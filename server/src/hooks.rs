//! Claude `SettingsHook` ingestion endpoint.
//!
//! `POST /api/_internal/hook` is the inbound side of the status detector's apex
//! signal: Claude Code runs supermux's `curl` hook (installed by
//! [`crate::claude_config`]) on every tool call / notification / turn end, and it
//! lands here. A valid event is recorded into [`AppState::record_hook`] and the
//! session's detector loop is woken so the status update surfaces well within the
//! "1s" bound.
//!
//! **Auth model — per-session, NOT the dashboard bearer.** This route is
//! mounted OUTSIDE the bearer-token layer because the hook command never carries
//! the dashboard bearer (it must not be in the session env). Instead each request
//! presents `X-Supermux-Hook-Token`, validated by a **constant-time** compare against
//! `session_runtime.hook_token WHERE name = body.session`. Consequences:
//!   * A leaked dashboard bearer cannot drive this endpoint (it isn't checked).
//!   * A leaked hook token of session A cannot mark session B — B's row holds a
//!     different token, so the compare fails → 401 (regression: `hook_auth_scope`).

use axum::extract::State;
use axum::http::HeaderMap;
use axum::routing::post;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

use axum::body::Bytes;

use crate::db;
use crate::error::AppError;
use crate::sessions::activity::{self, HookPayload};
use crate::sessions::status::{HookEvent, Status};
use crate::state::{AppState, SseEvent};

/// Header the hook command sets to its per-session `$SUPERMUX_HOOK_TOKEN`.
const HOOK_TOKEN_HEADER: &str = "X-Supermux-Hook-Token";

/// The hook sub-router. Merged at the top level of `http::router` (NO bearer
/// layer — auth is the per-session hook token, validated in [`hook_handler`]).
pub fn router_for(state: AppState) -> Router {
    Router::new()
        .route("/api/_internal/hook", post(hook_handler))
        .with_state(state)
}

#[derive(Debug, Deserialize)]
struct HookBody {
    /// The supermux session name (`$SUPERMUX_SESSION`); scopes the token check.
    session: String,
    /// The Claude event kind (`pre_tool` | `post_tool` | `notification` | `stop`
    /// | `subagent_stop` | `session_start` | `session_end` | `stop_failure`).
    event: String,
    /// The forwarded Claude hook JSON: the event's STDIN payload,
    /// size-capped by the hook command. Parsed LENIENTLY into [`HookPayload`]
    /// (every field optional; a partial/truncated/odd payload is a no-op, never a
    /// 400). Held in memory only — NEVER persisted (spec §SECURITY). Absent on a
    /// legacy hook command (pre-upgrade sessions) → treated as `{}`.
    #[serde(default)]
    payload: Option<Value>,
}

