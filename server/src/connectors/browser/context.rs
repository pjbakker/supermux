//! **One page, driven by an agent or a human** — its cookie jar, its
//! `localStorage`, its target, and its [`DriveLock`].
//!
//! # Two jars, one page primitive (shared-browser v1 §2.3)
//!
//! Everything below the identity line is shared; only *which* jar the page
//! lands in differs, and that is exactly one field:
//!
//! * **Agent scratch** ([`AgentContext::create`], `browser_context_id =
//!   Some(_)`). A CDP `BrowserContext` (`Target.createBrowserContext`), the same
//!   primitive an incognito window uses. The spike verified cookie *and*
//!   `localStorage` isolation between two of them, and verified that disposing
//!   one leaves its siblings responsive — so per-agent teardown is safe. This
//!   path is **byte-for-byte today's behaviour** and keeps every guarantee it
//!   has: an incognito-equivalent context does not persist to the profile dir,
//!   so scratch stays isolated even while sharing a durable `--user-data-dir`.
//! * **Workspace tab** ([`AgentContext::create_in_default_context`],
//!   `browser_context_id = None`). `Target.createTarget` with **no**
//!   `browserContextId` lands in the browser's DEFAULT context, whose cookies /
//!   `localStorage` / IndexedDB Chrome persists into
//!   `<user-data-dir>/Default/…`. **The profile IS the jar** — there is nothing
//!   to create and, decisively, nothing to dispose (see
//!   [`AgentContext::close`]).
//!
//! Every page-driving method below is identical for both and is deliberately
//! left untouched by v1 — in particular the screencast pump's ack accounting,
//! which is subtle and must not be re-derived.
//!
//! # Flat-mode sessions
//!
//! Each context owns exactly one page target, attached with
//! `Target.attachToTarget {flatten:true}`. Every command below therefore rides
//! the single browser WebSocket carrying our `sessionId`; there is no second
//! socket per page.
//!
//! # Every mutating method takes an [`Actor`]
//!
//! That is the lock, in the type system: an [`Actor::Agent`] call goes through
//! [`DriveLock::ensure_agent`] and is refused with
//! [`BrowserError::HumanDriving`] while a human has taken over, while
//! [`Actor::Human`] always passes. Read-only helpers are ungated — observing
//! the page is never a conflict.

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tokio::sync::{broadcast, Mutex};
use tokio::task::JoinHandle;
use tracing::{debug, warn};

use super::cdp::CdpClient;
use super::error::{BrowserError, Result};
use super::lock::{Actor, DriveLock, DriveMode};

/// How long [`AgentContext::navigate`] waits for `Page.loadEventFired` before
/// returning anyway. Navigation is *started* regardless; this only bounds how
/// long we block the caller. Slow third-party pages must not wedge a tool call.
const LOAD_BUDGET: Duration = Duration::from_secs(20);

/// Fan-out capacity for a context's screencast frames. Frames are droppable by
/// design (see `SPIKE-RESULT.md` gotcha #2) — a lagging viewer skips ahead
/// rather than pushing back on the browser.
const FRAME_CHANNEL_CAP: usize = 16;

/// Ceiling on `deviceScaleFactor`. Chrome composites `width × scale` REAL
/// pixels, so the render cost is quadratic in this number while the legibility
/// win stops at "one frame pixel per screen pixel". A 3× phone therefore
/// renders at 2× and the extra third is left on the client's downscale, which
/// is free.
pub const MAX_DEVICE_SCALE: f64 = 2.0;

/// `everyNthFrame` for the drive profile. Chrome paints up to ~60 fps; a person
/// READING a page wants ~15 sharp frames far more than 60 that spent their
/// quality budget on motion, and it is the same trade the 512-cap made in the
/// other direction.
const DRIVE_EVERY_NTH: u32 = 4;

/// One JPEG/PNG frame off `Page.screencastFrame`.
#[derive(Debug, Clone)]
pub struct ScreencastFrame {
    /// Base64-encoded image bytes, exactly as CDP delivered them (phase 2
    /// relays these to the browser client without a re-encode).
    pub data: String,
    /// `{offsetTop, pageScaleFactor, deviceWidth, deviceHeight, scrollOffsetX,
    /// scrollOffsetY, timestamp}` — the transform a client needs to map a tap
    /// back to page coordinates (gotcha #6).
    pub metadata: Value,
    /// The CDP `sessionId` this frame must be acked with, present only under
    /// [`AckPolicy::Viewer`] — under [`AckPolicy::Immediate`] the pump already
    /// acked and there is nothing for the consumer to do.
    ///
    /// Chromium counts *frames in flight* (max 2) and each ack is a decrement
    /// carrying the screencast's — not the frame's — session id, so an ack is
    /// fungible: a consumer that DROPS a frame still has to ack for it or the
    /// counter saturates and the stream stalls forever. See
    /// [`AgentContext::ack_frame`].
    pub ack: Option<Value>,
}

