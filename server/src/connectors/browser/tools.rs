//! **The lock-gated tool endpoint** — where a granted agent's browser tool call
//! actually touches the page.
//!
//! One route, `POST /api/hook/browser/tool`, called ONLY by the embedded MCP
//! server ([`super::mcp`]) that a granted bot launches. It sits on the same
//! no-bearer, per-session-hook-token router family as the status hook, the board
//! hook and the scheduler hook — and for the same reason: the caller runs inside
//! a pane and must never hold the dashboard bearer.
//!
//! ```text
//!   bot ──stdio──▶ mcp_server.py ──HTTP(hook token)──▶ THIS ──▶ BrowserService
//!                                                        │          │
//!                                                        └ DriveLock ┘   ← the gate
//! ```
//!
//! # Four gates, in order
//!
//! 1. **Identity.** The `X-Supermux-Hook-Token` header is constant-time compared
//!    against `session_runtime.hook_token` for the session named in the body. Bot
//!    A's token authenticates only bot A, so bot A can never drive bot B's
//!    context — even though every bot runs the identical server script.
//! 2. **Connector grant.** The session must hold an enabled `shared-browser`
//!    grant (its own, its company's, or the `*` all-agents one). An ungranted bot
//!    that somehow learned the URL still gets a 403, and — decisively — never
//!    spawns chrome. For a workspace tab this is **necessary and NOT sufficient**.
//! 3. **Per-tab grant** (shared-browser v1, R2 — the security crux). When the
//!    call names a `tab`, the session must ALSO hold a per-tab grant on that tab,
//!    resolved through the same three tiers and the same hard company
//!    containment ([`crate::db::browser_tabs::tabs_for_session`]). Then the tab
//!    must be usable: a `needs_login` tab refuses every agent verb (409), and an
//!    agent `navigate` off the tab's origin allowlist is refused (403).
//! 4. **The wheel.** Every acting tool calls
//!    [`super::lock::DriveLock::ensure_agent`] BEFORE touching the page and
//!    answers `409 Conflict` while the human drives.
//!
//! Gate 3 sits **before dispatch**, which is what makes it total: it covers
//! `read` and `screenshot` for free, and it cannot be forgotten by a future
//! sixth verb.
//!
//! # Why READS are gated too
//!
//! [`super::context::AgentContext::evaluate`] is deliberately ungated (phase 2's
//! takeover UI must read page state while the human drives). This endpoint is the
//! AGENT's door, and it gates reads as well: the whole point of a takeover is a
//! human typing a password, a 2FA code or a card number into that page. An agent
//! that could `browser_read`/`browser_screenshot` mid-takeover would read exactly
//! those keystrokes back out. While the human holds the wheel, the agent sees
//! nothing.
//!
//! **On a workspace tab the argument is stronger, not weaker.** The lock-free
//! reasoning "observing the page is never a control conflict" is true for a
//! scratch context and false for a logged-in one, where **reading IS the
//! exfiltration**. Reads stay lock-gated here AND become grant-gated: without a
//! per-tab grant, `browser_read` and `browser_screenshot` on a tab are 403, in
//! the same breath as `navigate` and `click`. A confused deputy — any bot holding
//! the connector grant reaching every authenticated surface in the company — is
//! exactly what gate 3 exists to prevent.

use axum::extract::State;
use axum::http::HeaderMap;
use axum::routing::post;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;

use crate::db::browser_tabs as db_tabs;
use crate::db::connectors as db_connectors;
use crate::error::AppError;
use crate::extract::LenientJson;
use crate::sessions::takeover_ask::TakeoverAsk;
use crate::state::AppState;

use super::context::AgentContext;
use super::error::BrowserError;
use super::lock::{Actor, HandOff};
use super::mcp::BROWSER_ID;
use super::tab::{Tab, TabMeta};
use std::sync::Arc;

/// Default / ceiling for a `request_human_takeover` park. The hand-back wakes the
/// call the instant it happens, so the ceiling only bites when nobody comes.
const DEFAULT_PARK: u64 = 120;
const MAX_PARK: u64 = 600;

/// Default / ceiling on returned page text. A page is not a context window.
const DEFAULT_MAX_CHARS: usize = 8_000;
const MAX_MAX_CHARS: usize = 40_000;

/// The agent→browser tool sub-router. Merged at the TOP level of
/// [`crate::http::router`] (NO bearer layer — auth is the per-session hook token,
/// validated in the handler).
pub fn router_for(state: AppState) -> Router {
    Router::new()
        .route("/api/hook/browser/tool", post(tool_handler))
        .with_state(state)
}

#[derive(Debug, Deserialize)]
pub struct ToolBody {
    /// The supermux session name (`$SUPERMUX_SESSION`); scopes the token check
    /// AND names the browser context to drive.
    pub session: String,
    /// `navigate` | `click` | `read` | `screenshot` | `request_human_takeover`
    /// | `list_tabs`.
    pub tool: String,
    /// The tool's arguments (shape per tool).
    #[serde(default)]
    pub args: Value,
}

