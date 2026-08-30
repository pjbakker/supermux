# README hero video + screenshot production spec

**Status:** final — build to this, no open options.
**Branch:** `hotfix/readme-hero` in the worktree `/opt/projects/supermux-readme`.
**Date:** 2026-08-30.

---

## 0. Outcome

**The hero that is currently in the README is a real product video of the wrong product, and its alt text describes a third thing that does not exist. That is the whole regression, and it cannot be fixed by re-encoding — the film has to be re-shot.**

Verified this session:

- `hero.html` does not draw the UI. It composites four screenshots inside hand-built macOS/iPhone chrome: `shots/focus-mobile.png` (line 131), `shots/overview-hero4.png` (146), `shots/overview-mobile.png` (152, 202), `shots/overview-desktop.png` (196).
- Every one of those PNGs is dated **Jun 26–28**, i.e. pre-Bot-Mode. `docs/hero.gif` was last written by commit `bba7c297`.
- So `docs/hero.gif` (4,277,858 B, 1120×700, 11.00 s) is an honest film of the **v0.5 session-tile** product — no named bots, no company, no chat renderer, no group chat, no connectors, no shared browser.
- `README.md:13` puts `alt="supermux Bot Mode — Run a company of bots: named AI teammates (a developer, a marketer, a sales bot)…"` on top of it. Under `STRATEGY.md` §5 a verified false claim caps the README at **4/10**. The alt text is that false claim.
- Commit `7f9f4ff8` (1 insertion, 10 deletions, README.md only) removed the robot illustration and the `Sign in again` screenshot from the *page*. It did not remove them from *git*: `git ls-files` still lists all 9 files under `docs/screenshots/botmode/`, including `bot-card.png`.

Three further defects `7f9f4ff8` left behind: `width="760"` on a 1120 px asset; the `▶ Click for HD` line gone, so the MP4 is undiscoverable; and `overview-mobile-clean.png` orphaned on disk.

**This spec ships:** a re-shot 7-beat / 18.0 s hero built from Bot-Mode surfaces, 9 interaction-bearing stills wired one-for-one into the sections whose images are currently lying, and the deletion of all 9 stale `botmode/` assets.

### Blocking correction to the original brief

`/dev/*` and `/?mock` are gated on `import.meta.env.DEV` (`web/src/App.tsx:78-80`, `web/src/hooks/use-sessions.ts:245-251`) and tree-shaken out of the production bundle. **The live server on `:8824` cannot serve any capture surface** — its 200s are SPA fallback. Every frame in this spec comes from a **worktree Vite dev server**, which has no `/api` proxy unless `SUPERMUX_E2E_BACKEND` is set (`web/vite.config.ts:274-286`) and is therefore *structurally* incapable of reaching real data. That is a stronger PII guarantee than `/?mock` on the live server, and it is the reason no frame here can leak a client.

---

## 1. Capture rig (contract — deviate and frames will not reproduce)

**Server.** `http://127.0.0.1:5199`, serving `/opt/projects/supermux-readme/web`. The worktree has no `node_modules`; symlink the main checkout's (`/opt/projects/supermux/web/node_modules`) — do not write into the main checkout.

**Playwright.** Import is CJS in the scratchpad, ESM inside `~/supermux-launch-video` (which has its own `playwright`). From the rig directory `import { chromium } from 'playwright'` works; from anywhere else use:

```js
const pw = await import('/opt/projects/folderwijzer/app/backend/node_modules/playwright/index.js');
const chromium = pw.chromium ?? pw.default?.chromium;
```

**Browser.**

```js
executablePath: process.env.HOME + '/.cache/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-linux64/chrome-headless-shell'
chromiumSandbox: false
args: ['--no-sandbox','--no-zygote','--disable-gpu','--disable-dev-shm-usage',
       '--force-color-profile=srgb','--font-render-hinting=none']
env: LD_LIBRARY_PATH="$HOME/.local/chromelibs/extract/usr/lib/x86_64-linux-gnu:$HOME/.local/chromelibs/extract/lib/x86_64-linux-gnu"
```

**`--single-process` is banned.** It works for the single-context hero capture (`capframes.mjs` uses it) but **crashes on the second `newContext()`** — verified: `browserContext.newPage: Target page, context or browser has been closed`. The multi-surface still-capture script must omit it.

**Viewports.** Stills desktop `1440×900` **DPR 2**; stills phone `390×844` **DPR 2**, `isMobile:true, hasTouch:true`. Hero frames `1456×910` **DPR 1** (bytes).

**Init script — every capture, no exceptions:**

```js
await ctx.addInitScript(() => { try {
  localStorage.setItem('supermux-theme', 'dark');
  localStorage.setItem('supermux-first-launch', 'done');
  localStorage.setItem('supermux-ui', JSON.stringify({ state:{ overviewSize:4, botMode:true }, version:1 }));
} catch (e) {} });
```

Then, after load: `await page.addStyleTag({ content: '.pointer-events-none.z-30{display:none!important}' })`.

