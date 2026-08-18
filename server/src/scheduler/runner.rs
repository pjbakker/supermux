//! Schedule execution.
//!
//! [`run`] dispatches one due (or manually-triggered) schedule. For a tick
//! dispatch it FIRST claims the `(schedule_id, scheduled_for_ts)` idempotency key
//! so a restart can't double-fire; a duplicate is logged and skipped.
//! Three job kinds — `tmux` (send to a session), `shell` (`bash -c`, 600s cap),
//! and `boot` (spawn a fresh session, with a dirty-worktree pre-flight). Every
//! run records a `schedule_runs` row and an `audit_log` entry, then recomputes
//! `next_run` (or disables a finished one-shot).

use std::path::Path;

use chrono::{DateTime, Utc};
use serde_json::json;

use crate::db;
use crate::db::schedules::Schedule;
use crate::sessions;
use crate::sessions::native::spool::{self, SOCKET_PATH_MAX};
use crate::state::{AppState, SseEvent};

use super::parser;
use super::watch;

/// What caused this run — distinguishes the idempotent tick path from a manual
/// "run now" (which neither gates on the fire-key nor advances `next_run`).
#[derive(Debug, Clone, Copy)]
pub enum Trigger {
    /// The 10s tick fired this; carries the scheduled fire-time (Unix seconds).
    Tick { scheduled_for_ts: i64 },
    /// `POST /api/schedules/{id}/run` — explicit user request.
    Manual,
}

/// Outcome of executing a job body.
struct JobOutcome {
    status: &'static str,
    note: String,
    /// Pre-send capture for watch-mode delta detection (tmux + watch only).
    pre_output: Option<String>,
}

/// Recompute the next fire time for `sched` relative to `now`, anchored at the
/// last fire (or the just-missed `next_run`). `None` disables (one-shot, or
/// unparseable recurrence).
pub fn recompute_next(sched: &Schedule, now: DateTime<Utc>) -> Option<DateTime<Utc>> {
    if sched.sched_type == "once" {
        return None;
    }
    let expr = sched.schedule_expr.as_deref().unwrap_or("");
    let parsed = parser::parse(expr, now).ok()?;
    let anchor = sched
        .last_run
        .as_deref()
        .or(sched.next_run.as_deref())
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
        .map(|d| d.with_timezone(&Utc))
        .unwrap_or(now);
    parsed.recurrence.next_after(anchor, now)
}

/// Run one schedule end-to-end.
pub async fn run(state: AppState, sched: Schedule, trigger: Trigger) {
    // Idempotency gate (tick path only).
    if let Trigger::Tick { scheduled_for_ts } = trigger {
        match db::schedules::claim_run_key(&state.pool, &sched.id, scheduled_for_ts).await {
            Ok(true) => {}
            Ok(false) => {
                tracing::debug!(schedule = %sched.id, scheduled_for_ts, "duplicate fire skipped");
                return;
            }
            Err(e) => {
                tracing::warn!(schedule = %sched.id, error = %e, "fire-key claim failed");
                return;
            }
        }
    }

    let now = Utc::now();
    let outcome = execute(&state, &sched).await;

    // Ledger + audit (best-effort; logging is the only feedback channel).
    let _ = db::schedules::insert_run(
        &state.pool,
        &sched.id,
        now.timestamp(),
        outcome.status,
        &outcome.note,
    )
    .await;
    let actor = match trigger {
        Trigger::Tick { .. } => "scheduler",
        Trigger::Manual => "user",
    };
    let _ = db::audit::log(
        &state.pool,
        actor,
        "schedule.run",
        &sched.id,
        json!({ "kind": sched.kind, "status": outcome.status, "manual": matches!(trigger, Trigger::Manual) }),
    )
    .await;

    // Surface the run to clients (anti-vision: push, never poll).
    let _ = state.sse_tx.send(SseEvent {
        event: "alerts".to_string(),
        payload: json!({
            "level": if outcome.status == "error" { "error" } else { "info" },
            "source": "scheduler",
            "schedule": sched.id,
            "detail": format!("Ran schedule: {}", sched.title),
        }),
    });

    // Phone push on ERROR only — successes would be too noisy for periodic
    // schedules (a 5-min cron firing all day every day). Spawned so the run
    // loop is never blocked on the push service; `send_push_for` honours the
    // `schedule_error` category toggle in Settings.
    if outcome.status == "error" {
        let st = state.clone();
        let title = sched.title.clone();
        let note = outcome.note.clone();
        tokio::spawn(async move {
            let body = if note.is_empty() {
                format!("Schedule '{title}' errored.")
            } else {
                format!("'{title}' errored: {note}")
            };
            let _ = crate::push::send_push_for(
                &st,
                crate::db::push::NotifCategory::ScheduleError,
                &format!("schedule '{title}' errored"),
                &body,
                "/scheduler",
            )
            .await;
        });
    }

    // Persist cadence.
    match trigger {
        Trigger::Tick { .. } => {
            let next = recompute_next(&sched, now);
            let _ = db::schedules::record_fire(&state.pool, &sched.id, now, next).await;
        }
        Trigger::Manual => {
            let _ = db::schedules::record_manual(&state.pool, &sched.id, now).await;
        }
    }

    // Watch mode: poll the session for the done-pattern (tmux + ok only).
    if sched.watch == 1 && sched.kind == "tmux" && outcome.status == "ok" {
        watch::spawn(state, sched, outcome.pre_output.unwrap_or_default());
    }
}