/// `POST /api/hook/browser/tool` — run ONE browser tool for a granted session.
async fn tool_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    LenientJson(body): LenientJson<ToolBody>,
) -> Result<Json<Value>, AppError> {
    // 1. Identity: the session's own hook token, constant-time (401 on any miss,
    //    including an unknown session — no existence oracle).
    crate::hooks::verify_hook_token(&state, &body.session, &headers).await?;
    if !crate::sessions::valid_name(&body.session) {
        return Err(AppError::BadRequest("invalid session name".into()));
    }
    // 2. Grant: no `shared-browser` grant, no browser — and no chrome spawned.
    if !has_browser_grant(&state, &body.session).await? {
        return Err(AppError::Forbidden(format!(
            "session '{}' has no '{BROWSER_ID}' grant",
            body.session
        )));
    }

    let args = &body.args;

    // `list_tabs` is the ONE verb reachable on the connector grant alone. It
    // returns only the tabs this session may use — an empty list for a session
    // with no tab grants, which is the honest answer and not an existence
    // oracle. It never touches a page, so it never spawns chrome either.
    if body.tool == "list_tabs" {
        let tabs = list_tabs(&state, &body.session).await?;
        return Ok(Json(json!({ "ok": true, "result": tabs })));
    }

    // 3. **The tab gate** (R2). `tab` absent ⇒ the scratch context, byte-for-byte
    //    today's behaviour. `tab` present ⇒ per-tab grant, containment, and
    //    usability, ALL before dispatch — so `read` and `screenshot` are covered
    //    without either verb knowing about it.
    let target = match str_arg(args, "tab") {
        Some(tab_id) => resolve_tab(&state, &body.session, tab_id).await?,
        None => {
            // Lazily spawns the ONE chrome on first use by any granted session.
            Target::Scratch(
                state
                    .browser
                    .context_for(&body.session)
                    .await
                    .map_err(browser_err)?,
            )
        }
    };

    // 4. Audit BEFORE the CDP call, so a call that crashes the page is still on
    //    the record (§8.7). Only tab traffic is audited: a scratch context holds
    //    nothing but its own agent's work.
    if let Some(tab_id) = target.tab_id() {
        audit_tab_call(&state, &body.session, &body.tool, tab_id, args).await;
    }

    let result = match body.tool.as_str() {
        "navigate" => navigate(&target, args).await,
        "click" => click(target.page(), args).await,
        "read" => read(target.page(), args).await,
        "screenshot" => screenshot(target.page(), args).await,
        "request_human_takeover" => takeover(&state, &body.session, &target, args).await,
        other => {
            return Err(AppError::BadRequest(format!("unknown browser tool '{other}'")));
        }
    };
    let result = result.map_err(browser_err)?;
    Ok(Json(json!({ "ok": true, "result": result })))
}

/// What a tool call is pointed at: today's per-session scratch context, or a
/// persistent workspace tab the caller has been granted.
///
/// The page primitives are identical for both — the difference lives entirely in
/// the gate that produced this value, plus the per-tab origin allowlist that only
/// a [`Target::Workspace`] carries.
enum Target {
    Scratch(Arc<AgentContext>),
    Workspace(Arc<Tab>),
}

impl Target {
    /// The page every verb drives.
    fn page(&self) -> &AgentContext {
        match self {
            Self::Scratch(ctx) => ctx,
            Self::Workspace(tab) => tab.page(),
        }
    }

    /// The durable tab id, for the audit trail and the lock subject.
    fn tab_id(&self) -> Option<&str> {
        match self {
            Self::Scratch(_) => None,
            Self::Workspace(tab) => Some(tab.id()),
        }
    }
}

/// **Resolve a `tab` argument into a driveable target, or refuse.**
///
/// Every refusal below is rendered `403` by [`browser_err`] except the
/// login-expiry one, so an ungranted agent cannot use this endpoint to learn
/// which tab ids exist. Order matters: shape, then grant, then existence.
async fn resolve_tab(state: &AppState, session: &str, tab_id: &str) -> Result<Target, AppError> {
    // Shape gate first — the id becomes a map key, a log field and a lock
    // subject, and must be checked before any of that (the `valid_name` shape).
    if !db_tabs::valid_tab_id(tab_id) {
        return Err(browser_err(BrowserError::NotGrantedForTab {
            session: session.to_string(),
            tab: tab_id.to_string(),
        }));
    }
    // THE gate. `has_tab_grant` is fail-closed on every path, and is built on the
    // same predicate `list_tabs` uses, so discovery and enforcement cannot drift.
    if !has_tab_grant(state, session, tab_id).await {
        return Err(browser_err(BrowserError::NotGrantedForTab {
            session: session.to_string(),
            tab: tab_id.to_string(),
        }));
    }
    let pool = &state.pool;
    let row = db_tabs::get(pool, tab_id)
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!(e)))?
        .ok_or_else(|| browser_err(BrowserError::NoSuchTab(tab_id.to_string())))?;

    // **Honest expiry** (§7.3). An agent reading a login wall and reporting its
    // contents as data is worse than an agent that errors, so a lapsed tab
    // refuses every verb — including the read verbs — rather than serving one.
    if row.login_state == db_tabs::LOGIN_NEEDED {
        // Raise the in-chat ask through the affordance the human already knows,
        // so the blockage is visible where takeovers already are.
        let reason = format!("browser tab '{tab_id}' needs you to sign in again");
        if state.set_browser_takeover(session, TakeoverAsk::new(session, &reason)) {
            crate::hooks::broadcast_activity_delta(state, session);
        }
        return Err(browser_err(BrowserError::TabNeedsLogin {
            tab: tab_id.to_string(),
        }));
    }

    let meta = TabMeta {
        title: row.title.clone(),
        url: row.url.clone(),
        pinned: row.pinned != 0,
        origins: db_tabs::origins_of(&row),
        login_state: row.login_state.clone(),
    };
    let tab = state
        .browser
        .ensure_tab(tab_id, meta)
        .await
        .map_err(browser_err)?;
    // Freshness for the workspace UI's "last used" ordering.
    let _ = db_tabs::update(
        pool,
        tab_id,
        &db_tabs::TabPatch {
            touch_used: true,
            ..Default::default()
        },
    )
    .await;
    Ok(Target::Workspace(tab))
}

/// Does this session hold an ENABLED `shared-browser` grant (its own or `*`)?
async fn has_browser_grant(state: &AppState, session: &str) -> Result<bool, AppError> {
    let grants = db_connectors::grants_for_session(&state.pool, session).await?;
    Ok(grants
        .iter()
        .any(|g| g.connector_id == BROWSER_ID && g.enabled != 0))
}