Both are **verified working**: with them, `/?mock=1` at 1440×900 reports `coach:false, recon:false, signin:false`. The brief's selector `div[aria-live="polite"].z-30` does **not** match the reconnect banner — its root is `web/src/components/status-banner/reconnect-banner.tsx:210-212`, `className="pointer-events-none z-30 flex shrink-0 justify-center"`; `aria-live` is on a different element (`components/onboarding/welcome-banner.tsx:65`).

**Per-frame assertion before any file is written:**

```js
const t = await page.evaluate(() => document.body.innerText);
assert(!t.includes('Sign in'));
assert(!t.includes('Reconnecting'));
assert(!t.includes('Take the tour'));
assert(!t.includes('/dev/'));          // bench caption bars
assert(!t.includes('Sander'));         // the owner's name, see B2
assert(!t.includes('<div id="root">')); // the Vite index.html leak, see B3
```

---

## 2. Blockers — close these before capture, in this order

**B1 · The overview's fixture tail is QA-grade.** `web/src/components/session-tile/mock.ts` lines **208, 220, 236, 248, 264, 275** are `idle-1`, `idle-2`, `long-name-session-with-a-really-long-title`, `errored-agent`, `stopped-agent`, `ghost-session`. Lines 83–197 are already marketing-grade (`codex-app`, `web-app`, `api-server`, `docs-writer`, `cso-review`, `build-runner`, `qa-astro`).

*Default:* rename the six to match the chat bench's cast register — `ledger`, `compass`, `lookout`, `kestrel`, `quill`, `patch` — preserving each row's `status` verbatim (`idle`, `idle`, `idle`, `error`, `stopped`, `error`). This is a `web/src` change on a README branch and **needs the orchestrator's OK**.

*Fallback if that OK is withheld (fully specified, no further decisions):* crop every overview frame so the `DONE TODAY` group is out of frame — desktop to **CSS 1440×500** from the top, phone to **CSS 390×540** from the top. Both crops were measured against the frames in §5 and land in whitespace, not mid-row.

**B2 · The group-chat fixture carries the owner's first name.** `web/src/routes/dev-groupchat.fixture.ts:56` `authorName: 'Sander'`, and again inside a message body at `:76` (`@Sander do you want the fallback capped…`). Cropping cannot remove it — it appears both in the human's row and six lines into the bot's reply.

*Resolution (needs no repo change):* rewrite the text at capture time, immediately before the screenshot:

```js
await page.evaluate(() => {
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode())
    if (n.nodeValue.includes('Sander')) n.nodeValue = n.nodeValue.replaceAll('Sander', 'Sam');
});
```

Renaming a fixture handle is cosmetic, not a claim. The surrounding engineering copy (the `/browser` black band, the ≥512KiB transcript bug) **stays** — it is this repo's own work, it reads as authentic, and it is the reason the frame is credible.

**B3 · `/dev/focus` and `/?mock=1` + `feature-x` leak Vite's own `index.html` into the terminal pane.** Verified by reading the frame: `<title>supermux</title>`, `<div id="root">`, `<script type="module" src="/src/main.tsx">` are legible inside the `Live terminal · unconfirmed` block, and a `Reconnecting…` pill sits in that pane's header (a *different* element from the banner the CSS hides).

*Resolution:* **`/dev/focus` is banned from this spec entirely**, and the overview still selects **`codex-app`**, not `feature-x`. Probed: `feature-x → leak`, `qa-astro → leak`; `codex-app` and `build-runner` are clean. Of the two clean ones `codex-app` is the correct pick — its row reads `needs you · never prompted`, so its pane's `No conversation yet — open the thread to start one.` is *internally consistent*, whereas `build-runner` reads `working` and would contradict its own empty pane. (The §5 crop removes that line anyway.)

**B4 · `?grok=1` destroys the workflows bench.** Row titles and cadence render invisible at both 390 and 1440; the composer variant is worse. `?theme=dark` alone renders perfectly. **Never append `grok=1` to a workflows capture.** This is a real `[data-grok]` skin defect and deserves its own issue — it is not a capture workaround.

**B5 · `/workflows?mock=1` white-screens** (`TypeError: rows.filter is not a function`). Never capture the real route; use `/dev/workflows`.

**B6 · Bench caption bars must not ship.** `/dev/groupchat` paints `/dev/groupchat · 390px · populated · full feed` as a `<header>` (`dev-groupchat.tsx:122-125`); `/dev/workflows` paints `Workflows — dark · running` and `Workflows timeline dark`; `/dev/store` paints `Connector store — light` **and stacks four slabs on one page** (`store-grid-light`, `store-grid-light-grok`, `store-grid-dark`, `store-grid-dark-grok`) — a page screenshot returns the *light* one, which is what the previous pass shipped. Remove or element-clip per §5.

**B7 · The phone overview raises an A2HS bottom sheet.** Verified: `Install supermux on your home screen / Launches full-screen, no browser chrome… / 1 Tap the Share button in Safari's toolbar / 2 Choose Add to Home Screen / [Got it]` covers the lower ~40 % at 390×844. Dismiss it by clicking `text=Got it`, then wait 400 ms, before capturing.