/// Ingest one hook event. 401 on any auth failure; 200 even for an unknown event
/// kind (a no-op) so a future Claude event type never trips a tool call.
///
/// The body is taken as raw [`Bytes`] and parsed manually rather than via the
/// `Json` extractor ON PURPOSE: the extractor 415s any request whose
/// `Content-Type` is not exactly `application/json`, and the hook is a `curl -d`
/// POST whose default content type is `application/x-www-form-urlencoded`. A 415
/// here is invisible (the hook `|| true`s it away) yet fatal — it kills the
/// entire turn state machine. The hook command now sends the correct header, but
/// parsing leniently makes the endpoint robust to any future client / proxy that
/// drops or rewrites it, so the detector's authoritative signal can never be
/// silently severed by a content-type mismatch again.
async fn hook_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    raw: Bytes,
) -> Result<Json<Value>, AppError> {
    // Parse the JSON body ourselves (Content-Type agnostic). A malformed body is
    // a 400 — a genuine client bug, distinct from the silent 415 we are avoiding.
    let body: HookBody =
        serde_json::from_slice(&raw).map_err(|e| AppError::BadRequest(format!("hook body: {e}")))?;
    // The expected token is the session's own (DB is the source of truth;
    // survives restart). A missing session row → 401 (no existence oracle).
    let expected = db::sessions::runtime(&state.pool, &body.session)
        .await?
        .map(|rt| rt.hook_token)
        .ok_or(AppError::Unauthorized)?;

    let presented = headers
        .get(HOOK_TOKEN_HEADER)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    // Empty stored token (session never started → no secret minted) can never be
    // authenticated; and the compare is constant-time (no timing oracle).
    if expected.is_empty()
        || !constant_time_eq::constant_time_eq(expected.as_bytes(), presented.as_bytes())
    {
        return Err(AppError::Unauthorized);
    }

    // Authenticated. The session's Claude hooks are demonstrably LIVE (this POST
    // reached us), so flag it: the detector now treats the turn state machine +
    // content bank as authoritative and suppresses the raw PTY-heartbeat `Active`
    // fallback for this session — typing at the prompt echoes bytes but must not
    // read as "the agent is working". This fires on EVERY event kind (incl.
    // `SessionStart`, which lands in the boot window before the first prompt), so
    // the flag is set well before the user can type.
    state.mark_hooks_live(&body.session);

    // Fold the turn-state signal in for the events the detector
    // cares about (Notification→Waiting, turn-start→Active, …). Unknown
    // event kinds (e.g. SessionStart/SessionEnd/StopFailure) have NO HookEvent
    // variant and are skipped here — they are handled by the activity/lifecycle
    // dispatch below, NOT by the turn state machine.
    if let Some(event) = HookEvent::from_event_str(&body.event) {
        state.record_hook(&body.session, event);
    }

    // ── live activity + error + lifecycle from the PAYLOAD ──────────
    // Parse leniently (every field optional); a missing/odd/truncated payload
    // parses to the empty default and is a no-op rather than a 400.
    let payload: HookPayload = body
        .payload
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default();

    // Is this POST the LEAD's own event, or one fired by an in-process teammate
    // running under the same pane token? Decided ONCE per POST (the predicate is
    // read twice below) and only when the payload carries an `agent_type` at all,
    // so the overwhelmingly common no-agent_type path costs no extra DB read.
    let foreign_agent = if has_agent_type(&payload) {
        let tracked = db::sessions::cc_conversation_id(&state.pool, &body.session)
            .await
            .ok()
            .flatten();
        is_foreign_agent_payload(&payload, tracked.as_deref())
    } else {
        false
    };

    apply_payload(&state, &body.session, &body.event, &payload, foreign_agent);

    // Track the LIVE Claude conversation id so "this session" prompt-recall reads
    // the CURRENT transcript, not a stale one. Claude rotates conversation files
    // (a restart / `/clear` / compaction forks a fresh `<session_id>.jsonl`) and
    // the resume-only `set_cc_conversation_id` never followed — so a long-lived
    // session's `cc_conversation_id` drifted days behind the real conversation
    // (the stale-recall bug). Only on the two events that reliably carry a
    // main-session id (SessionStart = a fresh process; UserPromptSubmit = the user
    // acting) — NOT per-tool events, whose subagent hooks would otherwise thrash
    // it. The DB write is conditional (no-op unless the id changed).
    // ... and NEVER for an in-process teammate's own SessionStart OR
    // UserPromptSubmit: those payloads carry the TEAMMATE's session id, so
    // following one would point the lead's recall at the subagent's transcript.
    // (A teammate fires UserPromptSubmit every time the lead messages it, so
    // gating only the lifecycle events left the same corruption wide open.)
    if matches!(
        body.event.as_str(),
        "session_start" | "SessionStart" | "user_prompt" | "user_prompt_submit" | "UserPromptSubmit"
    ) && !foreign_agent
    {
        if let Some(id) = payload.session_id.as_deref() {
            if !id.is_empty() {
                let _ = db::sessions::track_cc_conversation_id(&state.pool, &body.session, id).await;
            }
        }
    }

    // Re-tick the detector now so the status (e.g. Notification → waiting,
    // SessionEnd → stopped) is broadcast within ~1s, not at the next tier edge.
    state.wake_detector(&body.session);

    Ok(Json(json!({ "ok": true })))
}

