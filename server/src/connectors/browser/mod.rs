//! **Shared-Browser connector — the browser service.**
//!
//! One long-lived Chromium, owned by the Rust server, running **two modes at
//! once** over one process and one CDP socket:
//!
//! ```text
//!   BrowserService ── lazily spawns ──▶ chromium --headless=new   (ONE process,
//!        │                                    │                    ONE durable
//!        │  one browser WebSocket (CdpClient) ┘                    --user-data-dir)
//!        │
//!        ├─ tabs["tb_9f…"]  → Tab { durable id, target, DriveLock, grants }   WORKSPACE
//!        ├─ tabs["tb_4c…"]  → Tab { … }        ↑ all in the DEFAULT context —
//!        │                                       the profile on disk IS the jar
//!        ├─ scratch["alice"] → AgentContext { browserContextId, target, lock } AGENT
//!        └─ scratch["bob"]   → AgentContext { … }   ↑ incognito-equivalent, dies
//!                                                     with the session
//! ```
//!
//! # The two modes, and the one argument that chooses between them
//!
//! * **Agent scratch** — today's behaviour, byte for byte. A tool call with no
//!   `tab` argument gets its own isolated context that is destroyed with the
//!   session. Every isolation guarantee it ever had still holds: an
//!   incognito-equivalent context does not persist, even on a durable profile.
//! * **Workspace tab** — the human logs in once; tabs persist and pin; an agent
//!   that is **explicitly granted a tab** reuses that authenticated tab. A tool
//!   call naming a `tab` takes this path, and only after
//!   [`tools::has_tab_grant`] says yes — reads and screenshots included, because
//!   on a logged-in page reading IS the exfiltration.
//!
//! # A tab is durable; its target is not
//!
//! `tb_<uuid>` is minted once and stored in `browser_tabs`. The CDP `targetId`
//! underneath changes on every rehydrate. The idle reaper therefore
//! **dehydrates** rather than evicts (persist url/title → `closeTarget` → keep
//! the row), and because the profile is on disk, the next access relaunches
//! Chrome, reopens the stored URL, and the login is simply there.
//!
//! # Phase boundaries
//!
//! * **Phase 1 (here).** The process manager, the CDP client, the registries,
//!   the drive lock, leak safety.
//! * **Phase 2 (shipped, [`takeover`]).** The takeover UI's data plane: a WS
//!   relay that publishes [`context::ScreencastFrame`]s to an authenticated
//!   client and feeds its taps back as [`lock::Actor::Human`] input. It does
//!   NOT pause the agent's pty — the lock IS the pause (an agent browser call
//!   is refused/parked while [`lock::DriveMode::HumanDriving`]), which leaves
//!   the agent free to keep thinking about everything else.
//! * **Phase 3.** The MCP tool server, whose every tool calls
//!   [`lock::DriveLock::ensure_agent`] before touching a page.
//!
//! # Lazy start is load-bearing
//!
//! [`BrowserService::new`] allocates a config struct and nothing else. Chrome
//! is spawned on the **first** [`BrowserService::context_for`] call. A supermux
//! install with no browser grants therefore never spawns a browser, never
//! installs a signal handler, and never touches `/tmp` — its launch is
//! byte-identical to one built without this module.
//!
//! # Leak safety (the reason this phase exists)
//!
//! Four independent guarantees, because this box has leaked chrome before:
//!
//! 1. **Process group.** Chrome is spawned with `process_group(0)`, so
//!    `kill(-pgid)` reaps the browser *and* every renderer/gpu/utility child.
//! 2. **`Drop`.** [`launch::ChromeProcess`] kills the group and removes the
//!    temp profile on drop — covering panics, early `?`, and dropped tests.
//! 3. **Signal hook.** Installed *only once chrome is actually running*:
//!    SIGTERM/SIGINT tears the browser down before the server exits, because
//!    `std::process::exit` does not run destructors.
//! 4. **Idle reaper.** A browser with zero contexts for
//!    [`BrowserConfig::idle_timeout`] is shut down; the next `context_for`
//!    transparently relaunches.

pub mod cdp;
pub mod context;
pub mod error;
pub mod launch;
pub mod lock;
/// Phase 3: the store-facing connector — the `shared-browser` card and the
/// embedded MCP server a granted bot launches.
pub mod mcp;
/// Phase 3: the lock-gated tool endpoint the MCP server forwards to.
pub mod tools;
/// Phase 2: the human takeover WebSocket — screencast out, input in, gated by
/// the drive lock.
pub mod takeover;
/// Shared-browser v1: the persistent workspace **tab** — the unit a human pins
/// and an agent is granted.
pub mod tab;
/// Shared-browser v1: the HUMAN's bearer-gated tab CRUD + per-tab grant API.
/// Deliberately a different door from [`tools`], which is the agent's.
pub mod api;
/// "Keep me signed in": the 60-second sweep that refreshes an opted-in tab's
/// session from what the cookie jar knows. The first writer of `login_state`
/// and `last_probe_at` that is not a human.
pub mod keepalive;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Once, Weak};
use std::time::{Duration, Instant};

use tokio::sync::{watch, Mutex};
use tokio::task::JoinHandle;
use tracing::{info, warn};

use cdp::CdpClient;
use context::{AgentContext, NavState};
use error::{BrowserError, Result};
use launch::{ChromeProcess, ProfileMode};
use lock::{DriveMode, HandOff};
use tab::{Tab, TabId, TabMeta};

use crate::db::browser_tabs as db_tabs;

pub use error::BrowserError as Error;

/// Cap on live **scratch** contexts. Each context is a page + its renderer; the
/// spike measured ~592 MB RSS for browser + 3 contexts, and one 60 fps
/// screencast already costs ~68 % of a core, so this is a resource guard, not a
/// policy.
const DEFAULT_MAX_CONTEXTS: usize = 8;

/// Cap on **live** workspace tabs. 8 is far too low for a workspace, and this is
/// a LIVENESS ceiling, not a persistence one: `browser_tabs` rows are unbounded
/// by this number, and a dehydrated tab costs a row, not ~100 MB of RSS. Full
/// Chromium idles at ~844 MB, so 16 live tabs is ~2.5 GB — affordable on the
/// deploy box, and precisely why the idle reaper (which dehydrates rather than
/// pinning chrome alive forever) stays.
const DEFAULT_MAX_TABS: usize = 16;

/// Shut the browser down after this long with **zero** contexts.
const DEFAULT_IDLE_TIMEOUT: Duration = Duration::from_secs(10 * 60);

/// How often the idle reaper wakes.
const REAPER_INTERVAL: Duration = Duration::from_secs(30);

/// How long the nav-state write-through waits for a page to go QUIET before it
/// commits a `url`/`title` to `browser_tabs` (P1-5).
///
/// The debounce is the point, not a throttle: a redirect chain publishes several
/// nav states and lands on one, and a per-hop write would leave an interstitial
/// — often a login wall — sitting in the tab list for anyone who looked in the
/// wrong second. One second is far longer than a same-host redirect and far
/// shorter than a human noticing.
const NAV_WRITE_DEBOUNCE: Duration = Duration::from_secs(1);

/// Budget for closing every context during shutdown. A wedged browser must not
/// be able to delay the process kill.
const CONTEXT_DRAIN_BUDGET: Duration = Duration::from_secs(3);

