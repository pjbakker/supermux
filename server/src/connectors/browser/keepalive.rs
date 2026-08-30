//! **"Keep me signed in"** — the per-tab background sweep that keeps a
//! signed-in workspace tab's session fresh so overnight bot work does not wake
//! up logged out.
//!
//! One 60-second loop. Per *due* tab it does exactly this and nothing else:
//!
//! ```text
//!   wake the tab if it is asleep      (at most 2 cold wakes per tick)
//!     └─ unless a HUMAN holds the wheel — then skip the whole tick
//!   soft ping: the PAGE fetches its own origin root
//!   read the cookie jar over CDP                     ← AFTER the ping
//!   next tick = clamp(shortest auth-cookie lifetime / 2, 5 min, 6 h)
//! ```
//!
//! # The three rules that carry the design
//!
//! **1. Soft ping, always. [`Page.reload`] is not implemented here, in any
//! mode, behind any flag.** A reload burns one-time CSRF nonces, drops unsaved
//! form state, and can land on top of a bot mid-action. A page-context `fetch`
//! slides a sliding cookie's expiry (measured: a `Max-Age=600` cookie moved
//! forward by exactly the elapsed time) and leaves `Page.getNavigationHistory`
//! at one entry.
//!
//! **2. `needs_login` is an enforcement gate, not a label.**
//! [`super::tools`] turns it into a **409 on every agent verb, reads
//! included**. So the sign-out detector is deliberately conservative: a benign
//! `/` → `/home` redirect must never trip it, ambiguity always resolves to
//! [`Ping::Unclear`], and a claim needs two consecutive strikes. Any successful
//! ping writes `ok`, so a false positive undoes itself within 10 minutes.
//!
//! **3. The shortest cookie in the jar is not the session clock.** A 5-minute
//! CSRF/consent cookie sitting beside a 10-minute httpOnly auth cookie is the
//! common shape; picking the minimum naively mis-times the schedule and (in the
//! design this replaces) refused to enable on perfectly healthy sites.
//! [`auth_deadline`] prefers httpOnly candidates for that reason.
//!
//! # Why the cookie read happens AFTER the ping
//!
//! With `every = ttl/2`, reading the deadline *before* the ping reads a sliding
//! site at roughly half its window. An 18-minute sliding window would give
//! `every = 9 min`; the next tick would then see ~9 minutes left, trip the
//! "under 10 minutes" watch rule, stop refreshing — and sign the owner out by
//! its own hand. Post-ping, a sliding site reads its full window.
//!
//! [`Page.reload`]: https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-reload

use std::collections::HashMap;

use rand::Rng;
use serde_json::Value;
use tokio::time::MissedTickBehavior;

use crate::db::browser_tabs as db_tabs;
use crate::db::browser_tabs::TabPatch;
use crate::db::push::NotifCategory;
use crate::notify::{PushPayload, Tier};
use crate::push;
use crate::state::AppState;

use super::lock::DriveMode;

// ── the numbers ──────────────────────────────────────────────────────────────

/// The sweep's period. Also the retry interval for everything that writes
/// nothing (an unconfirmed sign-out, an unclear answer, a deferred human tick).
pub const TICK: std::time::Duration = std::time::Duration::from_secs(60);
/// Below this a tab requests its own origin more often than any human uses a
/// site — the cheapest bot-detection signal there is.
pub const FLOOR_MINUTES: i64 = 5;
/// Nothing known. Server-side sessions cluster at ASP.NET's 20 min and PHP's
/// `session.gc_maxlifetime` 1440 s (24 min); 15 clears both with a missed tick
/// of margin, at the traffic cost of one human tab left open.
pub const BLIND_MINUTES: i64 = 15;
/// A 14-day cookie does not need hourly attention. 4 requests/day is the whole
/// drift budget.
pub const CEILING_MINUTES: i64 = 360;
/// Under this remaining lifetime supermux **stops pinging and only watches**. A
/// 5-15 minute idle timeout is a deliberate security control (PCI DSS 4.0
/// §8.2.8 wants re-auth after 15 idle minutes on cardholder systems); defeating
/// it on a bank tab is the least defensible thing this feature could do.
pub const WATCH_UNDER_SECS: i64 = 600;
/// Cadence while watching, and while a tab is known signed out.
pub const WATCH_EVERY_MINUTES: i64 = 10;
/// Cadence while `needs_login` — short, because this is also how a re-sign-in
/// is noticed and the 409 gate lifted.
pub const NEEDS_LOGIN_MINUTES: i64 = 10;
/// An enabled tab is kept LIVE, and a live tab disarms the idle reaper, so
/// Chrome stays up while any tab has the toggle on. This cap is that cost,
/// stated in the UI rather than hidden.
pub const MAX_ENABLED_TABS: usize = 4;
/// Cold wakes per tick — a boot with four enabled tabs staggers over two
/// minutes instead of stampeding one Chrome start.
pub const MAX_WAKES_PER_TICK: usize = 2;
/// Consecutive non-answers before the sweep stops retrying every 60 s and falls
/// back to the plan's interval.
pub const UNCLEAR_STRIKES: u8 = 3;
/// A tick skipped because the human holds the wheel retries after this.
pub const HUMAN_DEFER_SECS: i64 = 120;