/// **Does this session hold a grant on THIS tab?** (v1 §5.2 / §8.2 — R2.)
///
/// Two conditions, both required:
///
/// 1. the connector-level `shared-browser` grant — **necessary, and no longer
///    sufficient**: holding it lets a bot open a scratch browser, not read the
///    human's authenticated tabs;
/// 2. a per-tab grant resolved through the same three tiers as
///    `grants_for_session` (own slug > `@company:<id>` > `*`, `enabled = 1`),
///    **with the hard company containment of §8.3 re-checked at call time** — so
///    a session moved between companies after the grant was made loses access
///    immediately, rather than merely being hidden in the UI.
///
/// Both live inside [`crate::db::browser_tabs::tabs_for_session`], which is also
/// what `list_tabs` returns: one predicate, so what an agent can *discover* and
/// what an agent can *touch* can never disagree.
///
/// **Fail-closed on every path.** A DB error, a malformed row, a missing session
/// — all read as *not granted*. There is no error branch that reaches a page.
pub async fn has_tab_grant(state: &AppState, session: &str, tab_id: &str) -> bool {
    match has_browser_grant(state, session).await {
        Ok(true) => {}
        _ => return false,
    }
    db_tabs::session_may_use(&state.pool, session, tab_id)
        .await
        .unwrap_or(false)
}

/// `browser_list_tabs` — the tabs this session may use, and nothing else.
///
/// Grant-FILTERED, not grant-gated: it needs only the connector grant and answers
/// an empty list for a session with no tab grants. That is the honest answer and
/// not an oracle — an ungranted session learns nothing about which tabs exist.
/// It is the tool an agent calls first, and it doubles as discovery.
///
/// A `needs_login` tab is still LISTED, with its state, so the agent can report
/// the blockage accurately instead of guessing why its verbs are refused.
async fn list_tabs(state: &AppState, session: &str) -> Result<Value, AppError> {
    if !has_browser_grant(state, session).await? {
        return Err(AppError::Forbidden(format!(
            "session '{session}' has no '{BROWSER_ID}' grant"
        )));
    }
    let rows = db_tabs::tabs_for_session(&state.pool, session)
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!(e)))?;
    let live = state.browser.live_tabs().await;
    let tabs: Vec<Value> = rows
        .iter()
        .map(|t| {
            json!({
                "tab": t.id,
                "title": t.title,
                "url": t.url,
                "pinned": t.pinned != 0,
                // Never a bare green dot: the state AND the age of its evidence.
                "login_state": t.login_state,
                "last_verified": t.last_probe_at,
                "live": live.contains(&t.id),
                "allowed_hosts": db_tabs::origins_of(t),
            })
        })
        .collect();
    Ok(json!({ "tabs": tabs, "count": tabs.len() }))
}

/// Record an agent verb against a tab **before** the CDP call (§8.7).
///
/// Best-effort: an audit write that fails must not deny the call it is recording
/// (that would turn the ledger into an availability dependency), but it is logged
/// loudly. `detail` carries metadata only — a URL and a clipped selector, never
/// page contents.
async fn audit_tab_call(state: &AppState, session: &str, tool: &str, tab_id: &str, args: &Value) {
    let action = match tool {
        "navigate" => "browser.navigate",
        "click" => "browser.click",
        "read" => "browser.read",
        "screenshot" => "browser.screenshot",
        "request_human_takeover" => "browser.takeover",
        other => other,
    };
    let (selector, _) = clip(str_arg(args, "selector").unwrap_or_default(), 200);
    let (url, _) = clip(str_arg(args, "url").unwrap_or_default(), 500);
    let detail = json!({
        "tool": tool,
        "url": url,
        "selector": selector,
    });
    if let Err(e) = crate::db::audit::log(
        &state.pool,
        &format!("agent:{session}"),
        action,
        &format!("tab:{tab_id}"),
        detail,
    )
    .await
    {
        tracing::warn!(session, tab = tab_id, error = %e, "browser: tab audit write failed");
    }
}

/// Map a browser error onto HTTP. The ONE that matters is the lock refusal:
/// `409 Conflict` is what the MCP server turns into the agent-readable
/// "the human is driving" result.
fn browser_err(e: BrowserError) -> AppError {
    match e {
        BrowserError::HumanDriving { .. } | BrowserError::TakeoverWait { .. } => {
            AppError::Conflict(e.to_string())
        }
        BrowserError::TooManyContexts { .. } | BrowserError::TooManyTabs { .. } => {
            AppError::TooManyRequests(e.to_string())
        }
        BrowserError::NoSuchContext(_) => AppError::NotFound(e.to_string()),
        // **No existence oracle.** `NoSuchTab` and `NotGrantedForTab` are both
        // 403 to an agent caller, deliberately: a 404 here would tell an
        // ungranted bot which tab ids are real, which is the same leak the
        // constant-time hook-token check exists to avoid. The distinction
        // survives in the logs and on the human surface, where it is safe.
        BrowserError::NoSuchTab(_) | BrowserError::NotGrantedForTab { .. } => {
            AppError::Forbidden(e.to_string())
        }
        BrowserError::OriginNotAllowed { .. } => AppError::Forbidden(e.to_string()),
        // Honest expiry: a distinct, actionable 409 the agent can report.
        BrowserError::TabNeedsLogin { .. } => AppError::Conflict(e.to_string()),
        BrowserError::ProfileLocked { .. } => AppError::Conflict(e.to_string()),
        BrowserError::ChromeMissing(_)
        | BrowserError::Launch(_)
        | BrowserError::Transport(_)
        | BrowserError::Protocol { .. }
        | BrowserError::Timeout(_)
        | BrowserError::Evaluate(_)
        | BrowserError::ShuttingDown => AppError::Internal(anyhow::anyhow!(e.to_string())),
    }
}

fn str_arg<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

/// The host of an absolute URL, lowercased, or `None` for anything this gate
/// cannot reason about.
///
/// Deliberately strict and hand-rolled (this module's stated pride is that it
/// adds no crates): only `http`/`https` are recognised, and everything else —
/// `javascript:`, `data:`, `file:`, a relative path, a userinfo trick — yields
/// `None`, which the caller turns into a refusal. Fail closed.
fn host_of(url: &str) -> Option<String> {
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))?;
    let authority = rest
        .split(['/', '?', '#'])
        .next()
        .unwrap_or_default();
    // `user@host` — the host is what the browser connects to, never the userinfo.
    let hostport = authority.rsplit('@').next().unwrap_or_default();
    // Strip a port; an IPv6 literal keeps its brackets and never matches a rule.
    let host = match hostport.strip_prefix('[') {
        Some(v6) => format!("[{}]", v6.split(']').next().unwrap_or_default()),
        None => hostport.split(':').next().unwrap_or_default().to_string(),
    };
    let host = host.trim().to_ascii_lowercase();
    (!host.is_empty()).then_some(host)
}

