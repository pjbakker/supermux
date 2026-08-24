//! **Phase 2 — the human takeover socket.**
//!
//! One WebSocket per session that turns the agent's headless page into a
//! *thing a person can use*: JPEG frames out at up to 60 fps, pointer/key/touch
//! events back in, and the phase-1 [`DriveLock`](super::lock::DriveLock) as the
//! interlock between the two drivers.
//!
//! ```text
//!   web canvas ──input JSON──▶ takeover WS ──Input.dispatch*──▶ page
//!        ▲                          │
//!        └──frame JSON (b64 jpeg)───┴──Page.screencastFrameAck──▶ page
//! ```
//!
//! # The lock IS the pause button
//!
//! Attaching sets [`DriveMode::HumanDriving`]. That single flag is the entire
//! "pause the agent" mechanism: every agent-side browser call goes through
//! [`DriveLock::gate`](super::lock::DriveLock::gate)/`ensure_agent` and is
//! refused (or parks in `await_agent`) until the human hands back. We do **not**
//! SIGSTOP the agent's pty — the agent stays alive, keeps thinking, and simply
//! cannot touch this page. Detaching (socket close, or an explicit `hand_back`)
//! releases it. Both transitions are idempotent, so a flapping mobile
//! connection cannot wedge a context in `HumanDriving`… except by staying
//! attached, which is exactly what it means.
//!
//! Releasing on ANY socket exit is correct — a human who is gone must not hold
//! the wheel — but "the socket closed" is not "the human finished". The release
//! therefore carries a [`HandOff`](super::lock::HandOff): only the explicit
//! `hand_back` frame is `Explicit`; every transport exit is `Disconnected`, and
//! a parked agent is told so instead of being told the login succeeded.
//!
//! # Frames and backpressure
//!
//! Chromium keeps at most **2 screencast frames in flight** and only produces
//! the next one when an earlier one is acked. Phase 1's pump acked immediately;
//! this socket asks for [`AckPolicy::Viewer`] instead and acks only **after the
//! client's socket has accepted the frame**, which converts that 2-frame window
//! into real end-to-end backpressure — a slow phone throttles chrome's encoder
//! rather than making the server drop frames it already paid to encode.
//!
//! The ack is a *counter decrement*, not a per-frame receipt, so a dropped
//! frame must still be acked or the stream stalls permanently. The one place
//! frames can be dropped is a `Lagged` broadcast receiver (the channel holds 16
//! and chrome will only ever have 2 outstanding, so this is close to
//! unreachable); we ack once per dropped frame there to keep the counter
//! honest. **Drop-old-frames** is the policy: a late frame is worthless.
//!
//! # Coordinates
//!
//! The client sends **page-viewport CSS pixels**, not canvas pixels. Only the
//! client knows its canvas' CSS size and the letterboxing of the image inside
//! it, so it does that division itself (`web/src/lib/browser/frame-map.ts`)
//! from the `metadata` we relay verbatim — `deviceWidth`/`deviceHeight` is the
//! CSS-pixel box the JPEG covers and `offsetTop` is the non-page strip above
//! it. The server does not trust the result: every coordinate is checked finite
//! and clamped to the live viewport (from the last frame's metadata) before it
//! reaches CDP.
//!
//! # Auth
//!
//! In-band first-frame, byte-identical to the terminal and chat sockets — a
//! browser `WebSocket` cannot send an `Authorization` header, so this router is
//! merged **outside** the bearer layer and reuses
//! [`crate::ws::verify_auth_frame`] / [`crate::ws::origin_allowed`].

use std::collections::HashSet;
use std::sync::{Arc, Mutex, OnceLock};