/// Who is responsible for `Page.screencastFrameAck`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AckPolicy {
    /// The pump acks the moment it has fanned a frame out (phase-1 behaviour).
    /// Chrome then renders/encodes at full speed regardless of the consumer.
    Immediate,
    /// The pump leaves the ack to the consumer, which acks only once the frame
    /// has actually been handed to its viewer. Chrome's 2-frame in-flight
    /// window then becomes REAL backpressure: a slow phone throttles the
    /// encoder instead of burning a core on frames nobody sees.
    Viewer,
}

/// Screencast tuning. Defaults are the spike's mobile-friendly recommendation:
/// jpeg q60 capped at 512px, which measured ~138 KB/s at 60 fps.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ScreencastOptions {
    pub format: String,
    pub quality: u32,
    #[serde(rename = "maxWidth")]
    pub max_width: u32,
    #[serde(rename = "maxHeight")]
    pub max_height: u32,
    #[serde(rename = "everyNthFrame")]
    pub every_nth_frame: u32,
    /// Who acks (not part of the CDP payload — hence `skip`).
    #[serde(skip)]
    pub ack: AckPolicy,
}

impl Default for ScreencastOptions {
    fn default() -> Self {
        Self {
            format: "jpeg".to_string(),
            quality: 60,
            max_width: 512,
            max_height: 512,
            every_nth_frame: 1,
            ack: AckPolicy::Immediate,
        }
    }
}

/// **Two profiles, and the gap between them is the whole legibility story.**
///
/// The same page streamed to a phone-sized card next to a chat transcript and
/// to a laptop viewport somebody is trying to READ are not the same problem.
/// One wants motion at ~138 KB/s; the other wants type it can resolve. The
/// server cannot guess which it is serving, so the client says
/// (`ClientMsg::Viewport`) and this picks.
impl ScreencastOptions {
    /// The largest frame either profile will ever ask chrome for — a cap on the
    /// encoder, on the wire and on the canvas the client has to paint. Past it a
    /// sharper frame buys nothing an eye can see on a real screen.
    pub const MAX_STREAM_PX: u32 = 1600;

    /// **watch** — the in-chat takeover card. The spike's measured mobile
    /// profile (jpeg q60, 512², every frame), byte for byte, because a person
    /// watching an agent work wants motion and a small bill, not typography.
    /// This is what a client that never negotiates keeps getting.
    pub fn watch() -> Self {
        Self::default()
    }

    /// **drive** — the workspace viewport, sized for the human looking at it.
    ///
    /// `css_w`/`css_h` are the viewer's CSS box and `dpr` its device pixel
    /// ratio, so the cap is the count of REAL pixels their screen can show.
    /// Paired with [`AgentContext::set_viewport_scaled`], which lays the page
    /// out at that same box, the result is 1:1 and readable instead of a 1366px
    /// render squeezed through a 512px pipe and re-upscaled in a canvas.
    pub fn drive(css_w: u32, css_h: u32, dpr: f64) -> Self {
        let scale = if dpr.is_finite() {
            dpr.clamp(1.0, MAX_DEVICE_SCALE)
        } else {
            1.0
        };
        let px = |css: u32| -> u32 {
            let want = f64::from(css.max(1)) * scale;
            (want.round() as u32).clamp(1, Self::MAX_STREAM_PX)
        };
        Self {
            format: "jpeg".to_string(),
            quality: 75,
            max_width: px(css_w),
            max_height: px(css_h),
            every_nth_frame: DRIVE_EVERY_NTH,
            ack: AckPolicy::Immediate,
        }
    }

    /// The `Page.startScreencast` payload. Split out so the mapping is testable
    /// without chrome AND so the renegotiation path below cannot drift from the
    /// start path — the bug that would show up as "the profile changed but the
    /// picture did not".
    pub fn cdp_params(&self) -> Value {
        json!({
            "format": self.format,
            "quality": self.quality,
            "maxWidth": self.max_width,
            "maxHeight": self.max_height,
            "everyNthFrame": self.every_nth_frame.max(1),
        })
    }
}

/// A key press descriptor. Chrome needs the *full* payload — the spike found
/// that omitting `code` leaves pages reading `e.code == ""` (gotcha #8).
#[derive(Debug, Clone)]
pub struct KeyPress {
    pub key: &'static str,
    pub code: &'static str,
    pub windows_virtual_key_code: i64,
    /// The text the key inserts, if any (`None` for Backspace/Escape/arrows).
    pub text: Option<&'static str>,
}