/// Execute the job body for `sched`, returning its status + note + pre-capture.
async fn execute(state: &AppState, sched: &Schedule) -> JobOutcome {
    match sched.kind.as_str() {
        "shell" => execute_shell(sched).await,
        "boot" => execute_boot(state, sched).await,
        // default to tmux
        _ => execute_tmux(state, sched).await,
    }
}

/// `kind='shell'` — `bash -c <command>` with a 600s ceiling.
async fn execute_shell(sched: &Schedule) -> JobOutcome {
    let result = tokio::time::timeout(
        parser::SHELL_TIMEOUT,
        tokio::process::Command::new("/bin/bash")
            .arg("-c")
            .arg(&sched.command)
            .output(),
    )
    .await;

    match result {
        Ok(Ok(out)) if out.status.success() => JobOutcome {
            status: "ok",
            note: truncate(&String::from_utf8_lossy(&out.stdout)),
            pre_output: None,
        },
        Ok(Ok(out)) => {
            let mut note = String::from_utf8_lossy(&out.stderr).to_string();
            if note.trim().is_empty() {
                note = String::from_utf8_lossy(&out.stdout).to_string();
            }
            JobOutcome {
                status: "error",
                note: truncate(&format!("exit {}: {}", out.status, note)),
                pre_output: None,
            }
        }
        Ok(Err(e)) => JobOutcome {
            status: "error",
            note: truncate(&format!("spawn failed: {e}")),
            pre_output: None,
        },
        Err(_) => JobOutcome {
            status: "error",
            note: "timeout after 600s".to_string(),
            pre_output: None,
        },
    }
}

/// `kind='tmux'` — send the optional `command` then the optional free-text
/// `prompt` to the target session (auto-wakes). At least one is non-empty (the
/// create handler guarantees it). Each is a separate submitted line, so a job can
/// run `/supermux-task` and follow it with a prompt, or send just one of the two.
/// Captures pre-send output first when watch-mode is on, for delta detection.
async fn execute_tmux(state: &AppState, sched: &Schedule) -> JobOutcome {
    if sched.session.trim().is_empty() {
        return JobOutcome {
            status: "error",
            note: "tmux schedule has no target session".to_string(),
            pre_output: None,
        };
    }
    let pre_output = if sched.watch == 1 {
        sessions::lifecycle::peek(state, &sched.session, 200).await.ok()
    } else {
        None
    };
    // Agent-confirmed finish: append the completion-call footer to the LAST
    // delivered line so it lands in the SAME submission as the task prompt — the
    // agent reads "do X, and when fully done, curl Y" as one instruction and so
    // never fires the signal before the work is done. (A bare `/command`-only
    // job carries the footer as trailing context, which skills ignore.)
    let mut lines: Vec<String> = delivery_lines(sched).into_iter().map(str::to_string).collect();
    if sched.confirm_finish == 1 {
        let footer = confirm_footer(&sched.id);
        match lines.last_mut() {
            Some(last) => {
                last.push_str("\n\n");
                last.push_str(&footer);
            }
            None => lines.push(footer),
        }
    }
    for line in &lines {
        if let Err(e) = sessions::lifecycle::send_text(state, &sched.session, line).await {
            return JobOutcome {
                status: "error",
                note: truncate(&format!("send failed: {e}")),
                pre_output: None,
            };
        }
    }
    JobOutcome {
        status: "ok",
        note: format!("sent to {}", sched.session),
        pre_output,
    }
}

