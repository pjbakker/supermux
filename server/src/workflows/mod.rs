//! Workflows — a bot, an ORDERED list of prompt steps, a trigger, and a typed
//! completion action.
//!
//! The successor to `scheduler/`. This module owns the cadence grammar
//! ([`parser`], moved here unchanged), the post-upgrade reconciliation that runs
//! once at boot after `0038_workflows.sql`, and — from Phase 2 — the execution
//! engine and its 10s tick.

pub mod parser;
pub mod port;

use std::time::Duration;

use chrono::{DateTime, Utc};

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