impl KeyPress {
    /// The common named keys a tool call or a takeover keyboard needs.
    pub fn named(name: &str) -> Option<Self> {
        let k = match name {
            "Enter" => Self {
                key: "Enter",
                code: "Enter",
                windows_virtual_key_code: 13,
                text: Some("\r"),
            },
            "Backspace" => Self {
                key: "Backspace",
                code: "Backspace",
                windows_virtual_key_code: 8,
                text: None,
            },
            "Tab" => Self {
                key: "Tab",
                code: "Tab",
                windows_virtual_key_code: 9,
                text: Some("\t"),
            },
            "Escape" => Self {
                key: "Escape",
                code: "Escape",
                windows_virtual_key_code: 27,
                text: None,
            },
            "ArrowUp" => Self {
                key: "ArrowUp",
                code: "ArrowUp",
                windows_virtual_key_code: 38,
                text: None,
            },
            "ArrowDown" => Self {
                key: "ArrowDown",
                code: "ArrowDown",
                windows_virtual_key_code: 40,
                text: None,
            },
            "ArrowLeft" => Self {
                key: "ArrowLeft",
                code: "ArrowLeft",
                windows_virtual_key_code: 37,
                text: None,
            },
            "ArrowRight" => Self {
                key: "ArrowRight",
                code: "ArrowRight",
                windows_virtual_key_code: 39,
                text: None,
            },
            _ => return None,
        };
        Some(k)
    }
}

/// A live per-agent browser context.
pub struct AgentContext {
    /// The lock subject — a session name for scratch, a `tb_…` tab id for a
    /// workspace tab.
    session: String,
    /// `Some(_)` ⇒ an isolated (incognito-equivalent) context we own and must
    /// dispose. `None` ⇒ the browser's DEFAULT context: the persistent profile,
    /// which is shared by every workspace tab and must NEVER be disposed.
    browser_context_id: Option<String>,
    target_id: String,
    cdp_session_id: String,
    client: Arc<CdpClient>,
    lock: DriveLock,
    /// The CSS-pixel box this target is laid out at — mirrored from every
    /// `Emulation.setDeviceMetricsOverride` we issue, which is authoritative
    /// because nothing else in the tree ever sets one. Atomic, not behind the
    /// screencast mutex, because the takeover seed reads it on a path with
    /// nothing to await.
    viewport_w: AtomicU32,
    viewport_h: AtomicU32,
    /// Live screencast pump, if one is running.
    screencast: Mutex<Option<Screencast>>,
}

struct Screencast {
    tx: broadcast::Sender<ScreencastFrame>,
    pump: JoinHandle<()>,
    /// The options this cast is RUNNING with. Kept so a second caller asking
    /// for a different profile is honoured instead of silently inheriting the
    /// first attacher's — see [`AgentContext::start_screencast`].
    options: ScreencastOptions,
}

impl std::fmt::Debug for AgentContext {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AgentContext")
            .field("session", &self.session)
            .field("browser_context_id", &self.browser_context_id)
            .field("target_id", &self.target_id)
            .field("mode", &self.lock.mode())
            .finish()
    }
}

impl AgentContext {
    /// Create an isolated context + its page and attach a flat-mode session.
    ///
    /// If anything fails midway the partially-created context is disposed
    /// before the error is returned, so a failed create leaks no context.
    pub async fn create(
        client: Arc<CdpClient>,
        session: &str,
        width: u32,
        height: u32,
    ) -> Result<Self> {
        // `disposeOnDetach:false` on purpose: a client disconnecting must NOT
        // nuke the agent's browsing session (spike gotcha #12).
        let ctx = client
            .call(
                "Target.createBrowserContext",
                json!({ "disposeOnDetach": false }),
            )
            .await?;
        let browser_context_id = ctx["browserContextId"]
            .as_str()
            .ok_or_else(|| BrowserError::Protocol {
                method: "Target.createBrowserContext".into(),
                message: "no browserContextId in result".into(),
            })?
            .to_string();

        match Self::finish_create(
            client.clone(),
            session,
            Some(browser_context_id.as_str()),
            width,
            height,
            "about:blank",
        )
        .await
        {
            Ok(me) => Ok(me),
            Err(e) => {
                let _ = client
                    .call(
                        "Target.disposeBrowserContext",
                        json!({ "browserContextId": browser_context_id }),
                    )
                    .await;
                Err(e)
            }
        }
    }

    /// **Open a page in the browser's DEFAULT (persistent) context** — the
    /// workspace path (v1 §2.3 R2 / §4.1).
    ///
    /// The one structural difference from [`create`](Self::create): it does
    /// **not** call `Target.createBrowserContext` at all. A `createTarget` with
    /// no `browserContextId` lands in the default context, which is the durable
    /// profile on disk, which is the human's cookie jar. That is the entire
    /// mechanism by which a login survives a tab close, an idle reap, a Chrome
    /// crash and a `systemctl restart`.
    ///
    /// `subject` is the lock subject (a tab id here, not a session name), and
    /// `url` is where the page opens — a rehydrating tab reopens at its stored
    /// URL rather than at `about:blank`.
    pub async fn create_in_default_context(
        client: Arc<CdpClient>,
        subject: &str,
        width: u32,
        height: u32,
        url: &str,
    ) -> Result<Self> {
        // No createBrowserContext, and therefore nothing to dispose if
        // `finish_create` fails halfway — its own `closeTarget` on the way out
        // is not needed either, because a failed createTarget leaves no target.
        Self::finish_create(client, subject, None, width, height, url).await
    }

