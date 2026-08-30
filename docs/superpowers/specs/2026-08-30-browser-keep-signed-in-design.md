# "Keep me signed in" — build spec

**Branch** `feat/browser-keep-logged-in` · worktree `/opt/projects/supermux-keepalive` · base `main 004ccbfe`
**Date** 2026-08-30 · **Status** decided, no options left open.

---

## OUTCOME

A per-tab toggle in the ⋯ page menu. When it is on, a 60-second server sweep does, per due tab, exactly this:

```
wake the tab if it is asleep  →  (unless a human holds the wheel)
  soft ping: the PAGE fetches its own origin root — never a reload, never a navigation
  read the cookie jar over CDP
  next tick = clamp(shortest auth-cookie lifetime / 2, 5 min, 6 h)
```

Nothing else. **No migration** (0039 already reserved the columns), **no new crate**, **one new CDP method** (`Network.getCookies`), **one new server module**, **one new pure web module**, **one optional field on the menu-row type**. It also makes the dead `login_state` / `last_probe_at` machinery real — the sweep is the first writer of either.

Three rules carry the whole design, and each one exists because the obvious alternative logs somebody out:

1. **Soft ping, always. `Page.reload` is not implemented at all.** A reload burns CSRF nonces, drops unsaved form state and can land on top of a bot mid-action. Measured: a page-context `fetch` slides a sliding cookie's expiry and leaves `Page.getNavigationHistory` at 1 entry.
2. **`needs_login` is an enforcement gate, not a label** (`connectors/browser/tools.rs:260-270`: a `needs_login` tab refuses *every* agent verb, reads included, with a 409). So the sign-out detector is deliberately conservative — a benign `/` → `/home` redirect must never trip it — and any claim it does make self-heals within 10 minutes.
3. **The shortest cookie in the jar is not the session clock.** Picking it naively both mis-times the schedule and (in design B's form) refuses to enable on perfectly good sites. Measured counter-example below.

---

## 0. Measured facts this spec rests on

All measured on the pinned binary — `~/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome`, `Google Chrome for Testing 149.0.7827.55` (`launch.rs:84` `DEFAULT_CHROME_REL`, `:88` `PINNED_CHROME_MAJOR = 149`) — launched as a throwaway instance on a temp profile against a local test server. **The owner's live browser was never touched.** Probes kept at `…/scratchpad/probe.py`, `probe2.py`, `probe3.py`.

| # | Claim | Measured result |
|---|---|---|
| M1 | `Network.getCookies` works on a flat-mode page session with **no `Network.enable`** | `[('shortcsrf', 1788115150.05, session=false, httpOnly=false), ('sid', 1788115450.05, false, true), ('sess', -1, true, false)]` |
| M2 | `Network.getCookies` with **no `urls` param** returns the page's own cookies | same jar back; **no tab URL needs to be passed**, so a stale `browser_tabs.url` row cannot mis-target the read |
| M3 | A foreign `urls` value returns nothing | `urls:["https://example.invalid/"]` → `0 cookies` |
| M4 | `document.cookie` is not a substitute | `"shortcsrf=z; sess=1"` — the httpOnly `sid` is invisible |
| M5 | A page-context `fetch` **slides** a sliding cookie | `sid` expiry `1788115450.055` → `1788115453.781` (+3.73 s = elapsed) |
| M6 | The ping does **not** navigate | `Page.getNavigationHistory` → `1` entry, `currentIndex 0`, after the ping |
| M7 | A benign same-origin `302 /redirhome → /home` under `redirect:'manual'` is **indistinguishable from a login bounce** | `opaqueredirect:0` |
| M8 | Under `redirect:'follow'` the same case is fully legible | `basic:200:/home` |
| M9 | A real sign-out bounce is equally legible | root `302 → /login` ⇒ `basic:200:/login`; root `401` ⇒ `basic:401` |
| M10 | `about:blank` cannot be pinged | `location.origin === 'null'`, ping → `error:TypeError` |
| M11 | **Session cookies SURVIVE a Chrome restart on the durable profile** — clean `Browser.close` *and* `SIGKILL` | jar after restart still holds `('sess', -1, session=true)`, and the server actually received `Cookie: sid=abc; sess=1` on the next request |
| M12 | The exact `PING_JS` below returns a parseable string | `'basic 200 0 /'` |
| M13 | `AbortSignal.timeout(10000)` bounds a hung ping | a 25 s endpoint settled at **10.0 s** with `'error TimeoutError'` |

**M11 corrects the shared-browser v1 spec §7.1a and both input designs**, which assert that session cookies die with the Chrome process. They do not, on this profile, on this binary. Consequence: keeping Chrome alive is *not* required to preserve session logins, so the design must not justify pinning Chrome on that basis, and the UI must not warn about it. (It still keeps the tab live — for the reason in §5, which is network footprint, not cookies.)

Repo facts, each read in this worktree:

* `server/migrations/0039_browser_tab_grants.sql:33-39` reserves six `keepalive_*` columns; `db/browser_tabs.rs:42-47` maps them; a repo-wide grep finds **no reader and no writer** — only the struct, its test fixture (`:433-438`), and the migration.
* `TabPatch` (`db/browser_tabs.rs:141-150`) and `update()` (`:153-208`) have no keepalive branch; `tab_json` (`connectors/browser/api.rs:92-111`) does not serialise them; `PatchBody` (`api.rs:203-212`) does not accept them.
* `probed_now` is set `true` nowhere; `api.rs:237` passes `false`. Live confirmation on :8824 — all three of the owner's tabs report `live:false`, `login_state:"unknown"`, `last_probe_at:null`, and one is parked on `https://login.bol.com/wsp/login`.
* `AgentContext::evaluate` (`context.rs:1097`) already sets `returnByValue:true` + `awaitPromise:true` and is **ungated** by design ("reading the DOM is never a control conflict"). `session_call` (`:943`) is private; there is no public accessor for the `CdpClient`.
* `Tab::mode()` (`tab.rs:138`) is sync and returns `DriveMode`; the lock subject is the tab id (`mod.rs:603`).
* `spawn_idle_reaper` (`mod.rs:1034-1065`) `return`s early when `idle_timeout.is_zero()` (`:1035-1038`) and is installed inside `self.background.call_once` **on the first Chrome start** (`mod.rs:814-821`). `idle_armed()` (`:506-513`) needs `scratch.is_empty() && tabs.is_empty()`, and `dehydrate_tab` re-arms `idle_since` (`:682`).
* `ensure_tab` (`mod.rs:568-629`) reopens a dehydrated tab **at `meta.url` in the DEFAULT context** — i.e. waking is a real page load. `api::wake_tab` (`api.rs:288`) is already `pub(super)`.
* `BrowserMenuItem` (`browser-menu.tsx:36-49`) has no second-line field; `hint` is rendered **only as `title=`** (`:180`), invisible on a phone; rows are single-line `truncate` in a fixed `MENU_WIDTH = 232` popup (`:65`).
* `pageRows()` `workspace.tsx:447-477`, `runMenu()` `:480-548`, tab-menu precedent `label: t.pinned ? 'Unpin' : 'Pin'` (`:435`). Route wiring `routes/browser.tsx:95` `onPin={(id, pinned) => void actions.setPinned(id, pinned)}`.
* `useBrowserTabs` polls every 30 s (`use-browser-tabs.ts:103-104`); `patchM` (`:206-211`) invalidates on success and toasts on error via `fail(verb)`.
* `tab-grant-sheet.tsx:155-177` is the Pin settings-row primitive (`min-h-11`, label + sub-label + icon) inside a `ResponsiveSheet`. There is no `switch.tsx` in `web/src/components/ui/`.
* `rand = "0.8"` is already a dependency (`server/Cargo.toml:76`). `db::audit::log(pool, actor, action, target, detail)` (`db/audit.rs:19`). `push::send_push_for(state, cat, payload, session)` (`push.rs:517`), `notify::PushPayload::simple(title, body, url, tier)` (`notify.rs:338`), `NotifCategory::AgentWaiting` (`push.rs:426`), `Tier::Attention` (`notify.rs:163`).

---

## 1. Adversarial findings against the two input designs

These are the reasons the mechanics below differ from both.

**F1 — Design B's `opaqueredirect ⇒ Suspicious` breaks every bot on a healthy tab.** Under `redirect:'manual'` a benign signed-in `/` → `/home` returns `opaqueredirect:0` (M7), byte-identical to a login bounce. Design B strikes that twice and writes `login_state='needs_login'`, which `tools.rs:260-270` turns into a 409 on *every* agent verb for that tab. A site that redirects its root — most SaaS dashboards — would have its bots hard-blocked forever, with a takeover ask raised in chat each time. **Fix: `redirect:'follow'` (M8/M9), classify on the final pathname, and never claim a sign-out from a redirect that did not land on a login-shaped path.**

**F2 — Design B's `interval_from` refuses to enable on healthy sites, and lies about why.** It takes the min over *all* non-session cookies and calls anything under 10 min `TooFast` → `400 "this site signs you out after about 8 minutes"`. My measured jar (M1) is exactly this shape: `shortcsrf` 300 s alongside the real httpOnly `sid` at 600 s. On any site with a short CSRF/consent/challenge cookie beside a long auth cookie, the toggle bounces with a false claim. **Fix: prefer httpOnly candidates when any exist (M4 shows the real auth cookie is the httpOnly one), and never block the enable on a cookie read.**

**F3 — Both designs mis-time the refuse/watch decision by reading the deadline before the ping.** With `every = ttl/2`, at ping time a sliding site's remaining ttl is ~half its window. An 18-minute sliding window gives `every = 9 min`, so the next tick sees 9 min remaining, trips "under 10 minutes", and stops refreshing — **a self-inflicted sign-out.** *Fix: the schedule and the watch decision are computed from the cookie read taken **after** the ping, which on a sliding site is the full window.*

**F4 — Design A's "dehydrate the tab again after each ping" makes the ping heavier and more detectable, not lighter.** `ensure_tab` reopens a dehydrated tab by loading `meta.url` (`mod.rs:600-617`) — a full page load with all its subresources. Cold-cycling every 15 minutes therefore replaces one ~1 KB `fetch` with a whole page load, which is the opposite of a low-footprint keep-alive. (Design A's *stated* reason for the symmetry — that a dropped Chrome kills session logins — is also false: M11.) **Fix: keep an enabled tab live; cap enabled tabs at 4 and say so in the UI.**

