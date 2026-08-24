//! **Shared-Browser connector, phase 1 — the real-chrome integration tests.**
//!
//! These drive an actual `chrome-headless-shell` over a real CDP WebSocket.
//! They are `#[ignore]`d (the repo's convention for tests that need an external
//! binary — see `sessions::tmux`), so a CI box without the pinned chrome stays
//! green. Run them explicitly:
//!
//! ```bash
//! OPENSSL_NO_VENDOR=1 OPENSSL_LIB_DIR=/usr/lib/x86_64-linux-gnu \
//!   cargo test --test browser_service -- --ignored --test-threads=1 --nocapture
//! ```
//!
//! `--test-threads=1` on purpose: each test spawns its own browser (~600 MB
//! RSS with a few contexts), and the leak test scans the *global* process table.
//!
//! # Two modes, two opposite guarantees
//!
//! Shared-browser v1 added a persistent workspace mode beside the original
//! per-agent scratch mode, and the two want **opposite** things from a profile:
//!
//! * **Agent scratch** — nothing survives. Both isolation tests below are still
//!   true and still desirable, so they are **re-scoped, not deleted**: they name
//!   `scratch` explicitly and select `ProfileMode::Ephemeral` explicitly, so
//!   nobody can read them as a global invariant they stopped being.
//! * **Workspace tab** — the login survives *everything*. That is the mirror
//!   image, and it is one test:
//!   [`a_login_survives_a_chrome_restart_on_the_durable_profile`].
//!
//! Coverage:
//! 1. [`lifecycle_leaves_no_orphan_process_or_profile_dir`] — THE critical one
//!    (explicitly `Ephemeral`: an ephemeral profile is still removed).
//! 2. [`two_scratch_contexts_are_cookie_and_localstorage_isolated`]
//! 2b. [`a_recycled_session_name_never_inherits_the_previous_scratch_cookie_jar`]
//!     — what disposing the context on session end buys beyond the leak fix.
//! 2c. [`a_login_survives_a_chrome_restart_on_the_durable_profile`] — the mirror.
//! 2d. [`a_durable_profile_survives_shutdown_without_leaking_a_process`]
//! 3. [`click_and_insert_text_mutate_the_page`]
//! 4. [`human_takeover_refuses_agent_input_until_released`]
//! 5. [`dropping_the_service_without_shutdown_still_kills_the_tree`] — the Drop backstop.

use std::path::Path;
use std::time::Duration;

use supermux_server::connectors::browser::context::ScreencastOptions;
use supermux_server::connectors::browser::error::BrowserError;
use supermux_server::connectors::browser::launch::ProfileMode;
use supermux_server::connectors::browser::lock::{Actor, DriveMode, HandOff};
use supermux_server::connectors::browser::tab::TabMeta;
use supermux_server::connectors::browser::{dispose_on_teardown, BrowserConfig, BrowserService};

// ── harness ─────────────────────────────────────────────────────────────────

/// A service configured for tests: idle reaping off (the tests own teardown),
/// small viewport, tiny context cap so the guard is cheap to exercise.
///
/// **`ProfileMode::Ephemeral` is explicit and load-bearing.** The service now
/// defaults to the durable workspace profile; the leak test and the isolation
/// tests below are *about* the throwaway one, and selecting it here is what keeps
/// them asserting exactly what they have always asserted.
fn test_service() -> std::sync::Arc<BrowserService> {
    BrowserService::new(BrowserConfig {
        width: 800,
        height: 600,
        max_contexts: 4,
        max_tabs: 4,
        profile: ProfileMode::Ephemeral,
        idle_timeout: Duration::ZERO,
        ..BrowserConfig::default()
    })
}

/// A service on a **durable** profile at `dir` — the workspace shape. Two of
/// these on the same `dir` (sequentially) is the persistence test.
fn durable_service(dir: &Path) -> std::sync::Arc<BrowserService> {
    BrowserService::new(BrowserConfig {
        width: 800,
        height: 600,
        max_contexts: 4,
        max_tabs: 4,
        profile: ProfileMode::Durable(dir.to_path_buf()),
        idle_timeout: Duration::ZERO,
        ..BrowserConfig::default()
    })
}

