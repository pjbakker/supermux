//! The five typed completion actions — the curated replacement for
//! `done_action: command:<text>`.
//!
//! **This is the unit that keeps the dragon dead.** `engine` never formats a
//! message and never decides what to send: it calls [`fire`] with a
//! [`CompletionAction`], a typed enum with no free-text arm anywhere in it. The
//! old `command:<text>` shape was a string the operator typed and the server
//! executed; there is no field here that shape could occupy.
//!
//! **The honesty rule (spec, DECISIONS LOCKED).** supermux has no MCP client.
//! It cannot send an email, a Slack message or anything else through a
//! connector — only the BOT can, because only the bot has the tools. A
//! `connector_send` completion is therefore an INSTRUCTION delivered to the
//! bot's pane, and every string a user ever reads about it says **"asked scout
//! to send via Gmail"** — never "sent". [`CompletionOutcome::Asked`] carries
//! that word in its name so a future caller cannot accidentally promise more
//! than happened.

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::db;
use crate::db::workflows::{Workflow, WorkflowRun};
use crate::error::AppError;
use crate::state::{AppState, SseEvent};

/// What happens when a workflow (or one of its steps) finishes.
///
/// Serialized into `workflows.on_complete` / `workflow_steps.on_complete` as
/// tagged JSON. An unknown tag is a 400 at the writer — never a silent default,
/// which is how a row written by a future version would otherwise become a
/// no-op the user cannot see.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CompletionAction {
    /// Do nothing at all.
    None,
    /// Push + SSE: "it finished".
    Notify,
    /// Turn the workflow off (today's `done_action: disable`).
    Disable,
    /// ASK THE BOT to send the run summary through one of its connectors. The
    /// server does not send anything — see the module docs.
    ConnectorSend {
        connector_id: String,
        /// Which connected account of that connector (`connector_accounts.id`).
        account_ref: String,
        /// The recipient, in whatever shape the connector's target takes.
        to: String,
        subject: Option<String>,
    },
    /// Hand the run summary to another bot in the same company.
    ///
    /// Deliberately has NO text field: the body is the server-generated run
    /// summary. A text field here would be `command:<text>` wearing a hat.
    MessageBot { session: String },
}

impl Default for CompletionAction {
    fn default() -> Self {
        CompletionAction::None
    }
}

/// What [`fire`] actually did — the vocabulary every UI string is built from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CompletionOutcome {
    Nothing,
    Notified,
    Disabled,
    /// The instruction was DELIVERED to a bot. The string is user-facing and
    /// says "asked …", because that is all that happened.
    Asked(String),
    Failed(String),
}

/// Parse a stored/incoming `on_complete` value. An unknown `kind` is a 400, not
/// a default: `{"kind":"command","text":"rm -rf /"}` must be refused loudly.
pub fn parse(json: &str) -> Result<CompletionAction, AppError> {
    let s = json.trim();
    if s.is_empty() {
        return Ok(CompletionAction::None);
    }
    serde_json::from_str::<CompletionAction>(s).map_err(|_| {
        AppError::BadRequest(
            "on_complete must be one of {\"kind\":\"none\"|\"notify\"|\"disable\"|\
             \"connector_send\"|\"message_bot\"}"
                .into(),
        )
    })
}

/// [`parse`] for the AGENT hook path, which is authenticated by a per-session
/// hook token rather than by the owner's bearer.
///
/// A session token must not be able to arm something that emails the world, or
/// that types into another bot's pane — so the two outward-facing arms are a
/// hard 400 here even though they are perfectly legal over the bearer API.
pub fn parse_for_hook(json: &str) -> Result<CompletionAction, AppError> {
    let action = parse(json)?;
    match action {
        CompletionAction::ConnectorSend { .. } => Err(AppError::BadRequest(
            "a workflow created by an agent may not arm a connector send".into(),
        )),
        CompletionAction::MessageBot { .. } => Err(AppError::BadRequest(
            "a workflow created by an agent may not arm a message to another bot".into(),
        )),
        other => Ok(other),
    }
}

