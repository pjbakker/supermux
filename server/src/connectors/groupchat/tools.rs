//! The group-chat tool endpoint: `POST /api/hook/groupchat/tool`.
//!
//! Called ONLY by the embedded MCP server ([`super`]) that a granted bot
//! launches. It sits on the same no-bearer, per-session-hook-token router family
//! as the status hook, the board hook and the browser tool endpoint — and for
//! the same reason: the caller runs inside a pane and must never hold the
//! dashboard bearer.
//!
//! ```text
//!   bot ──stdio──▶ mcp_server.py ──HTTP(hook token)──▶ THIS ──▶ companies::groupchat
//! ```
//!
//! # The gates, in order
//!
//! 1. **Identity.** `X-Supermux-Hook-Token` is constant-time compared against
//!    that session's `session_runtime.hook_token`. Bot A's token authenticates
//!    only bot A.
//! 2. **Company.** The company is read from the SESSION ROW, never from the
//!    request or from the baked `SUPERMUX_COMPANY_ID`. A session with no
//!    company has no channel to reach.
//! 3. **Connector grant.** The session must hold an enabled `group-chat` grant
//!    (its own, its company's `@company:<id>` tier, or the all-agents one).
//! 4. **Per-tool rules.** `tag_bot` is Router-only and passes the CODE-SIDE
//!    two-tags-per-routing-turn cap; `post_message` is `@`-stripped; every read
//!    is budget-capped. These live here, on the single path, rather than in the
//!    Python — a forwarder cannot be a fence.
//!
//! Nothing in here wakes a bot except `tag_bot`, which is the one tool whose
//! entire job is to wake exactly one.

use axum::extract::State;
use axum::http::HeaderMap;
use axum::routing::post;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::companies::groupchat as gc;
use crate::db;
use crate::error::AppError;
use crate::extract::LenientJson;
use crate::state::AppState;

/// The largest `post_message` / `tag_bot` text this endpoint accepts. Matches
/// the channel's own row cap so a refusal happens at the door, once.
const TEXT_MAX_BYTES: usize = gc::POST_MAX_BYTES;

pub fn router_for(state: AppState) -> Router {
    Router::new()
        .route("/api/hook/groupchat/tool", post(tool_handler))
        .with_state(state)
}

#[derive(Debug, Deserialize)]
pub struct ToolBody {
    /// The supermux session name (`$SUPERMUX_SESSION`); scopes the token check
    /// AND names the caller in the channel.
    pub session: String,
    /// `read_history` | `who_tagged_me` | `post_message` | `tag_bot` | `whoami`.
    pub tool: String,
    #[serde(default)]
    pub args: Value,
}

/// `POST /api/hook/groupchat/tool` — run ONE group-chat tool for a granted bot.
async fn tool_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    LenientJson(body): LenientJson<ToolBody>,
) -> Result<Json<Value>, AppError> {
    // 1. Identity (401 on any miss, including an unknown session — no oracle).
    crate::hooks::verify_hook_token(&state, &body.session, &headers).await?;
    if !crate::sessions::valid_name(&body.session) {
        return Err(AppError::BadRequest("invalid session name".into()));
    }
    // 2. Company — from the row, never from the request.
    let row = db::sessions::get(&state.pool, &body.session)
        .await?
        .ok_or(AppError::Unauthorized)?;
    let Some(company_id) = row.company_id else {
        return Err(AppError::Forbidden(
            "this session is not in a company, so it has no group chat".into(),
        ));
    };
    let company = db::companies::get(&state.pool, company_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("company id={company_id}")))?;
    // 3. Connector grant — an ungranted bot that somehow learned the URL is a
    //    403, and reaches no channel.
    let granted = db::connectors::grants_for_session(&state.pool, &body.session)
        .await
        .unwrap_or_default()
        .into_iter()
        .any(|g| g.connector_id == super::GROUPCHAT_ID);
    if !granted {
        return Err(AppError::Forbidden(
            "this session has no group-chat grant".into(),
        ));
    }
    let result = run(&state, &company, &body.session, &body.tool, &body.args).await?;
    Ok(Json(json!({ "ok": true, "result": result })))
}