/// Skip (loudly) if the pinned chrome is not installed on this box.
fn chrome_present() -> bool {
    let exe = BrowserConfig::default().executable;
    if exe.exists() {
        return true;
    }
    eprintln!("SKIP: no chrome-headless-shell at {}", exe.display());
    false
}

/// One row of the process table, for the leak assertions.
#[derive(Debug, Clone)]
struct Proc {
    pid: u32,
    /// Process-GROUP id — field 5 of `/proc/<pid>/stat`.
    pgrp: u32,
    cmdline: String,
}

/// Snapshot every process on the box (pid, pgrp, cmdline).
fn ps() -> Vec<Proc> {
    let mut out = Vec::new();
    let Ok(dir) = std::fs::read_dir("/proc") else {
        return out;
    };
    for entry in dir.flatten() {
        let name = entry.file_name();
        let Some(pid) = name.to_str().and_then(|s| s.parse::<u32>().ok()) else {
            continue;
        };
        // `pid (comm) state ppid pgrp …` — comm can contain spaces AND parens,
        // so split after the LAST ')'.
        let Ok(stat) = std::fs::read_to_string(entry.path().join("stat")) else {
            continue;
        };
        let Some(rest) = stat.rsplit_once(')') else {
            continue;
        };
        let fields: Vec<&str> = rest.1.split_whitespace().collect();
        // fields[0] = state, [1] = ppid, [2] = pgrp
        let Some(pgrp) = fields.get(2).and_then(|s| s.parse::<u32>().ok()) else {
            continue;
        };
        let cmdline = std::fs::read(entry.path().join("cmdline"))
            .map(|raw| String::from_utf8_lossy(&raw).replace('\0', " "))
            .unwrap_or_default();
        out.push(Proc { pid, pgrp, cmdline });
    }
    out.sort_by_key(|p| p.pid);
    out
}

/// **The precise orphan check.** Chrome is spawned with `process_group(0)`, so
/// its pgid equals its pid and *every* renderer / gpu / utility child inherits
/// it. Anything still in that group after shutdown is a leak — including the
/// children, which do NOT carry `--user-data-dir` in their own cmdline (with
/// `--no-zygote` only the parent does), so a cmdline scan alone would miss them.
fn procs_in_group(pgid: u32) -> Vec<Proc> {
    ps().into_iter().filter(|p| p.pgrp == pgid).collect()
}

/// Every pid whose `/proc/<pid>/cmdline` mentions `needle` — the second,
/// independent leak lens (catches anything that escaped the group).
fn procs_mentioning(needle: &str) -> Vec<u32> {
    ps().into_iter()
        .filter(|p| p.cmdline.contains(needle))
        .map(|p| p.pid)
        .collect()
}

/// A minimal loopback HTTP server serving one fixed HTML page.
///
/// Cookies and `localStorage` require a real (non-opaque) origin, so a `data:`
/// URL cannot carry the isolation test. Hand-rolled rather than pulled from a
/// framework so the test has zero behaviour of its own to debug.
async fn serve_page(html: &'static str) -> (String, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind loopback");
    let addr = listener.local_addr().expect("local_addr");
    let handle = tokio::spawn(async move {
        loop {
            let Ok((mut sock, _)) = listener.accept().await else {
                break;
            };
            tokio::spawn(async move {
                use tokio::io::{AsyncReadExt, AsyncWriteExt};
                // Read the request head; we serve the same page for any path.
                let mut buf = [0u8; 2048];
                let _ = sock.read(&mut buf).await;
                let response = format!(
                    "HTTP/1.1 200 OK\r\n\
                     Content-Type: text/html; charset=utf-8\r\n\
                     Content-Length: {}\r\n\
                     Cache-Control: no-store\r\n\
                     Connection: close\r\n\r\n{}",
                    html.len(),
                    html
                );
                let _ = sock.write_all(response.as_bytes()).await;
                let _ = sock.flush().await;
            });
        }
    });
    (format!("http://127.0.0.1:{}/", addr.port()), handle)
}

