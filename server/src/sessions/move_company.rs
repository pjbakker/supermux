//! **Move a bot between companies** — `POST /api/sessions/{name}/company`.
//!
//! A bot is a [`sessions`](crate::db::sessions) row with a nullable `company_id`
//! (migration 0032). This module reassigns that column and drags EVERYTHING
//! company-owned along with it — the session's files, its Claude transcript
//! history, its own-slug connector + browser-tab grants, and its group-chat
//! channel — in the single ordering that never loses data or leaks a credential
//! across a company boundary.
//!
//! # Why FS-first, then one DB transaction
//!
//! The files are moved on disk BEFORE the DB is touched, so a crash at any point
//! leaves the DB pointing at a directory that actually exists (never an orphaned
//! transcript, never a row whose `dir` is gone). The DB write is a SINGLE
//! transaction — the commit point — that flips `company_id` + `dir` and sweeps
//! the two grant classes that would otherwise leak the OLD company's
//! credentials. The only pre-commit mutations are two filesystem renames, each
//! individually reversible; a failure reverses them in LIFO order, so a partial
//! move never half-commits. Re-running the same move after a partial success is
//! safe (every step no-ops when already applied).
//!
//! The one step that cannot be a rename — a CROSS-FILESYSTEM move, where
//! `rename(2)` returns `EXDEV` — copies into the destination pre-commit and
//! removes the source only AFTER the commit (a cross-fs rename BACK would fail
//! too, so removing the source early is how a directory gets lost when the DB tx
//! then fails). Pre-commit it is reversed by deleting the destination copy; the
//! source is never at risk. See [`DirMove`].
//!
//! A bot whose directory does not exist on disk yet (it is created lazily on the
//! first start) skips the filesystem work entirely and still gets the DB flip —
//! never a 500, and the skip is surfaced in `warnings[]`.
//!
//! # What is honest breakage, surfaced never silent
//!
//! Moving OUT of a company necessarily strands things that were *inherited*, not
//! owned: `@company:<old>` tier connector + tab grants stop resolving (nothing
//! is lost — they resolve live off the row and simply no longer match), and the
//! old-company group-chat history stays append-only in the old log. These are
//! returned in `warnings[]` and rendered in the confirm result — the move NEVER
//! silently loses data, leaks a credential, or orphans a transcript.
//!
//! # Restart required
//!
//! Confinement/isolation and the live pty's cwd are read at SPAWN
//! (`lifecycle::build_launch_command`), so a running pane keeps the old inode and
//! old jail until it is restarted. A busy pane is therefore moved WITHOUT being
//! force-killed, and the response is always `restart_required: true`.

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::db;
use crate::error::AppError;
use crate::state::{AppState, SseEvent};

use super::resumable::project_dir_for;

/// One own-slug connector grant that was revoked because it pointed at the OLD
/// company's connected account (a credential-leak guard).
#[derive(Debug, Clone, Serialize)]
pub struct DroppedGrant {
    pub connector_id: String,
    /// The connector's display name (falls back to its id when the manifest row
    /// is gone), so the post-move toast can say what stopped working.
    pub connector_name: String,
}

/// One own-slug browser-tab grant that was revoked because the tab belongs to
/// the OLD company.
#[derive(Debug, Clone, Serialize)]
pub struct DeadTabGrant {
    pub tab_id: String,
    pub title: String,
}

/// The move's honest receipt (`§2.5`). Serialized as the HTTP body.
#[derive(Debug, Clone, Serialize)]
pub struct MoveResult {
    pub ok: bool,
    /// Always `true` for a real move — isolation + the live pty cwd apply on the
    /// NEXT start. `false` only for the no-op (nothing changed).
    pub restart_required: bool,
    /// `"moved"` (a plain rename), `"copied"` with a file count (cross-fs
    /// fallback), or `"skipped"` (nothing to move — an idempotent re-run, or a bot
    /// whose dir is not on disk yet).
    pub moved_files: serde_json::Value,
    pub dropped_grants: Vec<DroppedGrant>,
    pub dead_tab_grants: Vec<DeadTabGrant>,
    /// Human-readable lines describing acceptable, surfaced breakage.
    pub warnings: Vec<String>,
}