/// Derive + store the in-memory activity/error/lifecycle effects of one hook
/// event's PAYLOAD, broadcasting a `sessions` SSE delta only
/// when the activity/error actually changed (change-only). Pure
/// dispatch on the wire `event` token (accepts both the snake_case form supermux
/// emits and Claude's PascalCase). NOTHING here is persisted to disk/DB.
/// `foreign_agent` is [`is_foreign_agent_payload`], decided once by the caller:
/// true when this payload was fired by an in-process TEAMMATE session rather
/// than by the lead itself.
fn apply_payload(
    state: &AppState,
    session: &str,
    event: &str,
    payload: &HookPayload,
    foreign_agent: bool,
) {
    // An in-process teammate's OWN lifecycle is not the lead's. Since Claude Code
    // 2.1.232 a named subagent in a session with agent teams enabled runs as a
    // teammate with its own Claude session, and its SessionStart/SessionEnd hooks
    // fire under the PARENT pane's `$SUPERMUX_SESSION` token. `TaskStop` on such a
    // teammate emits `SessionEnd` (reason "other"), which used to force the LEAD
    // Stopped and, for an `archive_on_stop` session, auto-archive (kill) it while
    // it was still working. Ignore those events entirely here.
    if foreign_agent && is_lifecycle_event(event) {
        // Logged at info: a dropped lifecycle event is invisible in the UI (the
        // lead simply keeps its status), so a misclassified LEAD event would be
        // undiagnosable without this line.
        tracing::info!(
            name = %session,
            event = %event,
            payload_session_id = payload.session_id.as_deref().unwrap_or(""),
            agent_type = payload.agent_type.as_deref().unwrap_or(""),
            "ignoring lifecycle hook from an in-process teammate"
        );
        return;
    }

    let changed = match event {
        // A tool call started → set the live activity label (`✎ tile.tsx`, …).
        // A payload with no tool name yields no label → leave activity as-is.
        "pre_tool" | "pre_tool_use" | "PreToolUse" => {
            match activity::activity_label(payload) {
                Some((label, kind)) => state.set_activity(session, label, kind),
                None => false,
            }
        }
        // A tool FAILED → transient `✗ {tool} failed`. Claude has no dedicated
        // PostToolUseFailure event, so we ALSO treat a `post_tool` whose payload
        // carries an error as a failure; a clean PostToolUse is a no-op (it falls
        // through to the turn state machine for status, untouched here).
        "post_tool_failure" | "PostToolUseFailure" => {
            state.set_activity(session, activity::failed_label(payload), "failed".into())
        }
        "post_tool" | "post_tool_use" | "PostToolUse"
            if payload.error_type.is_some() || payload.error.is_some() =>
        {
            state.set_activity(session, activity::failed_label(payload), "failed".into())
        }
        // A Task sub-agent STARTED → bump the live outstanding count (the
        // display-only parallelism signal). Never touches the turn boundary.
        "subagent_start" | "SubagentStart" => state.inc_subagents(session),
        // The MAIN turn ended → clear the live activity (the error, if any,
        // persists until the next prompt/start) AND force-0 the subagent count
        // (the authoritative turn end; makes the finished-notification gate
        // fail-safe — a lost SubagentStop can't permanently suppress a finish).
        "stop" | "Stop" => {
            let act = state.clear_activity(session);
            let sub = state.reset_subagents(session);
            act || sub
        }
        // A Task sub-agent finished. It shares the parent session token and the
        // MAIN agent is still working, so do NOT wipe the main activity label or
        // end the turn (non-decisive, mirrors turn_end = Stop-only) — but DO
        // decrement the live outstanding count (saturating).
        "subagent_stop" | "SubagentStop" => state.dec_subagents(session),
        // A new prompt / a fresh session → the previous error is no longer
        // current (the user is acting again) → clear it, and reset the subagent
        // count for the new turn. Both effects are LEAD state, so a teammate's own
        // UserPromptSubmit (fired every time the lead messages it) must not run
        // them: it would wipe the lead's error badge and zero its outstanding
        // subagent count mid-turn.
        "user_prompt" | "user_prompt_submit" | "UserPromptSubmit" if !foreign_agent => {
            let err = state.clear_error(session);
            let sub = state.reset_subagents(session);
            err || sub
        }
        // Session lifecycle ───────────────────────────────────────────────────
        // Start: clear a stale error AND any pending forced-stopped override so
        // the detector re-evaluates the freshly-(re)started session freely.
        "session_start" | "SessionStart" => {
            // A brand-new Claude process: clear the stale forced-stopped override
            // AND wipe the previous process's in-progress turn so the detector
            // doesn't pin the freshly-booted, idle session Active (the
            // restart-stuck-loading bug). reset_turn_state has no activity-delta
            // effect; wake_detector (in the handler) re-ticks the status.
            state.reset_turn_state(session);
            state.clear_forced_status(session);
            state.clear_error(session)
        }
        // End: clear activity AND force Stopped now (the capture classifier can't
        // infer a clean exit). The forced status is applied by the detector loop;
        // we ALSO push the stopped status straight through the DB + watch + SSE so
        // the tile flips immediately, mirroring lifecycle::stop's broadcast.
        "session_end" | "SessionEnd" => {
            let act_changed = state.clear_activity(session);
            let sub_changed = state.reset_subagents(session);
            // The turn is definitively over when the session ends — drop it so a
            // later restart can't inherit it (belt-and-suspenders with the
            // SessionStart reset above).
            state.reset_turn_state(session);
            force_stopped(state, session);
            act_changed || sub_changed
        }
        // A turn failed with an agent error → record `{type, message}` for the
        // error badge (also clear the now-irrelevant activity).
        "stop_failure" | "StopFailure" => {
            let (etype, msg) = activity::error_info(payload);
            let cleared = state.clear_activity(session);
            let set = state.set_error(session, etype, msg);
            cleared || set
        }
        _ => false,
    };

    if changed {
        broadcast_activity_delta(state, session);
    }
}