**B8 · The frosted chat header must not sit over body text.** The phone chat header is translucent by design and content scrolls under it. That reads as intentional when an *image or a bubble edge* is beneath it (verified good in the `state=working` frame) and as a rendering bug when *body copy* is beneath it (verified bad in the default `state=permission` frame, where `the run is captured above if you want` is legible through the header). Before each phone-chat screenshot, scroll the message list so the element under the header is a divider, an attachment, or inter-bubble whitespace — never a line of body text. Do **not** scroll to the very bottom: that leaves ~45 % dead black below the composer (verified).

---

## 3. The video

### 3.1 What it must prove

One sentence: *"A company of named Claude Code agents on one screen — they hand work to each other, they keep going when you close the laptop, and your phone buzzes the second one needs you."*

Order is **Value → Differentiator → Flow → Trust**. Beats 3→4→5 are one causal story, not three features: it got stuck → your phone buzzed → you drove it, from anywhere.

### 3.2 Format — settled, not up for relitigation

`<a href="docs/hero.mp4"><img src="docs/hero.gif" width="900"></a>`. A GIF committed at a relative path, embedded as a plain `<img>`.

Never a hand-written `<video src="https://raw.githubusercontent.com/…">` — GitHub's sanitizer strips it (3/3 repos tested render zero `<video>` elements). The only inline player comes from drag-dropping the MP4 into the github.com web editor, which mints a `user-attachments` URL; GitHub then wraps it in a `<details>` **labelled with the uploaded filename**. If that route is ever taken, the file must be named `supermux-demo.mp4`. No WebP/AVIF/APNG for the animated hero.

### 3.3 Storyboard — 7 beats, 18.0 s, loops

`N = 7`, `FADE = 0.055`, `FPS = 12`, `SEC = 18`, 216 frames. Each beat is 2.571 s: **≤0.60 s of entrance motion, then frozen** (§3.5 explains why that word carries the entire byte budget).

Three pieces of the existing rig are load-bearing and must survive verbatim:

- `seek()`'s `+0.5` phase offset (`hero.html:243`) — puts t=0 and t=215/215 both inside beat 0's hold, so the poster is the strongest static frame and the loop seam is invisible.
- `headOp(lp)` (`hero.html:239`) — fades a headline in over local `[.10,.24]` and out over `[.86,.96]`, so **no two headlines are ever legible in one frame**.
- `op(i,s)` / `local(i,s)` wrap with `for k of [-N,0,N]` and `±N/2`, so the seam math generalises to `N=7` with no other edit.

| # | t | Headline (≤6 words) | On screen | Motion (all complete by 0.60 s) | Asset |
|---|---|---|---|---|---|
| **0** | 0.00 — poster **and** last frame | kicker `FREE & OPEN SOURCE · SELF-HOSTED`<br>**"A company of agents. In your pocket."** | iPhone chrome around `bm-chat-phone.png`: header `Release Train` + `Chat ǀ >_` toggle, the `release-run.png` attachment, the cross-bot line *"**Patch** sent over the failing job and **Quill** tightened the notes"*, the user bubble *"ship it once CI is green"*, and the live receipt card `✓ Read money.rs / ✓ Grep parse_locale / ○ cargo test --lib money 46s` | phone rises 24 px (`p0`), headline rises 12 px. **No motion in the first 300 ms.** | new `bm-chat-phone.png` |
| **1** | 0.143 | **"Every bot. One screen."** | `.macwin` around `bm-overview-desktop.png` — `NEEDS YOU 2` (`feature-x · 1 need you · researcher · 5 bots`; `codex-app · needs you · 21k · codex 11% ctx`), `ACTIVE 2` (`build-runner · working · listening on 127.0.0.1:8823`; `qa-astro · working`), company ring in the nav rail — beside `.phone` holding `bm-overview-phone.png`, the same roster | reuse `s1` verbatim: `m1` scale 1.018→1.0 + rise 10 px; `p1` rises 26 px on a 0.22 delay | new `bm-overview-desktop.png`, `bm-overview-phone.png` |
| **2** | 0.286 | **"They hand work to each other."** | phone, group chat `#canary · 5 members`. **A:** the human ask, then `Main Assistant [NUDGED] → @chat-dataplane @render-bug`. **B:** scrolled past the blue `NEW` divider to `chat-dataplane`'s reply | **new slide.** Cross-dissolve `-a.png` → `-b.png` *inside* the phone over local `[.45,.62]`, `easeOut`; the phone itself never moves. Cut on the handoff, not on a scroll | new `bm-groupchat-a.png`, `bm-groupchat-b.png` |
| **3** | 0.429 | **"Pinged the second one needs you."** | iOS lock screen, full chrome (date, clock, flashlight/camera pills, home bar); one frosted banner in the lower third: `supermux · now — Release Train · Patch is waiting on your call.` | reuse the existing `push2` verbatim: opacity 0→1, `translateY(-24px)`, `scale .96→1` over local `[.22,.52]` | **none** — hand-built HTML/CSS at `hero.html:172`. Copy edit only. |
| **4** | 0.571 | **"You take the wheel."** | shared browser, desktop: tab rail (`Pipeline · CRM`, `Analytics`, `Quarterly reselle…`, `Ads Manager`), omnibox `mail.acme.example/inbox`, `Signed in · verified 6 min ago`, the `Watch ǀ Drive` control with **Drive** engaged, and the page reading *"Verify it's you — The agent hit a challenge it can't solve. Take the wheel."* Causally continues beat 3 — same domain. | window pushes in from `scale(0.985)`; the segmented thumb slides `Watch → Drive` at local `.30` | new `bm-browser-drive.png` |
| **5** | 0.714 | **"Close your laptop. It keeps working."** | the beat-1 desktop returns, slides left and desaturates, while the phone lifts forward still colour-true | reuse `s3` verbatim: `m3.translateX(-44k) scale(1-0.10k)`, `filter: brightness(1-0.46k) saturate(1-0.34k)`; `p3.translateY((1-e)*30) scale(1+0.05k)` — the emotional argument is *entirely* in the desaturation asymmetry | reuses beat-1 assets |
| **6** | 0.857 | kicker `FREE · OPEN SOURCE · MIT`<br>**"One Rust binary. One line."** | terminal types `curl -fsSL …/install.sh \| sudo bash` char-by-char, then `✓ service supermux installed & started` / `✓ open http://your-server:8823` stagger in, MIT pill lands last | reuse `s4` verbatim (`hero.html:275-281`). Typing is the **only** beat allowed per-frame motion during its hold — it costs ~110 KB and it earns it | **none** |