/// Request body: `{ "company_id": <id> | null }` (`null` = HQ / main).
#[derive(Debug, Deserialize)]
pub struct MoveInput {
    #[serde(default)]
    pub company_id: Option<i64>,
}

/// `POST /api/sessions/{name}/company` — owner/admin only; a scoped MEMBER is
/// forbidden (moving a bot between companies is company MANAGEMENT, not a
/// per-bot config edit).
pub(crate) async fn handler(
    axum::extract::State(state): axum::extract::State<AppState>,
    ctx: crate::scope::OptCtx,
    axum::extract::Path(name): axum::extract::Path<String>,
    axum::Json(input): axum::Json<MoveInput>,
) -> Result<impl axum::response::IntoResponse, AppError> {
    // Owner/admin gate. `None` (a handler invoked with no stamped identity — unit
    // tests, and the pre-human-auth owner default) passes, byte-identical to the
    // rest of the codebase's owner-neutral guards; a scoped member is FORBIDDEN.
    // 403 (not the hide-existence 404) because this is a deliberate authorization
    // boundary on a surface the member CAN see their own bot through.
    if !ctx.0.as_ref().map(|c| c.is_admin_or_owner()).unwrap_or(true) {
        return Err(AppError::Forbidden(
            "moving a bot between companies is owner/admin only".into(),
        ));
    }
    let result = move_to_company(&state, &name, input.company_id).await?;
    Ok(super::ok(result))
}