/// Budget for the graceful CDP `Browser.close`. Spike measured 81–101 ms.
const BROWSER_CLOSE_BUDGET: Duration = Duration::from_secs(2);

/// Budget for the one context disposal a session-teardown path fires. A wedged
/// browser must never be able to hold up a session Stop/delete.
const TEARDOWN_BUDGET: Duration = Duration::from_secs(5);

/// Env override: max simultaneous per-agent **scratch** contexts. Deliberately
/// the same variable it always was — scratch mode's tuning is unchanged.
pub const ENV_MAX_CONTEXTS: &str = "SUPERMUX_BROWSER_MAX_CONTEXTS";
/// Env override: max simultaneous LIVE workspace tabs.
pub const ENV_MAX_TABS: &str = "SUPERMUX_BROWSER_MAX_TABS";
/// Env override: the durable profile directory (an operator escape hatch — e.g.
/// putting the credential store on a different volume).
pub const ENV_PROFILE_DIR: &str = "SUPERMUX_BROWSER_PROFILE_DIR";
/// Env override: idle minutes before the shell is reaped (`0` disables).
pub const ENV_IDLE_MINUTES: &str = "SUPERMUX_BROWSER_IDLE_MINUTES";

/// Static configuration for the browser service.
#[derive(Debug, Clone)]
pub struct BrowserConfig {
    /// Absolute path to `chrome-headless-shell`.
    pub executable: PathBuf,
    /// `LD_LIBRARY_PATH` for the child (extracted chrome libs on a no-sudo box).
    pub ld_library_path: Option<String>,
    /// Default per-page viewport (also the browser `--window-size`). Raised from
    /// 1024×768 for v1: a workspace wants a saner login viewport, and 1366×900 is
    /// a less unusual fingerprint besides.
    pub width: u32,
    pub height: u32,
    /// Hard cap on live scratch contexts.
    pub max_contexts: usize,
    /// Hard cap on live workspace tabs.
    pub max_tabs: usize,
    /// **Where the cookie jar lives.** `Durable` is the workspace default; the
    /// leak test and the two isolation tests select `Ephemeral` explicitly, which
    /// is what keeps them asserting exactly what they always asserted.
    pub profile: ProfileMode,
    /// Idle-reap threshold; `Duration::ZERO` disables reaping.
    pub idle_timeout: Duration,
}

/// The durable profile's default location: `<data_dir>/browser/profile`.
///
/// `data_dir` resolves to `$SUPERMUX_DATA_DIR` → `$HOME/.supermux`, which the
/// systemd unit sets explicitly to the service user's real home — deliberately
/// outside the repo checkout and outside the unit's `WorkingDirectory` churn, so
/// the profile survives `deploy-self.sh` AND the in-app updater (which only
/// replaces `<data_dir>/bin/` and writes `<data_dir>/archives/`) for free.
///
/// **It is a credential store.** Mode 0700, excluded from any backup or
/// support-bundle sweep, and logged by PATH only — never by contents (§8.5).
pub fn default_profile_dir() -> PathBuf {
    if let Some(p) = std::env::var_os(ENV_PROFILE_DIR) {
        return PathBuf::from(p);
    }
    let base = std::env::var_os("SUPERMUX_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            dirs::home_dir()
                .unwrap_or_else(|| PathBuf::from("/"))
                .join(".supermux")
        });
    base.join("browser").join("profile")
}

/// The profile dir for an ALREADY-RESOLVED data dir.
///
/// [`default_profile_dir`] re-reads the environment, which is right for a
/// standalone `BrowserConfig::default()` and **wrong** for the running server:
/// `config.data_dir` is the resolved answer (env → `config.toml` → `$HOME`), and
/// a test harness with its own temp data dir must land its profile there rather
/// than in the live one. The explicit [`ENV_PROFILE_DIR`] override still wins.
pub fn profile_dir_for(data_dir: &std::path::Path) -> PathBuf {
    if let Some(p) = std::env::var_os(ENV_PROFILE_DIR) {
        return PathBuf::from(p);
    }
    data_dir.join("browser").join("profile")
}

impl Default for BrowserConfig {
    fn default() -> Self {
        Self {
            executable: launch::default_executable(),
            ld_library_path: launch::default_ld_library_path(),
            width: 1366,
            height: 900,
            max_contexts: DEFAULT_MAX_CONTEXTS,
            max_tabs: DEFAULT_MAX_TABS,
            profile: ProfileMode::Durable(default_profile_dir()),
            idle_timeout: DEFAULT_IDLE_TIMEOUT,
        }
    }
}

impl BrowserConfig {
    /// [`from_env`](Self::from_env) with the durable profile pinned under an
    /// already-resolved `data_dir` — what the server actually constructs.
    pub fn for_data_dir(data_dir: &std::path::Path) -> Self {
        let mut cfg = Self::from_env();
        cfg.profile = ProfileMode::Durable(profile_dir_for(data_dir));
        cfg
    }

    /// [`Default`] with the documented env overrides applied.
    pub fn from_env() -> Self {
        let mut cfg = Self::default();
        if let Ok(v) = std::env::var(ENV_MAX_CONTEXTS) {
            if let Ok(n) = v.trim().parse::<usize>() {
                if n > 0 {
                    cfg.max_contexts = n;
                }
            }
        }
        if let Ok(v) = std::env::var(ENV_MAX_TABS) {
            if let Ok(n) = v.trim().parse::<usize>() {
                if n > 0 {
                    cfg.max_tabs = n;
                }
            }
        }
        if let Ok(v) = std::env::var(ENV_IDLE_MINUTES) {
            if let Ok(n) = v.trim().parse::<u64>() {
                cfg.idle_timeout = Duration::from_secs(n * 60);
            }
        }
        cfg
    }
}

/// Everything that exists only while chrome is running.
///
/// **Two registries, one browser** (v1 §2.3 R2). The split IS the feature: a
/// scratch context is keyed on a *session name* and dies with that session; a
/// workspace tab is keyed on a *durable tab id* and outlives everything,
/// including this struct.
struct Running {
    chrome: ChromeProcess,
    client: Arc<CdpClient>,
    /// LIVE workspace tabs. A dehydrated tab is absent here and present in
    /// `browser_tabs` — that asymmetry is the whole persistence design.
    tabs: HashMap<TabId, Arc<Tab>>,
    /// Per-session scratch contexts — today's map, renamed, same semantics.
    scratch: HashMap<String, Arc<AgentContext>>,
    /// When the registries last became idle (`None` while something is live).
    idle_since: Option<Instant>,
}

/// The server-held browser service. One per process, in
/// [`crate::state::AppState`].
pub struct BrowserService {
    cfg: BrowserConfig,
    running: Mutex<Option<Running>>,
    /// The DB handle, attached by [`crate::state::AppState`] right after
    /// construction. `OnceLock` rather than a constructor argument so
    /// [`BrowserService::new`] stays the allocation-only call the lazy-start
    /// invariant depends on, and so every existing test constructs unchanged.
    /// Absent ⇒ the tab surface is simply unavailable (scratch is untouched).
    pool: std::sync::OnceLock<sqlx::SqlitePool>,
    /// Guards the one-time spawn of the signal hook + idle reaper. Both are
    /// installed on the first successful chrome launch and never again.
    background: Once,
}

