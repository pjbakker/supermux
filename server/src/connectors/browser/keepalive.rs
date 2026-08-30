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
//! # The four rules that carry the design
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
//! [`auth_deadline`] prefers httpOnly candidates for that reason, and only an
//! httpOnly deadline may ever put a tab into watch mode — watch mode is *zero*
//! pings, so earning it off a JS-readable CSRF/consent token silently switched
//! the whole feature off on a site that was fine. And a jar
//! that could not be READ is not an empty jar: an empty one plans the blind
//! 15-minute refresh, so folding a CDP error into `Vec::new()` released watch
//! mode and pinged the one class of site this feature promises not to ping (a
//! short idle timeout is a deliberate security control). A failed read carries
//! the row's own plan forward — see [`plan_after_read`].
//!
//! **4. Silent until it can no longer do its job — and then not silent.** No
//! per-tick chatter, no badge for a normal day. But a tab whose every check
//! fails is stamped and backed off exactly like a healthy one, so it needs to
//! be said out loud: after [`STALE_INTERVALS`] of its own intervals without a
//! successful check, [`is_stale`] fires **one** push (re-armed by the next
//! successful check), and the ⋯ row takes the attention tint instead of leaving
//! the bad news in the same grey as the healthy line.
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
/// Consecutive 60-second retries (ticks that write nothing) before the sweep
/// gives up on an answer and falls back to the plan's interval. Four leaves
/// every deliberate retry — a two-strike confirmation, an unclear streak —
/// room to finish, and still bounds a flapping site at four requests instead of
/// one a minute forever.
pub const QUIET_TICKS: u8 = 4;

/// Intervals without a successful check before supermux says so OUT LOUD. Three,
/// not one: a single missed tick is ordinary (the human held the wheel, the wake
/// budget deferred the tab, the box was busy). The ⋯ row flips to its stale line
/// on the same three, so the notification and the row never disagree.
pub const STALE_INTERVALS: i64 = 3;

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

/// A deadline read out of the jar, and **where it came from**. The provenance
/// is not decoration: it is the whole difference between "this site expires in
/// minutes, stop pinging it" and "some consent banner cookie is short".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Deadline {
    /// Seconds from now until it expires.
    pub secs: i64,
    /// Did it come off an httpOnly cookie — one only the server can set?
    pub http_only: bool,
}