/// `keepalive_action` — soft mode: fetch-ping, then read the jar.
pub const ACTION_SOFT: &str = "soft";
/// `keepalive_action` — watch mode: read the jar only, ping nothing.
pub const ACTION_WATCH: &str = "watch";

// ── the ping ─────────────────────────────────────────────────────────────────

/// WHY a `fetch` and not `Page.reload`: a reload burns one-time CSRF nonces,
/// drops unsaved form state, and can land on top of a bot mid-action. This is a
/// normal same-origin GET issued by the real page, so the network stack applies
/// any `Set-Cookie` to the jar (measured: a `Max-Age=600` cookie's expiry moved
/// forward by exactly the elapsed time), it carries the page's genuine
/// TLS/UA-CH/Referer profile, and it never touches the DOM (measured: the
/// navigation history stays at one entry).
///
/// `redirect:'follow'` and NOT `'manual'`: manual collapses a benign
/// `/ -> /home` and a real login bounce into the same `opaqueredirect:0`, and
/// acting on that ambiguity would 409 every bot on a healthy tab.
///
/// `AbortSignal.timeout(10000)` is the stall guard: `evaluate` awaits the
/// promise under the CDP client's deadline, so an unbounded fetch would hold
/// the sweep. Measured: a 25 s endpoint settles at 10.0 s.
///
/// **Nothing is interpolated into this string**, so it has no injection
/// surface, and the origin is computed *inside the page*, so the request is
/// same-origin by construction and no allowlist check is needed.
pub const PING_JS: &str = "(location.origin.indexOf('http')===0?\
fetch(location.origin+'/',{credentials:'include',cache:'no-store',redirect:'follow',\
signal:AbortSignal.timeout(10000)})\
.then(function(r){return r.type+' '+r.status+' '+(r.redirected?1:0)+' '+(r.url?new URL(r.url).pathname:'')})\
.catch(function(e){return 'error '+(e&&e.name)}):Promise.resolve('skip 0 0 '))";

// ── the cookie clock ─────────────────────────────────────────────────────────

/// The three fields of a CDP cookie this feature reads. Everything else in the
/// jar (name, value, domain, path) is deliberately **not** carried: a keep-alive
/// that copies cookie values around is one bug away from being an exfiltration
/// primitive.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CookieLite {
    /// Unix seconds, or `-1` for a session cookie.
    pub expires: f64,
    pub session: bool,
    pub http_only: bool,
}

impl CookieLite {
    /// Read one `Network.getCookies` entry. Missing fields read as a session
    /// cookie, which [`auth_deadline`] ignores — the safe direction.
    pub fn from_cdp(v: &Value) -> Self {
        Self {
            expires: v.get("expires").and_then(Value::as_f64).unwrap_or(-1.0),
            session: v.get("session").and_then(Value::as_bool).unwrap_or(false),
            http_only: v.get("httpOnly").and_then(Value::as_bool).unwrap_or(false),
        }
    }
}

/// Seconds until the soonest deadline this origin's session appears to rely on,
/// or `None` when nothing in the jar carries one.
///
/// **httpOnly first, and only httpOnly when any exists.** A real auth cookie is
/// httpOnly (measured: a test jar's `sid` is invisible to `document.cookie`
/// while its 5-minute `shortcsrf` is not), so preferring it keeps a short
/// CSRF/consent/challenge cookie from impersonating the session clock. Falling
/// back to every non-session cookie when nothing is httpOnly is wrong only in
/// the safe direction: a too-short deadline just means a chattier schedule,
/// clamped at the 5-minute floor, while a too-long one misses the expiry.
pub fn auth_deadline(cookies: &[CookieLite], now: i64) -> Option<i64> {
    let live: Vec<&CookieLite> = cookies
        .iter()
        .filter(|c| !c.session && c.expires > now as f64)
        .collect();
    let has_http_only = live.iter().any(|c| c.http_only);
    live.iter()
        .filter(|c| !has_http_only || c.http_only)
        .map(|c| c.expires as i64 - now)
        .min()
}