/// The page under test: a text input parked at the top-left so a click at
/// (20, 20) is guaranteed to land in it (the spike burned an hour on an
/// overlay stealing the click — gotcha in `SPIKE-RESULT.md` §3).
const PAGE: &str = r#"<!doctype html><meta charset="utf-8"><title>supermux browser phase 1</title>
<body style="margin:0;background:#fff">
<input id="t" value="" style="position:absolute;left:0;top:0;width:400px;height:80px;font-size:24px">
<script>
  window.__clicks = 0;
  document.getElementById('t').addEventListener('click', () => { window.__clicks++; });
</script>
</body>"#;

// ── 1. lifecycle / leak — THE critical test ─────────────────────────────────

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs the pinned chrome-headless-shell"]
async fn lifecycle_leaves_no_orphan_process_or_profile_dir() {
    if !chrome_present() {
        return;
    }
    let svc = test_service();

    // Nothing before first use: lazy start is the byte-identical-launch invariant.
    assert!(
        !svc.is_running().await,
        "constructing the service must spawn nothing"
    );

    let ctx = svc.context_for("leak-test").await.expect("context");
    ctx.navigate(Actor::Agent, "data:text/html,<h1 id=h>phase-1</h1>")
        .await
        .expect("navigate");
    let heading = ctx
        .evaluate("document.getElementById('h').textContent")
        .await
        .expect("evaluate");
    assert_eq!(heading, serde_json::json!("phase-1"));

    let pid = svc.chrome_pid().await.expect("pid while running");
    let profile = svc.user_data_dir().await.expect("profile while running");
    let needle = profile.to_string_lossy().into_owned();

    // The whole chrome TREE, by process group (pgid == the browser pid).
    let during = procs_in_group(pid);
    eprintln!("[ps DURING] pid={pid} profile={needle}");
    for p in &during {
        let kind = p
            .cmdline
            .split_whitespace()
            .find(|a| a.starts_with("--type="))
            .unwrap_or("(browser)");
        eprintln!("            pid={} pgrp={} {kind}", p.pid, p.pgrp);
    }
    assert!(
        during.iter().any(|p| p.pid == pid),
        "the browser process must be in its own group"
    );
    assert!(
        during.len() >= 2,
        "expected renderer/utility children in the group, saw {during:?}"
    );
    assert!(
        procs_mentioning(&needle).contains(&pid),
        "the browser pid should reference its own --user-data-dir"
    );
    assert!(
        Path::new(&profile).is_dir(),
        "profile dir should exist while running"
    );

    // ── teardown ──
    svc.shutdown().await;

    // The browser pid is gone …
    assert!(
        !supermux_server::connectors::browser::launch::pid_alive(pid),
        "chrome pid {pid} is STILL ALIVE after shutdown()"
    );
    // … and so is every renderer/gpu/utility child of the group …
    let after = procs_in_group(pid);
    eprintln!("[ps AFTER]  procs in group {pid} = {}", after.len());
    assert!(
        after.is_empty(),
        "ORPHANS LEAKED: {} processes still in chrome's process group: {after:#?}",
        after.len()
    );
    // … including under the independent cmdline lens …
    let stragglers = procs_mentioning(&needle);
    eprintln!("[ps AFTER]  procs mentioning the profile = {stragglers:?}");
    assert!(
        stragglers.is_empty(),
        "ORPHANS LEAKED: {stragglers:?} still reference {needle}"
    );
    // … and the scratch profile is removed.
    assert!(
        !Path::new(&profile).exists(),
        "user-data-dir {needle} was not removed"
    );
    assert!(!svc.is_running().await);
    assert_eq!(svc.chrome_pid().await, None);

    // Idempotent: a second shutdown must not panic or resurrect anything.
    svc.shutdown().await;
    assert!(procs_in_group(pid).is_empty());
    assert!(procs_mentioning(&needle).is_empty());
}

