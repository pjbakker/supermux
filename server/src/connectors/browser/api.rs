//! **The human's workspace API** — bearer-gated tab CRUD and per-tab grants.
//!
//! ```text
//!   human (dashboard) ──bearer──▶ THIS ──▶ browser_tabs / browser_tab_grants
//!   bot (pane)     ──hook token──▶ tools.rs ──▶ has_tab_grant ──▶ the page
//! ```
//!
//! Two doors, deliberately far apart. This one is merged into
//! [`crate::http::protected_router`] — the **bearer** layer, not the hook-token
//! family the agent endpoint lives on — because the human owns the browser and
//! an agent must never be able to grant itself a tab.
//!
//! `/api/browser` is absent from [`crate::scope::member_may_reach`], so a scoped
//! company member gets the uniform 404 a missing route returns, and the whole
//! sub-router additionally carries the shared `require_admin` route-layer. v1's
//! workspace is the owner's; widening that is a later, deliberate decision.
//!
//! # Company containment is enforced HERE and again at call time
//!
//! [`grant_handler`] refuses a cross-company grant with a `400` (§8.3, half 1),
//! and `tools::has_tab_grant` re-checks the same predicate on every agent call
//! (half 2) — so a session moved between companies after the grant was made
//! loses access immediately. Refusing only here would be a UI-level fiction.