/// True when `event` is one of Claude's session LIFECYCLE events (the ones whose
/// `apply_payload` arms touch the lead's forced status / turn state). Paired with
/// [`is_foreign_agent_payload`] this is the "teammate lifecycle" guard; tool and
/// turn events from a teammate are deliberately NOT filtered, so they still count
/// toward the pane's live activity.
fn is_lifecycle_event(event: &str) -> bool {
    matches!(
        event,
        "session_start" | "SessionStart" | "session_end" | "SessionEnd"
    )
}

/// True when `payload` carries a non-empty `agent_type` (whitespace counts as
/// absent). The cheap first half of [`is_foreign_agent_payload`], used to skip the
/// tie-breaker DB read on the common path.
fn has_agent_type(payload: &HookPayload) -> bool {
    payload.agent_type.as_deref().is_some_and(|t| !t.trim().is_empty())
}

/// A hook payload belongs to an in-process teammate (not the lead) when it carries
/// a non-empty `agent_type` AND its `session_id` is not the lead's own tracked
/// conversation id.
///
/// A teammate shares the pane's `$SUPERMUX_SESSION` (and therefore the hook
/// token), so its events are indistinguishable by transport. Captured shapes:
///   start: {"session_id":"<teammate>","agent_type":"general-purpose","hook_event_name":"SessionStart","source":"startup"}
///   end:   {"session_id":"<teammate>","agent_type":"general-purpose","hook_event_name":"SessionEnd","reason":"other"}
///
/// `agent_type` alone is NOT enough: Claude sets it from the MAIN-THREAD agent
/// type, so a lead launched with `claude --agent <name>` (or with `"agent"` in
/// settings.json) also carries it on its own lifecycle payloads. Masking those
/// would leave a zombie row: no forced Stopped, no teardown, no archive-on-stop.
/// The lead's tracked id (`sessions.cc_conversation_id`) is the tie-breaker; when
/// nothing is tracked yet the payload is accepted as the lead's (first contact
/// establishes the id), so an `--agent` lead self-heals on its first
/// SessionStart / UserPromptSubmit.
fn is_foreign_agent_payload(payload: &HookPayload, tracked_cc_id: Option<&str>) -> bool {
    if !has_agent_type(payload) {
        return false;
    }
    let sid = payload.session_id.as_deref().filter(|s| !s.trim().is_empty());
    let tracked = tracked_cc_id.filter(|t| !t.trim().is_empty());
    match (sid, tracked) {
        // Both known: the lead's own id is the lead's own event.
        (Some(sid), Some(tracked)) => sid != tracked,
        // Nothing tracked yet: give the payload to the lead so it can establish
        // its id (an `--agent` lead would otherwise be masked forever).
        (_, None) => false,
        // A tracked lead id exists and this payload names no session at all, so it
        // demonstrably is not the lead's own conversation.
        (None, Some(_)) => true,
    }
}

/// Force a session `Stopped` from a `SessionEnd` hook (lifecycle).
/// Sets the detector-loop override (so the next tick can't re-derive it back to
/// active) AND pushes the transition straight through the DB + status watch + SSE
/// `status` so connected tiles flip immediately — the exact triplet
/// `lifecycle::stop`/`start` use, so the wait-primitive + clients stay coherent.
fn force_stopped(state: &AppState, session: &str) {
    state.set_forced_status(session, Status::Stopped);
    // Best-effort DB writeback + broadcast on a detached task (the handler must
    // return fast, within the hook's `--max-time 1`). A failed write only delays
    // the flip to the next detector tick, which the forced override also covers.
    let state = state.clone();
    let session = session.to_string();
    tokio::spawn(async move {
        if let Err(e) =
            db::sessions::set_last_status(&state.pool, &session, Status::Stopped.as_str()).await
        {
            tracing::debug!(name = %session, error = %e, "SessionEnd: set_last_status failed");
        }
        let version = {
            let tx = state.status_watch_for(&session);
            let next = tx.borrow().1.wrapping_add(1);
            tx.send_replace((Status::Stopped.as_str().to_string(), next));
            next
        };
        let _ = state.sse_tx.send(SseEvent {
            event: "status".to_string(),
            payload: json!({
                "name": session,
                "status": Status::Stopped.as_str(),
                "version": version,
            }),
        });
        let _ = state.sse_tx.send(SseEvent {
            event: "sessions".to_string(),
            payload: json!({ "delta": [{ "name": session, "status": Status::Stopped.as_str() }] }),
        });
        // AFTER the status flip: SessionEnd means the lead agent is exiting right
        // now, so capture its pid while it is still the pane's foreground job and
        // let the teardown task wait out its death and reap the team's tmux
        // server. This forks tmux, and the tile flip must not wait on that; the
        // agent takes far longer than these few ms to actually leave the pane, and
        // the teardown polls for its death anyway.
        //
        // Kept BEFORE the auto-archive below: archiving tears the session's
        // runtime down, after which the lead pid is unrecoverable.
        if let Ok(rt) = state.runtime_for(&session).await {
            if let Some(pid) = crate::sessions::swarm::lead_pid_of(rt.as_ref()).await {
                crate::sessions::swarm::spawn_teardown_for_lead(pid);
            }
        }
        crate::sessions::lifecycle::maybe_archive_on_stop(&state, &session).await;
    });
}

