//! `config_dir` on `POST /api/sessions` (the per-account boot path).
//!
//! Pins the wire contract the dispatcher depends on: a valid absolute
//! directory is stored and echoed on the view; anything else is a 400 that
//! leaves NO row behind; an absent field keeps the old behaviour exactly.

use std::path::PathBuf;

use supermux_server::config::{Config, ProviderDefaults, TlsConfig};
use supermux_server::state::AppState;
use supermux_server::{db, http};

use axum::body::Body;
use axum::http::{header, Method, Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tower::ServiceExt; // for `oneshot`

const TOKEN: &str = "session-config-dir-token";

/// A fresh temp dir, created. Process- and time-unique so parallel tests never
/// share one (same shape as `resumable`'s test helper).
fn temp_dir(tag: &str) -> PathBuf {
    let p = std::env::temp_dir().join(format!(
        "supermux-cfgdir-{tag}-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&p).unwrap();
    p
}

async fn setup() -> (AppState, axum::Router, PathBuf) {
    let dir = temp_dir("data");
    let config = Config {
        data_dir: dir.clone(),
        bind: "127.0.0.1:0".parse().unwrap(),
        extra_binds: vec![],
        extra_origins: vec![],
        tls: TlsConfig::default(),
        auth_token: TOKEN.to_string(),
        provider_defaults: ProviderDefaults::default(),
        ws: Default::default(),
        swarm_reaper: Default::default(),
        remote_callback_url: None,
        push_sub: None,
        github_token: None,
    };
    let pool = db::init(&config).await.expect("db init");
    let state = AppState::new(pool, config);
    let app = http::router(state.clone());
    (state, app, dir)
}

/// Send an authenticated request; returns (status, parsed-JSON-body).
async fn send(
    app: &axum::Router,
    method: Method,
    uri: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut builder = Request::builder()
        .method(method)
        .uri(uri)
        .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"));
    let req = match body {
        Some(b) => {
            builder = builder.header(header::CONTENT_TYPE, "application/json");
            builder.body(Body::from(b.to_string())).unwrap()
        }
        None => builder.body(Body::empty()).unwrap(),
    };
    let resp = app.clone().oneshot(req).await.unwrap();
    let status = resp.status();
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let value: Value = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or(Value::Null)
    };
    (status, value)
}

#[tokio::test]
async fn valid_config_dir_is_stored_and_echoed() {
    let (state, app, data) = setup().await;
    let account = temp_dir("account");
    let (status, body) = send(
        &app,
        Method::POST,
        "/api/sessions",
        Some(json!({
            "name": "second-account",
            "dir": "/tmp",
            "provider": "claude",
            "config_dir": account.to_string_lossy(),
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    assert_eq!(
        body["data"]["config_dir"],
        account.to_string_lossy().as_ref(),
        "{body}"
    );

    let row = db::sessions::get(&state.pool, "second-account")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(row.config_dir, account.to_string_lossy());

    let _ = std::fs::remove_dir_all(account);
    let _ = std::fs::remove_dir_all(data);
}

#[tokio::test]
async fn absent_config_dir_reads_back_empty() {
    let (state, app, data) = setup().await;
    let (status, body) = send(
        &app,
        Method::POST,
        "/api/sessions",
        Some(json!({ "name": "default-account", "dir": "/tmp", "provider": "claude" })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    assert_eq!(body["data"]["config_dir"], "", "{body}");
    let row = db::sessions::get(&state.pool, "default-account")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(row.config_dir, "");
    let _ = std::fs::remove_dir_all(data);
}

/// Every refusal is a 400 AND leaves no row: the caller retries a corrected
/// body under the same name without hitting a 409.
#[tokio::test]
async fn bad_config_dirs_are_refused_with_400_and_no_row() {
    let (state, app, data) = setup().await;
    let file_dir = temp_dir("file");
    let file = file_dir.join("settings.json");
    std::fs::write(&file, b"{}").unwrap();

    let cases: Vec<(&str, String)> = vec![
        // Relative path.
        ("rel", ".claude-second".to_string()),
        // Absolute but does not exist.
        ("gone", "/nonexistent-supermux-config-dir".to_string()),
        // Exists but is a file, not a directory.
        ("file", file.to_string_lossy().to_string()),
        // Shell metacharacters (space, semicolon) outside the charset.
        ("meta", "/tmp/evil; rm -rf /".to_string()),
        // Single quote would close our own quoting.
        ("quote", "/tmp/it's".to_string()),
        // Command substitution.
        ("subst", "/tmp/$(whoami)".to_string()),
    ];

    for (name, value) in cases {
        let (status, body) = send(
            &app,
            Method::POST,
            "/api/sessions",
            Some(json!({
                "name": name,
                "dir": "/tmp",
                "provider": "claude",
                "config_dir": value,
            })),
        )
        .await;
        assert_eq!(
            status,
            StatusCode::BAD_REQUEST,
            "{value:?} must be refused: {body}"
        );
        assert!(
            !db::sessions::exists(&state.pool, name).await.unwrap(),
            "{value:?} must leave no session row"
        );
    }

    let _ = std::fs::remove_dir_all(file_dir);
    let _ = std::fs::remove_dir_all(data);
}
