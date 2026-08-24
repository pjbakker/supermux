//! Workflows — a bot, an ORDERED list of prompt steps, a trigger, and a typed
//! completion action.
//!
//! The successor to `scheduler/`. This module owns the cadence grammar
//! ([`parser`], moved here unchanged), the post-upgrade reconciliation that runs
//! once at boot after `0038_workflows.sql`, and — from Phase 2 — the execution
//! engine and its 10s tick.

pub mod complete;
pub mod engine;
pub mod parser;
pub mod port;

use std::time::Duration;

use chrono::{DateTime, Utc};
use serde_json::json;
use tokio::time::MissedTickBehavior;

use crate::db;
use crate::state::{AppState, SseEvent};

// ── constants ─────────────────────────────────────────────────────────────────
//
// Carried over VERBATIM from `scheduler::mod` (spec §3.2). Every one of them is
// a behaviour the old scheduler earned the hard way; none of them is a new
// tuning knob.

/// The workflows tick interval (explicit 10s).
pub const TICK_INTERVAL: Duration = Duration::from_secs(10);
/// Past-due tolerance: beyond this, the window is treated as missed.
pub const MISSED_WINDOW: chrono::Duration = chrono::Duration::seconds(60);
/// Grace window for a *one-shot* (`trigger_kind == 'once'`): a single-fire
/// workflow past due by less than this is still FIRED rather than silently
/// discarded — the server may simply have been down when it came due.
pub const ONESHOT_GRACE: chrono::Duration = chrono::Duration::hours(6);
/// Default per-step deadline (seconds) — today's `DEFAULT_WATCH_TIMEOUT`. The
/// status→idle signal is event-driven (no polling cost while waiting), so a
/// generous default lets long agent steps run to completion.
pub use crate::db::workflows::DEFAULT_STEP_TIMEOUT;
/// How many workflows one bot may own.
pub const MAX_WORKFLOWS_PER_SESSION: usize = 20;
/// How many steps one workflow may carry.
pub const MAX_STEPS_PER_WORKFLOW: usize = 20;
/// How many steps a workflow created over the AGENT hook path may carry — a
/// session token arms less than a human at a keyboard does.
pub const MAX_STEPS_VIA_HOOK: usize = 5;

/// Compute the next `count` fire times for `expr` relative to now (no DB I/O).
/// A one-shot yields a single time; recurring expressions are walked forward via
/// the parser's [`parser::Recurrence`].
///
/// Moved verbatim from `scheduler::preview_runs` — the next-5-runs preview is
/// one of the few genuinely good bits of today's create dialog.
pub fn preview_runs(expr: &str, count: usize) -> Result<Vec<DateTime<Utc>>, String> {
    let now = Utc::now();
    let parsed = parser::parse(expr, now).map_err(|e| e.to_string())?;
    let mut out = vec![parsed.next_run];
    let mut cursor = parsed.next_run;
    while out.len() < count {
        match parsed.recurrence.next_after(cursor, cursor) {
            Some(next) if next > cursor => {
                out.push(next);
                cursor = next;
            }
            _ => break, // one-shot, or no further occurrences
        }
    }
    Ok(out)
}

// ── tick loop ─────────────────────────────────────────────────────────────────

/// Spawn the 10s workflows tick (fire-and-forget; errors are logged only).
///
/// [`MissedTickBehavior::Skip`] is load-bearing, not a preference: the default
/// `Burst` fires every missed tick at once after a laptop sleep and would
/// dispatch each due workflow N times.
pub fn spawn(state: AppState) {
    tokio::spawn(async move {
        // A restart is EXACTLY when in-memory watchers were lost, so the reaper
        // runs once at boot before the first tick — otherwise a run interrupted
        // by the restart would sit `running` forever and rule 2 would block its
        // workflow from ever firing again (§3.6).
        engine::reap(&state).await;
        let mut tick = tokio::time::interval(TICK_INTERVAL);
        tick.set_missed_tick_behavior(MissedTickBehavior::Skip);
        loop {
            tick.tick().await;
            if let Err(e) = tick_once(&state).await {
                tracing::warn!(error = %e, "workflows tick failed");
            }
        }
    });
}

