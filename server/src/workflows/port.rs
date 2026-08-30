//! Post-upgrade reconciliation for the `schedules` → `workflows` port.
//!
//! `0038_workflows.sql` does the port itself, inside one transaction. Two
//! things it cannot do are done here instead, once, at boot:
//!
//! 1. **Re-derive `company_id`.** The migration reads `sessions.company_id` at
//!    the moment it runs. In a restored database a `sessions` row can appear
//!    *after* that — so the cache SQL wrote may already be stale by first boot.
//!    Re-deriving is cheap, idempotent, and the only way the cache can be
//!    trusted (spec §7.5).
//! 2. **Tell the user what could not be carried over.** A shell job, a boot job
//!    and a `done_action: command:…` follow-up all end up in
//!    `workflows_import_log`. Losing them silently is the failure this whole
//!    port was written to avoid, so the first boot after the upgrade raises
//!    **one** SSE `alerts` frame and **one** push naming the count — never one
//!    per row, and never again on a later boot.
//!
//! **Idempotency** rides on the audit row: `workflows.port` in `audit_log` is
//! written the first time the alert is raised, and its presence is what makes
//! every later boot re-derive silently. This module never touches anything the
//! migration owns — it reads the import log and writes only `workflows.company_id`.

use serde_json::json;

use crate::db;
use crate::error::AppError;
use crate::state::{AppState, SseEvent};

/// What one `reconcile` did. Returned so the caller (and the tests) can assert
/// on it rather than on log lines.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ReconcileReport {
    /// Workflows whose `company_id` cache was corrected.
    pub rederived: usize,
    /// Rows in the import log that could not be carried over at all.
    pub unported: usize,
    /// Ported rows whose `done_action: command:…` follow-up was dropped.
    pub command_notes: usize,
    /// Whether THIS call raised the one-time alert. `false` on every boot after
    /// the first, and on a clean upgrade with nothing to report.
    pub alerted: bool,
}

/// The audit action that marks the port as already announced.
const PORT_AUDIT_ACTION: &str = "workflows.port";

/// The import-log reason 0038 writes for a dropped `command:` follow-up.
/// Matched as a prefix so the sentence can gain a tail without breaking this.
const COMMAND_REASON_HEAD: &str = "done_action command:";

/// Run the post-upgrade reconciliation. Safe to call on every boot.
pub async fn reconcile(state: &AppState) -> Result<ReconcileReport, AppError> {
    // 1. The cache, always. This is the half that must run every boot.
    let rederived = db::workflows::resync_company_ids(&state.pool).await? as usize;

    // 2. The import log. A database that never held a `schedules` row has an
    //    empty log and nothing to say.
    let unported = count_where(state, "ported = 0").await?;
    let command_notes =
        count_where(state, &format!("ported = 1 AND reason LIKE '{COMMAND_REASON_HEAD}%'")).await?;

    let mut report = ReconcileReport { rederived, unported, command_notes, alerted: false };
    if unported == 0 && command_notes == 0 {
        return Ok(report);
    }

    // 3. Announce ONCE. The audit row is the latch: if it is already there this
    //    upgrade has been reported, and repeating it on every restart would
    //    train the user to dismiss it.
    if db::audit::has_action(&state.pool, PORT_AUDIT_ACTION).await? {
        return Ok(report);
    }

    let detail = summary(unported, command_notes);
    let _ = state.sse_tx.send(SseEvent::global(
        "alerts",
        json!({
            "level": "warn",
            "source": "workflows",
            "detail": detail,
            "unported": unported,
            "command_notes": command_notes,
        }),
    ));

    // One push, in the schedule lane — the same persisted category the old
    // scheduler used, deliberately NOT renamed (a renamed NotifCategory value
    // silently un-mutes a user who muted it).
    let st = state.clone();
    let body = detail.clone();
    tokio::spawn(async move {
        let _ = crate::push::send_push_for(
            &st,
            crate::db::push::NotifCategory::ScheduleError,
            &crate::notify::PushPayload::simple(
                "old schedules need a look".to_string(),
                body,
                "/settings#imported-schedules",
                crate::notify::Tier::Schedule,
            ),
            None,
        )
        .await;
    });

    db::audit::log(
        &state.pool,
        "server",
        PORT_AUDIT_ACTION,
        "workflows",
        json!({ "unported": unported, "command_notes": command_notes, "rederived": rederived }),
    )
    .await?;

    tracing::info!(unported, command_notes, rederived, "workflows: reported the schedules port");
    report.alerted = true;
    Ok(report)
}

/// The one sentence the user reads. Says the count and where to look; it never
/// claims anything was migrated that was not.
fn summary(unported: usize, command_notes: usize) -> String {
    let mut parts: Vec<String> = Vec::new();
    if unported > 0 {
        parts.push(format!(
            "{unported} old schedule{} could not be carried over to Workflows",
            if unported == 1 { "" } else { "s" }
        ));
    }
    if command_notes > 0 {
        parts.push(format!(
            "{command_notes} kept {} follow-up command that was removed",
            if command_notes == 1 { "a" } else { "their" }
        ));
    }
    format!("{} — review them in Settings.", parts.join(", and "))
}

/// `SELECT COUNT(*) FROM workflows_import_log WHERE <predicate>`. The predicate
/// is a literal from this file, never user input.
async fn count_where(state: &AppState, predicate: &str) -> Result<usize, AppError> {
    let sql = format!("SELECT COUNT(*) FROM workflows_import_log WHERE {predicate}");
    let n: i64 = sqlx::query_scalar(&sql).fetch_one(&state.pool).await?;
    Ok(n as usize)
}