// ── 2. per-agent SCRATCH context isolation ──────────────────────────────────
//
// Re-scoped, body unchanged. This is the guarantee agent scratch mode keeps, and
// the reason an ungranted agent's browser is exactly as isolated as it ever was
// — even though the chrome it runs in may be holding the human's durable profile
// open at the same time (an incognito-equivalent context does not persist).

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs the pinned chrome-headless-shell"]
async fn two_scratch_contexts_are_cookie_and_localstorage_isolated() {
    if !chrome_present() {
        return;
    }
    let (url, server) = serve_page(PAGE).await;
    let svc = test_service();

    let a = svc.context_for("agent-a").await.expect("context a");
    let b = svc.context_for("agent-b").await.expect("context b");
    assert_ne!(
        a.browser_context_id(),
        b.browser_context_id(),
        "each agent must get its own browserContextId"
    );

    a.navigate(Actor::Agent, &url).await.expect("nav a");
    b.navigate(Actor::Agent, &url).await.expect("nav b");

    a.evaluate("document.cookie='who=AGENT_A;path=/'; localStorage.setItem('who','AGENT_A'); 1")
        .await
        .expect("write a");
    b.evaluate("document.cookie='who=AGENT_B;path=/'; localStorage.setItem('who','AGENT_B'); 1")
        .await
        .expect("write b");

    let a_cookie = a.evaluate("document.cookie").await.expect("read a cookie");
    let b_cookie = b.evaluate("document.cookie").await.expect("read b cookie");
    let a_ls = a
        .evaluate("localStorage.getItem('who')")
        .await
        .expect("read a ls");
    let b_ls = b
        .evaluate("localStorage.getItem('who')")
        .await
        .expect("read b ls");
    eprintln!("[isolation] a: cookie={a_cookie} ls={a_ls}");
    eprintln!("[isolation] b: cookie={b_cookie} ls={b_ls}");

    assert_eq!(a_cookie, serde_json::json!("who=AGENT_A"));
    assert_eq!(b_cookie, serde_json::json!("who=AGENT_B"));
    assert_eq!(a_ls, serde_json::json!("AGENT_A"));
    assert_eq!(b_ls, serde_json::json!("AGENT_B"));

    // Idempotent lookup: same session ⇒ same context, not a second one.
    let a_again = svc.context_for("agent-a").await.expect("context a again");
    assert_eq!(a_again.browser_context_id(), a.browser_context_id());
    assert_eq!(svc.sessions().await, vec!["agent-a", "agent-b"]);

    // Disposing one agent's context leaves its sibling responsive.
    svc.close_context("agent-b").await.expect("close b");
    assert_eq!(svc.sessions().await, vec!["agent-a"]);
    let still_there = a
        .evaluate("localStorage.getItem('who')")
        .await
        .expect("a still alive");
    assert_eq!(still_there, serde_json::json!("AGENT_A"));

    // The max-contexts guard.
    for name in ["c", "d", "e"] {
        let _ = svc.context_for(name).await;
    }
    let err = svc.context_for("one-too-many").await.unwrap_err();
    assert!(
        matches!(err, BrowserError::TooManyContexts { max: 4 }),
        "got {err:?}"
    );

    svc.shutdown().await;
    server.abort();
}

// ── 2b. a recycled session name starts clean ────────────────────────────────