/// The move service (`§2`): preflight (no writes) → FS move → transcript rehome
/// → one DB transaction → post-commit broadcast. See the module docs for the
/// ordering rationale.
pub async fn move_to_company(
    state: &AppState,
    name: &str,
    target: Option<i64>,
) -> Result<MoveResult, AppError> {
    // ── Preflight (no writes) ────────────────────────────────────────────────
    let row = db::sessions::get(&state.pool, name)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("session '{name}'")))?;
    let old_cid = row.company_id;
    let old_dir = row.dir.clone();
    let slug = name.to_string();

    // No-op: already in the target company. Idempotent, zero writes.
    if target == old_cid {
        return Ok(MoveResult {
            ok: true,
            restart_required: false,
            moved_files: json!("skipped"),
            dropped_grants: vec![],
            dead_tab_grants: vec![],
            warnings: vec!["already in this company — nothing to move".into()],
        });
    }

    // Resolve the destination directory + a label for the target.
    let (new_dir, target_label) = match target {
        Some(new) => {
            let company = db::companies::get(&state.pool, new)
                .await?
                .ok_or_else(|| AppError::NotFound(format!("no company {new}")))?;
            // Mirror create (`sessions::create`): a move INTO an archived company
            // is refused rather than dropping a bot into a dead jail. 409.
            if company.archived != 0 {
                return Err(AppError::Conflict(format!(
                    "company '{}' is archived — unarchive it before moving bots in",
                    company.slug
                )));
            }
            let dir = std::path::Path::new(&company.root_dir)
                .join(name)
                .display()
                .to_string();
            (dir, format!("company '{}'", company.slug))
        }
        None => {
            // HQ target: the bot gets its own `$HOME/<name>` folder (each bot a
            // distinct dir, never the bare `$HOME` several would collide on).
            let home = dirs::home_dir().unwrap_or_else(|| std::path::PathBuf::from("."));
            let dir = home.join(name).display().to_string();
            (dir, "HQ (main)".to_string())
        }
    };

    let old_path = std::path::PathBuf::from(&old_dir);
    let new_path = std::path::PathBuf::from(&new_dir);
    let old_exists = old_path.exists();
    let new_exists = new_path.exists();
    let same_path = paths_equal(&old_path, &new_path);

    // Collision: the destination dir is occupied by SOMETHING ELSE — refuse, never
    // merge or overwrite. A destination that exists while the SOURCE is already
    // gone is the idempotent-resume case (a prior partial move), not a collision.
    if new_exists && !same_path && old_exists {
        return Err(AppError::Conflict(format!(
            "destination '{new_dir}' already exists — refusing to overwrite or merge"
        )));
    }

    // Transcript-dir collision: a `~/.claude/projects/<new-encoded>` that already
    // exists for a DIFFERENT session would orphan/merge history. Only a fresh move
    // (source still present) can be a real collision; a resume (source gone) is us.
    let old_proj = project_dir_for(&old_dir); // resolves while old_dir still exists
    let new_proj = project_dir_for(&new_dir);
    let proj_differs = old_proj != new_proj;
    if proj_differs && old_exists && new_proj.exists() {
        return Err(AppError::Conflict(format!(
            "transcript dir '{}' already exists — a different session's history is there",
            new_proj.display()
        )));
    }

    // ── Execution: FS FIRST (the DB tx is the commit point) ──────────────────
    let mut warnings: Vec<String> = Vec::new();

    // Step 1 — move the session directory.
    //
    // `dir_move` records what THIS call actually did on disk: it is the input to
    // both the pre-commit rollback (LIFO reverse) and the post-commit finish (a
    // cross-fs source dir is removed only once the DB has committed).
    let mut dir_move = DirMove::None;
    let moved_files: serde_json::Value = if same_path {
        json!("skipped")
    } else if !old_exists {
        // Nothing to move. Either the dir was never created on disk (a stopped bot
        // creates its dir lazily on first start) or a prior partial move already
        // put it at the destination (idempotent resume). Both still need the DB tx
        // so `company_id` + `dir` flip; neither is an error.
        if !new_exists {
            warnings.push(format!(
                "session dir not on disk yet — nothing to move (it is created on the next start at {new_dir})"
            ));
        }
        json!("skipped")
    } else {
        if let Some(parent) = new_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                AppError::Internal(anyhow::anyhow!("mkdir {}: {e}", parent.display()))
            })?;
        }
        match rename_dir(&old_path, &new_path) {
            Ok(()) => {
                dir_move = DirMove::Renamed;
                json!("moved")
            }
            Err(e) if e.raw_os_error() == Some(libc::EXDEV) => {
                // Cross-filesystem: rename(2) can't span mounts. Copy-tree and
                // VERIFY into the destination — but do NOT remove the source here.
                // Removing it before the commit is what loses the directory when
                // the DB tx later fails; it is a POST-COMMIT cleanup instead
                // (`DirMove::Copied` → `finish_dir_move`).
                let n = copy_tree(&old_path, &new_path)
                    .and_then(|n| verify_copy(&old_path, &new_path).map(|()| n))
                    .map_err(|e| {
                        // Best-effort: don't leave a half-copied destination behind.
                        let _ = std::fs::remove_dir_all(&new_path);
                        AppError::Internal(anyhow::anyhow!(
                            "cross-fs copy {} → {}: {e}",
                            old_path.display(),
                            new_path.display()
                        ))
                    })?;
                dir_move = DirMove::Copied;
                json!({ "copied": n })
            }
            Err(e) => {
                return Err(AppError::Internal(anyhow::anyhow!(
                    "rename {} → {}: {e}",
                    old_path.display(),
                    new_path.display()
                )));
            }
        }
    };

    // Step 2 — rehome the Claude transcript project dir and rewrite its `cwd`s.
    // Skipped entirely when there is nothing to rehome — no transcript at the old
    // encoded path, which is always the case for a bot that has no dir on disk yet.
    // On ANY failure, reverse step 1 (LIFO) and abort — history integrity is never
    // sacrificed silently.
    let mut proj_moved = false;
    if proj_differs {
        if old_proj.exists() && !new_proj.exists() {
            if let Some(parent) = new_proj.parent() {
                if let Err(e) = std::fs::create_dir_all(parent) {
                    rollback_dir_move(dir_move, &new_path, &old_path);
                    return Err(AppError::Internal(anyhow::anyhow!(
                        "mkdir transcript parent {}: {e}",
                        parent.display()
                    )));
                }
            }
            if let Err(e) = std::fs::rename(&old_proj, &new_proj) {
                rollback_dir_move(dir_move, &new_path, &old_path);
                return Err(AppError::Internal(anyhow::anyhow!(
                    "rehome transcript {} → {}: {e}",
                    old_proj.display(),
                    new_proj.display()
                )));
            }
            proj_moved = true;
            // Rewrite the `cwd` field inside every transcript line to the new
            // canonicalized dir (Claude records the resolved path).
            let new_canonical = std::fs::canonicalize(&new_path)
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_else(|_| new_dir.clone());
            if let Err(e) = rewrite_transcript_cwd(&new_proj, &new_canonical) {
                // Reverse LIFO: transcript rename back, then dir move back.
                let _ = std::fs::rename(&new_proj, &old_proj);
                rollback_dir_move(dir_move, &new_path, &old_path);
                return Err(AppError::Internal(anyhow::anyhow!(
                    "rewrite transcript cwd in {}: {e}",
                    new_proj.display()
                )));
            }
        } else if old_proj.exists() && new_proj.exists() {
            // Both present (partial-move resume) — leave the destination as-is.
        }
        // else: no transcript history yet — nothing to rehome.
    }

    // Step 3 — the single DB transaction (the atomic commit).
    let sweep = match commit_move(&state.pool, &slug, &new_dir, target, old_cid).await {
        Ok(s) => s,
        Err(e) => {
            // Reverse LIFO: transcript rename back, then dir move back. The DB tx
            // is all-or-nothing, so nothing was committed.
            if proj_moved {
                let _ = std::fs::rename(&new_proj, &old_proj);
                // The cwd rewrite is cosmetic and re-applied on the next attempt;
                // leaving the rewritten value in the reversed dir is harmless (the
                // paths point nowhere until a retry re-moves it).
            }
            // A cross-fs copy is reversed by deleting the DESTINATION — its source
            // is still intact precisely because it was never removed pre-commit.
            rollback_dir_move(dir_move, &new_path, &old_path);
            return Err(AppError::Internal(anyhow::anyhow!("commit move: {e}")));
        }
    };

    // ── Post-commit: finish the cross-fs move ────────────────────────────────
    // The commit succeeded, so the destination copy is now the truth and the old
    // directory is redundant. This is the ONLY place the cross-fs source is
    // removed. Best-effort: a failure here leaves a stale copy behind — a warning,
    // never a 500, because the move itself is already committed and correct.
    if let Err(e) = finish_dir_move(dir_move, &old_path) {
        warnings.push(format!(
            "Copied across filesystems, but the old directory {} could not be removed ({e}) — remove it manually.",
            old_path.display()
        ));
    }

    // ── Post-commit: caches, SSE, group-chat re-scope ────────────────────────
    // Invalidate every cache that was derived from the OLD company/dir so the
    // next spawn reads the new confinement + cwd (the reason for restart_required).
    state.runtime_invalidate(&slug);
    state.isolation_applied.remove(&slug);

    // Both rosters must update: broadcast the full new row stamped with the NEW
    // company (so its members + the owner add/refresh the tile) AND stamped with
    // the OLD company (so its members drop it — the row now belongs elsewhere).
    if let Ok(view) = super::get(state, &slug).await {
        if let Ok(mut rowval) = serde_json::to_value(&view) {
            rowval["archived"] = json!(false);
            let payload = json!({ "delta": [rowval] });
            // New company (or owner-only, when target is HQ / None).
            let _ = state.sse_tx.send(SseEvent::for_company(
                "sessions",
                payload.clone(),
                target,
            ));
            // Old company (or owner-only, when the bot came from HQ / None). Skip
            // a duplicate frame when both scopes are the same (they never are, but
            // belt-and-suspenders).
            if old_cid != target {
                let _ = state.sse_tx.send(SseEvent::for_company(
                    "sessions",
                    payload,
                    old_cid,
                ));
            }
        }
    }

    // Group-chat re-scope: the bot's channel is derived from `company_id` at
    // tool-call time, so the membership change takes effect on the next
    // group-chat tool call and after restart. Nudge BOTH heroes' badges so the
    // rosters/feeds repaint without a manual refetch.
    for cid in [old_cid, target].into_iter().flatten() {
        let _ = state.sse_tx.send(SseEvent::for_company(
            "groupchat",
            json!({ "company": cid, "membership": "changed", "session": slug }),
            Some(cid),
        ));
    }

    // ── Honest warnings (surfaced, never silent) ─────────────────────────────
    warnings.push(format!("Moved to {target_label}."));
    if let Some(old) = old_cid {
        warnings.push(format!(
            "Inherited `@company:{old}` connector & browser-tab grants stop applying (nothing lost — they resolve live off the row)."
        ));
        warnings.push(format!("Leaves the #{old} group chat; its history stays in the old log."));
    }
    if !sweep.dropped_grants.is_empty() {
        let names: Vec<&str> = sweep
            .dropped_grants
            .iter()
            .map(|g| g.connector_name.as_str())
            .collect();
        warnings.push(format!(
            "Revoked {} own-slug connector grant(s) that pointed at the old company's account(s): {}.",
            sweep.dropped_grants.len(),
            names.join(", ")
        ));
    }
    if !sweep.dead_tab_grants.is_empty() {
        warnings.push(format!(
            "Removed {} own-slug browser-tab grant(s) on old-company tab(s).",
            sweep.dead_tab_grants.len()
        ));
    }
    warnings.push("Restart required: confinement and the working directory apply on the next start.".into());

    Ok(MoveResult {
        ok: true,
        restart_required: true,
        moved_files,
        dropped_grants: sweep.dropped_grants,
        dead_tab_grants: sweep.dead_tab_grants,
        warnings,
    })
}