/// What the next tick should do, and when.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Plan {
    /// Keep pinging, this many minutes apart.
    Refresh(i64),
    /// Read the jar only. Zero network traffic, zero detection surface.
    Watch,
}

impl Plan {
    /// The cadence this plan wants written to `keepalive_every`.
    pub fn minutes(self) -> i64 {
        match self {
            Plan::Refresh(m) => m,
            Plan::Watch => WATCH_EVERY_MINUTES,
        }
    }
    /// The `keepalive_action` this plan wants written.
    pub fn action(self) -> &'static str {
        match self {
            Plan::Refresh(_) => ACTION_SOFT,
            Plan::Watch => ACTION_WATCH,
        }
    }
}

/// `ttl / 2`, clamped — ASP.NET Core's `SlidingExpiration` handler re-issues the
/// cookie on any request past the halfway point of the window, so a halfway
/// ping is literally what such a server waits for. It also survives one missed
/// tick before expiry and self-tunes across four orders of magnitude with no
/// per-site configuration.
///
/// **The watch decision is never latched**: it is recomputed from the post-ping
/// jar on every tick, so an ephemeral 5-minute cookie that briefly shortened
/// the deadline stops mattering the moment it expires.
pub fn plan_for(ttl_secs: Option<i64>) -> Plan {
    match ttl_secs {
        None => Plan::Refresh(BLIND_MINUTES),
        Some(t) if t < WATCH_UNDER_SECS => Plan::Watch,
        Some(t) => Plan::Refresh((t / 120).clamp(FLOOR_MINUTES, CEILING_MINUTES)),
    }
}

// ── reading the ping ─────────────────────────────────────────────────────────

/// What one ping said about the sign-in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ping {
    /// The origin answered as a signed-in page would.
    Alive,
    /// It answered like a sign-in wall. **Never acted on alone** — see
    /// [`decide`].
    Suspicious,
    /// The site's problem, a transport error, or a page we cannot ping. Never a
    /// sign-out claim.
    Unclear,
}

/// Parse `"<type> <status> <redirected> <path>"` — the only four things
/// [`PING_JS`] reports.
///
/// Everything ambiguous lands on [`Ping::Unclear`] on purpose: a false
/// `Suspicious` costs a 409 on every agent verb for the tab, while a missed
/// sign-out costs a stale age line that the next tick corrects.
pub fn classify(raw: &str) -> Ping {
    let mut it = raw.splitn(4, ' ');
    match it.next().unwrap_or("") {
        "error" | "skip" | "" => return Ping::Unclear,
        _ => {}
    }
    let status: u16 = it.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    // Redundant with the path, and deliberately kept in the wire line so a log
    // entry reads on its own.
    let _redirected = it.next();
    let path = it.next().unwrap_or("");
    if status == 401 || status == 403 {
        return Ping::Suspicious;
    }
    if (200..400).contains(&status) {
        if looks_like_login_path(path) {
            return Ping::Suspicious;
        }
        return Ping::Alive;
    }
    Ping::Unclear
}

/// EXACT path-**segment** match, never a substring: `/logistics` contains "log"
/// and `/assorted` contains "sso", and a substring rule would flip both tabs to
/// `needs_login` — which 409s every bot on them.
pub fn looks_like_login_path(path: &str) -> bool {
    const WORDS: [&str; 11] = [
        "login",
        "log-in",
        "log_in",
        "signin",
        "sign-in",
        "sign_in",
        "sso",
        "auth",
        "authorize",
        "oauth",
        "session",
    ];
    path.split('/')
        .any(|seg| WORDS.iter().any(|w| seg.eq_ignore_ascii_case(w)))
}

// ── the outcome state machine ────────────────────────────────────────────────

/// What a tick actually observed. Distinct from [`Ping`] because a tick spent
/// in watch mode issues no ping at all and therefore may claim nothing about
/// the sign-in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    /// We pinged, and this is what came back.
    Pinged(Ping),
    /// We were in watch mode: the jar was read, nothing was requested.
    Watching,
}

/// The DB write a tick produces.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Write {
    /// **Nothing at all.** The row keeps its old `last_keepalive_at`, so it
    /// stays due and the next tick retries in 60 s. That is the entire
    /// two-strike confirmation mechanism — no extra state anywhere.
    Nothing,
    /// Stamp the tick, and set the cadence, the mode, and (only when the tick
    /// actually checked) the sign-in state.
    Stamp {
        every: i64,
        action: &'static str,
        login_state: Option<&'static str>,
        probed: bool,
    },
}

/// A tick's whole effect: what to write, and whether to fire the one push.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Step {
    pub write: Write,
    /// Only on the `ok|unknown → needs_login` edge — never per tick.
    pub push_signed_out: bool,
}

