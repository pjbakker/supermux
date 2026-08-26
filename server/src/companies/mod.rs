//! Companies CRUD HTTP surface (migration `0032_companies.sql`).
//!
//! **Router-registry pattern.** [`router_for`] returns this module's sub-router;
//! [`crate::http::protected_router`] merges it under the bearer auth layer with
//! one `.merge(...)` line. Mounting under `/api/` is enough — `auth_middleware`
//! has no path carve-outs.
//!
//! **Scope.** Five routes wrap the `db::companies` surface:
//!   * `GET  /api/companies`        — list live companies (`?archived=1` includes archived).
//!   * `POST /api/companies`        — create ({slug, display_name, root_dir}); mkdir root_dir.
//!   * `GET  /api/companies/{id}`   — fetch one (404 on miss).
//!   * `PATCH /api/companies/{id}`  — set display_name and/or archived.
//!   * `DELETE /api/companies/{id}` — hard-delete; refuses (409) if active sessions remain.
//!
//! **Slug soft-reject.** A company slug lives in its own namespace and can never
//! collide with a `sessions.name` at the PK level, but for folder/URL legibility
//! the create handler additionally rejects (409) a slug equal to an existing
//! session slug.
//!
//! **Delete guard.** `DELETE` refuses while the company has any active
//! (non-archived) session; the `trg_company_delete_sessions` trigger then NULLs
//! any lingering (archived) sessions, but the `root_dir` folder on disk is NOT
//! removed — the response returns the retained path.

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::{Json, Router};
use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::db::companies::{self, Company};
use crate::error::AppError;
use crate::state::AppState;

/// The per-company GROUP CHAT channel (sidecar log + chat ring). Its two REST
/// routes are registered below; the live socket lives in [`crate::ws`] with the
/// other WebSockets, for the same reason the session chat socket does (a
/// browser `WebSocket` cannot satisfy the bearer layer).
pub mod groupchat;

/// Build the companies sub-router (no auth layer — applied by `http::router`).
pub fn router_for(state: AppState) -> Router {
    use axum::routing::get;
    Router::new()
        .route("/api/companies", get(list_handler).post(create_handler))
        .route(
            "/api/companies/{id}",
            get(get_handler).patch(patch_handler).delete(delete_handler),
        )
        // ── the company group chat (headless channel) ──
        // History pages the sidecar LOG (the durable truth), not the ring, so a
        // restart cannot lose the feed. `post` is its OWN path, physically
        // separate from `deliver_delegation`: it appends + publishes and wakes
        // nobody.
        .route(
            "/api/companies/{id}/groupchat/history",
            get(groupchat::history_handler),
        )
        .route(
            "/api/companies/{id}/groupchat/post",
            axum::routing::post(groupchat::post_handler),
        )
        .with_state(state)
}

// ── HTTP envelope ────────────────────────────────────────────────────────────

#[derive(Serialize)]
struct Envelope<T> {
    ok: bool,
    data: T,
}

fn ok<T: Serialize>(data: T) -> Json<Envelope<T>> {
    Json(Envelope { ok: true, data })
}

// ── validation ───────────────────────────────────────────────────────────────

/// `slug` rule: letters, digits, `_`, `.`, `-`, length 1..=64. No shell meta —
/// it becomes a folder-path segment and a URL segment.
static SLUG_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[a-zA-Z0-9._-]{1,64}$").unwrap());

fn valid_slug(slug: &str) -> bool {
    SLUG_RE.is_match(slug)
}

/// The authoritative company-jail namespace root: `<projects_root>/companies`.
///
/// `<projects_root>` is the FIRST `SUPERMUX_PROJECT_DIRS` entry — the SAME notion
/// the files-repos handler (`files::projects_repos`) and the start-a-team
/// pre-fill (`static_assets`) already read, so there is one source of truth —
/// tilde-expanded. When the var is unset/empty we fall back to `$HOME` (and `/`
/// only if even that is unknown). Every company's `root_dir` is derived under
/// here (`<companies_root>/<slug>`) so a client can never supply an arbitrary
/// jail root.
fn companies_root() -> std::path::PathBuf {
    let projects_root = std::env::var("SUPERMUX_PROJECT_DIRS")
        .ok()
        .and_then(|s| s.split(':').next().map(str::to_string))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .map(|s| std::path::PathBuf::from(shellexpand::tilde(&s).into_owned()))
        .or_else(dirs::home_dir)
        .unwrap_or_else(|| std::path::PathBuf::from("/"));
    projects_root.join("companies")
}