    async fn finish_create(
        client: Arc<CdpClient>,
        session: &str,
        browser_context_id: Option<&str>,
        width: u32,
        height: u32,
        url: &str,
    ) -> Result<Self> {
        let mut params = json!({ "url": url });
        // Present ⇒ isolated context. ABSENT ⇒ the default, persistent one.
        //
        // `width`/`height` ride along ONLY on the isolated path, unchanged. In
        // the default context Chrome refuses them outright ("Target position can
        // only be set for new windows" — measured against Chrome 149), and they
        // buy nothing there: the viewport is per-target and is pinned below with
        // `Emulation.setDeviceMetricsOverride` either way (gotcha #11).
        if let Some(bcid) = browser_context_id {
            params["browserContextId"] = json!(bcid);
            params["width"] = json!(width);
            params["height"] = json!(height);
        }
        let target = client.call("Target.createTarget", params).await?;
        let target_id = target["targetId"]
            .as_str()
            .ok_or_else(|| BrowserError::Protocol {
                method: "Target.createTarget".into(),
                message: "no targetId in result".into(),
            })?
            .to_string();

        // Flat mode: this target's traffic rides the browser socket, tagged.
        let attached = client
            .call(
                "Target.attachToTarget",
                json!({ "targetId": target_id, "flatten": true }),
            )
            .await?;
        let cdp_session_id = attached["sessionId"]
            .as_str()
            .ok_or_else(|| BrowserError::Protocol {
                method: "Target.attachToTarget".into(),
                message: "no sessionId in result".into(),
            })?
            .to_string();

        let me = Self {
            session: session.to_string(),
            browser_context_id: browser_context_id.map(str::to_string),
            target_id,
            cdp_session_id,
            client,
            lock: DriveLock::new(session),
            viewport_w: AtomicU32::new(width),
            viewport_h: AtomicU32::new(height),
            screencast: Mutex::new(None),
        };
        // Domains we need events + evaluation from.
        me.session_call("Page.enable", json!({})).await?;
        me.session_call("Runtime.enable", json!({})).await?;
        // `--window-size` is a browser-wide default; the viewport is per-target
        // (gotcha #11), so pin it here.
        me.session_call(
            "Emulation.setDeviceMetricsOverride",
            json!({
                "width": width, "height": height,
                "deviceScaleFactor": 1, "mobile": false,
            }),
        )
        .await?;
        Ok(me)
    }

    // ── identity ────────────────────────────────────────────────────────────

    /// The supermux session name this context belongs to.
    pub fn session(&self) -> &str {
        &self.session
    }
    /// The CDP `browserContextId` (the isolation boundary), or `None` for a page
    /// in the DEFAULT persistent context — a workspace tab, whose jar is the
    /// profile on disk.
    pub fn browser_context_id(&self) -> Option<&str> {
        self.browser_context_id.as_deref()
    }

    /// Is this page in the persistent (default) context? True for a workspace
    /// tab, false for an agent-scratch context.
    pub fn is_persistent(&self) -> bool {
        self.browser_context_id.is_none()
    }
    /// The CDP `targetId` of this context's page.
    pub fn target_id(&self) -> &str {
        &self.target_id
    }
    /// The flat-mode `sessionId` commands for this page carry.
    pub fn cdp_session_id(&self) -> &str {
        &self.cdp_session_id
    }
    /// This context's AGENT/HUMAN drive lock.
    pub fn lock(&self) -> &DriveLock {
        &self.lock
    }
    /// Shorthand for `self.lock().mode()`.
    pub fn mode(&self) -> DriveMode {
        self.lock.mode()
    }

    async fn session_call(&self, method: &str, params: Value) -> Result<Value> {
        self.client
            .call_on(Some(&self.cdp_session_id), method, params)
            .await
    }

    // ── navigation + reading (reads are ungated) ────────────────────────────

    /// Navigate and wait (bounded) for the load event.
    pub async fn navigate(&self, actor: Actor, url: &str) -> Result<()> {
        self.lock.gate(actor)?;
        // Subscribe BEFORE issuing the command so a fast load cannot race us.
        let mut events = self.client.subscribe();
        let result = self
            .session_call("Page.navigate", json!({ "url": url }))
            .await?;
        if let Some(err) = result.get("errorText").and_then(Value::as_str) {
            return Err(BrowserError::Protocol {
                method: "Page.navigate".into(),
                message: format!("{url}: {err}"),
            });
        }
        let want = self.cdp_session_id.clone();
        let waited = tokio::time::timeout(LOAD_BUDGET, async {
            loop {
                match events.recv().await {
                    Ok(ev) => {
                        if ev.method == "Page.loadEventFired"
                            && ev.session_id.as_deref() == Some(want.as_str())
                        {
                            return;
                        }
                    }
                    // Lagged: we may have missed the load event, so stop
                    // waiting rather than hang until the budget expires.
                    Err(broadcast::error::RecvError::Lagged(_)) => return,
                    Err(broadcast::error::RecvError::Closed) => return,
                }
            }
        })
        .await;
        if waited.is_err() {
            debug!(session = %self.session, url, "browser: load event not seen within budget");
        }
        Ok(())
    }