impl std::fmt::Debug for BrowserService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BrowserService")
            .field("executable", &self.cfg.executable)
            .field("max_contexts", &self.cfg.max_contexts)
            .finish()
    }
}

impl BrowserService {
    /// Build the service. **Spawns nothing** — see the module docs on lazy
    /// start. Cheap enough to call unconditionally from `AppState::new`.
    pub fn new(cfg: BrowserConfig) -> Arc<Self> {
        Arc::new(Self {
            cfg,
            running: Mutex::new(None),
            pool: std::sync::OnceLock::new(),
            background: Once::new(),
        })
    }

    /// Hand the service its DB pool. Idempotent; a second call is ignored.
    ///
    /// Only the **tab** surface needs it (rows, grants, and persisting a tab's
    /// URL before it is dehydrated). Scratch mode never touches the DB, so a
    /// service without a pool behaves exactly as it did before v1.
    pub fn attach_pool(&self, pool: sqlx::SqlitePool) {
        let _ = self.pool.set(pool);
    }

    fn pool(&self) -> Option<&sqlx::SqlitePool> {
        self.pool.get()
    }

    /// The effective configuration.
    pub fn config(&self) -> &BrowserConfig {
        &self.cfg
    }

    /// Is a chrome process live right now?
    pub async fn is_running(&self) -> bool {
        self.running.lock().await.is_some()
    }

    /// PID of the running browser, if any. Exposed for the leak test and for
    /// operational diagnostics.
    pub async fn chrome_pid(&self) -> Option<u32> {
        self.running.lock().await.as_ref().map(|r| r.chrome.pid())
    }

    /// The running browser's profile dir, if any. Exposed so the leak test can
    /// assert an EPHEMERAL one is gone after shutdown, and so the persistence
    /// test can assert a DURABLE one is still there.
    pub async fn user_data_dir(&self) -> Option<PathBuf> {
        self.running
            .lock()
            .await
            .as_ref()
            .map(|r| r.chrome.user_data_dir().to_path_buf())
    }

    /// Sessions that currently hold a scratch context.
    pub async fn sessions(&self) -> Vec<String> {
        match self.running.lock().await.as_ref() {
            Some(r) => {
                let mut v: Vec<String> = r.scratch.keys().cloned().collect();
                v.sort();
                v
            }
            None => Vec::new(),
        }
    }

    /// Ids of the workspace tabs that are LIVE right now (a subset of the
    /// `browser_tabs` rows — the rest are dehydrated).
    pub async fn live_tabs(&self) -> Vec<String> {
        match self.running.lock().await.as_ref() {
            Some(r) => {
                let mut v: Vec<String> = r.tabs.keys().cloned().collect();
                v.sort();
                v
            }
            None => Vec::new(),
        }
    }

    /// How many workspace tabs are live.
    pub async fn tab_count(&self) -> usize {
        self.running
            .lock()
            .await
            .as_ref()
            .map(|r| r.tabs.len())
            .unwrap_or(0)
    }

    /// How many persisted tabs currently have **no** live target — the companion
    /// observable to [`idle_armed`](Self::idle_armed): a reap that "loses" tabs
    /// would show up here as rows that never come back.
    pub async fn dehydrated_tab_count(&self) -> usize {
        let Some(pool) = self.pool() else { return 0 };
        let rows = db_tabs::list(pool).await.unwrap_or_default();
        let live = self.live_tabs().await;
        rows.iter().filter(|r| !live.contains(&r.id)).count()
    }

    // ── the registry ────────────────────────────────────────────────────────

    /// Get (or create) `session`'s isolated browser context, starting chrome on
    /// first use. **Idempotent**: a second call for the same session returns
    /// the same `Arc`, it does not create a second context.
    ///
    /// The context lives until the session ends — see [`dispose_on_teardown`],
    /// which is what makes the cap below a cap on LIVE contexts rather than a
    /// lifetime budget, and what keeps a recycled session name from finding the
    /// previous occupant's still-logged-in page.
    pub async fn context_for(self: &Arc<Self>, session: &str) -> Result<Arc<AgentContext>> {
        let mut guard = self.running.lock().await;

        // Relaunch if a previous chrome died under us.
        if let Some(r) = guard.as_ref() {
            if r.client.is_closed() || !r.chrome.is_alive() {
                warn!("browser: chrome died; relaunching on demand");
                if let Some(dead) = guard.take() {
                    dead.chrome.shutdown().await;
                }
            }
        }

        if guard.is_none() {
            *guard = Some(self.start_locked().await?);
        }
        let running = guard.as_mut().expect("just started");

        if let Some(existing) = running.scratch.get(session) {
            return Ok(existing.clone());
        }
        if running.scratch.len() >= self.cfg.max_contexts {
            return Err(BrowserError::TooManyContexts {
                max: self.cfg.max_contexts,
            });
        }

        let ctx = Arc::new(
            AgentContext::create(
                running.client.clone(),
                session,
                self.cfg.width,
                self.cfg.height,
            )
            .await?,
        );
        info!(
            session,
            browser_context = ?ctx.browser_context_id(),
            "browser: scratch context created"
        );
        running.scratch.insert(session.to_string(), ctx.clone());
        running.idle_since = None;
        Ok(ctx)
    }

    /// Look up an existing context **without** creating one (and without
    /// starting chrome). Used by the lock API and by phase 2's UI.
    pub async fn context(&self, session: &str) -> Option<Arc<AgentContext>> {
        self.running
            .lock()
            .await
            .as_ref()
            .and_then(|r| r.scratch.get(session).cloned())
    }

    /// How many contexts are live right now. This is the number
    /// [`BrowserConfig::max_contexts`] caps, so a teardown path that forgets to
    /// call [`close_context`](Self::close_context) shows up here as a count that
    /// only ever grows.
    pub async fn context_count(&self) -> usize {
        self.running
            .lock()
            .await
            .as_ref()
            .map(|r| r.scratch.len())
            .unwrap_or(0)
    }

    /// Is the idle reaper's clock armed (nothing live, waiting to time out)?
    /// The reaper can only fire while this is true, so it is the observable
    /// behind "the reaper is not defeated".
    ///
    /// **Unchanged in meaning, widened in scope:** a live workspace tab now also
    /// disarms it. A tab is not *lost* by a reap — it is dehydrated (R4) — but a
    /// tab someone is actually driving must not have chrome pulled out from
    /// under it, so it counts as activity while it is live.
    pub async fn idle_armed(&self) -> bool {
        self.running
            .lock()
            .await
            .as_ref()
            .map(|r| r.idle_since.is_some() && r.scratch.is_empty() && r.tabs.is_empty())
            .unwrap_or(false)
    }

    /// Close one session's **scratch** context and dispose it browser-side.
    /// Disposing one context provably leaves its siblings responsive.
    ///
    /// It can no longer reach the tab map — that is R3 in one method: a session
    /// ending must never close a workspace tab, pinned or not.
    pub async fn close_scratch(&self, session: &str) -> Result<()> {
        let mut guard = self.running.lock().await;
        let Some(running) = guard.as_mut() else {
            return Err(BrowserError::NoSuchContext(session.to_string()));
        };
        let Some(ctx) = running.scratch.remove(session) else {
            return Err(BrowserError::NoSuchContext(session.to_string()));
        };
        if running.scratch.is_empty() && running.tabs.is_empty() {
            running.idle_since = Some(Instant::now());
        }
        drop(guard);
        ctx.close().await;
        info!(session, "browser: scratch context closed");
        Ok(())
    }