/// The second thing `dispose_on_teardown` buys, after the leak itself.
///
/// supermux session names are recycled — delete `scraper`, create `scraper`
/// again, and a different bot answers to the same name. Contexts are keyed by
/// that name, so before the teardown wiring the new bot found the old one's
/// context still sitting there: same page, same cookies, still logged in. No
/// extra machinery is needed to prevent that — freeing the context when the
/// session ends means there is simply nothing left under the name.
///
/// This drives the real teardown helper (the one the `SessionEnd` hook,
/// `lifecycle::stop`, delete/archive and rename all call), not `close_context`
/// directly, so it fails if that helper stops disposing.
///
/// **Scoped to scratch.** The same helper must NOT reach a workspace tab — a
/// session ending closing a tab a human pinned and logged into is the anti-goal
/// of the feature — which is why it calls `close_scratch` and cannot see the tab
/// map at all.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs the pinned chrome-headless-shell"]
async fn a_recycled_session_name_never_inherits_the_previous_scratch_cookie_jar() {
    if !chrome_present() {
        return;
    }
    let (url, server) = serve_page(PAGE).await;
    let svc = test_service();

    // ── occupant #1 signs in ────────────────────────────────────────────────
    let first = svc.context_for("scraper").await.expect("first occupant");
    first.navigate(Actor::Agent, &url).await.expect("nav 1");
    first
        .evaluate("document.cookie='sid=THE-FIRST-BOT;path=/'; localStorage.setItem('sid','THE-FIRST-BOT'); 1")
        .await
        .expect("sign in");
    assert_eq!(
        first.evaluate("document.cookie").await.expect("jar 1"),
        serde_json::json!("sid=THE-FIRST-BOT"),
        "occupant #1 really is logged in"
    );
    let first_id = first
        .browser_context_id()
        .expect("a scratch context owns a browserContextId")
        .to_string();

    // ── its session ends ────────────────────────────────────────────────────
    dispose_on_teardown(&svc, "scraper")
        .expect("a runtime")
        .await
        .expect("disposal task");
    assert_eq!(
        svc.context_count().await,
        0,
        "session end must free the context (the leak fix)"
    );

    // ── the name is recycled by occupant #2 ─────────────────────────────────
    let second = svc.context_for("scraper").await.expect("second occupant");
    assert_ne!(
        second.browser_context_id(),
        Some(first_id.as_str()),
        "there was nothing left to inherit, so this is a NEW browser context"
    );
    second.navigate(Actor::Agent, &url).await.expect("nav 2");
    let jar = second.evaluate("document.cookie").await.expect("jar 2");
    let ls = second
        .evaluate("localStorage.getItem('sid')")
        .await
        .expect("ls 2");
    eprintln!("[recycled-name] occupant #2: cookie={jar} ls={ls}");
    assert_eq!(
        jar,
        serde_json::json!(""),
        "occupant #2 can see occupant #1's cookies"
    );
    assert_eq!(
        ls,
        serde_json::Value::Null,
        "occupant #2 can see occupant #1's localStorage"
    );

    svc.shutdown().await;
    server.abort();
}

// ── 2c. THE MIRROR: a login survives a restart on the durable profile ───────

/// **The single assertion the feature lives or dies on.**
///
/// The exact mirror image of the two isolation tests above: where a scratch
/// context must LOSE everything, a workspace tab must KEEP everything. A cookie
/// and a `localStorage` key written in one Chrome process are read back after
/// that process is gone and a **brand-new** `BrowserService` has opened the same
/// durable profile — which is what a `systemctl restart supermux`, an idle reap
/// and a Chrome crash all look like from the tab's point of view.
///
/// Note the cookie is written with an explicit `max-age`. A *session* cookie
/// (no expiry) is deliberately NOT asserted here: Chrome only restores those when
/// it believes it is resuming a session, which an automation launch on a
/// `--user-data-dir` is not — measured, spec §7.1a. Pretending otherwise would
/// make this test lie about exactly the case the honest `needs_login` state
/// exists for.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs the pinned chrome"]
async fn a_login_survives_a_chrome_restart_on_the_durable_profile() {
    if !chrome_present() {
        return;
    }
    let (url, server) = serve_page(PAGE).await;
    let profile = std::env::temp_dir().join(format!("supermux-durable-{}", uuid::Uuid::new_v4()));
    let tab_id = "tb_persistencetest0001";
    let meta = TabMeta {
        url: url.clone(),
        ..TabMeta::default()
    };

    // ── run #1: the human signs in ──────────────────────────────────────────
    let svc = durable_service(&profile);
    let tab = svc.ensure_tab(tab_id, meta.clone()).await.expect("open tab");
    assert!(
        tab.page().is_persistent(),
        "a workspace tab must live in the DEFAULT context — that context IS the jar"
    );
    assert_eq!(
        tab.page().browser_context_id(),
        None,
        "the workspace path must never call Target.createBrowserContext"
    );
    tab.page()
        .navigate(Actor::Agent, &url)
        .await
        .expect("nav run 1");
    tab.page()
        .evaluate(
            "document.cookie='sid=THE-HUMAN;path=/;max-age=86400'; \
             localStorage.setItem('sid','THE-HUMAN'); 1",
        )
        .await
        .expect("sign in");
    assert_eq!(
        tab.page().evaluate("document.cookie").await.expect("jar 1"),
        serde_json::json!("sid=THE-HUMAN"),
        "the human really is signed in"
    );

    let pid = svc.chrome_pid().await.expect("a live chrome");
    svc.shutdown().await;

    // The process is gone; the JAR IS NOT. This is the one line that separates
    // this test from the ephemeral leak test, which asserts the exact opposite.
    assert!(
        procs_in_group(pid).is_empty(),
        "a durable profile must not weaken process leak-safety by one line"
    );
    assert!(
        profile.exists(),
        "remove_profile() must be a no-op for a durable profile"
    );
    drop(svc);

    // ── run #2: a BRAND-NEW service on the same profile ─────────────────────
    let svc2 = durable_service(&profile);
    let tab2 = svc2
        .ensure_tab(tab_id, meta.clone())
        .await
        .expect("rehydrate tab");
    assert_ne!(
        svc2.chrome_pid().await.expect("a second chrome"),
        pid,
        "this really is a second browser process"
    );
    tab2.page()
        .navigate(Actor::Agent, &url)
        .await
        .expect("nav run 2");
    let jar = tab2
        .page()
        .evaluate("document.cookie")
        .await
        .expect("jar 2");
    let ls = tab2
        .page()
        .evaluate("localStorage.getItem('sid')")
        .await
        .expect("ls 2");
    eprintln!("[durable] after restart: cookie={jar} ls={ls}");
    assert_eq!(
        jar,
        serde_json::json!("sid=THE-HUMAN"),
        "the cookie must survive a full Chrome + service restart"
    );
    assert_eq!(
        ls,
        serde_json::json!("THE-HUMAN"),
        "localStorage must survive a full Chrome + service restart"
    );

    svc2.shutdown().await;
    let _ = std::fs::remove_dir_all(&profile);
    server.abort();
}