    /// Evaluate JS in the page and return the value (`returnByValue`).
    ///
    /// Ungated: reading the DOM is never a control conflict, and phase 2's
    /// takeover UI needs to read page state while the human drives.
    pub async fn evaluate(&self, expression: &str) -> Result<Value> {
        let out = self
            .session_call(
                "Runtime.evaluate",
                json!({
                    "expression": expression,
                    "returnByValue": true,
                    "awaitPromise": true,
                }),
            )
            .await?;
        if let Some(details) = out.get("exceptionDetails") {
            let msg = details
                .get("exception")
                .and_then(|e| e.get("description"))
                .and_then(Value::as_str)
                .or_else(|| details.get("text").and_then(Value::as_str))
                .unwrap_or("unknown exception")
                .to_string();
            return Err(BrowserError::Evaluate(msg));
        }
        Ok(out
            .get("result")
            .and_then(|r| r.get("value"))
            .cloned()
            .unwrap_or(Value::Null))
    }

    /// Convenience: `document.location.href`.
    pub async fn current_url(&self) -> Result<String> {
        Ok(self
            .evaluate("document.location.href")
            .await?
            .as_str()
            .unwrap_or_default()
            .to_string())
    }

    // ── input (all gated) ───────────────────────────────────────────────────

    /// A full left click at viewport coordinates.
    pub async fn click(&self, actor: Actor, x: f64, y: f64) -> Result<()> {
        self.lock.gate(actor)?;
        for kind in ["mousePressed", "mouseReleased"] {
            self.session_call(
                "Input.dispatchMouseEvent",
                json!({
                    "type": kind, "x": x, "y": y,
                    "button": "left", "buttons": 1, "clickCount": 1,
                }),
            )
            .await?;
        }
        Ok(())
    }

    /// Move the pointer (hover) without clicking.
    pub async fn move_mouse(&self, actor: Actor, x: f64, y: f64) -> Result<()> {
        self.lock.gate(actor)?;
        self.session_call(
            "Input.dispatchMouseEvent",
            json!({ "type": "mouseMoved", "x": x, "y": y, "buttons": 0 }),
        )
        .await
        .map(|_| ())
    }

    /// Scroll by a wheel delta at a point.
    pub async fn scroll(&self, actor: Actor, x: f64, y: f64, dx: f64, dy: f64) -> Result<()> {
        self.lock.gate(actor)?;
        self.session_call(
            "Input.dispatchMouseEvent",
            json!({
                "type": "mouseWheel", "x": x, "y": y,
                "deltaX": dx, "deltaY": dy, "buttons": 0,
            }),
        )
        .await
        .map(|_| ())
    }

    /// Insert text as if pasted / committed by an IME. Handles non-ASCII and
    /// emoji, which per-key events do not.
    pub async fn insert_text(&self, actor: Actor, text: &str) -> Result<()> {
        self.lock.gate(actor)?;
        self.session_call("Input.insertText", json!({ "text": text }))
            .await
            .map(|_| ())
    }

    /// Press and release a named key with the full CDP payload.
    pub async fn press_key(&self, actor: Actor, name: &str) -> Result<()> {
        self.lock.gate(actor)?;
        let k = KeyPress::named(name).ok_or_else(|| BrowserError::Protocol {
            method: "Input.dispatchKeyEvent".into(),
            message: format!("unsupported key '{name}'"),
        })?;
        for kind in ["keyDown", "keyUp"] {
            let mut params = json!({
                "type": kind,
                "key": k.key,
                "code": k.code,
                "windowsVirtualKeyCode": k.windows_virtual_key_code,
                "nativeVirtualKeyCode": k.windows_virtual_key_code,
            });
            if kind == "keyDown" {
                if let Some(text) = k.text {
                    params["text"] = json!(text);
                    params["unmodifiedText"] = json!(text);
                }
            }
            self.session_call("Input.dispatchKeyEvent", params).await?;
        }
        Ok(())
    }

    /// A touch tap. Enable touch emulation first (see
    /// [`set_touch_emulation`](Self::set_touch_emulation)) if the page only
    /// binds mouse handlers — Chrome then synthesises the compatibility click.
    pub async fn tap(&self, actor: Actor, x: f64, y: f64) -> Result<()> {
        self.lock.gate(actor)?;
        self.session_call(
            "Input.dispatchTouchEvent",
            json!({
                "type": "touchStart",
                "touchPoints": [{ "x": x, "y": y }],
            }),
        )
        .await?;
        self.session_call(
            "Input.dispatchTouchEvent",
            json!({ "type": "touchEnd", "touchPoints": [] }),
        )
        .await
        .map(|_| ())
    }

    /// Toggle touch emulation for this target.
    pub async fn set_touch_emulation(&self, actor: Actor, enabled: bool) -> Result<()> {
        self.lock.gate(actor)?;
        self.session_call(
            "Emulation.setTouchEmulationEnabled",
            json!({ "enabled": enabled, "maxTouchPoints": 5 }),
        )
        .await
        .map(|_| ())
    }