**F5 — Design B's synchronous cookie read inside `PATCH` can hang the toggle for seconds.** Its enable path calls `ensure_tab` → cold Chrome launch (~2-5 s on this box) inside the HTTP handler, on a phone, before the row is written. **Fix: enable is a pure DB write; the first tick lands within 60 s and does all the learning.**

**F6 — Design A's in-memory `keepalive_status` map plus three extra JSON fields (`keepalive_verdict` / `_deadline` / `_reason`) is state the UI does not need.** Everything the owner reads is derivable from four durable columns. Cut. Likewise cut: `Network.enable` / `responseReceivedExtraInfo`, the sliding-vs-absolute verdict, the push at `deadline − 30 min`, `keepalive_url`, `keepalive_script`, and any interval picker.

**F7 — "Never refresh while a bot is mid-action" is the wrong guard for a soft ping, and both designs half-state it.** `DriveMode::AgentDriving` is simply "no human holds the wheel"; it is not "a bot is mid-call", so gating on it does not do what design A claims. It does not need to: a `fetch` touches no DOM, steals no focus and does not navigate (M6). The guard that *is* load-bearing is `HumanDriving` — `evaluate()` is ungated (`context.rs:1095-1097`), so without an explicit check the sweep would fire while the owner is typing his password on his phone.