/// Per-tab memory, owned as a local by the single sweeper task. No `Mutex`, no
/// `AppState` field, nothing to serialise — a restart simply re-learns, and the
/// worst a lost strike costs is one more 60-second confirmation.
#[derive(Debug, Default, Clone, Copy)]
pub struct Health {
    /// Consecutive [`Ping::Unclear`] answers.
    pub strikes: u8,
    /// Was the previous outcome [`Ping::Suspicious`]?
    pub last_suspicious: bool,
    /// The ±10 % offset drawn at the last stamp, in seconds.
    pub jitter: i64,
    /// Unix seconds before which this tab is not touched (the human-driving
    /// back-off).
    pub defer_until: i64,
}

/// Fold one tick's outcome and plan into a write.
///
/// The plan owns the **cadence and the mode**; the outcome owns the **sign-in
/// claim**. Keeping those two axes separate is what makes both of these true at
/// once:
///
/// * any `Alive` writes `ok` — so a false `needs_login` self-heals within 10
///   minutes even on a site that has just dropped into watch mode (without
///   this, a bank tab the owner had already signed back into would stay
///   409-gated forever, because watch mode never pings again);
/// * a tick spent **watching** writes no `login_state` and no `probed_now` — it
///   requested nothing, so it knows nothing new, and saying otherwise would be
///   the false green light the workspace exists to prevent.
pub fn decide(health: &mut Health, outcome: Outcome, plan: Plan, was_needs_login: bool) -> Step {
    match outcome {
        Outcome::Pinged(Ping::Suspicious) => {
            health.strikes = 0;
            if health.last_suspicious {
                // Confirmed. The cadence drops to 10 min because this is also
                // how a re-sign-in is noticed and the 409 gate lifted.
                Step {
                    write: Write::Stamp {
                        every: NEEDS_LOGIN_MINUTES,
                        action: ACTION_SOFT,
                        login_state: Some(db_tabs::LOGIN_NEEDED),
                        probed: true,
                    },
                    push_signed_out: !was_needs_login,
                }
            } else {
                // First strike: write NOTHING, stay due, ask again in 60 s. The
                // cost of a false positive is every bot on this tab hitting a
                // 409; the cost of the second tick is a minute of patience.
                health.last_suspicious = true;
                Step {
                    write: Write::Nothing,
                    push_signed_out: false,
                }
            }
        }
        Outcome::Pinged(Ping::Alive) => {
            health.strikes = 0;
            health.last_suspicious = false;
            Step {
                write: Write::Stamp {
                    every: plan.minutes(),
                    action: plan.action(),
                    login_state: Some(db_tabs::LOGIN_OK),
                    probed: true,
                },
                push_signed_out: false,
            }
        }
        Outcome::Pinged(Ping::Unclear) => {
            // An unclear answer breaks a Suspicious streak: "twice in a row"
            // means twice in a row.
            health.last_suspicious = false;
            health.strikes = health.strikes.saturating_add(1);
            if health.strikes >= UNCLEAR_STRIKES {
                // Back off to the plan's interval. NEVER a `login_state` write:
                // we did not learn anything about the sign-in.
                Step {
                    write: Write::Stamp {
                        every: plan.minutes(),
                        action: plan.action(),
                        login_state: None,
                        probed: false,
                    },
                    push_signed_out: false,
                }
            } else {
                Step {
                    write: Write::Nothing,
                    push_signed_out: false,
                }
            }
        }
        Outcome::Watching => {
            health.last_suspicious = false;
            Step {
                write: Write::Stamp {
                    every: plan.minutes(),
                    action: plan.action(),
                    login_state: None,
                    probed: false,
                },
                push_signed_out: false,
            }
        }
    }
}

// ── the schedule ─────────────────────────────────────────────────────────────

/// When this row next becomes due.
///
/// `last == None` ⇒ `0` ⇒ **due now**, which is how enabling schedules its first
/// tick inside 60 s with no extra state: the enable path simply nulls the
/// column.
pub fn due_at(last: Option<i64>, every_min: i64, jitter_secs: i64) -> i64 {
    match last {
        None => 0,
        Some(t) => t + every_min * 60 + jitter_secs,
    }
}

/// ±10 % of the interval, drawn once per stamp and held in memory. The
/// persisted `keepalive_every` stays the clean number the UI renders; jitter
/// never reaches the DB — so four tabs learning the same 15-minute cadence do
/// not march in lockstep forever.
pub fn draw_jitter(every_min: i64) -> i64 {
    let span = (every_min * 60) / 10;
    if span <= 0 {
        return 0;
    }
    rand::thread_rng().gen_range(-span..=span)
}