    /// Resize this target's viewport (per-target, not browser-wide) at 1:1.
    pub async fn set_viewport(
        &self,
        actor: Actor,
        width: u32,
        height: u32,
        mobile: bool,
    ) -> Result<()> {
        self.set_viewport_scaled(actor, width, height, 1.0, mobile)
            .await
    }

    /// The same override, **at the viewer's device pixel ratio** — the call
    /// that makes a shared browser legible.
    ///
    /// Two distinct things happen here and both matter:
    ///
    /// * `width`/`height` decide how the PAGE LAYS OUT. A 390px box gets the
    ///   site's mobile layout; a 1200px box gets the desktop one. Streaming a
    ///   1366px render to a 390px phone is not the same picture shrunk — it is
    ///   the wrong page.
    /// * `deviceScaleFactor` decides how SHARP it is. Chrome composites
    ///   `width × scale` real pixels, so a retina viewer asking for its own box
    ///   gets a frame with its own pixels in it rather than an upscale of a
    ///   CSS-pixel render. Clamped to [`MAX_DEVICE_SCALE`]: the cost is
    ///   quadratic and the benefit stops at one frame pixel per screen pixel.
    ///
    /// `Actor::Human` is never refused by the lock, deliberately: a person
    /// whose window is 390px wide must be able to make the page lay out at
    /// 390px even while an agent holds the wheel, because the alternative is a
    /// picture they cannot read. It is the same escalation rule the input relay
    /// runs on.
    pub async fn set_viewport_scaled(
        &self,
        actor: Actor,
        width: u32,
        height: u32,
        dpr: f64,
        mobile: bool,
    ) -> Result<()> {
        self.lock.gate(actor)?;
        let (width, height) = (width.max(1), height.max(1));
        let scale = if dpr.is_finite() {
            dpr.clamp(1.0, MAX_DEVICE_SCALE)
        } else {
            1.0
        };
        self.session_call(
            "Emulation.setDeviceMetricsOverride",
            json!({
                "width": width, "height": height,
                "deviceScaleFactor": scale, "mobile": mobile,
            }),
        )
        .await?;
        self.viewport_w.store(width, Ordering::Relaxed);
        self.viewport_h.store(height, Ordering::Relaxed);
        Ok(())
    }

    /// The CSS-pixel box this target is currently laid out at.
    ///
    /// Free (no CDP round trip) and always true, because it mirrors the only
    /// `setDeviceMetricsOverride` any code path here issues. The takeover seed
    /// uses it to send a real `width`/`height` and a real `metadata` box
    /// **before frame #1**, so the input clamp is right from the first click
    /// instead of from whenever the page next repaints — which on a static page
    /// is never.
    pub fn viewport_css(&self) -> (u32, u32) {
        (
            self.viewport_w.load(Ordering::Relaxed),
            self.viewport_h.load(Ordering::Relaxed),
        )
    }

    // ── screencast (phase 2 consumes this) ──────────────────────────────────

    /// Start (or re-subscribe to) this context's screencast and return a
    /// receiver of frames.
    ///
    /// The pump acks each frame right after fanning it out. Acking is
    /// **mandatory** — without it Chrome delivers ~3 frames and stalls — and it
    /// doubles as free backpressure (spike gotcha #2). Phase 2 may move the ack
    /// to "after the client socket accepted the frame"; the hook is one line.
    ///
    /// # Options are negotiable, not first-come
    ///
    /// This used to hand every later caller the running cast and drop their
    /// options on the floor, which made the profile a property of *whoever
    /// attached first*. A viewer telling us its screen size (the whole point of
    /// [`ScreencastOptions::drive`]) would then be answered with somebody
    /// else's 512px stream. Now:
    ///
    /// * same options ⇒ plain re-subscribe, as before;
    /// * different encoder options, same [`AckPolicy`] ⇒ chrome is stopped and
    ///   restarted with the new payload while the **pump and the channel stay
    ///   alive**, so existing subscribers keep their receiver (a fresh channel
    ///   would hand them `Closed`, which the takeover socket reads as "the
    ///   screencast died" and hangs up on the human);
    /// * a different ack policy ⇒ the pump itself is wrong (the policy is baked
    ///   in at spawn), so it is aborted and rebuilt below.
    pub async fn start_screencast(
        &self,
        actor: Actor,
        options: ScreencastOptions,
    ) -> Result<broadcast::Receiver<ScreencastFrame>> {
        self.lock.gate(actor)?;
        let mut slot = self.screencast.lock().await;
        // Copied out so no borrow of `slot` is alive across the awaits below.
        let running = slot.as_ref().map(|sc| (sc.tx.clone(), sc.options.clone()));
        if let Some((tx, current)) = running {
            if current == options {
                return Ok(tx.subscribe());
            }
            if current.ack == options.ack {
                self.session_call("Page.stopScreencast", json!({})).await?;
                self.session_call("Page.startScreencast", options.cdp_params())
                    .await?;
                if let Some(sc) = slot.as_mut() {
                    sc.options = options;
                }
                return Ok(tx.subscribe());
            }
            if let Some(old) = slot.take() {
                old.pump.abort();
            }
            self.session_call("Page.stopScreencast", json!({})).await?;
        }

        let (tx, rx) = broadcast::channel(FRAME_CHANNEL_CAP);
        let pump = {
            let mut events = self.client.subscribe();
            let client = self.client.clone();
            let want = self.cdp_session_id.clone();
            let tx = tx.clone();
            let policy = options.ack;
            tokio::spawn(async move {
                loop {
                    let ev = match events.recv().await {
                        Ok(ev) => ev,
                        Err(broadcast::error::RecvError::Lagged(n)) => {
                            debug!(dropped = n, "browser: screencast pump lagged");
                            continue;
                        }
                        Err(broadcast::error::RecvError::Closed) => break,
                    };
                    if ev.method != "Page.screencastFrame"
                        || ev.session_id.as_deref() != Some(want.as_str())
                    {
                        continue;
                    }
                    let ack = ev.params.get("sessionId").cloned();
                    let frame = ScreencastFrame {
                        data: ev
                            .params
                            .get("data")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                        metadata: ev.params.get("metadata").cloned().unwrap_or(json!({})),
                        // Under `Viewer` the consumer owns the ack, so it needs
                        // the token; under `Immediate` we ack below and hand it
                        // `None` so a consumer cannot double-ack.
                        ack: match policy {
                            AckPolicy::Viewer => ack.clone(),
                            AckPolicy::Immediate => None,
                        },
                    };
                    let _ = tx.send(frame);
                    if policy == AckPolicy::Immediate {
                        if let Some(ack) = ack {
                            if let Err(e) = client.notify(
                                Some(&want),
                                "Page.screencastFrameAck",
                                json!({ "sessionId": ack }),
                            ) {
                                warn!(error = %e, "browser: screencast ack failed");
                                break;
                            }
                        }
                    }
                }
            })
        };

        self.session_call("Page.startScreencast", options.cdp_params())
            .await?;
        *slot = Some(Screencast { tx, pump, options });
        Ok(rx)
    }