/// The agent-confirmed-finish footer: a copy-pasteable curl the agent runs when
/// the scheduled task is genuinely complete, so completion is agent-declared
/// (the reliable signal) rather than inferred from idle. Uses the per-session
/// `$SUPERMUX_*` env already in the pane (same convention as the board footer in
/// `board::dispatch`). Idle detection remains the fallback if the agent forgets.
fn confirm_footer(schedule_id: &str) -> String {
    format!(
        "— — —\n\
         When this scheduled task is FULLY complete (not before), signal completion \
         so I'm notified — run exactly:\n\
         curl -fsS -H \"X-Supermux-Hook-Token: $SUPERMUX_HOOK_TOKEN\" \\\n\
         \x20 \"$SUPERMUX_URL/api/hook/schedule/done\" \\\n\
         \x20 -d '{{\"session\":\"'$SUPERMUX_SESSION'\",\"schedule_id\":\"{schedule_id}\"}}'\n\
         Call it only once, only when the work is genuinely done."
    )
}

/// The ordered, non-empty lines a `tmux`/`boot` job delivers: the slash `command`
/// first (when set), then the free-text `prompt` (when set). Each is submitted as
/// its own line. At least one is present (create-handler invariant).
fn delivery_lines(sched: &Schedule) -> Vec<&str> {
    let mut lines = Vec::new();
    let cmd = sched.command.trim();
    if !cmd.is_empty() {
        lines.push(cmd);
    }
    let prompt = sched.prompt.trim();
    if !prompt.is_empty() {
        lines.push(prompt);
    }
    lines
}

/// `kind='boot'` — spawn a NEW session in `boot_dir` and send `command` as its
/// first prompt. Pre-flight: if `boot_worktree`, refuse on a dirty parent repo
/// (don't silently pollute it — Eng failure-paths table).
async fn execute_boot(state: &AppState, sched: &Schedule) -> JobOutcome {
    if sched.boot_worktree == 1 {
        match worktree_is_dirty(&sched.boot_dir).await {
            Ok(true) => {
                return JobOutcome {
                    status: "error",
                    note: "parent worktree dirty".to_string(),
                    pre_output: None,
                };
            }
            Ok(false) => {}
            Err(e) => {
                return JobOutcome {
                    status: "error",
                    note: truncate(&format!("worktree check failed: {e}")),
                    pre_output: None,
                };
            }
        }
    }

    let name = boot_session_name(sched, &state.config.data_dir);
    let input = sessions::CreateInput {
        name: name.clone(),
        display_name: None,
        dir: Some(sched.boot_dir.clone()),
        desc: Some(format!("booted by schedule {}", sched.id)),
        provider: Some(sched.boot_provider.clone()),
        creator: Some("scheduler".to_string()),
        flags: None,
        // The schedule's bypass-permissions choice → the trusted launch flag,
        // built server-side by `sessions::create` (never raw flags on the wire).
        bypass_permissions: Some(sched.bypass_permissions == 1),
        archive_on_stop: Some(sched.archive_on_stop == 1),
        tags: None,
        branch: None,
        mcp: None,
        worktree: Some(sched.boot_worktree == 1),
        host_id: None,
        // No host_id here, so leaving runtime absent resolves to native (the
        // local-session default in `sessions::create`), not tmux. That is why
        // the name above is budgeted against the native socket path.
        runtime: None,
        // The runner delivers its own opening prompt below, and a schedule's
        // singleton behaviour is the schedule's own (not the create guard).
        prompt: None,
        unless_live_prefix: None,
        max_quiet_secs: None,
    };
    if let Err(e) = sessions::create(state, input).await {
        return JobOutcome {
            status: "error",
            note: truncate(&format!("boot create failed: {e}")),
            pre_output: None,
        };
    }
    // Start with the FIRST delivery line as the agent's opening prompt (the slash
    // command when set, else the free-text prompt), then send any remaining line
    // as a follow-up. This lets a boot job run e.g. `/cso` and then a prompt — or
    // boot straight into a free-text prompt with no command.
    let lines = delivery_lines(sched);
    let first = lines.first().copied();
    if let Err(e) = sessions::lifecycle::start(state, &name, first).await {
        return JobOutcome {
            status: "error",
            note: truncate(&format!("boot start failed: {e}")),
            pre_output: None,
        };
    }
    for follow in lines.iter().skip(1) {
        if let Err(e) = sessions::lifecycle::send_text(state, &name, follow).await {
            return JobOutcome {
                status: "error",
                note: truncate(&format!("boot follow-up send failed: {e}")),
                pre_output: None,
            };
        }
    }
    JobOutcome {
        status: "ok",
        note: format!("booted session {name}"),
        pre_output: None,
    }
}