/// Does this row's mode mean "ping"? **Any unrecognised value resolves to soft**
/// — including the column's legacy migration default `'reload'`, which is an
/// artifact of a design that was never built. Reload is not implemented
/// anywhere in this feature and so cannot be reached by accident.
pub fn is_watch_mode(action: &str) -> bool {
    action == ACTION_WATCH
}

// ── the loop ─────────────────────────────────────────────────────────────────

/// Start the sweep. Mirrors `workflows::spawn`.
pub fn spawn(state: AppState) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(TICK);
        // Burst would fire every missed tick at once after a suspend — a
        // stampede of pings is exactly the footprint this feature avoids.
        tick.set_missed_tick_behavior(MissedTickBehavior::Skip);
        let mut health: HashMap<String, Health> = HashMap::new();
        loop {
            tick.tick().await;
            sweep(&state, &mut health).await;
        }
    });
}

/// One tick. Public so a test can drive it deterministically.
///
/// **Nothing here touches `state.browser` until a row says the human asked for
/// it** — the lazy-start invariant is honoured, not repealed: a supermux with
/// no keep-alive tab never spawns Chrome because of this loop.
pub async fn sweep(state: &AppState, health: &mut HashMap<String, Health>) {
    let rows = match db_tabs::list_keepalive(&state.pool).await {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!(error = %e, "keepalive: could not list tabs");
            return;
        }
    };
    if rows.is_empty() {
        return;
    }
    let now = chrono::Utc::now().timestamp();
    // Drop memory for tabs that are gone or switched off, so the map cannot
    // grow across a long uptime.
    health.retain(|id, _| rows.iter().any(|r| &r.id == id));

    let live = state.browser.live_tabs().await;
    let mut woken = 0usize;

    for row in &rows {
        let h = *health.entry(row.id.clone()).or_default();
        if now < h.defer_until {
            continue;
        }
        if now < due_at(row.last_keepalive_at, row.keepalive_every, h.jitter) {
            continue;
        }
        // `about:blank` and friends cannot be pinged (`location.origin` is
        // `'null'`), and there is nothing to learn from their jar. Stamp so the
        // row does not spin, and try again at the blind interval.
        if !row.url.starts_with("http") {
            stamp(state, &row.id, BLIND_MINUTES, ACTION_SOFT, None, false).await;
            continue;
        }
        if !live.contains(&row.id) {
            if woken >= MAX_WAKES_PER_TICK {
                continue;
            }
            woken += 1;
        }
        // TooManyTabs / a launch failure is Unclear, never a reason to evict
        // somebody else's tab.
        let tab = match super::api::wake_tab(state, row).await {
            Ok(t) => t,
            Err(e) => {
                tracing::debug!(tab = %row.id, error = %e, "keepalive: could not wake");
                let entry = health.entry(row.id.clone()).or_default();
                let step = decide(entry, Outcome::Pinged(Ping::Unclear), Plan::Refresh(row.keepalive_every), false);
                apply(state, row, step).await;
                continue;
            }
        };
        // THE load-bearing guard. `AgentContext::evaluate` is ungated by design
        // ("reading the DOM is never a control conflict"), so without this the
        // sweep would fire while the owner is typing a password on their phone.
        // `AgentDriving` is NOT a pause: it only means no human holds the wheel,
        // and a fetch touches no DOM, steals no focus and does not navigate.
        if tab.mode() == DriveMode::HumanDriving {
            health.entry(row.id.clone()).or_default().defer_until = now + HUMAN_DEFER_SECS;
            continue;
        }

        let outcome = if is_watch_mode(&row.keepalive_action) {
            Outcome::Watching
        } else {
            match tab.page().evaluate(PING_JS).await {
                Ok(v) => Outcome::Pinged(classify(v.as_str().unwrap_or(""))),
                Err(e) => {
                    tracing::debug!(tab = %row.id, error = %e, "keepalive: ping failed");
                    Outcome::Pinged(Ping::Unclear)
                }
            }
        };
        // AFTER the ping — a sliding site reads its full window here, and its
        // half-window before. See the module header.
        let jar: Vec<CookieLite> = match tab.page().cookies().await {
            Ok(cs) => cs.iter().map(CookieLite::from_cdp).collect(),
            Err(e) => {
                tracing::debug!(tab = %row.id, error = %e, "keepalive: cookie read failed");
                Vec::new()
            }
        };
        let plan = plan_for(auth_deadline(&jar, now));
        let entry = health.entry(row.id.clone()).or_default();
        let step = decide(
            entry,
            outcome,
            plan,
            row.login_state == db_tabs::LOGIN_NEEDED,
        );
        if matches!(step.write, Write::Stamp { .. }) {
            entry.jitter = draw_jitter(plan.minutes());
        }
        apply(state, row, step).await;
        // The tab is LEFT LIVE. Dehydrating it would replace this ~1 KB fetch
        // with a full page load of `meta.url` on the next tick — the opposite
        // of a quiet keep-alive.
    }
}