// ── query / body types ───────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct ListParams {
    /// `?archived=1` (or `true`/`yes`) includes archived companies. Absent =
    /// live only.
    #[serde(default)]
    archived: Option<String>,
}

fn is_truthy(v: &str) -> bool {
    matches!(v.trim(), "1" | "true" | "TRUE" | "yes" | "on")
}

#[derive(Debug, Deserialize)]
pub struct CreateCompanyInput {
    pub slug: String,
    pub display_name: String,
    /// **Ignored — never trusted.** The company jail root is derived
    /// AUTHORITATIVELY server-side as `<projects_root>/companies/<slug>` (see
    /// [`companies_root`] + [`create_handler`]), so a client can never point a
    /// company's jail at an arbitrary path. Kept optional purely so an older
    /// client may still send it as a hint; the value is discarded.
    #[serde(default)]
    pub root_dir: Option<String>,
    /// Turn on the COMPANY GROUP CHAT for this company (spec §6).
    ///
    /// **Absent = OFF**, deliberately. The web checkbox defaults to ON and sends
    /// `true`; an older client, a script or a `curl` that says nothing gets the
    /// behaviour it has always had — provisioning a live Claude session and a
    /// connector grant is not something an unchanged caller should suddenly
    /// start doing because the server was upgraded.
    #[serde(default)]
    pub enable_group_chat: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct PatchCompanyInput {
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub archived: Option<bool>,
}

/// DELETE response body: the row is gone, but the `root_dir` folder is retained
/// on disk — hand the owner the path so they can remove it deliberately.
#[derive(Debug, Serialize)]
struct DeleteResult {
    deleted: bool,
    /// The retained on-disk `root_dir` (NOT removed by this delete).
    retained_root_dir: String,
}

// ── handlers ─────────────────────────────────────────────────────────────────

async fn list_handler(
    State(state): State<AppState>,
    ctx: crate::scope::OptCtx,
    Query(params): Query<ListParams>,
) -> Result<Json<Envelope<Vec<Company>>>, AppError> {
    let include_archived = params.archived.as_deref().map(is_truthy).unwrap_or(false);
    let rows = companies::list(&state.pool, include_archived).await?;
    // P3d: a scoped MEMBER sees ONLY their own company (so the switcher shows just
    // theirs) — never the whole roster. Owner/admin (Scope::All) see everything.
    let rows = match crate::scope::Scope::of(ctx.0.as_ref()) {
        crate::scope::Scope::All => rows,
        crate::scope::Scope::Company(hc) => {
            rows.into_iter().filter(|c| c.id == hc).collect()
        }
    };
    Ok(ok(rows))
}

async fn get_handler(
    State(state): State<AppState>,
    ctx: crate::scope::OptCtx,
    Path(id): Path<i64>,
) -> Result<Json<Envelope<Company>>, AppError> {
    // P3d: a member may fetch ONLY their own company; any other id is a uniform
    // 404 (byte-identical to a nonexistent id — no cross-company enumeration).
    if let crate::scope::Scope::Company(hc) = crate::scope::Scope::of(ctx.0.as_ref()) {
        if id != hc {
            return Err(AppError::NotFound(format!("company id={id}")));
        }
    }
    let row = companies::get(&state.pool, id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("company id={id}")))?;
    Ok(ok(row))
}