    /// The pre-v1 name for [`close_scratch`](Self::close_scratch). Kept because
    /// every caller of it always meant "scratch" — the rename is a clarification,
    /// not a behaviour change.
    pub async fn close_context(&self, session: &str) -> Result<()> {
        self.close_scratch(session).await
    }

    // ── the workspace tab registry (shared-browser v1) ──────────────────────

    /// A LIVE tab, without creating one and **without starting chrome**.
    ///
    /// Deliberately non-spawning, exactly like [`context`](Self::context): the
    /// takeover socket takes over something that already exists, and an
    /// unauthorised surface must never be able to spawn a browser.
    pub async fn tab(&self, tab_id: &str) -> Option<Arc<Tab>> {
        self.running
            .lock()
            .await
            .as_ref()
            .and_then(|r| r.tabs.get(tab_id).cloned())
    }

    /// **Get or rehydrate** a workspace tab, starting chrome on first use.
    ///
    /// Idempotent: a second call for the same id returns the same `Arc`. A tab
    /// that was dehydrated (or lost to a crash / a restart) is re-opened at
    /// `meta.url` in the DEFAULT context — the profile is on disk, so the cookies
    /// are simply there and the login comes back with the page.
    ///
    /// Lazy start is preserved: nothing here runs until somebody with a grant
    /// actually asks for a tab.
    pub async fn ensure_tab(self: &Arc<Self>, tab_id: &str, meta: TabMeta) -> Result<Arc<Tab>> {
        if !db_tabs::valid_tab_id(tab_id) {
            return Err(BrowserError::NoSuchTab(tab_id.to_string()));
        }
        let mut guard = self.running.lock().await;

        // Relaunch if a previous chrome died under us (same policy as scratch).
        if let Some(r) = guard.as_ref() {
            if r.client.is_closed() || !r.chrome.is_alive() {
                warn!("browser: chrome died; relaunching on demand");
                if let Some(dead) = guard.take() {
                    dead.chrome.shutdown().await;
                }
            }
        }
        if guard.is_none() {
            *guard = Some(self.start_locked().await?);
        }
        let running = guard.as_mut().expect("just started");

        if let Some(existing) = running.tabs.get(tab_id) {
            running.idle_since = None;
            return Ok(existing.clone());
        }
        if running.tabs.len() >= self.cfg.max_tabs {
            return Err(BrowserError::TooManyTabs {
                max: self.cfg.max_tabs,
            });
        }

        let url = if meta.url.trim().is_empty() {
            "about:blank"
        } else {
            meta.url.as_str()
        };
        // The lock subject is the TAB id, not a session name — one lock per tab.
        let page = Arc::new(
            AgentContext::create_in_default_context(
                running.client.clone(),
                tab_id,
                self.cfg.width,
                self.cfg.height,
                url,
            )
            .await?,
        );
        let tab = Arc::new(Tab::new(tab_id.to_string(), page, meta));
        info!(
            tab = tab_id,
            target = %tab.page().target_id(),
            "browser: workspace tab live"
        );
        // Every live tab gets the nav-state write-through, viewer or no viewer
        // (P1-5). An agent driving a tab nobody is watching is exactly the case
        // the stale-URL bug was worst in.
        if let Some(writer) = self.spawn_nav_write_through(&tab).await {
            tab.set_nav_writer(writer);
        }
        running.tabs.insert(tab_id.to_string(), tab.clone());
        running.idle_since = None;
        Ok(tab)
    }

    /// Follow a live tab's nav state and write `url`/`title` back to
    /// `browser_tabs`, debounced by [`NAV_WRITE_DEBOUNCE`].
    ///
    /// **This is what kills the stale-URL bug for good.** Before it the row
    /// learned a page's address exactly twice — at a clean dehydrate, and at a
    /// human REST verb — so the workspace list showed where a tab *had been*,
    /// and a crash-recovery rehydrate landed on the page the human left rather
    /// than the one they were on.
    ///
    /// It holds only `Weak` handles: a write-through task must never be the
    /// reason a tab (or the whole service) stays alive.
    async fn spawn_nav_write_through(self: &Arc<Self>, tab: &Arc<Tab>) -> Option<JoinHandle<()>> {
        let mut rx = tab.page().watch_nav().await.ok()?;
        let service = Arc::downgrade(self);
        let handle = Arc::downgrade(tab);
        Some(tokio::spawn(async move {
            while let Some(state) = settled_nav(&mut rx, NAV_WRITE_DEBOUNCE).await {
                if !worth_writing(&state) {
                    continue;
                }
                let (Some(service), Some(tab)) = (service.upgrade(), handle.upgrade()) else {
                    return;
                };
                tab.set_location(state.url.clone(), state.title.clone()).await;
                let Some(pool) = service.pool() else { continue };
                let patch = db_tabs::TabPatch {
                    url: Some(state.url),
                    title: Some(state.title),
                    ..Default::default()
                };
                if let Err(e) = db_tabs::update(pool, tab.id(), &patch).await {
                    warn!(tab = tab.id(), error = %e, "browser: nav write-through");
                }
            }
        }))
    }

    /// **Dehydrate** a tab: persist where it was, close its target, forget it.
    /// The `browser_tabs` row — and the profile's cookies — are untouched, so
    /// the next [`ensure_tab`](Self::ensure_tab) restores it losslessly.
    ///
    /// `Ok(false)` when the tab was not live (already dehydrated); that is a
    /// normal state, not an error.
    pub async fn dehydrate_tab(&self, tab_id: &str) -> Result<bool> {
        let taken = {
            let mut guard = self.running.lock().await;
            let Some(running) = guard.as_mut() else {
                return Ok(false);
            };
            let taken = running.tabs.remove(tab_id);
            if running.scratch.is_empty() && running.tabs.is_empty() {
                running.idle_since = Some(Instant::now());
            }
            taken
        };
        let Some(tab) = taken else { return Ok(false) };
        self.persist_location(&tab).await;
        tab.close().await;
        info!(tab = tab_id, "browser: tab dehydrated (row + cookies kept)");
        Ok(true)
    }

    /// Read the page's real URL/title and write them through to `browser_tabs`,
    /// so a rehydrate reopens where the human actually was.
    async fn persist_location(&self, tab: &Arc<Tab>) {
        let url = tab.page().current_url().await.unwrap_or_default();
        let title = tab
            .page()
            .evaluate("document.title")
            .await
            .ok()
            .and_then(|v| v.as_str().map(str::to_string))
            .unwrap_or_default();
        // `about:blank` is not a location — it is the absence of one. Writing it
        // through would erase where the human actually was and make the next
        // rehydrate land on a blank page (`tools::landing_drift` treats it the
        // same way: no host, no claim).
        if url.is_empty() || url == "about:blank" {
            return;
        }
        tab.set_location(url.clone(), title.clone()).await;
        let Some(pool) = self.pool() else { return };
        let patch = db_tabs::TabPatch {
            url: Some(url),
            title: Some(title),
            ..Default::default()
        };
        if let Err(e) = db_tabs::update(pool, tab.id(), &patch).await {
            warn!(tab = tab.id(), error = %e, "browser: could not persist tab location");
        }
    }