/// Perform a step's write, its audit row and its one push.
async fn apply(state: &AppState, row: &db_tabs::TabRow, step: Step) {
    let Write::Stamp {
        every,
        action,
        login_state,
        probed,
    } = step.write
    else {
        return;
    };
    stamp(state, &row.id, every, action, login_state, probed).await;
    if !step.push_signed_out {
        return;
    }
    let host = host_of(&row.url);
    let _ = crate::db::audit::log(
        &state.pool,
        "system",
        "browser.keepalive_signed_out",
        &format!("tab:{}", row.id),
        serde_json::json!({ "host": host }),
    )
    .await;
    // `AgentWaiting` is reused deliberately: it is literally the "needs you"
    // category and it honours the owner's existing mute prefs, whereas a new
    // category means new prefs plumbing. `session: None` — this is not about
    // one bot.
    push::send_push_for(
        state,
        NotifCategory::AgentWaiting,
        &PushPayload::simple(
            format!("Signed out of {host}"),
            "Bots using this tab are blocked until you sign in again.".to_string(),
            "/browser",
            Tier::Attention,
        ),
        None,
    )
    .await;
}

async fn stamp(
    state: &AppState,
    tab_id: &str,
    every: i64,
    action: &str,
    login_state: Option<&str>,
    probed: bool,
) {
    let patch = TabPatch {
        login_state: login_state.map(str::to_string),
        probed_now: probed,
        keepalive_every: Some(every),
        keepalive_action: Some(action.to_string()),
        keepalive_stamp_now: true,
        ..Default::default()
    };
    if let Err(e) = db_tabs::update(&state.pool, tab_id, &patch).await {
        tracing::warn!(tab = %tab_id, error = %e, "keepalive: could not stamp");
    }
}

