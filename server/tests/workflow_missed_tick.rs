//! Missed-tick recovery — workflows idempotency after downtime.
//! (Port of `schedule_missed_tick.rs`; the contract is unchanged, only re-keyed
//! by `workflow_id`.)
//!
//! A workflow whose `next_run` is far in the past must NOT burst-fire on the
//! next tick: the tick logs a `skipped` run and ADVANCES `next_run` to the
//! future without delivering anything. Paired with `workflow_run_keys` UNIQUE,
//! this is what stops double/late fires after a laptop sleep or a restart.
//!
//! The third case is new in v1 and belongs here rather than only in
//! `workflows_chain.rs`: §3.2 rule 2 is a TICK-level rule, and asserting it only
//! at the engine level would let a future tick rewrite reintroduce the bug.

use std::path::PathBuf;

use supermux_server::config::{Config, ProviderDefaults, TlsConfig, WsConfig};
use supermux_server::db::workflows::{StepInput, Workflow};
use supermux_server::state::AppState;
use supermux_server::workflows;
use supermux_server::{db, sessions};

use chrono::Utc;

async fn new_state() -> (AppState, PathBuf) {
    let dir = std::env::temp_dir().join(format!("supermux-wf-missed-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let config = Config {
        swarm_reaper: Default::default(),
        data_dir: dir.clone(),
        bind: "127.0.0.1:0".parse().unwrap(),
        extra_binds: vec![],
        extra_origins: vec![],
        tls: TlsConfig::default(),
        auth_token: "wf-missed-token".to_string(),
        provider_defaults: ProviderDefaults::default(),
        ws: WsConfig::default(),
        remote_callback_url: None,
        push_sub: None,
        github_token: None,
        statusline_tap: false,
        isolation_mode: supermux_server::isolation::IsolationMode::BestEffort,
        human_auth: Default::default(),
    };
    let pool = db::init(&config).await.expect("db init");
    (AppState::new(pool, config), dir)
}

/// A live `shell`-provider bot plus a one-step recurring workflow pointed at it.
/// The session is real so that a fire would be VISIBLE (`last_send_text`) — the
/// workflows equivalent of the original test's marker file.
async fn seed(state: &AppState, dir: &std::path::Path, id: &str, session: &str) -> Workflow {
    db::sessions::insert_minimal(&state.pool, session, dir.to_str().unwrap(), "shell")
        .await
        .unwrap();
    db::sessions::ensure_runtime(&state.pool, session, "hook-token").await.unwrap();
    let now = Utc::now().timestamp();
    let wf = Workflow {
        id: id.to_string(),
        title: "missed".into(),
        session: session.to_string(),
        company_id: None,
        enabled: 1,
        trigger_kind: "recurring".into(),
        schedule_expr: Some("every 1m".into()),
        next_run: Some((Utc::now() + chrono::Duration::seconds(60)).to_rfc3339()),
        last_run: None,
        run_count: 0,
        on_complete: r#"{"kind":"none"}"#.into(),
        created: now,
        updated: now,
        deleted: None,
    };
    let wf = db::workflows::insert(&state.pool, &wf).await.unwrap();
    db::workflows::replace_steps(
        &state.pool,
        id,
        &[StepInput { prompt: "MUST-NOT-FIRE".into(), ..Default::default() }],
    )
    .await
    .unwrap();
    wf
}

async fn set_next_run(state: &AppState, id: &str, at: chrono::DateTime<Utc>) {
    sqlx::query("UPDATE workflows SET next_run = ? WHERE id = ?")
        .bind(at.to_rfc3339())
        .bind(id)
        .execute(&state.pool)
        .await
        .unwrap();
}

#[tokio::test]
async fn missed_window_skips_and_advances_without_firing() {
    let (state, dir) = new_state().await;
    seed(&state, &dir, "WF-missed", "missedbot").await;

    // Force next_run 5 minutes into the past (well beyond the 60s window).
    set_next_run(&state, "WF-missed", Utc::now() - chrono::Duration::seconds(300)).await;

    workflows::tick_once(&state).await.unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;

    // Nothing was delivered.
    let sess = db::sessions::get(&state.pool, "missedbot").await.unwrap().unwrap();
    assert_eq!(sess.last_send_text, "", "a missed workflow must not deliver its step");

    // A 'skipped' run row must be recorded, and no 'ok' row.
    let runs = db::workflows::runs_for(&state.pool, "WF-missed", 20).await.unwrap();
    assert!(
        runs.iter().any(|r| r.status == "skipped" && r.note == "missed window"),
        "expected a skipped/missed-window run, got {runs:?}"
    );
    assert!(!runs.iter().any(|r| r.status == "ok"), "must not record an ok run");
    assert!(
        db::workflows::step_runs_for(&state.pool, runs[0].id).await.unwrap().is_empty(),
        "a skipped window opens no step run"
    );

    // next_run must have advanced to the future; run_count untouched (no fire).
    let after = db::workflows::get(&state.pool, "WF-missed").await.unwrap().unwrap();
    let next = chrono::DateTime::parse_from_rfc3339(after.next_run.as_deref().unwrap()).unwrap();
    assert!(next.with_timezone(&Utc) > Utc::now(), "next_run should be in the future");
    assert_eq!(after.run_count, 0, "a missed window must not bump run_count");
    assert_eq!(after.enabled, 1, "a recurring workflow stays enabled");

    let _ = sessions::lifecycle::stop(&state, "missedbot").await;
    state.pool.close().await;
    let _ = std::fs::remove_dir_all(dir);
}

/// `workflow_run_keys` UNIQUE makes a duplicate fire-key claim a no-op — the
/// idempotency guard the tick relies on to avoid double-fires on restart.
#[tokio::test]
async fn fire_key_is_idempotent() {
    let (state, dir) = new_state().await;
    seed(&state, &dir, "WF-idem", "idembot").await;

    let ts = Utc::now().timestamp();
    let first = db::workflows::claim_run_key(&state.pool, "WF-idem", ts).await.unwrap();
    let second = db::workflows::claim_run_key(&state.pool, "WF-idem", ts).await.unwrap();
    assert!(first, "first claim wins");
    assert!(!second, "second claim for the same fire-time is rejected");

    // A different fire-time is a fresh claim.
    let other = db::workflows::claim_run_key(&state.pool, "WF-idem", ts + 60).await.unwrap();
    assert!(other);

    let _ = sessions::lifecycle::stop(&state, "idembot").await;
    state.pool.close().await;
    let _ = std::fs::remove_dir_all(dir);
}

/// §3.2 rule 2 at the TICK level: a due window that lands on a workflow with a
/// run already in flight records ONE skipped run and moves the cadence on — it
/// does not start a second chain, and it does not go silent either.
#[tokio::test]
async fn a_due_tick_while_a_run_is_in_flight_records_a_skip_and_advances_the_cadence() {
    let (state, dir) = new_state().await;
    seed(&state, &dir, "WF-inflight", "inflightbot").await;

    // An open run, exactly as a long chain would leave it.
    let open = db::workflows::open_run(&state.pool, "WF-inflight", "tick").await.unwrap();
    set_next_run(&state, "WF-inflight", Utc::now() - chrono::Duration::seconds(1)).await;

    workflows::tick_once(&state).await.unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;

    let sess = db::sessions::get(&state.pool, "inflightbot").await.unwrap().unwrap();
    assert_eq!(sess.last_send_text, "", "a second chain must never be started");

    let runs = db::workflows::runs_for(&state.pool, "WF-inflight", 20).await.unwrap();
    let skipped: Vec<_> = runs.iter().filter(|r| r.status == "skipped").collect();
    assert_eq!(skipped.len(), 1, "exactly one skip is recorded: {runs:?}");
    assert!(
        skipped[0].note.contains("still in flight"),
        "the note says why: {:?}",
        skipped[0].note
    );
    assert!(
        runs.iter().any(|r| r.id == open && r.status == "running"),
        "the in-flight run is untouched"
    );

    let after = db::workflows::get(&state.pool, "WF-inflight").await.unwrap().unwrap();
    let next = chrono::DateTime::parse_from_rfc3339(after.next_run.as_deref().unwrap()).unwrap();
    assert!(
        next.with_timezone(&Utc) > Utc::now(),
        "the cadence moved on rather than re-firing every 10s"
    );

    let _ = sessions::lifecycle::stop(&state, "inflightbot").await;
    state.pool.close().await;
    let _ = std::fs::remove_dir_all(dir);
}
