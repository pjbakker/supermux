# Shared Browser v1 — design spec

**Status:** implementation-ready design. No product code in this document.
**Basis:** the approved assessment (`shared-browser-assessment.md`, verdict **PARTIAL-REUSE**).
**Code ground truth:** `/opt/projects/supermux` @ `main` (d6b73cb, PR #119). Every line
reference below was re-read against the tree while writing this spec; corrections to the
assessment are flagged inline with **[corrected]**.
Date: 2026-08-24.

---

## 1. Summary, goals, non-goals

### 1.1 Summary

The shipped browser connector gives every *agent session* a throwaway, isolated Chrome
context that is destroyed with the session. Owner decision for v1 inverts the unit of
identity:

> **The human logs in once. Sessions and tabs persist and pin. Agents that are explicitly
> granted a tab reuse that authenticated tab.**

v1 therefore builds a **persistent human-driven browser workspace** on top of the existing
module's transport and process layer, and **re-scopes** (never deletes) the existing
per-agent isolation path to a second mode — **agent scratch** — which remains the default
for any agent with no tab grant.

Two modes, one Chrome process, one CDP socket:

```text
  chrome  (ONE process, ONE durable --user-data-dir)
    │
    ├── DEFAULT browser context  ← the persistent profile IS the cookie jar
    │     ├── target ──▶ Tab { id:"tb_9f…", title, url, pinned, grants, lock, origins }
    │     ├── target ──▶ Tab { … }            ← WORKSPACE mode (new)
    │     └── target ──▶ Tab { … }
    │
    ├── BrowserContext(incognito-equivalent) ──▶ AgentContext{session:"alice"}
    └── BrowserContext(incognito-equivalent) ──▶ AgentContext{session:"bob"}
                                                  ↑ AGENT SCRATCH mode (existing, unchanged)
```

The switch between them is **one optional `tab` argument on every tool**: present ⇒
workspace tab (requires a per-tab grant); absent ⇒ scratch context (today's behaviour,
byte-for-byte). That keeps every shipped test meaningful and every shipped agent working.

### 1.2 Goals

- **G1 — logins outlive everything.** A login completed by the human in a workspace tab
  survives: the tab being closed, Chrome being idle-reaped, Chrome crashing, and a
  `systemctl restart supermux`.
- **G2 — the human drives.** A real, mobile-first UI route where a human opens tabs, logs
  in, pins them, and watches what agents do on them.
- **G3 — per-tab lending.** An agent may be granted tab *A* and not tab *B*, using the
  existing bot / `@company:<id>` / `*` grant keyspace. Fail-closed everywhere.
- **G4 — honest expiry.** A tab whose login has lapsed says so, and **refuses agent verbs**
  rather than letting an agent scrape a login page and report it as data.
- **G5 — no regression for agents.** Un-granted agents keep exactly the isolated scratch
  browser they have today, with the same isolation guarantees and the same tests.
- **G6 — auditability.** Every agent action against a workspace tab is recorded and visible
  on that tab's card.

### 1.3 Non-goals (v1, explicitly)

- **Multiple concurrent human drivers.** One driver per tab (the existing `ViewerSlot`
  primitive, re-keyed). Two humans on one tab is out of scope.
- **Multiple workspaces / profiles.** Exactly one durable profile per supermux instance.
- **Extensions.** No `--load-extension`, no Chrome Web Store, no user scripts.
- **Downloads, printing, file pickers, native dialogs.** Out of scope; a tab that raises a
  native dialog is a known dead end in v1.
- **Cross-company tab sharing.** Refused server-side, not merely hidden (see §8.3).
- **Automatic re-login.** No credential replay, no password autofill by supermux. Expiry is
  surfaced; re-login is a human act.
- **Multi-instance shared profile.** The user runs more than one supermux; a profile is
  owned by exactly one instance and a second instance is refused loudly (§8.6).
- **Anti-detection as a product.** v1 adopts a *credible-browser* posture (§2.3, R0): a real
  full-Chromium build with a real UA. It does **not** ship a fingerprint-spoofing framework,
  proxy rotation, or CAPTCHA solving. Sites that hard-gate datacentre IPs stay out of reach in
  v1; the residential-proxy path (§2.3, R0.5) is noted as a config seam, not built.

---

## 2. Architecture — KEEP vs REPLACE

### 2.1 The seam, stated precisely

Identity lives in exactly two places, and only these two change:

| Where | Today | v1 |
|---|---|---|
| `mod.rs:163` `Running.contexts: HashMap<String /*session*/, Arc<AgentContext>>` | keyed on session name | split into `tabs: HashMap<TabId, Arc<Tab>>` + `scratch: HashMap<String, Arc<AgentContext>>` |
| `context.rs` `AgentContext::create` → `Target.createBrowserContext` (`{"disposeOnDetach": false}`) | always an incognito-equivalent context | **workspace path does not call it at all** — `Target.createTarget` with **no** `browserContextId` lands in the default (persistent) context. Scratch path unchanged. |

Everything below that seam — `cdp.rs` flat-mode client, `launch.rs` process ownership,
`lock.rs` state machine, the screencast pump + ack accounting, `INPUT_METHODS`,
coordinate mapping, WS first-frame auth — is identity-agnostic and transfers unchanged.

### 2.2 KEEP layer (verified against code)

| Component | Verified fact | v1 change |
|---|---|---|
| `launch.rs` spawn / `process_group(0)` / group-kill / `DevToolsActivePort` / `Drop` backstop | `launch.rs:145` `launch`, `:295` `shutdown`, `:331` `remove_profile`, `:344` `Drop` (calls `remove_profile` at `:359`) | **KEEP wholesale.** One change: profile mode (§2.3). |
| `launch.rs::launch_args` (`launch.rs:101`) | exact pinned recipe; three unit tests assert it (`:385`, `:394`, `:415`) | durable `--user-data-dir` value; `--window-size` raised for the workspace; no other arg changes in v1 (`--headless=new` stays forbidden, `launch.rs:16`) |
| `cdp.rs` (312 ln) — one browser WS, `{id,method,params,sessionId}`, flat-mode fan-out, reader fails all pending on socket death | no identity assumptions anywhere | **KEEP AS-IS. Zero edits.** |
| `lock.rs` (404 ln) — `DriveMode`, `Actor`, `HandOff`, `DriveLock` over `watch::channel`, `ensure_agent`, `await_agent`, `gate` (`:247`, humans always pass) | `DriveLock::new(impl Into<String>)` (`:144`) — already generic over the subject | **KEEP logic 1:1, re-scope cardinality: one lock per TAB.** Rename the field/accessor `session` → `subject` (`lock.rs:154`, and the `BrowserError::HumanDriving{session}` / `TakeoverWait{session}` fields, `error.rs:41/:45`). Mechanical, ~8 call sites. |
| `context.rs` page-driving body — `navigate`, `evaluate`, `current_url`, `click`, `move_mouse`, `scroll`, `insert_text`, `press_key`, `tap`, `set_touch_emulation`, `set_viewport`, `start_screencast`/`stop_screencast`/`ack_frame`, `screenshot`, `dispatch_input` + `INPUT_METHODS` (4 methods) | ~500 of 795 lines have no isolation semantics; the ack doc-comment on `ScreencastFrame.ack` records the **2-frame in-flight** trap (a dropped frame still must be acked or the stream stalls forever) | **KEEP the body verbatim.** It becomes the shared `Page` primitive used by both a `Tab` and an `AgentContext`. Do **not** re-derive the ack accounting. |
| `takeover.rs` (1097 ln) — WS relay, first-frame auth (`:519`), `origin_allowed` (`:128`), `valid_name` gate (`:529`), `ViewerSlot` (`:159`), `Viewport::from_metadata`/`clamp` (`:312`), `to_cdp` closed command set (`:358`), `MAX_TEXT_BYTES`/`COORD_CEILING`, ping/pong, `human_may_drive` (`:489`), the "every exit is the socket going away" honesty comment (`:567`) | genuinely non-trivial and tested; the relay's own gate at `:706` (`if !human_may_drive(ctx.mode())`) is what makes watch-mode free (§6.4) | **KEEP, add a route.** New `/ws/browser/tab/{tab_id}`; the existing `/ws/browser/{session}/takeover` **stays** for the in-chat scratch takeover. `ViewerSlot` keys become namespaced (`tab:<id>` / `session:<name>`). |
| `tools.rs` — hook-token auth (`:95` `verify_hook_token`), grant gate (`:100`), closed 5-verb dispatch (`:116-120`), error→HTTP mapping (`:140`), selector escaping (`js_string` `:166`), `clip` (`:171`) | `the_tool_dispatch_table_is_closed` (`:514`) and `auth_and_grant_gates_refuse_before_any_chrome_can_spawn` (`:474`) pin the shape | **EXTEND** (§5). The gate order — auth, then grant, **then** dispatch — is the reason reads get grant-gated for free. |
| `error.rs` (58 ln) | typed, one variant per actionable outcome | **KEEP + new variants** (§2.5). |
| web `lib/browser/takeover-socket.ts` (365 ln) | builds the URL at `:178`; `EMPTY_SNAPSHOT`, `modifiersFor`, terminal close codes 4404/`already attached` (`:55-57`) | **KEEP AS-IS**; the URL builder becomes subject-aware. |
| web `lib/browser/frame-map.ts` (196 ln) | `decodeFrame`/`fitFrame`/`frameSize`/`toPagePoint`, letterboxing math, pure | **KEEP AS-IS. Zero edits.** |
| web `components/browser/takeover-panel.tsx` (364 ln) | props `{ session, options, embedded, className }` (`:75`); `MAX_DPR = 2`; drop-old-frames decode; `role="application"` a11y rationale | **KEEP, promote.** Rename prop `session` → `subject`; add a Watch/Drive control (§6.4). |
| web `components/chat/ui/takeover-card.tsx` | mounted from `chat/live-layer.tsx:360` + two `/dev` routes | **KEEP unchanged.** It is the *interruption*; the workspace is the *workspace*. |
| web `components/store/grant-control.tsx` | `GrantScope = 'bot'\|'company'\|'all'\|null` (`:22`); `companyGrantKey` from `@/lib/api/connectors`; company tier hidden at HQ (`activeCompany === null`); "via all agents" honesty + disabled phantom-revoke | **KEEP + one small generalization** so it can grant a *tab* as well as a connector (§6.5). |

### 2.3 REPLACE layer — the isolation boundary

**R0. The browser binary changes: full Chromium in `--headless=new`. [decided, measured]**

This was the assessment's open gate (old §10 R3, "spike it first"). It was spiked — on this
box, 2026-08-24 — and it is **closed**. The measurements below are from this host, not from
the literature.

*Why the pinned binary cannot do this job.* `chrome-headless-shell` is, in Chrome's own words,
"a lightweight wrapper around Chromium's `//content` module", recommended for "automated
screenshotting and web scraping" where "full browser authenticity" is not needed — explicitly
*not* for high-accuracy work, because it is not the real browser. The shared-browser feature is
the exact opposite use case: a human signing in to real apps. Measured head-to-head, same host,
same page, same Playwright driver:

| Signal a login page / WAF reads | `chrome-headless-shell` (pinned today) | full Chromium `--headless=new` |
|---|---|---|
| `navigator.userAgentData.brands` | **`HeadlessChrome`, `Chromium`, `Not)A;Brand`** | `Chromium`, `Not)A;Brand` |
| `window.chrome` | **`undefined`** | `object` |
| `navigator.plugins.length` | **`0`** | `5` |
| `navigator.pdfViewerEnabled` | **`false`** | `true` |
| `navigator.languages` | `["en-US"]` (single entry) | `["en-US","en"]` |
| `navigator.webdriver` (with `--disable-blink-features=AutomationControlled`) | `false` | `false` |
| WebGL renderer | SwiftShader | SwiftShader (unchanged — see R0.4) |

The first row is the decisive one and the reason this is not a tuning exercise: the
**User-Agent Client Hints brand list is a separate surface from the UA string**, and
`--user-agent=` does not touch it. Verified directly: launching full Chromium with a spoofed
`--user-agent` produced `ua: "…Chrome/149.0.0.0 Safari/537.36"` *and* clean
`brands: [Chromium, Not)A;Brand]`. On the shell the brand list keeps announcing
`HeadlessChrome` no matter what the UA string says. Any site reading `Sec-CH-UA` — which is
sent on every request by default — sees a headless browser. `window.chrome === undefined` and
`plugins.length === 0` are the two oldest, most widely deployed headless tells in every
commercial bot-detection script; the shell fails both, full Chromium passes both **before any
stealth patching at all**.

*Why not headful under Xvfb.* This is the stronger posture in the literature (a documented case
of a SAML SSO provider detecting headless Chrome that was fixed by running headful under Xvfb),
and it is what a fully paranoid build would use. **It does not work on this host and cannot be
made to without root.** Measured: `Xvfb` *is* already extracted at
`~/.local/xvfb/usr/bin/Xvfb` and its shared libs resolve cleanly, but the server aborts at
startup on `XKB: Failed to compile keymap` → `Failed to activate virtual core keyboard` — the
extracted `xkeyboard-config` data is incomplete, and `/tmp/.X11-unix` cannot be created with
the ownership X insists on (`_XSERVTransmkdir: Owner of /tmp/.X11-unix should be set to root`).
Four attempts (adding `xkbcomp` to `PATH`, `-xkbdir`, `XKB_BINDIR`, pre-creating the socket
dir) all ended at the same fatal. `sudo` is unavailable (`no new privileges` is set), so
`apt-get install xvfb xkb-data` is not an option. Adopting headful would make the shared
browser depend on a root-installed system package on every host supermux runs on — including
`supermux-strato` — which contradicts the project's no-sudo deploy story. **Rejected on deploy
cost, not on merit.** `--headless=new` is the same real-Chrome codebase (Chrome 112 unified
headless and headful into one binary; the old implementation is what got split out as
`chrome-headless-shell`), so the authenticity gap between it and headful is narrow, while the
gap to the shell is wide.

**R0.1 — the recipe.** The swap is config-only today (`ENV_CHROME_BIN`, `launch.rs:51`), and
full Chromium is **already on both boxes** via the Playwright cache — no download, no new
dependency:

```text
bin: ~/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome    (Chrome/149.0.7827.55)
LD_LIBRARY_PATH: ~/.local/chromelibs/extract/usr/lib/x86_64-linux-gnu   (unchanged)
```

Verified end-to-end with the **exact** current `launch_args()` recipe plus three additions:
Chrome wrote `DevToolsActivePort`, `GET /json/version` returned
`"Browser": "Chrome/149.0.7827.55"`, and stderr was clean (one benign GLib schema warning).
The three additions to `launch_args` (`launch.rs:101`) are:

```
  --headless=new
  --disable-blink-features=AutomationControlled
  --user-agent=<real Chrome UA matching the binary's major version>
```

- **`launch.rs:16`'s "Never `--headless=new`" comment must be rewritten, not obeyed.** It is
  true and remains true *for the shell* (the shell is already headless; the flag crashes it).
  It does not transfer to full Chromium, where the flag is the supported mode. The three recipe
  tests (`launch.rs:385`, `:394`, `:415`) update with it; `:415` (loopback-only) is unchanged.
- `--no-sandbox --no-zygote --disable-gpu --disable-dev-shm-usage` all stay — no user
  namespaces on this host, and `--no-zygote` keeps the group-kill accounting exact. Leak safety
  (§2.2) is untouched: the process-group ownership does not care which binary it owns.
- The UA must be **regenerated whenever the pinned Chromium is bumped.** A UA claiming Chrome
  149 on a Chrome 151 binary is a worse signal than no spoof at all, because the mismatch
  between the UA string and the (unspoofable) UA-CH brand version is itself a detection.
  Pin them together in one constant; a test asserts the UA's major matches the binary's.

**R0.2 — memory budget.** Measured RSS, whole process group, one `about:blank` tab:

| | window | RSS |
|---|---|---|
| `chrome-headless-shell` (today) | 1024×768 | **~286 MB** |
| full Chromium `--headless=new` | 1366×900 | **~844 MB** |

**~+560 MB at idle**, before any real page. On this host (23 GB total, ~10 GB available at
measurement time) that is affordable but not free, and it is a real argument for keeping the
idle reaper (R4) rather than pinning Chrome alive forever. Budget **~100 MB per additional live
tab** on top. `max_tabs` default **16** (R2) is therefore a *persistence* ceiling, not a
liveness one — 16 simultaneously-live tabs would be ~2.5 GB. Dehydration (R4) is what keeps
that honest, and the reaper's existing 10-minute idle timeout stays.

**R0.3 — what this does and does not buy.** It buys ordinary username/password portals,
company-internal apps, marketing tools, reseller back-offices, and most Microsoft/Google SSO —
the actual target list. It does **not** buy sites whose gate is IP reputation rather than
browser fingerprint: this is a datacentre IP, and a datacentre ASN is the one signal no local
flag can change. That is the honest residual risk (§10, R3').

**R0.4 — known remaining tells**, recorded so nobody re-derives them:
`navigator.webdriver` is already `false` via `--disable-blink-features=AutomationControlled`;
the WebGL renderer reports `SwiftShader` (software rendering) because `--disable-gpu` is on —
common enough on real Linux VMs and VDI to be weak evidence, and re-enabling GPU on a headless
no-sudo box costs more than it buys; `navigator.hardwareConcurrency` is 6 and truthful. No
`init script` fingerprint patching ships in v1 — the reason full Chromium was chosen is
precisely that it needs none for this tier of site.

**R0.5 — the proxy seam (noted, not built).** This box already has a working residential-proxy
credential set used by another project (Decodo ISP). If a target turns out to be IP-gated
rather than fingerprint-gated, the fix is a per-profile `--proxy-server` + a proxy-auth
handler, which is a config seam on `launch_args`, not an architecture change. Explicitly out of
scope for v1; recorded so the design does not preclude it.

**R1. The profile becomes a mode, not a constant.**

`launch.rs:156` hardcodes `std::env::temp_dir().join("supermux-browser-<uuid>")` and
`remove_profile()` (`:331`) is called from both `shutdown()` (`:326`) and `Drop` (`:359`).
Replace the field with a mode:

```
enum ProfileMode {
    Ephemeral(PathBuf),   // temp_dir()/supermux-browser-<uuid> — today's behaviour
    Durable(PathBuf),     // <data_dir>/browser/profile          — the workspace
}
```

- `remove_profile()` becomes a no-op for `Durable`. Everything else in `shutdown()`/`Drop`
  (group SIGTERM→SIGKILL, reap, the unconditional final group kill at `:325`) is unchanged —
  **process leak-safety is not weakened by one line.**
- `BrowserConfig` gains `profile: ProfileMode`, defaulting to `Durable(<data_dir>/browser/profile)`.
  `server/tests/browser_service.rs::test_service()` (`:37`) explicitly selects `Ephemeral`,
  so the existing leak test keeps asserting exactly what it asserts today.
- `<data_dir>/browser/` is created `0700`. See §8.5.
- **The default context is the jar.** Chrome persists cookies/localStorage/IndexedDB of the
  *default* browser context into `<user-data-dir>/Default/…`. Incognito-equivalent contexts
  created by `Target.createBrowserContext` do **not** persist — so scratch mode keeps its
  guarantee even while sharing the durable profile dir.

**R2. The registry keys on a durable tab id.**

`Running` becomes:

```
struct Running {
    chrome: ChromeProcess,
    client: Arc<CdpClient>,
    tabs:    HashMap<TabId, Arc<Tab>>,        // live workspace tabs
    scratch: HashMap<String, Arc<AgentContext>>, // session → scratch context (as today)
    idle_since: Option<Instant>,
}
```

- `TabId` is a **durable uuid** minted at tab creation (`uuid::Uuid::new_v4().simple()`,
  the same idiom `launch.rs:158` already uses), prefixed `tb_`. It is **not** the CDP
  `targetId`, which changes on every rehydrate.
- `BrowserConfig.max_contexts` (default 8, `mod.rs:86`, env `SUPERMUX_BROWSER_MAX_CONTEXTS`)
  splits into `max_scratch` (8, unchanged, same env var) and `max_tabs` (default **16**,
  env `SUPERMUX_BROWSER_MAX_TABS`). 8 is too low for a workspace.
- `context_for(session)` (`mod.rs:246`) keeps its exact signature and semantics for scratch.
  New: `tab(tab_id)` / `open_tab(url)` / `close_tab(tab_id)` / `tabs()`.

**R3. `dispose_on_teardown` must not touch tabs.**

`mod.rs:487` `dispose_on_teardown(browser, session)` is wired into `SessionEnd`,
`lifecycle::stop`, `forget_session`, and rename. Its doc (`:472-486`) lists three real leaks
it fixes, all of which are about *scratch* contexts. **v1 change is one word:** it calls
`close_scratch(session)` and can no longer reach the tab map. A session ending must never
close a tab, pinned or not — that is precisely the anti-goal.

**R4. The idle reaper dehydrates instead of losing.**

`spawn_idle_reaper` (`mod.rs:545`) fires when `idle_since.is_some() && contexts.is_empty()`
after `DEFAULT_IDLE_TIMEOUT` (10 min, `:89`). Pinning Chrome alive forever would re-introduce
leak #2 from that same doc-comment on a box with a documented chrome-leak history. So:

**Dehydration, not eviction.** A tab has two orthogonal states:

- *Persisted* (always): its row in `browser_tabs` — id, title, url, pinned, origins, grants,
  login state. Never lost by a reap.
- *Live* (transient): a CDP target + flat-mode session inside the running Chrome.

Reaper policy:
1. Idle clock arms when `tabs` and `scratch` are both empty **of activity** — no live driver,
   no agent call, no attached viewer — for `idle_timeout`.
2. On expiry: for each live tab, persist `url`/`title`, `Target.closeTarget`, drop it from
   `tabs`. Then the existing `shutdown()` runs unchanged.
3. Because the profile is on disk, **the cookies survive the reap.** Next access to a tab
   relaunches Chrome on the same durable profile, `Target.createTarget` at the stored URL, and
   the login is simply there. This is asserted by test T4/T6 (§9).

`idle_armed()` (`mod.rs:318`) keeps its meaning (the observable behind "the reaper is not
defeated") and grows a companion `dehydrated_tab_count()`.

**R5. `Tab::close()` never disposes a browser context.**

`AgentContext::close()` today does `Target.closeTarget` **then**
`Target.disposeBrowserContext`. The workspace path must do `closeTarget` only — disposing the
*default* context would be a protocol error at best and would nuke every tab at worst.

### 2.4 Component keep/change/drop table (assessment's table, corrected)

Corrections marked **[corrected]**.

#### Server

| Component | Call | Note |
|---|---|---|
| `launch.rs` process ownership | **KEEP + 1 change** | `ProfileMode`; `remove_profile` skipped for `Durable`. |
| `launch.rs::launch_args` | **CHANGE** | durable `--user-data-dir`, larger `--window-size`. Binary swap is already possible via `SUPERMUX_CHROME_BIN` (`launch.rs:50`) — no code change needed for the spike. **[corrected]** the assessment implied the binary change is code work; it is config work until the LD_LIBRARY_PATH recipe bites. |
| `cdp.rs` | **KEEP AS-IS** | zero edits. |
| `error.rs` | **KEEP + variants** | §2.5. |
| `lock.rs` | **KEEP AS-IS, re-scope** | one lock **per tab**; `session` → `subject` rename. |
| `context.rs` page primitives | **KEEP body** | becomes the shared `Page` used by `Tab` and `AgentContext`. |
| `context.rs::create/finish_create/close` | **REPLACE (workspace path)** | workspace never calls `createBrowserContext`; `close_tab` = `closeTarget` only. Scratch path keeps `create`/`close` verbatim. |
| `mod.rs` service skeleton, lazy start, relaunch-on-death (`:249-256`), `shutdown` drain, `install_signal_hook`, `Drop` | **KEEP** | unchanged. |
| `mod.rs` registry / cap / reaper / `dispose_on_teardown` | **REPLACE** | R2–R4. |
| `takeover.rs` | **KEEP, add route** | `/ws/browser/tab/{tab_id}` added; session route retained. **[corrected]** the assessment says "change the route"; the scratch route must **stay**, because `TakeoverCard` still needs it. |
| `tools.rs` | **EXTEND** | `tab` arg, `has_tab_grant`, `browser_list_tabs`. |
| `mcp.rs` + `mcp_server.py` | **EXTEND** | mirror the tool signature change; `tool_decls()` (`mcp.rs:63`) and `TOOLS` (`mcp_server.py:202`) must stay in lockstep with `web/src/components/store/catalog.ts:207`. |
| `db/connectors.rs` | **KEEP AS-IS** | reused for the connector-level grant and for `company_of_grant_target` (`:408`). Not modified. |
| `tests/browser_service.rs` isolation tests | **RE-SCOPE, don't delete** | §9. |

#### Web

| Component | Call | Note |
|---|---|---|
| `lib/browser/takeover-socket.ts` | **KEEP AS-IS** | URL builder (`:178`) becomes subject-aware. |
| `lib/browser/frame-map.ts` | **KEEP AS-IS** | zero edits. |
| `components/browser/takeover-panel.tsx` | **KEEP, promote** | prop rename + Watch/Drive control. |
| `components/chat/ui/takeover-card.tsx` | **KEEP** | unchanged. |
| `components/store/catalog.ts` `shared-browser` card (`:207`) | **KEEP + amend copy** | add `browser_list_tabs`; description stops implying a per-bot browser. |
| `components/store/grant-control.tsx` | **KEEP + generalize** | optional grant/revoke overrides so one control serves connector *and* tab. |
| `routes/browser.tsx` + tab strip + pin + per-tab grant sheet | **NEW** | §6. |

**Delete outright: nothing.**

### 2.5 New error variants (`error.rs`)

```
NoSuchTab(String)                          → 404
NotGrantedForTab { session, tab }          → 403   (never reveals whether the tab exists)
TooManyTabs { max }                        → 429
TabNeedsLogin { tab }                      → 409   (the honest-expiry refusal, §7)
OriginNotAllowed { tab, host }             → 403
ProfileLocked { by_pid: Option<u32> }      → 503   (§8.6)
```

`HumanDriving`/`TakeoverWait` keep their variants; their field is renamed `session` →
`subject`. The 403 for `NotGrantedForTab` and the 404 for `NoSuchTab` are deliberately
**both** rendered as 403 at the HTTP boundary for agent callers, so an ungranted agent gets no
existence oracle — mirroring the constant-time no-oracle posture of `verify_hook_token`.

---

## 3. Data model

### 3.1 Why not `session_connectors`

`session_connectors`' primary key is `(session_name, connector_id)`
(`db/connectors.rs::grant`, `:264`, `ON CONFLICT(session_name, connector_id)`). It holds
**exactly one row per grantee per connector** and therefore cannot express "bot X may use
tabs 2 and 5, but not tab 7." `account_ref` (`Grant.account_ref`, `:60`) is a tempting hook
and is the wrong shape: an account is a *credential*, a tab is a *live authenticated
surface*. Two new tables.

### 3.2 New tables

Migration **`server/migrations/0038_browser_tabs.sql`** — a **new file**. The highest existing
number is `0037_connector_account_company.sql` (note `0025` is absent; the sequence is not
contiguous). **Never edit an existing migration** — they are checksummed and a
`VersionMismatch` bricks deployed installs. ⚠️ A concurrent bot-mode workstream is also
queued to claim `0038`; re-run `ls server/migrations` at implementation time and take the next
genuinely free number.

```sql
CREATE TABLE browser_tabs (
  id            TEXT PRIMARY KEY,           -- "tb_<uuid-simple>", durable across restarts
  title         TEXT NOT NULL DEFAULT '',
  url           TEXT NOT NULL DEFAULT 'about:blank',
  pinned        INTEGER NOT NULL DEFAULT 0,
  company_id    INTEGER,                    -- NULL = HQ/global; FK companies(id) ON DELETE SET NULL
  origins       TEXT NOT NULL DEFAULT '[]', -- JSON array of host rules (§8.4)
  login_state   TEXT NOT NULL DEFAULT 'unknown', -- 'ok' | 'needs_login' | 'unknown'
  last_probe_at INTEGER,                    -- unix seconds; NULL = never probed
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER NOT NULL
);
CREATE INDEX browser_tabs_company_idx ON browser_tabs(company_id);

CREATE TABLE browser_tab_grants (
  tab_id     TEXT NOT NULL REFERENCES browser_tabs(id) ON DELETE CASCADE,
  grantee    TEXT NOT NULL,   -- bot slug | '@company:<id>' | '*'  (the EXISTING keyspace)
  enabled    INTEGER NOT NULL DEFAULT 1,
  granted_at INTEGER NOT NULL,
  PRIMARY KEY (tab_id, grantee)
);
CREATE INDEX browser_tab_grants_grantee_idx ON browser_tab_grants(grantee);
```

`ON DELETE CASCADE` mirrors the `connectors`→`session_connectors` cascade established by
migration `0031`.

### 3.3 Grantee keyspace and company scoping — reuse, don't reinvent

`grantee` reuses **the exact sentinels already in `db/connectors.rs`**:

- `db::connectors::ALL_AGENTS` = `"*"` (`:16`)
- `db::connectors::COMPANY_PREFIX` = `"@company:"` (`:23`) — **[corrected]**, the assessment
  cited `:184`; that line is the doc-comment of `grants_for_session`, the constant is at `:23`.
- otherwise a real session slug.

**There is no `server/src/connectors/scope.rs`** — **[corrected]** relative to the original
brief. Company scoping is implemented in **`db/connectors.rs::grants_for_session`** (`:193`):
a three-tier union with `own > company > all` precedence, where tier 2 resolves the session's
`sessions.company_id` and reads grants keyed `@company:<id>`, and a `*`/`@company:` sentinel
never resolves to a company itself. `connector_accounts.company_id` (`:92`) and
`company_of_grant_target` (`:408`) are the companion primitives.

New module **`server/src/db/browser_tabs.rs`**, mirroring `db/connectors.rs`'s shape and its
runtime-checked (`query_as::<_, T>`) style so no offline sqlx cache is needed:

```
list(pool)                                  -> Vec<TabRow>
get(pool, tab_id)                           -> Option<TabRow>
create(pool, id, url, company_id)           -> ()
update(pool, tab_id, patch)                 -> ()      // title/url/pinned/origins/login_state
delete(pool, tab_id)                        -> bool
grants_for_tab(pool, tab_id)                -> Vec<TabGrant>
tabs_for_session(pool, session_name)        -> Vec<TabRow>   // the 3-tier union, tab-shaped
grant(pool, tab_id, grantee, enabled)       -> ()
revoke(pool, tab_id, grantee)               -> bool
```

`tabs_for_session` is the **direct analogue** of `grants_for_session`: own-slug rows, then
`@company:<id>` rows when `sessions.company_id` is non-NULL, then `*` rows, de-duplicated by
`tab_id` keeping the highest-precedence occurrence. It additionally applies the **hard company
containment filter** of §8.3, so it is the single source of truth for both `list_tabs` and
`has_tab_grant` and the two can never disagree.

### 3.4 Audit

No new table. Reuse `db::audit::log_authored` (`db/audit.rs:72`) and
`events_for_session` (`:190`) with:

- `author` = the calling session slug
- `action` = `browser.navigate` | `browser.click` | `browser.read` | `browser.screenshot` |
  `browser.takeover` | `browser.list_tabs`
- `target` = `tab:<tab_id>` (indexed by `0026_audit_target_idx`)
- detail = the tab's URL at call time (+ selector, clipped)

---

## 4. The tab model

```rust
pub struct Tab {
    id: TabId,                       // durable, "tb_<uuid>"
    target_id: String,               // CDP targetId — CHANGES on rehydrate
    cdp_session_id: String,          // flat-mode session id
    client: Arc<CdpClient>,          // the ONE browser socket, shared
    lock: DriveLock,                 // DriveLock::new(tab_id) — one per tab
    screencast: Mutex<Option<Screencast>>,   // the existing pump, verbatim
    meta: RwLock<TabMeta>,           // title, url, pinned, origins, login_state (mirrors DB)
}
```

`Tab` and `AgentContext` share every page-driving method by holding the same inner `Page`
primitive lifted out of `context.rs` (a `{client, target_id, cdp_session_id}` triple plus the
methods listed in §2.2). **No page-driving logic is rewritten; it is moved once.**

### 4.1 CDP surface used

| Operation | CDP call |
|---|---|
| open a tab | `Target.createTarget { url }` — **no `browserContextId`** ⇒ default persistent context |
| attach | `Target.attachToTarget { targetId, flatten: true }` then `Page.enable`, `Runtime.enable` (exactly `context.rs::finish_create`'s sequence) |
| enumerate on boot / after crash | `Target.getTargets` → reconcile live targets against `browser_tabs` rows |
| close a tab | `Target.closeTarget { targetId }` — **never** `Target.disposeBrowserContext` |
| everything else | the existing `Page.*` / `Input.*` / `Runtime.*` calls, unchanged |

Flat mode already multiplexes N targets over the one socket (`cdp.rs` module docs), so N tabs
is **additive plumbing, not structural**: `CdpEvent.session_id` already tags every event, and
`Tab` filters on its own `cdp_session_id` exactly as `AgentContext` does today.

### 4.2 Lifecycle: hydrate / dehydrate / rehydrate

```
create   : INSERT row → (lazily) createTarget+attach → live
dehydrate: persist url+title → closeTarget → row remains, target gone
rehydrate: relaunch chrome if needed → createTarget(row.url) → attach → probe (§7)
delete   : closeTarget if live → DELETE row (grants cascade)
```

**Reconciliation on start.** `start_locked()` (`mod.rs:~395`) additionally, after
`CdpClient::connect`, calls `Target.getTargets` and drops any orphan page target that the
durable profile's session-restore may have resurrected, so the live set is always exactly the
set supermux believes in. Tabs are rehydrated **lazily** (on first human open or first granted
agent call), never eagerly at boot — the lazy-start invariant (`mod.rs:30-35`, "a supermux
install with no browser grants never spawns a browser") is load-bearing and must survive.

### 4.3 One lock per tab

`DriveLock::new(tab_id)`. Consequences, all desirable:

- A human editing tab A does **not** block a granted agent on tab B.
- `request_human_takeover` / `release_to_agent` / `mode` on `BrowserService` gain tab-scoped
  siblings; the session-scoped ones stay for scratch.
- The in-chat `TakeoverCard` ask (raised by `sessions::takeover_ask`) is unchanged for
  scratch, and for a tab it names the tab.

---

## 5. Tool / MCP surface

### 5.1 Signatures

Every verb gains an **optional** `tab` argument. Absent ⇒ scratch (today's behaviour,
byte-identical). Present ⇒ workspace tab.

| Tool | Args |
|---|---|
| `browser_navigate` | `{ url, tab? }` |
| `browser_click` | `{ selector? , x?, y?, tab? }` |
| `browser_read` | `{ selector?, format?, max_chars?, tab? }` |
| `browser_screenshot` | `{ tab? }` |
| `request_human_takeover` | `{ reason, tab?, wait_seconds? }` |
| **`browser_list_tabs`** *(new)* | `{}` |

`browser_list_tabs` returns **only tabs this session may use** — id, title, url, pinned,
`login_state`, `last_verified` — so it doubles as discovery and leaks nothing about tabs the
session has no grant on. It is the tool an agent calls first; the store card copy says so.

### 5.2 The gate

`tools.rs::tool_handler` (`:88`) keeps its order — **auth → grant → dispatch** — which is
exactly why every verb, including `read` and `screenshot`, is grant-gated for free:

```
1. verify_hook_token(state, body.session, headers)              (:95, unchanged)
2. has_browser_grant(state, session)                            (:130, unchanged — necessary)
3. if args.tab is Some(t):                                       NEW
       has_tab_grant(state, session, t)?    else 403             (necessary AND sufficient)
       tab_is_usable(t)?                    else 409 TabNeedsLogin
   else:
       context_for(session)                                      (unchanged scratch path)
4. closed dispatch table                                        (:116-120 + list_tabs)
```

```
async fn has_tab_grant(state, session, tab_id) -> Result<bool> {
    // 1. connector-level grant — NECESSARY, no longer SUFFICIENT
    if !has_browser_grant(state, session).await? { return Ok(false) }
    // 2. per-tab grant across the SAME three tiers as grants_for_session
    //    (own slug > @company:<id> > *), enabled = 1
    // 3. HARD company containment (§8.3)
    // fail closed on every error path
}
```

`browser_list_tabs` is the one verb reachable with only the connector grant — it returns an
empty list for a session with no tab grants, which is the honest answer and not an oracle.

### 5.3 `mcp.rs` and `mcp_server.py`

Three files must stay mirrored (the catalog file says so in a comment at `catalog.ts:203`):

1. `mcp.rs::tool_decls()` (`:63`) — add the 6th `ToolDecl`, amend descriptions to mention
   `tab`. `manifest()` (`:138`) picks these up automatically.
2. `mcp_server.py` — add `LIST_TABS_TOOL` + `tool_list_tabs`, append to `TOOLS` (`:202`),
   add `tab` to each `inputSchema.properties` (`:105`, `:121`, `:138`, `:164`, `:178`).
   Stays stdlib-only (asserted by `mcp.rs::embedded_server_is_a_stdlib_only_python_mcp_stdio_server`,
   `:234`); it just forwards `tab` in the JSON body to `/api/hook/browser/tool`.
3. `web/src/components/store/catalog.ts:207` — add the tool row + amend the description.

`SERVER_KEY`/`ALLOW_RULE` (`mcp__browser__*`) and `TAKEOVER_TOOL` are unchanged, so the
existing permission glob and the in-chat takeover detector keep working untouched. Update
`mcp.rs::live_server_advertises_the_five_tools_with_the_takeover_marker` (`:262`) → six.

### 5.4 Human REST API (bearer-gated)

New router merged into **`protected_router`** in `http.rs` (the bearer layer — *not* beside
the hook-token routers at `http.rs:51-57`):

```
GET    /api/browser/tabs                       → all tabs (human sees everything)
POST   /api/browser/tabs        { url }        → create + open
PATCH  /api/browser/tabs/{id}   { pinned?, title?, url?, origins? }
DELETE /api/browser/tabs/{id}
GET    /api/browser/tabs/{id}/grants
POST   /api/browser/tabs/{id}/grant  { grantee }     → 400 on cross-company (§8.3)
DELETE /api/browser/tabs/{id}/grant/{grantee}
POST   /api/browser/tabs/{id}/probe            → run the login probe now (§7)
GET    /api/browser/tabs/{id}/audit            → the tab's audit trail
```

---

## 6. Web UI — mobile-first

Project rule: **every UI slice is mobile-first (bottom sheets, safe-area, no overflow at
390px) AND reuses existing components.** This section is written to that rule.

### 6.1 Route + nav

New `web/src/routes/browser.tsx`, registered in `App.tsx` inside the `<Layout />` group
beside `/store` and `/files`. Nav item in `components/layout.tsx`'s `NAV` array:

```
{ to: '/browser', label: 'Browser', icon: Globe, grokOnly: true }
```

`grokOnly: true` matches the `/store` doorway policy (`layout.tsx:94`) — both nav surfaces
filter it out when grok is off, keeping the base app byte-identical. Both the rail and the
phone tab bar honour it; adding a cell shifts `--nav-n` and the sliding pill geometry
automatically (`layout.tsx:290-298`).

### 6.2 Layout

```
┌─ /browser ────────────────────────────┐
│ [◀ tab strip ─ scroll-snap rail ─ +▶] │  56px, the ONLY overflow container
│ ┌───────────────────────────────────┐ │
│ │ 🔒 example.com/inbox        ⋯     │ │  address bar + tab menu
│ ├───────────────────────────────────┤ │
│ │                                   │ │
│ │       <TakeoverPanel/>            │ │  reused verbatim
│ │                                   │ │
│ ├───────────────────────────────────┤ │
│ │ ◉ Watch  ○ Drive     👤 2 agents  │ │  mode toggle + grant affordance
│ └───────────────────────────────────┘ │
└───────────────────────────────────────┘
```

### 6.3 The tab strip at 390px — the risky bit

Constraints: 390px viewport, iOS safe-area, no horizontal *document* scroll ever (the app's
standing rule), and the strip must remain usable at 8–16 tabs.

Design:

- **A horizontal scroll rail, not a wrapping row.** `display:flex; overflow-x:auto;
  overscroll-behavior-x:contain; scroll-snap-type:x proximity; scrollbar-width:none`
  with `-webkit-overflow-scrolling:touch`. The rail is the **only** element on the page with
  `overflow-x` — everything else is `min-width:0` so a long title can never push the document
  wide. This is the specific failure mode to guard in review.
- **Chip width `clamp(112px, 38vw, 168px)`**, so ~2.6 chips are visible at 390px — enough that
  the rail *reads* as scrollable without a scrollbar. Title `text-overflow:ellipsis`.
- **Chip contents:** a 8px state dot (green = live+ok · slate = dehydrated · amber =
  needs-login · sky ring = pinned) + title + a 24px close affordance that only renders on the
  *active* chip (a 24px target next to a 112px chip is a mis-tap generator otherwise).
- **`+` is the last cell in the rail**, not a fixed overlay — a floating `+` covers the
  right-most chip exactly when the rail is scrolled to the end.
- **Safe-area:** `padding-inline: max(12px, env(safe-area-inset-left/right))` on the rail so
  the first/last chip clears a notch in landscape.
- **Active chip auto-centres** with `scrollIntoView({ inline:'center', block:'nearest' })` on
  tab change, guarded by `matchMedia('(prefers-reduced-motion)')` for `behavior`.
- **Pinned tabs sort first** and are *sticky-left* only on ≥`md` (on a phone a sticky pinned
  chip eats a third of the rail).
- **Pin toggle is NOT long-press-only.** Long-press opens the tab menu; the pin lives as an
  explicit item in that menu *and* as a control in the grant sheet. Discoverability over
  cleverness.

### 6.4 Viewport + Watch/Drive

`TakeoverPanel` is reused with `subject` instead of `session`; `takeover-socket.ts` builds
`/ws/browser/tab/{tab_id}` for a tab subject and keeps `/ws/browser/{session}/takeover` for a
session subject. Terminal close codes 4404 (`no browser context` → "this tab isn't open yet")
and `already attached` are reused verbatim.

**Watch mode is the default for a tab, and it is nearly free.** `takeover_socket` step 4
(`takeover.rs:549`) currently calls `ctx.lock().request_human_takeover()` unconditionally on
attach. For the **tab route only**, skip it: the relay already refuses to forward any input
while `!human_may_drive(ctx.mode())` (`takeover.rs:706`), and `DriveLock::gate` lets
`Actor::Human` start the screencast regardless (`lock.rs:247`). So the human sees live frames
and drives nothing until they press **Drive**, which sends a new `ClientMsg::Take` frame that
calls `request_human_takeover`. Existing `ClientMsg::HandBack` (`:266`) hands the wheel back.

Why this matters: without it, *merely looking at a tab* silently blocks every granted agent on
it — a footgun the workspace surface would hit constantly. The session route keeps
grab-on-attach (an in-chat takeover ask means the human is coming to drive).

### 6.5 The per-tab grant sheet

A `ResponsiveSheet` (`components/ui/responsive-sheet.tsx` — bottom sheet on mobile, dialog on
desktop) titled **"Who may use this tab"**, containing `GrantControl` instantiated per tab.

`GrantControl` today is hardwired to `connectorId` + `useConnectorActions()`. Minimal
generalization, keeping ONE control and ONE honesty rule:

```
GrantControl({
  connectorId, botName, scope, accountRef, compact, onGranted, onRevoked,
  // NEW, all optional — absent ⇒ today's behaviour exactly:
  resourceLabel?: string,                          // "this tab" instead of "this connector"
  api?: { grant(target): Promise<…>, revoke(target): Promise<…> },
})
```

The three tiers, the `companyGrantKey(company.id)` target, the hide-at-HQ rule
(`activeCompany === null` ⇒ no company tier), the "via all agents" copy, and the disabled
phantom-revoke all carry over **unchanged** — that honesty rule is exactly what a per-tab
grant needs. The sheet lists current grantees with their tier, plus the tab's audit tail
(§3.4) under a "Recent agent activity" disclosure, plus the pin toggle and the origin
allowlist editor.

### 6.6 Store card copy

`catalog.ts:207` and the server's `mcp.rs::manifest()` description, amended together:

> **Shared Browser** — One real Chrome you log into once. Pin the tabs that matter, and lend
> individual tabs to named agents. When a bot hits a login or 2FA it asks you to take the wheel.

Tools list gains:

> `browser_list_tabs` — See which shared tabs you're allowed to use.

The in-chat `TakeoverCard` is unchanged and stays the interruption affordance.

---

## 7. Keeping logins warm + honest expiry

**Nothing in the module refreshes anything today.** Silent expiry is *the* failure mode to
prevent: an agent reading a login wall and confidently reporting its contents as data is worse
than an agent that errors.

Persistent login profiles are an ordinary, well-supported pattern — Chromium's own
`--user-data-dir` is the mechanism every real user's browser already uses, and Playwright
documents `launchPersistentContext` for exactly this. It was verified on this box: a cookie and
a `localStorage` entry written in one Chrome process were **both still present after a full
process exit and relaunch on the same durable profile dir** (2.6 MB on disk). So the design
question is not *"can logins persist"* — they do — it is *"what makes them lapse, and what do
we do about it."*

### 7.0 What actually ends a session (and what we can do about each)

| Cause | Can keep-alive prevent it? | v1 answer |
|---|---|---|
| **Idle timeout** — server expires the session after N minutes of no requests | **Yes.** This is the whole point. | §7.2 keep-alive actions |
| **Absolute timeout** — session dies at a fixed age regardless of activity | **No.** Nothing prevents it. | honest `needs_login` (§7.3) |
| **Session cookie eviction** — a cookie with *no* `Expires` is dropped on browser exit | Partly | §7.1a — measured, see below |
| **IP change** — server binds the session to the originating IP | No | stable egress; `needs_login` |
| **UA / fingerprint mismatch** — profile reused under a different UA than it logged in with | **Yes, by not doing it** | the UA is pinned with the binary (R0.1) |
| Password change, admin revoke, MFA re-challenge | No | `needs_login` |

The two rows that generate design work are idle timeout (§7.2) and session-cookie eviction
(§7.1a). Everything else terminates in the same honest fallback, which is why §7.3 is
non-negotiable rather than a nicety.

**§7.1a — the session-cookie trap. [measured]** In the same persistence test above, the
*persistent* cookie survived the restart and a deliberately-written **session cookie (no
`Expires`) did not** — matching the long-standing Playwright report that session cookies are
not retained across `launchPersistentContext` launches. Chrome only restores session cookies
when it believes it is resuming a session ("continue where you left off"), which a
`--user-data-dir` automation launch is not. **Consequence:** an app that authenticates purely
with a session cookie will show `needs_login` after every Chrome restart, no matter how healthy
the profile is — and since R4 *deliberately* restarts Chrome on idle, that is not a rare path.

Two mitigations, both cheap, both specified here:
1. **Keep-alive keeps Chrome alive.** A tab with keep-alive enabled counts as *activity* for
   the idle reaper (R4), so a warmed tab's Chrome is not reaped, so its session cookies are not
   dropped. This is the main reason keep-alive is worth building beyond the login-lifetime
   argument.
2. **Never claim a restart is lossless.** After a rehydrate, a tab whose probe comes back
   `needs_login` must say *"signed out by a browser restart"* rather than a generic error, so
   the human knows the cause and does not go hunting.

### 7.1 The probe

Per **pinned** tab, every `KEEP_WARM_INTERVAL` (default 20 min, env
`SUPERMUX_BROWSER_KEEPWARM_MINUTES`, `0` disables), **and** unconditionally on rehydrate and
before the first agent verb after `last_probe_at` is older than the interval:

- If the tab is **dehydrated**, skip. Rehydrating Chrome to send a ping costs more than the
  staleness it buys; the probe runs on the next rehydrate instead.
- If the tab is **live**, run a same-origin credentialed probe from inside the page via the
  existing `Runtime.evaluate` path (no new CDP surface, no new crate):
  `fetch(probe_url, { method:'GET', credentials:'include', redirect:'manual' })`, where
  `probe_url` defaults to the tab's own URL.

Classification:

| Observed | `login_state` |
|---|---|
| 2xx | `ok` |
| 401 / 403, or an opaque-redirect whose `Location` host differs from the tab's host | `needs_login` |
| network error / throw / timeout | `unknown` (leave the previous value, bump nothing) |

`last_probe_at` is always recorded.

### 7.2 Bot-driven keep-alive actions (owner's design)

The probe in §7.1 *observes*; it does not necessarily *refresh*. Many apps slide their idle
timeout on any authenticated request, so a probe doubles as a keep-alive — but some slide it
only on a **navigation or a real interaction**, and some (SPAs holding a token in memory)
refresh nothing on a bare `fetch`. So keep-alive is specified as its own, escalating thing,
owned by the agents rather than by a background timer in the server.

**The unit is a `keepalive` policy on a pinned tab**, stored in `browser_tabs` (§3.2):

```
keepalive_enabled   bool      default false — opt-in per tab, set by the human in the tab sheet
keepalive_every     minutes   default 20, min 5   (env SUPERMUX_BROWSER_KEEPWARM_MINUTES)
keepalive_url       text?     null ⇒ the tab's own url; else MUST satisfy §8.4 origin scope
keepalive_action    enum      probe | reload | script    default reload
keepalive_script    text?     only for action=script; authored by a bot, approved by the human
last_keepalive_at   timestamp
```

**The three actions, cheapest first.** A tab starts at `reload` and is escalated by the human
(or by a bot's recommendation) only if that proves insufficient:

| Action | What runs | Costs | Use when |
|---|---|---|---|
| `probe` | the §7.1 same-origin credentialed `fetch` | ~1 request | the app slides on any request |
| `reload` (default) | `Page.navigate` to `keepalive_url`, wait for load, then the §7.1 probe | one page load | the common case |
| `script` | `reload`, then a bot-authored `Runtime.evaluate` snippet (e.g. click a "still there?" dialog, touch a dashboard widget) | a page load + JS | SPAs that only slide on real interaction |

**Who runs it.** This is the owner's point and it is the right shape: **the grok bots do the
keep-alive, not a hidden server thread.** Mechanically:

- The server owns only the *schedule*. A `keepalive` sweep (piggybacking the existing idle
  reaper tick, `mod.rs:545` — no new task) finds pinned tabs where
  `now - last_keepalive_at > keepalive_every` and enqueues a keep-alive **through the normal
  scheduler** as a prompt to the tab's designated keep-alive bot.
- That bot executes it **through the ordinary tool surface** (§5.1) — `browser_navigate` /
  `browser_read` with `tab:<id>`. It therefore passes **the same per-tab grant gate as any
  other agent verb** (§5.2, §8.2). *A keep-alive is not a privileged path.* A bot that has lost
  its grant simply cannot warm the tab, and the tab goes stale honestly. This is the property
  that keeps R2 intact: there is no server-side actor that reads authenticated pages outside
  the grant model.
- The bot reports the outcome; the server records `last_keepalive_at` + the resulting
  `login_state`. A `script` action's snippet is authored by the bot **but stored and replayed
  by the server after human approval** — so a compromised prompt cannot silently mutate what
  runs on an authenticated page every 20 minutes.
- `keepalive_action=script` snippets are subject to the existing `MAX_TEXT_BYTES` ceiling and
  are recorded verbatim in the §3.4 audit trail on every run.

**Rules that keep this from becoming a footgun:**

1. **Dehydrated tabs are not woken to be warmed.** If Chrome is down, a keep-alive is skipped,
   not a reason to relaunch — otherwise keep-alive defeats the idle reaper on every tab and the
   R0.2 memory budget goes with it. *Exception, deliberate:* a tab with `keepalive_enabled`
   counts as activity **while Chrome is already up** (§7.1a), which keeps the common case warm
   without ever being a reason to start Chrome.
2. **Jitter every schedule** by ±20%. Sixteen tabs pinging their apps on the same wall-clock
   20-minute boundary forever is itself an automation signature.
3. **Never keep-alive a `needs_login` tab.** Repeatedly reloading a login page is pointless,
   looks like credential-stuffing reconnaissance, and can trip lockouts. On `needs_login`,
   keep-alive **stops** until a human clears it.
4. **Back off on failure.** Two consecutive failed keep-alives ⇒ double the interval, to a
   6-hour ceiling; a success resets it. An app that is down must not be hammered.
5. **Keep-alive never re-authenticates.** It cannot log in, cannot submit a form containing a
   password field, and cannot type credentials (§1.3, "no automatic re-login"). It only touches
   an *already*-authenticated session.
6. **Absolute timeouts are unbeatable, and the UI must not imply otherwise.** Keep-alive
   extends idle-expiring sessions only; the surface says *"kept warm"*, never *"stays logged in"*.
7. **`keepalive_every` has a floor of 5 minutes**, enforced server-side, so a misconfigured tab
   cannot turn into a request flood against someone's portal.

### 7.3 Honesty rules (non-negotiable)

- **The UI never shows a bare green dot.** The chip and the tab header show
  *"Signed in · verified 6 min ago"* / *"Sign-in needed"* / *"Not verified yet"*. The heuristic
  is fallible, so the surface states its evidence and its age.
- **`needs_login` ⇒ agent verbs on that tab return `TabNeedsLogin` (409)** with the message
  *"tab `<id>` needs the human to sign in again"*. Fail closed. `browser_list_tabs` still
  lists the tab with its state, so the agent can report the blockage accurately.
- **A `needs_login` tab raises the existing in-chat ask** through
  `sessions::takeover_ask` when an agent hits it, so the human is told by the same affordance
  they already know rather than a new notification channel.
- **The human clears it by driving**: taking the wheel and completing the login flips the tab
  to `ok` on the next probe (and `POST …/probe` forces one immediately).
- **No credential replay.** supermux never stores, autofills, or replays a password. Re-login
  is always a human act.
- **Keep-alive is reported as what it is.** The tab card shows *"kept warm by @<bot> · last 12
  min ago"*, and it is never rendered as a sign-in guarantee. If keep-alive is backing off
  (§7.2 rule 4) or stopped because the tab is `needs_login` (rule 3), the card says so — a
  silently-disabled keep-alive that the human still believes is running is exactly the kind of
  false green light this section exists to forbid.

---

## 8. Security

This feature converts the browser from *isolated scratch space* into a **shared credential
store that agents can drive**. That is a genuine privilege-escalation surface.

### 8.1 What already helps (verified, retained)

- Hook-token identity per session, constant-time, no existence oracle (`tools.rs:95`).
- Closed tool dispatch table, tested (`tools.rs:514`).
- `INPUT_METHODS` allowlist (4 methods) on the raw-input seam + `to_cdp`'s closed command set
  built from untrusted client JSON (`takeover.rs:358`, with the test at `:876` asserting
  unknown shapes map to `None`), plus `MAX_TEXT_BYTES` (8 KiB) and `COORD_CEILING`.
- First-frame WS auth + `origin_allowed`, reused from the terminal socket.
- `valid_name` gate before a name is used as a map key or reaches a log line
  (`takeover.rs:529`) — the tab route applies the same shape check to `tab_id`.
- Selector escaping so a selector can never break out of the evaluate expression
  (`tools.rs::js_string`, test at `:531`).
- The drive lock already prevents agent and human fighting over one page.
- The CDP port is loopback-only and never exposed (`launch.rs:22`, test at `:415`).

### 8.2 Per-tab enforcement, fail-closed

- Enforcement is **at the tool boundary, before dispatch** (§5.2), so it covers **every**
  verb — including `read` and `screenshot`. This is the crux: those two are deliberately
  **lock**-ungated ("observing the page is never a conflict", `context.rs:23`), which is
  correct for a scratch context and *dangerous* for an authenticated one, where **reading is
  the exfiltration**. They stay lock-ungated and become **grant-gated**.
- `NoSuchTab` and `NotGrantedForTab` both render 403 to agent callers — no existence oracle.
- Any error inside `has_tab_grant` (DB error, malformed row) returns *not granted*.

### 8.3 Company containment as a hard boundary

`grants_for_session` unions `@company:<id>` grants correctly, but **nothing today prevents
granting a resource across companies**. Since the premise of the feature is "keep the no-API
systems neatly inside the company," containment is enforced **server-side, in two places**:

1. `POST /api/browser/tabs/{id}/grant` refuses (400) when
   `browser_tabs.company_id` is `Some(c)` and `db::connectors::company_of_grant_target(pool,
   grantee)` (`:408`) resolves to anything other than `Some(c)`. A tab with `company_id = NULL`
   (HQ) may only be granted to HQ sessions or `*`.
2. `has_tab_grant` re-checks the same predicate at call time, so a session moved between
   companies after the grant was made loses access immediately. **Not merely hidden in the UI.**

### 8.4 Navigation scoping per tab

A tab authenticated to `bank.example` handed to an agent is a cookie-bearing HTTP client.
`navigate` + `read` against a same-site attacker-controlled path is a plausible exfil chain.

- Each tab carries `origins`: a JSON array of host rules — an exact host (`mail.example.com`)
  or a leading-dot suffix the human opts into (`.example.com`). **Host-matching, not
  PSL-based** — deliberately, because a PSL means a new crate and this module's stated pride is
  that it adds **zero** new crates (`cdp.rs` module docs).
- On tab creation the set is seeded with the exact host of the first URL the human lands on.
- **Agent** `navigate` to a host outside the set ⇒ `OriginNotAllowed` (403), audited.
- **Human** navigation (address bar / clicking a link while driving) is never blocked; landing
  on a new host offers "Also allow `newhost` on this tab?" — an explicit, per-tab, human act.
- In-page navigation by the *site* (redirects, SPA routing) is not blocked — it cannot be, and
  blocking it would break every SSO flow.

### 8.5 Credential-surface posture

The durable profile now contains real session cookies on disk. Chrome needs it
plaintext-readable, so it cannot be sealed the way `vault` secrets are (migration `0031`). It
gets the vault's *handling* posture instead:

- `<data_dir>/browser/` created `0700`, files inherit; verified at start, and start **fails
  loudly** if the mode is looser.
- Excluded from any backup/log-capture path; never printed, never in an error string, never in
  a support bundle. Log the *path*, never the contents.
- Documented in the deploy notes as a secret-bearing directory of the same class as the vault.
- Deleting a tab does **not** clear its cookies (they live in one shared jar). A **"Sign out
  everywhere / reset the browser profile"** action exists on the workspace route, it stops
  Chrome, removes the profile dir, and sets every tab to `needs_login`. That is the honest
  eraser, and the only one.

### 8.6 One writer per profile

The user runs **more than one supermux instance**. Two processes on one `--user-data-dir` is
profile corruption. On `start_locked()`:

- Take an exclusive lockfile `<data_dir>/browser/owner.lock` (`O_CREAT|O_EXCL`, contents =
  pid + instance name); if it exists and its pid is alive, fail with `ProfileLocked`.
- Stale lock (pid dead) is reclaimed with a warning.
- Released on `shutdown()`, on `Drop`, and by the SIGTERM/SIGINT hook (`mod.rs::install_signal_hook`).

### 8.7 Audit

Every agent verb against a tab is recorded (§3.4) **before** the CDP call, so a call that
crashes the page is still recorded. The tab card surfaces the tail. This is the single
highest-value guardrail: it makes misuse discoverable where prevention is incomplete.

---

## 9. Isolation, boundaries, and the test plan

### 9.1 The boundary that must not move

**Agent scratch mode keeps every guarantee it has today.** Both existing isolation tests
remain *true and desirable* — they are re-scoped, not deleted, so nobody reads them as a
global invariant:

| Today | v1 |
|---|---|
| `two_contexts_are_cookie_and_localstorage_isolated` (`tests/browser_service.rs:265`) | → `two_scratch_contexts_are_cookie_and_localstorage_isolated`, unchanged body |
| `a_recycled_session_name_never_inherits_the_previous_cookie_jar` (`:352`) | → `a_recycled_session_name_never_inherits_the_previous_scratch_cookie_jar`, unchanged body |
| `lifecycle_leaves_no_orphan_process_or_profile_dir` (`:170`) | keeps asserting removal, now explicitly under `ProfileMode::Ephemeral` |
| `click_and_insert_text_mutate_the_page` (`:417`) | unchanged |
| `human_takeover_refuses_agent_input_until_released` (`:510`) | unchanged (scratch) + a tab-scoped sibling |
| `dropping_the_service_without_shutdown_still_kills_the_tree` (`:596`) | unchanged |

### 9.2 New tests

**The mirror test (the one the owner asked for):**

- **T4 — `a_login_survives_a_chrome_restart_and_a_service_restart`.** Serve the local test page
  (`tests/browser_service.rs::serve_page`, `:122`); in a workspace tab set a cookie **and** a
  `localStorage` key; `svc.shutdown().await`; assert the durable profile dir **still exists**;
  construct a **brand-new** `BrowserService` on the same durable dir; rehydrate the tab; read
  the cookie and the localStorage key back. This is the exact mirror image of the two
  re-scoped isolation tests and the single assertion the feature lives or dies on.

Plus:

| # | Test | Asserts |
|---|---|---|
| T1 | `a_durable_profile_survives_shutdown` | `remove_profile` is a no-op for `Durable`, and the leak test's process assertions still pass (no orphan pid, no orphan group) |
| T2 | `an_ephemeral_profile_is_still_removed` | the existing leak assertion, unchanged, under `Ephemeral` |
| T3 | `omitting_tab_routes_to_the_scratch_context` | back-compat: every shipped agent keeps working |
| T5 | `dehydrate_then_rehydrate_preserves_url_and_login` | reap-losslessness at the unit level |
| T6 | `the_idle_reaper_dehydrates_pinned_tabs_instead_of_losing_them` | `idle_armed()` still arms; rows survive; cookies survive |
| T7 | `an_ungranted_session_gets_403_on_every_verb_naming_a_tab` | explicitly enumerates **`read` and `screenshot`** — the confused-deputy guard |
| T8 | `a_cross_company_tab_grant_is_refused_server_side` | §8.3 at both the grant endpoint and `has_tab_grant` |
| T9 | `list_tabs_hides_tabs_the_session_may_not_use` | no discovery oracle |
| T10 | `a_tab_in_needs_login_refuses_agent_verbs` | §7.2, fail closed |
| T11 | `the_agent_cannot_navigate_a_tab_off_its_origin_allowlist` | §8.4; and that a human can |
| T12 | `two_tabs_have_independent_locks` | human on A does not block an agent on B |
| T13 | `the_tool_dispatch_table_is_closed` (extended) | `browser_list_tabs` in, unknown names still 400 |
| T14 | `a_second_instance_cannot_open_the_same_profile` | §8.6, typed `ProfileLocked` |
| T15 | `the_default_context_target_carries_no_browser_context_id` | the workspace path never calls `createBrowserContext` |
| T16 | `tab_close_never_disposes_a_browser_context` | R5 |
| T17 | `an_agent_call_against_a_tab_is_audited_before_the_cdp_call` | §8.7 |
| T18 | web/mobile-rig: `browser route has no horizontal document overflow at 390px` | §6.3, via the offline mobile UI review rig against a `/dev` route |
| T19 | `mcp_server_and_catalog_and_tool_decls_advertise_the_same_six_tools` | the three-file mirror of §5.3 |

Every chrome-touching test keeps the existing `chrome_present()` guard (`:48`) so CI without
the pinned binary still passes.

### 9.3 Boundaries with the rest of the app

- **Session lifecycle** may close scratch contexts and **must not** reach tabs (R3).
- **Company delete** sets `browser_tabs.company_id` to NULL (FK `ON DELETE SET NULL`); the tab
  becomes HQ-scoped and its `@company:` grants stop resolving — it does not silently become
  world-readable, because §8.3 re-checks at call time.
- **The connector store** stays the place the `shared-browser` *connector* is granted; the
  workspace route is the place *tabs* are granted. Both are necessary; neither is sufficient
  alone.
- **`/dev` routes** keep working: `dev-browser-takeover.tsx` continues to exercise the session
  route; a new `/dev/browser-workspace` fixture exercises the tab strip offline for T18.

---

## 10. Open questions and risks

### Top 3 risks

**R1 — Persistent profile × concurrent tabs is where the bugs live.** One Chrome profile is
not designed for many independent drivers. A crash, a double-launch, or an unclean shutdown can
corrupt the profile and silently drop *all* logins at once — the exact failure the feature
exists to prevent, at maximum blast radius. Mitigations, all specified above: the single-writer
lockfile (§8.6), dehydration instead of hard eviction (R4), a post-shutdown profile backup
(copy `Default/Cookies` + `Default/Local Storage` **only after Chrome is confirmed dead**, keep
the last 3), and an explicit **"logins lost, please re-authenticate"** state rather than a
silent empty jar.

**R2 — Agent access to authenticated tabs is a genuine privilege escalation, and today's read
path is ungated by design.** `evaluate`/`screenshot` are lock-free on the reasoning that
reading is never a control conflict — true for a scratch context, false for a logged-in bank
tab where reading *is* the exfiltration. If per-tab grant enforcement is not applied to reads
and to navigation origin, v1 ships a confused deputy: any bot holding the connector grant
reaches every authenticated surface in the company. §5.2 (gate before dispatch), §8.2, §8.3 and
§8.4 exist for exactly this, and T7/T8/T11 are the tests that must not be allowed to go
non-blocking.

**R3 — RESOLVED. The binary question is answered; what remains is narrower.** The original R3
("`chrome-headless-shell` may not be able to complete the logins the feature is for, spike it
first") was spiked on 2026-08-24 and is **closed in favour of full Chromium `--headless=new`**
— see §2.3 R0 for the measurements. The shell fails the two oldest headless tells outright
(`window.chrome === undefined`, `navigator.plugins.length === 0`) and, decisively, announces
`HeadlessChrome` in its **UA Client Hints brand list**, which `--user-agent` cannot mask. Full
Chromium passes all three unpatched, is already present on both boxes, and runs on the existing
`LD_LIBRARY_PATH` stash with the current launch recipe plus `--headless=new`. Persistence was
verified in the same session (cookie + `localStorage` survived a process restart on a durable
profile). The residual risks that R3 used to carry are now these three, all smaller:

**R3' — IP reputation, not fingerprint, is the remaining gate.** supermux runs on a datacentre
IP, and ASN reputation is the one signal no local flag changes. Ordinary portals and most
Microsoft/Google SSO do not care; aggressive WAFs (Cloudflare/Akamai at high sensitivity) do.
This is **not** falsifiable in the abstract — it is per-target. Mitigation is the honest
`needs_login` / blocked state plus the noted-not-built proxy seam (§2.3 R0.5). Do not let this
become a scope creep into a stealth framework.

**R3'' — passkeys/WebAuthn are a real, partial dead end. [measured]** `PublicKeyCredential`
*exists* in both binaries, but
`PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()` returns **`false`** in
full Chromium `--headless=new` on this host — there is no platform authenticator, because there
is no biometric sensor, no TPM-backed store, and no OS credential UI on a headless VPS. So:
password + TOTP/SMS logins work; **a site that mandates a platform passkey cannot be signed
into by a human driving this browser, period.** CDP's `WebAuthn` domain can attach a *virtual*
authenticator, but that is a testing facility — the credential is software-only and unattested,
and any relying party checking FIDO MDS attestation will reject it (and using it to impersonate
a hardware authenticator against a third party is out of scope on principle, not just on
feasibility). **v1 answer: detect and be honest.** A tab that hits a passkey-mandatory flow gets
a distinct `unsupported_auth` state — *"this site requires a passkey, which this browser cannot
provide"* — rather than a confusing generic failure. Headful under Xvfb would **not** fix this
either; it is a hardware/OS-credential gap, not a headless gap.

**R3''' — UA/binary drift.** The spoofed UA (R0.1) and the pinned Chromium version must be
bumped together. A stale UA is worse than none, because the UA-CH brand version is unspoofable
and the mismatch is itself the detection. Guarded by a test asserting the UA major matches the
binary's reported major.

### Recommended first move

R3's spike is **done** — the remaining half of the original recommendation stands, and is now
the actual first move: prove **one real login on one real target app** (the owner picks; a
bol.com-reseller-class portal is the honest representative case, not a friendly one) completes
in full Chromium `--headless=new` *and* survives a deliberate Chrome restart on the durable
profile. That is a half-day now that the binary and the recipe are settled, and it is the last
thing gating the persistence work. Everything else in this document is ordinary engineering.

### Open questions

1. ~~**Headful-under-Xvfb vs `--headless=new` full Chromium**~~ — **CLOSED: full Chromium
   `--headless=new`** (§2.3 R0). Headful was rejected on deploy cost: `Xvfb` cannot be brought
   up on this no-sudo host (XKB keymap compile fails fatally; `xkb-data` needs root), and
   depending on a root-installed X server on every supermux host contradicts the deploy story.
   Budget consequence is recorded in R0.2 (~+560 MB idle).
2. ~~**Where does `<data_dir>` point on the deployed instances?**~~ — **ANSWERED.**
   `data_dir` resolves to `$SUPERMUX_DATA_DIR` → `$HOME/.supermux` (`config.rs:435`,
   `:450-465`), and the systemd unit sets it explicitly
   (`etc/systemd/supermux.service:64`, `Environment=SUPERMUX_DATA_DIR=__DATA_DIR__`) to the
   **service user's real home**, deliberately outside the repo and outside the unit's
   `WorkingDirectory` churn. On this box that is `/home/supermux/.supermux`; on
   `supermux-strato` it is the same shape under that instance's service user. Therefore:
   - **The durable profile lives at `<data_dir>/browser/profile`, mode `0700`** (§2.3 R1) — on
     persistent storage on both instances, with no new mount, no new path to provision.
   - **It survives the in-app updater** for free: the updater replaces `<data_dir>/bin/` and
     writes `<data_dir>/archives/`, and a rollback swaps the binary back. Neither touches
     `<data_dir>/browser/`. The profile is *deliberately not* under the repo checkout or a
     worktree, both of which the updater and `deploy-self.sh` do churn.
   - **Two deploy constraints to honour, or the profile is lost anyway:**
     (a) the unit's read-write path set must include the data dir — it already does, since the
     DB and `connectors/` live there, so no unit change is needed; and (b) `<data_dir>/browser/`
     must be **excluded from any backup/restore or archive-prune sweep** that treats the data
     dir as disposable state — it is a credential store, and §10 R1's "keep the last 3 cookie
     backups" lives here too.
   - **Disk is the one thing to watch:** the root filesystem on this box is at **93% (27 GB
     free)**, and a Chrome profile starts at ~3 MB but grows with cache. Set
     `--disk-cache-size` (~256 MB) in `launch_args` and let the §10 R1 backup keep exactly 3.
3. **Backup restore UX** — v1 specifies "keep the last 3, restore is a documented manual step."
   Is a one-click restore worth v1? Leaning no: an untested restore path is worse than none.
4. **Should `browser_list_tabs` cost a grant at all?** Spec'd as: connector grant only, returns
   an empty list without tab grants. Alternative (stricter, more annoying): require at least
   one tab grant. Owner call.
5. **Per-tab viewport size.** *(R0 partly settles this: the recipe now launches 1366×900, which
   is both a saner login viewport and a less unusual fingerprint than 1024×768.)*
   The workspace wants a bigger `--window-size` than 1024×768, but
   `ScreencastOptions` caps at 512px for the mobile profile (`context.rs`). Does a desktop
   viewer get a second, higher-quality screencast profile, or is 512px enough to log in on?
   Suspect it is not, for dense enterprise SSO pages.
6. **Session restore.** Chrome on a durable profile may resurrect targets on launch.
   §4.2 reconciles and drops orphans; if it turns out `--disable-session-crashed-bubble` /
   `--restore-last-session=false` are needed in `launch_args`, that changes the recipe tests at
   `launch.rs:394`.
7. **`request_human_takeover` on a tab with no attached viewer** — today the ask surfaces
   in-chat and the agent parks (`DEFAULT_PARK` 120s / `MAX_PARK` 600s, `tools.rs:59`). For a
   tab, should it also push a notification? Probably yes, reusing `push.rs`; out of scope here.
