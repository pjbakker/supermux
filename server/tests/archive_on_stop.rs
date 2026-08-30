//! The disposable-session marker (`sessions.archive_on_stop`, migration 0025):
//! the `archive_pending` gate, the stop-time auto-archive hook, and the
//! workflows plumbing that stamps a target session.

use supermux_server::config::{Config, ProviderDefaults, TlsConfig};
use supermux_server::sessions::lifecycle;
use supermux_server::state::AppState;
use supermux_server::{db, http};

const TOKEN: &str = "archive-removes-token";

async fn setup() -> (AppState, axum::Router, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("supermux-archive-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let config = Config {
        data_dir: dir.clone(),
        bind: "127.0.0.1:0".parse().unwrap(),
        extra_binds: vec![],
        extra_origins: vec![],
        tls: TlsConfig::default(),
        auth_token: TOKEN.to_string(),
        provider_defaults: ProviderDefaults::default(),
        ws: Default::default(),
        remote_callback_url: None,
        push_sub: None,
        github_token: None,
        statusline_tap: false,
        isolation_mode: supermux_server::isolation::IsolationMode::BestEffort,
        human_auth: Default::default(),
    };
    let pool = db::init(&config).await.expect("db init");
    let state = AppState::new(pool, config);
    let app = http::router(state.clone());
    (state, app, dir)
}

async fn insert_session(state: &supermux_server::state::AppState, name: &str, archive_on_stop: bool) {
    let new = db::sessions::NewSession {
        name: name.to_string(),
        display_name: name.to_string(),
        dir: "/tmp".into(),
        desc: String::new(),
        provider: "claude".into(),
        creator: "spawn".into(),
        flags: String::new(),
        tags: "[]".into(),
        branch: String::new(),
        mcp: String::new(),
        worktree: false,
        worktree_repo: String::new(),
        host_id: None,
        company_id: None,
        runtime: "tmux".into(),
        model: String::new(),
        archive_on_stop,
    };
    db::sessions::create(&state.pool, &new).await.unwrap();
}

#[tokio::test]
async fn archive_pending_true_only_when_flagged_and_live() {
    let (state, _router, _dir) = setup().await;
    insert_session(&state, "boot-a", true).await;
    insert_session(&state, "boot-b", false).await;

    assert!(db::sessions::archive_pending(&state.pool, "boot-a").await.unwrap());
    assert!(!db::sessions::archive_pending(&state.pool, "boot-b").await.unwrap());
    // Missing row -> false (not an error).
    assert!(!db::sessions::archive_pending(&state.pool, "nope").await.unwrap());

    // Once archived, no longer pending.
    db::sessions::set_archived(&state.pool, "boot-a", true).await.unwrap();
    assert!(!db::sessions::archive_pending(&state.pool, "boot-a").await.unwrap());
}

#[tokio::test]
async fn maybe_archive_on_stop_archives_only_flagged_and_is_idempotent() {
    let (state, _router, _dir) = setup().await;
    insert_session(&state, "flagged", true).await;
    insert_session(&state, "plain", false).await;

    // Flagged -> archived.
    lifecycle::maybe_archive_on_stop(&state, "flagged").await;
    assert_eq!(db::sessions::is_archived(&state.pool, "flagged").await.unwrap(), Some(true));

    // Unflagged -> untouched.
    lifecycle::maybe_archive_on_stop(&state, "plain").await;
    assert_eq!(db::sessions::is_archived(&state.pool, "plain").await.unwrap(), Some(false));

    // Idempotent: a second call on the already-archived row logs no new audit row.
    let before = audit_count(&state.pool, "flagged").await;
    lifecycle::maybe_archive_on_stop(&state, "flagged").await;
    let after = audit_count(&state.pool, "flagged").await;
    assert_eq!(before, after, "second call must be a no-op (no duplicate audit)");
}

/// Count `session.archive` audit rows for `target`.
async fn audit_count(pool: &sqlx::SqlitePool, target: &str) -> i64 {
    let (n,): (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM audit_log WHERE action = 'session.archive' AND target = ?",
    )
    .bind(target)
    .fetch_one(pool)
    .await
    .unwrap();
    n
}
