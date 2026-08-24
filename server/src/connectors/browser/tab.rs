//! **A workspace tab** — the human's persistent, authenticated surface, and the
//! unit an agent is granted (shared-browser v1 §4).
//!
//! ```text
//!   chrome (ONE process, ONE durable --user-data-dir)
//!     └── DEFAULT browser context          ← the profile IS the cookie jar
//!           ├── target ──▶ Tab { id:"tb_9f…", title, url, pinned, grants, lock }
//!           ├── target ──▶ Tab { … }
//!           └── target ──▶ Tab { … }
//! ```
//!
//! # A tab is durable; its target is not
//!
//! [`Tab::id`] is a `tb_<uuid>` minted once and stored in `browser_tabs`. The CDP
//! `targetId` underneath changes on **every** rehydrate, so nothing outside this
//! module may key on it. That split is the whole trick: the row survives a
//! dehydration, an idle reap, a Chrome crash and a `systemctl restart`, and
//! because the profile is on disk the login survives with it.
//!
//! # No page-driving logic lives here
//!
//! The page primitives — navigate / evaluate / click / input / the screencast
//! pump with its 2-frame ack accounting / screenshot — are
//! [`AgentContext`](super::context::AgentContext)'s, unchanged, and a tab simply
//! holds one opened in the DEFAULT context. There is exactly one implementation
//! of that code and v1 does not touch it.
//!
//! # One lock per tab
//!
//! [`Tab::lock`] is the existing [`DriveLock`](super::lock::DriveLock) with the
//! **tab id** as its subject. A human editing tab A therefore does not block a
//! granted agent on tab B — which the session-keyed cardinality could not
//! express.

use std::sync::Arc;

use tokio::sync::RwLock;

use super::context::AgentContext;
use super::lock::{DriveLock, DriveMode};

/// A durable tab id (`tb_<uuid-simple>`). Minted by
/// [`crate::db::browser_tabs::new_tab_id`].
pub type TabId = String;

/// The mutable half of a tab, mirroring its `browser_tabs` row. Kept in memory
/// so the hot path (a grant check, a chip repaint) does not hit SQLite, and
/// written through on every change that matters.
#[derive(Debug, Clone, Default)]
pub struct TabMeta {
    pub title: String,
    pub url: String,
    pub pinned: bool,
    /// Host rules (§8.4). Empty ⇒ **no** agent navigation off-host: fail closed.
    pub origins: Vec<String>,
    /// `ok` | `needs_login` | `unknown` — see [`crate::db::browser_tabs`].
    pub login_state: String,
}

/// A LIVE workspace tab: a durable id, its meta, and the page it is attached to.
///
/// A tab that has been dehydrated has no `Tab` — only its row. Rehydration
/// builds a fresh one at the stored URL.
pub struct Tab {
    id: TabId,
    page: Arc<AgentContext>,
    meta: RwLock<TabMeta>,
}

impl std::fmt::Debug for Tab {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Tab")
            .field("id", &self.id)
            .field("target_id", &self.page.target_id())
            .field("mode", &self.page.mode())
            .finish()
    }
}

impl Tab {
    /// Wrap a page opened in the DEFAULT context. The caller is responsible for
    /// having used [`AgentContext::create_in_default_context`] — a tab holding a
    /// scratch context would silently lose its cookies on close, so this is
    /// asserted rather than assumed.
    pub fn new(id: TabId, page: Arc<AgentContext>, meta: TabMeta) -> Self {
        debug_assert!(
            page.is_persistent(),
            "a workspace tab must live in the DEFAULT (persistent) context"
        );
        Self {
            id,
            page,
            meta: RwLock::new(meta),
        }
    }

    /// The durable tab id.
    pub fn id(&self) -> &str {
        &self.id
    }

    /// The page primitive — every navigate/read/input/screencast call goes here.
    pub fn page(&self) -> &Arc<AgentContext> {
        &self.page
    }

    /// This tab's own drive lock (subject = the tab id).
    pub fn lock(&self) -> &DriveLock {
        self.page.lock()
    }

    /// Shorthand for `self.lock().mode()`.
    pub fn mode(&self) -> DriveMode {
        self.page.mode()
    }

    /// A snapshot of the mutable meta.
    pub async fn meta(&self) -> TabMeta {
        self.meta.read().await.clone()
    }

    /// The tab's origin allowlist (§8.4).
    pub async fn origins(&self) -> Vec<String> {
        self.meta.read().await.origins.clone()
    }

    /// The last known `login_state`.
    pub async fn login_state(&self) -> String {
        self.meta.read().await.login_state.clone()
    }

    /// Record where the page actually is now (used by dehydration so a rehydrate
    /// reopens at the right URL, and by the audit trail).
    pub async fn set_location(&self, url: String, title: String) {
        let mut m = self.meta.write().await;
        m.url = url;
        m.title = title;
    }

    /// Record a probe result (§7.1).
    pub async fn set_login_state(&self, state: impl Into<String>) {
        self.meta.write().await.login_state = state.into();
    }

    /// Replace the origin allowlist (a human act — an agent can never widen it).
    pub async fn set_origins(&self, origins: Vec<String>) {
        self.meta.write().await.origins = origins;
    }

    /// Set/clear the pin.
    pub async fn set_pinned(&self, pinned: bool) {
        self.meta.write().await.pinned = pinned;
    }

    /// **Close the tab's target, and NOTHING else** (§2.3 R5).
    ///
    /// [`AgentContext::close`] already refuses to dispose a browser context it
    /// does not own, which is what makes this safe: disposing the DEFAULT context
    /// would take every other tab — and the profile's cookies — with it.
    pub async fn close(&self) {
        self.page.close().await;
    }
}