async fn create_handler(
    State(state): State<AppState>,
    ctx: crate::scope::OptCtx,
    Json(input): Json<CreateCompanyInput>,
) -> Result<impl IntoResponse, AppError> {
    // P3d: creating a company is owner/admin-only company-management. A member is
    // refused with the uniform hide-existence 404.
    crate::scope::require_admin(ctx.0.as_ref(), "/api/companies")?;
    let slug = input.slug.trim();
    let display_name = input.display_name.trim();

    if slug.is_empty() {
        return Err(AppError::BadRequest("slug is required".into()));
    }
    if !valid_slug(slug) {
        return Err(AppError::BadRequest(
            "invalid slug (allowed: letters, digits, '_', '.', '-', 1..=64 chars)".into(),
        ));
    }
    if display_name.is_empty() {
        return Err(AppError::BadRequest("display_name is required".into()));
    }

    // AUTHORITATIVE derivation — the jail root is NEVER taken from the client
    // (`input.root_dir` is ignored). The slug is already unique + charset-validated,
    // so `<companies_root>/<slug>` is a safe, namespaced folder that a client can
    // never redirect. This closes the "client sets an arbitrary jail root"
    // weakness and namespaces companies under `<projects>/companies/`.
    let root_path = companies_root().join(slug);
    let root_dir = root_path.display().to_string();
    // Safety still applies to the FINAL derived path — a company folder is a fixed
    // absolute jail root, not a cwd-relative one.
    if !root_path.is_absolute() {
        return Err(AppError::BadRequest(
            "derived root_dir is not absolute (misconfigured SUPERMUX_PROJECT_DIRS)".into(),
        ));
    }
    if root_dir.bytes().any(|b| b == 0 || b == b'\n' || b == b'\r') {
        return Err(AppError::BadRequest("invalid root_dir (NUL / newline)".into()));
    }
    let root_dir = root_dir.as_str();

    // Slug soft-reject: never collide with an existing SESSION slug (folder /
    // URL legibility) — same 409 shape as a duplicate company slug.
    if crate::db::sessions::exists(&state.pool, slug).await? {
        return Err(AppError::Conflict(format!(
            "slug '{slug}' collides with an existing session slug — choose another"
        )));
    }
    // Duplicate company slug → clean 409 (instead of leaking the SQLite UNIQUE).
    if companies::get_by_slug(&state.pool, slug).await?.is_some() {
        return Err(AppError::Conflict(format!("company '{slug}' already exists")));
    }

    // mkdir the company root up front so the first agent lands in an existing
    // tree.
    std::fs::create_dir_all(root_dir)
        .map_err(|e| AppError::Internal(anyhow::anyhow!("mkdir {root_dir}: {e}")))?;

    let created = match companies::create(&state.pool, slug, display_name, root_dir).await {
        Ok(c) => c,
        Err(sqlx::Error::Database(db_err)) if is_unique_violation(db_err.as_ref()) => {
            // Race lost the get_by_slug check — still a 409.
            return Err(AppError::Conflict(format!("company '{slug}' already exists")));
        }
        Err(e) => return Err(AppError::from(e)),
    };

    // ── group chat (spec §3.1) ───────────────────────────────────────────────
    // BEST-EFFORT, and after the row exists: a company must not fail to be
    // created because a bot could not boot. Every step logs what it could not
    // do rather than half-failing the create.
    if input.enable_group_chat.unwrap_or(false) {
        provision_group_chat(&state, &created).await;
    }
    Ok((StatusCode::CREATED, ok(created)))
}