/// One tick: dispatch due workflows, skipping (and advancing) missed windows.
/// Public so a test can drive a single tick deterministically instead of racing
/// a 10s interval.
pub async fn tick_once(state: &AppState) -> anyhow::Result<()> {
    let now = Utc::now();
    let candidates = db::workflows::enabled_with_next(&state.pool).await?;

    for wf in candidates {
        let Some(next_run) = wf
            .next_run
            .as_deref()
            .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
            .map(|d| d.with_timezone(&Utc))
        else {
            continue;
        };
        if next_run > now {
            continue; // not due yet
        }

        let scheduled_for_ts = next_run.timestamp();

        // §3.2 rule 2 — ONE RUN AT A TIME, checked BEFORE the fire-key so the
        // skip is recorded against THIS window rather than swallowed by the
        // in-flight run's own claim. A chain can outlive its cadence, and two
        // interleaved chains in one pane would be indistinguishable garbage in
        // the transcript. `next_run` still advances: the workflow keeps its
        // rhythm, it just misses this beat, and the ledger says so out loud.
        match db::workflows::running_for(&state.pool, &wf.id).await {
            Ok(Some(inflight)) => {
                let _ = db::workflows::insert_run(
                    &state.pool,
                    &wf.id,
                    now.timestamp(),
                    "tick",
                    "skipped",
                    &format!("previous run #{} still in flight", inflight.id),
                )
                .await;
                let next = engine::recompute_next(&wf, now);
                let _ = db::workflows::advance_next(&state.pool, &wf.id, next).await;
                continue;
            }
            Ok(None) => {}
            Err(e) => tracing::warn!(workflow = %wf.id, error = %e, "in-flight check failed"),
        }

        if now - next_run > MISSED_WINDOW {
            // A still-recent ONE-SHOT is honoured late rather than discarded.
            // `recompute_next` returns `None` for `trigger_kind='once'`, so the
            // generic skip path below would NULL `next_run` + set `enabled = 0`
            // — silently dropping a one-shot that came due before the server's
            // first tick (down at creation, a brief busy spell, a restored DB).
            // Inside the grace window we fall through to the normal dispatch.
            let recent_oneshot = wf.trigger_kind == "once" && now - next_run <= ONESHOT_GRACE;
            if !recent_oneshot {
                // Missed-window: log + advance, do NOT fire. Claim the fire-key
                // FIRST so this only catches GENUINELY missed windows (server
                // downtime); the ordering is what distinguishes downtime from a
                // long job, and it is carried over deliberately.
                match db::workflows::claim_run_key(&state.pool, &wf.id, scheduled_for_ts).await {
                    Ok(true) => {
                        let _ = db::workflows::insert_run(
                            &state.pool,
                            &wf.id,
                            now.timestamp(),
                            "tick",
                            "skipped",
                            "missed window",
                        )
                        .await;
                        let next = engine::recompute_next(&wf, now);
                        let _ = db::workflows::advance_next(&state.pool, &wf.id, next).await;
                        tracing::info!(workflow = %wf.id, "advanced past a missed window (not fired)");
                        // Surface it — this path used to be log-only, i.e.
                        // invisible. Company-stamped so the bot's own people see
                        // it, not just the owner.
                        let _ = state.sse_tx.send(SseEvent::for_company(
                            "alerts",
                            json!({
                                "level": "info",
                                "source": "workflows",
                                "workflow": wf.id,
                                "detail": format!(
                                    "Skipped workflow '{}' — its fire window was missed",
                                    wf.title
                                ),
                            }),
                            wf.company_id,
                        ));
                    }
                    Ok(false) => {} // already handled — leave next_run to record_fire
                    Err(e) => tracing::warn!(workflow = %wf.id, error = %e, "missed-window claim failed"),
                }
                continue;
            }
            tracing::info!(
                workflow = %wf.id,
                "one-shot past due within the grace window — firing late rather than skipping",
            );
            // fall through to the normal dispatch below
        }

        // The idempotency gate: a restart mid-dispatch cannot double-fire the
        // same (workflow, fire-time) tuple.
        match db::workflows::claim_run_key(&state.pool, &wf.id, scheduled_for_ts).await {
            Ok(true) => {}
            Ok(false) => {
                tracing::debug!(workflow = %wf.id, scheduled_for_ts, "duplicate fire skipped");
                continue;
            }
            Err(e) => {
                tracing::warn!(workflow = %wf.id, error = %e, "fire-key claim failed");
                continue;
            }
        }
        if let Err(e) = engine::start(state, wf.clone(), engine::Trigger::Tick).await {
            tracing::warn!(workflow = %wf.id, error = %e, "workflow dispatch failed");
        }
    }

    // §3.6 — the reaper rides the same tick.
    engine::reap(state).await;
    Ok(())
}