/// The result of the in-transaction grant sweeps.
struct Sweep {
    dropped_grants: Vec<DroppedGrant>,
    dead_tab_grants: Vec<DeadTabGrant>,
}

/// The single atomic commit: flip `company_id` + `dir`, then revoke the two
/// grant classes that would leak the OLD company's scope. All-or-nothing.
///
/// Raw SQL inside one `sqlx` transaction (the same shape as
/// [`db::sessions::rename`]) rather than the pool-based `set_dir` /
/// `connectors::revoke` / `browser_tabs::revoke` helpers, because those each take
/// their own `&SqlitePool` connection and could not share this transaction — and
/// atomicity across the flip + the sweeps is the whole point of the commit step.
/// The DELETEs mirror those helpers' statements exactly.
async fn commit_move(
    pool: &sqlx::SqlitePool,
    slug: &str,
    new_dir: &str,
    target: Option<i64>,
    old_cid: Option<i64>,
) -> sqlx::Result<Sweep> {
    let mut tx = pool.begin().await?;

    // 1. The core flip.
    sqlx::query("UPDATE sessions SET company_id = ?, dir = ? WHERE name = ?")
        .bind(target)
        .bind(new_dir)
        .bind(slug)
        .execute(&mut *tx)
        .await?;

    // 1b. Re-derive the workflows company_id cache (0038 §1). It is a derived
    //     copy of `sessions.company_id`, set at insert / rename and re-synced at
    //     boot, but a company MOVE never touched it — so a moved bot's workflows
    //     kept their OLD scope and rendered under the wrong company. Re-stamp
    //     every workflow of this session with the new company (a number, or NULL
    //     for a move to HQ), inside THIS tx so the cache can never diverge from
    //     the sessions flip above. `target` is byte-identical to what step 1 just
    //     wrote to `sessions.company_id`. Keyed by `session` = the bot's slug,
    //     which a move does not change; a no-op when the bot has zero workflows.
    sqlx::query("UPDATE workflows SET company_id = ? WHERE session = ?")
        .bind(target)
        .bind(slug)
        .execute(&mut *tx)
        .await?;

    // 2. Sweep leaking own-slug CONNECTOR grants. A grant keyed on the bot's own
    //    slug whose account is company-scoped (`connector_accounts.company_id`
    //    NOT NULL) to a company OTHER THAN the destination would inject the old
    //    company's sealed secret into a bot that no longer belongs there — a
    //    credential leak across the boundary. Revoke it. HQ/global-account grants
    //    (`company_id` NULL) and grants already on the destination company's
    //    account are kept. `@company:<old>` tier grants are keyed on the sentinel,
    //    not the slug, so they are not matched here — they resolve live off the
    //    row and simply stop applying.
    //
    //    `IS NOT ?` (SQLite null-safe) so a HQ target (`target = NULL`) revokes
    //    EVERY company-scoped own-slug grant, and a company target keeps only its
    //    own company's.
    let leaking: Vec<(String, Option<String>)> = sqlx::query_as(
        "SELECT sc.connector_id, c.display_name \
         FROM session_connectors sc \
         JOIN connector_accounts a ON a.id = sc.account_ref \
         LEFT JOIN connectors c ON c.id = sc.connector_id \
         WHERE sc.session_name = ? \
           AND a.company_id IS NOT NULL \
           AND a.company_id IS NOT ?",
    )
    .bind(slug)
    .bind(target)
    .fetch_all(&mut *tx)
    .await?;

    let mut dropped_grants = Vec::with_capacity(leaking.len());
    for (connector_id, display_name) in leaking {
        sqlx::query("DELETE FROM session_connectors WHERE session_name = ? AND connector_id = ?")
            .bind(slug)
            .bind(&connector_id)
            .execute(&mut *tx)
            .await?;
        let connector_name = display_name
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| connector_id.clone());
        dropped_grants.push(DroppedGrant {
            connector_id,
            connector_name,
        });
    }

    // 3. Sweep dead own-slug BROWSER-TAB grants: an own-slug grant on a tab owned
    //    by the OLD company is dead (the bot loses containment on that tab). Only
    //    when the bot HAD an old company — an HQ→company move has no old-company
    //    tabs to sweep. `@company` tab grants are left (phantom to revoke).
    let mut dead_tab_grants = Vec::new();
    if let Some(old) = old_cid {
        let dead: Vec<(String, String)> = sqlx::query_as(
            "SELECT g.tab_id, t.title \
             FROM browser_tab_grants g \
             JOIN browser_tabs t ON t.id = g.tab_id \
             WHERE g.grantee = ? AND t.company_id = ?",
        )
        .bind(slug)
        .bind(old)
        .fetch_all(&mut *tx)
        .await?;
        for (tab_id, title) in dead {
            sqlx::query("DELETE FROM browser_tab_grants WHERE tab_id = ? AND grantee = ?")
                .bind(&tab_id)
                .bind(slug)
                .execute(&mut *tx)
                .await?;
            dead_tab_grants.push(DeadTabGrant { tab_id, title });
        }
    }

    tx.commit().await?;
    Ok(Sweep {
        dropped_grants,
        dead_tab_grants,
    })
}