    /// Stop the screencast and drop its pump.
    pub async fn stop_screencast(&self, actor: Actor) -> Result<()> {
        self.lock.gate(actor)?;
        let taken = self.screencast.lock().await.take();
        if let Some(sc) = taken {
            sc.pump.abort();
            self.session_call("Page.stopScreencast", json!({})).await?;
        }
        Ok(())
    }

    /// Ack one screencast frame under [`AckPolicy::Viewer`].
    ///
    /// Fire-and-forget (`notify`) on purpose: at up to 60 acks/s a round trip
    /// per ack would add its own latency for a result that carries no
    /// information. **Every** frame the consumer receives must be acked exactly
    /// once — including frames it decided to DROP — because Chromium's ack is a
    /// decrement of a 2-slot in-flight counter, not a per-frame receipt. Skip
    /// one and the screencast silently stops.
    pub fn ack_frame(&self, ack: &Value) -> Result<()> {
        self.client.notify(
            Some(&self.cdp_session_id),
            "Page.screencastFrameAck",
            json!({ "sessionId": ack }),
        )
    }

    /// The methods [`dispatch_input`](Self::dispatch_input) will forward. An
    /// allowlist, not a filter: the takeover socket builds CDP payloads from
    /// untrusted client JSON, so the set of commands it can reach is pinned
    /// here rather than wherever the next caller happens to be written.
    pub const INPUT_METHODS: [&'static str; 4] = [
        "Input.dispatchMouseEvent",
        "Input.dispatchKeyEvent",
        "Input.dispatchTouchEvent",
        "Input.insertText",
    ];

    /// Forward one already-built `Input.*` payload to this context's page.
    ///
    /// The typed helpers above (`click`, `press_key`, …) are what a *tool call*
    /// wants — one intention, several CDP events. A human at a takeover canvas
    /// is the other shape: raw pointer/key events at ~60 Hz that must arrive
    /// individually (a `mouseMoved` during a drag is not a click). This is that
    /// seam, and it carries the same [`Actor`] gate as every other mutating
    /// method — plus the [`INPUT_METHODS`](Self::INPUT_METHODS) allowlist.
    pub async fn dispatch_input(&self, actor: Actor, method: &str, params: Value) -> Result<()> {
        self.lock.gate(actor)?;
        if !Self::INPUT_METHODS.contains(&method) {
            return Err(BrowserError::Protocol {
                method: method.to_string(),
                message: "not an allowed input method".to_string(),
            });
        }
        self.session_call(method, params).await.map(|_| ())
    }

    /// One-shot JPEG of the current page, base64. Needed because a static page
    /// emits no screencast frames (gotcha #1) — a client attaching mid-idle
    /// would otherwise see a blank canvas.
    pub async fn screenshot(&self) -> Result<String> {
        let out = self
            .session_call(
                "Page.captureScreenshot",
                json!({ "format": "jpeg", "quality": 70 }),
            )
            .await?;
        Ok(out
            .get("data")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string())
    }

    // ── teardown ────────────────────────────────────────────────────────────