// ── 2d. dehydration is lossless, and tabs have independent locks ────────────

/// R4 + R5 + the per-tab lock, in one browser.
///
/// * Dehydrating a tab closes its target and persists nothing else — the row and
///   the cookies stay, so the rehydrated tab still knows who it is.
/// * `Tab::close` must never dispose a browser context: if it did, dehydrating
///   tab A would take tab B (and the whole jar) with it. Tab B answering after
///   A's dehydration is that assertion.
/// * A human on tab A must not block an agent on tab B — the cardinality change
///   the session-keyed lock could not express.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs the pinned chrome"]
async fn dehydrating_one_tab_leaves_its_siblings_and_the_jar_intact() {
    if !chrome_present() {
        return;
    }
    let (url, server) = serve_page(PAGE).await;
    let profile = std::env::temp_dir().join(format!("supermux-durable-{}", uuid::Uuid::new_v4()));
    let svc = durable_service(&profile);
    let meta = TabMeta {
        url: url.clone(),
        ..TabMeta::default()
    };

    let a = svc.ensure_tab("tb_aaaa0001", meta.clone()).await.expect("tab a");
    let b = svc.ensure_tab("tb_bbbb0002", meta.clone()).await.expect("tab b");
    assert_eq!(svc.tab_count().await, 2);
    a.page().navigate(Actor::Agent, &url).await.expect("nav a");
    b.page().navigate(Actor::Agent, &url).await.expect("nav b");
    a.page()
        .evaluate("document.cookie='shared=YES;path=/;max-age=3600'; 1")
        .await
        .expect("write a");

    // Same DEFAULT context ⇒ tab B sees the cookie tab A set. That is the
    // POINT: one jar, shared by every workspace tab.
    let seen_by_b = b.page().evaluate("document.cookie").await.expect("jar b");
    assert_eq!(
        seen_by_b,
        serde_json::json!("shared=YES"),
        "workspace tabs share ONE jar — the human's profile"
    );

    // Independent locks: a human on A does not stop an agent on B.
    a.lock().request_human_takeover();
    assert!(
        a.page().navigate(Actor::Agent, &url).await.is_err(),
        "the agent must be refused on the tab a human took over"
    );
    b.page()
        .navigate(Actor::Agent, &url)
        .await
        .expect("tab B must be unaffected by a human on tab A");
    a.lock().release_to_agent(HandOff::Explicit);

    // Dehydrate A. B must still answer — proof that closing a tab did NOT
    // dispose the shared context.
    assert!(svc.dehydrate_tab("tb_aaaa0001").await.expect("dehydrate"));
    assert_eq!(svc.tab_count().await, 1);
    assert_eq!(svc.live_tabs().await, vec!["tb_bbbb0002"]);
    let b_after = b.page().evaluate("document.cookie").await.expect("jar b after");
    assert_eq!(
        b_after,
        serde_json::json!("shared=YES"),
        "dehydrating one tab must not touch its siblings or the jar"
    );

    // Rehydrating A finds the jar exactly where it left it.
    let a2 = svc.ensure_tab("tb_aaaa0001", meta).await.expect("rehydrate a");
    a2.page().navigate(Actor::Agent, &url).await.expect("nav a2");
    assert_eq!(
        a2.page().evaluate("document.cookie").await.expect("jar a2"),
        serde_json::json!("shared=YES"),
        "a rehydrated tab is signed in exactly as it was"
    );

    svc.shutdown().await;
    let _ = std::fs::remove_dir_all(&profile);
    server.abort();
}