---

## 2. Mechanics

### 2.1 The refresh — soft only

New `pub const` in `server/src/connectors/browser/keepalive.rs`. **Nothing is interpolated into it**, so there is no injection surface, and the origin is computed *inside the page*, so the request is same-origin by construction and no allowlist check is needed:

```rust
/// WHY a fetch and not `Page.reload`: a reload burns one-time CSRF nonces,
/// drops unsaved form state, and can land on top of a bot mid-action. This is a
/// normal same-origin GET issued by the real page, so the network stack applies
/// any `Set-Cookie` to the jar (measured: a `Max-Age=600` cookie's expiry moved
/// by exactly the elapsed time), it carries the page's genuine TLS/UA-CH/
/// Referer profile, and it never touches the DOM (measured: the navigation
/// history stays at one entry).
///
/// `redirect:'follow'` and NOT `'manual'`: manual collapses a benign
/// `/ -> /home` and a real login bounce into the same `opaqueredirect:0`, and
/// acting on that ambiguity 409s every bot on a healthy tab.
///
/// `AbortSignal.timeout(10000)` is the stall guard: `evaluate` awaits the
/// promise under the CDP client's 30 s deadline, so an unbounded fetch would
/// hold the sweep. Measured: a 25 s endpoint settles at 10.0 s.
const PING_JS: &str = "(location.origin.indexOf('http')===0?\
fetch(location.origin+'/',{credentials:'include',cache:'no-store',redirect:'follow',\
signal:AbortSignal.timeout(10000)})\
.then(function(r){return r.type+' '+r.status+' '+(r.redirected?1:0)+' '+(r.url?new URL(r.url).pathname:'')})\
.catch(function(e){return 'error '+(e&&e.name)}):Promise.resolve('skip 0 0 '))";
```

Issued through the existing `tab.page().evaluate(PING_JS)`. Result shape, all measured: `"basic 200 0 /"`, `"basic 401 0 /"`, `"basic 200 0 /login"`, `"error TypeError"`, `"error TimeoutError"`, `"skip 0 0 "`.

**`Page.reload` is not implemented in this feature, in any mode, behind any flag.** `keepalive_action` never takes the value `reload`.

### 2.2 The cookie read

One new public method on `AgentContext`, beside `evaluate`:

```rust
/// Cookies the browser would send to THIS page and its subframes, straight
/// from the jar — httpOnly auth cookies included, which `document.cookie` can
/// never see (measured).
///
/// No `urls` argument on purpose: CDP defaults to the page's own frame URLs, so
/// a `browser_tabs.url` row that has drifted cannot mis-target the read.
/// Needs NO `Network.enable` — measured on Chrome 149, the flat session answers
/// with the Network domain disabled. Read-only, and ungated for exactly the
/// reason `evaluate` is.
pub async fn cookies(&self) -> Result<Vec<Value>> {
    let out = self.session_call("Network.getCookies", json!({})).await?;
    Ok(out.get("cookies").and_then(Value::as_array).cloned().unwrap_or_default())
}
```

### 2.3 The tick, in full

```
sweep(state, health):                                   # every 60 s
  rows = db_tabs::list_keepalive(pool)                  # WHERE keepalive_enabled = 1
  if rows.is_empty(): return                            # state.browser is never touched — lazy start intact
  woken = 0
  for row in rows (ordered by id):
    if now < due_at(row.last_keepalive_at, row.keepalive_every, health.jitter(row.id)): continue
    if !row.url.starts_with("http"): stamp(row, every=BLIND); continue     # about:blank cannot be pinged (M10)
    if !live_tabs.contains(row.id):
      if woken >= MAX_WAKES_PER_TICK: continue          # stagger a cold boot
      woken += 1
    tab = api::wake_tab(state, row)?                    # TooManyTabs / launch failure => Unclear, never evict
    if tab.mode() == DriveMode::HumanDriving:
      health.defer(row.id, now + 120); continue         # no ping, no stamp, no claim
    outcome = if row.keepalive_action == "watch" { Unclear::Watching } else { classify(tab.evaluate(PING_JS)) }
    ttl     = auth_deadline(tab.cookies(), now)         # AFTER the ping — F3
    plan    = plan_for(ttl)
    apply(outcome, plan)                                # §2.5
```

The tab is **left live**. It is not dehydrated (F4).

### 2.4 The timing rule — concrete numbers

```rust
pub const TICK:                Duration = Duration::from_secs(60);
pub const FLOOR_MINUTES:       i64 = 5;    // below this we out-request every human
pub const BLIND_MINUTES:       i64 = 15;   // nothing known
pub const CEILING_MINUTES:     i64 = 360;  // 6 h
pub const WATCH_UNDER_SECS:    i64 = 600;  // 10 min — a deliberate idle control
pub const WATCH_EVERY_MINUTES: i64 = 10;
pub const NEEDS_LOGIN_MINUTES: i64 = 10;
pub const MAX_ENABLED_TABS:    usize = 4;
pub const MAX_WAKES_PER_TICK:  usize = 2;
pub const UNCLEAR_STRIKES:     u8 = 3;     // back off after this many non-answers
```

**Which cookie is the clock:**