/// What step 1 actually did on disk — the input to both the pre-commit rollback
/// and the post-commit finish.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DirMove {
    /// Nothing was touched: same path, no source dir on disk, or the dir already
    /// sits at the destination (idempotent resume).
    None,
    /// A same-filesystem `rename(2)` — atomic, and reversed by renaming back.
    Renamed,
    /// A cross-filesystem COPY into the destination. The SOURCE IS STILL THERE:
    /// it is removed only by [`finish_dir_move`] AFTER the DB commits, so a failed
    /// commit can never lose the directory.
    Copied,
}

/// Reverse step 1 after a PRE-COMMIT failure. A rename goes back; a cross-fs copy
/// is undone by deleting the DESTINATION (the source was never removed).
fn rollback_dir_move(m: DirMove, new_path: &std::path::Path, old_path: &std::path::Path) {
    match m {
        DirMove::None => {}
        DirMove::Renamed => {
            // Same-fs by construction (it renamed forward), so this goes back.
            let _ = rename_dir(new_path, old_path);
        }
        DirMove::Copied => {
            let _ = std::fs::remove_dir_all(new_path);
        }
    }
}

/// Finish step 1 after the commit SUCCEEDED: the now-redundant source of a
/// cross-fs copy is removed. A `rename` needs no finishing, and there is nothing
/// to remove when no copy happened.
fn finish_dir_move(m: DirMove, old_path: &std::path::Path) -> std::io::Result<()> {
    if m == DirMove::Copied && old_path.exists() {
        std::fs::remove_dir_all(old_path)?;
    }
    Ok(())
}