/// Stand up a company's group chat: the welcome row (which creates the sidecar
/// log), the company-wide connector grant, and the Main Assistant bot.
///
/// Ordered cheapest-and-most-durable first. The log and the grant are local,
/// fast and idempotent; the bot is a real Claude process, so it is created last
/// and BOOTED in the background — a company create must not block for the
/// seconds a pty takes, and a boot failure must leave a normal, startable
/// session row rather than wedging the create.
async fn provision_group_chat(state: &AppState, company: &Company) {
    // 1. The welcome row. Creates `<data_dir>/companies/<id>/groupchat.log.jsonl`
    //    so the hero opens on a real first message instead of empty air.
    if let Err(e) = groupchat::append(
        state,
        company.id,
        groupchat::NewRow::plain(
            "server".to_string(),
            groupchat::AUTHOR_WORKFLOW,
            welcome_row(&company.display_name),
        ),
    )
    .await
    {
        tracing::warn!(company = company.id, error = %e, "group chat: welcome row failed");
    }

    // 2. The connector grant, on the `@company:<id>` tier — so every bot in this
    //    company inherits it (`grants_for_session` tier 2) with no per-bot grant
    //    and no migration.
    let company_key = format!(
        "{}{}",
        crate::db::connectors::COMPANY_PREFIX,
        company.id
    );
    if let Err(e) = crate::db::connectors::grant(
        &state.pool,
        &company_key,
        crate::connectors::groupchat::GROUPCHAT_ID,
        None,
        true,
    )
    .await
    {
        tracing::warn!(company = company.id, error = %e, "group chat: connector grant failed");
    }

    // 3. The Main Assistant — a NORMAL company bot on the subscription default
    //    model (no API-token side channel, no special cheap model), created the
    //    same way `teams::start` creates a lead.
    let router = groupchat::router_name(&company.slug);
    let created = crate::sessions::create(
        state,
        crate::sessions::CreateInput {
            name: router.clone(),
            display_name: Some(format!("{} assistant", company.display_name)),
            // None: `sessions::create` FORCES a company session's dir under the
            // company root (`<root_dir>/<name>`), which is exactly where it goes.
            dir: None,
            desc: Some(format!("Group-chat router for {}", company.display_name)),
            provider: Some("claude".into()),
            creator: Some("group-chat".into()),
            flags: None,
            bypass_permissions: None,
            tags: Some(vec!["group-chat".into(), "router".into()]),
            branch: None,
            mcp: None,
            worktree: None,
            host_id: None,
            runtime: None,
            model: None,
            company_id: Some(company.id),
        },
    )
    .await;
    if let Err(e) = created {
        tracing::warn!(company = company.id, error = %e, "group chat: could not create the assistant bot");
        return;
    }

    // 4. Boot it with the routing brief as its first turn (the `teams::start`
    //    pattern). Spawned: booting a pty takes seconds, and the owner is
    //    waiting on an HTTP 201 for a row that already exists.
    let st = state.clone();
    let prompt = router_brief(&company.slug, &company.display_name);
    tokio::spawn(async move {
        if let Err(e) = crate::sessions::lifecycle::start(&st, &router, Some(&prompt)).await {
            tracing::warn!(session = %router, error = %e, "group chat: assistant boot failed");
        }
    });
}

/// The welcome row a new channel opens with (usecase #9). Server-authored, so
/// it is `author_kind = workflow` — nobody claimed to have said it.
fn welcome_row(display_name: &str) -> String {
    format!(
        "This is {display_name}'s group chat. Drop a request here and the assistant routes it to          the right bot; bots post milestones and finished workflows. Everyone in the company          reads the same feed."
    )
}

/// The Router's first turn (spec §3.2): what it is for, and — decisively — what
/// it must not do.
///
/// The two hard rules are stated as facts about the SERVER, not as requests:
/// the tag cap and the `@`-strip are enforced in code, so a Router that tries to
/// exceed them fails rather than succeeds quietly. Telling it so up front is the
/// difference between a cooperative router and one that spends turns discovering
/// its own limits.
fn router_brief(slug: &str, display_name: &str) -> String {
    let max = crate::companies::groupchat::MAX_TAGS_PER_TURN;
    format!(
        "You are the router for {display_name}'s group chat (company `{slug}`).

         You wake ONLY on messages from a human. When you do, decide which bot — or which two          bots — should act, and hand each ONE distilled request with          `mcp__group_chat__tag_bot(session, distilled_request)`. Never do the work yourself.

         Rules the SERVER enforces, so do not try to route around them:
         - At most {max} tags per human message. The {max}+1th is dropped, not queued.
         - `mcp__group_chat__post_message` strips every '@': a post cannot summon anyone. Use it          only to answer a human directly when no bot is needed.
         - Bots never read each other's posts, so tagging is the only thing that reaches one.

         Start each turn with `mcp__group_chat__who_tagged_me` or          `mcp__group_chat__read_history` only if you need context you do not already have — a          read costs the human's tokens. `mcp__group_chat__whoami` tells you who you are.

         If nobody should act, post one short reply saying so, and tag no one."
    )
}