```rust
/// Seconds until the soonest deadline this origin's session appears to rely on,
/// or `None` when nothing in the jar carries one.
///
/// httpOnly FIRST, and only httpOnly when any exists: a real auth cookie is
/// httpOnly (measured — the test jar's `sid` is invisible to `document.cookie`
/// while the 5-minute `shortcsrf` is not), so preferring it keeps a short
/// CSRF/consent/challenge cookie from impersonating the session clock. Falling
/// back to all non-session cookies when nothing is httpOnly is wrong only in
/// the safe direction: a too-short deadline just means a chattier schedule,
/// clamped at the 5-minute floor, while a too-long one misses the expiry.
pub fn auth_deadline(cookies: &[CookieLite], now: i64) -> Option<i64> {
    let live: Vec<&CookieLite> =
        cookies.iter().filter(|c| !c.session && c.expires > now as f64).collect();
    let has_http_only = live.iter().any(|c| c.http_only);
    live.iter()
        .filter(|c| !has_http_only || c.http_only)
        .map(|c| c.expires as i64 - now)
        .min()
}
```

**The plan:**

```rust
pub enum Plan { Refresh(i64), Watch }   // minutes

pub fn plan_for(ttl_secs: Option<i64>) -> Plan {
    match ttl_secs {
        None                                => Plan::Refresh(BLIND_MINUTES),
        Some(t) if t < WATCH_UNDER_SECS     => Plan::Watch,
        Some(t) => Plan::Refresh((t / 120).clamp(FLOOR_MINUTES, CEILING_MINUTES)),
    }
}
```

Why these numbers:

* **`ttl / 2`** — ASP.NET Core's `SlidingExpiration` handler re-issues the cookie on any request **past the halfway point** of the window, so a halfway ping is literally what such a server waits for. It also survives one missed tick before expiry and self-tunes across four orders of magnitude with no per-site configuration.
* **Floor 5 min** — below that the tab requests its own origin more often than any human uses a site: the cheapest bot-detection signal there is, and the strongest rate-limit exposure.
* **Ceiling 6 h** — a 14-day cookie does not need hourly attention; 4 requests/day is the whole drift budget.
* **Blind 15 min** — the unknown case is almost always a server-side session, and those defaults cluster at ASP.NET session state 20 min and PHP `session.gc_maxlifetime` 1440 s (24 min). 15 clears both with a missed tick of margin, and costs ~48 cheap GETs overnight — the traffic of one human tab left open.
* **Watch under 10 min** — a 5-15 minute idle timeout is a deliberate security control (PCI DSS 4.0 §8.2.8 requires re-auth after 15 minutes idle on cardholder-data systems). Defeating it on a bank tab is the least defensible thing this feature could do, so it is the one case where supermux says no. It **stops pinging** and keeps only reading the jar — zero network traffic, zero detection surface.
* **The watch decision is never latched.** It is recomputed from the post-ping jar on every tick, so an ephemeral 5-minute cookie that briefly shortened the deadline stops mattering the moment it expires and the minimum jumps back to the real auth cookie. This is also what makes an absolute-expiry site degrade correctly: its window shrinks, the cadence shrinks with it, and inside the last 10 minutes supermux stops pinging and just watches — then the cookie expires, the jar has no candidate left, `plan_for(None)` resumes pinging at 15 min, the ping bounces to a login path, and the tab is honestly flipped to signed out.

**Jitter.** `due_at` adds a per-tab jitter of ±10 % of `keepalive_every`, drawn once per stamp with `rand` and held in the in-memory health map:

```rust
pub fn due_at(last: Option<i64>, every_min: i64, jitter_secs: i64) -> i64 {
    match last { None => 0, Some(t) => t + every_min * 60 + jitter_secs }
}
```

`last_keepalive_at = NULL` ⇒ `due_at == 0` ⇒ **due now**, which is how enabling schedules its first tick within 60 s with no extra state. The persisted `keepalive_every` stays the clean number the UI renders; jitter never reaches the DB.

### 2.5 Sign-out detection, and what it costs to be wrong

```rust
pub enum Ping { Alive, Suspicious, Unclear }

pub fn classify(raw: &str) -> Ping {
    let mut it = raw.splitn(4, ' ');
    match it.next().unwrap_or("") {
        "error" | "skip" | "" => return Ping::Unclear,
        _ => {}
    }
    let status: u16 = it.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    let _redirected = it.next();               // redundant with the path; kept so a log line reads on its own
    let path = it.next().unwrap_or("");
    if status == 401 || status == 403 { return Ping::Suspicious }
    if (200..400).contains(&status) {
        if looks_like_login_path(path) { return Ping::Suspicious }
        return Ping::Alive
    }
    Ping::Unclear                              // 404, 5xx, 0 — the site's problem, never a sign-out claim
}

/// EXACT path-SEGMENT match, never a substring: `/logistics` contains "log" and
/// `/assorted` contains "sso", and a substring rule would flip both tabs to
/// `needs_login`, which 409s every bot on them.
pub fn looks_like_login_path(path: &str) -> bool {
    const WORDS: [&str; 11] = ["login", "log-in", "log_in", "signin", "sign-in", "sign_in",
                               "sso", "auth", "authorize", "oauth", "session"];
    path.split('/').any(|seg| WORDS.iter().any(|w| seg.eq_ignore_ascii_case(w)))
}
```

Per-tab in-memory health, owned as a local by the single sweeper task — no `Mutex`, no `AppState` field, nothing to serialise:

```rust
struct Health { strikes: u8, last_suspicious: bool, jitter: i64, defer_until: i64 }
```

Applying an outcome:

| Outcome | DB write | Next tick |
|---|---|---|
| `Alive` | `login_state='ok'`, `probed_now`, `last_keepalive_at=now`, `keepalive_every` and `keepalive_action` from the plan; strikes cleared | the plan's interval |
| `Suspicious`, previous outcome **not** Suspicious | **nothing** (deliberately no stamp) | **60 s** — the row stays due, which is the entire confirmation mechanism |
| `Suspicious` twice in a row | `login_state='needs_login'`, `probed_now`, `last_keepalive_at=now`, `keepalive_every=10`; **one push** iff the row was not already `needs_login`; audit `browser.keepalive_signed_out` | 10 min |
| `Unclear`, strikes < 3 | nothing | 60 s |
| `Unclear`, strikes ≥ 3 | `last_keepalive_at=now` only — **never a `login_state` write** | the plan's interval |
| `Plan::Watch` | `keepalive_action='watch'`, `keepalive_every=10`, `last_keepalive_at=now`; **no `login_state`, no `probed_now`** — we did not check the sign-in, so we claim nothing about it | 10 min |
| Human holds the wheel | nothing | +2 min |

**Why two consecutive Suspicious ticks and not one:** the cost of a false positive is that `tools.rs` 409s every agent verb on the tab and raises a takeover ask in chat. The cost of the second tick is 60 seconds of extra patience.

**Why `needs_login` is safe to write at all:** a successful ping *always* writes `login_state='ok'`, and the cadence while `needs_login` is 10 minutes, so a false positive un-does itself within 10 minutes of the truth and a real sign-in is noticed just as fast. Missing a sign-out is cheap by comparison (the UI keeps saying "checked N min ago"; a bot that hits the tab still meets the wall and raises its own takeover ask), so every ambiguous case resolves to `Unclear`.

**The push** fires only on the `ok|unknown → needs_login` transition:

```rust
push::send_push_for(state, NotifCategory::AgentWaiting,
    &PushPayload::simple(
        format!("Signed out of {host}"),
        "Bots using this tab are blocked until you sign in again.".to_string(),
        "/browser", Tier::Attention),
    None).await;
```

`AgentWaiting` is reused deliberately: it is literally the "needs you" category and it honours the owner's existing mute prefs, whereas a new category means new prefs plumbing in `db/push.rs`. `session: None` — this is not about one bot. The deep link is `/browser`; `routes/browser.tsx` has no `?tab=` param today and this spec does not add one.

### 2.6 Pause and lock rules

1. **`tab.mode() == DriveMode::HumanDriving` ⇒ skip the whole tick** (no ping, no cookie read, no stamp), retry in 2 minutes. `AgentContext::evaluate` is ungated by design (`context.rs:1095-1097`), so this explicit check is the only thing between a background ping and the owner's thumbs on a sign-in form.
2. **`AgentDriving` is not a pause.** A soft ping touches no DOM, steals no focus and does not navigate (M6), so it is safe beside a bot mid-call. Waking a dehydrated tab is `ensure_tab`, which is idempotent. `Runtime.evaluate` racing a navigation fails with an exception, which is `Unclear` — harmless.
3. **Never evict.** `TooManyTabs` (`max_tabs`, default 16) is `Unclear`: skip and retry, never close somebody else's tab.
4. **Never spawn Chrome speculatively.** `sweep` returns before touching `state.browser` when no row has the toggle on.
5. **At most `MAX_WAKES_PER_TICK = 2` cold wakes per tick**, so a boot with four enabled tabs staggers over two minutes instead of stampeding one Chrome start.

---

## 3. Data model — no migration

`server/migrations/0039_browser_tab_grants.sql` is used exactly as reserved. **No new migration file.** (sqlx checksums migrations; a schema change here is the one irreversible act in this repo.)

| Column | Written by | Meaning in this feature |
|---|---|---|
| `keepalive_enabled` | the human's `PATCH` only | 0 / 1 |
| `keepalive_every` | the sweep | minutes; always in `[5, 360]`, or `10` in watch / needs-login mode. The number the UI renders |
| `keepalive_action` | the enable `PATCH` (`'soft'`) and the sweep (`'soft'` \| `'watch'`) | **the mode, not a verb.** `'soft'` = fetch-ping; `'watch'` = read the jar only. The column's migration default `'reload'` is a legacy artifact of a design that was never built: the sweep treats **any** unrecognised value as `'soft'` and rewrites it, because reload is not implemented anywhere in this feature and so cannot be reached by accident |
| `last_keepalive_at` | the sweep | unix seconds of the last *completed* tick. `NULL` = never ⇒ due now |
| `keepalive_url` | **nobody** | unused. The ping's origin is computed inside the page, so no URL is ever stored, parsed or trusted server-side |
| `keepalive_script` | **nobody** | unused, stays `NULL`. A per-tab JS payload is what would turn a keep-alive into an exfiltration primitive |
| `login_state` | the sweep (first writer besides the human) | `ok` \| `needs_login` \| `unknown` |
| `last_probe_at` | the sweep via `probed_now` (first writer at all) | freshness of the sign-in evidence |

`server/src/db/browser_tabs.rs` — `TabPatch` gains four fields, `update()` four more `if let` / `if` blocks in the existing one-statement-per-field style:

```rust
pub keepalive_enabled: Option<bool>,
pub keepalive_every: Option<i64>,        // minutes; server-derived, never from a request body
pub keepalive_action: Option<String>,    // "soft" | "watch"
pub keepalive_stamp_now: bool,           // last_keepalive_at = now
pub keepalive_clear_stamp: bool,         // last_keepalive_at = NULL  (the enable path)
```

One new query, the sweep's only read:

```rust
pub async fn list_keepalive(pool: &SqlitePool) -> sqlx::Result<Vec<TabRow>>
    // SELECT * FROM browser_tabs WHERE keepalive_enabled = 1 ORDER BY id
```

---

## 4. API

`server/src/connectors/browser/api.rs`.

**`PatchBody` gains exactly one field:** `pub keepalive_enabled: Option<bool>`. The interval and the mode are never accepted from a body — there is no interval picker, by design.

`patch_handler`, on `Some(true)`:

1. `row.url` must start with `http://` or `https://` → else `400 "only web pages can be kept signed in"`.
2. `list_keepalive()`, excluding this tab, must be `< MAX_ENABLED_TABS` → else `400 "supermux keeps at most 4 tabs signed in — each one holds a page open in the browser"`.
3. Write `keepalive_enabled=1`, `keepalive_action='soft'`, `keepalive_every=BLIND_MINUTES`, `keepalive_clear_stamp=true` (⇒ due within 60 s).
4. `db::audit::log(&pool, "user", "browser.keepalive_on", &format!("tab:{id}"), json!({"host": host}))`.

On `Some(false)`: `keepalive_enabled=0`, audit `browser.keepalive_off`. `keepalive_every` / `keepalive_action` are left as they are — harmless, and it keeps the last learned cadence visible if the owner turns it back on.

**No Chrome is started inside the handler** (F5). The response is a plain DB round-trip.

`tab_json` gains four flat fields:

```json
"keepalive_enabled": true, "keepalive_every": 45,
"keepalive_action": "soft", "last_keepalive_at": 1788115450
```

`web/src/lib/api/browser.ts`: `BrowserTab` mirrors those four; `TabPatch` gains `keepalive_enabled?: boolean`. Nothing else changes — the 30-second poll already refreshes them.

---

## 5. Interface

### 5.1 The ⋯ page menu row

`browser-menu.tsx` gains **one optional field**, and nothing else:

```ts
/** A second, muted line under the label — the evidence. NOT a tooltip:
 *  `hint` renders only as `title=`, and a phone has no hover, so today a menu
 *  row physically cannot show state. */
detail?: string
```

Rendered inside the existing `<button role="menuitem">`: the label span becomes a `flex-col` block (`text-[13.5px] truncate` + `text-[11.5px] text-muted-foreground line-clamp-2`), and the row's `min-h-11` becomes `min-h-14` **only when `detail` is present**, so every existing row renders byte-identically. `MENU_WIDTH` stays 232 px; the existing flip-and-clamp already handles a taller menu.

The row, in `pageRows()` (`workspace.tsx:447`), directly above `Sharing & settings…`:

```tsx
{ id: 'keepalive', icon: active?.keepalive_enabled ? ShieldCheck : Shield,
  separated: true, ...keepAliveRow(active, Date.now() / 1000) }
```

`keepAliveRow()` is a pure function in the new `web/src/lib/browser/keep-signed-in.ts`, returning `{ label, detail, disabled, hint }`. **Label is the verb**, matching the Pin/Unpin precedent at `workspace.tsx:435`.

| Tab state | Label | Detail |
|---|---|---|
| no active tab, or url not `http(s)` | *(disabled)* **Keep me signed in** | *hint:* `Only web pages can be kept signed in` |
| off | **Keep me signed in** | `Refresh bol.com in the background so bots stay signed in.` |
| on, `last_keepalive_at === null` | **Stop keeping signed in** | `Starting — first check within a minute.` |
| on, `action === 'soft'`, healthy | **Stop keeping signed in** | `Every 45 min · checked 12 min ago.` |
| on, `action === 'watch'` | **Stop keeping signed in** | `Watching only — this site expires sessions in minutes; refreshing would fight that.` |
| on, `login_state === 'needs_login'` | **Stop keeping signed in** | `Signed out — take the wheel and sign in again.` |
| on, `now − last_keepalive_at > 3 × every × 60` | **Stop keeping signed in** | `Hasn't been able to check since 2 h ago.` |

Interval wording is coarse, via one helper: `every < 120 ⇒ "45 min"`, else `"6 h"` (`Math.round(every / 60)`). Ages reuse the existing `ago()` (`browser.ts:313`). **No live countdown** — a backgrounded PWA must not re-render a clock nobody is watching; the line is recomputed when the menu opens.

`runMenu('keepalive')` calls a new `onKeepAlive?.(active.id, !active.keepalive_enabled)` prop, wired in `routes/browser.tsx` beside `onPin`:

```tsx
onKeepAlive={(id, on) => void actions.patch(id, { keepalive_enabled: on }, 'keepalive')}
```

The menu closes on select, so success needs a word: on a resolved enable, toast `Keeping bol.com signed in — first check within a minute.`; on disable, toast `Stopped keeping bol.com signed in.` Failures already toast through `patchM`'s `fail(verb)` (`use-browser-tabs.ts:210`), which is how the two 400s in §4 reach the owner. `TabVerb` gains `'keepalive'` with the message `Could not change keep-signed-in for this tab`.

### 5.2 The sheet row (the depth surface)

One more row in `tab-grant-sheet.tsx`, directly under the Pin row and cloning its exact primitive (`:155-177`: `min-h-11` bordered button, label + sub-label + trailing icon) inside the existing `ResponsiveSheet` — a bottom sheet at 390 px. State-first phrasing, because there is room here for the cost:

* on: **Keeping you signed in** — `Refreshes this tab quietly so bots stay signed in. Holds the page open in the browser — up to 4 tabs.`
* watch: **Watching this tab** — `This site expires sessions in minutes. supermux won't hammer it; it will tell you when you're signed out.`
* off: **Not kept signed in** — `Bots lose access when the site signs this tab out.`

`tabState()` (`browser.ts:271`) is **not** touched: it feeds five components and its wording is pinned by existing tests.

### 5.3 390 px

The ⋯ menu is a fixed 232 px popup with flip-and-clamp (not a bottom sheet) — verified at `browser-menu.tsx:65,150-200`. The row is a full-width 56 px tap target; the detail line wraps to at most two lines (`line-clamp-2`) and is written to fit: **every `detail` string is ≤ 88 characters**, asserted in the unit test. The sheet row is the same `min-h-11` primitive already shipping at 390 px.

**Not built:** no interval picker, no advanced section, no badge, no banner, no new dot, no countdown, no post-takeover "stay signed in?" toast. The feature is offered once in the menu and is then silent until it can no longer do its job.