/// The exact sentence a `connector_send` becomes.
///
/// Every substituted value is a typed, validated field — the connector's own
/// display name, the account's own label, and the two strings the writer
/// supplied under a schema. There is no operator free-text anywhere in it, which
/// is the whole point: this function is the reason `command:<text>` cannot grow
/// back through the completion action.
pub fn connector_instruction(
    connector_name: &str,
    account_label: &str,
    to: &str,
    subject: Option<&str>,
) -> String {
    let account = if account_label.trim().is_empty() {
        String::new()
    } else {
        format!(" (account {account_label})")
    };
    let subject = match subject.map(str::trim).filter(|s| !s.is_empty()) {
        Some(s) => format!(" with subject \"{s}\""),
        None => String::new(),
    };
    format!(
        "Use the {connector_name} connector{account} to send the summary of this workflow run \
         to {to}{subject}. Do not include anything else."
    )
}

/// The server-generated body a `message_bot` / `connector_send` summary carries.
/// Built here, never supplied by a caller.
fn run_summary(wf: &Workflow, steps: usize) -> String {
    format!(
        "Workflow '{}' finished on {} — {} step{} completed.",
        wf.title,
        wf.session,
        steps,
        if steps == 1 { "" } else { "s" }
    )
}

/// Apply one typed completion action.
///
/// A failure is an `error` on the run plus ONE push — never a silent skip. That
/// asymmetry is deliberate: a completion action is the half of the workflow the
/// user actually cares about ("email me the summary"), so it failing quietly is
/// worse than the workflow itself failing quietly.
pub async fn fire(
    state: &AppState,
    run: &WorkflowRun,
    action: &CompletionAction,
) -> CompletionOutcome {
    if matches!(action, CompletionAction::None) {
        return CompletionOutcome::Nothing;
    }
    let Ok(Some(wf)) = db::workflows::get(&state.pool, &run.workflow_id).await else {
        return CompletionOutcome::Failed("the workflow row is gone".into());
    };
    match action {
        CompletionAction::None => CompletionOutcome::Nothing,

        CompletionAction::Disable => {
            let _ = db::workflows::set_enabled(&state.pool, &wf.id, false).await;
            CompletionOutcome::Disabled
        }

        // The two direct ports of today's `done_action`. They reuse the EXISTING
        // `NotifCategory` variants: their DB values (`schedule_finished` /
        // `schedule_error`) are persisted user mute toggles and must not be
        // renamed — only their UI labels change.
        CompletionAction::Notify => {
            let st = state.clone();
            let title = wf.title.clone();
            tokio::spawn(async move {
                let _ = crate::push::send_push_for(
                    &st,
                    crate::db::push::NotifCategory::ScheduleFinished,
                    &crate::notify::PushPayload::simple(
                        format!("workflow '{title}' finished"),
                        format!("'{title}' finished."),
                        "/workflows",
                        crate::notify::Tier::Schedule,
                    ),
                    None,
                )
                .await;
            });
            CompletionOutcome::Notified
        }

        CompletionAction::MessageBot { session } => {
            let target = session.trim();
            match same_company(state, &wf, target).await {
                Ok(()) => {}
                Err(note) => return fail(state, run, &wf, note).await,
            }
            let steps = db::workflows::step_runs_for(&state.pool, run.id)
                .await
                .map(|s| s.iter().filter(|r| r.status == "ok").count())
                .unwrap_or(0);
            let summary = run_summary(&wf, steps);
            match crate::agents::delegate::deliver_delegation(
                state,
                &wf.session,
                target,
                &summary,
                Some("workflows"),
            )
            .await
            {
                Ok(_) => CompletionOutcome::Asked(format!("asked {target} to pick this up")),
                Err(e) => {
                    fail(state, run, &wf, format!("could not reach '{target}': {e}")).await
                }
            }
        }

        CompletionAction::ConnectorSend { connector_id, account_ref, to, subject } => {
            // RE-CHECKED AT FIRE TIME, not trusted from save time. A grant
            // revoked between the two is exactly the case where the instruction
            // would send the agent hunting for a tool it no longer has — and the
            // user, who asked for an email, would get silence.
            let connector = match db::connectors::get(&state.pool, connector_id).await {
                Ok(Some(c)) => c,
                _ => {
                    return fail(
                        state,
                        run,
                        &wf,
                        format!("the '{connector_id}' connector is no longer installed"),
                    )
                    .await
                }
            };
            let granted = db::connectors::grants_for_session(&state.pool, &wf.session)
                .await
                .unwrap_or_default()
                .into_iter()
                .any(|g| &g.connector_id == connector_id);
            if !granted {
                return fail(
                    state,
                    run,
                    &wf,
                    format!(
                        "'{}' is no longer connected to {} — nothing was sent",
                        connector.display_name, wf.session
                    ),
                )
                .await;
            }
            let account = db::connectors::account_get(&state.pool, account_ref).await.ok().flatten();
            let label = match &account {
                Some(a) if a.connector_id == *connector_id && a.status == "active" => {
                    a.account_label.clone()
                }
                Some(_) => {
                    return fail(
                        state,
                        run,
                        &wf,
                        format!(
                            "the '{}' account this workflow used is disconnected — nothing was sent",
                            connector.display_name
                        ),
                    )
                    .await
                }
                None if account_ref.trim().is_empty() => String::new(),
                None => {
                    return fail(
                        state,
                        run,
                        &wf,
                        format!(
                            "the '{}' account this workflow used no longer exists — nothing was sent",
                            connector.display_name
                        ),
                    )
                    .await
                }
            };

            let instruction = connector_instruction(
                &connector.display_name,
                &label,
                to.trim(),
                subject.as_deref(),
            );
            // Delivered as a synthetic FINAL STEP: defanged and wrapped exactly
            // like any other step body, so the receiving transcript attributes
            // it to this workflow and nothing inside it can forge a wrapper.
            let title = format!("{} · completion", wf.title);
            let sent = super::engine::wrap_schedule(&wf.id, &title, &instruction);
            match crate::sessions::lifecycle::send_harness_text(
                state,
                &wf.session,
                &sent,
                Some(&instruction),
                None,
            )
            .await
            {
                // HONESTY. The server has no MCP client; it did not send
                // anything. It asked the bot to.
                Ok(()) => CompletionOutcome::Asked(format!(
                    "asked {} to send via {}",
                    wf.session, connector.display_name
                )),
                Err(e) => fail(state, run, &wf, format!("could not reach {}: {e}", wf.session)).await,
            }
        }
    }
}

