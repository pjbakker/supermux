//! `/api/schedules` — a READ-ONLY projection of workflows, and `410 Gone` on
//! every write.
//!
//! DELETE THIS MODULE in the release after v1 ships. Tracked: spec §5.2.
//!
//! **Why it exists at all.** A PWA can be wedged on a stale bundle — it has
//! happened on this host (the `index.html`/`navigateFallback` incident, fixed in
//! 76f9fef). A client stuck on the pre-workflows bundle would otherwise call
//! `/api/schedules`, get a 404, and render a crash instead of a list. So the
//! three GETs keep answering, from the NEW tables, in the OLD JSON shape: the
//! stale client shows a correct-if-simplified list until the service worker
//! swaps it out.
//!
//! **Why the writes are 410 and not a redirect.** A 307/308 on POST re-plays a
//! mutating body against a different contract — an old `{kind:"shell",
//! command:"…"}` would arrive at a validator that has never heard of either
//! field. `410 Gone` with a sentence naming the fix ("reload supermux") is a
//! terminal answer the web client's error path can recognise and turn into the
//! service-worker update prompt.
//!
//! **The projection is LOSSY, deliberately.** `kind` is always `"tmux"` (the
//! other two are the dragon this feature killed), `command`/`prompt` come from
//! step 0, and `done_action` maps back to the closest old spelling. Nothing in
//! here can ever emit `command:<text>`: there is no arm that produces it, which
//! is the property that matters.