/// A JS string literal for `s` — `serde_json` escaping is a superset of JS's, so
/// a selector can never break out of the expression it is spliced into.
fn js_string(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into())
}

/// Trim `s` to `max` CHARS (never bytes), flagging the cut.
fn clip(s: &str, max: usize) -> (String, bool) {
    if s.chars().count() <= max {
        return (s.to_string(), false);
    }
    (s.chars().take(max).collect(), true)
}

/// The result a parked `request_human_takeover` reports once the wheel comes
/// back — and the whole of FINDING 2.
///
/// The lock is released on ANY takeover-socket exit, because a human who is gone
/// must not hold the wheel. But a tab close, a dead mobile link and a ping
/// timeout are not "the human finished": telling the agent they did is a lie it
/// then acts on, mid sign-in, on a half-filled form. Only
/// [`HandOff::Explicit`] — the hand-back button — earns the success sentence.
fn handback_result(handoff: Option<HandOff>, url: &str, reason: &str) -> Value {
    match handoff {
        Some(h) if h.is_explicit() => json!({
            "handed_back": true,
            "human_disconnected": false,
            "message": "The human finished and handed the wheel back. Continue from this page.",
            "url": url,
            "reason": reason,
        }),
        // `Disconnected`, `Abandoned`, or (defensively) no recorded hand-off:
        // the wheel is ours again, but nobody confirmed anything.
        _ => json!({
            "handed_back": false,
            "human_disconnected": true,
            "message": "The human disconnected before confirming — the page may be incomplete. \
                        Verify its state before acting on it, or ask for takeover again.",
            "url": url,
            "reason": reason,
        }),
    }
}

// ── the tools ────────────────────────────────────────────────────────────────

/// **Navigation, origin-scoped on a workspace tab** (§8.4).
///
/// A tab authenticated to `bank.example` and handed to an agent is a
/// cookie-bearing HTTP client; `navigate` + `read` against an attacker-chosen
/// host is a plausible exfil chain. So an AGENT may only navigate a tab to a host
/// on that tab's allowlist. The human is never blocked (they navigate by driving,
/// not through this endpoint), and in-page navigation by the site itself —
/// redirects, SPA routing, every SSO hop — is not blocked, because it cannot be
/// and blocking it would break the logins this feature exists to keep.
///
/// A scratch context has no allowlist and is unchanged.
async fn navigate(target: &Target, args: &Value) -> Result<Value, BrowserError> {
    let ctx = target.page();
    ctx.lock().ensure_agent()?;
    let url = str_arg(args, "url").ok_or_else(|| BrowserError::Protocol {
        method: "navigate".into(),
        message: "missing `url`".into(),
    })?;
    if let Target::Workspace(tab) = target {
        let host = host_of(url).ok_or_else(|| BrowserError::OriginNotAllowed {
            tab: tab.id().to_string(),
            host: String::new(),
        })?;
        let origins = tab.origins().await;
        if !db_tabs::host_allowed(&origins, &host) {
            return Err(BrowserError::OriginNotAllowed {
                tab: tab.id().to_string(),
                host,
            });
        }
    }
    ctx.navigate(Actor::Agent, url).await?;
    let landed = ctx.evaluate("({url: location.href, title: document.title})").await?;
    Ok(json!({
        "navigated": true,
        "url": landed.get("url").cloned().unwrap_or(Value::Null),
        "title": landed.get("title").cloned().unwrap_or(Value::Null),
    }))
}

async fn click(ctx: &AgentContext, args: &Value) -> Result<Value, BrowserError> {
    ctx.lock().ensure_agent()?;
    let (x, y, via) = if let Some(sel) = str_arg(args, "selector") {
        // Resolve the selector to the element's centre IN THE PAGE, scrolling it
        // into view first — a click at coordinates that are off-screen lands on
        // whatever happens to be there instead.
        let expr = format!(
            "(() => {{ const el = document.querySelector({sel}); if (!el) return null; \
             el.scrollIntoView({{block:'center', inline:'center'}}); \
             const r = el.getBoundingClientRect(); \
             return {{x: r.left + r.width/2, y: r.top + r.height/2, w: r.width, h: r.height}}; }})()",
            sel = js_string(sel)
        );
        let found = ctx.evaluate(&expr).await?;
        if found.is_null() {
            return Err(BrowserError::Evaluate(format!(
                "no element matches selector {sel}"
            )));
        }
        let x = found.get("x").and_then(Value::as_f64).unwrap_or(0.0);
        let y = found.get("y").and_then(Value::as_f64).unwrap_or(0.0);
        (x, y, json!({ "selector": sel }))
    } else {
        let x = args.get("x").and_then(Value::as_f64);
        let y = args.get("y").and_then(Value::as_f64);
        match (x, y) {
            (Some(x), Some(y)) => (x, y, json!({ "coords": [x, y] })),
            _ => {
                return Err(BrowserError::Protocol {
                    method: "click".into(),
                    message: "needs a `selector` or both `x` and `y`".into(),
                })
            }
        }
    };
    ctx.click(Actor::Agent, x, y).await?;
    let url = ctx.current_url().await.unwrap_or_default();
    Ok(json!({ "clicked": true, "at": [x, y], "target": via, "url": url }))
}