/// The soonest deadline this origin's session appears to rely on, or `None`
/// when nothing in the jar carries one.
///
/// **httpOnly first, and only httpOnly when the jar holds ANY — session cookies
/// included.** A real auth cookie is httpOnly (measured: a test jar's `sid` is
/// invisible to `document.cookie` while its 5-minute `shortcsrf` is not), so
/// preferring it keeps a short CSRF/consent/challenge cookie from impersonating
/// the session clock.
///
/// The provenance vote deliberately runs over the whole jar, **before** the
/// session filter. Deciding it after — as this did — read the most common auth
/// shape on the web as "no httpOnly cookie here": `PHPSESSID`, `JSESSIONID`,
/// `connect.sid` and Rails' `_session` are httpOnly *session* cookies whose
/// lifetime lives on the server, so they carry no expiry to filter on, and a
/// 5-minute consent cookie was left speaking for the session on a perfectly
/// healthy site. Now such a jar honestly carries **no deadline at all**, which
/// plans the blind refresh — the answer for a server-side session.
pub fn auth_deadline(cookies: &[CookieLite], now: i64) -> Option<Deadline> {
    let has_http_only = cookies.iter().any(|c| c.http_only);
    cookies
        .iter()
        .filter(|c| !c.session && c.expires > now as f64)
        .filter(|c| !has_http_only || c.http_only)
        .map(|c| Deadline {
            secs: c.expires as i64 - now,
            http_only: c.http_only,
        })
        .min_by_key(|d| d.secs)
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
pub fn plan_for(deadline: Option<Deadline>) -> Plan {
    match deadline {
        None => Plan::Refresh(BLIND_MINUTES),
        // **ONLY an httpOnly deadline may stop the pings.** Watch mode is not a
        // gentler schedule, it is *no* schedule — zero requests, and a menu line
        // that says "this site signs out in minutes". Earning that claim off a
        // JS-readable cookie was a silent way to switch the feature off on a
        // healthy site: any short CSRF/consent/challenge token could demote the
        // tab, and if the page's own JS kept re-setting it (an SPA heartbeat, a
        // rotating CSRF) the demotion stuck, because a watching tab requests
        // nothing that could ever disagree. A visible cookie's deadline is still
        // worth *scheduling* on — it is just never evidence about the session.
        Some(d) if d.http_only && d.secs < WATCH_UNDER_SECS => Plan::Watch,
        Some(d) => Plan::Refresh((d.secs / 120).clamp(FLOOR_MINUTES, CEILING_MINUTES)),
    }
}

/// The plan for the next tick, given what the cookie read actually returned.
///
/// **`None` means the READ FAILED, and that is not the same fact as an empty
/// jar.** `auth_deadline(&[])` is `None` and `plan_for(None)` is the blind
/// 15-minute refresh, so folding a `cookies()` error into `Vec::new()` made a
/// transient CDP failure (a detached session, a timeout) do two things this
/// feature promises never to do:
///
///   · it **released watch mode** — the row's `keepalive_action` was rewritten
///     from `watch` to `soft`, and the next tick started pinging the one class
///     of site §2.4 says supermux will not ping: a bank tab whose 5-15 minute
///     idle timeout is a deliberate security control. A target that fails the
///     read repeatedly would be pinged every 15 minutes forever;
///   · it **reset a learned cadence** — a healthy tab that had settled on 6 h
///     dropped to 15 min, quadrupling its traffic, on nothing but an error.
///
/// So a failed read carries the row's own plan forward and changes nothing. The
/// clamp is only a guard on a garbage column value; the cadence itself is never
/// invented here.
pub fn plan_after_read(
    jar: Option<&[CookieLite]>,
    now: i64,
    current_action: &str,
    current_every: i64,
) -> Plan {
    match jar {
        Some(cookies) => plan_for(auth_deadline(cookies, now)),
        None if is_watch_mode(current_action) => Plan::Watch,
        None => Plan::Refresh(current_every.clamp(FLOOR_MINUTES, CEILING_MINUTES)),
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
    if status == 401 {
        return Ping::Suspicious;
    }
    // **403 IS NOT 401.** An automated same-origin GET of `/` carrying
    // `Sec-Fetch-Dest: empty` is exactly the shape a bot-detection edge
    // (a Cloudflare/Akamai managed challenge, an anti-CSRF filter) answers with
    // 403 while the human's session is perfectly valid. Reading that as a
    // sign-out 409s every bot on a tab that is signed in, and the documented
    // self-heal ("any Alive writes ok") can never arrive, because the very same
    // fetch keeps being blocked. So 403 has to be corroborated by the
    // login-shaped path; on its own it is the site's problem, not a claim.
    if status == 403 {
        return if looks_like_login_path(path) {
            Ping::Suspicious
        } else {
            Ping::Unclear
        };
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
    /// Is a Suspicious strike currently armed? Dropped after every write, and
    /// re-derived from the row's own `login_state` — see [`decide`].
    pub last_suspicious: bool,
    /// Consecutive [`Write::Nothing`] ticks. A row that writes nothing stays
    /// due, so this is the only thing standing between a flapping site and a
    /// 60-second ping forever.
    pub quiet: u8,
    /// The ±10 % offset drawn at the last stamp, in seconds.
    pub jitter: i64,
    /// Unix seconds before which this tab is not touched (the human-driving
    /// back-off).
    pub defer_until: i64,
    /// Unix seconds of the last tick that actually CHECKED this tab, seeded from
    /// the row's own `last_probe_at` the first time the sweep sees it.
    ///
    /// The stale clock runs off this rather than off the column because a tab
    /// whose every *wake* fails never gets a `last_probe_at` at all, and the row
    /// carries no "enabled at" to measure from. Nothing is persisted: a restart
    /// re-seeds from the column when it has one (so a tab that is still stuck is
    /// re-announced once) and from `now` when it does not (so the streak starts
    /// over). Both are honest; neither invents a gap that did not happen.
    pub last_check: i64,
    /// Has the "can't check" push already fired for this streak? One per streak
    /// per process, re-armed by the next successful check.
    pub stale_pushed: bool,
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
    let step = judge(health, outcome, plan, was_needs_login);
    if !matches!(step.write, Write::Nothing) {
        health.quiet = 0;
        return step;
    }
    // A `Write::Nothing` leaves `last_keepalive_at` alone, which leaves the row
    // DUE — that is the whole two-strike mechanism, and it is also the one way
    // this feature can turn into a 60-second ping loop. A site alternating
    // Suspicious and Unclear (a 401 flapping with a 429/5xx — i.e. one that is
    // already shedding load) resets one counter with each answer and reaches
    // neither back-off, so it would be fetched 1440 times a day: exactly the
    // traffic profile FLOOR_MINUTES exists to prevent. Cap the retries and fall
    // back to the plan's interval, claiming nothing about the sign-in.
    health.quiet = health.quiet.saturating_add(1);
    if health.quiet < QUIET_TICKS {
        return step;
    }
    health.quiet = 0;
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

/// [`decide`]'s state machine proper. Split out so the retry cap above wraps
/// every branch rather than being repeated in three of them.
fn judge(health: &mut Health, outcome: Outcome, plan: Plan, was_needs_login: bool) -> Step {
    match outcome {
        Outcome::Pinged(Ping::Suspicious) => {
            health.strikes = 0;
            // Two strikes to CLAIM a sign-out; one to re-confirm one the row
            // already carries. The arm is **dropped after every write** and
            // re-derived from the row's own `login_state`, so:
            //
            //   · while the row says `needs_login`, each Suspicious re-stamps
            //     at the 10-minute cadence instead of spinning at 60 s;
            //   · the moment a human clears the tab back to `ok` (the PATCH
            //     accepts `login_state`), the next single Suspicious has to
            //     earn its 409 again. Latching the arm made one ping silently
            //     revert the correction — and re-fire the push, and re-409
            //     every bot on the tab — with no second-strike grace at all.
            if health.last_suspicious || was_needs_login {
                health.last_suspicious = false;
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

/// Has this tab gone long enough without a successful check that the owner has
/// to be TOLD, rather than left to find it in a menu?
///
/// WHY this exists: everything else in this file is designed to fail quietly,
/// and that is right — but the quiet has one hole. A tab whose every ping fails
/// (a 404/5xx root, a cross-origin SSO bounce the fetch rejects, a wake that
/// keeps failing) is still stamped every tick and still backs off to its plan's
/// interval, so from the outside it is indistinguishable from a healthy one.
/// The promise this feature makes is "silent until it can no longer do its
/// job"; without this it was silent exactly then, and the bad news lived only
/// inside the ⋯ menu, in the same grey as the healthy line.
///
/// **Watch mode is never stale.** It pings nothing by design, so its probe stamp
/// stands still forever and an alarm there would be false every single time.
pub fn is_stale(last_check: i64, now: i64, every_min: i64, action: &str) -> bool {
    if is_watch_mode(action) {
        return false;
    }
    now - last_check > STALE_INTERVALS * every_min.max(1) * 60
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
        let h = {
            let e = health.entry(row.id.clone()).or_default();
            // Seed the stale clock once, from the row's own last successful
            // probe when it has one. A tab that has never been probed starts its
            // streak NOW, so a restart delays that notification rather than
            // firing one about a gap this process did not witness.
            if e.last_check == 0 {
                e.last_check = row.last_probe_at.unwrap_or(now);
            }
            *e
        };
        if now < h.defer_until {
            continue;
        }
        if now < due_at(row.last_keepalive_at, row.keepalive_every, h.jitter) {
            continue;
        }
        // `about:blank` and friends cannot be pinged (`location.origin` is
        // `'null'`), and there is nothing to learn from their jar. Stamp so the
        // row does not spin, and try again at the blind interval — but keep the
        // row's own MODE: a watch-mode tab that sits on `about:blank` for a
        // moment must not come back as a soft-pinged one and fire a ping at the
        // site that put it in watch mode.
        if !row.url.starts_with("http") {
            let action = if is_watch_mode(&row.keepalive_action) {
                ACTION_WATCH
            } else {
                ACTION_SOFT
            };
            stamp(state, &row.id, BLIND_MINUTES, action, None, false).await;
            // NOT a stale streak: there is genuinely nothing to check here, the
            // row says so in its own words ("Not a web page"), and a tab parked
            // on `about:blank` overnight must not turn into a notification.
            health.entry(row.id.clone()).or_default().last_check = now;
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
                // A wake failure teaches us nothing about the jar either, so it
                // carries the row's plan forward for the same reason a failed
                // cookie read does.
                let step = decide(
                    entry,
                    Outcome::Pinged(Ping::Unclear),
                    plan_after_read(None, now, &row.keepalive_action, row.keepalive_every),
                    row.login_state == db_tabs::LOGIN_NEEDED,
                );
                apply_tracked(state, row, step, health, now).await;
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
        // `None`, never an empty Vec: a failed read is not an empty jar, and
        // conflating the two is what un-latched watch mode. See
        // [`plan_after_read`].
        let jar: Option<Vec<CookieLite>> = match tab.page().cookies().await {
            Ok(cs) => Some(cs.iter().map(CookieLite::from_cdp).collect()),
            Err(e) => {
                tracing::debug!(tab = %row.id, error = %e, "keepalive: cookie read failed");
                None
            }
        };
        // A FRESH clock, not the sweep's: a slow ping (up to the 10 s stall
        // guard) plus the tabs ahead of this one can put seconds between `now`
        // and this read, and every one of them would be counted as extra
        // session lifetime — an interval set slightly past the real deadline.
        let read_at = chrono::Utc::now().timestamp();
        let plan = plan_after_read(
            jar.as_deref(),
            read_at,
            &row.keepalive_action,
            row.keepalive_every,
        );
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
        apply_tracked(state, row, step, health, now).await;
        // The tab is LEFT LIVE. Dehydrating it would replace this ~1 KB fetch
        // with a full page load of `meta.url` on the next tick — the opposite
        // of a quiet keep-alive.
    }
}

/// Perform the step, then run the stale clock. **Every path that writes goes
/// through here**, the wake failure included — a tab that can never be woken is
/// exactly the silent failure the notification exists for.
async fn apply_tracked(
    state: &AppState,
    row: &db_tabs::TabRow,
    step: Step,
    health: &mut HashMap<String, Health>,
    now: i64,
) {
    apply(state, row, step).await;
    let entry = health.entry(row.id.clone()).or_default();
    // `probed` is the only honest definition of "it worked": a tick that backed
    // off, watched, or failed to wake writes `probed: false` and must not reset
    // the streak. A CONFIRMED sign-out is a successful check — it probed, it
    // learned, and it has a notification of its own.
    if matches!(step.write, Write::Stamp { probed: true, .. }) {
        entry.last_check = now;
        entry.stale_pushed = false;
        return;
    }
    // One tab, one story: a `needs_login` tab already told the owner what to do,
    // and "can't check it" on top of "signed out" is noise about the same tab.
    if entry.stale_pushed || row.login_state == db_tabs::LOGIN_NEEDED {
        return;
    }
    if !is_stale(entry.last_check, now, row.keepalive_every, &row.keepalive_action) {
        return;
    }
    entry.stale_pushed = true;
    let host = host_of(&row.url);
    tell_the_owner(
        state,
        row,
        "browser.keepalive_stuck",
        format!("Can't check {host}"),
        "supermux hasn't been able to check this tab. Bots using it may already be signed out.",
    )
    .await;
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
    tell_the_owner(
        state,
        row,
        "browser.keepalive_signed_out",
        format!("Signed out of {host}"),
        "Bots using this tab are blocked until you sign in again.",
    )
    .await;
}

/// The feature's ONLY channel to the owner: an audit row, then one push.
///
/// `AgentWaiting` is reused deliberately: it is literally the "needs you"
/// category and it honours the owner's existing mute prefs, whereas a new
/// category means new prefs plumbing. `session: None` — this is not about one
/// bot. The audit row logs the HOST, never the url: a tab's url can carry a
/// magic-link or session token in its query string.
async fn tell_the_owner(
    state: &AppState,
    row: &db_tabs::TabRow,
    event: &str,
    title: String,
    body: &str,
) {
    let _ = crate::db::audit::log(
        &state.pool,
        "system",
        event,
        &format!("tab:{}", row.id),
        serde_json::json!({ "host": host_of(&row.url) }),
    )
    .await;
    push::send_push_for(
        state,
        NotifCategory::AgentWaiting,
        &PushPayload::simple(title, body.to_string(), "/browser", Tier::Attention),
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

/// Host for the copy and for every audit row — falling back to the raw url, so
/// it is never a panic and never an empty title. **Audit rows log this, never
/// the url**: a tab's url can carry a magic-link or session token in its query
/// string.
pub fn host_of(url: &str) -> String {
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

    /// A deadline, with its provenance — the field that decides whether it may
    /// stop the pings.
    fn d(secs: i64, http_only: bool) -> Deadline {
        Deadline { secs, http_only }
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
        assert_eq!(auth_deadline(&jar, now), Some(d(600, true)));
    }

    /// R2's regression, and the one that switched the feature OFF on a healthy
    /// site. The most common auth cookie on the web is an httpOnly **session**
    /// cookie (`PHPSESSID`, `JSESSIONID`, `connect.sid`, Rails `_session`): no
    /// expiry, lifetime on the server. Voting on the provenance *after* the
    /// session filter read such a jar as "nothing httpOnly here", let the
    /// 5-minute consent cookie beside it speak for the session, and
    /// `plan_for(Some(300))` then demoted the tab to `Watch` — zero pings, and a
    /// menu line telling the owner "this site signs out in minutes" about a site
    /// that does not. Worse, watching requests nothing, so if the page's own JS
    /// kept re-setting that cookie the demotion never lifted.
    #[test]
    fn an_httponly_session_cookie_is_the_auth_cookie_not_the_consent_banner() {
        let now = 1_788_114_850;
        let jar = [
            c(-1.0, true, true),                 // PHPSESSID — the real auth cookie
            c(now as f64 + 300.0, false, false), // cookieconsent — 5 minutes, visible
        ];
        // The server sets something httpOnly, so nothing visible carries a
        // deadline: "nothing known" is the honest answer for a server-side
        // session, and it plans the blind refresh.
        assert_eq!(auth_deadline(&jar, now), None);
        assert_eq!(plan_for(auth_deadline(&jar, now)), Plan::Refresh(BLIND_MINUTES));
    }

    /// And the belt to that brace: when the jar holds NO httpOnly cookie at all,
    /// a short visible one is still allowed to set the *schedule* — but never to
    /// stop it. Watch mode is not a chattier schedule, it is no schedule, so a
    /// visible deadline clamps to the floor instead.
    #[test]
    fn with_no_httponly_cookie_visible_ones_schedule_but_never_watch() {
        let now = 1_000_000;
        let jar = [c(now as f64 + 300.0, false, false), c(now as f64 + 1200.0, false, false)];
        assert_eq!(auth_deadline(&jar, now), Some(d(300, false)));
        assert_eq!(plan_for(auth_deadline(&jar, now)), Plan::Refresh(FLOOR_MINUTES));
        assert_eq!(plan_for(Some(d(60, false))), Plan::Refresh(FLOOR_MINUTES));
        // Only the httpOnly one earns the silence.
        assert_eq!(plan_for(Some(d(300, true))), Plan::Watch);
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
        assert_eq!(auth_deadline(&jar, now), Some(d(4000, true)));
        assert_eq!(auth_deadline(&[c(now as f64 - 10.0, false, true)], now), None);
    }

    #[test]
    fn the_plan_is_half_the_window_clamped_and_watches_under_ten_minutes() {
        assert_eq!(plan_for(None), Plan::Refresh(BLIND_MINUTES));
        assert_eq!(plan_for(Some(d(1800, true))), Plan::Refresh(15));
        assert_eq!(plan_for(Some(d(2880, true))), Plan::Refresh(24));
        assert_eq!(plan_for(Some(d(601, true))), Plan::Refresh(5)); // floor
        assert_eq!(plan_for(Some(d(599, true))), Plan::Watch);
        assert_eq!(plan_for(Some(d(14 * 86_400, true))), Plan::Refresh(CEILING_MINUTES));
    }

    /// The 18-minute sliding window from §F3, spelled out: reading the deadline
    /// BEFORE the ping would see ~half the window and schedule 9 minutes out;
    /// the tick after that would see 9 minutes left, trip the watch rule, stop
    /// refreshing — and sign the owner out by supermux's own hand. Post-ping the
    /// jar reads the full 18 minutes and the cadence is 9 with no watch trip.
    #[test]
    fn the_post_ping_read_is_what_keeps_a_sliding_site_refreshing() {
        assert_eq!(plan_for(Some(d(18 * 60, true))), Plan::Refresh(9)); // post-ping: full window
        // pre-ping: the self-inflicted sign-out
        assert_eq!(plan_for(Some(d(9 * 60, true))), Plan::Watch);
    }

    #[test]
    fn classify_reads_the_four_fields_and_resolves_every_ambiguity_to_unclear() {
        assert_eq!(classify("basic 200 0 /"), Ping::Alive);
        assert_eq!(classify("basic 200 0 /home"), Ping::Alive);
        assert_eq!(classify("basic 200 1 /home"), Ping::Alive);
        assert_eq!(classify("basic 200 0 /login"), Ping::Suspicious);
        assert_eq!(classify("basic 401 0 /"), Ping::Suspicious);
        assert_eq!(classify("basic 404 0 /"), Ping::Unclear);
        assert_eq!(classify("basic 500 0 /"), Ping::Unclear);
        assert_eq!(classify("error TypeError"), Ping::Unclear);
        assert_eq!(classify("error TimeoutError"), Ping::Unclear);
        assert_eq!(classify("skip 0 0 "), Ping::Unclear);
        assert_eq!(classify(""), Ping::Unclear);
    }

    /// A 403 on `/` is what a bot-detection edge answers an automated
    /// same-origin GET with while the human's session is fine. Reading it as a
    /// sign-out 409s every bot on a signed-in tab, and the self-heal can never
    /// arrive because the same fetch keeps being blocked — a permanent outage
    /// caused entirely by the feature that exists to prevent one. 401 stays a
    /// strong signal; 403 needs the login-shaped path to corroborate it.
    #[test]
    fn a_bare_403_is_the_edge_talking_not_a_sign_out() {
        assert_eq!(classify("basic 403 0 /"), Ping::Unclear);
        assert_eq!(classify("basic 403 0 /dashboard"), Ping::Unclear);
        assert_eq!(classify("basic 403 1 /home"), Ping::Unclear);
        // Corroborated: bounced to a sign-in wall AND refused.
        assert_eq!(classify("basic 403 1 /login"), Ping::Suspicious);
        assert_eq!(classify("basic 403 1 /auth/signin"), Ping::Suspicious);
        // And a WAF that answers 403 forever never claims anything: three
        // Unclears back off to the plan's interval with no `login_state` write.
        let mut h = Health::default();
        let plan = Plan::Refresh(15);
        for _ in 0..12 {
            let s = decide(&mut h, Outcome::Pinged(classify("basic 403 0 /")), plan, false);
            match s.write {
                Write::Nothing => {}
                Write::Stamp { login_state, .. } => assert_eq!(login_state, None),
            }
            assert!(!s.push_signed_out);
        }
    }

    /// F2's regression: `cookies()` returning `Err` was folded into an empty
    /// `Vec`, and an empty jar plans the blind 15-minute REFRESH — so one CDP
    /// error released watch mode and started pinging a bank tab.
    #[test]
    fn a_failed_cookie_read_carries_the_row_forward_and_never_releases_watch() {
        let now = 1_000_000;
        // Watch mode survives the error.
        assert_eq!(plan_after_read(None, now, ACTION_WATCH, 10), Plan::Watch);
        // A learned 6 h cadence is not reset to the blind 15 min.
        assert_eq!(plan_after_read(None, now, ACTION_SOFT, 360), Plan::Refresh(360));
        assert_eq!(plan_after_read(None, now, "reload", 45), Plan::Refresh(45));
        // A garbage column value is still clamped into the legal range.
        assert_eq!(plan_after_read(None, now, ACTION_SOFT, 0), Plan::Refresh(FLOOR_MINUTES));
        assert_eq!(
            plan_after_read(None, now, ACTION_SOFT, 99_999),
            Plan::Refresh(CEILING_MINUTES)
        );
        // A jar that was actually READ and is empty still means "nothing known".
        assert_eq!(plan_after_read(Some(&[]), now, ACTION_WATCH, 10), Plan::Refresh(BLIND_MINUTES));
        let jar = [c(now as f64 + 1800.0, false, true)];
        assert_eq!(plan_after_read(Some(&jar), now, ACTION_WATCH, 10), Plan::Refresh(15));
    }

    /// The two-strike arm has to RE-ARM. It used to latch: after a confirmed
    /// sign-out `last_suspicious` stayed true forever, so a human clearing the
    /// tab back to `ok` had their correction reverted by a single ping — with
    /// another "Signed out of X" push and another 409 on every bot.
    #[test]
    fn a_human_clearing_the_tab_buys_a_fresh_second_strike() {
        let mut h = Health::default();
        let plan = Plan::Refresh(45);
        assert_eq!(decide(&mut h, Outcome::Pinged(Ping::Suspicious), plan, false).write, Write::Nothing);
        let s = decide(&mut h, Outcome::Pinged(Ping::Suspicious), plan, false);
        assert!(s.push_signed_out, "the confirmed claim pushes once");

        // The row now says needs_login. While it does, each Suspicious simply
        // re-stamps at the 10-minute cadence — no push, and no 60-second spin.
        for _ in 0..3 {
            let s = decide(&mut h, Outcome::Pinged(Ping::Suspicious), plan, true);
            assert!(matches!(s.write, Write::Stamp { every: NEEDS_LOGIN_MINUTES, .. }));
            assert!(!s.push_signed_out);
        }

        // The human clears it back to `ok`. One ping must NOT undo that.
        let s = decide(&mut h, Outcome::Pinged(Ping::Suspicious), plan, false);
        assert_eq!(s.write, Write::Nothing, "a cleared tab earns its second strike again");
        assert!(!s.push_signed_out, "and never re-pushes off a single strike");
    }

    /// A site alternating Suspicious and Unclear resets one counter with each
    /// answer, so it reached neither back-off and was fetched every 60 s
    /// forever — the exact traffic profile FLOOR_MINUTES exists to prevent.
    #[test]
    fn a_flapping_site_is_bounded_and_falls_back_to_the_plan() {
        let mut h = Health::default();
        let plan = Plan::Refresh(45);
        let flap = [Ping::Suspicious, Ping::Unclear];
        let mut stamps = 0;
        for i in 0..40 {
            let s = decide(&mut h, Outcome::Pinged(flap[i % 2]), plan, false);
            if let Write::Stamp { every, login_state, probed, .. } = s.write {
                stamps += 1;
                assert_eq!(every, 45, "back off to the plan's interval");
                assert_eq!(login_state, None, "and claim nothing about the sign-in");
                assert!(!probed);
            }
            assert!(!s.push_signed_out);
        }
        // 40 ticks, capped at one retry burst each: the row is stamped (and so
        // stops being due) roughly every QUIET_TICKS minutes instead of never.
        assert_eq!(stamps, 40 / QUIET_TICKS as usize);
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

    /// R2's second regression: when the keep-alive stops working, something has
    /// to reach the owner. A tab whose every check fails is stamped every tick
    /// and backs off to its plan's interval, so nothing about it looks wrong
    /// from the outside — the one push fired only on the sign-out edge, and the
    /// bad news otherwise lived inside a menu in the same grey as a healthy
    /// line. Three of the tab's OWN intervals is the threshold, so a chatty tab
    /// is noticed in minutes and a 6-hourly one is not cried wolf over.
    #[test]
    fn a_streak_of_failed_checks_becomes_something_the_owner_can_see() {
        let now = 1_788_000_000;
        let every = 15;
        let cutoff = STALE_INTERVALS * every * 60;
        // One, two, even three missed intervals are ordinary.
        assert!(!is_stale(now - cutoff, now, every, ACTION_SOFT));
        assert!(is_stale(now - cutoff - 1, now, every, ACTION_SOFT));
        // The threshold is the tab's own cadence, not a fixed clock.
        assert!(!is_stale(now - cutoff - 1, now, 360, ACTION_SOFT));
        assert!(is_stale(now - 3 * 360 * 60 - 1, now, 360, ACTION_SOFT));
        // A garbage cadence still yields a finite threshold rather than a
        // division by nothing.
        assert!(is_stale(now - 181, now, 0, ACTION_SOFT));
        // WATCH MODE IS NEVER STALE. It pings nothing by design, so its probe
        // stamp stands still forever and every alarm here would be false.
        assert!(!is_stale(now - 30 * 86_400, now, 10, ACTION_WATCH));
    }

    /// The three ticks that must NOT reset the streak, in the machine's own
    /// vocabulary: `probed` is the only honest definition of "it worked".
    #[test]
    fn only_a_tick_that_actually_probed_re_arms_the_stale_clock() {
        let mut h = Health::default();
        let plan = Plan::Refresh(15);
        // Backed off after an unclear streak: stamped, learned nothing.
        for _ in 0..UNCLEAR_STRIKES {
            let s = decide(&mut h, Outcome::Pinged(Ping::Unclear), plan, false);
            if let Write::Stamp { probed, .. } = s.write {
                assert!(!probed, "an unclear back-off never claims a check");
            }
        }
        // Watching: requested nothing.
        assert!(matches!(
            decide(&mut h, Outcome::Watching, Plan::Watch, false).write,
            Write::Stamp { probed: false, .. }
        ));
        // A real answer — including a confirmed sign-out, which has its own
        // notification and is a successful check.
        assert!(matches!(
            decide(&mut h, Outcome::Pinged(Ping::Alive), plan, false).write,
            Write::Stamp { probed: true, .. }
        ));
        let mut h2 = Health::default();
        decide(&mut h2, Outcome::Pinged(Ping::Suspicious), plan, false);
        assert!(matches!(
            decide(&mut h2, Outcome::Pinged(Ping::Suspicious), plan, false).write,
            Write::Stamp { probed: true, .. }
        ));
    }

    #[test]
    fn the_host_line_survives_a_url_it_cannot_parse() {
        assert_eq!(host_of("https://bol.com/account"), "bol.com");
        assert_eq!(host_of("http://127.0.0.1:8824/"), "127.0.0.1:8824");
        assert_eq!(host_of("about:blank"), "about:blank");
        assert_eq!(host_of(""), "");
    }
}