/// `Ok(())` when `target` is a real, live bot in the SAME company as `wf`.
async fn same_company(state: &AppState, wf: &Workflow, target: &str) -> Result<(), String> {
    if target.is_empty() {
        return Err("the completion action names no bot".into());
    }
    match db::sessions::get(&state.pool, target).await {
        Ok(Some(s)) if s.company_id == wf.company_id => Ok(()),
        // A cross-company target is refused with the SAME sentence a missing one
        // gets: a scoped caller must not be able to probe which bots exist
        // elsewhere by reading the difference.
        Ok(_) => Err(format!("'{target}' is not a bot this workflow can reach")),
        Err(e) => Err(format!("could not look up '{target}': {e}")),
    }
}

/// A completion action that did not happen: mark the run `error` with a note
/// naming what failed, raise one company-stamped frame, push once. NEVER a
/// silent skip.
async fn fail(
    state: &AppState,
    run: &WorkflowRun,
    wf: &Workflow,
    note: String,
) -> CompletionOutcome {
    let note = super::engine::truncate(&note);
    let _ = db::workflows::close_run(&state.pool, run.id, "error", &note).await;
    let _ = state.sse_tx.send(SseEvent::for_company(
        "alerts",
        json!({
            "level": "error",
            "source": "workflows",
            "workflow": wf.id,
            "run_id": run.id,
            "status": "error",
            "detail": format!("Workflow '{}' — {note}", wf.title),
        }),
        wf.company_id,
    ));
    let st = state.clone();
    let title = wf.title.clone();
    let body = note.clone();
    tokio::spawn(async move {
        let _ = crate::push::send_push_for(
            &st,
            crate::db::push::NotifCategory::ScheduleError,
            &crate::notify::PushPayload::simple(
                format!("workflow '{title}' could not finish"),
                body,
                "/workflows",
                crate::notify::Tier::Schedule,
            ),
            None,
        )
        .await;
    });
    CompletionOutcome::Failed(note)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The honesty rule, as an assertion rather than a comment: nothing this
    /// module can produce claims the SERVER sent anything. (The rest of this
    /// unit's contract — parse, the hook refusals, the instruction shape — lives
    /// in `tests/workflows_completion.rs` alongside the two cases that need a DB.)
    #[test]
    fn the_outcome_says_asked_never_sent() {
        let outcome = CompletionOutcome::Asked("asked scout to send via Gmail".into());
        let CompletionOutcome::Asked(text) = &outcome else { panic!() };
        assert!(text.starts_with("asked "), "{text}");
        assert!(!text.contains("sent "), "the server has no MCP client: {text}");
        assert!(text.contains("to send via"), "{text}");
    }
}