    /// Dehydrate every live tab (the reaper's first step, and the shutdown path's).
    async fn dehydrate_all_tabs(&self) {
        for id in self.live_tabs().await {
            let _ = self.dehydrate_tab(&id).await;
        }
    }

    // ── the AGENT/HUMAN lock, service-level ─────────────────────────────────

    /// **The human grabs the wheel** for `session`. Returns the previous mode.
    ///
    /// Phase 2 additionally pauses the agent's pty here; the lock itself — the
    /// part that makes agent input impossible — is complete now.
    pub async fn request_human_takeover(&self, session: &str) -> Result<DriveMode> {
        let ctx = self
            .context(session)
            .await
            .ok_or_else(|| BrowserError::NoSuchContext(session.to_string()))?;
        let previous = ctx.lock().request_human_takeover();
        info!(session, %previous, "browser: HUMAN takeover");
        Ok(previous)
    }

    /// **The wheel goes back to the agent**, recording how (see
    /// [`HandOff`]). Returns the previous mode.
    pub async fn release_to_agent(&self, session: &str, handoff: HandOff) -> Result<DriveMode> {
        let ctx = self
            .context(session)
            .await
            .ok_or_else(|| BrowserError::NoSuchContext(session.to_string()))?;
        let previous = ctx.lock().release_to_agent(handoff);
        info!(session, %previous, "browser: released to AGENT");
        Ok(previous)
    }

    /// Current drive mode for a session's scratch context.
    pub async fn mode(&self, session: &str) -> Result<DriveMode> {
        self.context(session)
            .await
            .map(|c| c.mode())
            .ok_or_else(|| BrowserError::NoSuchContext(session.to_string()))
    }

    /// **The human grabs the wheel on one TAB.** Tab-scoped sibling of
    /// [`request_human_takeover`](Self::request_human_takeover); the
    /// session-scoped one stays for scratch.
    pub async fn request_human_takeover_tab(&self, tab_id: &str) -> Result<DriveMode> {
        let tab = self
            .tab(tab_id)
            .await
            .ok_or_else(|| BrowserError::NoSuchTab(tab_id.to_string()))?;
        let previous = tab.lock().request_human_takeover();
        info!(tab = tab_id, %previous, "browser: HUMAN takeover (tab)");
        Ok(previous)
    }

    /// The wheel goes back to the agent on one tab.
    pub async fn release_tab_to_agent(&self, tab_id: &str, handoff: HandOff) -> Result<DriveMode> {
        let tab = self
            .tab(tab_id)
            .await
            .ok_or_else(|| BrowserError::NoSuchTab(tab_id.to_string()))?;
        let previous = tab.lock().release_to_agent(handoff);
        info!(tab = tab_id, %previous, "browser: tab released to AGENT");
        Ok(previous)
    }

    /// Current drive mode for one tab.
    pub async fn tab_mode(&self, tab_id: &str) -> Result<DriveMode> {
        self.tab(tab_id)
            .await
            .map(|t| t.mode())
            .ok_or_else(|| BrowserError::NoSuchTab(tab_id.to_string()))
    }

    // ── lifecycle ───────────────────────────────────────────────────────────

    /// Launch chrome + connect CDP. Caller holds the `running` lock.
    async fn start_locked(self: &Arc<Self>) -> Result<Running> {
        let chrome = ChromeProcess::launch(
            &self.cfg.executable,
            self.cfg.ld_library_path.as_deref(),
            self.cfg.width,
            self.cfg.height,
            &self.cfg.profile,
        )
        .await?;
        // From here `chrome` owns its own teardown: if the CDP connect fails,
        // dropping it kills the group and removes the profile.
        let client = CdpClient::connect(chrome.ws_url()).await?;

        // Install the process-lifetime background tasks exactly once, and only
        // now that a browser really exists (see module docs: a server with no
        // browser use installs no signal handler).
        let weak = Arc::downgrade(self);
        self.background.call_once(|| {
            install_signal_hook(weak.clone());
            spawn_idle_reaper(weak, self.cfg.idle_timeout);
        });

        // **Reconcile** (§4.2). A durable profile's session-restore can resurrect
        // page targets we know nothing about; a live set larger than the set
        // supermux believes in is how a tab registry silently desyncs. Close any
        // orphan page target now, while there is provably nothing of ours to hit
        // (both registries are empty at this point, by construction).
        reconcile_orphan_targets(&client).await;

        Ok(Running {
            chrome,
            client,
            tabs: HashMap::new(),
            scratch: HashMap::new(),
            idle_since: Some(Instant::now()),
        })
    }

    /// Tear everything down: dispose every context, ask chrome to exit over
    /// CDP, then kill the process group and remove the profile dir.
    ///
    /// Idempotent and infallible — a second call on an already-stopped service
    /// is a no-op. After it returns, `kill(pid, 0)` on the old pid fails and
    /// the `--user-data-dir` is gone (asserted by the leak test).
    pub async fn shutdown(&self) {
        let taken = self.running.lock().await.take();
        let Some(mut running) = taken else { return };
        let pid = running.chrome.pid();

        // 1. Best-effort per-context disposal, bounded. Tabs are dropped from
        //    the registry WITHOUT `disposeBrowserContext` (there is none to
        //    dispose) — their rows and their cookies are on disk and outlive
        //    this process entirely, which is the point.
        let contexts: Vec<Arc<AgentContext>> = running.scratch.drain().map(|(_, c)| c).collect();
        let tabs: Vec<Arc<Tab>> = running.tabs.drain().map(|(_, t)| t).collect();
        let _ = tokio::time::timeout(CONTEXT_DRAIN_BUDGET, async {
            for ctx in contexts {
                ctx.close().await;
            }
            for tab in tabs {
                tab.close().await;
            }
        })
        .await;

        // 2. Graceful CDP exit. The response never arrives — the socket dies as
        //    a consequence — so the error/timeout here is the success signal.
        let _ = tokio::time::timeout(
            BROWSER_CLOSE_BUDGET,
            running.client.call("Browser.close", serde_json::json!({})),
        )
        .await;
        running.client.close().await;

        // 3. Verify + escalate + remove the profile dir.
        running.chrome.shutdown().await;
        info!(pid, "browser: service shut down");
    }
}

impl Drop for BrowserService {
    /// Last-ditch synchronous backstop. The real teardown is
    /// [`BrowserService::shutdown`] (async, graceful); this only exists so that
    /// dropping the service without calling it still cannot leak — the inner
    /// [`ChromeProcess`]'s own `Drop` does the group kill and the rmdir.
    fn drop(&mut self) {
        if let Ok(mut guard) = self.running.try_lock() {
            if guard.take().is_some() {
                warn!(
                    "browser: service dropped without shutdown() — ChromeProcess::drop cleans up"
                );
            }
        }
    }
}

/// Close any page target Chrome brought back on its own.
///
/// A durable `--user-data-dir` means Chrome may restore the previous run's tabs.
/// Those targets are not in our registry, would never be closed, and would count
/// against nothing — a slow leak of authenticated pages nobody can see. Called
/// once per launch, before either registry has an entry, so every page target
/// found here is by definition an orphan.
///
/// Best-effort and non-fatal: a browser that will not enumerate its targets is
/// not a reason to refuse to start.
async fn reconcile_orphan_targets(client: &Arc<CdpClient>) {
    let Ok(v) = client.call("Target.getTargets", serde_json::json!({})).await else {
        return;
    };
    let Some(infos) = v.get("targetInfos").and_then(|t| t.as_array()) else {
        return;
    };
    for info in infos {
        if info.get("type").and_then(|t| t.as_str()) != Some("page") {
            continue;
        }
        let Some(target_id) = info.get("targetId").and_then(|t| t.as_str()) else {
            continue;
        };
        warn!(
            target = target_id,
            url = info.get("url").and_then(|u| u.as_str()).unwrap_or(""),
            "browser: closing a target restored by the durable profile"
        );
        let _ = client
            .call(
                "Target.closeTarget",
                serde_json::json!({ "targetId": target_id }),
            )
            .await;
    }
}