/// Broadcast a `sessions` SSE delta carrying `name`'s current activity/error so
/// open overviews update the live line / error badge without a refetch.
/// Cheap; sent only when the snapshot changed (the caller gates
/// on that). A cleared field is sent as JSON `null` so the client drops it.
fn broadcast_activity_delta(state: &AppState, session: &str) {
    let act = state.session_activity(session).unwrap_or_default();
    let error = act.error.as_ref().map(|(t, m)| json!({ "type": t, "message": m }));
    let _ = state.sse_tx.send(SseEvent {
        event: "sessions".to_string(),
        payload: json!({ "delta": [{
            "name": session,
            // `null` when absent so a client clears the prior value.
            "activity": act.activity,
            "activity_kind": act.activity_kind,
            "error": error,
            // Live outstanding-subagent count (display-only parallelism signal).
            // Always present so a drop back to 0 clears the client's clause.
            "subagents": act.subagents,
        }] }),
    });
}

#[cfg(test)]
mod tests {
    //! Endpoint PAYLOAD dispatch. Drives [`apply_payload`] —
    //! the same in-memory derivation the live `/api/_internal/hook` handler runs
    //! after auth — so the activity/error/lifecycle effects are pinned without a
    //! live HTTP request. A real `AppState` (with a temp DB) is used so the
    //! `SessionEnd` forced-stop writeback task has a pool.

    use super::*;
    use crate::config::Config;

    async fn test_state() -> (AppState, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("supermux-hook-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let config = Config {
            data_dir: dir.clone(),
            bind: "127.0.0.1:0".parse().unwrap(),
            extra_binds: vec![],
            tls: Default::default(),
            auth_token: "test-token".to_string(),
            provider_defaults: Default::default(),
            ws: Default::default(),
            swarm_reaper: Default::default(),
            remote_callback_url: None,
            push_sub: None,
            github_token: None,
            extra_origins: Vec::new(),
        };
        let pool = crate::db::init(&config).await.expect("init pool");
        (AppState::new(pool, config), dir)
    }

    fn p(json: &str) -> HookPayload {
        serde_json::from_str(json).unwrap()
    }