/// Host for the copy, falling back to the raw url — never a panic and never an
/// empty title.
fn host_of(url: &str) -> String {
    url.split("://")
        .nth(1)
        .and_then(|rest| rest.split('/').next())
        .filter(|h| !h.is_empty())
        .unwrap_or(url)
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn c(expires: f64, session: bool, http_only: bool) -> CookieLite {
        CookieLite {
            expires,
            session,
            http_only,
        }
    }

    /// F2's regression test, on the exact measured jar: a 5-minute non-httpOnly
    /// `shortcsrf` beside the real 10-minute httpOnly `sid`. Taking the naive
    /// minimum here is what made the previous design refuse to enable on a
    /// perfectly healthy site — and lie about why.
    #[test]
    fn the_httponly_cookie_is_the_clock_not_the_shortest_one() {
        let now = 1_788_114_850;
        let jar = [
            c(now as f64 + 300.0, false, false), // shortcsrf
            c(now as f64 + 600.0, false, true),  // sid — the real auth cookie
            c(-1.0, true, false),                // sess
        ];
        assert_eq!(auth_deadline(&jar, now), Some(600));
    }

    #[test]
    fn with_no_httponly_cookie_every_non_session_cookie_counts() {
        let now = 1_000_000;
        let jar = [c(now as f64 + 300.0, false, false), c(now as f64 + 1200.0, false, false)];
        assert_eq!(auth_deadline(&jar, now), Some(300));
    }

    #[test]
    fn a_session_only_or_empty_jar_carries_no_deadline() {
        let now = 1_000_000;
        assert_eq!(auth_deadline(&[], now), None);
        assert_eq!(auth_deadline(&[c(-1.0, true, false), c(-1.0, true, true)], now), None);
    }

    #[test]
    fn an_already_expired_cookie_is_not_a_deadline() {
        let now = 1_000_000;
        let jar = [c(now as f64 - 10.0, false, true), c(now as f64 + 4000.0, false, true)];
        assert_eq!(auth_deadline(&jar, now), Some(4000));
        assert_eq!(auth_deadline(&[c(now as f64 - 10.0, false, true)], now), None);
    }

    #[test]
    fn the_plan_is_half_the_window_clamped_and_watches_under_ten_minutes() {
        assert_eq!(plan_for(None), Plan::Refresh(BLIND_MINUTES));
        assert_eq!(plan_for(Some(1800)), Plan::Refresh(15));
        assert_eq!(plan_for(Some(2880)), Plan::Refresh(24));
        assert_eq!(plan_for(Some(601)), Plan::Refresh(5)); // floor
        assert_eq!(plan_for(Some(599)), Plan::Watch);
        assert_eq!(plan_for(Some(14 * 86_400)), Plan::Refresh(CEILING_MINUTES));
    }

    /// The 18-minute sliding window from §F3, spelled out: reading the deadline
    /// BEFORE the ping would see ~half the window and schedule 9 minutes out;
    /// the tick after that would see 9 minutes left, trip the watch rule, stop
    /// refreshing — and sign the owner out by supermux's own hand. Post-ping the
    /// jar reads the full 18 minutes and the cadence is 9 with no watch trip.
    #[test]
    fn the_post_ping_read_is_what_keeps_a_sliding_site_refreshing() {
        assert_eq!(plan_for(Some(18 * 60)), Plan::Refresh(9)); // post-ping: full window
        assert_eq!(plan_for(Some(9 * 60)), Plan::Watch); // pre-ping: the self-inflicted sign-out
    }

    #[test]
    fn classify_reads_the_four_fields_and_resolves_every_ambiguity_to_unclear() {
        assert_eq!(classify("basic 200 0 /"), Ping::Alive);
        assert_eq!(classify("basic 200 0 /home"), Ping::Alive);
        assert_eq!(classify("basic 200 1 /home"), Ping::Alive);
        assert_eq!(classify("basic 200 0 /login"), Ping::Suspicious);
        assert_eq!(classify("basic 401 0 /"), Ping::Suspicious);
        assert_eq!(classify("basic 403 0 /"), Ping::Suspicious);
        assert_eq!(classify("basic 404 0 /"), Ping::Unclear);
        assert_eq!(classify("basic 500 0 /"), Ping::Unclear);
        assert_eq!(classify("error TypeError"), Ping::Unclear);
        assert_eq!(classify("error TimeoutError"), Ping::Unclear);
        assert_eq!(classify("skip 0 0 "), Ping::Unclear);
        assert_eq!(classify(""), Ping::Unclear);
    }

    #[test]
    fn a_login_path_is_matched_by_segment_never_by_substring() {
        for p in ["/login", "/users/sign_in", "/auth/login", "/sso", "/oauth/authorize"] {
            assert!(looks_like_login_path(p), "{p} should read as a login path");
        }
        // The substring trap. Both of these would otherwise 409 every bot on
        // the tab.
        for p in ["/", "/home", "/dashboard", "/logistics", "/assorted", "/blog/authors"] {
            assert!(!looks_like_login_path(p), "{p} must NOT read as a login path");
        }
    }

    #[test]
    fn the_outcome_state_machine_needs_two_strikes_and_self_heals() {
        let mut h = Health::default();
        let plan = Plan::Refresh(45);

        // Alive stamps, writes ok, and marks the evidence fresh.
        let s = decide(&mut h, Outcome::Pinged(Ping::Alive), plan, false);
        assert_eq!(
            s.write,
            Write::Stamp {
                every: 45,
                action: ACTION_SOFT,
                login_state: Some(db_tabs::LOGIN_OK),
                probed: true
            }
        );
        assert!(!s.push_signed_out);

        // One Suspicious writes NOTHING — the row stays due, and 60 s later we
        // ask again.
        let s = decide(&mut h, Outcome::Pinged(Ping::Suspicious), plan, false);
        assert_eq!(s.write, Write::Nothing);
        assert!(!s.push_signed_out);

        // Twice in a row: the claim, the 10-minute cadence, and ONE push.
        let s = decide(&mut h, Outcome::Pinged(Ping::Suspicious), plan, false);
        assert_eq!(
            s.write,
            Write::Stamp {
                every: NEEDS_LOGIN_MINUTES,
                action: ACTION_SOFT,
                login_state: Some(db_tabs::LOGIN_NEEDED),
                probed: true
            }
        );
        assert!(s.push_signed_out);
        // Already signed out ⇒ no second push.
        let s = decide(&mut h, Outcome::Pinged(Ping::Suspicious), plan, true);
        assert!(!s.push_signed_out);

        // Signing back in is noticed by the very next Alive.
        let s = decide(&mut h, Outcome::Pinged(Ping::Alive), plan, true);
        assert_eq!(
            s.write,
            Write::Stamp {
                every: 45,
                action: ACTION_SOFT,
                login_state: Some(db_tabs::LOGIN_OK),
                probed: true
            }
        );
        assert!(!h.last_suspicious);
    }

    #[test]
    fn an_unclear_answer_breaks_the_suspicious_streak() {
        let mut h = Health::default();
        let plan = Plan::Refresh(15);
        assert_eq!(decide(&mut h, Outcome::Pinged(Ping::Suspicious), plan, false).write, Write::Nothing);
        assert_eq!(decide(&mut h, Outcome::Pinged(Ping::Unclear), plan, false).write, Write::Nothing);
        // Not "twice in a row" any more: this is a first strike again.
        assert_eq!(decide(&mut h, Outcome::Pinged(Ping::Suspicious), plan, false).write, Write::Nothing);
    }

    #[test]
    fn three_unclear_answers_back_off_without_ever_claiming_a_sign_out() {
        let mut h = Health::default();
        let plan = Plan::Refresh(15);
        for _ in 0..2 {
            assert_eq!(decide(&mut h, Outcome::Pinged(Ping::Unclear), plan, false).write, Write::Nothing);
        }
        let s = decide(&mut h, Outcome::Pinged(Ping::Unclear), plan, false);
        assert_eq!(
            s.write,
            Write::Stamp {
                every: 15,
                action: ACTION_SOFT,
                login_state: None,
                probed: false
            }
        );
    }

    /// A tick spent watching requested nothing, so it claims nothing — but an
    /// `Alive` that lands on a tab whose window has just shrunk still clears a
    /// stale `needs_login`, which is what keeps a signed-back-in bank tab from
    /// staying 409-gated forever.
    #[test]
    fn watching_claims_nothing_but_a_live_ping_still_clears_needs_login() {
        let mut h = Health::default();
        let s = decide(&mut h, Outcome::Watching, Plan::Watch, false);
        assert_eq!(
            s.write,
            Write::Stamp {
                every: WATCH_EVERY_MINUTES,
                action: ACTION_WATCH,
                login_state: None,
                probed: false
            }
        );

        let s = decide(&mut h, Outcome::Pinged(Ping::Alive), Plan::Watch, true);
        assert_eq!(
            s.write,
            Write::Stamp {
                every: WATCH_EVERY_MINUTES,
                action: ACTION_WATCH,
                login_state: Some(db_tabs::LOGIN_OK),
                probed: true
            }
        );

        // And when the deadline comes back, watch mode releases on its own.
        let s = decide(&mut h, Outcome::Watching, Plan::Refresh(BLIND_MINUTES), false);
        assert_eq!(
            s.write,
            Write::Stamp {
                every: BLIND_MINUTES,
                action: ACTION_SOFT,
                login_state: None,
                probed: false
            }
        );
    }

    #[test]
    fn a_row_that_has_never_been_checked_is_due_now() {
        assert_eq!(due_at(None, 45, 120), 0);
        assert_eq!(due_at(Some(1_000), 15, 0), 1_000 + 900);
        assert_eq!(due_at(Some(1_000), 15, -60), 1_000 + 840);
    }

    #[test]
    fn jitter_stays_within_ten_percent_of_the_interval() {
        for every in [5, 15, 45, 360] {
            let span = (every * 60) / 10;
            for _ in 0..64 {
                let j = draw_jitter(every);
                assert!(j >= -span && j <= span, "jitter {j} outside ±{span}");
            }
        }
        assert_eq!(draw_jitter(0), 0);
    }

    /// The no-injection pin: nothing is interpolated into the ping, and the
    /// stall guard / redirect policy cannot be edited away silently.
    #[test]
    fn the_ping_is_a_fixed_same_origin_get_with_a_stall_guard() {
        for needle in [
            "credentials:'include'",
            "redirect:'follow'",
            "cache:'no-store'",
            "AbortSignal.timeout(10000)",
            "location.origin",
        ] {
            assert!(PING_JS.contains(needle), "PING_JS must contain {needle}");
        }
        assert!(!PING_JS.contains("{}"));
        assert!(!PING_JS.contains("{0}"));
        assert!(!PING_JS.contains("redirect:'manual'"));
        // Rule 1, asserted rather than trusted.
        assert!(!PING_JS.contains("reload"));
    }

    /// The column's migration default is `'reload'` — a legacy artifact of a
    /// design that was never built. Any unrecognised value must resolve to soft
    /// mode, so reload cannot be reached by accident.
    #[test]
    fn an_unrecognised_action_means_soft_never_reload() {
        assert!(!is_watch_mode("reload"));
        assert!(!is_watch_mode(""));
        assert!(!is_watch_mode("soft"));
        assert!(!is_watch_mode("Watch"));
        assert!(is_watch_mode("watch"));
    }

    #[test]
    fn the_host_line_survives_a_url_it_cannot_parse() {
        assert_eq!(host_of("https://bol.com/account"), "bol.com");
        assert_eq!(host_of("http://127.0.0.1:8824/"), "127.0.0.1:8824");
        assert_eq!(host_of("about:blank"), "about:blank");
        assert_eq!(host_of(""), "");
    }
}