// ── 3. input + read-back ────────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs the pinned chrome-headless-shell"]
async fn click_and_insert_text_mutate_the_page() {
    if !chrome_present() {
        return;
    }
    let (url, server) = serve_page(PAGE).await;
    let svc = test_service();
    let ctx = svc.context_for("typist").await.expect("context");
    ctx.navigate(Actor::Agent, &url).await.expect("navigate");

    let before = ctx
        .evaluate("document.getElementById('t').value")
        .await
        .expect("read");
    assert_eq!(before, serde_json::json!(""));

    // Click focuses the input …
    ctx.click(Actor::Agent, 20.0, 20.0).await.expect("click");
    let clicks = ctx.evaluate("window.__clicks").await.expect("read clicks");
    let focused = ctx
        .evaluate("document.activeElement && document.activeElement.id")
        .await
        .expect("read focus");
    assert_eq!(
        clicks,
        serde_json::json!(1),
        "the click handler must have run"
    );
    assert_eq!(
        focused,
        serde_json::json!("t"),
        "the click must focus the input"
    );

    // … insertText types (incl. non-ASCII + emoji, which per-key events can't) …
    ctx.insert_text(Actor::Agent, "Hey42 héllo 🌍")
        .await
        .expect("insert");
    let typed = ctx
        .evaluate("document.getElementById('t').value")
        .await
        .expect("read");
    eprintln!("[input] value after insertText = {typed}");
    assert_eq!(typed, serde_json::json!("Hey42 héllo 🌍"));

    // … and a real key event edits it.
    ctx.press_key(Actor::Agent, "Backspace")
        .await
        .expect("backspace");
    let trimmed = ctx
        .evaluate("document.getElementById('t').value")
        .await
        .expect("read");
    eprintln!("[input] value after Backspace  = {trimmed}");
    assert_eq!(trimmed, serde_json::json!("Hey42 héllo "));

    // A screencast subscription yields decodable frames (phase 2's data plane).
    let mut frames = ctx
        .start_screencast(Actor::Agent, ScreencastOptions::default())
        .await
        .expect("start screencast");
    // A static page emits ~0 frames (gotcha #1), so force repaints.
    ctx.evaluate("(function(){let n=0;const id=setInterval(()=>{document.body.style.background=(n++%2)?'#f00':'#00f';if(n>40)clearInterval(id);},16);return 1})()")
        .await
        .expect("animate");
    let frame = tokio::time::timeout(Duration::from_secs(5), frames.recv())
        .await
        .expect("a frame within 5s")
        .expect("frame channel open");
    eprintln!(
        "[screencast] {} base64 bytes, metadata={}",
        frame.data.len(),
        frame.metadata
    );
    assert!(
        frame.data.len() > 100,
        "frame should carry real image bytes"
    );
    assert!(
        frame.metadata.get("deviceWidth").is_some(),
        "metadata drives coord mapping"
    );
    ctx.stop_screencast(Actor::Agent)
        .await
        .expect("stop screencast");

    svc.shutdown().await;
    server.abort();
}