    #[tokio::test]
    async fn subagent_count_rides_the_sessions_delta() {
        // The live overview gets the outstanding-subagent count on the SAME
        // change-only `sessions` SSE delta that already carries the activity line
        // — no new event type. The broadcasts fire synchronously inside
        // apply_payload, so the channel holds them immediately.
        let (state, dir) = test_state().await;
        let s = "lead-3";
        let mut rx = state.sse_tx.subscribe();

        apply_payload(&state, s, "subagent_start", &p("{}"), false);
        apply_payload(&state, s, "subagent_start", &p("{}"), false);

        let mut last_count: Option<i64> = None;
        while let Ok(ev) = rx.try_recv() {
            if ev.event == "sessions" {
                if let Some(d) = ev
                    .payload
                    .get("delta")
                    .and_then(|d| d.as_array())
                    .and_then(|a| a.first())
                {
                    if d.get("name").and_then(|n| n.as_str()) == Some(s) {
                        last_count = d.get("subagents").and_then(|v| v.as_i64());
                    }
                }
            }
        }
        assert_eq!(last_count, Some(2), "the sessions delta must carry subagents: 2");

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn pre_tool_sets_activity_and_stop_clears_it() {
        let (state, dir) = test_state().await;
        let s = "worker-1";

        apply_payload(
            &state,
            s,
            "pre_tool",
            &p(r#"{"tool_name":"Edit","tool_input":{"file_path":"src/tile.tsx"}}"#),
            false,
        );
        let act = state.session_activity(s).unwrap();
        assert_eq!(act.activity.as_deref(), Some("✎ tile.tsx"));
        assert_eq!(act.activity_kind.as_deref(), Some("edit"));

        // Stop clears the live activity; the snapshot prunes empty → None.
        apply_payload(&state, s, "stop", &p("{}"), false);
        assert!(state.session_activity(s).is_none(), "Stop clears activity");

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn subagent_stop_does_not_clear_the_main_activity() {
        // A Task subagent finishing (SubagentStop, on the parent session token)
        // means the MAIN agent is still working — its live activity label must
        // survive. Only the main Stop clears it.
        let (state, dir) = test_state().await;
        let s = "lead-1";

        apply_payload(
            &state,
            s,
            "pre_tool",
            &p(r#"{"tool_name":"Task","tool_input":{"description":"review"}}"#),
            false,
        );
        assert!(state.session_activity(s).is_some(), "pre_tool set an activity");

        apply_payload(&state, s, "subagent_stop", &p("{}"), false);
        assert!(
            state.session_activity(s).is_some(),
            "SubagentStop must NOT clear the main session's activity"
        );

        // The real main Stop still clears it.
        apply_payload(&state, s, "stop", &p("{}"), false);
        assert!(state.session_activity(s).is_none(), "main Stop clears activity");

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Read the live outstanding-subagent count (0 when there's no entry).
    fn subagents(state: &AppState, s: &str) -> u32 {
        state.session_activity(s).map(|a| a.subagents).unwrap_or(0)
    }

    #[tokio::test]
    async fn session_start_resets_a_stale_turn_state() {
        // A restarted session must NOT inherit the previous Claude process's
        // in-progress turn. The server keeps in-memory TurnState across a session
        // restart (it's only cleared on delete), and a turn left with
        // turn_start > turn_end (no clean Stop — e.g. the old process was killed,
        // or a dangling SubagentStop) makes the detector pin the freshly-booted,
        // idle session "active" until TURN_SAFETY (15 min). SessionStart (a new
        // process) must reset the turn machine so the detector classifies the new
        // session from scratch.
        use crate::sessions::status::{HookEvent, TurnState};
        let (state, dir) = test_state().await;
        let s = "restarted-1";

        // The previous process left a turn in progress (UserPromptSubmit/PreToolUse,
        // no Stop) → the detector would read this Active.
        state.record_hook(s, HookEvent::UserPromptSubmit);
        state.record_hook(s, HookEvent::PreToolUse);
        assert_ne!(
            state.turn_state(s),
            TurnState::default(),
            "precondition: a turn is in progress"
        );

        // The new process boots → SessionStart must wipe the stale turn.
        apply_payload(&state, s, "session_start", &p("{}"), false);
        assert_eq!(
            state.turn_state(s),
            TurnState::default(),
            "SessionStart must reset the stale turn state so the idle session isn't pinned active"
        );

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn subagent_start_stop_track_the_outstanding_count() {
        // Display-only parallelism signal: SubagentStart increments, SubagentStop
        // decrements (saturating), a new prompt resets, and the main Stop force-0s
        // (the authoritative turn end — bounds any drift to one turn).
        let (state, dir) = test_state().await;
        let s = "lead-2";

        apply_payload(&state, s, "subagent_start", &p("{}"), false);
        apply_payload(&state, s, "subagent_start", &p("{}"), false);
        apply_payload(&state, s, "subagent_start", &p("{}"), false);
        assert_eq!(subagents(&state, s), 3, "three subagents started");

        apply_payload(&state, s, "subagent_stop", &p("{}"), false);
        assert_eq!(subagents(&state, s), 2, "one finished → 2 outstanding");

        // Saturating: more stops than starts must clamp at 0, never underflow.
        apply_payload(&state, s, "subagent_stop", &p("{}"), false);
        apply_payload(&state, s, "subagent_stop", &p("{}"), false);
        apply_payload(&state, s, "subagent_stop", &p("{}"), false);
        assert_eq!(subagents(&state, s), 0, "saturating dec floors at 0");

        // A fresh turn resets the count.
        apply_payload(&state, s, "subagent_start", &p("{}"), false);
        apply_payload(&state, s, "subagent_start", &p("{}"), false);
        assert_eq!(subagents(&state, s), 2);
        apply_payload(&state, s, "user_prompt", &p("{}"), false);
        assert_eq!(subagents(&state, s), 0, "a new prompt resets the count");

        // The main Stop force-0s any stragglers (makes the notification gate
        // fail-safe: a lost SubagentStop can never permanently suppress a finish).
        apply_payload(&state, s, "subagent_start", &p("{}"), false);
        apply_payload(&state, s, "subagent_start", &p("{}"), false);
        assert_eq!(subagents(&state, s), 2);
        apply_payload(&state, s, "stop", &p("{}"), false);
        assert_eq!(subagents(&state, s), 0, "main Stop force-0s the count");

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn stop_failure_records_error_and_user_prompt_clears_it() {
        let (state, dir) = test_state().await;
        let s = "worker-1";

        apply_payload(
            &state,
            s,
            "stop_failure",
            &p(r#"{"error_type":"rate_limit","message":"quota exceeded"}"#),
            false,
        );
        let err = state.session_activity(s).unwrap().error.unwrap();
        assert_eq!(err.0, "rate_limit");
        assert_eq!(err.1, "quota exceeded");

        // The next UserPromptSubmit clears the (now-stale) error.
        apply_payload(&state, s, "user_prompt", &p("{}"), false);
        assert!(
            state.session_activity(s).and_then(|a| a.error).is_none(),
            "UserPromptSubmit clears the error"
        );

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn session_end_forces_stopped_and_clears_activity() {
        let (state, dir) = test_state().await;
        let s = "worker-1";

        // A live activity to be cleared by the end.
        apply_payload(&state, s, "pre_tool", &p(r#"{"tool_name":"Bash","tool_input":{"command":"sleep 1"}}"#), false);
        assert!(state.session_activity(s).is_some());

        apply_payload(&state, s, "session_end", &p("{}"), false);
        // Activity cleared.
        assert!(
            state.session_activity(s).and_then(|a| a.activity).is_none(),
            "SessionEnd clears activity"
        );
        // A Stopped override is pending for the detector loop to apply.
        assert_eq!(state.take_forced_status(s), Some(Status::Stopped));

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn session_start_clears_error_and_forced_status() {
        let (state, dir) = test_state().await;
        let s = "worker-1";

        // Seed an error + a pending forced-stop (as if from a prior end).
        state.set_error(s, "billing_error".into(), "card declined".into());
        state.set_forced_status(s, Status::Stopped);

        apply_payload(&state, s, "session_start", &p("{}"), false);
        assert!(
            state.session_activity(s).and_then(|a| a.error).is_none(),
            "SessionStart clears the error"
        );
        assert_eq!(state.take_forced_status(s), None, "SessionStart clears the forced stop");

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn teammate_session_end_is_ignored() {
        // Since Claude Code 2.1.232 a named in-process teammate has its OWN Claude
        // session and fires its own lifecycle hooks under the PARENT pane's
        // `$SUPERMUX_SESSION`. `TaskStop` on such a teammate emits SessionEnd with
        // reason "other". It must NOT force the lead Stopped (an `archive_on_stop`
        // session would then be auto-archived while still working) and must not
        // touch the lead's live activity.
        let (state, dir) = test_state().await;
        let s = "lead-teammate-end";

        apply_payload(&state, s, "pre_tool", &p(r#"{"tool_name":"Bash","tool_input":{"command":"sleep 1"}}"#), false);
        assert!(state.session_activity(s).is_some(), "precondition: a live activity");

        apply_payload(
            &state,
            s,
            "session_end",
            &p(r#"{"session_id":"x","agent_type":"general-purpose","reason":"other"}"#),
            // the caller decided this payload is a teammate's (its session_id is
            // not the lead's tracked conversation id)
            true,
        );

        assert!(
            state.session_activity(s).and_then(|a| a.activity).is_some(),
            "a teammate SessionEnd must NOT clear the lead's activity"
        );
        assert_eq!(
            state.take_forced_status(s),
            None,
            "a teammate SessionEnd must NOT force the lead Stopped"
        );

        // The lead's OWN SessionEnd (no agent_type) still forces Stopped.
        apply_payload(&state, s, "session_end", &p("{}"), false);
        assert_eq!(state.take_forced_status(s), Some(Status::Stopped));

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn teammate_session_start_is_ignored() {
        // The teammate's startup hook likewise must not read as "the lead
        // rebooted": it would clear the pending forced-stop and wipe the lead's
        // in-progress turn state mid-turn.
        use crate::sessions::status::{HookEvent, TurnState};
        let (state, dir) = test_state().await;
        let s = "lead-teammate-start";

        state.set_error(s, "billing_error".into(), "card declined".into());
        state.set_forced_status(s, Status::Stopped);
        state.record_hook(s, HookEvent::UserPromptSubmit);
        state.record_hook(s, HookEvent::PreToolUse);
        assert_ne!(state.turn_state(s), TurnState::default(), "precondition: a turn is in progress");

        apply_payload(
            &state,
            s,
            "session_start",
            &p(r#"{"session_id":"x","agent_type":"general-purpose","source":"startup"}"#),
            // the caller decided this payload is a teammate's (its session_id is
            // not the lead's tracked conversation id)
            true,
        );

        assert_eq!(
            state.take_forced_status(s),
            Some(Status::Stopped),
            "a teammate SessionStart must NOT clear the lead's forced status"
        );
        assert!(
            state.session_activity(s).and_then(|a| a.error).is_some(),
            "a teammate SessionStart must NOT clear the lead's error"
        );
        assert_ne!(
            state.turn_state(s),
            TurnState::default(),
            "a teammate SessionStart must NOT reset the lead's turn state"
        );

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn change_only_broadcast_is_suppressed_on_no_op() {
        let (state, dir) = test_state().await;
        let s = "worker-1";
        let mut rx = state.sse_tx.subscribe();

        // A clean PostToolUse (no error) is a no-op for activity → no broadcast.
        apply_payload(&state, s, "post_tool", &p(r#"{"tool_name":"Read"}"#), false);
        assert!(rx.try_recv().is_err(), "clean post_tool must not broadcast");

        // A PreToolUse with no tool name is also a no-op.
        apply_payload(&state, s, "pre_tool", &p("{}"), false);
        assert!(rx.try_recv().is_err(), "tool-less pre_tool must not broadcast");

        // A real activity change DOES broadcast a `sessions` delta.
        apply_payload(&state, s, "pre_tool", &p(r#"{"tool_name":"Read","tool_input":{"file_path":"a.rs"}}"#), false);
        let ev = rx.try_recv().expect("activity change broadcasts");
        assert_eq!(ev.event, "sessions");

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn post_tool_with_error_sets_failed_label() {
        let (state, dir) = test_state().await;
        let s = "worker-1";

        apply_payload(
            &state,
            s,
            "post_tool",
            &p(r#"{"tool_name":"Bash","error_type":"non_zero_exit"}"#),
            false,
        );
        let act = state.session_activity(s).unwrap();
        assert_eq!(act.activity.as_deref(), Some("✗ Bash failed"));
        assert_eq!(act.activity_kind.as_deref(), Some("failed"));

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn foreign_agent_payload_needs_both_agent_type_and_a_different_id() {
        // No agent_type at all: always the lead's own payload.
        assert!(!is_foreign_agent_payload(&p(r#"{"session_id":"lead-1"}"#), Some("lead-1")));
        assert!(!is_foreign_agent_payload(&p(r#"{"session_id":"other"}"#), Some("lead-1")));

        // agent_type but nothing tracked yet: accept it as the lead's, so a lead
        // launched as `claude --agent <name>` can establish its own id instead of
        // being masked forever.
        assert!(!is_foreign_agent_payload(
            &p(r#"{"session_id":"lead-1","agent_type":"reviewer"}"#),
            None
        ));
        assert!(!is_foreign_agent_payload(
            &p(r#"{"session_id":"lead-1","agent_type":"reviewer"}"#),
            Some("")
        ));

        // agent_type + the SAME id as the lead's tracked conversation: the
        // `--agent` lead's own lifecycle, must still be handled.
        assert!(!is_foreign_agent_payload(
            &p(r#"{"session_id":"lead-1","agent_type":"reviewer"}"#),
            Some("lead-1")
        ));

        // agent_type + a DIFFERENT id: a real in-process teammate.
        assert!(is_foreign_agent_payload(
            &p(r#"{"session_id":"teammate-9","agent_type":"general-purpose"}"#),
            Some("lead-1")
        ));
        // agent_type, a tracked lead id, and no session_id at all: not the lead's.
        assert!(is_foreign_agent_payload(
            &p(r#"{"agent_type":"general-purpose"}"#),
            Some("lead-1")
        ));

        // An empty / whitespace agent_type counts as ABSENT (never mask a real
        // lifecycle event on it: the failure mode is a zombie session).
        assert!(!is_foreign_agent_payload(
            &p(r#"{"session_id":"teammate-9","agent_type":""}"#),
            Some("lead-1")
        ));
        assert!(!is_foreign_agent_payload(
            &p(r#"{"session_id":"teammate-9","agent_type":"  "}"#),
            Some("lead-1")
        ));
        assert!(!has_agent_type(&p(r#"{"agent_type":" "}"#)));
    }

    #[tokio::test]
    async fn teammate_user_prompt_leaves_the_lead_error_and_subagents_alone() {
        // A teammate fires UserPromptSubmit every time the lead messages it. That
        // is not the lead acting, so it must not clear the lead's error badge nor
        // force-0 its outstanding-subagent count mid-turn.
        let (state, dir) = test_state().await;
        let s = "lead-teammate-prompt";

        state.set_error(s, "billing_error".into(), "card declined".into());
        apply_payload(&state, s, "subagent_start", &p("{}"), false);
        apply_payload(&state, s, "subagent_start", &p("{}"), false);
        assert_eq!(subagents(&state, s), 2, "precondition: two outstanding");

        apply_payload(
            &state,
            s,
            "user_prompt_submit",
            &p(r#"{"session_id":"teammate-9","agent_type":"general-purpose"}"#),
            true,
        );
        assert!(
            state.session_activity(s).and_then(|a| a.error).is_some(),
            "a teammate prompt must NOT clear the lead's error"
        );
        assert_eq!(subagents(&state, s), 2, "a teammate prompt must NOT reset the count");

        // The lead's OWN prompt still does both.
        apply_payload(&state, s, "user_prompt_submit", &p("{}"), false);
        assert!(state.session_activity(s).and_then(|a| a.error).is_none());
        assert_eq!(subagents(&state, s), 0);

        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }
}