async fn patch_handler(
    State(state): State<AppState>,
    ctx: crate::scope::OptCtx,
    Path(id): Path<i64>,
    Json(input): Json<PatchCompanyInput>,
) -> Result<Json<Envelope<Company>>, AppError> {
    // P3d: renaming/archiving a company is owner/admin-only.
    crate::scope::require_admin(ctx.0.as_ref(), &format!("/api/companies/{id}"))?;
    // 404 if the row is gone.
    companies::get(&state.pool, id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("company id={id}")))?;

    if let Some(dn) = input.display_name.as_deref() {
        let dn = dn.trim();
        if dn.is_empty() {
            return Err(AppError::BadRequest("display_name cannot be empty".into()));
        }
        companies::set_display_name(&state.pool, id, dn).await?;
    }
    // Unarchive needs no fresh collision check: the slug is immutable and its
    // UNIQUE row survived archival, so it cannot have been re-created.
    if let Some(archived) = input.archived {
        companies::set_archived(&state.pool, id, archived).await?;
    }

    let row = companies::get(&state.pool, id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("company id={id}")))?;
    Ok(ok(row))
}

async fn delete_handler(
    State(state): State<AppState>,
    ctx: crate::scope::OptCtx,
    Path(id): Path<i64>,
) -> Result<impl IntoResponse, AppError> {
    // P3d: deleting a company is owner/admin-only company-management.
    crate::scope::require_admin(ctx.0.as_ref(), &format!("/api/companies/{id}"))?;
    let company = companies::get(&state.pool, id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("company id={id}")))?;

    // Guard: refuse while any active (non-archived) session still belongs to
    // this company (parallels the archived-only purge guard on sessions).
    let active = companies::active_session_count(&state.pool, id).await?;
    if active > 0 {
        return Err(AppError::Conflict(format!(
            "company '{}' still has {active} active session(s) — archive or delete them first",
            company.slug
        )));
    }

    // The trigger NULLs any lingering (archived) sessions. The `root_dir` folder
    // on disk is deliberately NOT removed (data safety) — hand back the retained
    // path.
    companies::delete(&state.pool, id).await?;
    Ok(ok(DeleteResult {
        deleted: true,
        retained_root_dir: company.root_dir,
    }))
}

// ── helpers ──────────────────────────────────────────────────────────────────