**Deliberately excluded:** connectors and workflows. Both are strong, both are legible as *stills* (§5 #5, #7) and neither reads in 2.5 s of silent motion. An eighth beat costs one crossfade (~0.59 MB) and buys less than the still does. The rule for the whole deliverable: **the video carries what needs motion; the stills carry the rest.**

### 3.4 Assets to shoot into `~/supermux-launch-video/shots/`

DPR **1**, dark, all init-script rules from §1.

| file | route | viewport | note |
|---|---|---|---|
| `bm-chat-phone.png` | `/dev/chat-live?mock&bare=1&state=working&grok=1` | 390×844 | ship-clean as read; apply B8 |
| `bm-overview-desktop.png` | `/?mock=1`, click `codex-app` | 1440×900 → crop CSS 1440×500 | B1, B3, B7 |
| `bm-overview-phone.png` | `/?mock=1`, dismiss `Got it` | 390×844 → crop CSS 390×540 | B1, B7 |
| `bm-groupchat-a.png` | `/dev/groupchat?w=390` | 390×844 | B2, B6; scrolled to the `NUDGED` row |
| `bm-groupchat-b.png` | same, scrolled past the `NEW` divider | 390×844 | B2, B6 |
| `bm-browser-drive.png` | `/dev/browser-workspace?desktop=1&theme=dark&drive=1` | 1440×900 → crop per §5 #6 | letterbox + white slab |

Because beat 1's desktop is a 1440×500 crop, `.macwin`'s aspect in `hero.html` must be set to match (2.88:1). That is a rig-side CSS edit, outside the repo.

### 3.5 Byte budget — measured, not estimated

Every number below is a file on disk in `…/scratchpad/budget/` or `…/scratchpad/gtest/`, produced this session by re-encoding the repo's own 132 frames.

| variant | bytes |
|---|---|
| shipped recipe rebuilt, 132 fr @1120/q85 | **4,277,858** — byte-identical to `docs/hero.gif` |
| same frames, width 960 | 3,331,393 (×0.779) |
| same frames, quality 78 | 3,530,214 (×0.825) |
| same frames, `FADE 0.13 → 0.055` | 3,588,792 (×0.839) |
| `FADE .055` + 1000 px / q80 | 2,582,484 (×0.604) |
| **all crossfades stripped, hard cuts only** | **634,588** |
| **120 frames frozen on one image** | **80,755** → 673 B/frame |
| 120 frozen frames + one small element toggling every frame | 421,219 → +2,837 B/frame |

Two rules fall out, and they decide the whole design:

1. **A crossfade costs ~0.73 MB at `FADE .13`, ~0.59 MB at `FADE .055`.** `(4,277,858 − 634,588)/5` and `(3,588,792 − 634,588)/5`. Crossfades *are* the budget.
2. **A frozen frame costs 673 B; an animated one costs ~32 KB.** A 48× ratio. This is why §3.3 mandates that all entrance motion finish inside 0.60 s: it converts ~20 frames per beat from 32 KB to 0.7 KB. Blink micro-elements at **2 Hz, never 6 Hz**, and never more than one on screen.

**Projection for this film** — 7 crossfades, 216 frames, holds frozen, one 2 Hz micro-element on three beats:

```
7 × 590,841  (crossfades)            = 4,135,887
188 held frames × 673                =   126,524
3 beats × 24 frames × ~950 (2 Hz)    =    68,400
                              @1120  ≈ 4.33 MB
                              @1040  ≈ 3.73 MB   (× (1040/1120)² = 0.862)
```

**Encode the GIF at 1040 px, quality 85. Hard gate: ≤ 4.60 MB, measured with `stat`, never projected.** Fallback ladder, in order, stopping at the first pass: `--width 1000 --quality 82`, then `--width 960 --quality 80`. If a build lands over 4.60 MB at 960/q80, a beat is animating during its hold — fix the beat, do not lower quality further.

The 5 MB figure is the camo proxy's cap and binds only for third-party hosts; in-repo `raw.githubusercontent.com` assets are **not** camo-proxied (measured: 0 `camo.` URLs in a rendered README with 4 direct `raw.` URLs). 4.60 MB is a load-time target, not a hosting limit — but hold it anyway.

### 3.6 Build

```bash
cd ~/supermux-launch-video
# 1. drop the 6 new PNGs into shots/
# 2. edit hero.html: N=7, FADE=0.055, new s2, s5 block in seek(), .macwin aspect, swapped <img src>
# 3. edit capframes.mjs: FPS=12, SEC=18; preview loop to i<7, t=i/7

node capframes.mjs preview   # → preview/s0..s6.png — READ ALL SEVEN
node capframes.mjs           # → frames/000..215.png

node_modules/gifski/bin/debian/gifski --fps 12 --width 1040 --quality 85 \
  -o /opt/projects/supermux-readme/docs/hero.gif frames/*.png

node_modules/ffmpeg-static/ffmpeg -y -framerate 12 -i frames/%03d.png \
  -vf "scale=1456:910:flags=lanczos,format=yuv420p" \
  -c:v libx264 -preset slow -crf 20 -movflags +faststart \
  /opt/projects/supermux-readme/docs/hero.mp4
```

`gifski` and `ffmpeg` are **not on PATH**; both work by absolute path from the rig's `node_modules`. `render-hero.mjs` is the Remotion path and **will not launch on this box** — `capframes.mjs` is the proven one.

Because every frame is a pure function of `t`, also emit the mid-transition frames (`t = i/7 ± 0.03`) and confirm no two headlines are legible together. That determinism is what made the original's 9 review rounds possible; use it.

---

## 4. Craft rules the frames must obey

Distilled from the reference pass (23 top READMEs measured) and non-negotiable here:

- **Real UI only.** Of 23 top READMEs, **zero** used a mascot or illustration as primary product proof. No `company-diagram.png` successor.
- **Bake the interaction into the frame.** A selected row with its panel open; a pressed button; an open sheet; a divider mid-flight; a spinner on a named step. Excalidraw ships named multiplayer cursors and selection handles; starship ships a ghost autosuggestion mid-typing; supabase crops to 506×308 around one open dropdown. Interaction is *shown*, never claimed.
- **Crop to the smallest region that carries the action.** A full 1440 px dashboard proves nothing at README scale.
- **Type ≥16 px at source.** At `width="900"` on a ~728 px column — and ~40 % of that on mobile — anything smaller is gone.
- **Bake the background in.** The README renders on white and on near-black; never rely on transparency, and never let a bright white slab meet the page edge (see §5 #6).
- **Alt text describes the capability, not the file** — and must match what is actually on screen. This is the rule the current README breaks.
- **No phone-in-hand, no tilt, no perspective.** immich's composite uses flat phone screenshots with real status bars. Phone-in-hand is a marketing-site device, not a README device.
- **Sound: none.** GitHub force-mutes. Every point lands visually or not at all.

---

## 5. The stills — 9 files, every one carrying a visible interaction

All dark. Desktop `width="900"`, phone `width="260"`. DPR 2, then crop with Playwright `clip` or an element screenshot — never re-encode. Caption = what the user just did, one line, sentence case.

**V** = a frame I read this session. **P** = route verified rendering, exact target frame not yet read.

| # | file | route + state | viewport | the interaction *in the frame* | crop | |
|---|---|---|---|---|---|---|
| 1 | `chat-phone.png` | `/dev/chat-live?mock&bare=1&state=working&grok=1` | 390×844 | receipts mid-run — two `✓`, a **live spinner** on `cargo test --lib money 46s`; the user's `ship it once CI is green` already sent; `Patch`/`Quill` cross-bot mention above it; mic composer | none | **V** |
| 2 | `chat-desktop.png` | `/dev/chat-live?mock&bare=1&state=delegation` | 1440×900 | roster rail of 7 named bots with **`Patch — Typing…`** and an unread dot on `Quill`; the `Message from Patch` divider mid-flight; the live **`●●● asking Patch…`** pill | crop the right ~22 % dead column; scroll so the header does not clip the top receipt (B8) | **V** |
| 3 | `chat-permission-phone.png` | `/dev/chat-live?mock&bare=1&state=permission&surface=phone&theme=dark` | 390×844 | the permission card **`Run cargo publish --dry-run ?` · Bash · in supermux/server**, three options with keyboard digits (`Allow once 1` / `Allow while this session runs 2` / `Not now 3`), the honest footnote *"Answer in the terminal — chat can't answer this one yet."*, and the working row ticking `21s` | scroll per B8 so the `Notification · Nightly release watch` divider sits under the frosted header | **V** |
| 4 | `groupchat-phone.png` | `/dev/groupchat?w=390` | 390×844 | `Main Assistant [NUDGED]` fanning out to `@chat-dataplane @render-bug`, the blue **NEW** divider, `chat-dataplane` already answering below it, and a `[WORKFLOW]` result card (`mobile-rig · 390px sweep — 6 steps · 6 succeeded · 0 failed`) above | remove the bench `<header>` (B6); apply B2 | **V** |
| 5 | `workflow-runs.png` | `/dev/workflows?panel=timeline&state=running&theme=dark` | 1440×1200 | `Running 5:18 PM [on schedule]` with step 1 `✓ 41 s` and step 2 spinning; the red **`Failed · 3 min 34 s [by hand]` — "step 3 stopped: the bot never confirmed"** with per-step timings; a `Done` run below | **element screenshot of `[data-vr="workflows-timeline-dark"]`** — removes both bench captions. Never `?grok=1` (B4) | **V** |
| 6 | `browser-drive.png` | `/dev/browser-workspace?desktop=1&theme=dark&drive=1` | 1440×900 | the `Watch ǀ Drive` segmented control with **Drive** engaged, `Signed in · verified 6 min ago`, viewer count, and the page reading *"Verify it's you — The agent hit a challenge it can't solve. Take the wheel."* | **mandatory.** The workspace occupies only the middle ~66 % (black letterbox both sides) and the inner page is a bright white slab. Crop to the **top ~45 %** — tab rail + omnibox + `Signed in` + the `Verify it's you` headline and its subtitle — so the white terminates on a hard edge *inside* the mac chrome, and trim the right edge where the `Handbook` tab clips | **V** |
| 7 | `connector-store.png` | `/dev/store`, click `Browse` | 1440×1200 | category chips with **All** engaged; `GitHub 21 tools`, `Notion 12 tools`, `Stripe`, each with a live blue **Connect**; second row `PayPal / Plaid / Square` | **element screenshot of `[data-vr="store-grid-dark"]`** — verified to exist and clip clean. A page screenshot returns the *light* slab (B6). Trim the bottom so the third card row is not cut mid-card | **V** |
| 8 | `overview-desktop.png` + `overview-phone.png` | `/?mock=1`, click `codex-app` (desktop) / dismiss `Got it` (phone) | 1440×900 / 390×844 | **desktop:** the selected row highlighted, its panel open on the right — identity, `Say what this bot does →`, **`>_ Open terminal`**, `Overview ǀ Setup ǀ Workflows` tabs, `Needs you · never prompted`, Tags. Attention grouping `NEEDS YOU 2` / `ACTIVE 2` on the left with `working · listening on 127.0.0.1:8823` and ctx rings. **phone:** the same roster, same grouping | desktop → CSS **1440×500** from the top; phone → CSS **390×540** from the top (B1, B3, B7) | **V** |
| 9 | `hire-sheet-phone.png` | `/dev/new-session?theme=dark` | 390×844 | the `Hire a teammate` bottom sheet mid-flow: grab handle, rerollable avatar with *"Tap the avatar to reroll"*, the job sentence typed into the field, suggestion chips, `Advanced` disclosure, `Continue` armed | crop to the sheet — the bench backdrop behind it is flat grey | **P** — `?theme=dark` is a real knob (`dev-new-session.tsx:32`) but only the light render has been read. **Read the dark capture before it ships; if it renders light, drop this still and keep the existing `docs/screenshots/new-session.png`.** |

Nine stills exceeds the reference pass's "4–6 max", and that is deliberate: they are not a strip under the hero, they are **one image per body section**, replacing five images that currently make false claims. No section carries more than the desktop+phone pair. The 4–6 rule governs a hero-adjacent gallery; this is section illustration, which is what `ea0e737e` did and what the sections need.

---

## 6. README wiring

Paths: hero stays at `docs/hero.gif` / `docs/hero.mp4`; stills go to `docs/screenshots/` with the filenames in §5. `docs/screenshots/botmode/` is deleted entirely (§7).

### 6.1 Hero — replace `README.md:8-16`

```html
<p align="center">
  <a href="docs/hero.mp4"><img src="docs/hero.gif" width="900"
     alt="supermux in use: a phone running a live Claude Code session with tool receipts; a desktop overview of every bot with who needs you first; one bot handing work to another in the company chat; a lock-screen push when one needs you; taking the wheel in the shared browser; and the one-line install"></a>
</p>

<p align="center"><sub>▶ <a href="docs/hero.mp4">Click for HD</a> · the loop above autoplays on GitHub</sub></p>
```

Three fixes in that block: `width` **760 → 900** (the asset is 1040–1120 px; 760 threw away the crispness the re-render was for), alt text that describes what frame 1 actually shows, and the restored `▶ Click for HD` line from `ea0e737e:14` without which the MP4 is undiscoverable.

### 6.2 Stills → sections

| section | line (current) | image | alt | caption |
|---|---|---|---|---|
| `### A bot is a teammate with a role` | 58 | `chat-phone.png` @260 + `chat-desktop.png` @900, in that order | "A bot's thread on a phone: tool receipts ticking — Read, Grep, and a cargo test still running at 46 seconds — under a reply the owner just sent" / "The same company on a desktop: a rail of seven named bots, one mid-reply, and one bot's message arriving inside another's thread" | *"Every tool call, as it happens."* / *"Seven bots, one rail — and they can talk to each other."* |
| `### Companies` | 62 | `groupchat-phone.png` @260 — **replaces `companies.png` and `company-diagram.png`** | "A company's group chat: the owner asks once, the Main Assistant routes the ask to two named bots, and the first one is already answering below the unread divider" | *"You ask once. The router picks who does it."* |
| `### Connectors` | 80 | `connector-store.png` @900 — **replaces `connectors.png`** | "The connector store: GitHub with 21 tools, Notion with 12, Stripe, PayPal, Plaid and Square, each with its own Connect button, filtered by category" | *"A store of tools, granted per bot — not per box."* |
| `### Workflows` | 91 | `workflow-runs.png` @900 — **replaces `workflows.png`** | "A workflow's run history: today's run in progress with per-step timings, and yesterday's run failed at step three with the reason written out" | *"Give a bot a job and a time. It tells you what happened — including the failures."* |
| `### A shared company browser` | 102 | `browser-drive.png` @900 — **replaces `shared-browser.png`** | "The shared browser with the Drive control engaged: the agent's tab hit a sign-in challenge it can't solve and is asking the owner to take over" | *"When it's stuck, take the wheel — then hand it back."* |
| `### See every agent, jump anywhere` | 165 | `overview-desktop.png` @900 then `overview-phone.png` @260 — **replaces `overview-desktop.png` at line 149** and un-orphans the `ea0e737e:56-60` pairing | "The overview with a bot selected: its panel open on the right, and the roster on the left grouped by who needs you first, who's active, and what's done" / "The same control room on a phone, same grouping" | *"Every bot, ranked by who needs you."* / *"The same control room, in your pocket."* |
| `### Edit prompts in a real textarea` | 189 | `native-input.png` — **unchanged**, but re-verify alt vs. image | — | — |
| new-session sheet | 172 | `hire-sheet-phone.png` @260 if the dark capture reads clean; otherwise keep `new-session.png` | "The hire-a-teammate sheet on a phone: a rerollable avatar, the job written in one sentence, and an Advanced disclosure for engine, model and folder" | *"Hiring a bot is one sentence."* |

Markup pattern for every still (verified to survive GitHub's sanitizer — `width` and `align` are kept, and the image is auto-wrapped in a link to the full asset):

```html
<p align="center">
  <a href="docs/screenshots/NAME.png"><img src="docs/screenshots/NAME.png" alt="…" width="900"></a>
</p>
<p align="center"><sub><em>Caption.</em></sub></p>
```

Desktop + phone pairs go in a two-column markdown table (also verified to survive the sanitizer).

---

## 7. Delete from git

`git rm` — unlinking from the README was not removal; all nine are still tracked.

| file | bytes | why |
|---|---|---|
| `docs/screenshots/botmode/bot-card.png` | 129,227 | a full-screen *"Sign in again. Your session expired."* modal — **and** the dimmed page behind it is a **real** session (`Feat/Grok-Mode`, 96k tokens). Broken *and* non-mock. |
| `docs/screenshots/botmode/hero.png` | 1,681,076 | the robot illustration. Orphaned. |
| `docs/screenshots/botmode/hero.gif` | 1,752,466 | same, animated. Orphaned. |
| `docs/screenshots/botmode/hero.mp4` | 248,479 | same. Orphaned. |
| `docs/screenshots/botmode/company-diagram.png` | 1,650,363 | AI-generated smiley circles; its alt claims a connectors rail, a shared browser and a company chat that are not in the image. |
| `docs/screenshots/botmode/companies.png` | 394,651 | a portrait group chat rendered at width 860 (→ ~2200 px tall), alt-described as a roster with a switcher ring. Contains the owner's name. Superseded by still #4. |
| `docs/screenshots/botmode/connectors.png` | 341,327 | superseded by still #7. |
| `docs/screenshots/botmode/workflows.png` | 238,111 | desktop composer alt-described as a mobile step rail, rendered at width 420 where its body text is unreadable. Superseded by still #5. |
| `docs/screenshots/botmode/shared-browser.png` | 518,383 | superseded by still #6. |

**`git rm -r docs/screenshots/botmode/`** — 6,954,083 B, on a `docs/` tree currently at 33 MB.

---

## 8. Acceptance criteria

A reviewer checks each of these **by reading the PNG or the GIF**, not by reading the markdown.

### The hero

1. `stat docs/hero.gif` ≤ **4,600,000 bytes**. Measured, not projected.
2. `ffprobe docs/hero.gif` → 18.0 s ± 0.1, width 1040 (or 1000 / 960 if the ladder was walked), 12 fps.
3. `ffprobe docs/hero.mp4` → 1456×910, 18.0 s, `yuv420p`, ≤ 3 MB.
4. All seven `preview/s0..s6.png` read. Each shows exactly **one** legible headline, ≤ 6 words.
5. Mid-transition frames at `t = i/7 ± 0.03` read: **no frame shows two legible headlines.**
6. Frame 0 and frame 215 are visually identical (the `+0.5` offset held) — the loop does not snap.
7. **Frame 0 alone answers: what is this, and who is it for.** A reader who sees only that frame knows it is a control room for many Claude Code agents, running on their own box, driven from a phone.
8. No frame contains: `Sign in`, `Reconnecting`, `Take the tour`, `/dev/`, `Sander`, `<div id="root">`, a bench caption bar, or an error toast presented as normal.
9. **Every beat shows Bot-Mode UI.** Zero frames composed from the June `shots/` set. This is the criterion the current hero fails.
10. The README's hero `alt` text is checked line-by-line against frame 0 and the six preview stills. **Every noun in the alt exists in a frame.**

### The stills

11. All nine read at 100 %. Each shows the interaction named in its §5 row — a selected row, a pressed control, an open sheet, a divider mid-flight, or a spinner on a named step. **A still with no visible interaction is rejected.**
12. Same forbidden-string list as (8), per still.
13. No bench caption bar in any frame (`/dev/groupchat · …`, `Workflows — dark · running`, `Workflows timeline dark`, `Connector store — light`).
14. #6 `browser-drive.png`: the white page region does **not** touch the frame edge on any side.
15. #7 `connector-store.png`: dark slab, not light; no card row cut mid-card at the bottom edge.
16. #8 desktop: the `DONE TODAY` group is out of frame, or its rows carry the renamed cast — never `idle-1`, `idle-2`, `long-name-session-with-a-really-long-title`, `errored-agent`, `stopped-agent`, `ghost-session`.
17. Any empty state visible in a frame is **consistent with the row that produced it** (a `never prompted` bot may show `No conversation yet`; a `working` bot may not).
18. Every still's `alt` names only things present in that image, and every caption states the *consequence*, not the pixels.
19. Source type ≥ 16 px in every still, checked at the README's rendered width.

### The tree

20. `git ls-files docs/screenshots/botmode/` returns **nothing**.
21. `git ls-files | xargs -I{} stat -c '%s {}'` shows no image over 2 MB except `docs/hero.gif`.
22. No `<video>` tag anywhere in `README.md`.
23. `README.md` contains the string `▶` and `Click for HD`.
24. The hero `<img>` carries `width="900"`.

### Ship gate

25. Re-fetch the rendered README through `api.github.com/repos/sanderbz/supermux/readme` with `Accept: application/vnd.github.html+json` and confirm **each asset appears in the rendered HTML**. Local markdown proves nothing.
26. Eyes on the hero at: github.com logged-out, iOS Safari, the GitHub mobile app, and an IDE/npm preview — light **and** dark.
27. `STRATEGY.md` §5 rubric: a render failure anywhere caps the score at 5; **any verified false claim caps it at 4.** Criteria 10 and 18 exist to close that gate, because it is the one the current README fails.

---

## 9. Branch note

`git log` on `hotfix/readme-hero` shows `b5335b0e Merge pull request #126`, i.e. **this branch is already merged into its base.** Confirm with the orchestrator whether the work lands as new commits here or on a fresh branch cut from that point, before the first commit.

## 10. Provenance

Every factual claim above was checked against a tool result this session: `git ls-files` and `git log` for the tracked assets and `hero.gif`'s provenance; `grep` on `hero.html` for the four composited `shots/`; `ls -la` for their June dates; `ffprobe` for both hero assets' geometry; `stat` for every byte figure; a Playwright probe for the `codex-app` panel opening, the `feature-x` Vite leak, the A2HS sheet, the coach-mark/reconnect suppression, and the `[data-vr="store-grid-dark"]` clip; and direct reads of eleven PNGs — `readme-probe-chat-live-phone`, `-chat-delegation`, `-chat-permission`, `-groupchat-phone390`, `-browser-drive`, `-wf-timeline-plain`, `-store-browse`, `-overview-mock-desktop`, plus `spec/ov-desktop-clicked`, `spec/ov-row-feature-x`, `spec/gc-phone-noheader`, `spec/store-dark-el`, `spec/ov-phone` and `spec/chat-perm-scrolled`.

Probe scripts, reusable: `/home/supermux/supermux-launch-video/probe-spec.mjs`, `probe-spec2.mjs`.