/// Test hook for the cross-filesystem branch: forces `rename_dir` to report
/// `EXDEV` so the copy path can be exercised without two real mounts.
#[cfg(test)]
static FORCE_EXDEV: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// `rename(2)` for the session dir (the test-only `EXDEV` hook lives here).
fn rename_dir(old: &std::path::Path, new: &std::path::Path) -> std::io::Result<()> {
    #[cfg(test)]
    if FORCE_EXDEV.load(std::sync::atomic::Ordering::SeqCst) {
        return Err(std::io::Error::from_raw_os_error(libc::EXDEV));
    }
    std::fs::rename(old, new)
}

/// Are two paths the same target? Canonicalize when both exist; otherwise a plain
/// component compare (a not-yet-created destination can't be canonicalized).
fn paths_equal(a: &std::path::Path, b: &std::path::Path) -> bool {
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(ca), Ok(cb)) => ca == cb,
        _ => a == b,
    }
}

/// Recursively copy a directory tree; returns the number of FILES copied. Used
/// only on the `EXDEV` cross-filesystem fallback for the session dir.
fn copy_tree(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<u64> {
    std::fs::create_dir_all(dst)?;
    // A source that isn't there is "nothing to copy", never a hard failure — the
    // dir may be created lazily on first start, or have vanished under us.
    let entries = match std::fs::read_dir(src) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(e) => return Err(e),
    };
    let mut count = 0u64;
    for entry in entries {
        let entry = entry?;
        let ft = entry.file_type()?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if ft.is_dir() {
            count += copy_tree(&from, &to)?;
        } else if ft.is_symlink() {
            let target = std::fs::read_link(&from)?;
            #[cfg(unix)]
            std::os::unix::fs::symlink(&target, &to)?;
        } else {
            std::fs::copy(&from, &to)?;
            count += 1;
        }
    }
    Ok(count)
}