async fn read(ctx: &AgentContext, args: &Value) -> Result<Value, BrowserError> {
    // Gated on purpose — see the module docs: while the human drives, the agent
    // reads nothing off the page they are typing into.
    ctx.lock().ensure_agent()?;
    let selector = str_arg(args, "selector");
    let want_html = args.get("html").and_then(Value::as_bool).unwrap_or(false);
    let max = args
        .get("max_chars")
        .and_then(Value::as_u64)
        .map(|n| n as usize)
        .unwrap_or(DEFAULT_MAX_CHARS)
        .clamp(1, MAX_MAX_CHARS);

    let target = match selector {
        Some(sel) => format!("document.querySelector({})", js_string(sel)),
        None => "document.body".to_string(),
    };
    let field = if want_html { "outerHTML" } else { "innerText" };
    let expr = format!(
        "(() => {{ const el = {target}; return {{url: location.href, title: document.title, \
         found: !!el, text: el ? (el.{field} || '') : ''}}; }})()"
    );
    let out = ctx.evaluate(&expr).await?;
    if !out.get("found").and_then(Value::as_bool).unwrap_or(false) {
        if let Some(sel) = selector {
            return Err(BrowserError::Evaluate(format!(
                "no element matches selector {sel}"
            )));
        }
    }
    let raw = out.get("text").and_then(Value::as_str).unwrap_or_default();
    let (text, truncated) = clip(raw, max);
    Ok(json!({
        "url": out.get("url").cloned().unwrap_or(Value::Null),
        "title": out.get("title").cloned().unwrap_or(Value::Null),
        "format": if want_html { "html" } else { "text" },
        "text": text,
        "truncated": truncated,
    }))
}

async fn screenshot(ctx: &AgentContext, _args: &Value) -> Result<Value, BrowserError> {
    // Gated for the same reason as `read`: a screenshot mid-takeover is a photo
    // of the human's login form.
    ctx.lock().ensure_agent()?;
    let data = ctx.screenshot().await?;
    let url = ctx.current_url().await.unwrap_or_default();
    Ok(json!({
        "data": data,
        "mime_type": "image/jpeg",
        "bytes": data.len(),
        "url": url,
    }))
}