/// True if `git status --porcelain` in `dir` reports any change.
async fn worktree_is_dirty(dir: &str) -> Result<bool, std::io::Error> {
    let out = tokio::process::Command::new("git")
        .arg("-C")
        .arg(dir)
        .arg("status")
        .arg("--porcelain")
        .output()
        .await?;
    if !out.status.success() {
        return Err(std::io::Error::other(format!(
            "git status exited {}: {}",
            out.status,
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }
    Ok(!out.stdout.is_empty())
}

/// A valid, unique session slug for a boot job (`[A-Za-z0-9_.-]+`).
///
/// The name is budgeted against the NATIVE RUNTIME'S SOCKET PATH, not just
/// against [`sessions::valid_name`]'s 100-byte cap. A native session binds
/// `<data_dir>/native/<name>/holder.sock`, and that whole path has to fit in
/// [`SOCKET_PATH_MAX`] bytes. On the default `~/.supermux` data dir a name
/// that passes `valid_name` at 100 bytes still produces a 130-byte socket path
/// and the boot fails at spawn ("socket path ... is too long for a unix
/// socket"). A boot schedule with a long title hit exactly that and the run was
/// recorded as an error nobody saw.
///
/// So: the BASE (the sanitized title) is cut BEFORE the suffix is appended,
/// never the finished name. The 8-hex suffix is what keeps two boots of the
/// same schedule apart, so it must always survive; truncating the assembled
/// string could eat it. The budget is derived from `data_dir` (configurable)
/// rather than hardcoded.
///
/// One case the budget cannot rescue: a `data_dir` so long that even a bare
/// 8-hex name overflows the cap (roughly 72 bytes and up). There is no name
/// that fits then, so the function warns and lets the runtime report the
/// spawn failure.
fn boot_session_name(sched: &Schedule, data_dir: &Path) -> String {
    let sanitized: String = sched
        .title
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-') { c } else { '-' })
        .collect();
    let trimmed = sanitized.trim_matches('-');
    let mut base = if trimmed.is_empty() { "boot" } else { trimmed }.to_string();
    let suffix = &uuid::Uuid::new_v4().simple().to_string()[..8];

    // Shrink the base until `<data_dir>/native/<base>-<suffix>/holder.sock`
    // fits. Measuring the real path (rather than doing arithmetic on the data
    // dir's length) keeps this correct whatever `join` does with separators.
    // Each pass drops the exact overflow, rounded down to a char boundary, so
    // one or two passes settle it.
    loop {
        let candidate = format!("{base}-{suffix}");
        let len = spool::socket_path(data_dir, &candidate).as_os_str().len();
        if len <= SOCKET_PATH_MAX || base.is_empty() {
            break;
        }
        let over = len - SOCKET_PATH_MAX;
        let mut keep = base.len().saturating_sub(over);
        // Defensive only: the sanitizer above already forced `base` to ASCII,
        // so every index is a char boundary today. The walk keeps the cut
        // safe if that charset ever widens to multi-byte characters.
        while keep > 0 && !base.is_char_boundary(keep) {
            keep -= 1;
        }
        base.truncate(keep);
        // Don't leave the base ending in the separator that precedes the
        // suffix (a `--` seam is harmless but ugly).
        while base.ends_with('-') {
            base.pop();
        }
    }

    // Degenerate case: a data_dir so long that not even a bare suffix fits.
    // Nothing sane can be built here, so hand back the suffix alone and let
    // the runtime's own spawn-time check report the real path length. Warn
    // loudly, because the real cause is the data_dir, not the title, and the
    // spawn error alone does not say so.
    if base.is_empty() {
        let path_len = spool::socket_path(data_dir, suffix).as_os_str().len();
        tracing::warn!(
            data_dir = %data_dir.display(),
            path_len,
            max = SOCKET_PATH_MAX,
            "data_dir is too long to budget a boot session name; the native \
             socket path will exceed the cap even with an empty title"
        );
        return suffix.to_string();
    }
    format!("{base}-{suffix}")
}

/// Trim a note to a reasonable column size (matches v2's 500-char cap).
/// Slices on a CHAR boundary — naive byte-index slicing panics when byte 500
/// lands inside a multi-byte char (emoji/CJK/accented stdout).
fn truncate(s: &str) -> String {
    const MAX_CHARS: usize = 500;
    let s = s.trim();
    if s.chars().count() <= MAX_CHARS {
        return s.to_string();
    }
    let mut out: String = s.chars().take(MAX_CHARS).collect();
    out.push('…');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A bare Schedule with just the two delivery fields set — the rest is unused
    /// by [`delivery_lines`], so defaults keep the fixture small.
    fn sched_with(command: &str, prompt: &str) -> Schedule {
        Schedule {
            id: "SCHED-test".into(),
            title: "t".into(),
            session: "s".into(),
            command: command.into(),
            prompt: prompt.into(),
            kind: "tmux".into(),
            boot_dir: String::new(),
            boot_provider: "claude".into(),
            boot_worktree: 0,
            sched_type: "recurring".into(),
            recurrence: None,
            run_at: None,
            next_run: None,
            last_run: None,
            enabled: 1,
            run_count: 0,
            schedule_expr: Some("every 1m".into()),
            watch: 0,
            watch_timeout: 120,
            done_pattern: None,
            done_action: "disable".into(),
            confirm_finish: 0,
            bypass_permissions: 0,
            archive_on_stop: 0,
            created: 0,
            updated: 0,
            deleted: None,
        }
    }

    #[test]
    fn delivery_lines_command_then_prompt() {
        let s = sched_with("/supermux-task", "summarise the board");
        assert_eq!(delivery_lines(&s), vec!["/supermux-task", "summarise the board"]);
    }

    #[test]
    fn delivery_lines_command_only() {
        let s = sched_with("/cso", "");
        assert_eq!(delivery_lines(&s), vec!["/cso"]);
    }

    #[test]
    fn delivery_lines_prompt_only() {
        let s = sched_with("", "check the deploy");
        assert_eq!(delivery_lines(&s), vec!["check the deploy"]);
    }

    #[test]
    fn delivery_lines_trims_and_drops_blank() {
        let s = sched_with("  ", "  do it  ");
        // whitespace-only command is dropped; prompt is trimmed.
        assert_eq!(delivery_lines(&s), vec!["do it"]);
    }

    #[test]
    fn truncate_does_not_panic_on_multibyte_boundary() {
        // "€" is 3 bytes; 167 copies = 501 bytes / 167 chars. A naive &s[..500]
        // would land inside the 167th '€' and panic. Char-boundary slice is safe.
        let input = "€".repeat(167);
        let out = truncate(&input);
        // Short input (167 chars ≤ 500 MAX_CHARS) passes through verbatim.
        assert_eq!(out.chars().count(), 167);
        // ASCII shorter than the cap is unchanged.
        assert_eq!(truncate("hello"), "hello");
        // Long multibyte input is capped to MAX_CHARS chars + the ellipsis.
        let long = "€".repeat(600);
        let capped = truncate(&long);
        assert_eq!(capped.chars().count(), 501); // 500 '€' + '…'
        assert!(capped.ends_with('…'));
    }

    // ---- boot_session_name: socket-path budget -------------------------------

    /// A boot-kind fixture whose only interesting field is the title.
    fn boot_sched(title: &str) -> Schedule {
        let mut s = sched_with("", "go");
        s.kind = "boot".into();
        s.title = title.into();
        s
    }

    /// Every boot name ends in `-` + 8 hex chars (the uniqueness suffix).
    fn assert_hex_suffixed(name: &str) {
        assert!(name.len() > 9, "name too short to carry a suffix: {name}");
        let (head, suffix) = name.split_at(name.len() - 8);
        assert!(head.ends_with('-'), "no dash before the suffix: {name}");
        assert!(
            suffix.chars().all(|c| c.is_ascii_hexdigit()),
            "suffix is not 8 hex chars: {name}"
        );
    }

    /// The socket path the native runtime would bind for `name` must fit.
    fn socket_len(data_dir: &Path, name: &str) -> usize {
        crate::sessions::native::spool::socket_path(data_dir, name)
            .as_os_str()
            .len()
    }

    #[test]
    fn boot_name_fits_the_native_socket_path() {
        // The incident shape: a title of this length produces a socket path
        // over the cap (105 bytes > 100 on the default data dir).
        let data_dir = Path::new("/home/supermux/.supermux");
        let title = "Nightly--archive--sweep-part-1-6--report--2026-08-17";
        let name = boot_session_name(&boot_sched(title), data_dir);
        assert!(
            socket_len(data_dir, &name) <= SOCKET_PATH_MAX,
            "socket path {} bytes > {SOCKET_PATH_MAX} for name {name}",
            socket_len(data_dir, &name)
        );
        assert_hex_suffixed(&name);
        // The head is still a PREFIX of the sanitized title, just shorter.
        let head = &name[..name.len() - 9];
        assert!(!head.is_empty());
        assert!(title.starts_with(head), "head {head} is not a title prefix");
        // And it stays a legal session name.
        assert!(crate::sessions::valid_name(&name), "invalid name {name}");
    }

    #[test]
    fn boot_name_keeps_a_short_title_intact() {
        let data_dir = Path::new("/home/supermux/.supermux");
        let name = boot_session_name(&boot_sched("nightly.sweep"), data_dir);
        assert!(name.starts_with("nightly.sweep-"), "unexpected name {name}");
        assert_eq!(name.len(), "nightly.sweep".len() + 9);
        assert_hex_suffixed(&name);
    }

    #[test]
    fn boot_name_truncates_a_very_long_title_and_stays_unique() {
        let data_dir = Path::new("/home/supermux/.supermux");
        let sched = boot_sched(&"a".repeat(200));
        let one = boot_session_name(&sched, data_dir);
        let two = boot_session_name(&sched, data_dir);
        assert!(socket_len(data_dir, &one) <= SOCKET_PATH_MAX);
        assert!(crate::sessions::valid_name(&one), "invalid name {one}");
        assert_hex_suffixed(&one);
        assert_ne!(one, two, "two boots of one schedule must differ");
    }

    #[test]
    fn boot_name_falls_back_when_the_title_is_all_punctuation() {
        let data_dir = Path::new("/home/supermux/.supermux");
        let name = boot_session_name(&boot_sched("!!! ??? ***"), data_dir);
        assert!(name.starts_with("boot-"), "unexpected name {name}");
        assert_hex_suffixed(&name);
    }

    #[test]
    fn boot_name_sanitizes_non_ascii_titles_to_a_legal_ascii_name() {
        let data_dir = Path::new("/home/supermux/.supermux");
        for title in ["🚀 launch 🚀", "café-über-groß", &"é".repeat(120)] {
            let name = boot_session_name(&boot_sched(title), data_dir);
            assert!(socket_len(data_dir, &name) <= SOCKET_PATH_MAX, "too long: {name}");
            assert!(crate::sessions::valid_name(&name), "invalid name {name}");
            assert_hex_suffixed(&name);
        }
    }

    #[test]
    fn boot_name_budget_shrinks_with_a_longer_data_dir() {
        let title = "Nightly--archive--sweep-part-1-6--report--2026-08-17";
        let short = boot_session_name(&boot_sched(title), Path::new("/d"));
        let long = boot_session_name(
            &boot_sched(title),
            Path::new("/var/lib/supermux/instances/production/data-dir"),
        );
        assert!(
            long.len() < short.len(),
            "a longer data_dir must shrink the base: {short} vs {long}"
        );
        assert!(socket_len(Path::new("/d"), &short) <= SOCKET_PATH_MAX);
        assert!(
            socket_len(Path::new("/var/lib/supermux/instances/production/data-dir"), &long)
                <= SOCKET_PATH_MAX
        );
    }
}