use axum::extract::{Path, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Serialize;
use serde_json::json;

use crate::auth_human::AuthContext;
use crate::db;
use crate::db::workflows::{Workflow, WorkflowStep};
use crate::error::AppError;
use crate::scope::{OptCtx, Scope};
use crate::state::AppState;

use super::complete::CompletionAction;

/// The sentence a stale client is answered with. The web error path matches on
/// the 410 status, not on this text, but the text is what a human sees in a
/// network log or a curl.
const GONE: &str = "Schedules were replaced by Workflows — reload supermux to continue.";

/// The legacy sub-router. Merged into `http::protected_router` where
/// `scheduler::router_for` used to sit.
pub fn router_for(state: AppState) -> Router {
    Router::new()
        .route("/api/schedules", get(list_handler).post(gone).patch(gone).delete(gone))
        // Static segments alongside `{id}`, the same shape the real router has.
        .route("/api/schedules/preview", post(gone).get(gone))
        .route("/api/schedules/commands", get(gone))
        .route("/api/schedules/runs", get(all_runs_handler))
        .route(
            "/api/schedules/{id}",
            get(get_handler).post(gone).patch(gone).put(gone).delete(gone),
        )
        .route("/api/schedules/{id}/runs", get(runs_handler))
        .route("/api/schedules/{id}/run", post(gone))
        .with_state(state)
}

/// Every write verb, one answer.
async fn gone() -> Result<Json<serde_json::Value>, AppError> {
    Err(AppError::Gone(GONE.to_string()))
}

#[derive(Serialize)]
struct Envelope<T> {
    ok: bool,
    data: T,
}

fn ok<T: Serialize>(data: T) -> Json<Envelope<T>> {
    Json(Envelope { ok: true, data })
}

/// The old `Schedule` JSON, built from a workflow and its first step.
///
/// Serialized by hand rather than through `db::schedules::Schedule` because that
/// struct dies with its table in Phase 4 — the shim must not be the reason a
/// deleted type has to stay.
fn project(wf: &Workflow, steps: &[WorkflowStep]) -> serde_json::Value {
    let first = steps.first();
    // `done_action` mapping. There is no old spelling for "do nothing", and the
    // old DEFAULT was `disable`, so `none` maps there — the least surprising
    // badge, and never an invented `command:`.
    let done_action = match super::complete::parse(&wf.on_complete).unwrap_or_default() {
        CompletionAction::Notify
        | CompletionAction::ConnectorSend { .. }
        | CompletionAction::MessageBot { .. } => "notify",
        CompletionAction::Disable | CompletionAction::None => "disable",
    };
    json!({
        "id": wf.id,
        "title": wf.title,
        "session": wf.session,
        "command": first.map(|s| s.command.as_str()).unwrap_or(""),
        "prompt": first.map(|s| s.prompt.as_str()).unwrap_or(""),
        // `shell` and `boot` are gone and cannot be expressed; everything a
        // workflow does is delivered into a pane.
        "kind": "tmux",
        "boot_dir": "",
        "boot_provider": "claude",
        "boot_worktree": 0,
        // A `manual` workflow has no old equivalent. `once` with a null
        // `next_run` is the closest: a stale client renders "no next run", which
        // is exactly true.
        "sched_type": if wf.trigger_kind == "recurring" { "recurring" } else { "once" },
        "recurrence": serde_json::Value::Null,
        "run_at": serde_json::Value::Null,
        "next_run": wf.next_run,
        "last_run": wf.last_run,
        "enabled": wf.enabled,
        "run_count": wf.run_count,
        "schedule_expr": wf.schedule_expr,
        "watch": (done_action == "notify") as i64,
        "watch_timeout": first.map(|s| s.timeout_secs).unwrap_or(db::workflows::DEFAULT_STEP_TIMEOUT),
        "done_pattern": serde_json::Value::Null,
        "done_action": done_action,
        // Agent-confirmed finish is unconditional in v1.
        "confirm_finish": 1,
        "bypass_permissions": 0,
        "created": wf.created,
        "updated": wf.updated,
        "deleted": wf.deleted,
    })
}

async fn projected(
    state: &AppState,
    wf: &Workflow,
) -> Result<serde_json::Value, AppError> {
    let steps = db::workflows::steps_for(&state.pool, &wf.id).await?;
    Ok(project(wf, &steps))
}

async fn list_handler(
    State(state): State<AppState>,
    OptCtx(ctx): OptCtx,
) -> Result<Json<Envelope<Vec<serde_json::Value>>>, AppError> {
    let scope = Scope::of(ctx.as_ref());
    let mut out = Vec::new();
    for wf in db::workflows::list(&state.pool).await? {
        if !scope.sees(wf.company_id) {
            continue;
        }
        out.push(projected(&state, &wf).await?);
    }
    Ok(ok(out))
}

async fn get_handler(
    State(state): State<AppState>,
    OptCtx(ctx): OptCtx,
    Path(id): Path<String>,
) -> Result<Json<Envelope<serde_json::Value>>, AppError> {
    let wf = load(&state, ctx.as_ref(), &id).await?;
    Ok(ok(projected(&state, &wf).await?))
}

/// The old `schedule_runs` shape: `{id, schedule_id, ran_at, status, note}`.
async fn runs_handler(
    State(state): State<AppState>,
    OptCtx(ctx): OptCtx,
    Path(id): Path<String>,
) -> Result<Json<Envelope<Vec<serde_json::Value>>>, AppError> {
    let wf = load(&state, ctx.as_ref(), &id).await?;
    let runs = db::workflows::runs_for(&state.pool, &wf.id, 20).await?;
    Ok(ok(runs
        .into_iter()
        .map(|r| {
            json!({
                "id": r.id,
                "schedule_id": r.workflow_id,
                "ran_at": r.started_at,
                "status": r.status,
                "note": r.note,
            })
        })
        .collect()))
}

/// The old cross-schedule feed. Not in spec §5.2's enumerated three, but it is a
/// READ the stale dashboard's activity list calls, and answering it costs
/// nothing while a 404 would put a red line in someone's console for a bundle
/// they cannot control.
async fn all_runs_handler(
    State(state): State<AppState>,
    OptCtx(ctx): OptCtx,
) -> Result<Json<Envelope<Vec<serde_json::Value>>>, AppError> {
    let scope = Scope::of(ctx.as_ref());
    let rows = db::workflows::recent_runs(&state.pool, 50).await?;
    Ok(ok(rows
        .into_iter()
        .filter(|r| scope.sees(r.company_id))
        .map(|r| {
            json!({
                "id": r.id,
                "schedule_id": r.workflow_id,
                "ran_at": r.started_at,
                "status": r.status,
                "note": r.note,
                "title": r.title,
            })
        })
        .collect()))
}

/// The uniform 404, echoing the id the caller typed, in the old vocabulary.
async fn load(
    state: &AppState,
    ctx: Option<&AuthContext>,
    id: &str,
) -> Result<Workflow, AppError> {
    let missing = || AppError::NotFound(format!("schedule '{id}'"));
    let wf = db::workflows::get(&state.pool, id).await?.ok_or_else(missing)?;
    if !Scope::of(ctx).sees(wf.company_id) {
        return Err(missing());
    }
    Ok(wf)
}