/// **Drop `session`'s SCRATCH browser context because the session is going away.**
///
/// Wired into every session-teardown path (`SessionEnd` hook, `lifecycle::stop`,
/// delete/archive via `AppState::forget_session`, and rename). Without it a
/// context created on an agent's first tool call lived until the process
/// exited, which leaked three ways:
///
/// 1. **The cap became a lifetime budget.** [`BrowserConfig::max_contexts`]
///    counts live contexts and nothing ever decremented it, so the 9th distinct
///    granted session was refused a context forever.
/// 2. **The idle reaper was defeated.** It only fires while the context map is
///    empty; a map that never shrinks never empties again, so chrome stayed
///    resident (and growing) for the life of the server — on a box with a
///    documented chrome-leak history.
/// 3. **Dead agents' pages stayed logged in.** A context holds whatever the
///    agent signed into; disposing it on session end is also why a recycled
///    session name finds nothing to inherit.
///
/// **It cannot reach a workspace tab** (v1 §2.3 R3). All three leaks above are
/// about *scratch* contexts; a session ending closing a tab a human pinned and
/// logged into would be the precise anti-goal of the feature. The one-word
/// change is the call below: [`BrowserService::close_scratch`].
///
/// Fire-and-forget and bounded: teardown must never block on CDP, and a session
/// that never used the browser is the common case — its `NoSuchContext` is
/// silent, not an error. Returns the spawned task so a test can await the
/// disposal it just triggered; `None` only outside a tokio runtime.
pub fn dispose_on_teardown(
    browser: &Arc<BrowserService>,
    session: &str,
) -> Option<tokio::task::JoinHandle<()>> {
    let handle = tokio::runtime::Handle::try_current().ok()?;
    let browser = browser.clone();
    let session = session.to_string();
    Some(handle.spawn(async move {
        match tokio::time::timeout(TEARDOWN_BUDGET, browser.close_scratch(&session)).await {
            // The common case: this session never opened a browser.
            Ok(Err(BrowserError::NoSuchContext(_))) => {}
            Ok(Err(e)) => warn!(session, error = %e, "browser: teardown disposal failed"),
            Ok(Ok(())) => info!(session, "browser: context disposed on session teardown"),
            Err(_) => warn!(session, "browser: teardown disposal timed out"),
        }
    }))
}

/// SIGTERM/SIGINT → tear the browser down, then exit.
///
/// **Only installed once a chrome process actually exists.** `std::process::exit`
/// (and the default signal disposition) do not run destructors, so without this
/// a `systemctl restart` would orphan the browser tree. Exiting 0 matches the
/// prior default disposition from systemd's point of view.
fn install_signal_hook(weak: Weak<BrowserService>) {
    tokio::spawn(async move {
        use tokio::signal::unix::{signal, SignalKind};
        let mut term = match signal(SignalKind::terminate()) {
            Ok(s) => s,
            Err(e) => {
                warn!(error = %e, "browser: could not hook SIGTERM");
                return;
            }
        };
        let mut int = match signal(SignalKind::interrupt()) {
            Ok(s) => s,
            Err(e) => {
                warn!(error = %e, "browser: could not hook SIGINT");
                return;
            }
        };
        let sig = tokio::select! {
            _ = term.recv() => "SIGTERM",
            _ = int.recv() => "SIGINT",
        };
        info!(signal = sig, "browser: tearing down chrome before exit");
        if let Some(svc) = weak.upgrade() {
            svc.shutdown().await;
        }
        std::process::exit(0);
    });
}

/// Close the browser after [`BrowserConfig::idle_timeout`] with nothing live.
///
/// Lives for the process lifetime (it exits when the service is dropped) and
/// is a no-op while chrome is not running, so a reaped browser simply
/// relaunches on the next [`BrowserService::context_for`] /
/// [`BrowserService::ensure_tab`].
///
/// # Dehydration, not eviction (v1 §2.3 R4)
///
/// Pinning chrome alive forever to protect tabs would re-introduce the very leak
/// this reaper exists to close — on a box with a documented chrome-leak history,
/// and at ~844 MB idle. So the reaper still fires; it just cannot LOSE anything:
/// every live tab has its URL and title persisted and its target closed, the row
/// stays, and the cookies stay in the profile on disk. The next access relaunches
/// chrome, reopens the stored URL, and the login is simply there.
///
/// A live tab still *disarms* the clock while it is live (see
/// [`BrowserService::idle_armed`]) — dehydrating a page a human is looking at
/// would be correct-but-rude.
fn spawn_idle_reaper(weak: Weak<BrowserService>, idle_timeout: Duration) {
    if idle_timeout.is_zero() {
        info!("browser: idle reaper disabled");
        return;
    }
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(REAPER_INTERVAL).await;
            let Some(svc) = weak.upgrade() else { return };
            let expired = {
                let guard = svc.running.lock().await;
                match guard.as_ref() {
                    Some(r) => r
                        .idle_since
                        .map(|t| {
                            r.scratch.is_empty() && r.tabs.is_empty() && t.elapsed() >= idle_timeout
                        })
                        .unwrap_or(false),
                    None => false,
                }
            };
            if expired {
                info!(?idle_timeout, "browser: idle — reaping chrome");
                // Belt and braces: the clock only arms with an empty tab map, but
                // a tab that went live in the same tick must be persisted, not
                // dropped on the floor.
                svc.dehydrate_all_tabs().await;
                svc.shutdown().await;
            }
        }
    });
}


/// Wait for a nav feed to go **quiet** for `debounce`, then hand back the state
/// it landed on. `None` ⇒ the watcher is gone, and so is the page.
///
/// Split out of [`BrowserService::spawn_nav_write_through`] so the debounce — the
/// part with an off-by-one-window failure mode nobody would notice until the tab
/// list was wrong again — is testable with a plain channel and a paused clock.
async fn settled_nav(rx: &mut watch::Receiver<NavState>, debounce: Duration) -> Option<NavState> {
    rx.changed().await.ok()?;
    loop {
        match tokio::time::timeout(debounce, rx.changed()).await {
            // Still moving — restart the quiet window.
            Ok(Ok(())) => continue,
            // The watcher is gone.
            Ok(Err(_)) => return None,
            // A full window of quiet. This is the landing.
            Err(_) => break,
        }
    }
    Some(rx.borrow_and_update().clone())
}