use axum::extract::{Path, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::db::browser_tabs as db_tabs;
use crate::db::connectors as db_connectors;
use crate::error::AppError;
use crate::extract::LenientJson;
use crate::state::AppState;

/// The human workspace sub-router. Merged into the BEARER-protected router.
pub fn router_for(state: AppState) -> Router {
    Router::new()
        .route("/api/browser/tabs", get(list_handler).post(create_handler))
        .route(
            "/api/browser/tabs/{id}",
            get(get_handler).patch(patch_handler).delete(delete_handler),
        )
        .route("/api/browser/tabs/{id}/grants", get(grants_handler))
        .route("/api/browser/tabs/{id}/grant", post(grant_handler))
        .route(
            "/api/browser/tabs/{id}/grant/{grantee}",
            axum::routing::delete(revoke_handler),
        )
        .with_state(state)
}

/// One tab, as the workspace UI reads it. `live` is the transient half — a tab
/// with no live target is *dehydrated*, not lost.
async fn tab_json(state: &AppState, row: &db_tabs::TabRow, live: &[String]) -> Value {
    let grants = db_tabs::grants_for_tab(&state.pool, &row.id)
        .await
        .unwrap_or_default();
    json!({
        "id": row.id,
        "title": row.title,
        "url": row.url,
        "pinned": row.pinned != 0,
        "company_id": row.company_id,
        "origins": db_tabs::origins_of(row),
        // Never a bare green dot: the state AND the age of its evidence (§7.3).
        "login_state": row.login_state,
        "last_probe_at": row.last_probe_at,
        "live": live.contains(&row.id),
        "grants": grants,
        "created_at": row.created_at,
        "last_used_at": row.last_used_at,
    })
}

/// `GET /api/browser/tabs` — **every** tab. The human owns the browser and sees
/// all of it; the grant-filtered view is the agent's (`browser_list_tabs`).
async fn list_handler(State(state): State<AppState>) -> Result<Json<Value>, AppError> {
    let rows = db_tabs::list(&state.pool).await?;
    let live = state.browser.live_tabs().await;
    let mut out = Vec::with_capacity(rows.len());
    for row in &rows {
        out.push(tab_json(&state, row, &live).await);
    }
    Ok(Json(json!({ "tabs": out })))
}

#[derive(Debug, Deserialize)]
pub struct CreateBody {
    pub url: String,
    /// Owning company; `None` = HQ / global.
    #[serde(default)]
    pub company_id: Option<i64>,
}

/// `POST /api/browser/tabs` — mint a tab row and seed its origin allowlist with
/// the exact host of the first URL (§8.4). It does **not** open the page: the
/// lazy-start invariant says a browser spawns when somebody actually uses one.
async fn create_handler(
    State(state): State<AppState>,
    LenientJson(body): LenientJson<CreateBody>,
) -> Result<Json<Value>, AppError> {
    let url = body.url.trim();
    let host = super::tools::host_of(url)
        .ok_or_else(|| AppError::BadRequest("a tab needs an http(s) URL".into()))?;
    let id = db_tabs::new_tab_id();
    let row = db_tabs::create(&state.pool, &id, url, body.company_id, &[host]).await?;
    let live = state.browser.live_tabs().await;
    Ok(Json(tab_json(&state, &row, &live).await))
}

async fn get_handler(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, AppError> {
    let row = load(&state, &id).await?;
    let live = state.browser.live_tabs().await;
    Ok(Json(tab_json(&state, &row, &live).await))
}

#[derive(Debug, Default, Deserialize)]
pub struct PatchBody {
    pub title: Option<String>,
    pub url: Option<String>,
    pub pinned: Option<bool>,
    /// The origin allowlist. **A human act only** — an agent can never widen it.
    pub origins: Option<Vec<String>>,
    /// `ok` | `needs_login` | `unknown`. Set by the human clearing a stale state.
    pub login_state: Option<String>,
}

async fn patch_handler(
    State(state): State<AppState>,
    Path(id): Path<String>,
    LenientJson(body): LenientJson<PatchBody>,
) -> Result<Json<Value>, AppError> {
    let _ = load(&state, &id).await?;
    if let Some(ls) = &body.login_state {
        if ![
            db_tabs::LOGIN_OK,
            db_tabs::LOGIN_NEEDED,
            db_tabs::LOGIN_UNKNOWN,
        ]
        .contains(&ls.as_str())
        {
            return Err(AppError::BadRequest(format!("unknown login_state '{ls}'")));
        }
    }
    let patch = db_tabs::TabPatch {
        title: body.title,
        url: body.url,
        pinned: body.pinned,
        origins: body.origins,
        login_state: body.login_state,
        probed_now: false,
        touch_used: false,
    };
    db_tabs::update(&state.pool, &id, &patch).await?;
    let row = load(&state, &id).await?;
    let live = state.browser.live_tabs().await;
    Ok(Json(tab_json(&state, &row, &live).await))
}

/// `DELETE /api/browser/tabs/{id}` — close the target if live, then drop the row
/// (grants cascade).
///
/// **This does not sign anything out.** The cookies live in one shared jar; the
/// honest eraser is the profile reset, and pretending a tab delete is a sign-out
/// would be the exact false green light §7.3 forbids.
async fn delete_handler(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, AppError> {
    let _ = load(&state, &id).await?;
    let _ = state.browser.dehydrate_tab(&id).await;
    let removed = db_tabs::delete(&state.pool, &id).await?;
    Ok(Json(json!({
        "deleted": removed,
        "cookies_cleared": false,
        "note": "the tab is gone; its cookies remain in the shared profile until you reset it",
    })))
}

async fn grants_handler(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, AppError> {
    let _ = load(&state, &id).await?;
    let grants = db_tabs::grants_for_tab(&state.pool, &id).await?;
    Ok(Json(json!({ "grants": grants })))
}

#[derive(Debug, Deserialize)]
pub struct GrantBody {
    /// bot slug | `@company:<id>` | `*` — the EXISTING keyspace.
    pub grantee: String,
    #[serde(default = "yes")]
    pub enabled: bool,
}

fn yes() -> bool {
    true
}

/// `POST /api/browser/tabs/{id}/grant` — lend ONE tab to ONE grantee.
///
/// **§8.3, enforced server-side.** A tab owned by company `c` may only be
/// granted to a target that resolves to company `c`; an HQ tab
/// (`company_id = NULL`) may only be granted to an HQ session or `*`. Refused
/// with 400 — not merely hidden in the UI — and re-checked on every agent call.
async fn grant_handler(
    State(state): State<AppState>,
    Path(id): Path<String>,
    LenientJson(body): LenientJson<GrantBody>,
) -> Result<Json<Value>, AppError> {
    let row = load(&state, &id).await?;
    let grantee = body.grantee.trim();
    if grantee.is_empty() {
        return Err(AppError::BadRequest("a grant needs a grantee".into()));
    }
    let target_company = db_connectors::company_of_grant_target(&state.pool, grantee).await;
    if row.company_id != target_company {
        return Err(AppError::BadRequest(format!(
            "'{grantee}' is not in this tab's company; a tab is never shared across companies"
        )));
    }
    db_tabs::grant(&state.pool, &id, grantee, body.enabled).await?;
    crate::db::audit::log(
        &state.pool,
        "user",
        "browser.tab_grant",
        &format!("tab:{id}"),
        json!({ "grantee": grantee, "enabled": body.enabled }),
    )
    .await
    .ok();
    let grants = db_tabs::grants_for_tab(&state.pool, &id).await?;
    Ok(Json(json!({ "granted": true, "grants": grants })))
}

async fn revoke_handler(
    State(state): State<AppState>,
    Path((id, grantee)): Path<(String, String)>,
) -> Result<Json<Value>, AppError> {
    let _ = load(&state, &id).await?;
    let removed = db_tabs::revoke(&state.pool, &id, &grantee).await?;
    crate::db::audit::log(
        &state.pool,
        "user",
        "browser.tab_revoke",
        &format!("tab:{id}"),
        json!({ "grantee": grantee, "existed": removed }),
    )
    .await
    .ok();
    let grants = db_tabs::grants_for_tab(&state.pool, &id).await?;
    // `revoked:false` is the store's honesty rule: nothing was there to revoke,
    // so do not draw a control that claims otherwise.
    Ok(Json(json!({ "revoked": removed, "grants": grants })))
}

/// Load a tab or 404. The human surface DOES distinguish missing from
/// forbidden — unlike the agent surface, where a 404 would be an oracle.
async fn load(state: &AppState, id: &str) -> Result<db_tabs::TabRow, AppError> {
    if !db_tabs::valid_tab_id(id) {
        return Err(AppError::NotFound(format!("no browser tab '{id}'")));
    }
    db_tabs::get(&state.pool, id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("no browser tab '{id}'")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use tower::ServiceExt;

    async fn test_state() -> (AppState, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("supermux-browser-api-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let config = crate::config::Config {
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
        let pool = crate::db::init(&config).await.expect("init pool");
        (AppState::new(pool, config), dir)
    }

    async fn send(state: &AppState, method: &str, uri: &str, body: Value) -> (StatusCode, Value) {
        let req = Request::builder()
            .method(method)
            .uri(uri)
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap();
        let resp = router_for(state.clone()).oneshot(req).await.unwrap();
        let status = resp.status();
        let bytes = axum::body::to_bytes(resp.into_body(), 1024 * 1024).await.unwrap();
        (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }

    /// Creating a tab seeds its origin allowlist with the FIRST URL's host and
    /// nothing else — an agent starts scoped to where the human actually is.
    #[tokio::test]
    async fn creating_a_tab_seeds_the_allowlist_with_exactly_the_first_host() {
        let (state, dir) = test_state().await;
        let (st, v) = send(
            &state,
            "POST",
            "/api/browser/tabs",
            json!({ "url": "https://mail.example.com/inbox?x=1" }),
        )
        .await;
        assert_eq!(st, StatusCode::OK, "{v}");
        assert_eq!(v["origins"], json!(["mail.example.com"]), "{v}");
        assert_eq!(v["login_state"], json!("unknown"), "never claim signed-in: {v}");
        assert_eq!(v["live"], json!(false), "creating a row must not spawn chrome");
        assert!(!state.browser.is_running().await);

        // A non-http URL is not a tab.
        let (st, _) = send(
            &state,
            "POST",
            "/api/browser/tabs",
            json!({ "url": "javascript:1" }),
        )
        .await;
        assert_eq!(st, StatusCode::BAD_REQUEST);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// **T8, write half.** A tab is never shared across companies, and the
    /// refusal is server-side (400), not a hidden button.
    #[tokio::test]
    async fn a_cross_company_tab_grant_is_refused_server_side() {
        let (state, dir) = test_state().await;
        let acme = crate::db::companies::create(&state.pool, "acme", "Acme", "/tmp/acme")
            .await
            .unwrap();
        let other = crate::db::companies::create(&state.pool, "other", "Other", "/tmp/other")
            .await
            .unwrap();
        crate::db::sessions::insert_minimal(&state.pool, "acme-bot", "/tmp", "claude")
            .await
            .unwrap();
        sqlx::query("UPDATE sessions SET company_id = ? WHERE name = ?")
            .bind(acme.id)
            .bind("acme-bot")
            .execute(&state.pool)
            .await
            .unwrap();

        let (_, tab) = send(
            &state,
            "POST",
            "/api/browser/tabs",
            json!({ "url": "https://portal.acme.test/", "company_id": acme.id }),
        )
        .await;
        let id = tab["id"].as_str().unwrap().to_string();

        // Same company: allowed.
        let (st, v) = send(
            &state,
            "POST",
            &format!("/api/browser/tabs/{id}/grant"),
            json!({ "grantee": "acme-bot" }),
        )
        .await;
        assert_eq!(st, StatusCode::OK, "{v}");
        // The company sentinel for the SAME company: allowed.
        let (st, _) = send(
            &state,
            "POST",
            &format!("/api/browser/tabs/{id}/grant"),
            json!({ "grantee": format!("@company:{}", acme.id) }),
        )
        .await;
        assert_eq!(st, StatusCode::OK);

        // Another company's sentinel, and the ALL-AGENTS sentinel, are refused:
        // `*` resolves to HQ/global, which is not this tab's company.
        for hostile in [
            format!("@company:{}", other.id),
            "*".to_string(),
            "stranger".to_string(),
        ] {
            let (st, v) = send(
                &state,
                "POST",
                &format!("/api/browser/tabs/{id}/grant"),
                json!({ "grantee": hostile }),
            )
            .await;
            assert_eq!(
                st,
                StatusCode::BAD_REQUEST,
                "granting a company tab to '{hostile}' must be refused: {v}"
            );
        }

        // Revoking something that was never granted says so, rather than
        // pretending it removed one.
        let (st, v) = send(
            &state,
            "DELETE",
            &format!("/api/browser/tabs/{id}/grant/nobody"),
            json!({}),
        )
        .await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(v["revoked"], json!(false), "{v}");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Deleting a tab must never claim to have signed anything out — the cookies
    /// are in one shared jar and only the profile reset clears them.
    #[tokio::test]
    async fn deleting_a_tab_does_not_claim_to_clear_its_cookies() {
        let (state, dir) = test_state().await;
        let (_, tab) = send(
            &state,
            "POST",
            "/api/browser/tabs",
            json!({ "url": "https://mail.example.com/" }),
        )
        .await;
        let id = tab["id"].as_str().unwrap().to_string();
        send(
            &state,
            "POST",
            &format!("/api/browser/tabs/{id}/grant"),
            json!({ "grantee": "*" }),
        )
        .await;

        let (st, v) = send(&state, "DELETE", &format!("/api/browser/tabs/{id}"), json!({})).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(v["deleted"], json!(true));
        assert_eq!(v["cookies_cleared"], json!(false), "{v}");
        // The grants cascaded with the row.
        assert!(db_tabs::grants_for_tab(&state.pool, &id).await.unwrap().is_empty());
        let (st, _) = send(&state, "GET", &format!("/api/browser/tabs/{id}"), json!({})).await;
        assert_eq!(st, StatusCode::NOT_FOUND);
        std::fs::remove_dir_all(&dir).ok();
    }
}