// ── 4. the AGENT/HUMAN lock, against a live page ────────────────────────────

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs the pinned chrome-headless-shell"]
async fn human_takeover_refuses_agent_input_until_released() {
    if !chrome_present() {
        return;
    }
    let (url, server) = serve_page(PAGE).await;
    let svc = test_service();
    let ctx = svc.context_for("shared").await.expect("context");
    ctx.navigate(Actor::Agent, &url).await.expect("navigate");
    assert_eq!(svc.mode("shared").await.unwrap(), DriveMode::AgentDriving);

    // The agent types freely while it holds the wheel.
    ctx.click(Actor::Agent, 20.0, 20.0)
        .await
        .expect("agent click");
    ctx.insert_text(Actor::Agent, "agent-")
        .await
        .expect("agent types");

    // ── the human grabs it ──
    let previous = svc
        .request_human_takeover("shared")
        .await
        .expect("takeover");
    assert_eq!(previous, DriveMode::AgentDriving);
    assert_eq!(svc.mode("shared").await.unwrap(), DriveMode::HumanDriving);

    let err = ctx
        .insert_text(Actor::Agent, "SHOULD-NOT-LAND")
        .await
        .expect_err("agent input must be refused under HUMAN_DRIVING");
    eprintln!("[lock] agent refused with: {err}");
    assert!(
        matches!(&err, BrowserError::HumanDriving { subject } if subject == "shared"),
        "got {err:?}"
    );
    for refused in [
        ctx.click(Actor::Agent, 20.0, 20.0).await.err(),
        ctx.navigate(Actor::Agent, "about:blank").await.err(),
        ctx.press_key(Actor::Agent, "Enter").await.err(),
        ctx.tap(Actor::Agent, 20.0, 20.0).await.err(),
        ctx.scroll(Actor::Agent, 10.0, 10.0, 0.0, 100.0).await.err(),
    ] {
        assert!(
            matches!(refused, Some(BrowserError::HumanDriving { .. })),
            "every agent action must be gated, got {refused:?}"
        );
    }

    // The human is never gated, and reads stay open for the takeover UI.
    ctx.insert_text(Actor::Human, "human")
        .await
        .expect("human types");
    let during = ctx
        .evaluate("document.getElementById('t').value")
        .await
        .expect("read");
    eprintln!("[lock] value while HUMAN_DRIVING = {during}");
    assert_eq!(
        during,
        serde_json::json!("agent-human"),
        "the agent's refused text must not appear; the human's must"
    );

    // ── release ──
    let previous = svc.release_to_agent("shared", HandOff::Explicit).await.expect("release");
    assert_eq!(previous, DriveMode::HumanDriving);
    assert_eq!(svc.mode("shared").await.unwrap(), DriveMode::AgentDriving);

    ctx.insert_text(Actor::Agent, "-again")
        .await
        .expect("agent types again");
    let after = ctx
        .evaluate("document.getElementById('t').value")
        .await
        .expect("read");
    eprintln!("[lock] value after release      = {after}");
    assert_eq!(after, serde_json::json!("agent-human-again"));

    svc.shutdown().await;
    server.abort();
}

// ── 5. the Drop backstop (leak safety guarantee #2) ─────────────────────────

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs the pinned chrome-headless-shell"]
async fn dropping_the_service_without_shutdown_still_kills_the_tree() {
    if !chrome_present() {
        return;
    }
    let (pid, profile) = {
        let svc = test_service();
        let ctx = svc.context_for("dropped").await.expect("context");
        ctx.navigate(Actor::Agent, "data:text/html,<b>drop me</b>")
            .await
            .expect("navigate");
        let pid = svc.chrome_pid().await.expect("pid");
        let profile = svc.user_data_dir().await.expect("profile");
        assert!(procs_in_group(pid).len() >= 2, "tree should be up");
        (pid, profile)
        // `svc` (and with it ChromeProcess) is dropped here — no shutdown() call.
    };

    // Drop is synchronous: the group kill has already been issued. Give the
    // kernel a moment to actually reap the tree before asserting.
    for _ in 0..50 {
        if procs_in_group(pid).is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let leaked = procs_in_group(pid);
    eprintln!("[drop] procs in group {pid} after Drop = {}", leaked.len());
    assert!(leaked.is_empty(), "Drop leaked {leaked:#?}");
    assert!(
        !Path::new(&profile).exists(),
        "Drop left the profile dir {} behind",
        profile.display()
    );
}