/// The dispatch table. One arm per declared tool — see
/// [`super::tool_decls`], which the card and the Python server share.
pub async fn run(
    state: &AppState,
    company: &db::companies::Company,
    session: &str,
    tool: &str,
    args: &Value,
) -> Result<Value, AppError> {
    let path = gc::log_path(state, company.id);
    match tool {
        "whoami" => Ok(json!({
            "session": session,
            "company_id": company.id,
            "company": company.slug,
            "display_name": company.display_name,
            "is_router": gc::is_router(&company.slug, session),
            "router": gc::router_name(&company.slug),
        })),

        "read_history" => {
            let since_seq = args.get("since_seq").and_then(|v| v.as_u64());
            let budget = args
                .get("budget_tokens")
                .and_then(|v| v.as_u64())
                .map(|n| n as usize);
            let (rows, more_seq) =
                tokio::task::spawn_blocking(move || gc::read_history(&path, since_seq, budget))
                    .await
                    .map_err(|e| AppError::Internal(anyhow::anyhow!("history read failed: {e}")))?;
            Ok(json!({
                "rows": rows,
                "more_seq": more_seq,
                "max_rows": gc::HISTORY_TOOL_MAX_ROWS,
                "max_tokens": gc::HISTORY_TOOL_MAX_TOKENS,
            }))
        }

        "who_tagged_me" => {
            let me = session.to_string();
            let found = tokio::task::spawn_blocking(move || gc::who_tagged_me(&path, &me))
                .await
                .map_err(|e| AppError::Internal(anyhow::anyhow!("history read failed: {e}")))?;
            Ok(match found {
                Some((tag, human)) => json!({
                    "tagged": true,
                    "by": tag.author_session,
                    "seq": tag.seq,
                    "reason": tag.body,
                    // The human request behind the routing decision, when it is
                    // still in the log. Absent is honest — never invented.
                    "request": human.as_ref().map(|h| h.body.clone()),
                    "requested_by": human.as_ref().map(|h| h.author_session.clone()),
                }),
                // Not an error: "nobody tagged you" is a real, useful answer.
                None => json!({ "tagged": false }),
            })
        }

        "post_message" => {
            let text = args.get("text").and_then(|v| v.as_str()).unwrap_or("").trim();
            if text.is_empty() {
                return Err(AppError::BadRequest("post_message needs `text`".into()));
            }
            if text.len() > TEXT_MAX_BYTES {
                return Err(AppError::BadRequest(format!(
                    "post_message text is too large (max {TEXT_MAX_BYTES} bytes)"
                )));
            }
            // The SAME path the REST route takes: `@`-stripped, author-kind
            // server-derived, appended to the log, published to the ring. Wakes
            // nobody.
            let row = gc::post_as_session(state, company, session, text, None).await?;
            Ok(json!({ "posted": true, "seq": row.seq, "text": row.body }))
        }

        "tag_bot" => tag_bot(state, company, session, args).await,

        other => Err(AppError::BadRequest(format!("unknown group-chat tool: {other}"))),
    }
}

/// `tag_bot` — the ONE tool that wakes another agent, and therefore the one
/// with the most gates.
///
/// The cap is CODE-SIDE (spec §4.6): the Router's prompt asks for at most two
/// tags, and this is what makes that true. A third tag in the same routing turn
/// is DROPPED — reported honestly to the Router, never queued behind its back,
/// because a queued fan-out is the same token bomb one tick later.
async fn tag_bot(
    state: &AppState,
    company: &db::companies::Company,
    session: &str,
    args: &Value,
) -> Result<Value, AppError> {
    if !gc::is_router(&company.slug, session) {
        // Only the company's Main Assistant routes. A bot that could tag would
        // be a bot that can wake other bots — the thing §4 exists to prevent.
        return Err(AppError::Forbidden(
            "only the company's assistant may tag bots".into(),
        ));
    }
    let target = args.get("session").and_then(|v| v.as_str()).unwrap_or("").trim();
    let request = args
        .get("distilled_request")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    if target.is_empty() || request.is_empty() {
        return Err(AppError::BadRequest(
            "tag_bot needs `session` and `distilled_request`".into(),
        ));
    }
    if request.len() > TEXT_MAX_BYTES {
        return Err(AppError::BadRequest(format!(
            "distilled_request is too large (max {TEXT_MAX_BYTES} bytes)"
        )));
    }
    if target == session {
        return Err(AppError::BadRequest("the router may not tag itself".into()));
    }
    // In-company, resolved from the row. A foreign or missing target is the
    // uniform 404 — the router must not become a cross-company roster oracle.
    let target_row = db::sessions::get(&state.pool, target)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("session '{target}'")))?;
    if target_row.company_id != Some(company.id) {
        return Err(AppError::NotFound(format!("session '{target}'")));
    }

    let gcc = gc::channel(state, company.id).await?;
    let path = gc::log_path(state, company.id);
    let turn = tokio::task::spawn_blocking(move || gc::current_turn(&path))
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!("history read failed: {e}")))?;
    let Some(turn) = turn else {
        // No human message has been posted, so there is no routing turn to be
        // in. Refusing here is what stops a bored Router from fanning out on
        // its own initiative.
        return Ok(json!({
            "tagged": false,
            "dropped": true,
            "reason": "there is no human request to route right now",
        }));
    };
    if !gc::claim_tag_slot(&gcc, turn) {
        return Ok(json!({
            "tagged": false,
            "dropped": true,
            "reason": format!(
                "the {}-tag cap for this routing turn is spent — pick the most important bots first",
                gc::MAX_TAGS_PER_TURN
            ),
            "max_tags_per_turn": gc::MAX_TAGS_PER_TURN,
        }));
    }

    // The visible routing line (the hero's DelegationPill), recorded BEFORE the
    // delivery so a failed wake still leaves the decision in the feed.
    let row = gc::record_tag(state, company.id, session, target, request).await?;
    // …and the ONE waking delegation. `actor: None` audits as `agent:<router>`,
    // which is exactly what happened.
    crate::agents::delegate::deliver_delegation(state, session, target, request, None).await?;
    Ok(json!({
        "tagged": true,
        "session": target,
        "seq": row.seq,
        "turn": turn,
        "remaining_tags": gc::MAX_TAGS_PER_TURN.saturating_sub(1),
    }))
}