/// Is this settled state worth committing to `browser_tabs`?
///
/// `about:blank` is not a location, it is the ABSENCE of one — the same rule
/// [`BrowserService::persist_location`] applies, and for the same reason:
/// writing it through erases where the human actually was and makes the next
/// rehydrate land on a blank page. A state still `loading` is a hop, not a
/// landing, and the debounce alone cannot tell them apart when a page is slow.
fn worth_writing(state: &NavState) -> bool {
    !state.loading && !state.url.is_empty() && state.url != "about:blank"
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── P1-5: the write-through debounce ────────────────────────────────────

    fn at(url: &str) -> NavState {
        NavState {
            url: url.to_string(),
            title: format!("title of {url}"),
            ..NavState::default()
        }
    }

    #[tokio::test(start_paused = true)]
    async fn the_write_through_commits_the_landing_not_every_redirect_hop() {
        // A redirect chain publishes several nav states and lands on one.
        // Writing each hop would leave an interstitial — very often a login
        // wall — sitting in the human's tab list for whoever looked in the
        // wrong second.
        let (tx, mut rx) = watch::channel(NavState::default());
        let hops = tokio::spawn(async move {
            for url in ["https://a.test/", "https://a.test/sso", "https://a.test/app"] {
                tx.send_replace(at(url));
                tokio::time::sleep(NAV_WRITE_DEBOUNCE / 2).await;
            }
            // Hold the sender so the channel does not close under the reader.
            tokio::time::sleep(NAV_WRITE_DEBOUNCE * 4).await;
        });

        let landed = settled_nav(&mut rx, NAV_WRITE_DEBOUNCE)
            .await
            .expect("a landing");
        assert_eq!(landed.url, "https://a.test/app", "only the landing is written");
        hops.await.unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn a_quiet_page_lands_once_and_then_waits() {
        let (tx, mut rx) = watch::channel(NavState::default());
        tx.send_replace(at("https://a.test/one"));
        let first = settled_nav(&mut rx, NAV_WRITE_DEBOUNCE).await.expect("first");
        assert_eq!(first.url, "https://a.test/one");

        // No further change ⇒ the writer parks on `changed()` rather than
        // re-committing the same row every debounce window.
        let idle = tokio::time::timeout(
            NAV_WRITE_DEBOUNCE * 5,
            settled_nav(&mut rx, NAV_WRITE_DEBOUNCE),
        )
        .await;
        assert!(idle.is_err(), "a settled page must not keep writing");

        tx.send_replace(at("https://a.test/two"));
        let second = settled_nav(&mut rx, NAV_WRITE_DEBOUNCE).await.expect("second");
        assert_eq!(second.url, "https://a.test/two");
    }

    #[tokio::test(start_paused = true)]
    async fn a_dead_watcher_ends_the_writer_instead_of_spinning() {
        let (tx, mut rx) = watch::channel(NavState::default());
        drop(tx);
        assert!(settled_nav(&mut rx, NAV_WRITE_DEBOUNCE).await.is_none());
    }

    #[test]
    fn a_blank_or_in_flight_page_is_never_written_through() {
        // `about:blank` is the ABSENCE of a location: writing it through would
        // erase where the human actually was and make the next rehydrate land
        // on a blank page — the same rule `persist_location` applies.
        assert!(!worth_writing(&NavState::default()));
        assert!(!worth_writing(&at("about:blank")));
        assert!(!worth_writing(&NavState {
            loading: true,
            ..at("https://a.test/half-loaded")
        }));
        assert!(worth_writing(&at("https://a.test/")));
    }

    #[tokio::test]
    async fn new_spawns_nothing() {
        // The byte-identical-launch invariant: constructing the service must
        // not start a browser, install a handler, or touch the filesystem.
        let svc = BrowserService::new(BrowserConfig::default());
        assert!(!svc.is_running().await);
        assert_eq!(svc.chrome_pid().await, None);
        assert!(svc.sessions().await.is_empty());
        assert!(svc.user_data_dir().await.is_none());
    }

    #[tokio::test]
    async fn shutdown_without_start_is_a_noop() {
        let svc = BrowserService::new(BrowserConfig::default());
        svc.shutdown().await;
        svc.shutdown().await;
        assert!(!svc.is_running().await);
    }

    #[tokio::test]
    async fn lock_api_needs_a_context() {
        let svc = BrowserService::new(BrowserConfig::default());
        let err = svc.request_human_takeover("nobody").await.unwrap_err();
        assert!(matches!(err, BrowserError::NoSuchContext(_)), "got {err:?}");
        let err = svc.mode("nobody").await.unwrap_err();
        assert!(matches!(err, BrowserError::NoSuchContext(_)), "got {err:?}");
        assert!(svc.context("nobody").await.is_none());
    }

    #[tokio::test]
    async fn missing_chrome_is_a_typed_error_and_leaves_nothing_running() {
        let svc = BrowserService::new(BrowserConfig {
            executable: PathBuf::from("/nonexistent/chrome-headless-shell"),
            ..BrowserConfig::default()
        });
        let err = svc.context_for("alice").await.unwrap_err();
        assert!(matches!(err, BrowserError::ChromeMissing(_)), "got {err:?}");
        assert!(!svc.is_running().await);
    }

    #[test]
    fn env_overrides_are_parsed() {
        // Parsing is what's under test; reading the process env is not, so the
        // vars are checked through the same code path with explicit values.
        let mut cfg = BrowserConfig::default();
        assert_eq!(cfg.max_contexts, DEFAULT_MAX_CONTEXTS);
        assert_eq!(cfg.idle_timeout, DEFAULT_IDLE_TIMEOUT);
        cfg.idle_timeout = Duration::from_secs(0);
        assert!(cfg.idle_timeout.is_zero(), "0 must disable the reaper");
    }

    #[test]
    fn defaults_are_conservative() {
        let cfg = BrowserConfig::default();
        assert!(cfg.max_contexts >= 1 && cfg.max_contexts <= 32);
        assert!(cfg.max_tabs >= cfg.max_contexts, "a workspace needs more room than scratch");
        assert!(cfg.idle_timeout >= Duration::from_secs(60));
        // Raised for v1: a login viewport, and a less unusual fingerprint.
        assert_eq!((cfg.width, cfg.height), (1366, 900));
        // The DEFAULT is the persistent workspace jar, living under the data dir
        // — never the repo checkout, never a worktree, never /tmp.
        match &cfg.profile {
            ProfileMode::Durable(dir) => {
                assert!(dir.ends_with("browser/profile"), "got {}", dir.display());
                assert!(
                    !dir.starts_with(std::env::temp_dir()),
                    "the durable profile must not live in temp: {}",
                    dir.display()
                );
            }
            other => panic!("the default profile must be Durable, got {other:?}"),
        }
    }

    /// A tab id that never passed the shape gate must not reach the registry —
    /// and must not start a browser on its way to being rejected.
    #[tokio::test]
    async fn a_malformed_tab_id_is_refused_without_spawning_anything() {
        let svc = BrowserService::new(BrowserConfig::default());
        for bad in ["", "alice", "tb_", "tb_../../etc", "tb_a b"] {
            let err = svc
                .ensure_tab(bad, TabMeta::default())
                .await
                .expect_err("must be refused");
            assert!(matches!(err, BrowserError::NoSuchTab(_)), "{bad}: {err:?}");
        }
        assert!(!svc.is_running().await, "no chrome may be spawned");
        assert_eq!(svc.tab_count().await, 0);
    }

    /// The tab-scoped lock API needs a LIVE tab, exactly as the session-scoped
    /// one needs a live context — and neither may spawn one to answer.
    #[tokio::test]
    async fn the_tab_lock_api_needs_a_live_tab() {
        let svc = BrowserService::new(BrowserConfig::default());
        let err = svc
            .request_human_takeover_tab("tb_nothinghere1")
            .await
            .unwrap_err();
        assert!(matches!(err, BrowserError::NoSuchTab(_)), "got {err:?}");
        let err = svc.tab_mode("tb_nothinghere1").await.unwrap_err();
        assert!(matches!(err, BrowserError::NoSuchTab(_)), "got {err:?}");
        assert!(svc.tab("tb_nothinghere1").await.is_none());
        // Dehydrating a tab that is not live is a normal state, not an error.
        assert!(!svc.dehydrate_tab("tb_nothinghere1").await.unwrap());
        assert!(!svc.is_running().await);
    }

    // ── FINDING 1: the registry's lifetime contract ─────────────────────────

    #[tokio::test]
    async fn closing_an_unknown_context_is_a_typed_error_not_a_panic() {
        // The teardown path fires for EVERY session, and almost none of them
        // ever opened a browser — that must be a quiet no-op.
        let svc = BrowserService::new(BrowserConfig::default());
        let err = svc.close_context("never-browsed").await.unwrap_err();
        assert!(matches!(err, BrowserError::NoSuchContext(_)), "got {err:?}");
        assert_eq!(svc.context_count().await, 0);
    }

    /// REAL-CHROME (FINDING 1). Two claims that only a live browser can settle:
    ///
    /// 1. **Disposal on session end.** `close_context` drops the live count and
    ///    RE-ARMS the idle reaper (which only fires on an empty map — the map
    ///    never emptying is what defeated it).
    /// 2. **No lifetime exhaustion.** With `max_contexts = 3`, nine sessions
    ///    that come and go all get a context; before the teardown wiring the 4th
    ///    distinct session was refused forever. The cap still holds for
    ///    SIMULTANEOUS contexts, which is what it is actually for.
    ///
    /// A recycled session name inherits nothing as a consequence of (1): by the
    /// time the name is reused there is no context left to find.
    #[tokio::test]
    #[ignore = "spawns a real chrome-headless-shell; run with --ignored on a box that has the pinned binary"]
    async fn real_chrome_contexts_are_disposed_and_the_cap_is_not_a_lifetime_budget() {
        fn pid_alive(pid: u32) -> bool {
            std::path::Path::new(&format!("/proc/{pid}")).exists()
        }

        let svc = BrowserService::new(BrowserConfig {
            max_contexts: 3,
            profile: ProfileMode::Ephemeral,
            ..BrowserConfig::default()
        });

        // ── 1. a context is disposed on session end ─────────────────────────
        svc.context_for("alice").await.expect("alice");
        let pid = svc.chrome_pid().await.expect("a chrome pid");
        assert_eq!(svc.context_count().await, 1);
        assert!(!svc.idle_armed().await, "a live context disarms the reaper");

        svc.close_context("alice").await.expect("dispose alice");
        assert_eq!(svc.context_count().await, 0, "the live count must DROP");
        assert!(svc.sessions().await.is_empty());
        assert!(
            svc.idle_armed().await,
            "the idle reaper must be re-armed once the last context goes"
        );

        // ── 2. nine sessions come and go under a cap of three ───────────────
        for i in 0..9 {
            let name = format!("bot-{i}");
            svc.context_for(&name)
                .await
                .unwrap_or_else(|e| panic!("session #{i} was refused a context: {e}"));
            assert_eq!(svc.context_count().await, 1, "one at a time, by construction");
            svc.close_context(&name).await.expect("dispose");
        }
        // …and the cap is still a REAL cap on SIMULTANEOUS contexts.
        for i in 0..3 {
            svc.context_for(&format!("sim-{i}"))
                .await
                .expect("under the cap");
        }
        let err = svc.context_for("sim-3").await.unwrap_err();
        assert!(
            matches!(err, BrowserError::TooManyContexts { max: 3 }),
            "got {err:?}"
        );

        svc.shutdown().await;
        for _ in 0..50 {
            if !pid_alive(pid) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert!(!pid_alive(pid), "LEAK: chrome pid {pid} still alive after shutdown");
    }

    /// REAL-CHROME end-to-end leak test (spec §13; this box has had chrome/rig
    /// leaks, so the persistent-shell service must prove clean teardown). Ignored
    /// by default — it spawns the pinned `chrome-headless-shell`. Run on a box that
    /// has it with: `cargo test -- --ignored real_chrome`. Proves the whole Phase-1
    /// contract against a live browser: one shell backs many isolated contexts, the
    /// lock flips + restores, and `shutdown()` leaves NO orphan process and removes
    /// the temporary user-data-dir.
    #[tokio::test]
    #[ignore = "spawns a real chrome-headless-shell; run with --ignored on a box that has the pinned binary"]
    async fn real_chrome_spawns_shares_and_tears_down_without_leak() {
        fn pid_alive(pid: u32) -> bool {
            std::path::Path::new(&format!("/proc/{pid}")).exists()
        }

        // **Explicitly ephemeral.** This test asserts the profile dir is REMOVED,
        // which is the scratch guarantee; the default is now the durable
        // workspace jar, whose whole job is to survive exactly this.
        let svc = BrowserService::new(BrowserConfig {
            profile: ProfileMode::Ephemeral,
            ..BrowserConfig::default()
        });
        // First context lazily spawns the single shell.
        svc.context_for("alice").await.expect("spawn + context alice");
        assert!(svc.is_running().await, "chrome should be running after context_for");
        let pid = svc.chrome_pid().await.expect("a chrome pid");
        let udd = svc.user_data_dir().await.expect("a user-data-dir");
        assert!(pid_alive(pid), "chrome pid {pid} must be alive while running");
        assert!(udd.exists(), "user-data-dir must exist while running");

        // A second context reuses the SAME shell (one process, isolated contexts).
        svc.context_for("bob").await.expect("context bob");
        assert_eq!(svc.chrome_pid().await, Some(pid), "second context must reuse the one shell");
        let mut names = svc.sessions().await;
        names.sort();
        assert_eq!(names, vec!["alice".to_string(), "bob".to_string()]);

        // The AGENT/HUMAN lock flips and restores. Each call returns the mode it
        // REPLACED (so a caller can tell a real takeover from a redundant click);
        // the resulting live mode is what we assert.
        assert_eq!(
            svc.request_human_takeover("alice").await.unwrap(),
            DriveMode::AgentDriving,
            "takeover returns the previous (resting) mode"
        );
        assert_eq!(svc.mode("alice").await.unwrap(), DriveMode::HumanDriving, "now HUMAN driving");
        assert_eq!(
            svc.release_to_agent("alice", HandOff::Explicit).await.unwrap(),
            DriveMode::HumanDriving,
            "release returns the previous (human) mode"
        );
        assert_eq!(svc.mode("alice").await.unwrap(), DriveMode::AgentDriving, "back to AGENT");

        // Teardown must leave nothing behind.
        svc.shutdown().await;
        assert!(!svc.is_running().await);
        assert_eq!(svc.chrome_pid().await, None);
        // Give the OS a beat to reap the process group, then assert it is truly gone.
        for _ in 0..50 {
            if !pid_alive(pid) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert!(!pid_alive(pid), "LEAK: chrome pid {pid} still alive after shutdown");
        assert!(!udd.exists(), "LEAK: user-data-dir {udd:?} must be removed on shutdown");
    }
}