/// **The hand-off.** Flip the wheel to the human, raise the in-chat card, and
/// PARK this call (which is the agent's tool call) until they hand back.
///
/// Both orders work, which is the point:
///   * card first — the human takes over from the chat card, the agent's next
///     acting tool is refused, then this call returns as soon as they detach;
///   * tool first — this call flips the lock and parks; the human opens the panel
///     (an idempotent re-takeover), finishes, detaches, and the release wakes us.
///
/// If NOBODY comes before the budget expires, the wheel goes back to the agent
/// rather than leaving the context stuck under a human who never arrived.
async fn takeover(
    state: &AppState,
    session: &str,
    target: &Target,
    args: &Value,
) -> Result<Value, BrowserError> {
    let ctx = target.page();
    let reason = str_arg(args, "reason").unwrap_or("the agent needs you to take the wheel");
    let park = args
        .get("timeout_seconds")
        .and_then(Value::as_u64)
        .unwrap_or(DEFAULT_PARK)
        .clamp(5, MAX_PARK);

    // The chat surface: a card that opens the takeover panel. For a workspace tab
    // the ask NAMES the tab, so the human knows which page they are being called
    // to — the card is the same affordance either way.
    let ask_reason = match target.tab_id() {
        Some(tab_id) => format!("{reason} (tab {tab_id})"),
        None => reason.to_string(),
    };
    if state.set_browser_takeover(session, TakeoverAsk::new(session, &ask_reason)) {
        crate::hooks::broadcast_activity_delta(state, session);
    }

    let previous = ctx.lock().request_human_takeover();
    tracing::info!(
        session = %session,
        tab = ?target.tab_id(),
        %previous,
        reason,
        "browser: agent asked for a human takeover"
    );

    let waited = ctx.lock().await_agent(Duration::from_secs(park)).await;

    // The ask is over either way — the card must not outlive it.
    if state.clear_browser_takeover(session) {
        crate::hooks::broadcast_activity_delta(state, session);
    }

    match waited {
        Ok(()) => {
            let url = ctx.current_url().await.unwrap_or_default();
            // WHY the wheel came back decides what we may claim — see
            // `handback_result`.
            Ok(handback_result(ctx.lock().last_handoff(), &url, reason))
        }
        Err(BrowserError::TakeoverWait { .. }) => {
            // "Is a human actually looking?" is asked of THIS subject — a viewer
            // on the tab route holds the tab's slot, not the session's.
            let attached = match target.tab_id() {
                Some(tab_id) => super::takeover::is_tab_attached(tab_id),
                None => super::takeover::is_attached(session),
            };
            if !attached {
                // Nobody ever picked it up — don't leave the context wedged.
                ctx.lock().release_to_agent(HandOff::Abandoned);
            }
            Ok(json!({
                "handed_back": false,
                "human_attached": attached,
                "waited_seconds": park,
                "message": if attached {
                    "The human is still driving. Call request_human_takeover again to keep waiting."
                } else {
                    "Nobody took the wheel in time; control is back with you. Ask again, or tell \
                     the human what you need in chat."
                },
                "reason": reason,
            }))
        }
        Err(e) => Err(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::lock::DriveLock;
    use crate::config::Config;
    use crate::db;
    use axum::body::Body;
    use axum::http::{HeaderValue, Request, StatusCode};
    use tower::ServiceExt;

    async fn test_state() -> (AppState, std::path::PathBuf) {
        let dir =
            std::env::temp_dir().join(format!("supermux-browser-tools-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let config = Config {
            data_dir: dir.clone(),
            bind: "127.0.0.1:0".parse().unwrap(),
            extra_binds: vec![],
            tls: Default::default(),
            auth_token: "test-token".to_string(),
            provider_defaults: Default::default(),
            ws: Default::default(),
            remote_callback_url: None,
            push_sub: None,
            github_token: None,
            statusline_tap: false,
            isolation_mode: crate::isolation::IsolationMode::BestEffort,
            human_auth: Default::default(),
            extra_origins: Vec::new(),
        };
        let pool = db::init(&config).await.expect("init pool");
        (AppState::new(pool, config), dir)
    }

    /// A session with a hook token; `granted` also lands an enabled
    /// `shared-browser` grant (through the same DB path the store's grant
    /// endpoint uses).
    async fn seed_session(state: &AppState, session: &str, token: &str, granted: bool) {
        db::sessions::insert_minimal(&state.pool, session, "/tmp", "claude")
            .await
            .unwrap();
        db::sessions::ensure_runtime(&state.pool, session, token)
            .await
            .unwrap();
        if granted {
            let m = super::super::mcp::manifest("/tmp/server.py");
            let cols = m.to_columns();
            db::connectors::upsert(
                &state.pool,
                &m.id,
                &m.kind,
                &m.display_name,
                &m.icon,
                &m.description,
                &cols.tools_json,
                &cols.credentials_json,
                &cols.emit_json,
                "{}",
            )
            .await
            .unwrap();
            db::connectors::grant(&state.pool, session, BROWSER_ID, None, true)
                .await
                .unwrap();
        }
    }

    fn tool_request(session: &str, token: &str, tool: &str, args: Value) -> Request<Body> {
        let body = json!({ "session": session, "tool": tool, "args": args });
        let mut req = Request::builder()
            .method("POST")
            .uri("/api/hook/browser/tool")
            .body(Body::from(body.to_string()))
            .unwrap();
        req.headers_mut().insert(
            "X-Supermux-Hook-Token",
            HeaderValue::from_str(token).unwrap(),
        );
        req
    }

    /// GATE 1 + GATE 2, and the thing that matters most about both: neither can
    /// spawn a browser. A wrong token is a 401, an ungranted session is a 403,
    /// and in both cases chrome never starts.
    #[tokio::test]
    async fn auth_and_grant_gates_refuse_before_any_chrome_can_spawn() {
        let (state, dir) = test_state().await;
        seed_session(&state, "alice", "tok-alice", false).await;
        seed_session(&state, "bob", "tok-bob", true).await;

        // Wrong token for a real session → 401.
        let resp = router_for(state.clone())
            .oneshot(tool_request("alice", "not-the-token", "read", json!({})))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);

        // Bob's token cannot drive Alice's context (the per-session scope rule).
        let resp = router_for(state.clone())
            .oneshot(tool_request("alice", "tok-bob", "read", json!({})))
            .await
            .unwrap();
        assert_eq!(
            resp.status(),
            StatusCode::UNAUTHORIZED,
            "bot B's token must never authenticate bot A's browser"
        );

        // Alice's own token, but no grant → 403.
        let resp = router_for(state.clone())
            .oneshot(tool_request("alice", "tok-alice", "read", json!({})))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);

        assert!(
            !state.browser.is_running().await,
            "a refused call must never have spawned chrome"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// An unknown tool name on a granted session is a 400 — the dispatch table is
    /// closed, so a compromised MCP server cannot reach anything else.
    #[tokio::test]
    async fn the_tool_dispatch_table_is_closed() {
        let (state, dir) = test_state().await;
        seed_session(&state, "carol", "tok-carol", true).await;
        let resp = router_for(state.clone())
            .oneshot(tool_request("carol", "tok-carol", "Bash", json!({})))
            .await
            .unwrap();
        // The name is rejected before the browser is ever asked for a context.
        assert!(
            resp.status() == StatusCode::BAD_REQUEST || resp.status() == StatusCode::INTERNAL_SERVER_ERROR,
            "unknown tool must not be dispatched: {}",
            resp.status()
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_selector_can_never_break_out_of_the_expression() {
        let hostile = "a\"); alert(1); //";
        let js = js_string(hostile);
        assert!(js.starts_with('"') && js.ends_with('"'));
        assert!(js.contains("\\\""), "the inner quote is escaped: {js}");
    }

    #[test]
    fn clip_counts_chars_not_bytes() {
        let (s, cut) = clip("héllo wörld", 5);
        assert_eq!(s.chars().count(), 5);
        assert!(cut);
        let (s, cut) = clip("short", 40);
        assert_eq!(s, "short");
        assert!(!cut);
    }

    #[test]
    fn the_lock_refusal_maps_to_409_and_a_quota_to_429() {
        let e = browser_err(BrowserError::HumanDriving { subject: "alice".into() });
        assert!(matches!(e, AppError::Conflict(_)), "human-driving is a 409");
        let e = browser_err(BrowserError::TooManyContexts { max: 4 });
        assert!(matches!(e, AppError::TooManyRequests(_)));
        let e = browser_err(BrowserError::NoSuchContext("bob".into()));
        assert!(matches!(e, AppError::NotFound(_)));
    }

    // ── FINDING 2: the hand-off must not lie ────────────────────────────────

    #[test]
    fn only_an_explicit_hand_back_is_reported_as_finished() {
        let ok = handback_result(Some(HandOff::Explicit), "https://bank/ok", "sign in");
        assert_eq!(ok["handed_back"], json!(true));
        assert_eq!(ok["human_disconnected"], json!(false));
        assert!(
            ok["message"].as_str().unwrap().contains("Continue from this page"),
            "{ok}"
        );

        // Every other way the wheel comes back is a human who is simply GONE.
        for gone in [
            Some(HandOff::Disconnected),
            Some(HandOff::Abandoned),
            None,
        ] {
            let v = handback_result(gone, "https://bank/half-filled", "sign in");
            assert_eq!(v["handed_back"], json!(false), "{gone:?} → {v}");
            assert_eq!(v["human_disconnected"], json!(true), "{gone:?} → {v}");
            let msg = v["message"].as_str().unwrap();
            assert!(msg.contains("disconnected"), "{gone:?} → {msg}");
            assert!(
                msg.contains("may be incomplete"),
                "the agent must be warned the page is unverified: {msg}"
            );
            assert!(
                !msg.contains("finished"),
                "never claim the human finished when nobody said so: {msg}"
            );
            // The URL is still reported — the agent may need it to check state.
            assert_eq!(v["url"], json!("https://bank/half-filled"));
        }
    }

    /// The exact sequence the takeover socket produces for a dropped phone:
    /// takeover → (no hand-back frame) → teardown release. The parked caller
    /// reads the provenance off the lock, so this is the end-to-end statement of
    /// FINDING 2 without a browser.
    #[test]
    fn a_dropped_socket_and_a_hand_back_reach_the_parked_caller_differently() {
        let lock = DriveLock::new("driver");

        lock.request_human_takeover();
        lock.release_to_agent(HandOff::Explicit); // the "Hand back" button
        let v = handback_result(lock.last_handoff(), "u", "r");
        assert_eq!(v["handed_back"], json!(true));

        lock.request_human_takeover();
        lock.release_to_agent(HandOff::Disconnected); // the tab/network died
        let v = handback_result(lock.last_handoff(), "u", "r");
        assert_eq!(v["handed_back"], json!(false));
        assert_eq!(v["human_disconnected"], json!(true));
    }

    // ── real-chrome end-to-end (phase 3's whole claim) ──────────────────────

    /// A page whose content is unambiguous to read back, and which can prove a
    /// click landed.
    fn tool_page() -> String {
        let html = "<title>Phase3</title><body><h1 id=h>hello-from-phase-3</h1><button id=b onclick=\"document.getElementById('h').textContent='clicked-ok'\">go</button></body>";
        format!("data:text/html,{}", html.replace(' ', "%20"))
    }

    async fn call(state: &AppState, session: &str, token: &str, tool: &str, args: Value) -> (StatusCode, Value) {
        let resp = router_for(state.clone())
            .oneshot(tool_request(session, token, tool, args))
            .await
            .unwrap();
        let status = resp.status();
        let bytes = axum::body::to_bytes(resp.into_body(), 4 * 1024 * 1024)
            .await
            .unwrap();
        let v: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        (status, v)
    }

    /// REAL-CHROME phase-3 end-to-end. Ignored by default (spawns the pinned
    /// `chrome-headless-shell`); run with
    /// `cargo test -- --ignored real_chrome_tool_loop`.
    ///
    /// Drives the ACTUAL endpoint the MCP server calls — hook-token auth, grant
    /// check, `BrowserService`, drive lock — and proves the whole phase-3 loop:
    ///
    /// 1. `navigate` → `read` returns the page's real text; `screenshot` returns
    ///    real JPEG bytes; `click` mutates the live DOM.
    /// 2. While `HumanDriving`, EVERY agent tool is refused with `409` — acting
    ///    and reading alike (the human's login page is not the agent's to read).
    /// 3. `request_human_takeover` raises the in-chat ask in session state AND
    ///    parks the agent; a simulated hand-back wakes it and clears the ask.
    /// 4. Teardown leaves no orphan chrome.
    #[tokio::test]
    #[ignore = "spawns a real chrome-headless-shell; run with --ignored on a box that has the pinned binary"]
    async fn real_chrome_tool_loop_reads_clicks_screenshots_and_parks_for_a_human() {
        fn pid_alive(pid: u32) -> bool {
            std::path::Path::new(&format!("/proc/{pid}")).exists()
        }

        let (state, dir) = test_state().await;
        seed_session(&state, "driver", "tok-driver", true).await;

        // ── 1. the agent's own loop ─────────────────────────────────────────
        let (st, v) = call(&state, "driver", "tok-driver", "navigate", json!({ "url": tool_page() })).await;
        assert_eq!(st, StatusCode::OK, "navigate: {v}");
        assert_eq!(v["result"]["navigated"], json!(true));
        assert_eq!(v["result"]["title"], json!("Phase3"), "read the live title back");

        let (st, v) = call(&state, "driver", "tok-driver", "read", json!({})).await;
        assert_eq!(st, StatusCode::OK, "read: {v}");
        let text = v["result"]["text"].as_str().unwrap_or_default();
        assert!(text.contains("hello-from-phase-3"), "read the real page text: {text:?}");

        let (st, v) = call(&state, "driver", "tok-driver", "screenshot", json!({})).await;
        assert_eq!(st, StatusCode::OK, "screenshot: {v}");
        let b64 = v["result"]["data"].as_str().unwrap_or_default();
        assert!(b64.len() > 1000, "screenshot returned {} base64 chars", b64.len());
        assert_eq!(v["result"]["mime_type"], json!("image/jpeg"));

        let (st, v) = call(&state, "driver", "tok-driver", "click", json!({ "selector": "#b" })).await;
        assert_eq!(st, StatusCode::OK, "click: {v}");
        let (_, v) = call(&state, "driver", "tok-driver", "read", json!({ "selector": "#h" })).await;
        assert_eq!(
            v["result"]["text"].as_str().unwrap_or_default().trim(),
            "clicked-ok",
            "the click mutated the real DOM"
        );

        let pid = state.browser.chrome_pid().await.expect("a chrome pid");
        let ctx = state.browser.context("driver").await.expect("context");

        // ── 2. the lock refuses the agent while the human drives ────────────
        ctx.lock().request_human_takeover();
        for (tool, args) in [
            ("navigate", json!({ "url": "about:blank" })),
            ("click", json!({ "selector": "#b" })),
            ("read", json!({})),
            ("screenshot", json!({})),
        ] {
            let (st, v) = call(&state, "driver", "tok-driver", tool, args).await;
            assert_eq!(st, StatusCode::CONFLICT, "{tool} must be refused while HumanDriving: {v}");
        }
        // …and the page is untouched: the refused navigate never happened.
        ctx.lock().release_to_agent(HandOff::Explicit);
        let (_, v) = call(&state, "driver", "tok-driver", "read", json!({ "selector": "#h" })).await;
        assert_eq!(
            v["result"]["text"].as_str().unwrap_or_default().trim(),
            "clicked-ok",
            "nothing the agent asked for while refused reached the page"
        );

        // ── 3. the hand-off: ask → park → hand back → resume ────────────────
        let parked = {
            let state = state.clone();
            tokio::spawn(async move {
                call(
                    &state,
                    "driver",
                    "tok-driver",
                    "request_human_takeover",
                    json!({ "reason": "sign in and approve the 2FA push", "timeout_seconds": 30 }),
                )
                .await
            })
        };
        // The ask reaches session state (this IS the in-chat card's source).
        let mut ask = None;
        for _ in 0..100 {
            if let Some(a) = state.session_activity("driver").and_then(|a| a.browser_takeover) {
                ask = Some(a);
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let ask = ask.expect("the takeover ask reached session state");
        assert_eq!(ask.session, "driver");
        assert!(ask.reason.contains("2FA"), "the agent's own sentence: {}", ask.reason);
        assert_eq!(ctx.lock().mode(), super::super::lock::DriveMode::HumanDriving);

        // The human finishes and presses **Hand back** — the explicit control
        // frame (what `ClientMsg::HandBack` does in the takeover socket).
        tokio::time::sleep(Duration::from_millis(100)).await;
        ctx.lock().release_to_agent(HandOff::Explicit);

        let (st, v) = parked.await.unwrap();
        assert_eq!(st, StatusCode::OK, "the parked call returns on hand-back: {v}");
        assert_eq!(v["result"]["handed_back"], json!(true));
        assert_eq!(v["result"]["human_disconnected"], json!(false));
        assert!(
            v["result"]["message"].as_str().unwrap_or_default().contains("handed the wheel back"),
            "an EXPLICIT hand-back is the one case we may report as finished: {v}"
        );
        assert!(
            state.session_activity("driver").and_then(|a| a.browser_takeover).is_none(),
            "the card is cleared once the wheel comes back"
        );

        // ── 3b. FINDING 2: the human's phone drops mid sign-in ──────────────
        // Same code path, same released lock — but the socket went away without
        // a hand-back frame, so the agent must NOT be told the login finished.
        let parked = {
            let state = state.clone();
            tokio::spawn(async move {
                call(
                    &state,
                    "driver",
                    "tok-driver",
                    "request_human_takeover",
                    json!({ "reason": "sign in", "timeout_seconds": 30 }),
                )
                .await
            })
        };
        for _ in 0..100 {
            if ctx.lock().mode() == super::super::lock::DriveMode::HumanDriving {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
        // What `takeover_socket`'s teardown does on ANY transport exit.
        ctx.lock().release_to_agent(HandOff::Disconnected);

        let (st, v) = parked.await.unwrap();
        assert_eq!(st, StatusCode::OK, "the parked call still returns: {v}");
        assert_eq!(
            v["result"]["handed_back"],
            json!(false),
            "a dropped connection is NOT a hand-back: {v}"
        );
        assert_eq!(v["result"]["human_disconnected"], json!(true));
        assert!(
            v["result"]["message"].as_str().unwrap_or_default().contains("disconnected"),
            "the agent must be told the page may be incomplete: {v}"
        );

        // The agent really is driving again.
        let (st, _) = call(&state, "driver", "tok-driver", "read", json!({})).await;
        assert_eq!(st, StatusCode::OK, "the agent resumes after the hand-back");

        // ── 4. no orphan chrome ─────────────────────────────────────────────
        state.browser.shutdown().await;
        for _ in 0..50 {
            if !pid_alive(pid) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert!(!pid_alive(pid), "chrome {pid} survived shutdown — orphan");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// REAL-CHROME (FINDING 1). **The teardown wiring, through the production
    /// paths** — the bug was not that `close_context` was wrong, it was that
    /// NOTHING called it, so a context outlived its agent forever.
    ///
    /// Each leg opens a real page through the real tool endpoint and then fires
    /// one real teardown path:
    ///
    /// * the `SessionEnd` hook, POSTed to the actual hook route;
    /// * `lifecycle::stop`;
    /// * `AppState::forget_session` (the choke point delete AND archive use);
    /// * `AppState::rename_session` (the still-alive-but-renamed case).
    #[tokio::test]
    #[ignore = "spawns a real chrome-headless-shell; run with --ignored on a box that has the pinned binary"]
    async fn real_chrome_every_teardown_path_disposes_the_agents_context() {
        let (state, dir) = test_state().await;

        /// Open a page for `session` through the real endpoint.
        async fn open_page(state: &AppState, session: &str, token: &str) {
            let (st, v) = call(state, session, token, "navigate", json!({ "url": tool_page() })).await;
            assert_eq!(st, StatusCode::OK, "navigate for {session}: {v}");
            assert_eq!(
                state.browser.context_count().await,
                1,
                "{session} should hold exactly one context"
            );
        }

        /// The teardown is fire-and-forget, so give it a bounded moment.
        async fn assert_disposed(state: &AppState, path: &str) {
            for _ in 0..200 {
                if state.browser.context_count().await == 0 {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
            assert_eq!(
                state.browser.context_count().await,
                0,
                "{path} must dispose the session's browser context"
            );
            assert!(
                state.browser.idle_armed().await,
                "{path} must leave the idle reaper armed (it only fires on an EMPTY map)"
            );
        }

        // ── the SessionEnd hook, through the real route ─────────────────────
        seed_session(&state, "ender", "tok-ender", true).await;
        open_page(&state, "ender", "tok-ender").await;
        let hook = Request::builder()
            .method("POST")
            .uri("/api/_internal/hook")
            .header("X-Supermux-Hook-Token", "tok-ender")
            .body(Body::from(
                json!({ "session": "ender", "event": "session_end", "payload": {} }).to_string(),
            ))
            .unwrap();
        let resp = crate::hooks::router_for(state.clone()).oneshot(hook).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK, "the hook must be accepted");
        assert_disposed(&state, "SessionEnd hook").await;

        // ── lifecycle::stop ─────────────────────────────────────────────────
        seed_session(&state, "stopper", "tok-stopper", true).await;
        open_page(&state, "stopper", "tok-stopper").await;
        let _ = crate::sessions::lifecycle::stop(&state, "stopper").await;
        assert_disposed(&state, "lifecycle::stop").await;

        // ── forget_session (delete + archive) ────────────────────────────────
        seed_session(&state, "deleted", "tok-deleted", true).await;
        open_page(&state, "deleted", "tok-deleted").await;
        state.forget_session("deleted");
        assert_disposed(&state, "forget_session (delete/archive)").await;

        // ── rename_session (the still-alive-but-renamed case) ───────────────
        seed_session(&state, "oldname", "tok-oldname", true).await;
        open_page(&state, "oldname", "tok-oldname").await;
        state.rename_session("oldname", "newname");
        assert_disposed(&state, "rename_session").await;

        state.browser.shutdown().await;
        std::fs::remove_dir_all(&dir).ok();
    }
}