/// SQLite surfaces a `UNIQUE` violation through the generic `DatabaseError`
/// path; the cheapest match is on the message.
fn is_unique_violation(err: &dyn sqlx::error::DatabaseError) -> bool {
    let msg = err.message();
    msg.contains("UNIQUE constraint failed") || msg.contains("UNIQUE")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;

    async fn test_state() -> (AppState, std::path::PathBuf) {
        let dir =
            std::env::temp_dir().join(format!("supermux-companies-http-{}", uuid::Uuid::new_v4()));
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
        let pool = crate::db::init(&config).await.expect("init pool");
        (AppState::new(pool, config), dir)
    }

    fn root_under(dir: &std::path::Path, name: &str) -> String {
        dir.join(name).display().to_string()
    }

    /// Serializes the tests that mutate the process-global `SUPERMUX_PROJECT_DIRS`
    /// (the create handler now DERIVES `root_dir` from it), so parallel test
    /// threads don't clobber each other's env.
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[tokio::test]
    async fn post_company_rejects_slug_colliding_with_session_slug() {
        let (state, dir) = test_state().await;
        // Seed a session slug "acme".
        crate::db::sessions::insert_minimal(&state.pool, "acme", "/tmp/acme", "shell")
            .await
            .unwrap();
        let r = create_handler(
            State(state.clone()),
            crate::scope::OptCtx(None),
            Json(CreateCompanyInput {
                slug: "acme".into(),
                display_name: "Acme".into(),
                root_dir: None,
                enable_group_chat: None,
            }),
        )
        .await;
        match r {
            Err(AppError::Conflict(_)) => {}
            other => panic!("expected Conflict, got {:?}", other.err()),
        }
        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    /// The SERVER derives `root_dir = <projects_root>/companies/<slug>` and
    /// IGNORES any client-supplied value — closing the "client picks an arbitrary
    /// jail root" weakness AND namespacing companies under `companies/`.
    #[tokio::test]
    async fn create_derives_root_dir_server_side_and_ignores_client_value() {
        let _env = ENV_LOCK.lock().unwrap();
        let (state, dir) = test_state().await;
        // Point the projects root at this test's isolated temp dir.
        std::env::set_var("SUPERMUX_PROJECT_DIRS", &dir);

        let created = create_handler(
            State(state.clone()),
            crate::scope::OptCtx(None),
            Json(CreateCompanyInput {
                slug: "acme".into(),
                display_name: "Acme".into(),
                // A BOGUS client-supplied jail root — must NOT be honored.
                root_dir: Some("/home/supermux".into()),
                enable_group_chat: None,
            }),
        )
        .await
        .expect("create should succeed")
        .into_response();
        assert_eq!(created.status(), StatusCode::CREATED);

        // The stored + returned root_dir is the server-derived path, NOT the
        // client's bogus one.
        let want = dir.join("companies").join("acme").display().to_string();
        let listed = list_handler(
            State(state.clone()),
            crate::scope::OptCtx(None),
            Query(ListParams { archived: None }),
        )
        .await
        .unwrap();
        assert_eq!(listed.data.len(), 1);
        assert_eq!(listed.data[0].root_dir, want, "root_dir is server-derived");
        assert_ne!(listed.data[0].root_dir, "/home/supermux", "client value ignored");
        // The folder (and its `companies/` parent) were created under the namespace.
        assert!(dir.join("companies").join("acme").is_dir(), "namespaced folder mkdir'd");

        // The P0 dir-forcing (sessions::create) reads companies.root_dir from the
        // DB and joins `<name>` — so a company session lands under
        // `<projects>/companies/<slug>/<agent>`. Mirror that join here to pin the
        // shape the derived root produces (the forcing code itself is covered by
        // the `company_session_dir_is_forced_*` sessions tests).
        let agent_dir = std::path::Path::new(&listed.data[0].root_dir).join("bot-a");
        assert_eq!(
            agent_dir.display().to_string(),
            dir.join("companies").join("acme").join("bot-a").display().to_string(),
            "agent dir forced under <projects>/companies/<slug>/<agent>"
        );

        state.pool.close().await;
        std::env::remove_var("SUPERMUX_PROJECT_DIRS");
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Enabling group chat at create time stands the channel up: a welcome row
    /// in the sidecar log, the `@company:<id>` connector grant every bot in the
    /// company inherits, and the Main Assistant session row. (Booting the
    /// assistant is spawned and best-effort — a company must exist even if a pty
    /// cannot start.)
    #[tokio::test]
    async fn enabling_group_chat_provisions_the_channel_and_the_router() {
        let _env = ENV_LOCK.lock().unwrap();
        let (state, dir) = test_state().await;
        std::env::set_var("SUPERMUX_PROJECT_DIRS", &dir);
        // The card is seeded at boot (`main`), and the grant's FK points at it —
        // so a test that skips the seed would assert against a grant the real
        // server writes and this one silently could not.
        crate::connectors::groupchat::seed(&state).await;

        create_handler(
            State(state.clone()),
            crate::scope::OptCtx(None),
            Json(CreateCompanyInput {
                slug: "acme".into(),
                display_name: "Acme".into(),
                root_dir: None,
                enable_group_chat: Some(true),
            }),
        )
        .await
        .expect("create should succeed");

        let id = companies::get_by_slug(&state.pool, "acme").await.unwrap().unwrap().id;

        // 1. The welcome row — the hero opens on a real message, not empty air.
        let (rows, _) = groupchat::rehydrate(&groupchat::log_path(&state, id));
        assert_eq!(rows.len(), 1, "one welcome row");
        assert_eq!(rows[0].author_session, "server", "server-authored");
        assert!(rows[0].body.contains("Acme"), "{}", rows[0].body);

        // 2. The company-tier grant: every bot in this company inherits it.
        let key = format!("{}{}", crate::db::connectors::COMPANY_PREFIX, id);
        let granted = crate::db::connectors::grants_for_connector(
            &state.pool,
            crate::connectors::groupchat::GROUPCHAT_ID,
        )
        .await
        .unwrap();
        assert!(
            granted.iter().any(|g| g.session_name == key && g.enabled == 1),
            "expected an enabled @company grant, got {granted:?}"
        );

        // 3. The Main Assistant, by the one naming convention, in this company.
        let router = crate::db::sessions::get(&state.pool, "acme-assistant")
            .await
            .unwrap()
            .expect("the assistant session row exists");
        assert_eq!(router.company_id, Some(id));
        assert_eq!(router.provider, "claude");

        state.pool.close().await;
        std::env::remove_var("SUPERMUX_PROJECT_DIRS");
        let _ = std::fs::remove_dir_all(dir);
    }

    /// ABSENT means OFF. An older client, a script or a `curl` that says nothing
    /// must not suddenly start booting a Claude session because the server was
    /// upgraded — the web checkbox is what sends `true`.
    #[tokio::test]
    async fn group_chat_is_off_unless_the_caller_asks_for_it() {
        let _env = ENV_LOCK.lock().unwrap();
        let (state, dir) = test_state().await;
        std::env::set_var("SUPERMUX_PROJECT_DIRS", &dir);

        create_handler(
            State(state.clone()),
            crate::scope::OptCtx(None),
            Json(CreateCompanyInput {
                slug: "quiet".into(),
                display_name: "Quiet".into(),
                root_dir: None,
                enable_group_chat: None,
            }),
        )
        .await
        .expect("create should succeed");

        let id = companies::get_by_slug(&state.pool, "quiet").await.unwrap().unwrap().id;
        assert!(
            !groupchat::log_path(&state, id).exists(),
            "no channel is created for a company that did not ask"
        );
        assert!(
            crate::db::sessions::get(&state.pool, "quiet-assistant").await.unwrap().is_none(),
            "no assistant bot is created either"
        );

        state.pool.close().await;
        std::env::remove_var("SUPERMUX_PROJECT_DIRS");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn delete_company_refused_when_active_sessions_present() {
        let (state, dir) = test_state().await;
        let c = companies::create(&state.pool, "acme", "Acme", &root_under(&dir, "acme"))
            .await
            .unwrap();
        // An active (archived=0) member session.
        crate::db::sessions::insert_minimal(&state.pool, "bot-a", "/tmp/bot-a", "shell")
            .await
            .unwrap();
        sqlx::query("UPDATE sessions SET company_id = ? WHERE name = 'bot-a'")
            .bind(c.id)
            .execute(&state.pool)
            .await
            .unwrap();

        let r = delete_handler(State(state.clone()), crate::scope::OptCtx(None), Path(c.id)).await;
        match r {
            Err(AppError::Conflict(_)) => {}
            other => panic!("expected Conflict, got {:?}", other.err()),
        }
        // The row survives the refused delete.
        assert!(companies::get(&state.pool, c.id).await.unwrap().is_some());
        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn create_then_list_roundtrip_over_http() {
        let _env = ENV_LOCK.lock().unwrap();
        let (state, dir) = test_state().await;
        std::env::set_var("SUPERMUX_PROJECT_DIRS", &dir);
        let r = create_handler(
            State(state.clone()),
            crate::scope::OptCtx(None),
            Json(CreateCompanyInput {
                slug: "acme".into(),
                display_name: "Acme".into(),
                root_dir: None,
                enable_group_chat: None,
            }),
        )
        .await;
        assert!(r.is_ok(), "create should succeed");
        // The server-derived root_dir (`<projects>/companies/acme`) was mkdir'd.
        assert!(dir.join("companies").join("acme").is_dir());

        // GET lists it.
        let listed = list_handler(
            State(state.clone()),
            crate::scope::OptCtx(None),
            Query(ListParams { archived: None }),
        )
        .await
        .unwrap();
        assert_eq!(listed.data.len(), 1);
        let id = listed.data[0].id;

        // PATCH archived=1 hides it from the default list.
        patch_handler(
            State(state.clone()),
            crate::scope::OptCtx(None),
            Path(id),
            Json(PatchCompanyInput {
                display_name: None,
                archived: Some(true),
            }),
        )
        .await
        .unwrap();
        let default_list = list_handler(
            State(state.clone()),
            crate::scope::OptCtx(None),
            Query(ListParams { archived: None }),
        )
        .await
        .unwrap();
        assert_eq!(default_list.data.len(), 0, "archived hidden by default");
        let with_archived = list_handler(
            State(state.clone()),
            crate::scope::OptCtx(None),
            Query(ListParams {
                archived: Some("1".into()),
            }),
        )
        .await
        .unwrap();
        assert_eq!(with_archived.data.len(), 1, "included when asked");

        state.pool.close().await;
        std::env::remove_var("SUPERMUX_PROJECT_DIRS");
        let _ = std::fs::remove_dir_all(dir);
    }
}