/// Sum `(files, bytes)` over a tree. Symlinks are counted as neither (they are
/// recreated, not copied, so their sizes never match). A missing tree is `(0, 0)`.
fn tree_stat(path: &std::path::Path) -> std::io::Result<(u64, u64)> {
    let entries = match std::fs::read_dir(path) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok((0, 0)),
        Err(e) => return Err(e),
    };
    let (mut files, mut bytes) = (0u64, 0u64);
    for entry in entries {
        let entry = entry?;
        let ft = entry.file_type()?;
        if ft.is_dir() {
            let (f, b) = tree_stat(&entry.path())?;
            files += f;
            bytes += b;
        } else if !ft.is_symlink() {
            files += 1;
            bytes += entry.metadata()?.len();
        }
    }
    Ok((files, bytes))
}

/// Verify a cross-fs copy landed whole (same file count, same total bytes) BEFORE
/// the source is ever eligible for removal. A mismatch is an error, so the caller
/// tears the destination down and aborts with the source untouched.
fn verify_copy(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    let a = tree_stat(src)?;
    let b = tree_stat(dst)?;
    if a != b {
        return Err(std::io::Error::new(
            std::io::ErrorKind::Other,
            format!(
                "verify failed: source has {} file(s)/{} byte(s), copy has {}/{}",
                a.0, a.1, b.0, b.1
            ),
        ));
    }
    Ok(())
}

/// Rewrite the top-level `cwd` field of every JSON line in every `*.jsonl`
/// transcript under `proj` to `new_cwd`. Non-JSON lines and lines without a
/// `cwd` are passed through untouched, so a malformed transcript is never
/// corrupted — it is merely left as-is.
fn rewrite_transcript_cwd(proj: &std::path::Path, new_cwd: &str) -> std::io::Result<()> {
    let entries = match std::fs::read_dir(proj) {
        Ok(e) => e,
        Err(_) => return Ok(()),
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let content = std::fs::read_to_string(&path)?;
        let mut out = String::with_capacity(content.len());
        let mut changed = false;
        for line in content.lines() {
            if line.is_empty() {
                out.push('\n');
                continue;
            }
            match serde_json::from_str::<serde_json::Value>(line) {
                Ok(mut v) if v.get("cwd").and_then(|c| c.as_str()).is_some() => {
                    v["cwd"] = json!(new_cwd);
                    out.push_str(&serde_json::to_string(&v).unwrap_or_else(|_| line.to_string()));
                    out.push('\n');
                    changed = true;
                }
                _ => {
                    out.push_str(line);
                    out.push('\n');
                }
            }
        }
        if changed {
            std::fs::write(&path, out)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests;