    /// Close the page and dispose the browser context. Best-effort: every step
    /// runs even if an earlier one failed, so a half-dead browser still gets
    /// the disposal commands it can honour.
    pub async fn close(&self) {
        let taken = self.screencast.lock().await.take();
        if let Some(sc) = taken {
            sc.pump.abort();
        }
        if let Err(e) = self
            .client
            .call("Target.closeTarget", json!({ "targetId": self.target_id }))
            .await
        {
            debug!(session = %self.session, error = %e, "browser: closeTarget");
        }
        // **Only a scratch context is disposed.** Disposing the DEFAULT context
        // would be a protocol error at best and would nuke every other workspace
        // tab — and the profile's cookies with them — at worst (v1 §2.3 R5). A
        // workspace tab closes with `closeTarget` and nothing else.
        let Some(bcid) = self.browser_context_id.as_deref() else {
            return;
        };
        if let Err(e) = self
            .client
            .call(
                "Target.disposeBrowserContext",
                json!({ "browserContextId": bcid }),
            )
            .await
        {
            debug!(session = %self.session, error = %e, "browser: disposeBrowserContext");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_cdp_payload_matches_the_profile() {
        let opts = ScreencastOptions::drive(1200, 800, 1.0);
        let p = opts.cdp_params();
        assert_eq!(p["format"], "jpeg");
        assert_eq!(p["quality"], json!(75));
        assert_eq!(p["maxWidth"], json!(1200));
        assert_eq!(p["maxHeight"], json!(800));
        assert_eq!(p["everyNthFrame"], json!(DRIVE_EVERY_NTH));
        // `everyNthFrame: 0` is a protocol error; the floor is enforced at the
        // payload, so no caller can construct one that stalls the cast.
        let zero = ScreencastOptions {
            every_nth_frame: 0,
            ..ScreencastOptions::watch()
        };
        assert_eq!(zero.cdp_params()["everyNthFrame"], json!(1));
    }

    #[test]
    fn the_drive_profile_is_the_viewers_real_pixels_capped() {
        // 1:1 laptop.
        let laptop = ScreencastOptions::drive(1366, 768, 1.0);
        assert_eq!((laptop.max_width, laptop.max_height), (1366, 768));
        // Retina: the cap is real pixels, or the frame is an upscale of a
        // CSS-pixel render and the text stays soft.
        let retina = ScreencastOptions::drive(700, 500, 2.0);
        assert_eq!((retina.max_width, retina.max_height), (1400, 1000));
        // The device-scale ceiling is a cost guard: rendering is quadratic in it.
        let phone = ScreencastOptions::drive(390, 400, 3.0);
        assert_eq!(phone.max_width, 780, "dpr clamped to MAX_DEVICE_SCALE");
        // A wall is still capped.
        let wall = ScreencastOptions::drive(4096, 4096, 2.0);
        assert_eq!(wall.max_width, ScreencastOptions::MAX_STREAM_PX);
        // Nonsense in, sane out.
        let bad = ScreencastOptions::drive(0, 0, f64::NAN);
        assert_eq!((bad.max_width, bad.max_height), (1, 1));
    }

    #[test]
    fn the_watch_profile_is_the_spikes_measured_default() {
        // The in-chat card's stream. If this moves, the agent-watch path
        // regressed — which this change is explicitly not allowed to do.
        assert_eq!(ScreencastOptions::watch(), ScreencastOptions::default());
        let w = ScreencastOptions::watch();
        assert_eq!((w.max_width, w.max_height, w.quality, w.every_nth_frame), (512, 512, 60, 1));
        // …and it is a DIFFERENT profile from any negotiated one, which is what
        // makes `start_screencast` restart the cast instead of re-subscribing.
        assert_ne!(ScreencastOptions::watch(), ScreencastOptions::drive(1200, 800, 1.0));
        assert_eq!(
            ScreencastOptions::drive(1200, 800, 1.0),
            ScreencastOptions::drive(1200, 800, 1.0),
            "same request ⇒ same options ⇒ a plain re-subscribe",
        );
    }

    #[test]
    fn named_keys_carry_the_full_payload() {
        let enter = KeyPress::named("Enter").unwrap();
        assert_eq!(enter.code, "Enter");
        assert_eq!(enter.windows_virtual_key_code, 13);
        assert_eq!(enter.text, Some("\r"));
        // gotcha #8: `code` must never be empty or pages reading e.code break.
        for name in [
            "Enter",
            "Backspace",
            "Tab",
            "Escape",
            "ArrowUp",
            "ArrowDown",
        ] {
            assert!(!KeyPress::named(name).unwrap().code.is_empty(), "{name}");
        }
        assert!(KeyPress::named("F13").is_none());
    }

    #[test]
    fn screencast_defaults_are_the_mobile_profile() {
        let o = ScreencastOptions::default();
        assert_eq!(o.format, "jpeg");
        assert!(o.quality <= 70, "jpeg beats png ~2.3x; keep quality modest");
        assert!(
            o.max_width <= 512 && o.max_height <= 512,
            "size server-side (gotcha #4)"
        );
        assert_eq!(o.every_nth_frame, 1);
    }
}
