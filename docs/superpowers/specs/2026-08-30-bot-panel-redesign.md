# Bot detail panel — redesign spec

**Status:** final. A builder implements this verbatim.
**Branch:** `integration/botmode-suite` (PR #123), worktree `/opt/projects/supermux-integration`.
**Files touched:** `web/src/components/roster/bot-panel.tsx`, `web/src/components/roster/learned-notes.tsx`, `web/src/lib/api/memory.ts`, `web/src/components/roster/team-panel.tsx`, `web/src/routes/dev-roster.tsx`, `web/tests/unit/bot-panel-settings.test.ts`, `server/src/bot_memory/mod.rs`, `server/src/sessions/connector_config.rs`.
**No migration. No new component files. No new abstraction. No refactor of `Field`/`Group`/`session-info-panel.tsx`.**

---

## 0 · Why this change exists, with the evidence

The owner's complaint — "the panel is full of hollow content" — is correct, and three of the fields are **structurally dead**, not merely empty on this host.

Live census, `GET /api/sessions`, n=36, non-empty count per key (probed against `http://127.0.0.1:8824` while writing this spec):

```
tokens          0/36   ← the key is ABSENT from the union of all 36 row objects
task_summary    0/36        chat_tail       0/36        model      0/36
branch          0/36        mcp             0/36        worktree   0/36
memory          0/36        skills          0/36        rate_limits 0/36
last_send_text 34/36        last_send_at   34/36        preview_lines 36/36
status         36/36        dir            36/36        runtime    36/36
flags          22/36        company_id     13/36        desc        6/36
tags            4/36        activity        2/36
```

* `grep -rn 'pub tokens\|"tokens"' server/src --include=*.rs` → **no match**. `ApiSession.tokens`
  (`web/src/lib/api/sessions.ts:213`) is a client type with **no producer anywhere in the server**.
  The Context ring and the Tokens card can therefore only ever render `—` and `0`. This is not a
  host artefact; it is a field that does not exist.
* `task_summary` is a DB column selected into nothing on the wire; its only producers in the tree
  are `session-tile/mock.ts` and the bench seed.
* `chat_tail` is SSE-delta-only and gated on a live chat tailer, so it is absent on every fresh
  panel open. `session-row.tsx:111-123` already carries an honest comment saying exactly this;
  `OverviewTab` ignored it.
* The header sub-line is `[status, model || provider, branch]` — with `model` and `branch` at 0/36
  it collapses to `"idle · claude"` on every bot, restating the face dot and the Status card.
* `GET /api/sessions/{name}/memory/notes` → **404** on `supermux`, `mena` (a company bot) and
  `Invulboekjes`. `~/.supermux/bot-memory` **does not exist**. Root cause in §4.
* The core-notes counter says `~N / 2000 chars`. The server caps at `CORE_MAX_LINES = 40` **and**
  `CORE_MAX_CHARS = 6_000` (`server/src/sessions/lifecycle.rs:304-305`), whichever bites first —
  and the line budget usually bites first. The counter is wrong on both axes.

Against that, the signals that **are** populated and that the panel renders nowhere:
`last_send_text`/`last_send_at` (34/36), `activity`/`subagents` (live), `error`/`blocked`,
`waiting_message`, `desc`, and two cheap endpoints measured live from this box:

| endpoint | code | time | size |
|---|---|---|---|
| `GET …/recall?chat=true&limit=8` | 200 | 2.2 ms | 5.9 KB |
| `GET /api/agents/delegations?session=` | 200 | <5 ms | 1–3 KB |

The panel is currently **less informative than the roster tile it was opened from**. That is the
actual bug, and it is what this spec fixes.

**Guiding rule for the whole change: a field with no producer is deleted, not em-dashed.**

---

## 1 · Frame — unchanged

Three tabs, same keys: `overview` · `instructions` (label **Setup**) · `workflows`.
`TabKey` / `TABS` / `normalizeTab` are router state, deep-link targets and bench selectors, and are
pinned by `web/tests/unit/bot-panel-settings.test.ts:93-131`. **Do not touch them.**

Both shells are unchanged: `variant="pane"` (full-screen on a phone, keeps
`pt-[max(0.875rem,env(safe-area-inset-top))]`), `variant="sheet"` (`<ResponsiveSheet hideHeader
title={name} className="max-w-2xl">` with the `data-grok` wrapper, body `max-h-[70vh]`).

### 1.1 Header — one change

Replace the sub-line at `bot-panel.tsx:879`
(`[session?.status, model || session?.provider, session?.branch].filter(Boolean).join(' · ')`)
with **the bot's standing job**:

* `session.desc` non-empty → render it, one line, `truncate`, `text-[13px] text-muted-foreground`
  (**drop the `capitalize` class** — `desc` is a sentence, not a status word).
* `desc` empty → a quiet inline button, `min-h-9`, text `Say what this bot does →`, which calls
  `setTab('instructions')`. That is the product's core action for an unconfigured bot, not filler.

Status leaves the header entirely: `SessionFace` already carries the dot, and §2.1 states it in
words. Three renderings of one fact was the complaint.

Everything else in the header is unchanged: face, editable name, `SessionActionsMenu`,
`Open thread` / `Open terminal`.

---

## 2 · Overview tab — final section order

Replace the body of `OverviewTab` (`bot-panel.tsx:419-515`). Keep the file's existing two-region
structure: a live region, a hairline (`border-t border-border pt-5`), then the details you act on.
Single column throughout — `flex flex-col gap-5`. **No grid anywhere in this tab.**

### 2.1 Live state — replaces the whole 4-card `Stat` grid

One wrapping row, always present, no card:

```
<StatusDot/face-coloured dot>  Active · ⚡ npm test · 3 subagents   [⚠ Limit reached] [5h 92%]
<dot>                          Idle · last prompted 12m ago
```

| piece | source | component |
|---|---|---|
| status word | `session.status` (36/36) | plain `capitalize` span |
| live tool line + subagent clause | `session.activity`, `session.subagents` | `<ActivityLine>` — `@/components/session-tile/activity-status` |
| unrecovered agent error (+ inline recovery for `holder_died`) | `session.error` | `<ErrorBadge error={session.error} session={session} />` — same module |
| cannot take a turn | `session.blocked` | `<BlockedBadge blocked={session.blocked} error={session.error} />` — same module |
| usage headroom | `session.rate_limits` | `<UsageChip rateLimits={session.rate_limits} />` — same module |

All four components return `null` on their own when they have nothing to say — **mount them
unguarded**, that is their documented contract. `<BlockedBadge>` already stands down when
`<ErrorBadge>` is saying the same thing (`statesSameBlock`); do not re-implement that.

Idle tail, when `<ActivityLine>` renders nothing:

* `last_send_at` present (34/36) → `Idle · last prompted {formatRecallTime(lastSend.sentAt)}`
* else → `Idle · never prompted`

Use `useLastSend(session)` and `formatRecallTime` from
`@/components/focus-mode/last-send-recall` (exported at `:83` and `:103`).

> **Implementation trap.** `last_send_at` is **epoch seconds as a number**, not an ISO string.
> The file-local `relTime(iso?: string)` helper (`bot-panel.tsx:117`) will silently return `''`
> for it. `useLastSend` already does the `new Date(at * 1000)` conversion — use it.

Say **"last prompted"**, never "last active": `updated_at` is
`max(last_send, last_started, created_at)` (`server/src/sessions/mod.rs:598`) and never arrives on
the SSE delta, so "last active" would be a second small lie in the same row.

**States.** No loading state (the row is already in the sessions cache). No empty state (`status`
is 36/36). No error state.

### 2.2 Needs you — conditional, renders nothing when nothing is asking

Renders **only** when `session.status === 'waiting'` and `session.waiting_message` is non-empty:
one muted row carrying the ask's own sentence, `line-clamp-2`, and nothing else. `Open thread` in
the header is the resolution — **do not build a second answering surface here.**

Do not branch on `permission_request` / `connect_request` / `question_request` / `browser_takeover`.
Those have their own surfaces on the chat plane; adding four more branches for rare states is scope
the panel does not need.

### 2.3 Last exchange — replaces the "Latest" bubble

The old "Latest" read `chat_tail ?? task_summary`. Both are 0/36 on a fresh open, so it was blank
every single time. Two layers, so the section is never empty and never expensive:

**Layer 1 — free, from the session row, renders immediately.**
`You asked` + `session.last_send_text` (34/36, server-clamped to ~200 chars), `line-clamp-3`, with
`formatRecallTime(lastSend.sentAt)` beside the label.

**Layer 2 — one request on Overview mount.**

```ts
useQuery({
  queryKey: ['bot-last-exchange', name],
  queryFn: () => sessionsApi.recall(name, { chat: true, limit: 8 }),
  staleTime: 30_000,
  retry: false,
})
```

`sessionsApi.recall` already exists (`web/src/lib/api/sessions.ts:1012`) and is used today only by
`last-send-recall.tsx`. Measured live: **200, 2.2 ms, 5.9 KB** at `limit=8`.

From `entries` (newest-first), render, in this order:

1. **`It answered`** — the newest entry with `kind === 'assistant'`, `line-clamp-2`.
2. up to **3** entries with `kind === 'tool_use'`, as receipt rows:
   `flex items-baseline gap-2 text-[12.5px]`, label = `condenseReceiptLabel(e.text)`
   (pure, exported from `@/components/chat/grouping:582`), and `e.ok === false` gets the calm
   `text-status-error` treatment. Verified live shapes: `label: "Read"|"Bash"|"Workflow"`,
   `text: "Read /path…" | "Bash cd /opt…"`, `ok: true`.
3. any entry with `kind === 'delegation'` → `↳ from {e.label}` — how inbound work becomes visible.

**Do NOT mount `<ReceiptGroup>`** (`chat/ui/receipt-group.tsx`). It wraps itself in the chat
`<Bubble>` with the chat bubble ceiling, and `bot-panel.tsx`'s header comment commits this file to
Tailwind + shadcn tokens rather than chat/grok-scoped chrome. **Reuse the label function, not the
chat furniture.**

The whole block is one `<button>` → `onOpenThread()`, `min-h-11`, `text-left`. One tap target, not
five 18px ones.

Put the entry selection in a pure exported helper so it is unit-testable without a live panel —
the house idiom (`afterUndo`, `normalizeTab` already live this way in the same file):

```ts
export interface LastExchange { answer?: string; receipts: { label: string; ok: boolean }[]; from?: string }
export function lastExchange(entries: RecallEntry[]): LastExchange
```

**States.**
* **loading** — Layer 1 renders normally; Layer 2's slot is one
  `h-16 animate-pulse rounded-xl border border-border bg-muted/30`
  (the same skeleton idiom as `learned-notes.tsx:102`).
* **empty** — no `last_send_text` **and** no usable entries → one muted line,
  *"No conversation yet — open the thread to start one."* Not a card.
* **error** — Layer 1 stays; Layer 2 collapses to *"Couldn't read this bot's history."*
  Unreachable is not empty. Never a spinner that never resolves.

### 2.4 Handoffs — conditional, renders nothing when both arrays are empty

`agentsApi.delegations(name)` (`web/src/lib/api/agents.ts:102`) — typed since migration 0005 and
**rendered by nothing in the product today**. In a company-of-bots product, *who hands this bot work
and who it hands work to* is the most product-shaped fact the panel can show, and it is already
populated: probed live, `supermux`, `mena` and `Invulboekjes` each returned real incoming edges.

```ts
useQuery({ queryKey: ['bot-handoffs', name], queryFn: () => agentsApi.delegations(name),
           staleTime: 60_000, retry: false })
```

Render up to **3** rows, newest first, merging both directions:
`← {from_session}` / `→ {to_session}`, the `prompt` clamped to one line (`truncate`), and
`formatRecallTime(new Date(edge.ts * 1000))`. Each row is a `min-h-11` button →
`onNavigate(partner)`.

> **Correction to an earlier audit claim.** `DelegationEdge.id` and `.ts` arrive as **JSON
> numbers**, matching the declared types — verified live (`id 86 :: int`, `ts 1788079360 :: int`).
> **No boundary coercion is needed.** Do not add `Number(...)` wrappers.

**States.** Loading and error both render **nothing** — this is a conditional block, and an error
banner about a graph the user did not ask for is noise.

### 2.5 Tags — unchanged

`<TagsEditor name={name} tags={session?.tags ?? []} />` inside
`<Field label="Tags" hint="Searchable across the roster.">`. Below the hairline.

### 2.6 Working directory — unchanged

`<WorkingDirRow name={name} dir={dir} />` inside `<Field label="Working directory">`. Keep
`WorkingDirRow` exported (`<TeamPanel>` imports it). **Do not append `branch`** — `branch` is 0/36;
real branch data already renders in the Workflows tab's `<GitRow>`.

**Resting Overview for a quiet bot is therefore four blocks**: live line, last exchange, tags, path.
No em-dashes, no zeroes, no empty cards.

---

## 3 · Setup tab (`instructions`) — final field list

Keep `SetupTab`'s four `<Group>`s and their order. Changes only:

### Group 1 · Behaviour

1. **What this bot does** — `<RoleField>` **unchanged**. Real write path, genuinely injected via
   `role_system_prompt` (`lifecycle.rs:280`), preset-insert + undo contract already unit-tested.
   It is the best thing in the panel. Do not touch it.

2. **Launch model** — keep `<ModelPicker>` and its PATCH (the write path is real; the server 400s
   on an unknown id). The hollowness is entirely in the framing, so fix the framing:
   * `<Field>` label: **`Launch model`** (was `Model`).
   * hint: **"Passed as `--model` when this bot next starts. It is not a reading of the model a
     running agent is on."**
   * trigger fallback label: **`Provider default`** (was `Default`, which reads as "we don't know").
   * Keep the `options.length === 0` branch verbatim.
   * **No backend work.** A live-model readout is §5.3 and is explicitly not required to make this
     field honest.

3. **Notes this bot keeps** — keep `<NotesEditor>` verbatim. Two fixes:
   * **Delete `CORE_NOTES_CAP = 2000`** (`bot-panel.tsx:393`) and the counter that uses it.
   * Add a pure exported helper mirroring `cap_core_notes`
     (`server/src/sessions/lifecycle.rs:304-345`) — the server truncates on **whichever budget
     bites first**, and the line budget is the one that is invisible today:

     ```ts
     /** Mirrors `cap_core_notes` in server/src/sessions/lifecycle.rs (40 lines / 6000 chars,
      *  whichever bites first) so the editor states the limit the server actually applies. */
     export const CORE_MAX_LINES = 40
     export const CORE_MAX_CHARS = 6_000
     export function coreNotesBudget(notes: string): {
       lines: number; chars: number; overLines: boolean; overChars: boolean
     }
     ```

     Mirror the Rust exactly: `trimEnd()` first; an empty string is **0 lines** (Rust `lines()`
     yields 0, JS `''.split('\n')` yields 1 — guard it); count characters as Unicode scalars with
     `[...s].length`, **not** `.length`, to match Rust's `chars().count()` on emoji.
   * Render `{lines} / 40 lines · {chars} / 6,000 chars · restart to apply`, tabular-nums, and
     switch the exceeded budget's number to the amber `text-status-error` tone, naming which one.
   * Append one sentence to the `<Field>` hint: **"This is also what turns this bot's memory on."**
     True today (it is the reachable half of the gate) and still true after §4.

### Group 2 · Connectors

`<GrantedConnectors name={name} />` — **unchanged**. 36/36 real per-bot grants, ~2 ms. The
strongest section in the panel.

### Group 3 · Memory

`<LearnedNotes name={name} />` — component structure unchanged, three empty states per §4.2.

### Group 4 · Delivery

* `<NotifPolicyControl name={name} value={session?.notif} />` — unchanged (36/36).
* `<LaunchInternals session={session} />` — two changes:
  * **Delete the hardcoded `Skills` / `"Workspace defaults"` row** (`bot-panel.tsx:629-632`). It is
    not data: `skills` is 0/36 and the server field's own doc says *"Nothing consumes it yet"*.
  * Render the **MCP** and **Worktree** rows only when set. **Flags** (22/36) and **Runtime**
    (36/36) stay unconditional. Without this, Advanced prints `None / No / None` three times.

`<RestartHint>` / `<RestartToApply>` — **unchanged**. Honest, and they close the loop.

---

## 4 · Learned notes — **FIX AT THE ROOT AND KEEP**

Not replaced, not dropped. The store, the slug/frontmatter format, the lexical scorer, the recall
hook, the write CLI and the three HTTP routes are all built and correct; `learned-notes.tsx` and its
Rust tests are correct. Exactly one gate is false, and it is false **by construction**.

**The chicken-and-egg, verified end to end:**

`session_has_memory()` (`server/src/bot_memory/mod.rs:63`) is true only when `role_id` is non-empty,
**or** `sessions.memory` is non-empty, **or** an index already exists on disk.

* `role_id` has **no production setter**. Its only writer in the tree is a `#[cfg(test)]` helper
  whose own comment says so (`server/src/sessions/memory.rs:376`). Live: 0/36.
* `memory` (core notes): live 0/36.
* The disk branch is unreachable: the store can only be written by `supermux-memory save`, which
  requires `BOT_MEMORY_DIR`/`BOT_MEMORY_NAME` — env only `apply_memory` exports, which only runs
  when the gate is already true.

So `connector_config.rs:595` never calls `apply_memory` → **no recall hook, no
`Bash(supermux-memory *)` grant, and no SessionStart capability briefing** (`agents/briefing.rs:100`
sits inside the same `if` and is the only place a bot is ever told the CLI exists).
Verified: `~/.supermux/bot-memory` does not exist; `memory/notes` returns 404 on every session
probed, including the company bot `mena`.

The gate asks *"does this session already have memory?"* while both ways to acquire memory are
downstream of it. **A new bot can never enter the tier.** The owner's doubt is well founded.

Keep it because it is the only mechanism in the product that makes a bot better over time, it is
fully built, and the fix is one condition.

### 4.1 · B1 (server, required) — widen the gate to what the product means by "bot"

`server/src/bot_memory/mod.rs`, in `session_has_memory`:

```rust
// A bot is a session with a STANDING JOB — one that belongs to a company, or one
// the owner gave a role. Gating on "already has memory" made the tier
// unreachable: `role_id` has no setter and core notes start empty, so nothing
// could ever bootstrap into it. A plain pane (no company, no role) still returns
// false, so its launch stays byte-identical — the invariant this function was
// written to protect.
let is_bot = s.company_id.is_some() || !s.desc.trim().is_empty();
if has_role || has_core || is_bot {
    return true;
}
```

Both fields exist on `crate::db::sessions::Session` (`company_id: Option<i64>`, `desc: String`) —
verified. Live effect: the 13 company bots plus the 6 role-bearing sessions enter the tier at their
next start.

**Rejected: `provider == "claude"` (32/36).** It hands every plain claude pane a private config dir
and a hook, breaking the documented "a plain session launches byte-identical" invariant
(`bot_memory/mod.rs:57-62`) for panes that are not bots in any product sense. Company-or-role is the
product's own definition of bot-ness, and it gives the owner a **reachable, honest switch** — write
the role in the field the panel already leads with, restart, memory is on.

**Knock-on the PR description must state:** this also turns on the SessionStart capability briefing
for those bots. That is the intended payoff (it is the only thing that ever tells a bot
`supermux-memory save` exists) but it is a real behaviour change.

**Inherent, and the UI must say so:** the config overlay is written at launch
(`connector_config::assemble`), so an already-running bot gains nothing until it restarts.
`<RestartToApply>` is exactly that affordance and §4.2 puts it in the empty state.

Add one `#[cfg(test)]` case beside the gate: a session with `role_id = None`, `memory = ""` and
`company_id = Some(_)` is memory-eligible; the same session with `company_id = None` and
`desc = ""` is not.

**No migration.** `role_id` exists since 0031, `company_id` since 0032.

### 4.2 · F1 (web, required) — stop conflating "not wired" with "nothing written"

`web/src/lib/api/memory.ts` currently swallows the 404 into the same empty state as a real empty
list (`emptyOn404`, `:65`), so `learned-notes.tsx:109` prints *"This bot hasn't written any notes
yet"* — a false statement when the store is disabled. The API already draws the distinction
(404 vs 200 + `[]`); the client is the only place throwing it away.

Client-side only — **no new server field**:

```ts
export interface NotesResponse { notes: LearnedNote[]; bot_count: number; role_count: number
                                 role: string
                                 /** false ⇒ the memory tier is not enabled for this session
                                  *  (the route 404'd), as opposed to enabled-and-empty. */
                                 wired: boolean }
const EMPTY: NotesResponse = { notes: [], bot_count: 0, role_count: 0, role: '', wired: false }
```

`emptyOn404` returns `EMPTY` (so `wired: false`); `listNotes` and `searchNotes` stamp
`wired: true` on their successful responses (two call sites).

`<LearnedNotes>` then renders **three** states instead of two:

| state | condition | copy |
|---|---|---|
| **not wired** | `data && !data.wired` | *"Memory isn't on for this bot yet. Give it a role or a company above, then restart it — after that it writes what it learns here."* plus an inline `<RestartToApply name={name} />` |
| **wired, empty** | `wired && notes.length === 0 && !searching` | today's copy, which is now true |
| **has notes** | otherwise | today's list, unchanged |

The search-empty branch (`No note matches "…"`) is unchanged and takes precedence while searching.
The footer line (`:127-140`) keeps its current wording in the two `wired` branches; in the
**not wired** branch it is omitted (there is nothing to count).

### 4.3 · B2 (server, 2 lines) — neutralise the permission-form risk

`server/src/sessions/connector_config.rs:339` grants `"Bash(supermux-memory *)"` (space form).
Claude Code's documented prefix form is `Bash(cmd:*)`. **I could not verify which form the current
CC build matches** — it needs a live agent to test, which this session had no way to run.

If the space form no longer matches, every `supermux-memory save` in an unattended pane hits a
permission prompt and the note silently never lands — which would make the tier look broken again
immediately after B1 fixes it.

**Push both forms into `permissions.allow`.** A duplicate allow entry is inert, it costs two lines,
and it removes the whole failure class without needing the answer. Extend the assertion at
`connector_config.rs:1647` to require both.

### 4.4 · The role tier — leave dormant, build nothing

`roles/<role_id>/` is a half-feature: no setter, no UI, unreachable. But `<LearnedNotes>` already
handles a role-less bot correctly (`role: ''`, the `role` `<TierChip>` simply never renders) and
says nothing false about it, and the store's union query depends on the tier existing.
**Do not add a role editor. Do not rip the tier out.**

---

## 5 · What is removed, and why

| removed | file / line | why (verified) |
|---|---|---|
| Context ring, `ctxPct`, `ringColor`, `CTX_WINDOW` | `bot-panel.tsx:83-105, 445-465` | `tokens` has no server producer; the key is absent from all 36 live rows. Permanently `—`. `CTX_WINDOW = 200_000` is also wrong for the models in use. |
| Tokens card, `fmtTokens` | `bot-panel.tsx:106-110, 466-474` | same dead field; renders the literal `0 · cumulative` on every bot. |
| Provider card | `bot-panel.tsx:475-483` | 36/36 true and 36/36 uninformative; its `meta` falls through to the hardcoded `"native runtime"` because `model` is 0/36 and `--model` is in `flags` on 0/36. |
| Status card | `bot-panel.tsx:484-492` | third rendering of one fact (face dot + sub-line + card). §2.1 says strictly more in one row. |
| the `Stat` component and its 2×2 grid | `bot-panel.tsx:399-417, 444-493` | no remaining caller in the file. At 390px it was a 2×2 of em-dashes occupying the entire fold. |
| the "Latest" bubble as built | `bot-panel.tsx:429-433, 496-503` | sources are `chat_tail` (0/36 on the list, by construction) and `task_summary` (no server producer). Replaced by §2.3, not deleted from the product. |
| header sub-line `status · model · branch` | `bot-panel.tsx:879, 932-939` | two of three fields are 0/36; collapses to `"idle · claude"`. Replaced by the role (§1.1). |
| `Skills` / `"Workspace defaults"` row | `bot-panel.tsx:629-632` | a hardcoded string standing in for `skills` (0/36, "nothing consumes it yet"). |
| `CORE_NOTES_CAP = 2000` + its counter | `bot-panel.tsx:393, 759-761` | wrong on both axes; replaced by the real 40-line / 6,000-char budget. |
| `describe('the context ring')` | `web/tests/unit/bot-panel-settings.test.ts:195-211` | asserts on source text that no longer exists. **Deleting the ring without deleting this block turns CI red.** |
| `ctxPct` / `fmtTokens` + the dead ring | `web/src/components/roster/team-panel.tsx:71, 545-546` | `<TeamPanel>` keeps its **own copies** and paints the same dead ring. `bot-panel.tsx:176-179` insists the two panels look like one family — fix it in this PR or the lie survives one tap away. |
| `tokens` / `task_summary` in the bench seed | `web/src/routes/dev-roster.tsx:95, 105` (and the roster seeds at `:417-440`) | `MOCK_BOT` seeds fields the shipped panel no longer reads, so the design-review bench would frame a panel nobody ships. Replace with `last_send_text` + `last_send_at` + `activity` so the bench shows the real §2 sections. |

**Explicitly NOT in this pass** (name them in the PR body, do not touch):
`grok-roster.tsx:288`, `session-tile/tile.tsx:686`, `session-row.tsx:148`, `compact-tile.tsx:85`,
`lib/fact-ladder.ts:241`, `routes/overview.tsx:287` all read `session.tokens` behind
`typeof === 'number'` guards, so they render *nothing* today — dead code, not a visible lie.
Deleting `tokens` from `ApiSession` is a separate sweep.

**Also explicitly cut from the redesign** (considered and rejected as filler):
a "Scheduled work" count row on Overview — the Workflows tab is one tap away and already carries
the list; a count row that duplicates a tab label is furniture. And a live-model / real-context
readout — see §6.3; the panel must be honest **without** it.

---

## 6 · Backend changes — the complete, minimal list

1. **B1 — required.** `server/src/bot_memory/mod.rs`, `session_has_memory`: add
   `s.company_id.is_some() || !s.desc.trim().is_empty()` to the OR, keeping the three existing
   branches as a superset. One function, one file, **no migration**, plus one `#[cfg(test)]` case.
   Existing tests at `connector_config.rs:1168/1579/1628/1669` already cover the wired shape.
2. **B2 — recommended, 2 lines.** Also emit `"Bash(supermux-memory:*)"` alongside the existing
   space form (§4.3), and extend the assertion at `connector_config.rs:1647`.
3. **B3 — NOT in this pass.** A true Context % / live model / cost would come from the transcript
   tail: `notify.rs::tail_for_push()` already does the live-store-else-disk-tail with
   `resumable::project_dir_for(&row.dir)` and `TAIL_READ_BYTES`, and `sessions.cc_conversation_id`
   is populated on 25/36. That is a real feature with a real cost. **Do not smuggle it into a panel
   redesign.** Drop the tiles now; add the data later if the owner asks for it.

There is no B4. The Learned-notes honesty fix is client-side only — the API already distinguishes
404 from 200-with-empty.

---

## 7 · Mobile at 390px

Above the fold in **both** variants, in order: face + name, the role sub-line, the live-state line
(with any error/blocked badge), `Open thread`, the three-tab bar. Everything else scrolls. This is
only achievable because the 2×2 stat grid is gone — it consumed the entire fold with em-dashes.

Rules every new block obeys:

* **No `grid-cols-*` anywhere in Overview.** Single column, `flex flex-col gap-5`.
* Every tappable row is `min-h-11` (44px floor). The last-exchange block is **one** tap target, not
  five; the receipt lines inside it are read-only text.
* **No horizontal overflow.** Receipt labels go through `condenseReceiptLabel` (basename /
  command-head) then `truncate`; `last_send_text` uses `line-clamp-3`, the assistant excerpt
  `line-clamp-2`, delegation prompts `truncate`. Never a fixed-height inner scroller.
* The live-state row is `flex flex-wrap items-center gap-x-2 gap-y-1` so badges wrap rather than
  overflow.
* Conditional blocks (Needs you, Handoffs, badges) render **nothing** when empty — a quiet bot's
  Overview is short, not a column of "None".
* Tab bar unchanged: three `flex-1 basis-0` tabs, fits at 320px, pinned by
  `bot-panel-settings.test.ts:164`.
* `<ModelPicker>`'s `<DropdownMenu modal={false}>` **must stay** — a modal Radix menu portalled to
  `<body>` lands under the Vaul drawer's `pointer-events:none` and reads as dead on touch
  (documented at `bot-panel.tsx:241-244`). Any new menu inherits the rule.

---

## 8 · Components reused — nothing new is created

`ResponsiveSheet` · `SessionFace` · `SessionActionsMenu` ·
`ActivityLine` / `ErrorBadge` / `BlockedBadge` / `UsageChip` (`session-tile/activity-status.tsx`) ·
`useLastSend` / `formatRecallTime` (`focus-mode/last-send-recall.tsx`) ·
`condenseReceiptLabel` (`chat/grouping.ts`) · `sessionsApi.recall` · `agentsApi.delegations` ·
`TagsEditor` / `DescEditor` / `GitRow` (`focus-mode/session-info-panel.tsx`) ·
`GrantedConnectors` / `RestartToApply` · `LearnedNotes` · `NotifPolicyControl` ·
`WorkflowsView` / `RecentRuns` / `IssueList` / `IssueSurface` ·
`Field` / `Group` / `WorkingDirRow` / `RoleField` / `ModelPicker` / `NotesEditor` /
`LaunchInternals` (in-file) · `useSession` / `useSessionConfig` / `useCloneSession`.

**Keep exported** (`<TeamPanel>` imports them): `Field`, `InstructionsTab`, `ToolsTab`,
`WorkingDirRow`. `InstructionsTab` gets the **same** Launch-model and core-notes-counter fixes as
§3 so the two panels do not drift — the mirror is pinned by
`bot-panel-settings.test.ts:124-131`.

**New code is exactly three small things**: the `lastExchange(entries)` selector, the
`coreNotesBudget(notes)` helper, and the `wired` flag in `memory.ts`. Each is pure, each gets a bun
test, none crosses a file boundary as an abstraction.

---

## 9 · Tests this change owes

**Web** — `web/tests/unit/bot-panel-settings.test.ts`:
* **delete** `describe('the context ring')` (`:195-211`) — mandatory, see §5.
* `coreNotesBudget`: empty (0 lines / 0 chars, neither over), under both budgets, 41 lines
  (`overLines` true, `overChars` false), one 6,001-char single line (`overChars` true,
  `overLines` false), and an emoji string asserting scalar counting (`[...s].length`).
* `lastExchange`: picks the newest `assistant`; caps receipts at 3; carries `ok: false` through;
  surfaces a `delegation` label; returns an all-empty result for `[]`.
* Keep every existing `TABS` / `normalizeTab` / `insertPreset` / `afterUndo` assertion untouched.

**Web** — a small case next to the memory client asserting a 404 yields `wired: false` and a 200
with `[]` yields `wired: true`.

**Server** — one `#[cfg(test)]` case beside `session_has_memory` (§4.1), and the extended
`permissions.allow` assertion at `connector_config.rs:1647` (§4.3).

**The CI gate — all seven must pass before this is called green:**

```
cd server && OPENSSL_NO_VENDOR=1 OPENSSL_LIB_DIR=/usr/lib/x86_64-linux-gnu cargo check --all-targets
cd server && OPENSSL_NO_VENDOR=1 OPENSSL_LIB_DIR=/usr/lib/x86_64-linux-gnu cargo test
cd web && bunx tsc -b
cd web && bun test tests/unit --timeout 15000
cd web && bun run build && bun run perf:size
cd web && bun run lint:gate
```

Never `cargo build/test --release`; never `cargo fmt`; never edit `server/migrations/*`.

---

## 10 · Acceptance criteria — checkable from screenshots

A reviewer opens the bot panel at 390px width and at desktop width, on **(a)** a company bot,
**(b)** a plain pane with no company and no role, and checks:

**Overview**
1. There is **no** 2×2 card grid, and the strings `—`, `0 · cumulative`, `no tokens yet` and
   `native runtime` appear **nowhere** in the tab.
2. The header sub-line shows the bot's role sentence (bot a), or a `Say what this bot does →`
   button (bot b). It never reads `idle · claude`.
3. The first body row states status in words plus, when the bot is mid-tool, the live activity line
   and any `· N subagents` clause. When idle it reads `Idle · last prompted <time>` — the words
   "last active" appear nowhere.
4. `Last exchange` shows a real quoted prompt and, once the request lands, a real assistant excerpt
   and up to three tool receipts. On a bot that has never been prompted it shows
   *"No conversation yet — open the thread to start one."*, not a blank card.
5. Tapping anywhere in `Last exchange` opens the thread.
6. `Handoffs` appears on a bot with delegation edges and is **absent entirely** on one without —
   no empty card, no zero count.
7. At 390px nothing scrolls horizontally, and above the fold the reviewer can see face, name, role,
   live line and `Open thread`.

**Setup**
8. The model field is labelled `Launch model`, the hint says it is not a reading of the running
   model, and the trigger reads `Provider default` (never bare `Default`) on an unset bot.
9. The core-notes counter reads `N / 40 lines · N / 6,000 chars · restart to apply`. Pasting 41
   lines turns the **lines** number amber; pasting one 6,001-char line turns the **chars** number
   amber. The string `2000` appears nowhere.
10. Advanced contains **no** `Skills` row, and on this host shows only `Flags` and `Runtime` —
    no `None / No / None` column.

**Learned notes** (the owner's headline doubt)
11. **Before** a restart, on any bot, the section says *"Memory isn't on for this bot yet…"* and
    offers a restart button. It never says "hasn't written any notes yet" while the route is 404ing.
12. **After** restarting a company bot with B1 shipped: `GET /api/sessions/{name}/memory/notes`
    returns **200** (not 404), `~/.supermux/bot-memory/` exists, and
    `~/.supermux/session-config/{name}/settings.json` contains a `bot-memory-recall` hook, both
    `Bash(supermux-memory *)` and `Bash(supermux-memory:*)` in `permissions.allow`, and a
    sibling `briefing.md`. The panel then shows the *"hasn't written any notes yet"* copy — which
    is now a true statement.
13. **After** that bot saves a note (`supermux-memory save --type decision --title … --body …`),
    the list renders the note with its type dot and tier chip, and typing in the search box
    re-ranks it.
14. On a plain pane (bot b, no company, no role): `session-config/` gains **no** hook and **no**
    private dir — the byte-identical-launch invariant holds — and the panel honestly says memory
    is off.

**Regression**
15. `<TeamPanel>` shows no Context ring and no Tokens card either.
16. The `/dev/roster` BotPanel bench frames the shipped panel (live line, last exchange), not a
    stat grid fed by mock `tokens`.
17. All seven CI commands in §9 pass.

---

## 11 · What is verified, and what is not

**Verified live from this box while writing this spec:** the 36-row field census in §0; the absence
of any `tokens` producer in `server/src`; the 404 on `memory/notes` for `supermux`, `mena` and
`Invulboekjes`; the absence of `~/.supermux/bot-memory`; the `recall?chat=true&limit=8` timing,
size and entry shapes; the delegations payload **and that its `id`/`ts` are JSON numbers, not
strings**; `CORE_MAX_LINES`/`CORE_MAX_CHARS` in `lifecycle.rs`; the grant string and its assertion;
the existence and signatures of every component and helper named in §8; and that `Session` carries
`company_id` and `desc`.

**Not verified:**
* **B2** — whether the current Claude Code build honours `Bash(supermux-memory *)` or requires
  `Bash(supermux-memory:*)`. Testing it needs a live agent session. This is why §4.3 emits both
  rather than picking one.
* **No code was changed and none of the seven CI commands were run** — this is a spec pass. The
  worktree was clean at `d9976f83` at the start and is clean now.
* Whether an activated bot actually *chooses* to write notes is unmeasured: nothing auto-captures,
  and the SessionStart briefing is the only prompt that tells it the CLI exists. After B1, an empty
  list on a wired bot is honest but still uninformative. If the owner later wants "has it ever
  learned anything", that needs a `last_written` stamp on the notes response — a follow-up, not
  this pass.