use axum::extract::ws::{close_code, Message, Utf8Bytes, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::response::Response;
use axum::routing::get;
use axum::Router;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::broadcast::error::RecvError;
use tokio::time::{Instant, MissedTickBehavior};
use tracing::{debug, info, warn};

use super::context::{capture_mismatch, AckPolicy, AgentContext, NavState, ScreencastOptions};
use super::lock::{Actor, DriveMode, HandOff};
use crate::state::AppState;
use crate::ws::{
    close, origin_allowed, verify_auth_frame, AUTH_TIMEOUT, PING_EVERY, PONG_DEADLINE,
};

/// Close code for "this session has no browser context". Terminal, in the
/// WebSocket private range, and the same 4404 the terminal/chat sockets use for
/// their own "the thing you asked for is not there": the client must stop
/// redialling and say so, not back off forever. A takeover implies the agent
/// already opened a page — there is nothing to take over otherwise.
pub const CLOSE_NO_CONTEXT: u16 = 4404;
/// The `reason` string that goes with it. Pinned on both sides (the web client
/// asserts on this exact text) so the day it moves, a test fails.
pub const REASON_NO_CONTEXT: &str = "no browser context";
/// Close reason when another takeover socket already holds this session.
pub const REASON_ALREADY_ATTACHED: &str = "already attached";

/// Longest `insert_text` payload we relay in one frame. Generous for a paste,
/// small enough that a hostile client cannot use the socket as a memory
/// amplifier.
const MAX_TEXT_BYTES: usize = 8 * 1024;

/// Fallback clamp bound before the first frame's metadata has told us the real
/// viewport. Larger than any plausible page viewport; the real clamp arrives
/// with frame #1, a few ms in.
const COORD_CEILING: f64 = 100_000.0;

/// The floor between two capture repairs. One is enough in practice (measured:
/// the frame right after it is the right shape), so this only exists so a page
/// that somehow never comes back cannot turn a 60 fps cast into 60 screenshots
/// and 120 `Emulation` round trips a second.
const CAPTURE_REPAIR_COOLDOWN: std::time::Duration = std::time::Duration::from_millis(500);

/// How many repairs in a row may fail to produce a correctly-sized frame before
/// this socket stops trying. A repair costs two `Emulation` calls and a
/// screenshot, so a page that somehow never comes back must not be able to bill
/// the browser for one of those every [`CAPTURE_REPAIR_COOLDOWN`] forever. The
/// counter clears the moment a frame arrives at the right box, so a page that
/// drifts once per navigation never approaches it.
const CAPTURE_REPAIR_TRIES: u32 = 3;

/// The WS sub-router. Merged at the TOP level of [`crate::http::router`] (next
/// to [`crate::ws::router_for`]), **not** into the bearer-protected `/api`
/// router — see the module docs on auth.
pub fn router_for(state: AppState) -> Router {
    Router::new()
        // Scratch: the in-chat takeover of ONE agent's own context. **Retained
        // unchanged** — `TakeoverCard` is still the interruption affordance, and
        // an in-chat ask means the human is coming to drive, so this route keeps
        // grabbing the wheel on attach.
        .route("/ws/browser/{session}/takeover", get(handle_takeover_ws))
        // Workspace: the human's persistent tab. Same relay, same frames, same
        // closed input command set — different subject, and **watch-first**.
        .route("/ws/browser/tab/{tab_id}", get(handle_tab_takeover_ws))
        .with_state(state)
}

/// Upgrade handler. The Origin decision is made on the pre-upgrade request and
/// carried into the socket task, because a real close frame can only be sent
/// after the upgrade.
async fn handle_takeover_ws(
    ws: WebSocketUpgrade,
    Path(session): Path<String>,
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Response {
    let origin_ok = origin_allowed(&state, &headers);
    ws.on_upgrade(move |socket| takeover_socket(socket, session, state, origin_ok))
}

/// Upgrade handler for a **workspace tab**.
async fn handle_tab_takeover_ws(
    ws: WebSocketUpgrade,
    Path(tab_id): Path<String>,
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Response {
    let origin_ok = origin_allowed(&state, &headers);
    ws.on_upgrade(move |socket| tab_takeover_socket(socket, tab_id, state, origin_ok))
}

// ── one viewer at a time ────────────────────────────────────────────────────

/// Subjects with a live takeover socket, **namespaced**: `session:<name>` for a
/// scratch context, `tab:<id>` for a workspace tab.
///
/// The namespace is load-bearing, not cosmetic: without it a session and a tab
/// that happened to share a string would fight over one slot, and (worse) one's
/// disconnect would release the other's wheel.
///
/// A second viewer on the SAME subject would be actively harmful, not merely
/// redundant: it would double-ack every frame, and — worse — *its* disconnect
/// would `release_to_agent` while the first human is still driving, handing the
/// wheel back mid-gesture. So the second socket is refused with 1013 (retryable).
fn viewers() -> &'static Mutex<HashSet<String>> {
    static VIEWERS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    VIEWERS.get_or_init(|| Mutex::new(HashSet::new()))
}

/// The viewer-slot key for a scratch session.
fn session_key(session: &str) -> String {
    format!("session:{session}")
}

/// The viewer-slot key for a workspace tab.
fn tab_key(tab_id: &str) -> String {
    format!("tab:{tab_id}")
}

/// **Is a human actually looking at this session's page right now?**
///
/// Phase 3 asks before deciding what a timed-out `request_human_takeover` park
/// means: a human who IS attached is simply taking their time (keep the wheel
/// with them), while nobody attached means the ask went unanswered and the
/// wheel must go back to the agent rather than wedging the context.
pub fn is_attached(session: &str) -> bool {
    viewers()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .contains(&session_key(session))
}

/// [`is_attached`] for a workspace tab.
pub fn is_tab_attached(tab_id: &str) -> bool {
    viewers()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .contains(&tab_key(tab_id))
}

/// RAII claim on one subject's single viewer slot.
struct ViewerSlot(String);

impl ViewerSlot {
    /// `key` is already namespaced — [`session_key`] or [`tab_key`].
    fn claim(key: &str) -> Option<Self> {
        let mut set = viewers().lock().unwrap_or_else(|e| e.into_inner());
        if !set.insert(key.to_string()) {
            return None;
        }
        Some(Self(key.to_string()))
    }
}

impl Drop for ViewerSlot {
    fn drop(&mut self) {
        viewers()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.0);
    }
}

// ── the wire ────────────────────────────────────────────────────────────────

/// Pointer phase. `move` is deliberately included: a drag, a hover menu, and a
/// `:hover` style are all things a human expects to work, and none of them
/// survives a click-only relay.
#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MouseKind {
    Move,
    Down,
    Up,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TouchKind {
    Start,
    Move,
    End,
    Cancel,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum KeyKind {
    Down,
    Up,
}

/// client → server. Internally tagged, like every other supermux socket.
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientMsg {
    /// First frame, always: `{"type":"auth","token":…}`.
    Auth { token: String },
    /// Pointer event at page-viewport CSS pixels.
    Mouse {
        kind: MouseKind,
        x: f64,
        y: f64,
        #[serde(default)]
        button: Option<String>,
        #[serde(default)]
        buttons: u32,
        #[serde(default)]
        click_count: u32,
        #[serde(default)]
        modifiers: u32,
    },
    /// Wheel/scroll delta at a point.
    Wheel {
        x: f64,
        y: f64,
        #[serde(default)]
        dx: f64,
        #[serde(default)]
        dy: f64,
        #[serde(default)]
        modifiers: u32,
    },
    /// One key transition. `text` present ⇒ it inserts something.
    Key {
        kind: KeyKind,
        key: String,
        #[serde(default)]
        code: String,
        #[serde(default)]
        key_code: i64,
        #[serde(default)]
        text: Option<String>,
        #[serde(default)]
        modifiers: u32,
    },
    /// IME / paste / emoji — anything per-key events cannot express.
    Text { text: String },
    /// A single touch point (multi-touch is not modelled: the takeover canvas
    /// is one finger, and pinch-zoom belongs to the client's own viewport).
    Touch {
        kind: TouchKind,
        #[serde(default)]
        x: f64,
        #[serde(default)]
        y: f64,
    },
    /// Give the wheel back but KEEP watching (the socket stays open, frames
    /// keep flowing, input starts being refused).
    HandBack,
    /// Grab the wheel again after a `hand_back`.
    TakeOver,
    /// **The viewer's box** — sent on attach and on every resize, and the one
    /// thing only the client can know.
    ///
    /// `width`/`height` are CSS pixels of the canvas the frames are painted
    /// into, `dpr` its `devicePixelRatio`, `mobile` whether this is a touch
    /// viewport that should get the site's phone layout. It drives BOTH halves
    /// of legibility: the page is laid out at this box
    /// (`Emulation.setDeviceMetricsOverride`) and the stream is capped to the
    /// real pixels behind it, instead of a 1366px render pushed through a
    /// 512px pipe. Aliased `w`/`h` because the client is free to send either.
    Viewport {
        #[serde(default, alias = "w")]
        width: u32,
        #[serde(default, alias = "h")]
        height: u32,
        #[serde(default = "one_dpr")]
        dpr: f64,
        #[serde(default)]
        mobile: bool,
    },
    /// Re-send a full still frame — a static page emits no screencast frames
    /// (spike gotcha #1), so a client that missed the seed would otherwise sit
    /// on a blank canvas until something on the page moved.
    Resync,

    // ── navigation controls (P1-4) ──────────────────────────────────────────
    //
    // All CONTROL frames: they carry no page coordinates, so `to_cdp` — which
    // is input-only and pure — returns `None` for every one of them and `drive`
    // handles them in its own match arm, next to `HandBack` / `Viewport`.
    //
    // Deliberately handled ABOVE the drive gate, for the same reason the REST
    // door does not grab the wheel: the human owns the browser, and the wheel
    // governs the *input relay*, not the address bar. Refusing a WS `navigate`
    // that the identical REST route accepts would be incoherent, not safer.
    /// The address bar: go to this URL.
    Navigate { url: String },
    /// One step back through the page's own history.
    Back,
    /// …and one step forward.
    Forward,
    /// Reload. `ignore_cache` is the hard reload.
    Reload {
        #[serde(default)]
        ignore_cache: bool,
    },
    /// Stop the in-flight load.
    Stop,
    /// Answer the modal the page has opened. `prompt_text` is the reply to a
    /// `prompt()`; ignored by the other dialog kinds.
    Dialog {
        #[serde(default)]
        accept: bool,
        #[serde(default)]
        prompt_text: Option<String>,
    },

    // ── the DOM verbs (P4) ──────────────────────────────────────────────
    //
    // The two verbs that need the page's TEXT rather than its pixels, plus the
    // cleanup for the first. CONTROL frames like the navigation ones: `to_cdp`
    // returns `None` for all three and `drive` runs them itself, because
    // neither is an `Input.*` dispatch — a find walks the DOM and a copy reads
    // the selection out of it.
    /// Find-in-page. `forward` is the direction of the step (`false` is what a
    /// shift-Enter means), `case_sensitive` the bar's `Aa` toggle.
    Find {
        query: String,
        #[serde(default = "yes")]
        forward: bool,
        #[serde(default)]
        case_sensitive: bool,
    },
    /// The find bar closed: drop the highlight and the server-side cursor, so a
    /// relay does not leave somebody's page selected behind a bar that is gone.
    FindClose,
    /// Read the page's current SELECTION as text, for the client's clipboard.
    Copy,

    /// Client-initiated liveness ping.
    Ping,
}

/// server → client. All JSON text frames.
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerMsg<'a> {
    /// Handshake echo — the same literal the terminal socket sends.
    AuthOk,
    /// What you are looking at, sent once after the handshake.
    Target {
        session: &'a str,
        url: String,
        width: u32,
        height: u32,
    },
    /// One JPEG, base64, plus the CDP metadata the client maps taps with.
    Frame { data: &'a str, metadata: &'a Value },
    /// **The live address bar** (P1-5) — url, title, favicon, spinner, honest
    /// back/forward affordances, the padlock, and the modal that is blocking the
    /// page right now.
    ///
    /// Serialised flat, so the wire shape is
    /// `{"type":"nav_state","url":…,"title":…,"favicon":…,"loading":…,
    /// "can_go_back":…,"can_go_forward":…,"secure":…,"dialog":…}` — pinned by a
    /// test, because the web client parses these names.
    ///
    /// This is what replaces the fire-once [`Target`](Self::Target) frame as the
    /// omnibox's feed: `Target` still seeds the canvas size on attach, but it is
    /// a snapshot and a page that navigates itself leaves it stale within
    /// seconds.
    NavState(&'a NavState),
    /// The live drive mode — the AGENT/HUMAN pill.
    Mode { mode: DriveMode },
    /// A frame was dropped rather than acted on, and why. Two callers: an input
    /// event arriving while the human does not hold the wheel, and a `navigate`
    /// to a scheme the human door refuses (`file:`/`data:` inside a profile that
    /// IS the human's cookie jar is a local read, not navigation).
    Refused { reason: &'a str },

    // ── the DOM verbs' answers (P4) ─────────────────────────────────────────
    /// **What this relay can do beyond pixels**, sent once per socket right
    /// after the seed.
    ///
    /// THE IMPORTANT ONE. Its absence is what an older relay looks like, and
    /// the client reads a missing frame as "cannot" rather than "not yet"
    /// (`page-tools.ts`: every flag defaults FALSE) — so this frame is the only
    /// thing that lights the find bar and the copy-selection control up, and a
    /// server that stops answering `find` must stop sending it.
    Caps { find: bool, copy: bool },
    /// Where a find landed: the query the server actually searched for, and the
    /// position in its own result set.
    ///
    /// `index` is 1-BASED, the way every find bar in the world counts, and `0`
    /// means "no current hit" — the only honest answer for `total: 0`. The
    /// `query` echo is load-bearing: the client shows `…` until the server has
    /// answered for the query it is *currently* showing, so a result for a
    /// stale keystroke can never be painted as this one's count.
    FindResult {
        query: &'a str,
        index: u32,
        total: u32,
    },
    /// The page's selection, as text — the answer to [`ClientMsg::Copy`].
    /// Capped at [`MAX_COPY_BYTES`]: a select-all on a long page is megabytes,
    /// and a clipboard is not a file transfer.
    Copied { text: &'a str },
}

impl ServerMsg<'_> {
    fn to_frame(&self) -> Message {
        Message::Text(Utf8Bytes::from(
            serde_json::to_string(self).unwrap_or_else(|_| r#"{"type":"refused"}"#.to_string()),
        ))
    }
}

/// A client that omits `dpr` is telling us nothing, not telling us zero.
fn one_dpr() -> f64 {
    1.0
}

/// A `find` that omits `forward` means the ordinary Enter: search downwards.
fn yes() -> bool {
    true
}

// ── the viewer's box ────────────────────────────────────────────────────────

/// A sanitised [`ClientMsg::Viewport`]: the box we will lay the page out at and
/// cap the stream to.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ViewportRequest {
    pub width: u32,
    pub height: u32,
    pub dpr: f64,
    pub mobile: bool,
}

impl ViewportRequest {
    /// Narrowest box worth laying a page out at — below this every site's
    /// layout collapses and no human is reading it anyway.
    pub const MIN_CSS: u32 = 200;
    /// Widest. Well past any real window; a guard against a client asking us to
    /// composite a wall.
    pub const MAX_CSS: u32 = 4096;

    /// Sanitise a client-supplied box.
    ///
    /// `None` ⇒ unusable — a zero-sized frame from a client that has not laid
    /// itself out yet, which arrives routinely on attach. Keeping the profile
    /// we have is right there; resizing the page to nothing is not.
    pub fn sanitized(width: u32, height: u32, dpr: f64, mobile: bool) -> Option<Self> {
        if width == 0 || height == 0 {
            return None;
        }
        let dpr = if dpr.is_finite() && dpr > 0.0 {
            dpr.clamp(1.0, super::context::MAX_DEVICE_SCALE)
        } else {
            1.0
        };
        Some(Self {
            width: width.clamp(Self::MIN_CSS, Self::MAX_CSS),
            height: height.clamp(Self::MIN_CSS, Self::MAX_CSS),
            dpr,
            mobile,
        })
    }
}

/// Pick this viewer's streaming profile. Pure, so the choice is testable
/// without chrome or a socket.
///
/// `None` — a client that never told us its size — is the **in-chat takeover
/// card**, and it keeps today's 512²/q60/every-frame stream byte for byte. A
/// client that negotiated is the **workspace viewport**, and it gets frames
/// sized to its own screen at q75 and a quarter of the frame rate. Both ack as
/// [`AckPolicy::Viewer`]: the end-to-end backpressure contract is a property of
/// this socket, not of the profile.
pub fn screencast_profile(req: Option<ViewportRequest>) -> ScreencastOptions {
    let base = match req {
        Some(v) => ScreencastOptions::drive(v.width, v.height, v.dpr),
        None => ScreencastOptions::watch(),
    };
    ScreencastOptions {
        ack: AckPolicy::Viewer,
        ..base
    }
}

/// The `metadata` box a still frame needs, synthesised from the viewport the
/// page is actually laid out at.
///
/// A seed/resync still is a `Page.captureScreenshot`, not a screencast frame,
/// so CDP hands us no metadata with it. Sending `{}` (what this did) made
/// [`Viewport::from_metadata`] fail, which left the server clamp at
/// [`COORD_CEILING`] and the client with no scale factor to map taps through —
/// so every click before the first real frame landed somewhere else. On a
/// **static page**, which emits no screencast frames at all (gotcha #1), that
/// is every click.
pub fn seed_metadata(width: u32, height: u32) -> Value {
    json!({
        "offsetTop": 0,
        "pageScaleFactor": 1,
        "deviceWidth": width,
        "deviceHeight": height,
        "scrollOffsetX": 0,
        "scrollOffsetY": 0,
    })
}

// ── input → CDP ─────────────────────────────────────────────────────────────

/// The live viewport, learned from the newest frame's metadata. Coordinates
/// from the client are clamped to it, so a malformed or hostile client can
/// dispatch inside the page but never at absurd offsets.
#[derive(Debug, Clone, Copy)]
pub struct Viewport {
    pub width: f64,
    pub height: f64,
}

impl Viewport {
    /// Read `deviceWidth`/`deviceHeight` off a `Page.screencastFrame`
    /// `metadata` object; `None` when the metadata does not carry a usable box.
    pub fn from_metadata(metadata: &Value) -> Option<Self> {
        let width = metadata.get("deviceWidth").and_then(Value::as_f64)?;
        let height = metadata.get("deviceHeight").and_then(Value::as_f64)?;
        (width > 0.0 && height > 0.0).then_some(Self { width, height })
    }

    /// Clamp a client-supplied point into this viewport. Non-finite input
    /// (`NaN`, `Infinity` — both legal JSON floats through serde) collapses to
    /// `0.0` rather than reaching CDP.
    pub fn clamp(&self, x: f64, y: f64) -> (f64, f64) {
        let fix = |v: f64, max: f64| {
            if v.is_finite() {
                v.clamp(0.0, max)
            } else {
                0.0
            }
        };
        (fix(x, self.width), fix(y, self.height))
    }
}

impl Default for Viewport {
    fn default() -> Self {
        Self {
            width: COORD_CEILING,
            height: COORD_CEILING,
        }
    }
}

/// One CDP call: `(method, params)`.
pub type CdpCall = (&'static str, Value);

/// Translate a client message into the CDP command it forwards, or `None` when
/// it is a control frame (auth/hand_back/…) with no page effect.
///
/// Pure, so the whole mapping — button masks, `rawKeyDown` vs `keyDown`,
/// clamping, the text cap — is testable without a browser or a socket.
pub fn to_cdp(msg: &ClientMsg, viewport: Viewport) -> Option<CdpCall> {
    match msg {
        ClientMsg::Mouse {
            kind,
            x,
            y,
            button,
            buttons,
            click_count,
            modifiers,
        } => {
            let (x, y) = viewport.clamp(*x, *y);
            let kind_str = match kind {
                MouseKind::Move => "mouseMoved",
                MouseKind::Down => "mousePressed",
                MouseKind::Up => "mouseReleased",
            };
            // A press/release with no button named is a left click; a move
            // with no buttons held is a plain hover.
            let button = match button.as_deref() {
                Some("left") | Some("right") | Some("middle") | Some("back") | Some("forward")
                | Some("none") => button.as_deref().unwrap(),
                _ if matches!(kind, MouseKind::Move) => "none",
                _ => "left",
            };
            Some((
                "Input.dispatchMouseEvent",
                json!({
                    "type": kind_str,
                    "x": x, "y": y,
                    "button": button,
                    "buttons": buttons,
                    "clickCount": (*click_count).min(3).max(u32::from(!matches!(kind, MouseKind::Move))),
                    "modifiers": modifiers & 0b1111,
                }),
            ))
        }
        ClientMsg::Wheel {
            x,
            y,
            dx,
            dy,
            modifiers,
        } => {
            let (x, y) = viewport.clamp(*x, *y);
            let delta = |v: f64| if v.is_finite() { v.clamp(-10_000.0, 10_000.0) } else { 0.0 };
            Some((
                "Input.dispatchMouseEvent",
                json!({
                    "type": "mouseWheel",
                    "x": x, "y": y,
                    "deltaX": delta(*dx), "deltaY": delta(*dy),
                    "buttons": 0,
                    "modifiers": modifiers & 0b1111,
                }),
            ))
        }
        ClientMsg::Key {
            kind,
            key,
            code,
            key_code,
            text,
            modifiers,
        } => {
            // `rawKeyDown` vs `keyDown` is not cosmetic: a keyDown WITHOUT text
            // still fires an empty `input`-ish path in some engines, and
            // DevTools' own screencast picks between the two exactly this way.
            let text = text.as_deref().filter(|t| !t.is_empty());
            let kind_str = match (kind, text) {
                (KeyKind::Down, Some(_)) => "keyDown",
                (KeyKind::Down, None) => "rawKeyDown",
                (KeyKind::Up, _) => "keyUp",
            };
            let mut params = json!({
                "type": kind_str,
                "key": clip(key, 32),
                // gotcha #8: an empty `code` breaks pages that read e.code.
                "code": clip(code, 32),
                "windowsVirtualKeyCode": key_code,
                "nativeVirtualKeyCode": key_code,
                "modifiers": modifiers & 0b1111,
            });
            if let Some(t) = text {
                let t = clip(t, 16);
                params["text"] = json!(t);
                params["unmodifiedText"] = json!(t);
            }
            Some(("Input.dispatchKeyEvent", params))
        }
        ClientMsg::Text { text } => {
            if text.is_empty() {
                return None;
            }
            Some((
                "Input.insertText",
                json!({ "text": clip(text, MAX_TEXT_BYTES) }),
            ))
        }
        ClientMsg::Touch { kind, x, y } => {
            let (x, y) = viewport.clamp(*x, *y);
            let kind_str = match kind {
                TouchKind::Start => "touchStart",
                TouchKind::Move => "touchMove",
                TouchKind::End => "touchEnd",
                TouchKind::Cancel => "touchCancel",
            };
            // touchEnd/touchCancel take an EMPTY point list — passing the
            // lifted finger is a protocol error, not a no-op.
            let points = match kind {
                TouchKind::Start | TouchKind::Move => json!([{ "x": x, "y": y }]),
                TouchKind::End | TouchKind::Cancel => json!([]),
            };
            Some((
                "Input.dispatchTouchEvent",
                json!({ "type": kind_str, "touchPoints": points }),
            ))
        }
        // Control frames: no page effect of their own. `Viewport` is handled
        // in `drive` (it resizes the page and renegotiates the stream) and must
        // never reach `dispatch_input`.
        ClientMsg::Auth { .. }
        | ClientMsg::HandBack
        | ClientMsg::TakeOver
        | ClientMsg::Resync
        | ClientMsg::Viewport { .. }
        // The navigation controls are page COMMANDS, not input events. They
        // reach the page through `AgentContext`'s gated verbs in `drive`, never
        // through `dispatch_input` — whose allowlist is `Input.*` and must stay
        // that way.
        | ClientMsg::Navigate { .. }
        | ClientMsg::Back
        | ClientMsg::Forward
        | ClientMsg::Reload { .. }
        | ClientMsg::Stop
        | ClientMsg::Dialog { .. }
        // The DOM verbs (P4) are page READS, run through `AgentContext::evaluate`
        // in `drive`. `Runtime.evaluate` is not in `dispatch_input`'s `Input.*`
        // allowlist, and must never be.
        | ClientMsg::Find { .. }
        | ClientMsg::FindClose
        | ClientMsg::Copy
        | ClientMsg::Ping => None,
    }
}

// ── the DOM verbs (P4): find-in-page and copy-out ───────────────────────────
//
// Everything else this socket relays is pixels and input events. These two are
// not: a find needs the page's TEXT and a copy needs its SELECTION, and neither
// exists in the JPEG we are painting. Both therefore run as
// `Runtime.evaluate` in the page's own world — the one CDP surface that can see
// the DOM — and both are expressed as PURE script builders here, so the whole
// contract (the escaping, the caps, the counting) is testable without a chrome.
//
// **Why an injected routine and not `DOM.performSearch`.** `performSearch`
// counts NODES that match, including matches inside attributes and raw HTML,
// and answering `3/7` from it would be a count of something the human cannot
// see. The walk below counts *visible text occurrences*, which is what a find
// bar's `3/7` claims to mean, and it produces the current hit's Range in the
// same pass — so the count and the thing that gets scrolled to can never
// disagree.

/// Most matches one find will count. A page with more than this is not one
/// anybody is stepping through match by match, and an unbounded count is an
/// unbounded walk of somebody else's DOM.
pub const FIND_MAX_HITS: usize = 10_000;

/// Longest query we will search for. Far past anything typed into a find bar;
/// the cap exists so the socket cannot be used as a way to hand chrome an
/// arbitrarily long string to scan a page with.
pub const MAX_QUERY_BYTES: usize = 4 * 1024;

/// Longest selection the page hands back, in JS string length…
pub const MAX_COPY_CHARS: usize = 256 * 1024;
/// …and the byte cap on the frame we put on the wire. Two caps, because the
/// first keeps megabytes from crossing the CDP socket at all and the second is
/// what actually bounds the frame.
pub const MAX_COPY_BYTES: usize = 512 * 1024;

/// The body of the find routine. Prefixed at call time with `Q`/`FWD`/`CS`/`CAP`
/// (see [`find_script`]); kept as its own constant so the Rust around it needs
/// no brace escaping.
///
/// It counts, selects and scrolls in one pass:
///  1. a `TreeWalker` over the text nodes that are actually laid out
///     (`getClientRects().length`, memoised per element — a `display:none` menu
///     is not a match a human can be scrolled to), skipping the non-content
///     tags;
///  2. every occurrence of the needle inside each node, up to `CAP`;
///  3. the cursor, kept on `window.__supermuxFind` and keyed by query+case, so
///     Enter steps and wraps instead of re-finding the first hit. A new query
///     starts at the first match (or the last, going backwards);
///  4. a `Range` over the current hit, put in the page's own selection (that IS
///     the highlight, and it is what makes `copy` after a find do the obvious
///     thing) and scrolled into the middle of its scroll container.
const FIND_BODY: &str = r##"
const SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, HEAD: 1, TITLE: 1, IFRAME: 1 };
const needle = CS ? Q : Q.toLowerCase();
const root = document.body || document.documentElement;
const sel = window.getSelection();
if (!needle || !root) { window.__supermuxFind = null; return { index: 0, total: 0 }; }
const seen = new WeakMap();
const shown = (el) => {
  if (!el) return false;
  let v = seen.get(el);
  if (v === undefined) { v = !!(el.getClientRects && el.getClientRects().length); seen.set(el, v); }
  return v;
};
const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
  acceptNode(n) {
    const p = n.parentElement;
    if (!p || SKIP[p.tagName] || !n.nodeValue) return NodeFilter.FILTER_REJECT;
    return shown(p) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
  }
});
const hits = [];
outer: for (let n = walk.nextNode(); n; n = walk.nextNode()) {
  const hay = CS ? n.nodeValue : n.nodeValue.toLowerCase();
  for (let from = 0; ; ) {
    const at = hay.indexOf(needle, from);
    if (at < 0) break;
    hits.push([n, at]);
    if (hits.length >= CAP) break outer;
    from = at + needle.length;
  }
}
const total = hits.length;
if (!total) {
  window.__supermuxFind = null;
  if (sel) sel.removeAllRanges();
  return { index: 0, total: 0 };
}
const key = (CS ? 'S:' : 'i:') + Q;
const st = window.__supermuxFind;
const idx = (st && st.key === key && typeof st.index === 'number')
  ? ((st.index + (FWD ? 1 : -1)) % total + total) % total
  : (FWD ? 0 : total - 1);
const node = hits[idx][0], at = hits[idx][1];
const range = document.createRange();
range.setStart(node, at);
range.setEnd(node, Math.min(at + needle.length, node.nodeValue.length));
if (sel) { sel.removeAllRanges(); sel.addRange(range); }
const el = node.parentElement;
if (el && el.scrollIntoView) {
  try { el.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (e) { el.scrollIntoView(); }
}
window.__supermuxFind = { key: key, index: idx };
return { index: idx + 1, total: total };
"##;

/// Build one find. The query is embedded as a JSON string literal, so a needle
/// containing quotes, backslashes or newlines is a *needle*, not a syntax error
/// or an injection.
pub fn find_script(query: &str, forward: bool, case_sensitive: bool) -> String {
    let q = serde_json::to_string(query).unwrap_or_else(|_| "\"\"".to_string());
    let mut js = String::with_capacity(FIND_BODY.len() + q.len() + 96);
    js.push_str("(() => { const Q = ");
    js.push_str(&q);
    js.push_str(", FWD = ");
    js.push_str(if forward { "true" } else { "false" });
    js.push_str(", CS = ");
    js.push_str(if case_sensitive { "true" } else { "false" });
    js.push_str(", CAP = ");
    js.push_str(&FIND_MAX_HITS.to_string());
    js.push_str(";");
    js.push_str(FIND_BODY);
    js.push_str("})()");
    js
}

/// Undo everything [`find_script`] leaves behind: the cursor and the selection
/// that IS the highlight.
///
/// The counterpart of `DOM.discardSearchResults` for a search we ran ourselves.
/// It only ever removes state this relay created, which is why the socket runs
/// it UNGATED — a human who loses the wheel mid-find must still be able to close
/// the bar without leaving the page highlighted behind it.
pub fn find_clear_script() -> &'static str {
    "(() => { try { const s = window.getSelection(); if (s) s.removeAllRanges(); } \
catch (e) {} window.__supermuxFind = null; return true; })()"
}

/// Read the page's selection, capped in the page so the megabytes never cross
/// the CDP socket in the first place.
pub fn copy_script() -> String {
    let cap = MAX_COPY_CHARS.to_string();
    let mut js = String::with_capacity(160 + cap.len() * 2);
    js.push_str("(() => { try { const s = window.getSelection(); const t = s ? s.toString() : ''; return t.length > ");
    js.push_str(&cap);
    js.push_str(" ? t.slice(0, ");
    js.push_str(&cap);
    js.push_str(") : t; } catch (e) { return ''; } })()");
    js
}

/// `{index,total}` out of whatever the page returned.
///
/// Total, like every parse on this wire: a garbled or missing value is `0`, and
/// `index` can never exceed `total` — a client that trusted `4/3` would paint a
/// count that cannot be true.
pub fn find_counts(value: &Value) -> (u32, u32) {
    let read = |key: &str| -> u32 {
        value
            .get(key)
            .and_then(Value::as_f64)
            .filter(|n| n.is_finite() && *n > 0.0)
            .map(|n| n.min(f64::from(u32::MAX)) as u32)
            .unwrap_or(0)
    };
    let total = read("total");
    (read("index").min(total), total)
}

/// What a takeover socket is attached to — the scratch session or a workspace
/// tab — in the two spellings the relay needs: the name that goes in the log
/// line and the seed frame, and the audit ledger's `target`.
#[derive(Debug, Clone, Copy)]
pub enum Subject<'a> {
    Session(&'a str),
    Tab(&'a str),
}

impl Subject<'_> {
    /// The session name or the tab id.
    pub fn name(&self) -> &str {
        match self {
            Subject::Session(s) | Subject::Tab(s) => s,
        }
    }

    /// The audit ledger's target column. `tab:<id>` is what every other browser
    /// write already uses (`api.rs`), so a copy shows up in the same trail as
    /// the navigations and the grants on that tab; a scratch context has no tab
    /// row, so it is audited under its session.
    pub fn audit_target(&self) -> String {
        match self {
            Subject::Session(s) => format!("session:{s}"),
            Subject::Tab(t) => format!("tab:{t}"),
        }
    }
}

/// Record a copy-out.
///
/// **Spawned and best-effort**: an audit write must never stall the frame relay,
/// and a failed one must never swallow the copy the human asked for.
///
/// **Never the text.** Only its size — `db::audit`'s secret-hygiene rule, and
/// the right call anyway: the fact worth keeping is that a signed-in page's
/// content left the browser, not what it said. Skipped entirely for an empty
/// selection, which is a button press, not a read.
fn spawn_copy_audit(state: &AppState, target: String, chars: usize, bytes: usize, clipped: bool) {
    let pool = state.pool.clone();
    tokio::spawn(async move {
        if let Err(e) = crate::db::audit::log(
            &pool,
            "user",
            "browser.copy",
            &target,
            json!({ "chars": chars, "bytes": bytes, "clipped": clipped }),
        )
        .await
        {
            warn!(subject = %target, error = %e, "browser takeover: copy audit write failed");
        }
    });
}

/// **The relay's own gate.** `Actor::Human` is never refused by the lock — that
/// is the whole point of the human escalation path — so "is this socket allowed
/// to drive right now" has to be asked separately, here, before anything is
/// forwarded. It is false the moment the wheel is not ours: after a `hand_back`,
/// or if something else released the context underneath us.
pub fn human_may_drive(mode: DriveMode) -> bool {
    matches!(mode, DriveMode::HumanDriving)
}

/// One navigation command from the socket, ready to run off the loop.
#[derive(Debug)]
enum NavCmd {
    /// The address bar. Already scheme-checked by the caller.
    Go(String),
    /// A history step: `-1` back, `+1` forward.
    Step(i64),
    Reload(bool),
    Stop,
    Dialog {
        accept: bool,
        prompt_text: Option<String>,
    },
}

/// Run one navigation command **off the socket loop**.
///
/// `navigate` / `reload` / `go` each wait (bounded) for the page's load event,
/// and awaiting that inline would freeze the viewer for the whole of it: no
/// frames relayed, no acks paid — and an unacked frame stalls chrome's 2-slot
/// in-flight window permanently — and no pongs, so a slow page could time the
/// socket out. Spawned instead, and the **nav watcher** reports what actually
/// happened on the very feed the address bar already reads.
fn spawn_nav(ctx: &Arc<AgentContext>, subject: &str, cmd: NavCmd) {
    let ctx = ctx.clone();
    let subject = subject.to_string();
    tokio::spawn(async move {
        let done = match &cmd {
            NavCmd::Go(url) => ctx.navigate(Actor::Human, url).await.map(|()| true),
            NavCmd::Step(delta) => ctx.go(Actor::Human, *delta).await,
            NavCmd::Reload(ignore_cache) => {
                ctx.reload(Actor::Human, *ignore_cache).await.map(|()| true)
            }
            NavCmd::Stop => ctx.stop(Actor::Human).await.map(|()| true),
            NavCmd::Dialog { accept, prompt_text } => ctx
                .handle_dialog(Actor::Human, *accept, prompt_text.as_deref())
                .await
                .map(|()| true),
        };
        match done {
            Ok(true) => {}
            // A history step off the end of the stack. A normal state, not an
            // error: the client has already greyed that button from
            // `can_go_back`/`can_go_forward` on the nav-state feed.
            Ok(false) => {
                debug!(subject = %subject, ?cmd, "browser takeover: no history entry that way");
            }
            Err(e) => warn!(subject = %subject, ?cmd, error = %e, "browser takeover: nav command"),
        }
    });
}

/// Truncate to `max` BYTES on a char boundary (never mid-UTF-8).
fn clip(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

// ── the socket ──────────────────────────────────────────────────────────────

async fn takeover_socket(
    mut socket: WebSocket,
    session: String,
    state: AppState,
    origin_ok: bool,
) {
    if !origin_ok {
        close(&mut socket, close_code::POLICY, "origin not allowed").await;
        return;
    }

    // 1. First-frame auth — the terminal socket's contract, verbatim.
    let authed = match tokio::time::timeout(AUTH_TIMEOUT, socket.recv()).await {
        Ok(Some(Ok(Message::Text(t)))) => verify_auth_frame(&state, t.as_str()),
        _ => false,
    };
    if !authed {
        close(&mut socket, close_code::POLICY, "auth required").await;
        return;
    }
    // 1a. Same name gate the REST surface applies, before the name is used as a
    //     map key or reaches a log line.
    if !crate::sessions::valid_name(&session) {
        close(&mut socket, close_code::POLICY, "bad name").await;
        return;
    }
    if socket.send(ServerMsg::AuthOk.to_frame()).await.is_err() {
        return;
    }

    // 2. There must ALREADY be a context: a takeover takes over something. We
    //    deliberately do NOT `context_for` here — that would let an unauthorised
    //    surface spawn chrome, and it would present an empty about:blank as if
    //    it were the agent's work.
    let Some(ctx) = state.browser.context(&session).await else {
        close(&mut socket, CLOSE_NO_CONTEXT, REASON_NO_CONTEXT).await;
        return;
    };

    // 3. One viewer per subject (see `ViewerSlot`).
    let Some(_slot) = ViewerSlot::claim(&session_key(&session)) else {
        close(&mut socket, close_code::AGAIN, REASON_ALREADY_ATTACHED).await;
        return;
    };

    // 4. **Grab the wheel.** This is the agent pause — see the module docs. The
    //    session route grabs on attach because an in-chat takeover ask means the
    //    human is coming to drive; the TAB route deliberately does not (§6.4).
    let previous = ctx.lock().request_human_takeover();
    info!(session = %session, %previous, "browser takeover: attached");

    let outcome = drive(&mut socket, Subject::Session(&session), &ctx, &state).await;

    // 5. Teardown, unconditional. `stop_screencast` first so chrome stops
    //    encoding for a socket that is gone, then the wheel goes back to the
    //    agent — which also wakes anything parked in `await_agent`.
    if let Err(e) = ctx.stop_screencast(Actor::Human).await {
        debug!(session = %session, error = %e, "browser takeover: stopScreencast");
    }
    // **Truthfully.** EVERY way out of `drive` is the socket going away — a tab
    // close, a dead mobile link, a ping timeout, an error — and none of them is
    // the human saying "I'm done". The one explicit hand-back is the
    // `ClientMsg::HandBack` frame, which already released the wheel (as
    // `Explicit`) inside the loop; this redundant release cannot overwrite that
    // label, because `release_to_agent` only records the release that actually
    // took the wheel back. So a parked agent is told the truth in both cases —
    // see `tools::handback_result`.
    ctx.lock().release_to_agent(HandOff::Disconnected);
    info!(session = %session, ?outcome, "browser takeover: detached, released to AGENT");
}

/// **The workspace-tab relay.** Same wire, same closed input command set, same
/// first-frame auth — three differences, all deliberate:
///
/// 1. **Subject.** The lock, the viewer slot and the log field are the TAB, so a
///    human on tab A does not touch tab B.
/// 2. **Watch-first** (§6.4). It does NOT call `request_human_takeover` on
///    attach. The relay already refuses to forward any input while the human does
///    not hold the wheel, and `DriveLock::gate` lets `Actor::Human` start the
///    screencast regardless — so the human sees live frames and drives nothing
///    until they press Drive (a `take_over` frame). Without this, *merely looking
///    at a tab* would silently block every granted agent on it: the workspace
///    surface would hit that footgun constantly, where an in-chat takeover card
///    never does.
/// 3. **Hand-back on exit is conditional.** Releasing a wheel we never took would
///    be a lie to a parked agent, so the release only fires if this socket
///    actually took it.
/// 4. **It rehydrates** (P0-2). An asleep workspace tab is woken on attach
///    instead of being hung up on; see the comment at the lookup.
async fn tab_takeover_socket(
    mut socket: WebSocket,
    tab_id: String,
    state: AppState,
    origin_ok: bool,
) {
    if !origin_ok {
        close(&mut socket, close_code::POLICY, "origin not allowed").await;
        return;
    }
    let authed = match tokio::time::timeout(AUTH_TIMEOUT, socket.recv()).await {
        Ok(Some(Ok(Message::Text(t)))) => verify_auth_frame(&state, t.as_str()),
        _ => false,
    };
    if !authed {
        close(&mut socket, close_code::POLICY, "auth required").await;
        return;
    }
    // The same shape gate `valid_name` is to a session name, before the id is
    // used as a map key or reaches a log line.
    if !crate::db::browser_tabs::valid_tab_id(&tab_id) {
        close(&mut socket, close_code::POLICY, "bad name").await;
        return;
    }
    if socket.send(ServerMsg::AuthOk.to_frame()).await.is_err() {
        return;
    }

    // **Rehydrate on attach** (P0-2). The scratch route above still refuses —
    // there, a freshly-opened `about:blank` really would be presented as the
    // agent's work. Here it is the opposite: a workspace tab reopens at its
    // stored URL in the persistent profile, so the same page with the same
    // cookies and the same sign-in comes back. That IS what was there; refusing
    // it left a human staring at a dead socket for a tab they own.
    //
    // The "unauthorised surface must never spawn chrome" rule is honoured, not
    // waived: this line is reached only AFTER the in-band bearer auth above —
    // the same credential the REST wake door demands.
    let tab = match state.browser.tab(&tab_id).await {
        Some(tab) => tab,
        None => match super::api::wake_tab_by_id(&state, &tab_id).await {
            Ok(tab) => {
                info!(tab = %tab_id, "browser takeover: rehydrated an asleep tab on attach");
                tab
            }
            Err(e) => {
                // No row, a chrome that will not start, the tab cap — all of them
                // mean "there is no page to show", which is what the client's
                // no-context branch already handles honestly.
                debug!(tab = %tab_id, error = %e, "browser takeover: rehydrate failed");
                close(&mut socket, CLOSE_NO_CONTEXT, REASON_NO_CONTEXT).await;
                return;
            }
        },
    };
    let Some(_slot) = ViewerSlot::claim(&tab_key(&tab_id)) else {
        close(&mut socket, close_code::AGAIN, REASON_ALREADY_ATTACHED).await;
        return;
    };
    info!(tab = %tab_id, mode = %tab.mode(), "browser takeover: attached to tab (watching)");

    let ctx = tab.page().clone();
    let outcome = drive(&mut socket, Subject::Tab(&tab_id), &ctx, &state).await;

    if let Err(e) = ctx.stop_screencast(Actor::Human).await {
        debug!(tab = %tab_id, error = %e, "browser takeover: stopScreencast");
    }
    // Only release what we actually took. A watcher who never pressed Drive has
    // no wheel to hand back, and claiming otherwise would wake a parked agent
    // with a hand-off that never happened.
    if human_may_drive(ctx.mode()) {
        ctx.lock().release_to_agent(HandOff::Disconnected);
    }
    info!(tab = %tab_id, ?outcome, "browser takeover: tab detached");
}

/// Why the socket loop ended. Logged, not sent — by the time we know, the
/// socket is usually already gone.
#[derive(Debug)]
enum Outcome {
    ClientClosed,
    PingTimeout,
    SendFailed,
    ScreencastGone,
    StartFailed,
}

async fn drive(
    socket: &mut WebSocket,
    subject: Subject<'_>,
    ctx: &Arc<AgentContext>,
    state: &AppState,
) -> Outcome {
    // The name that goes in the seed frame and every log line here; the audit
    // ledger's spelling of the same thing is `subject.audit_target()`, and only
    // the copy path needs it.
    let session = subject.name();
    // Seed: the target line, a still frame, and the current mode. The still is
    // load-bearing — a static page produces NO screencast frames (gotcha #1),
    // so without it a client attaching to an idle page sees a blank canvas.
    let url = ctx.current_url().await.unwrap_or_default();
    // The REAL render size, not the `0, 0` this used to claim: it is the box we
    // last pushed with `setDeviceMetricsOverride`, so the client can scale its
    // canvas correctly on the very first frame.
    let (seed_w, seed_h) = ctx.viewport_css();
    let seed_meta = seed_metadata(seed_w, seed_h);
    // …and the same box seeds the server-side clamp, so input mapping is right
    // BEFORE frame #1 rather than after the page next repaints.
    let mut viewport = Viewport::from_metadata(&seed_meta).unwrap_or_default();
    if socket
        .send(
            ServerMsg::Target {
                session,
                url,
                width: seed_w,
                height: seed_h,
            }
            .to_frame(),
        )
        .await
        .is_err()
    {
        return Outcome::SendFailed;
    }
    if let Ok(still) = ctx.screenshot().await {
        if socket
            .send(
                ServerMsg::Frame {
                    data: &still,
                    metadata: &seed_meta,
                }
                .to_frame(),
            )
            .await
            .is_err()
        {
            return Outcome::SendFailed;
        }
    }
    if socket
        .send(ServerMsg::Mode { mode: ctx.mode() }.to_frame())
        .await
        .is_err()
    {
        return Outcome::SendFailed;
    }

    // **What this relay can do beyond pixels** (P4), once per socket. Without
    // it the client cannot tell "this server does not do find" from "it has not
    // answered yet", and it defaults to CANNOT — so this single frame is what
    // turns the find bar and the copy-selection control from disabled shells
    // into live ones. Sent after the seed rather than before it so the very
    // first frame a client sees is still the `target` it sizes its canvas from.
    if socket
        .send(
            ServerMsg::Caps {
                find: true,
                copy: true,
            }
            .to_frame(),
        )
        .await
        .is_err()
    {
        return Outcome::SendFailed;
    }

    // **The live address bar** (P1-5). `watch` semantics do the seeding for us:
    // a receiver is handed the CURRENT state, so a client attaching to a page
    // that has not moved in an hour still gets a url, a title, a favicon and
    // honest back/forward affordances — and one that attaches to a page already
    // blocked on an `alert()` is told so by its first nav frame.
    let mut nav = match ctx.watch_nav().await {
        Ok(rx) => Some(rx),
        Err(e) => {
            // Not fatal: the canvas, the input relay and the mode pill all still
            // work. The client falls back to the `Target` seed's url.
            warn!(session = %session, error = %e, "browser takeover: nav watcher");
            None
        }
    };
    if let Some(rx) = nav.as_mut() {
        let seed = rx.borrow_and_update().clone();
        if socket
            .send(ServerMsg::NavState(&seed).to_frame())
            .await
            .is_err()
        {
            return Outcome::SendFailed;
        }
    }

    // The screencast, with the ack handed to US (see the module docs on
    // backpressure).
    // Start on the **watch** profile: it is what the in-chat card wants and all
    // it will ever ask for, and it is the honest default for a client that has
    // not yet told us how big it is. A workspace viewport upgrades itself one
    // round trip later with a `viewport` frame.
    let mut frames = match ctx
        .start_screencast(Actor::Human, screencast_profile(None))
        .await
    {
        Ok(rx) => rx,
        Err(e) => {
            warn!(session = %session, error = %e, "browser takeover: startScreencast failed");
            return Outcome::StartFailed;
        }
    };

    let mut modes = ctx.lock().subscribe();
    // The newest ack token, kept so DROPPED frames can still be acked — an
    // unacked frame permanently stalls chrome's 2-slot in-flight window.
    let mut last_ack: Option<Value> = None;
    // When we last put a drifted capture back, and how many tries in a row have
    // not stuck — see the frame arm below.
    let mut repaired_at: Option<Instant> = None;
    let mut repairs: u32 = 0;

    let mut last_inbound = Instant::now();
    let mut ping = tokio::time::interval(PING_EVERY);
    ping.set_missed_tick_behavior(MissedTickBehavior::Skip);
    ping.tick().await;

    loop {
        tokio::select! {
            inbound = socket.recv() => {
                match inbound {
                    None | Some(Err(_)) | Some(Ok(Message::Close(_))) => {
                        return Outcome::ClientClosed;
                    }
                    Some(Ok(Message::Text(t))) => {
                        last_inbound = Instant::now();
                        let Ok(msg) = serde_json::from_str::<ClientMsg>(t.as_str()) else {
                            // Unknown/garbled frame: a no-op, exactly like the
                            // other sockets. It still counts as liveness.
                            continue;
                        };
                        match msg {
                            ClientMsg::HandBack => {
                                // THE explicit hand-off: the human pressed the
                                // button. The only exit that may be reported to
                                // a parked agent as "the human finished".
                                ctx.lock().release_to_agent(HandOff::Explicit);
                                continue;
                            }
                            ClientMsg::TakeOver => {
                                ctx.lock().request_human_takeover();
                                continue;
                            }
                            ClientMsg::Resync => {
                                if let Ok(still) = ctx.screenshot().await {
                                    // The live box, not `{}` — a resync that
                                    // cannot be mapped is a resync that breaks
                                    // clicking on a static page.
                                    let (w, h) = ctx.viewport_css();
                                    let meta = seed_metadata(w, h);
                                    if socket.send(ServerMsg::Frame { data: &still, metadata: &meta }.to_frame()).await.is_err() {
                                        return Outcome::SendFailed;
                                    }
                                }
                                continue;
                            }
                            ClientMsg::Viewport { width, height, dpr, mobile } => {
                                // **This is the legibility path.** A control
                                // frame, deliberately handled ABOVE the drive
                                // gate: a watcher who never pressed Drive still
                                // needs the page to lay out at their screen's
                                // size, or they are reading a 1366px render
                                // squeezed into a phone.
                                let Some(req) = ViewportRequest::sanitized(width, height, dpr, mobile) else {
                                    continue;
                                };
                                // 1. Lay the PAGE out at the viewer's box. Half
                                //    of readability, and all of "a phone gets
                                //    the mobile site".
                                if let Err(e) = ctx
                                    .set_viewport_scaled(Actor::Human, req.width, req.height, req.dpr, req.mobile)
                                    .await
                                {
                                    debug!(session = %session, error = %e, "browser takeover: setDeviceMetricsOverride");
                                    continue;
                                }
                                // 2. The clamp follows immediately — we KNOW the
                                //    box we just set, so there is no window in
                                //    which input maps to the old one.
                                viewport = Viewport { width: f64::from(req.width), height: f64::from(req.height) };
                                // 3. Re-cap the stream to match. The other half:
                                //    a matching cap is what keeps the frame 1:1
                                //    instead of a downscale of the new render.
                                match ctx.start_screencast(Actor::Human, screencast_profile(Some(req))).await {
                                    Ok(rx) => frames = rx,
                                    Err(e) => {
                                        warn!(session = %session, error = %e, "browser takeover: screencast renegotiate");
                                    }
                                }
                                // 4. A static page emits NO frames (gotcha #1),
                                //    so without a still the resize would be
                                //    invisible until something moved.
                                let meta = seed_metadata(req.width, req.height);
                                if let Ok(still) = ctx.screenshot().await {
                                    if socket.send(ServerMsg::Frame { data: &still, metadata: &meta }.to_frame()).await.is_err() {
                                        return Outcome::SendFailed;
                                    }
                                }
                                // 5. And say what it is now looking at — the
                                //    seed's `Target` was the OLD size, and the
                                //    url may have moved since.
                                let url = ctx.current_url().await.unwrap_or_default();
                                if socket
                                    .send(ServerMsg::Target { session, url, width: req.width, height: req.height }.to_frame())
                                    .await
                                    .is_err()
                                {
                                    return Outcome::SendFailed;
                                }
                                continue;
                            }
                            // ── navigation controls (P1-4) ─────────────────
                            //
                            // Handled HERE, above the drive gate, and NOT routed
                            // through `to_cdp`: they are page commands, not input
                            // events, and `dispatch_input`'s allowlist is `Input.*`.
                            //
                            // Above the gate on purpose. The REST door
                            // (`api::navigate_handler`) moves a page without
                            // grabbing the wheel — deliberately, so that typing an
                            // address does not silently lock every granted agent
                            // out of the tab. A WS `navigate` that refused what the
                            // identical REST call accepts would be incoherent, not
                            // safer, and the human owns the browser either way.
                            ClientMsg::Navigate { url } => {
                                // The same scheme gate the REST route applies, for
                                // the same reason: `file:`/`data:` in a profile that
                                // IS the human's cookie jar is a local-read
                                // escalation, not navigation.
                                let url = url.trim().to_string();
                                if super::tools::host_of(&url).is_none() {
                                    let no = ServerMsg::Refused { reason: "only http(s) URLs" };
                                    if socket.send(no.to_frame()).await.is_err() {
                                        return Outcome::SendFailed;
                                    }
                                    continue;
                                }
                                spawn_nav(ctx, session, NavCmd::Go(url));
                                continue;
                            }
                            ClientMsg::Back => {
                                spawn_nav(ctx, session, NavCmd::Step(-1));
                                continue;
                            }
                            ClientMsg::Forward => {
                                spawn_nav(ctx, session, NavCmd::Step(1));
                                continue;
                            }
                            ClientMsg::Reload { ignore_cache } => {
                                spawn_nav(ctx, session, NavCmd::Reload(ignore_cache));
                                continue;
                            }
                            ClientMsg::Stop => {
                                spawn_nav(ctx, session, NavCmd::Stop);
                                continue;
                            }
                            // Answering a modal is never gated on the wheel: an
                            // `alert()` blocks the RENDERER, so a watcher with no
                            // way to dismiss one is a watcher of a frozen page.
                            ClientMsg::Dialog { accept, prompt_text } => {
                                spawn_nav(ctx, session, NavCmd::Dialog { accept, prompt_text });
                                continue;
                            }
                            // ── the DOM verbs (P4) ─────────────────────────
                            //
                            // GATED, unlike the navigation controls above, and
                            // deliberately: those move an address bar the human
                            // owns, while these two touch the PAGE's own state.
                            // A find replaces the selection and scrolls
                            // somebody's document; a copy reads the content of a
                            // signed-in surface out of the browser. Both are
                            // human actions on a page an agent may be working,
                            // so both wait for the wheel — and the refusal is
                            // spoken, not silent, because a find bar with no
                            // answer spins forever.
                            ClientMsg::Find { query, forward, case_sensitive } => {
                                if !human_may_drive(ctx.mode()) {
                                    let no = ServerMsg::Refused { reason: "agent is driving" };
                                    if socket.send(no.to_frame()).await.is_err() {
                                        return Outcome::SendFailed;
                                    }
                                    continue;
                                }
                                // An over-long needle is answered "no matches"
                                // WITHOUT walking the page: a 4 KiB string is a
                                // paste accident, not a search, and the answer
                                // it would get is the one we give.
                                let (index, total) = if query.is_empty() || query.len() > MAX_QUERY_BYTES {
                                    (0, 0)
                                } else {
                                    match ctx.evaluate(&find_script(&query, forward, case_sensitive)).await {
                                        Ok(v) => find_counts(&v),
                                        Err(e) => {
                                            debug!(subject = %session, error = %e, "browser takeover: find");
                                            (0, 0)
                                        }
                                    }
                                };
                                // ALWAYS answer, even for a failed evaluate. The
                                // bar shows `…` until the server has spoken for
                                // THIS query, so a dropped answer is a spinner
                                // that never stops — the exact failure the caps
                                // frame exists to prevent.
                                let out = ServerMsg::FindResult { query: &query, index, total };
                                if socket.send(out.to_frame()).await.is_err() {
                                    return Outcome::SendFailed;
                                }
                                continue;
                            }
                            // UNGATED, on purpose: it only ever REMOVES what our
                            // own find put on the page. Refusing it because the
                            // wheel moved mid-search would leave a highlight
                            // behind a bar that is gone.
                            ClientMsg::FindClose => {
                                if let Err(e) = ctx.evaluate(find_clear_script()).await {
                                    debug!(subject = %session, error = %e, "browser takeover: find_close");
                                }
                                continue;
                            }
                            ClientMsg::Copy => {
                                if !human_may_drive(ctx.mode()) {
                                    let no = ServerMsg::Refused { reason: "agent is driving" };
                                    if socket.send(no.to_frame()).await.is_err() {
                                        return Outcome::SendFailed;
                                    }
                                    continue;
                                }
                                // An in-page READ, nothing else: the server never
                                // fetches the selection's target, it asks the page
                                // what is selected. An empty answer is honest and
                                // the client handles it.
                                let text = match ctx.evaluate(&copy_script()).await {
                                    Ok(v) => v.as_str().unwrap_or_default().to_string(),
                                    Err(e) => {
                                        debug!(subject = %session, error = %e, "browser takeover: copy");
                                        String::new()
                                    }
                                };
                                let out = clip(&text, MAX_COPY_BYTES);
                                if !out.is_empty() {
                                    spawn_copy_audit(
                                        state,
                                        subject.audit_target(),
                                        out.chars().count(),
                                        out.len(),
                                        out.len() < text.len(),
                                    );
                                }
                                if socket.send(ServerMsg::Copied { text: out }.to_frame()).await.is_err() {
                                    return Outcome::SendFailed;
                                }
                                continue;
                            }
                            ClientMsg::Auth { .. } | ClientMsg::Ping => continue,
                            _ => {}
                        }
                        // THE GATE. The human's own events are never gated by
                        // `Actor::Human` (that is the point of the escalation
                        // path), so the mode is checked HERE: if the wheel is
                        // not ours — a `hand_back` landed, or the context was
                        // released underneath us — the event is dropped and the
                        // client is told why, rather than silently racing the
                        // agent for the same page.
                        if !human_may_drive(ctx.mode()) {
                            if socket
                                .send(ServerMsg::Refused { reason: "agent is driving" }.to_frame())
                                .await
                                .is_err()
                            {
                                return Outcome::SendFailed;
                            }
                            continue;
                        }
                        if let Some((method, params)) = to_cdp(&msg, viewport) {
                            if let Err(e) = ctx.dispatch_input(Actor::Human, method, params).await {
                                debug!(session = %session, method, error = %e, "browser takeover: input");
                            }
                        }
                    }
                    Some(Ok(_)) => { last_inbound = Instant::now(); }
                }
            }

            frame = frames.recv() => {
                match frame {
                    Ok(f) => {
                        if let Some(vp) = Viewport::from_metadata(&f.metadata) {
                            viewport = vp;
                        }
                        if f.ack.is_some() {
                            last_ack = f.ack.clone();
                        }
                        let sent = socket
                            .send(ServerMsg::Frame { data: &f.data, metadata: &f.metadata }.to_frame())
                            .await;
                        // Ack AFTER the socket accepted it — the whole point of
                        // `AckPolicy::Viewer`. On a send failure we are leaving
                        // anyway, so the unacked frame is irrelevant.
                        if sent.is_err() {
                            return Outcome::SendFailed;
                        }
                        if let Some(ack) = &f.ack {
                            let _ = ctx.ack_frame(ack);
                        }
                        // ── **the black band** ─────────────────────────────
                        //
                        // A main-frame commit drops the emulated size off the
                        // CAPTURE while leaving it on the document, so a page
                        // laid out at 390×700 starts arriving as a 1366×757
                        // window frame with the mobile page in its corner —
                        // which `fitFrame` letterboxes into a short band at the
                        // top of a tall viewport with the box's background
                        // under it. Nothing announces the drop, so the frame's
                        // own `deviceWidth/deviceHeight` is the error signal:
                        // it disagrees with the box we told chrome to lay the
                        // page out at, and that disagreement is the bug.
                        //
                        // Detected HERE rather than in the screencast pump
                        // because only this side can do the second half: a
                        // resize on a static page emits no frame of its own
                        // (gotcha #1), so an article would keep the band until
                        // the human scrolled it — which is exactly what the bug
                        // looked like. The still is what makes the repair
                        // visible.
                        if !capture_mismatch(Some(&f.metadata), ctx.viewport_css()) {
                            // Back at the box we set: whatever we did worked, so
                            // the next drift gets a full budget again.
                            repairs = 0;
                        } else if repairs < CAPTURE_REPAIR_TRIES
                            && repaired_at.is_none_or(|at| at.elapsed() >= CAPTURE_REPAIR_COOLDOWN)
                        {
                            repaired_at = Some(Instant::now());
                            repairs += 1;
                            if let Err(e) = ctx.repair_capture().await {
                                debug!(session = %session, error = %e, "browser takeover: capture repair");
                            } else {
                                let (w, h) = ctx.viewport_css();
                                // The frame above already moved the input clamp
                                // to the WINDOW's box; put it back, or every
                                // click between here and the next good frame
                                // lands scaled wrong.
                                viewport = Viewport { width: f64::from(w), height: f64::from(h) };
                                let meta = seed_metadata(w, h);
                                if let Ok(still) = ctx.screenshot().await {
                                    if socket
                                        .send(ServerMsg::Frame { data: &still, metadata: &meta }.to_frame())
                                        .await
                                        .is_err()
                                    {
                                        return Outcome::SendFailed;
                                    }
                                }
                            }
                        }
                    }
                    Err(RecvError::Lagged(n)) => {
                        // Dropped `n` frames we never saw. Their acks are still
                        // owed (an ack is a counter decrement, not a receipt),
                        // so pay them with the last token we hold or chrome
                        // never sends another frame.
                        debug!(session = %session, dropped = n, "browser takeover: frame lag");
                        if let Some(ack) = &last_ack {
                            for _ in 0..n {
                                let _ = ctx.ack_frame(ack);
                            }
                        }
                    }
                    Err(RecvError::Closed) => return Outcome::ScreencastGone,
                }
            }

            // The address bar's own feed. `Option` because a page whose watcher
            // failed to start still deserves a working canvas; `pending()` parks
            // this arm forever in that case instead of spinning.
            changed = async {
                match nav.as_mut() {
                    Some(rx) => rx.changed().await.is_ok(),
                    None => std::future::pending().await,
                }
            } => {
                if !changed {
                    // The watcher died (the context is going away). The canvas
                    // and the mode pill are still live, so keep the socket and
                    // stop pushing an address bar we no longer have.
                    nav = None;
                    continue;
                }
                let state = match nav.as_mut() {
                    Some(rx) => rx.borrow_and_update().clone(),
                    None => continue,
                };
                if socket.send(ServerMsg::NavState(&state).to_frame()).await.is_err() {
                    return Outcome::SendFailed;
                }
            }

            changed = modes.changed() => {
                if changed.is_err() {
                    return Outcome::ScreencastGone;
                }
                let mode = *modes.borrow_and_update();
                if socket.send(ServerMsg::Mode { mode }.to_frame()).await.is_err() {
                    return Outcome::SendFailed;
                }
            }

            _ = ping.tick() => {
                if last_inbound.elapsed() > PONG_DEADLINE {
                    close(socket, close_code::AWAY, "ping timeout").await;
                    return Outcome::PingTimeout;
                }
                if socket.send(Message::Ping(bytes::Bytes::new())).await.is_err() {
                    return Outcome::SendFailed;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(s: &str) -> ClientMsg {
        serde_json::from_str(s).expect("client frame")
    }

    // ── the viewer's box: profiles, seeds, control-frame handling ───────

    #[test]
    fn a_viewport_frame_is_a_control_frame_and_takes_either_field_spelling() {
        // The web half is free to send `width`/`height` or `w`/`h`; both must
        // land on the same message, and neither may reach `dispatch_input`.
        let long = parse(r#"{"type":"viewport","width":1200,"height":800,"dpr":2,"mobile":false}"#);
        let short = parse(r#"{"type":"viewport","w":1200,"h":800,"dpr":2}"#);
        for msg in [&long, &short] {
            let ClientMsg::Viewport { width, height, dpr, mobile } = msg else {
                panic!("not a viewport frame");
            };
            assert_eq!((*width, *height), (1200, 800));
            assert_eq!(*dpr, 2.0);
            assert!(!*mobile);
            assert!(to_cdp(msg, Viewport::default()).is_none(), "control frame");
        }
        // dpr is optional: absent means "unknown", i.e. 1.0 — never 0.
        let bare = parse(r#"{"type":"viewport","width":390,"height":844,"mobile":true}"#);
        let ClientMsg::Viewport { dpr, mobile, .. } = bare else {
            panic!("not a viewport frame");
        };
        assert_eq!(dpr, 1.0);
        assert!(mobile);
    }

    #[test]
    fn an_unusable_box_is_ignored_rather_than_applied() {
        // A client that has not laid itself out yet routinely sends 0×0 on
        // attach. Resizing the page to nothing would be worse than waiting.
        assert!(ViewportRequest::sanitized(0, 800, 2.0, false).is_none());
        assert!(ViewportRequest::sanitized(1200, 0, 2.0, false).is_none());
        // Absurd or non-finite values are clamped, not trusted.
        let tiny = ViewportRequest::sanitized(10, 10, f64::NAN, false).unwrap();
        assert_eq!((tiny.width, tiny.height), (ViewportRequest::MIN_CSS, ViewportRequest::MIN_CSS));
        assert_eq!(tiny.dpr, 1.0, "NaN dpr falls back to 1:1");
        let huge = ViewportRequest::sanitized(99_999, 99_999, 9.0, false).unwrap();
        assert_eq!((huge.width, huge.height), (ViewportRequest::MAX_CSS, ViewportRequest::MAX_CSS));
        assert_eq!(huge.dpr, 2.0, "the render scale is capped");
    }

    #[test]
    fn the_watch_profile_is_todays_stream_and_the_drive_profile_is_the_viewers() {
        // WATCH — the in-chat takeover card. Nothing about it may move: the
        // agent path is not the thing being fixed here.
        let watch = screencast_profile(None);
        assert_eq!(watch.max_width, 512);
        assert_eq!(watch.max_height, 512);
        assert_eq!(watch.quality, 60);
        assert_eq!(watch.every_nth_frame, 1);
        assert_eq!(watch.ack, AckPolicy::Viewer, "this socket always owns the ack");
        assert_eq!(
            ScreencastOptions { ack: AckPolicy::Immediate, ..watch },
            ScreencastOptions::default(),
            "byte for byte the profile the card streams today",
        );

        // DRIVE — a laptop viewport at 1:1. The cap is the viewer's REAL
        // pixels, so the frame is not a downscale of the render.
        let laptop = screencast_profile(Some(
            ViewportRequest::sanitized(1200, 800, 1.0, false).unwrap(),
        ));
        assert_eq!((laptop.max_width, laptop.max_height), (1200, 800));
        assert_eq!(laptop.quality, 75);
        assert!(laptop.every_nth_frame > 1, "sharp frames over many frames");

        // A retina viewer gets its own pixels…
        let retina = screencast_profile(Some(
            ViewportRequest::sanitized(700, 500, 2.0, false).unwrap(),
        ));
        assert_eq!((retina.max_width, retina.max_height), (1400, 1000));

        // …up to the cap, past which a sharper frame buys nothing visible.
        let wall = screencast_profile(Some(
            ViewportRequest::sanitized(1500, 1200, 2.0, false).unwrap(),
        ));
        assert_eq!(wall.max_width, ScreencastOptions::MAX_STREAM_PX);
        assert_eq!(wall.max_height, ScreencastOptions::MAX_STREAM_PX);
    }

    #[test]
    fn a_phone_box_stays_a_phone_box() {
        // The point of `mobile`: 390 CSS px must reach the page as 390, so the
        // site serves its phone layout — never 1366 shrunk into a canvas.
        let req = ViewportRequest::sanitized(390, 844, 3.0, true).unwrap();
        assert_eq!((req.width, req.height), (390, 844));
        assert!(req.mobile);
        let profile = screencast_profile(Some(req));
        assert_eq!(profile.max_width, 780, "390 CSS px at the capped 2× scale");
        assert_eq!(profile.max_height, 1600, "844 × 2 clamped to the stream cap");
    }

    #[test]
    fn the_seed_metadata_is_mappable_and_clamps_immediately() {
        // The defect: `{}` made `from_metadata` fail, so the clamp stayed at
        // COORD_CEILING and every pre-frame-1 click landed in the wrong place.
        assert!(Viewport::from_metadata(&json!({})).is_none());
        let meta = seed_metadata(1200, 800);
        let vp = Viewport::from_metadata(&meta).expect("a mappable seed");
        assert_eq!((vp.width, vp.height), (1200.0, 800.0));
        assert_eq!(meta["offsetTop"], json!(0), "a still has no browser chrome above it");
        assert_eq!(meta["pageScaleFactor"], json!(1));
        // …and the clamp that follows is the page's, not the 100_000 fallback.
        assert_eq!(vp.clamp(5_000.0, -1.0), (1200.0, 0.0));
        assert_eq!(Viewport::default().clamp(5_000.0, 5_000.0), (5_000.0, 5_000.0));
    }

    #[test]
    fn a_zero_sized_context_still_yields_a_usable_fallback_clamp() {
        // A context whose metrics we somehow do not know must not produce a
        // metadata box that maps everything to (0, 0).
        let meta = seed_metadata(0, 0);
        assert!(Viewport::from_metadata(&meta).is_none());
        let vp = Viewport::from_metadata(&meta).unwrap_or_default();
        assert_eq!(vp.width, COORD_CEILING);
    }

    #[test]
    fn a_tap_becomes_a_clamped_left_press() {
        let vp = Viewport { width: 400.0, height: 300.0 };
        let msg = parse(r#"{"type":"mouse","kind":"down","x":9999,"y":-5}"#);
        let (method, params) = to_cdp(&msg, vp).expect("a CDP call");
        assert_eq!(method, "Input.dispatchMouseEvent");
        assert_eq!(params["type"], "mousePressed");
        assert_eq!(params["x"], json!(400.0), "clamped to the live viewport");
        assert_eq!(params["y"], json!(0.0), "negative clamps to the top edge");
        assert_eq!(params["button"], "left");
        assert_eq!(params["clickCount"], json!(1), "a press must count as a click");
    }

    #[test]
    fn a_hover_carries_no_button_and_no_click_count() {
        let msg = parse(r#"{"type":"mouse","kind":"move","x":10,"y":20}"#);
        let (_, params) = to_cdp(&msg, Viewport::default()).unwrap();
        assert_eq!(params["type"], "mouseMoved");
        assert_eq!(params["button"], "none");
        assert_eq!(params["clickCount"], json!(0));
    }

    #[test]
    fn non_finite_coordinates_never_reach_cdp() {
        // `NaN`/`Infinity` are not JSON literals, but a client can produce them
        // as an overflowing float; the clamp is the guard either way.
        let vp = Viewport { width: 100.0, height: 100.0 };
        assert_eq!(vp.clamp(f64::NAN, f64::INFINITY), (0.0, 0.0));
        assert_eq!(vp.clamp(-1.0, 1e300), (0.0, 100.0));
    }

    #[test]
    fn a_text_key_is_keydown_and_a_bare_key_is_rawkeydown() {
        let typed = parse(r#"{"type":"key","kind":"down","key":"a","code":"KeyA","key_code":65,"text":"a"}"#);
        let (_, params) = to_cdp(&typed, Viewport::default()).unwrap();
        assert_eq!(params["type"], "keyDown");
        assert_eq!(params["text"], "a");
        assert_eq!(params["code"], "KeyA");

        let bare = parse(r#"{"type":"key","kind":"down","key":"ArrowLeft","code":"ArrowLeft","key_code":37}"#);
        let (_, params) = to_cdp(&bare, Viewport::default()).unwrap();
        assert_eq!(params["type"], "rawKeyDown");
        assert!(params.get("text").is_none());

        let up = parse(r#"{"type":"key","kind":"up","key":"a","code":"KeyA","key_code":65,"text":"a"}"#);
        let (_, params) = to_cdp(&up, Viewport::default()).unwrap();
        assert_eq!(params["type"], "keyUp");
    }

    #[test]
    fn touch_end_sends_an_empty_point_list() {
        let start = parse(r#"{"type":"touch","kind":"start","x":5,"y":6}"#);
        let (method, params) = to_cdp(&start, Viewport::default()).unwrap();
        assert_eq!(method, "Input.dispatchTouchEvent");
        assert_eq!(params["touchPoints"][0]["x"], json!(5.0));
        let end = parse(r#"{"type":"touch","kind":"end"}"#);
        let (_, params) = to_cdp(&end, Viewport::default()).unwrap();
        assert_eq!(params["type"], "touchEnd");
        assert_eq!(params["touchPoints"], json!([]));
    }

    #[test]
    fn oversized_text_is_clipped_on_a_char_boundary() {
        let long = "é".repeat(MAX_TEXT_BYTES); // 2 bytes each
        let msg = ClientMsg::Text { text: long };
        let (method, params) = to_cdp(&msg, Viewport::default()).unwrap();
        assert_eq!(method, "Input.insertText");
        let out = params["text"].as_str().unwrap();
        assert!(out.len() <= MAX_TEXT_BYTES);
        assert!(out.chars().all(|c| c == 'é'), "never split a code point");
    }

    #[test]
    fn control_frames_dispatch_nothing() {
        for raw in [
            r#"{"type":"hand_back"}"#,
            r#"{"type":"take_over"}"#,
            r#"{"type":"resync"}"#,
            r#"{"type":"viewport","width":1200,"height":800,"dpr":2}"#,
            r#"{"type":"ping"}"#,
            r#"{"type":"auth","token":"x"}"#,
            // The P1-4 navigation controls. They are page COMMANDS, and
            // `to_cdp` builds `Input.*` payloads — one of which reaching
            // `dispatch_input` would be refused by its allowlist anyway, so
            // this pins the routing rather than trusting the allowlist to.
            r#"{"type":"navigate","url":"https://example.test/"}"#,
            r#"{"type":"back"}"#,
            r#"{"type":"forward"}"#,
            r#"{"type":"reload"}"#,
            r#"{"type":"reload","ignore_cache":true}"#,
            r#"{"type":"stop"}"#,
            r#"{"type":"dialog","accept":true}"#,
            r#"{"type":"dialog","accept":true,"prompt_text":"hello"}"#,
        ] {
            assert!(to_cdp(&parse(raw), Viewport::default()).is_none(), "{raw}");
        }
    }

    #[test]
    fn the_navigation_controls_parse_into_the_commands_drive_runs() {
        let ClientMsg::Navigate { url } = parse(r#"{"type":"navigate","url":"https://example.test/x"}"#)
        else {
            panic!("not a navigate")
        };
        assert_eq!(url, "https://example.test/x");

        // A bare reload is the SOFT one: `ignore_cache` defaults to false, so a
        // client that omits it never accidentally asks for a cache-busting
        // reload of a page it just loaded.
        let ClientMsg::Reload { ignore_cache } = parse(r#"{"type":"reload"}"#) else {
            panic!("not a reload")
        };
        assert!(!ignore_cache);
        let ClientMsg::Reload { ignore_cache } = parse(r#"{"type":"reload","ignore_cache":true}"#)
        else {
            panic!("not a reload")
        };
        assert!(ignore_cache);

        assert!(matches!(parse(r#"{"type":"back"}"#), ClientMsg::Back));
        assert!(matches!(parse(r#"{"type":"forward"}"#), ClientMsg::Forward));
        assert!(matches!(parse(r#"{"type":"stop"}"#), ClientMsg::Stop));

        // A dialog answer defaults to DISMISS: a garbled frame must not accept
        // a `beforeunload` on the human's behalf.
        let ClientMsg::Dialog { accept, prompt_text } = parse(r#"{"type":"dialog"}"#) else {
            panic!("not a dialog")
        };
        assert!(!accept);
        assert_eq!(prompt_text, None);
        let ClientMsg::Dialog { accept, prompt_text } =
            parse(r#"{"type":"dialog","accept":true,"prompt_text":"hi"}"#)
        else {
            panic!("not a dialog")
        };
        assert!(accept);
        assert_eq!(prompt_text.as_deref(), Some("hi"));
    }

    #[test]
    fn a_nav_control_is_never_an_input_method() {
        // The other half of the routing rule: whatever a navigation control
        // does, it must not be reachable through the relay's CDP allowlist.
        for method in AgentContext::INPUT_METHODS {
            assert!(method.starts_with("Input."), "{method}");
        }
    }

    #[test]
    fn every_dispatched_method_is_on_the_context_allowlist() {
        // The gate in `AgentContext::dispatch_input` is only as good as this
        // agreement: anything this module can emit must be allowed there.
        for raw in [
            r#"{"type":"mouse","kind":"down","x":1,"y":1}"#,
            r#"{"type":"wheel","x":1,"y":1,"dy":10}"#,
            r#"{"type":"key","kind":"down","key":"a","code":"KeyA","key_code":65,"text":"a"}"#,
            r#"{"type":"text","text":"hi"}"#,
            r#"{"type":"touch","kind":"start","x":1,"y":1}"#,
        ] {
            let (method, _) = to_cdp(&parse(raw), Viewport::default()).unwrap();
            assert!(
                AgentContext::INPUT_METHODS.contains(&method),
                "{method} is not allowlisted"
            );
        }
    }

    #[test]
    fn viewport_comes_from_the_frame_metadata() {
        let meta = json!({ "deviceWidth": 512, "deviceHeight": 384, "pageScaleFactor": 1, "offsetTop": 0 });
        let vp = Viewport::from_metadata(&meta).expect("a viewport");
        assert_eq!((vp.width, vp.height), (512.0, 384.0));
        assert!(Viewport::from_metadata(&json!({})).is_none());
        assert!(
            Viewport::from_metadata(&json!({ "deviceWidth": 0, "deviceHeight": 0 })).is_none(),
            "a zero box would make every clamp collapse to the origin"
        );
    }

    #[test]
    fn the_viewer_slot_admits_exactly_one() {
        let first = ViewerSlot::claim("solo").expect("first in");
        assert!(ViewerSlot::claim("solo").is_none(), "second must be refused");
        assert!(ViewerSlot::claim("other").is_some(), "other sessions unaffected");
        drop(first);
        assert!(ViewerSlot::claim("solo").is_some(), "slot frees on drop");
    }

    #[test]
    fn the_relay_gate_tracks_the_mode() {
        assert!(human_may_drive(DriveMode::HumanDriving));
        assert!(
            !human_may_drive(DriveMode::AgentDriving),
            "after hand_back the canvas must go read-only"
        );
    }

    // ── the DOM verbs (P4) ──────────────────────────────────────────────────

    #[test]
    fn the_dom_verbs_parse_exactly_as_the_client_spells_them() {
        // Byte-for-byte the payloads `web/src/lib/browser/page-tools.ts` builds
        // (`findPayload` / `findClosePayload` / `copyPayload`). The day either
        // side renames a field, this fails instead of the frame being silently
        // dropped as garbled.
        let ClientMsg::Find { query, forward, case_sensitive } =
            parse(r#"{"type":"find","query":"needle","forward":true,"case_sensitive":false}"#)
        else {
            panic!("not a find");
        };
        assert_eq!((query.as_str(), forward, case_sensitive), ("needle", true, false));

        let ClientMsg::Find { forward, case_sensitive, .. } =
            parse(r#"{"type":"find","query":"n","forward":false,"case_sensitive":true}"#)
        else {
            panic!("not a find");
        };
        assert!(!forward, "shift-Enter searches backwards");
        assert!(case_sensitive);

        // A hand-written frame that omits the flags means the ordinary Enter.
        let ClientMsg::Find { forward, case_sensitive, .. } = parse(r#"{"type":"find","query":"n"}"#)
        else {
            panic!("not a find");
        };
        assert!(forward, "a missing direction is DOWN, not up");
        assert!(!case_sensitive, "a missing Aa toggle is off");

        assert!(matches!(parse(r#"{"type":"find_close"}"#), ClientMsg::FindClose));
        assert!(matches!(parse(r#"{"type":"copy"}"#), ClientMsg::Copy));
    }

    #[test]
    fn the_dom_verbs_are_control_frames_and_never_reach_dispatch_input() {
        // `dispatch_input`'s allowlist is `Input.*`. Find and copy run through
        // `Runtime.evaluate` in `drive`, so `to_cdp` must refuse to translate
        // them at all — a `Runtime.*` leaking into the input path would be a
        // hole in that allowlist.
        for raw in [
            r#"{"type":"find","query":"x","forward":true,"case_sensitive":false}"#,
            r#"{"type":"find_close"}"#,
            r#"{"type":"copy"}"#,
        ] {
            assert!(
                to_cdp(&parse(raw), Viewport::default()).is_none(),
                "{raw} must be handled by drive(), not forwarded as input"
            );
        }
    }

    #[test]
    fn the_phase_four_frames_are_the_shapes_the_client_parses() {
        // `page-tools.ts::parseCaps` / `parseFindResult`, and the `copied` arm
        // of `takeover-socket.ts::receive`.
        let caps = serde_json::to_string(&ServerMsg::Caps { find: true, copy: true }).unwrap();
        assert_eq!(caps, r#"{"type":"caps","find":true,"copy":true}"#);

        let found = serde_json::to_string(&ServerMsg::FindResult {
            query: "needle",
            index: 2,
            total: 7,
        })
        .unwrap();
        assert_eq!(
            found,
            r#"{"type":"find_result","query":"needle","index":2,"total":7}"#,
        );

        // No matches: 1-based counting makes `0` the only honest current hit.
        let none = serde_json::to_string(&ServerMsg::FindResult { query: "zz", index: 0, total: 0 })
            .unwrap();
        assert_eq!(none, r#"{"type":"find_result","query":"zz","index":0,"total":0}"#);

        let copied = serde_json::to_string(&ServerMsg::Copied { text: "hi \"there\"" }).unwrap();
        assert_eq!(copied, r#"{"type":"copied","text":"hi \"there\""}"#);
    }

    #[test]
    fn find_counts_never_claim_a_hit_past_the_total() {
        assert_eq!(find_counts(&json!({ "index": 3, "total": 9 })), (3, 9));
        assert_eq!(find_counts(&json!({ "index": 0, "total": 0 })), (0, 0));
        // A page that answered nonsense (or nothing) degrades to "no matches"
        // rather than to a count the bar would paint as fact.
        assert_eq!(find_counts(&json!({})), (0, 0));
        assert_eq!(find_counts(&Value::Null), (0, 0));
        assert_eq!(find_counts(&json!({ "index": -4, "total": -1 })), (0, 0));
        assert_eq!(
            find_counts(&json!({ "index": 12, "total": 3 })),
            (3, 3),
            "4/3 is a count that cannot be true",
        );
    }

    #[test]
    fn the_find_script_embeds_its_needle_as_a_json_literal() {
        // A needle full of quotes and backslashes is a NEEDLE, not a syntax
        // error and not an injection into the page's world.
        let js = find_script("he said \"hi\\\" and left\n", true, false);
        assert!(
            js.contains(r#"const Q = "he said \"hi\\\" and left\n""#),
            "the query must be a JSON string literal: {js}"
        );
        assert!(js.contains("FWD = true") && js.contains("CS = false"));
        assert!(js.contains(&format!("CAP = {FIND_MAX_HITS}")), "the walk is bounded");
        assert!(js.starts_with("(() => {") && js.ends_with("})()"));

        let back = find_script("x", false, true);
        assert!(back.contains("FWD = false") && back.contains("CS = true"));
    }

    #[test]
    fn the_copy_script_caps_the_selection_inside_the_page() {
        let js = copy_script();
        assert!(js.contains("window.getSelection()"), "{js}");
        assert!(
            js.contains(&format!("t.slice(0, {MAX_COPY_CHARS})")),
            "megabytes must never cross the CDP socket: {js}"
        );
        // And the frame itself is byte-capped on top of that.
        let long = "x".repeat(MAX_COPY_BYTES + 512);
        assert_eq!(clip(&long, MAX_COPY_BYTES).len(), MAX_COPY_BYTES);
    }

    #[test]
    fn find_close_only_undoes_our_own_search() {
        let js = find_clear_script();
        assert!(js.contains("removeAllRanges"), "the highlight IS the selection");
        assert!(js.contains("window.__supermuxFind = null"), "and the cursor goes too");
    }

    #[test]
    fn a_copy_is_audited_under_the_ledgers_own_spelling() {
        // `tab:<id>` is what every other browser write uses (`api.rs`), so a
        // copy lands in the same trail as the navigations and grants on that
        // tab; a scratch context has no tab row to hang off.
        assert_eq!(Subject::Tab("tb_abc").audit_target(), "tab:tb_abc");
        assert_eq!(Subject::Session("kim").audit_target(), "session:kim");
        assert_eq!(Subject::Tab("tb_abc").name(), "tb_abc");
        assert_eq!(Subject::Session("kim").name(), "kim");
    }

    #[test]
    fn server_frames_are_the_shapes_the_client_parses() {
        let auth = serde_json::to_string(&ServerMsg::AuthOk).unwrap();
        assert_eq!(auth, r#"{"type":"auth_ok"}"#, "must match the other sockets");
        let mode = serde_json::to_string(&ServerMsg::Mode { mode: DriveMode::HumanDriving }).unwrap();
        assert_eq!(mode, r#"{"type":"mode","mode":"human_driving"}"#);
        let meta = json!({ "deviceWidth": 512 });
        let frame = serde_json::to_string(&ServerMsg::Frame { data: "AAA", metadata: &meta }).unwrap();
        assert!(frame.starts_with(r#"{"type":"frame","data":"AAA""#), "{frame}");
        // `Target` carries the REAL render box — it used to say `0, 0`, which
        // left the client no way to scale its canvas until a frame arrived.
        let target = serde_json::to_string(&ServerMsg::Target {
            session: "s",
            url: "https://example.test/".to_string(),
            width: 1200,
            height: 800,
        })
        .unwrap();
        assert_eq!(
            target,
            r#"{"type":"target","session":"s","url":"https://example.test/","width":1200,"height":800}"#,
        );
    }

    #[test]
    fn the_nav_state_frame_is_flat_and_tagged() {
        // The web client's address bar reads these names off the top level, so
        // the internally-tagged newtype must NOT nest the state under a key.
        let state = NavState {
            url: "https://example.test/inbox".into(),
            title: "Inbox".into(),
            favicon: None,
            loading: true,
            can_go_back: true,
            can_go_forward: false,
            secure: true,
            dialog: None,
        };
        let raw = serde_json::to_string(&ServerMsg::NavState(&state)).unwrap();
        let v: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(v["type"], json!("nav_state"));
        assert_eq!(v["url"], json!("https://example.test/inbox"));
        assert_eq!(v["title"], json!("Inbox"));
        assert_eq!(v["loading"], json!(true));
        assert_eq!(v["can_go_back"], json!(true));
        assert_eq!(v["can_go_forward"], json!(false));
        assert_eq!(v["secure"], json!(true));
        assert_eq!(v["favicon"], Value::Null);
        assert_eq!(v["dialog"], Value::Null);
        assert!(v.get("nav_state").is_none(), "must be flat, not nested: {raw}");
    }
    // ── real-chrome end-to-end (phase 2's whole claim) ──────────────────────

    /// A page that is guaranteed to PRODUCE frames (a CSS animation drives the
    /// compositor; a static page emits one frame and stops — spike gotcha #1)
    /// and that can PROVE input landed (a text input + a click counter).
    fn takeover_page() -> String {
        let html = "<style>body{margin:0}\
@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}\
.s{position:fixed;left:0;top:200px;width:120px;height:120px;background:red;animation:spin 1s linear infinite}\
input{position:fixed;left:0;top:0;width:400px;height:60px;font-size:24px}</style>\
<input id=box><div class=s></div>\
<script>window.taps=0;document.addEventListener('mousedown',function(){window.taps++})</script>";
        format!("data:text/html,{}", html.replace(' ', "%20"))
    }

    /// REAL-CHROME phase-2 end-to-end. Ignored by default (spawns the pinned
    /// `chrome-headless-shell`); run with
    /// `cargo test -- --ignored real_chrome_takeover`.
    ///
    /// Proves the four things the takeover socket exists to do, against a live
    /// browser and with NO mocking of CDP:
    ///
    /// 1. `Page.screencastFrame` events really arrive under
    ///    [`AckPolicy::Viewer`] (frames > 0 over ~2 s) **and** carry an ack
    ///    token, which is what makes viewer-paced backpressure possible.
    /// 2. A human's forwarded `Input.*` — built by the same [`to_cdp`] the
    ///    socket uses — mutates the real DOM while `HumanDriving`.
    /// 3. The agent is REFUSED by the lock on that same page while the human
    ///    holds it, and the DOM proves nothing of the agent's landed.
    /// 4. After a hand-back the relay gate closes, and teardown leaves no
    ///    orphan chrome and no user-data-dir.
    #[tokio::test]
    #[ignore = "spawns a real chrome-headless-shell; run with --ignored on a box that has the pinned binary"]
    async fn real_chrome_takeover_streams_frames_and_accepts_human_input() {
        use super::super::{BrowserConfig, BrowserService};
        use std::time::Duration;

        fn pid_alive(pid: u32) -> bool {
            std::path::Path::new(&format!("/proc/{pid}")).exists()
        }

        // Explicitly ephemeral: this test's teardown assertion is the scratch
        // one (the profile dir is removed), not the workspace one.
        let svc = BrowserService::new(BrowserConfig {
            profile: crate::connectors::browser::launch::ProfileMode::Ephemeral,
            ..BrowserConfig::default()
        });
        let ctx = svc.context_for("takeover").await.expect("context");
        let pid = svc.chrome_pid().await.expect("a chrome pid");
        let udd = svc.user_data_dir().await.expect("a user-data-dir");
        ctx.navigate(Actor::Agent, &takeover_page())
            .await
            .expect("navigate");

        // ── 1. attach: the human grabs the wheel, frames start flowing ──────
        assert_eq!(ctx.lock().request_human_takeover(), DriveMode::AgentDriving);
        let mut frames = ctx
            .start_screencast(
                Actor::Human,
                ScreencastOptions {
                    ack: AckPolicy::Viewer,
                    ..ScreencastOptions::default()
                },
            )
            .await
            .expect("startScreencast");

        let mut count = 0usize;
        let mut viewport = Viewport::default();
        let mut acked = 0usize;
        let window = tokio::time::Instant::now() + Duration::from_secs(2);
        while tokio::time::Instant::now() < window {
            match tokio::time::timeout(Duration::from_millis(400), frames.recv()).await {
                Ok(Ok(f)) => {
                    count += 1;
                    assert!(!f.data.is_empty(), "a frame with no jpeg bytes");
                    if let Some(vp) = Viewport::from_metadata(&f.metadata) {
                        viewport = vp;
                    }
                    // Exactly what the relay does: ack only after "delivery".
                    let ack = f.ack.as_ref().expect("Viewer policy must hand us the ack");
                    ctx.ack_frame(ack).expect("ack");
                    acked += 1;
                }
                Ok(Err(_)) => break,
                Err(_) => break,
            }
        }
        println!("takeover: frames={count} acked={acked} viewport={viewport:?}");
        assert!(count > 0, "NO screencast frames arrived in 2s");
        assert!(
            count > 2,
            "only {count} frames — viewer-acked backpressure is stalling the stream"
        );
        assert!(viewport.width > 0.0, "no frame metadata carried a viewport");

        // ── 2. the human's input mutates the page ───────────────────────────
        for raw in [
            r#"{"type":"mouse","kind":"move","x":30,"y":30}"#,
            r#"{"type":"mouse","kind":"down","x":30,"y":30,"button":"left","buttons":1,"click_count":1}"#,
            r#"{"type":"mouse","kind":"up","x":30,"y":30,"button":"left","buttons":0,"click_count":1}"#,
            r#"{"type":"text","text":"hallo human"}"#,
        ] {
            let (method, params) = to_cdp(&parse(raw), viewport).expect("a CDP call");
            ctx.dispatch_input(Actor::Human, method, params)
                .await
                .unwrap_or_else(|e| panic!("human input {raw} refused: {e}"));
        }
        let typed = ctx
            .evaluate("document.getElementById('box').value")
            .await
            .expect("read back");
        assert_eq!(typed, json!("hallo human"), "human typing did not land");
        let taps = ctx.evaluate("window.taps").await.expect("read taps");
        assert_eq!(taps, json!(1), "the human's click did not reach the page");

        // ── 3. the agent is refused on the same page, and proves it ─────────
        let (method, params) = to_cdp(
            &parse(r#"{"type":"text","text":"AGENT"}"#),
            viewport,
        )
        .unwrap();
        let err = ctx
            .dispatch_input(Actor::Agent, method, params)
            .await
            .expect_err("the agent MUST be refused while a human drives");
        assert!(
            matches!(err, super::super::error::BrowserError::HumanDriving { .. }),
            "wrong refusal: {err:?}"
        );
        let still = ctx
            .evaluate("document.getElementById('box').value")
            .await
            .expect("read back");
        assert_eq!(still, json!("hallo human"), "the agent's input LANDED anyway");

        // ── 4. hand back: the relay gate closes, the agent is served again ──
        assert_eq!(
            ctx.lock().release_to_agent(HandOff::Explicit),
            DriveMode::HumanDriving
        );
        assert!(
            !human_may_drive(ctx.mode()),
            "after hand_back the socket must stop forwarding"
        );
        let (method, params) =
            to_cdp(&parse(r#"{"type":"text","text":"!"}"#), viewport).unwrap();
        ctx.dispatch_input(Actor::Agent, method, params)
            .await
            .expect("the agent drives again once the human let go");

        // ── teardown: no orphan chrome, no profile dir ──────────────────────
        ctx.stop_screencast(Actor::Human).await.expect("stop");
        svc.shutdown().await;
        for _ in 0..50 {
            if !pid_alive(pid) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert!(!pid_alive(pid), "LEAK: chrome pid {pid} still alive");
        assert!(!udd.exists(), "LEAK: user-data-dir {udd:?} survived");
    }

    /// A page whose matches are countable BY EYE: three visible `needle`s (one
    /// of them upper-case), one inside a `display:none` block and one inside a
    /// `<script>` — neither of which a human can be scrolled to, so neither may
    /// be counted.
    fn find_page() -> String {
        let html = "<style>body{margin:0;font:16px sans-serif}.hide{display:none}</style>\
<p>needle one</p><p>a NEEDLE upper</p><p>third needle here</p>\
<p class=hide>needle hidden</p><script>window.junk=1;/*needle*/</script>";
        format!("data:text/html,{}", html.replace(' ', "%20"))
    }

    /// REAL-CHROME phase-4 end-to-end: the find actually counts what a human
    /// sees, the cursor steps and wraps, the current hit becomes the page's
    /// selection (which is both the highlight AND what `copy` reads), and
    /// `find_close` leaves nothing behind.
    #[tokio::test]
    #[ignore = "spawns a real chrome-headless-shell; run with --ignored on a box that has the pinned binary"]
    async fn real_chrome_find_counts_visible_text_and_copy_reads_the_selection() {
        use super::super::{BrowserConfig, BrowserService};

        let svc = BrowserService::new(BrowserConfig {
            profile: crate::connectors::browser::launch::ProfileMode::Ephemeral,
            ..BrowserConfig::default()
        });
        let ctx = svc.context_for("findcopy").await.expect("context");
        ctx.navigate(Actor::Agent, &find_page())
            .await
            .expect("navigate");

        let run = |js: String| {
            let ctx = ctx.clone();
            async move { ctx.evaluate(&js).await.expect("evaluate") }
        };

        // ── 1. the count is what a human can SEE ────────────────────────────
        let first = run(find_script("needle", true, false)).await;
        assert_eq!(
            find_counts(&first),
            (1, 3),
            "the hidden and the scripted match are not matches a human is scrolled to: {first}"
        );

        // ── 2. Enter steps, and wraps ───────────────────────────────────────
        assert_eq!(find_counts(&run(find_script("needle", true, false)).await), (2, 3));
        assert_eq!(find_counts(&run(find_script("needle", true, false)).await), (3, 3));
        assert_eq!(
            find_counts(&run(find_script("needle", true, false)).await),
            (1, 3),
            "the cursor must wrap, not stick at the end"
        );
        // …and shift-Enter steps back over the wrap.
        assert_eq!(find_counts(&run(find_script("needle", false, false)).await), (3, 3));

        // ── 3. the Aa toggle ────────────────────────────────────────────────
        let cased = run(find_script("NEEDLE", true, true)).await;
        assert_eq!(find_counts(&cased), (1, 1), "case-sensitive: {cased}");

        // ── 4. the current hit IS the selection, so copy reads it ───────────
        let copied = run(copy_script()).await;
        assert_eq!(
            copied,
            json!("NEEDLE"),
            "the find's highlight is the page's own selection"
        );

        // ── 5. a miss clears, honestly ──────────────────────────────────────
        let miss = run(find_script("haystack", true, false)).await;
        assert_eq!(find_counts(&miss), (0, 0));
        assert_eq!(run(copy_script()).await, json!(""), "a miss drops the highlight");

        // ── 6. and closing the bar leaves nothing behind ────────────────────
        run(find_script("needle", true, false)).await;
        assert_eq!(run(copy_script()).await, json!("needle"));
        ctx.evaluate(find_clear_script()).await.expect("clear");
        assert_eq!(run(copy_script()).await, json!(""));
        assert_eq!(
            ctx.evaluate("window.__supermuxFind === null").await.unwrap(),
            json!(true),
            "the cursor must not survive the bar"
        );

        svc.shutdown().await;
    }

    // ── P0-2: rehydrate-on-attach, and the line it is NOT drawn on ──────────

    const WS_TOKEN: &str = "takeover-rehydrate-token";

    async fn ws_state() -> (AppState, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("supermux-tab-ws-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let config = crate::config::Config {
            data_dir: dir.clone(),
            bind: "127.0.0.1:0".parse().unwrap(),
            extra_binds: vec![],
            tls: Default::default(),
            auth_token: WS_TOKEN.to_string(),
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

    /// Bind the REAL takeover router on a loopback port — a WS upgrade cannot be
    /// exercised through `oneshot`, and the whole point of this pair of tests is
    /// that the two routes behave differently at the same wire.
    async fn serve(state: &AppState) -> std::net::SocketAddr {
        let app = router_for(state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        addr
    }

    /// Connect, send the in-band auth frame, and return the socket.
    async fn dial(
        addr: std::net::SocketAddr,
        path: &str,
    ) -> tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    > {
        use futures_util::SinkExt;
        let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{addr}{path}"))
            .await
            .expect("ws connect");
        ws.send(tokio_tungstenite::tungstenite::Message::Text(format!(
            r#"{{"type":"auth","token":"{WS_TOKEN}"}}"#
        )))
        .await
        .expect("send auth");
        ws
    }

    /// The next text frame, or the close code, whichever the server sends.
    async fn next_event(
        ws: &mut tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
    ) -> Option<Result<String, u16>> {
        use futures_util::StreamExt;
        use tokio_tungstenite::tungstenite::Message as M;
        loop {
            match tokio::time::timeout(std::time::Duration::from_secs(20), ws.next()).await {
                Ok(Some(Ok(M::Text(t)))) => return Some(Ok(t)),
                Ok(Some(Ok(M::Close(Some(cf))))) => return Some(Err(u16::from(cf.code))),
                Ok(Some(Ok(_))) => continue,
                _ => return None,
            }
        }
    }

    /// **The SCRATCH route keeps its 4404.** P0-2 rehydrates the workspace tab
    /// and nothing else: for a scratch context the original objection still
    /// holds — a freshly-spawned `about:blank` really would be presented as the
    /// agent's work, and there is no stored URL that would make it the truth.
    #[tokio::test]
    async fn the_scratch_takeover_socket_still_refuses_a_session_with_no_context() {
        let (state, dir) = ws_state().await;
        let addr = serve(&state).await;
        let mut ws = dial(addr, "/ws/browser/ghost/takeover").await;
        assert_eq!(
            next_event(&mut ws).await,
            Some(Ok(r#"{"type":"auth_ok"}"#.to_string())),
            "auth must still succeed — the refusal is about the context, not the token"
        );
        assert_eq!(
            next_event(&mut ws).await,
            Some(Err(CLOSE_NO_CONTEXT)),
            "a scratch takeover takes over something that exists"
        );
        assert!(!state.browser.is_running().await, "and it spawns nothing on the way");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// **REAL-CHROME — P0-3, the legibility claim.** Run with
    /// `cargo test -- --ignored real_chrome_viewport`.
    ///
    /// The unit tests above prove the *arithmetic* of the two profiles. This
    /// proves the part only a browser can answer: that a negotiated viewport
    /// actually **re-lays-out the page** and actually **re-caps the stream**,
    /// and that renegotiating does not hang up on a subscriber who is mid-watch.
    #[tokio::test]
    #[ignore = "spawns a real chrome-headless-shell; run with --ignored on a box that has the pinned binary"]
    async fn real_chrome_viewport_relayouts_the_page_and_recaps_the_stream() {
        use super::super::{BrowserConfig, BrowserService};
        use std::time::Duration;

        let svc = BrowserService::new(BrowserConfig {
            profile: crate::connectors::browser::launch::ProfileMode::Ephemeral,
            ..BrowserConfig::default()
        });
        if !svc.config().executable.exists() {
            eprintln!("skipping: no pinned chrome at {:?}", svc.config().executable);
            return;
        }
        let ctx = svc.context_for("viewport").await.expect("context");
        ctx.navigate(Actor::Agent, &takeover_page())
            .await
            .expect("navigate");

        // The configured render box is what the SEED reports — no longer `0, 0`.
        let (w, h) = ctx.viewport_css();
        assert_eq!((w, h), (svc.config().width, svc.config().height));
        assert_eq!(
            ctx.evaluate("window.innerWidth").await.expect("innerWidth"),
            json!(svc.config().width),
            "the page really is laid out at the configured box",
        );

        // Watch first — the in-chat card's profile, and a live subscriber that
        // must SURVIVE the renegotiation below.
        let mut watching = ctx
            .start_screencast(Actor::Human, screencast_profile(None))
            .await
            .expect("watch screencast");

        // ── negotiate: a laptop viewport at 2× ─────────────────────────────
        let req = ViewportRequest::sanitized(900, 700, 2.0, false).expect("a usable box");
        ctx.set_viewport_scaled(Actor::Human, req.width, req.height, req.dpr, req.mobile)
            .await
            .expect("setDeviceMetricsOverride");

        // 1. THE PAGE LAID OUT AT THE VIEWER'S SIZE. This is the whole point:
        //    a site branching on width now serves the layout for THAT width,
        //    instead of a 1366px render squeezed into the viewer's canvas.
        assert_eq!(
            ctx.evaluate("window.innerWidth").await.expect("innerWidth"),
            json!(900),
        );
        assert_eq!(
            ctx.evaluate("window.devicePixelRatio")
                .await
                .expect("dpr")
                .as_f64(),
            Some(2.0),
            "the render is at the viewer's pixel density, not upscaled from 1×",
        );
        assert_eq!(ctx.viewport_css(), (900, 700), "and the seed box followed it");

        // 2. THE STREAM RE-CAPPED to match, without closing the watcher.
        let mut driving = ctx
            .start_screencast(Actor::Human, screencast_profile(Some(req)))
            .await
            .expect("renegotiated screencast");

        let mut seen = 0usize;
        let mut metadata_box = None;
        let window = tokio::time::Instant::now() + Duration::from_secs(2);
        while tokio::time::Instant::now() < window && seen < 3 {
            match tokio::time::timeout(Duration::from_millis(600), driving.recv()).await {
                Ok(Ok(f)) => {
                    seen += 1;
                    if let Some(vp) = Viewport::from_metadata(&f.metadata) {
                        metadata_box = Some(vp);
                    }
                    if let Some(ack) = &f.ack {
                        ctx.ack_frame(ack).expect("ack");
                    }
                }
                _ => break,
            }
        }
        assert!(seen > 0, "no frames after renegotiating the profile");
        let vp = metadata_box.expect("a frame carrying metadata");
        assert_eq!(
            (vp.width, vp.height),
            (900.0, 700.0),
            "frames must describe the NEGOTIATED box — the client maps taps through this",
        );

        // 3. The mid-watch subscriber was not hung up on. A fresh channel would
        //    have handed it `Closed`, which `drive` reads as ScreencastGone.
        assert!(
            !matches!(
                watching.try_recv(),
                Err(tokio::sync::broadcast::error::TryRecvError::Closed)
            ),
            "renegotiating closed a live watcher's receiver",
        );

        // ── 4. `mobile: true` is REAL mobile emulation, not just a narrow box ──
        //
        // Measured, not assumed: with `mobile` set, chrome applies the same
        // layout-viewport rules a phone does. A page that declares
        // `width=device-width` lays out at the negotiated 390…
        let mobile = ViewportRequest::sanitized(390, 844, 2.0, true).expect("a usable box");
        ctx.set_viewport_scaled(
            Actor::Human,
            mobile.width,
            mobile.height,
            mobile.dpr,
            mobile.mobile,
        )
        .await
        .expect("setDeviceMetricsOverride");
        ctx.navigate(
            Actor::Human,
            "data:text/html,<meta%20name=viewport%20content=width=device-width><body>m",
        )
        .await
        .expect("navigate responsive");
        assert_eq!(
            ctx.evaluate("window.innerWidth").await.expect("innerWidth"),
            json!(390),
            "a responsive page must lay out at the phone's own width",
        );
        // …and one that does NOT declare it gets chrome's 980px fallback
        // layout viewport, scaled down — which is exactly what the same page
        // does on a real phone. Pinned so nobody later "fixes" it into a lie.
        ctx.navigate(Actor::Human, &takeover_page())
            .await
            .expect("navigate legacy");
        assert_eq!(
            ctx.evaluate("window.innerWidth").await.expect("innerWidth"),
            json!(980),
            "no viewport meta ⇒ the mobile fallback layout viewport, as on a phone",
        );

        ctx.stop_screencast(Actor::Human).await.expect("stop");
        svc.shutdown().await;
    }

    /// **REAL-CHROME — P0-2.** Run with
    /// `cargo test -- --ignored real_chrome_tab_socket`.
    ///
    /// A human attaching to an ASLEEP workspace tab used to be hung up on with
    /// 4404, which is why P0-1's wake still showed a blank canvas half the time.
    /// Now the socket rehydrates behind the same in-band bearer auth the REST
    /// **P1-4 + P1-5 end to end, against a real Chrome and the real socket.**
    ///
    /// The seed carries a live `nav_state` (url, title, favicon, honest
    /// back/forward), a `navigate` control frame moves the page and the feed
    /// says so, `back` restores the first page with `can_go_forward` now true,
    /// and an `alert()` — which blocks the renderer outright — is reported and
    /// then dismissed by a `dialog` frame.
    #[tokio::test]
    #[ignore = "spawns a real chrome; run with --ignored on a box that has the pinned binary"]
    async fn real_chrome_the_socket_streams_nav_state_and_drives_the_history() {
        use futures_util::SinkExt;
        let (state, dir) = ws_state().await;
        if !state.browser.config().executable.exists() {
            eprintln!("SKIP: no chrome at {}", state.browser.config().executable.display());
            std::fs::remove_dir_all(&dir).ok();
            return;
        }
        // Two pages plus a 1×1 gif at /favicon.ico, so the in-page favicon read
        // has something real to find.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let listener = tokio::net::TcpListener::from_std(listener).unwrap();
        let server = tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else { return };
                tokio::spawn(async move {
                    use tokio::io::{AsyncReadExt, AsyncWriteExt};
                    let mut buf = [0u8; 2048];
                    let n = sock.read(&mut buf).await.unwrap_or(0);
                    let req = String::from_utf8_lossy(&buf[..n]).to_string();
                    let (ctype, body): (&str, Vec<u8>) = if req.contains("GET /favicon.ico") {
                        // The smallest valid gif there is.
                        let gif: [u8; 35] = [
                            0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00,
                            0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0x21, 0xf9, 0x04, 0x01, 0x00,
                            0x00, 0x00, 0x00, 0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01,
                        ];
                        ("image/gif", gif.to_vec())
                    } else if req.contains("GET /two") {
                        ("text/html", b"<title>Second</title><body>second</body>".to_vec())
                    } else if req.contains("GET /alerting") {
                        (
                            "text/html",
                            b"<title>Alerting</title><body onload=\"setTimeout(()=>alert('stop right there'),50)\">wait</body>".to_vec(),
                        )
                    } else {
                        ("text/html", b"<title>First</title><body>first</body>".to_vec())
                    };
                    let head = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        ctype,
                        body.len()
                    );
                    let _ = sock.write_all(head.as_bytes()).await;
                    let _ = sock.write_all(&body).await;
                    let _ = sock.flush().await;
                });
            }
        });
        let one = format!("http://127.0.0.1:{port}/");
        let two = format!("http://127.0.0.1:{port}/two");
        let alerting = format!("http://127.0.0.1:{port}/alerting");
        let id = "tb_navstatecontrols";
        crate::db::browser_tabs::create(&state.pool, id, &one, None, &["127.0.0.1".to_string()])
            .await
            .unwrap();

        let addr = serve(&state).await;
        let mut ws = dial(addr, &format!("/ws/browser/tab/{id}")).await;

        /// Read frames until one is a `nav_state` that `want` accepts. Frames
        /// interleave with a 60 fps screencast, so "the next frame" is never the
        /// one you are looking for.
        async fn nav_until(
            ws: &mut tokio_tungstenite::WebSocketStream<
                tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
            >,
            what: &str,
            want: impl Fn(&Value) -> bool,
        ) -> Value {
            for _ in 0..400 {
                let Some(Ok(text)) = next_event(ws).await else {
                    panic!("socket closed while waiting for {what}");
                };
                let Ok(v) = serde_json::from_str::<Value>(&text) else { continue };
                if v["type"] == json!("nav_state") && want(&v) {
                    return v;
                }
            }
            panic!("never saw a nav_state matching {what}");
        }

        // ── 1. the seed feed: the page the tab actually stored ───────────────
        let landed = nav_until(&mut ws, "the first page", |v| {
            v["url"].as_str().unwrap_or_default().ends_with(&format!("{port}/"))
                && v["title"] == json!("First")
        })
        .await;
        assert_eq!(landed["loading"], json!(false), "{landed}");
        assert_eq!(landed["can_go_back"], json!(false), "the first page has nothing behind it: {landed}");
        assert_eq!(landed["can_go_forward"], json!(false), "{landed}");
        assert_eq!(landed["secure"], json!(false), "loopback http is NOT a padlock: {landed}");
        assert_eq!(landed["dialog"], Value::Null, "{landed}");
        assert!(
            landed["favicon"].as_str().unwrap_or_default().starts_with("data:image/"),
            "the icon is read IN the page and relayed as a data URI: {landed}"
        );

        // ── 2. a navigate control frame moves the page ───────────────────────
        ws.send(tokio_tungstenite::tungstenite::Message::Text(
            json!({ "type": "navigate", "url": two }).to_string(),
        ))
        .await
        .unwrap();
        let second = nav_until(&mut ws, "the second page", |v| {
            v["title"] == json!("Second") && v["loading"] == json!(false)
        })
        .await;
        assert_eq!(second["url"], json!(two), "{second}");
        assert_eq!(second["can_go_back"], json!(true), "there is now a page behind: {second}");
        assert_eq!(second["can_go_forward"], json!(false), "{second}");

        // ── 3. back really steps the history, forward becomes honest ─────────
        ws.send(tokio_tungstenite::tungstenite::Message::Text(
            json!({ "type": "back" }).to_string(),
        ))
        .await
        .unwrap();
        let back = nav_until(&mut ws, "the page behind", |v| {
            v["title"] == json!("First") && v["can_go_forward"] == json!(true)
        })
        .await;
        assert_eq!(back["can_go_back"], json!(false), "we are at the front again: {back}");

        // ── 4. a non-http scheme is refused at the socket, like at REST ──────
        ws.send(tokio_tungstenite::tungstenite::Message::Text(
            json!({ "type": "navigate", "url": "file:///etc/passwd" }).to_string(),
        ))
        .await
        .unwrap();
        let mut refused = false;
        for _ in 0..200 {
            let Some(Ok(text)) = next_event(&mut ws).await else { break };
            if text.contains(r#""type":"refused""#) {
                refused = true;
                break;
            }
        }
        assert!(refused, "file: in the human's own cookie jar is a local read, not navigation");

        // ── 5. an alert() blocks the renderer; the feed says so and the ──────
        //      dialog frame is the only way back out.
        ws.send(tokio_tungstenite::tungstenite::Message::Text(
            json!({ "type": "navigate", "url": alerting }).to_string(),
        ))
        .await
        .unwrap();
        let blocked = nav_until(&mut ws, "the dialog", |v| v["dialog"].is_object()).await;
        assert_eq!(blocked["dialog"]["kind"], json!("alert"), "{blocked}");
        assert_eq!(blocked["dialog"]["message"], json!("stop right there"), "{blocked}");
        ws.send(tokio_tungstenite::tungstenite::Message::Text(
            json!({ "type": "dialog", "accept": true }).to_string(),
        ))
        .await
        .unwrap();
        let cleared = nav_until(&mut ws, "the dialog clearing", |v| v["dialog"].is_null()).await;
        assert_eq!(cleared["dialog"], Value::Null, "{cleared}");

        drop(ws);
        state.browser.shutdown().await;
        server.abort();
        std::fs::remove_dir_all(&dir).ok();
    }

    /// wake door demands, and the seed `target` frame carries the tab's own
    /// stored URL — the same page, from the same on-disk profile.
    #[tokio::test]
    #[ignore = "spawns a real chrome; run with --ignored on a box that has the pinned binary"]
    async fn real_chrome_tab_socket_rehydrates_an_asleep_tab_on_attach() {
        let (state, dir) = ws_state().await;
        if !state.browser.config().executable.exists() {
            eprintln!("SKIP: no chrome at {}", state.browser.config().executable.display());
            std::fs::remove_dir_all(&dir).ok();
            return;
        }
        // A loopback page so the seed frame's URL is checkable.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let listener = tokio::net::TcpListener::from_std(listener).unwrap();
        let server = tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else { return };
                tokio::spawn(async move {
                    use tokio::io::{AsyncReadExt, AsyncWriteExt};
                    let mut buf = [0u8; 1024];
                    let _ = sock.read(&mut buf).await;
                    let body = "<title>Rehydrated</title><body>still-here</body>";
                    let _ = sock
                        .write_all(
                            format!(
                                "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                                body.len(),
                                body
                            )
                            .as_bytes(),
                        )
                        .await;
                    let _ = sock.flush().await;
                });
            }
        });
        let url = format!("http://127.0.0.1:{port}/");
        let id = "tb_rehydrateonattach";
        crate::db::browser_tabs::create(&state.pool, id, &url, None, &["127.0.0.1".to_string()])
            .await
            .unwrap();
        assert!(state.browser.tab(id).await.is_none(), "the tab starts ASLEEP");

        let addr = serve(&state).await;
        let mut ws = dial(addr, &format!("/ws/browser/tab/{id}")).await;
        assert_eq!(
            next_event(&mut ws).await,
            Some(Ok(r#"{"type":"auth_ok"}"#.to_string()))
        );
        let seed = match next_event(&mut ws).await {
            Some(Ok(t)) => t,
            other => panic!("expected the seed target frame, got {other:?}"),
        };
        assert!(
            seed.starts_with(r#"{"type":"target""#),
            "attaching to an asleep tab must WAKE it, not close 4404: {seed}"
        );
        assert!(
            seed.contains(&format!("127.0.0.1:{port}")),
            "the rehydrated page is the tab's own stored URL: {seed}"
        );
        // **The caps frame** (P4), which must arrive with the seed and AFTER the
        // target — the client sizes its canvas off `target` and reads a missing
        // `caps` as "this server cannot do find or copy".
        let mut caps = None;
        for _ in 0..6 {
            match next_event(&mut ws).await {
                Some(Ok(text)) => {
                    if text.starts_with(r#"{"type":"caps""#) {
                        caps = Some(text);
                        break;
                    }
                }
                other => panic!("socket ended before the caps frame: {other:?}"),
            }
        }
        assert_eq!(
            caps.as_deref(),
            Some(r#"{"type":"caps","find":true,"copy":true}"#),
            "without this frame the find bar and copy-selection stay disabled"
        );
        assert!(
            state.browser.tab(id).await.is_some(),
            "the tab is live once a human has attached"
        );

        drop(ws);
        state.browser.shutdown().await;
        server.abort();
        std::fs::remove_dir_all(&dir).ok();
    }
}