---

## 6. Where the loop lives

`keepalive::spawn(state.clone())` in `server/src/main.rs`, next to `workflows::spawn(state.clone())` (`main.rs:166`), mirroring its shape:

```rust
pub fn spawn(state: AppState) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(TICK);
        tick.set_missed_tick_behavior(MissedTickBehavior::Skip);  // Burst would fire every missed tick at once
        let mut health: HashMap<String, Health> = HashMap::new();
        loop { tick.tick().await; sweep(&state, &mut health).await; }
    });
}
```

**Not the idle reaper**, which the v1 spec §7.2 suggested, for two verified reasons: `spawn_idle_reaper` is installed inside `self.background.call_once` on the **first Chrome start** (`mod.rs:814-821`), so on a server that has not launched Chrome since boot it would never exist — which is exactly the overnight case this feature is for; and it `return`s early when `idle_timeout.is_zero()` (`mod.rs:1035-1038`), so `SUPERMUX_BROWSER_IDLE_MINUTES=0` would silently disable keep-alive.

**This sweep is also the only thing in the codebase that rehydrates a tab at boot.** Nothing in `main.rs:160-205` restores one today (the live server's three tabs are all `live:false`), so an enabled tab coming back up after a redeploy is a real behaviour change, and it is the one that makes "overnight" true.

**Memory, stated honestly:** an enabled tab is kept live, and a live tab disarms the idle reaper (`mod.rs:506-513`), so Chrome stays up (~844 MB idle) while any tab has the toggle on. That is the reason for `MAX_ENABLED_TABS = 4` and for the sheet's copy. It is *not* justified by session cookies (M11 disproves that); it is justified by footprint: waking a dehydrated tab is a full page load of `meta.url` (`mod.rs:600-617`), so cold-cycling every 15 minutes would replace one ~1 KB `fetch` with an entire page load plus subresources — the opposite of a quiet keep-alive.

---

## 7. Tests

**`server/src/connectors/browser/keepalive.rs`, `#[cfg(test)]` — pure, no Chrome:**

1. `auth_deadline` picks the httpOnly cookie over a shorter non-httpOnly one: the measured jar `[shortcsrf +300 s non-httpOnly, sid +600 s httpOnly, sess expires=-1]` ⇒ `Some(600)`. *(This is F2's regression test.)*
2. `auth_deadline` falls back to all non-session cookies when none is httpOnly: `[+300, +1200]` ⇒ `Some(300)`.
3. `auth_deadline` ⇒ `None` for a session-only jar, and for an empty jar.
4. `auth_deadline` ignores an already-expired cookie.
5. `plan_for`: `None`⇒`Refresh(15)`; `Some(1800)`⇒`Refresh(15)`; `Some(2880)`⇒`Refresh(24)`; `Some(601)`⇒`Refresh(5)` (floor); `Some(599)`⇒`Watch`; `Some(14*86400)`⇒`Refresh(360)` (ceiling).
6. `classify`: `"basic 200 0 /"`⇒`Alive`; `"basic 200 0 /home"`⇒`Alive`; `"basic 200 0 /login"`⇒`Suspicious`; `"basic 401 0 /"`⇒`Suspicious`; `"basic 403 0 /"`⇒`Suspicious`; `"basic 404 0 /"`⇒`Unclear`; `"basic 500 0 /"`⇒`Unclear`; `"error TypeError"`⇒`Unclear`; `"error TimeoutError"`⇒`Unclear`; `"skip 0 0 "`⇒`Unclear`; `""`⇒`Unclear`.
7. `looks_like_login_path`: true for `/login`, `/users/sign_in`, `/auth/login`, `/sso`, `/oauth/authorize`; **false for `/`, `/home`, `/dashboard`, `/logistics`, `/assorted`** — the substring trap that would 409 every bot on those tabs.
8. The outcome state machine: `Alive` stamps and writes `ok`; one `Suspicious` writes nothing; two consecutive `Suspicious` write `needs_login` with `every = 10`; `Suspicious` → `Alive` writes `ok` and clears strikes; three `Unclear` stamp without ever touching `login_state`.
9. `due_at`: `None` ⇒ `0` (due now); `Some(t)` ⇒ `t + every*60 + jitter`; the drawn jitter is within ±10 % of the interval.
10. `PING_JS` contains `credentials:'include'`, `redirect:'follow'`, `cache:'no-store'`, `AbortSignal.timeout(10000)` and `location.origin`, and contains neither `{}` nor any format placeholder — the no-injection pin.
11. An unrecognised `keepalive_action` (including the column default `'reload'`) resolves to soft mode, never to a reload.

**`server/src/db/browser_tabs.rs`** (mirroring the existing patch test at `:433`): each new `TabPatch` field round-trips; `None` / `false` leaves its column alone; `keepalive_stamp_now` sets `last_keepalive_at` and `keepalive_clear_stamp` nulls it; `list_keepalive` returns only enabled rows.

**`server/tests/browser_service.rs`, `#[ignore]`d** (the repo convention for tests needing the pinned binary), reusing `serve_page` (`:161`) extended to send `Set-Cookie: sid=…; Max-Age=600; HttpOnly`:

* `a_soft_ping_slides_a_cookie_expiry_without_navigating` — read `expires` and `Page.getNavigationHistory().entries.len()`, run `PING_JS`, assert the expiry moved forward and the history length is unchanged. This is exactly the experiment that ran green in the scratchpad probe (M5 + M6).

**`web/tests/unit/browser-keep-signed-in.test.ts`:** every row of the copy table with a frozen clock; the stale threshold flips exactly at `3 × every × 60`; `Starting —` appears only when `last_keepalive_at === null`; a non-http url disables the row and keeps its hint; the interval formatter gives `"45 min"` / `"6 h"`; **every produced `detail` is ≤ 88 characters**.

**`web/tests/unit/` component test:** `browser-menu` renders `detail` as a second line inside the same single `<button role="menuitem">`, keeps roving focus and `disabled` behaviour, and rows without `detail` render unchanged; `pageRows()` includes `keepalive`, disabled when there is no active tab.

**Bench:** two tabs added to `web/src/routes/dev-browser-workspace.fixture.ts` — one refreshing (`action:'soft'`, `every:45`, checked 12 min ago) and one watching (`action:'watch'`) — plus the four new fields on all eight existing fixtures, so the offline mobile rig can shoot the row at 390 px.

**Gates (both must be green before the PR):**

```bash
cd web && bun install --frozen-lockfile && bunx tsc -b && bun test tests/unit --timeout 15000 \
  && bun run build && bun run perf:size && bun run lint:gate
cd server && OPENSSL_NO_VENDOR=1 OPENSSL_LIB_DIR=/usr/lib/x86_64-linux-gnu \
  cargo check --all-targets && cargo test        # cp -r web/dist server/static first if static is empty
```

Never `cargo --release`, never `cargo fmt`.

---

## 8. Acceptance criteria

A reviewer can check every one of these.

**Mechanics**

1. `grep -rn "Page.reload" server/src/connectors/browser/keepalive.rs` is empty, and no code path in the feature writes `keepalive_action = 'reload'`.
2. `PING_JS` is a `const` with no interpolation; the ping's origin comes from `location.origin` inside the page, and `keepalive_url` is never read.
3. The cookie read is `Network.getCookies` with `{}` and no `Network.enable` call anywhere in the diff.
4. The schedule and the watch decision are computed from the cookie read taken **after** the ping (F3). A test or a code comment names the 18-minute sliding-window case.
5. `classify` returns `Unclear` — never `Suspicious` — for `404`, `5xx`, `error *`, and `skip`, and `looks_like_login_path("/logistics") == false`.
6. `login_state='needs_login'` is written only after two consecutive `Suspicious` outcomes, and any `Alive` outcome writes `login_state='ok'`.
7. The sweep reads `tab.mode()` and skips the whole tick on `DriveMode::HumanDriving`.
8. `sweep` returns before touching `state.browser` when `list_keepalive` is empty (assertable by reading the function's first five lines).
9. The sweep never calls `dehydrate_tab` and never closes a tab; `TooManyTabs` is handled as `Unclear`.

**Numbers**

10. `FLOOR_MINUTES=5`, `BLIND_MINUTES=15`, `CEILING_MINUTES=360`, `WATCH_UNDER_SECS=600`, `WATCH_EVERY_MINUTES=10`, `NEEDS_LOGIN_MINUTES=10`, `MAX_ENABLED_TABS=4`, `MAX_WAKES_PER_TICK=2`, `TICK=60s`, and `MissedTickBehavior::Skip` is set.
11. `plan_for(Some(2880)) == Refresh(24)` and `plan_for(Some(599)) == Watch` in a passing test.
12. Enabling a tab whose `last_keepalive_at` is `NULL` makes `due_at` return `0`, so the first tick lands within 60 s.

**Data & API**

13. `git status` shows **no new file under `server/migrations/`**.
14. `PatchBody` accepts `keepalive_enabled` and nothing else keepalive-shaped; `keepalive_every` and `keepalive_action` cannot be set from a request body.
15. `patch_handler` performs no `ensure_tab` / Chrome start; enabling on a cold box returns in DB time.
16. Enabling a fifth tab returns 400 with the four-tab message; enabling on a non-`http(s)` url returns 400.
17. `tab_json` emits `keepalive_enabled`, `keepalive_every`, `keepalive_action`, `last_keepalive_at`.
18. `audit` rows exist for `browser.keepalive_on`, `browser.keepalive_off`, `browser.keepalive_signed_out`; no audit row is written per successful tick.

**UI**

19. `BrowserMenuItem.detail` is optional and every existing menu row renders unchanged (component test).
20. The ⋯ row's label is `Keep me signed in` when off and `Stop keeping signed in` when on; the seven detail strings match §5.1 verbatim and each is ≤ 88 characters.
21. No countdown, no interval control, no badge, no new status dot anywhere in the diff.
22. A 390 px screenshot from `/dev/browser-workspace` shows the row with both lines legible and no horizontal overflow.

**Honesty**

23. No copy anywhere in the diff claims the tab "stays logged in"; every on-state line carries either an interval and an age, or the reason it cannot check.
24. The watch state writes no `login_state` and no `probed_now`, and its copy says supermux is watching rather than refreshing.
25. No copy claims a browser or server restart signs the owner out. It does not: session cookies were measured surviving both a clean close and a `SIGKILL` on this durable profile (M11).

---

## 9. Explicitly not in v1

`Page.reload` in any form · `Network.enable` / `responseReceivedExtraInfo` raw `Set-Cookie` learning · a sliding-vs-absolute verdict and the "you'll be signed out at 03:12" pre-warning · `keepalive_url` (a learned per-site keep-alive endpoint) · `keepalive_script` · per-origin rather than per-tab scope · an interval picker · a `?tab=` deep link for the push · the post-takeover "Stay signed in to github.com?" toast · the three anti-throttling launch flags (`--disable-background-timer-throttling`, `--disable-backgrounding-occluded-windows`, `--disable-renderer-backgrounding`), which `launch.rs:159-189` does not carry: they address an SPA's *own* silent-refresh timer being budget-throttled in a hidden tab, which is a different failure from the one this toggle fixes, and which **was not measured on this box**. They belong in a separate two-line commit with their own `launch_args` assertion, flagged unverified — not folded into this feature's claims.
