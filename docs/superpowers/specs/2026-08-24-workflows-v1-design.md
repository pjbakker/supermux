# Workflows v1 — design spec (replaces Schedules)

**Status:** draft for owner review · **Author:** staff eng + product design pass · **Date:** 2026-08-24
**Repo verified against:** `/opt/projects/supermux` @ `main` (d6b73cb). Every claim below was checked
against the real files; file/line references are load-bearing, not illustrative.

---

## 0. TL;DR for the owner

- A **Workflow** = a bot + an ordered list of **steps** + a **trigger** + a **completion action**.
  Each step is a prompt (plus file chips + connector hints). "If done → next step" rides on the
  status→idle / agent-confirm machinery `scheduler/watch.rs` already has, and which already works.
- New tables `workflows` / `workflow_steps` / `workflow_runs` / `workflow_step_runs` /
  `workflow_run_keys` in **one new migration (0038)**. `schedules` is **ported and dropped in the
  same transaction**, with every pre-drop row archived as JSON in `workflows_import_log`.
- The dragon dies: **no shell jobs, no boot jobs, no `bypass_permissions`, no `done_action:
  command:<text>`, no `done_pattern` regex, no `kind` toggle at all.** One delivery mode:
  a prompt to a bot.
- New top-level nav item **Workflows**, immediately after **Connectors**.
- BotPanel's `Activity` tab becomes **Workflows** (per-bot list + run history; Issues + Git stay).
- v1 is a **linear chain only**. No branching, no parallelism, no DAG. Named as a non-goal below.

---

## 1. Summary, goals, non-goals

### 1.1 What is wrong today (verified)

`web/src/components/scheduler/schedule-form.tsx` presents a three-way **kind toggle**:
*Prompt session* / *Boot session* / *Shell job*. Behind it, `server/src/scheduler/runner.rs`:

- `execute_shell` runs `/bin/bash -c <command>` with a 600 s cap — arbitrary host execution from a form field.
- `execute_boot` spawns a whole new session, optionally a git worktree, optionally with
  `--permission-mode bypassPermissions` (migration `0021`), and hard-codes `company_id: None`
  (`runner.rs`, `sessions::CreateInput`) — so a boot job in company mode silently produces a
  **main-bot session outside every company scope**.
- `watch.rs::fire_done` supports `done_action = "command:<text>"`, which sends arbitrary text into
  the session. `mod.rs::valid_done_action` accepts anything starting `command:`.
- Completion is configured through *three* different, overlapping controls: `watch`,
  `watch_timeout`, `done_pattern` (a regex), `confirm_finish`, and `done_action`.

That is the dragon. Every one of those is a v1 removal.

### 1.2 Goals

1. **One mental model.** "A workflow is a list of prompts my bot runs in order." Nothing else.
2. **10× simpler authoring.** A step is a prompt box; files are chips; connectors are chips;
   "when it's done" is a sentence, not a form.
3. **Bot/company native.** A workflow belongs to a bot, and (in company mode) to that bot's company,
   with the same scope guarantees `sessions` already enforces (`server/src/scope.rs`).
4. **Zero breakage on upgrade.** Every live `kind='tmux'` schedule keeps firing on the same cadence,
   at the same `next_run`, with its run history and its missed-tick idempotency intact.
5. **Keep every trigger we have.** cron / every-N / natural language / one-shot / run-now — the
   parser is reused *unchanged*; only the UI over it is new.
6. **Preserve the agent self-scheduling hook's guarantees** (`scheduler/hook.rs`) byte-for-byte,
   including the curl footer already sitting in live panes.

### 1.3 Non-goals (v1) — say no loudly

- ❌ **Conditional branching / if-else.** A step has exactly one successor.
- ❌ **Parallel steps / fan-out / DAGs.** One step in flight per workflow, ever.
- ❌ **Multi-bot workflows.** All steps run in one bot's pane. (Cross-bot handoff is available as a
  *completion action*, not as a step type.)
- ❌ **Loops / retries / error branches.** A failed or timed-out step **halts** the chain, loudly.
- ❌ **Variables / templating between steps.** The bot's own thread *is* the shared state — that is
  the whole reason "a workflow is just prompts" works. No `${step1.output}` syntax.
- ❌ **Server-side connector execution.** (See §5.3 — the server has no MCP client. Verified.)
- ❌ Workflow templates as a server resource. v1 ships three client-side starter templates only.

These are a plausible v2. They are not in this document beyond this list.

---

## 2. Data model

### 2.1 What exists today (verified)

`server/migrations/0003_schedules.sql` — `schedules` (id TEXT PK, `session TEXT NOT NULL DEFAULT ''`
**with no FK and no index**, `kind`, `boot_*`, `sched_type`, `recurrence`, `run_at`, `next_run`,
`last_run`, `enabled`, `run_count`, `schedule_expr`, `watch`, `watch_timeout`, `done_pattern`,
`done_action`, `created`, `updated`, `deleted`), plus `schedule_run_keys` (idempotency tuple) and
`schedule_runs` (per-fire ledger, pruned to 20 per schedule by
`db::schedules::RUN_HISTORY_KEEP`). Later: `0014` adds `prompt`, `0020` `confirm_finish`,
`0021` `bypass_permissions`.

Three CHECK constraints live in 0003 and **cannot be edited** — sqlx checksums every migration and a
`VersionMismatch` bricks deployed installs:

```sql
CHECK (kind IN ('tmux','shell','boot'))
CHECK (sched_type IN ('once','recurring'))
CHECK (done_action IN ('disable','notify') OR done_action LIKE 'command:%')
```

There is **no `company_id`** anywhere on `schedules`.

### 2.2 New schema — `server/migrations/0038_workflows.sql`

> One migration. It creates the new tables, ports the old rows, archives everything it does not port,
> and drops the old tables — all inside the single implicit transaction sqlx runs a migration in.

```sql
-- 0038_workflows.sql
-- Workflows replace schedules. A workflow is a bot + an ORDERED list of prompt
-- steps + a trigger + a typed completion action. The three dragon surfaces of
-- 0003 (kind='shell', kind='boot', done_action LIKE 'command:%') do not exist
-- here and cannot be expressed: the CHECKs below are exhaustive enumerations.
--
-- IMMUTABLE ONCE SHIPPED (sqlx checksums migrations).

CREATE TABLE workflows (
    id            TEXT PRIMARY KEY,                 -- 'WF-xxxxxxxx'; ported rows KEEP their 'SCHED-…' id (see §7)
    title         TEXT    NOT NULL,
    session       TEXT    NOT NULL,                 -- the owning bot (slug). Unkeyed by CHOICE — see §2.4
    company_id    INTEGER,                          -- DERIVED cache of sessions.company_id; NULL = main bot
    enabled       INTEGER NOT NULL DEFAULT 1,
    -- trigger
    trigger_kind  TEXT    NOT NULL DEFAULT 'manual',-- 'manual'|'once'|'recurring'
    schedule_expr TEXT,                             -- NULL iff trigger_kind='manual'
    next_run      TEXT,                             -- RFC3339, as today
    last_run      TEXT,
    run_count     INTEGER NOT NULL DEFAULT 0,
    -- completion
    on_complete   TEXT    NOT NULL DEFAULT '{"kind":"none"}',  -- typed JSON, §5.3
    -- bookkeeping
    created       INTEGER NOT NULL,
    updated       INTEGER NOT NULL,
    deleted       INTEGER,
    CHECK (trigger_kind IN ('manual','once','recurring')),
    CHECK (trigger_kind = 'manual' OR schedule_expr IS NOT NULL)
);
CREATE INDEX idx_workflows_due     ON workflows(deleted, enabled, next_run);
CREATE INDEX idx_workflows_session ON workflows(session) WHERE deleted IS NULL;
CREATE INDEX idx_workflows_company ON workflows(company_id) WHERE company_id IS NOT NULL;

CREATE TABLE workflow_steps (
    id           TEXT    PRIMARY KEY,               -- 'WS-xxxxxxxx' — stable across edits (see §2.3)
    workflow_id  TEXT    NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    position     INTEGER NOT NULL,                  -- 0-based, contiguous; rewritten atomically on save
    title        TEXT    NOT NULL DEFAULT '',       -- optional human label; falls back to prompt head
    command      TEXT    NOT NULL DEFAULT '',       -- the bare slash line, delivered as its OWN submission (§0.3 contract)
    prompt       TEXT    NOT NULL DEFAULT '',       -- the free-text prompt (wrapped)
    files        TEXT    NOT NULL DEFAULT '[]',     -- JSON [{path,name,size,mime}] — absolute paths under <data_dir>/uploads
    connectors   TEXT    NOT NULL DEFAULT '[]',     -- JSON ["gmail","github"] — connector ids the bot MUST prefer
    timeout_secs INTEGER NOT NULL DEFAULT 1800,     -- per-step done deadline (DEFAULT_WATCH_TIMEOUT today)
    on_complete  TEXT    NOT NULL DEFAULT '{"kind":"none"}',   -- optional per-step action, same vocabulary
    created      INTEGER NOT NULL,
    updated      INTEGER NOT NULL,
    CHECK (length(trim(command)) > 0 OR length(trim(prompt)) > 0)
);
CREATE UNIQUE INDEX idx_workflow_steps_pos ON workflow_steps(workflow_id, position);

CREATE TABLE workflow_runs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    workflow_id  TEXT    NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    started_at   INTEGER NOT NULL,
    finished_at  INTEGER,
    trigger      TEXT    NOT NULL,                  -- 'tick'|'manual'|'agent'
    status       TEXT    NOT NULL DEFAULT 'running',
    current_step INTEGER NOT NULL DEFAULT 0,        -- position of the in-flight step
    note         TEXT    NOT NULL DEFAULT '',
    heartbeat    INTEGER NOT NULL,                  -- bumped on every advance; the reaper reads it (§3.6)
    CHECK (status IN ('running','ok','error','skipped','timeout','interrupted','cancelled')),
    CHECK (trigger IN ('tick','manual','agent'))
);
CREATE INDEX idx_workflow_runs_wid ON workflow_runs(workflow_id, started_at DESC);
CREATE INDEX idx_workflow_runs_live ON workflow_runs(status, heartbeat) WHERE status = 'running';

CREATE TABLE workflow_step_runs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id      INTEGER NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
    step_id     TEXT    NOT NULL,                   -- NOT an FK: a step may be deleted after it ran; history must survive
    position    INTEGER NOT NULL,
    started_at  INTEGER NOT NULL,
    finished_at INTEGER,
    status      TEXT    NOT NULL DEFAULT 'running',
    signal      TEXT    NOT NULL DEFAULT '',        -- 'status-idle'|'agent-confirmed'|'timeout'|'send-error'|'skipped'
    preview     TEXT    NOT NULL DEFAULT '',        -- the DELIVERED prompt as the user sees it (never wrapper/footer)
    note        TEXT    NOT NULL DEFAULT '',
    CHECK (status IN ('running','ok','error','skipped','timeout','interrupted'))
);
CREATE INDEX idx_workflow_step_runs_rid ON workflow_step_runs(run_id, position);

CREATE TABLE workflow_run_keys (
    workflow_id      TEXT    NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    scheduled_for_ts INTEGER NOT NULL,
    fired_at         INTEGER NOT NULL,
    PRIMARY KEY (workflow_id, scheduled_for_ts)
);

-- Nothing is destroyed. Every schedules row is archived as JSON before the drop.
CREATE TABLE workflows_import_log (
    old_id   TEXT PRIMARY KEY,
    ported   INTEGER NOT NULL,      -- 1 = became a workflow, 0 = refused
    reason   TEXT    NOT NULL,      -- '' when ported; else 'shell job removed' / 'boot job removed' / …
    row_json TEXT    NOT NULL,      -- the complete pre-drop row
    at       INTEGER NOT NULL
);

-- … port statements (§7) …
-- … then: DROP TABLE schedule_runs; DROP TABLE schedule_run_keys; DROP TABLE schedules;
```

### 2.3 Decision: steps as ORDERED ROWS, not a JSON column

Recommendation: **rows.** Reasons, in order of weight:

1. `workflow_step_runs.step_id` needs a durable identity. With a JSON blob, "step 2" is a position,
   and inserting a step above it silently rewrites every historical run's meaning. Run history is
   the feature the owner explicitly asked for; it must not lie.
2. "Which workflows may use connector X" is a real query the connector store will want when the
   owner revokes a grant. Over rows it is a `LIKE '%"gmail"%'` on a narrow table; over a blob it is
   a scan of every workflow's whole body.
3. Per-step PATCH (rename, retime, toggle) is a one-row write; a blob forces read-modify-write with
   a lost-update window between two open composer tabs.

The cost — writing the ordered list is not a single `UPDATE` — is paid once, in
`PUT /api/workflows/{id}/steps`, which replaces the whole list inside one transaction
(`DELETE`d steps keep their `workflow_step_runs` history because `step_id` is deliberately **not**
an FK).

### 2.4 `workflows.session` stays an unkeyed TEXT — deliberately, with the cascade written down

`schedules.session` being an unkeyed `TEXT` is a real hazard and it has already bitten this codebase
twice (`db::schedules::soft_delete_for_session`'s doc-comment is a post-mortem; `db::sessions::rename`
carries an explicit `UPDATE schedules SET session = ?` line *because* deferred-FK does not reach it).

We keep `TEXT` — a FK to `sessions(name)` would make session rename/delete ordering worse, not
better, and every sibling child table (`issues`, `tracked_files`, `steering_queue`, `share_tokens`)
is already name-keyed the same way. What we **add** is a partial index and, non-negotiably, the four
cascade edits below in the same commit:

| Cascade | Where | Required change |
|---|---|---|
| **Rename** | `db/sessions.rs::rename` (~line 542) | Replace `UPDATE schedules …` with `UPDATE workflows SET session = ? WHERE session = ?`. The comment explaining *why* it is manual stays. |
| **Delete** | `db/schedules.rs::soft_delete_for_session` → `db/workflows.rs::soft_delete_for_session` | Same soft-delete semantics (hard delete would take the run ledger with it). Both removal paths call it, as today. |
| **Duplicate** | `db/schedules.rs::copy_for_session` → `db/workflows.rs::copy_for_session` | Must now copy **steps too** (new ids, positions preserved), still **DISABLED**, still with `next_run`/`last_run`/`run_count` reset. Today's function copies zero children; a workflow whose steps did not come along would be the exact bug that function's doc-comment was written to prevent. |
| **Archive** | `runner.rs` archive guard → `engine.rs` | Archiving *pauses*; unarchiving resumes; nothing on the row is mutated. A mid-chain archive **halts the run** with `status='skipped'`, note "session archived mid-workflow", and never starts the session. |

### 2.5 `company_id` is derived, never user-set

- Stamped at create from `sessions.company_id` (`db::sessions::get(session).company_id`), and
  **re-derived on every write** to the row. The client may not send it; a sent value is ignored, the
  same rule `sessions::create` applies to `CreateInput.company_id` (`sessions/mod.rs` ~1144: *"the
  create path forces … so `PATCH …/config` cannot reassign it"*).
- Purpose is two-fold: (a) scope filtering without a join in the hot list query, (b) stamping SSE
  frames via `SseEvent::for_company` — the routing attribute in `state.rs` that makes a frame
  reachable by a scoped member. Today every scheduler SSE frame is `company_id: None`, i.e.
  **owner-only**, so a company member never sees their own bot's schedule fire. Workflows fix that.
- Company delete: `0032`'s `trg_company_delete_sessions` NULLs `sessions.company_id`. 0038 adds the
  sibling trigger so the cache cannot go stale:

```sql
CREATE TRIGGER trg_company_delete_workflows
AFTER DELETE ON companies BEGIN
    UPDATE workflows SET company_id = NULL WHERE company_id = OLD.id;
END;
```

### 2.6 The boot-session `company_id: None` hazard is deleted, not fixed

`runner.rs::execute_boot` builds a `sessions::CreateInput` with a hard-coded `company_id: None`. In
company mode that means a scheduled boot silently manufactures a bot **outside every company**, in a
directory of the schedule author's choosing, optionally in bypass-permissions mode.

v1 has **no boot step type**. The hazard is removed by deletion rather than by patching the field.
If "start a fresh agent on a schedule" comes back as a v2 ask, it comes back as a *typed* step with
company inheritance and no bypass flag — and it gets its own gate.

### 2.7 Cascades / call-sites to re-audit (checklist for the implementer)

- `db/sessions.rs::rename` — the manual `UPDATE schedules` line (verified present).
- `sessions` delete + archive paths that call `soft_delete_for_session` (see
  `server/tests/delete_disposition.rs`, `archive_recover.rs`, `archive_removes.rs`).
- `sessions::duplicate` → `copy_for_session`.
- `scope.rs::member_may_reach` — the member allowlist must learn `/api/workflows*`; without it a
  company member gets a blanket 403 on their own bot's workflows.
- `scope.rs::authorize_connector_target` — reused by the connector-hint picker and by the
  `connector_send` completion action.
- `sse.rs` scoped stream + `web/src/hooks/use-sse.ts` — new `workflows` event type.
- `push.rs` / `db/push.rs::NotifCategory::{ScheduleError, ScheduleFinished}` — keep the enum
  variants (they are persisted user toggles) and relabel the UI strings only. **Do not rename the
  DB values**; a renamed category silently un-mutes a user who muted it.
- `sessions/recall.rs` — reads `<supermux-schedule>` back out of transcripts (§3.4).
- `agents/supermux-schedule.md` skill + the `supermux-schedule` Skill entry — retarget prose, keep
  the endpoint working (§5.4).
- `web/src/App.tsx` — `/scheduler` currently `Navigate`s to `/settings#schedules`.
- `web/src/components/command-palette/command-palette.tsx` — add the Workflows entry.

---

## 3. Execution engine

### 3.1 The one insight

`scheduler/watch.rs` already solves "the agent finished". It subscribes to the per-session status
`watch::Sender` the `StatusDetector` publishes and fires on an **idle transition whose version is
newer than the baseline captured at send time** — the same primitive `agents::wait` uses. It is
described in that file as "the apex signal; the 100× fix", and it needs **no configured pattern**.

A linear chain is therefore not a new engine. It is that signal, in a loop:

```
send step k  →  await (idle-edge | agent-confirm | timeout)  →  record  →  k+1
```

### 3.2 Tick

`server/src/workflows/mod.rs::spawn` — a 10 s `tokio::time::interval` with
`MissedTickBehavior::Skip`, identical to `scheduler::spawn` (Skip is load-bearing: `Burst` fires
every missed tick at once after a laptop sleep). Constants carried over verbatim:

| Constant | Value | Why it survives |
|---|---|---|
| `TICK_INTERVAL` | 10 s | unchanged |
| `MISSED_WINDOW` | 60 s | past-due beyond this = missed window |
| `ONESHOT_GRACE` | 6 h | a one-shot created while the server was down still fires late |
| `DEFAULT_STEP_TIMEOUT` | 1800 s | today's `DEFAULT_WATCH_TIMEOUT` |
| `RUN_HISTORY_KEEP` | 20 | prune-on-insert, now keyed by `workflow_id` |

Per due workflow, in order:

1. Parse `next_run`; skip if future.
2. **One run at a time.** If a `workflow_runs` row for this workflow is `status='running'`, record a
   `skipped` run ("previous run still in flight"), advance `next_run`, do **not** dispatch. This is
   new and mandatory: chains can outlive their cadence, and two interleaved chains in one pane would
   be indistinguishable garbage in the transcript.
3. Missed-window / one-shot-grace logic: copied from `scheduler::tick_once` unchanged, including the
   `claim_run_key`-first ordering (claiming before the skip is what distinguishes genuine downtime
   from an in-flight long job) and the SSE `alerts` frame — now company-stamped.
4. `claim_run_key(workflow_id, scheduled_for_ts)` → dispatch `engine::start(state, wf, Trigger::Tick)`.
5. **Reaper** (§3.6) runs on the same tick.

### 3.3 A run

`engine::start` opens a `workflow_runs` row (`status='running'`, `current_step=0`) and calls
`advance(run)`.

`advance` for step *k*:

1. **Guards.** `db::sessions::exists_active(session)` — archived → `skipped` with the readable note
   the archive contract requires (`"…is archived — its workflows are paused until you unarchive it"`);
   gone → `skipped`, and the whole run ends `skipped`. This is exactly `execute_tmux`'s existing
   guard, and it is the reason the runner does not push a phone notification every tick for a deleted
   session.
2. **Build the delivery.** `engine::deliveries(step, wf, run)` — a pure, unit-tested function, the
   direct descendant of `runner::deliveries`:
   - `command` (trimmed, non-empty) → its own bare submission. **Unchanged §0.3 contract**: wrapping
     a slash line stops Claude executing it as a slash command.
   - `prompt` → the free-text line.
   - **File chips** → appended to the prompt line as the existing attachment sentence:
     `"/abs/path/a.pdf" "/abs/path/b.png" ` — byte-identical to
     `web/src/components/chat/composer-insert.ts::attachmentSentence` (quoted absolute paths, one
     trailing space). Built **server-side at fire time** from `step.files`, so a stale client cannot
     smuggle a different shape.
   - **Connector hints** → one server-generated sentence, from typed ids only:
     `Use these connectors for this step: gmail, github. You may use others if needed.`
     Ids are validated against `connectors` at save time *and* re-checked at fire time; an id that no
     longer resolves is dropped from the sentence and noted on the step run.
   - **Completion footer** → **always appended to the last line**, for every step. Today
     `confirm_finish` is opt-in (migration `0020`); in a chain the done-edge is load-bearing, so it
     is unconditional. The footer is `runner::confirm_footer` retargeted at
     `/api/hook/workflow/step-done` with `{"session":…, "run_id":…}`. Idle detection remains the
     fallback exactly as documented.
   - **Wrap** the prompt line (never the command line) — see §3.4.
   - **Preview** (`last_send_text`, user-visible via `last-send-recall.tsx`, matched by
     `receiptClaims`) is the plain line: never the wrapper, never the footer, never the attachment
     sentence. This rule is already asserted by `runner.rs`'s own tests; port those tests.
3. **Send** via `sessions::lifecycle::send_harness_text(state, session, sent, Some(&preview), None)`
   — the same auto-wake, archive-refusing entry point. A send error → step run `error`, run `error`,
   chain halts, `ScheduleError` push.
4. **Arm the watcher.** `engine::watch_step(run_id, step, baseline)`:
   - Subscribe to `state.status_watch_for(session)` **before** the send, capture
     `baseline_version = rx.borrow().1`. (Capturing after the send is a race that fires on the
     session's *pre-existing* idle. The current watch.rs comment explains this precisely; keep it.)
   - `tokio::select!` on `rx.changed()` vs a `timeout_secs` sleep.
   - `status == "idle" && version != baseline` → **done**.
   - `waiting` is explicitly **not** done — a session blocked on the user is the opposite of finished.
     (Product note: `waiting` mid-chain surfaces in the UI as an amber "needs you" node, and the
     step's timeout keeps running. It does not advance.)
   - Sender dropped (session deleted mid-watch) → run `interrupted`.
   - No `done_pattern` polling, no `capture-pane` shell-out, no `tail_anchor`/`delta`. Deleted.
5. **Fire guard.** Per-`run_id` (not per-workflow) `HashSet` claim, so the idle edge and the agent
   hook cannot both advance the chain. Same fail-open-on-poisoned-lock rule as `watch.rs::claim_fire`:
   a missed dedup is a duplicate ping, never a lost one — but here it must be `run_id`-scoped, since
   a recurring workflow's next run must be able to fire again.
6. **Record + advance.** Close the `workflow_step_runs` row (`ok`, `signal`), bump
   `workflow_runs.heartbeat`, fire the step's own `on_complete` if set, then either `advance(k+1)` or
   finish the run.
7. **Finish.** `workflow_runs.status='ok'`, `finished_at`, then the workflow's `on_complete` (§5.3),
   then cadence: `Trigger::Tick` → `record_fire` (recompute `next_run`; NULL disables a finished
   one-shot, exactly as `db::schedules::record_fire` does today); `Trigger::Manual` → `record_manual`
   (never touches `next_run` — the tick still owns cadence).

### 3.4 The transcript wrapper — keep `<supermux-schedule>` in v1

`runner::wrap_schedule` writes `<supermux-schedule id="…" title="…">` and `sessions/recall.rs` reads
it back to classify and render the turn; `runner.rs` carries five tests on escaping and defanging,
and `web/tests/unit/chat-wrapper-parity.test.ts` mirrors the contract on the client.

**Decision: do not rename the tag in v1.** The reader, the renderer, the recall classifier, the
defang table (`SCHEDULE_TAG` + `DELEGATION_TAG`) and every historical transcript line all agree on
the current string. Renaming it is a cosmetic change with a rendering-regression blast radius across
transcripts that already exist on disk.

The step identity rides in the `title` attribute, which is already XML-escaped by `escape_attr`:

```
<supermux-schedule id="WF-3f9a21c7" title="Weekly report · step 2/4 — Draft the summary">
```

Renaming the tag to `<supermux-workflow>` (with the reader accepting both) is a tracked v1.1 item,
not a v1 blocker. Logged as an open question.

### 3.5 Triggers → engine

| UI | `trigger_kind` | `schedule_expr` | Engine |
|---|---|---|---|
| **Run when I say** | `manual` | NULL | `next_run` NULL; only `POST …/run` starts it |
| **Once** (datetime) | `once` | `at 2026-09-01T09:00` | tick fires once, `record_fire(None)` disables |
| **Repeating** | `recurring` | `0 9 * * 1-5`, `every 30m`, `every weekday at 9am` | `parser::parse` + `recurrence.next_after` |
| **Run now** | any | — | `Trigger::Manual`: no fire-key, no cadence advance, 202 |

`scheduler/parser.rs` moves to `workflows/parser.rs` **unchanged** (cron, every-N, natural language,
`SHELL_TIMEOUT` const deleted), with its tests. `preview_runs` and `POST /api/workflows/preview` are
verbatim ports — the next-5-runs preview is one of the few genuinely good bits of today's UI.

`synth_expr` (the legacy `recurrence`+`run_at` → cron synthesizer) is used **only** by the port in
0038 and then deleted from the live code path; workflows always carry a canonical `schedule_expr`.

### 3.6 Crash resilience — the reaper (new; today's watchers vanish silently)

Watchers are in-memory tokio tasks. Today, a restart mid-watch loses the watcher and the schedule's
`done_action` simply never fires — silently. In a chain that failure mode is worse: the run sits at
`running` forever and the workflow never fires again (§3.2 rule 2 would block it).

`engine::reap(state)` runs on every tick and once at boot:

```sql
SELECT * FROM workflow_runs
 WHERE status = 'running'
   AND heartbeat < :now - (step_timeout_of_current_step + 60)
```

→ `status='interrupted'`, close the open step run, SSE + a single `ScheduleError`-category push
("'<title>' was interrupted at step 2 of 4"). Honest, visible, and self-healing on the next cadence.

---

## 4. Removals — exactly what disappears

### 4.1 Server

| File | Delete |
|---|---|
| `scheduler/runner.rs` | `execute_shell`, `execute_boot`, `worktree_is_dirty`, `boot_session_name`, the `kind` match in `execute`, the `Schedule.kind/boot_*` plumbing |
| `scheduler/mod.rs` | `kind` validation, `boot_*` inputs, `bypass_permissions` input + clamp, `valid_done_action`'s `starts_with("command:")` arm and both 400 message strings, `synth_expr` (moves into the migration), `test_fire`'s boot refusal (moot) |
| `scheduler/watch.rs` | `matches()` (regex tier), `delta()`, `tail_anchor()`, the `need_capture` / `peek` pre-capture path, and the entire `action.strip_prefix("command:")` branch of `fire_done` |
| `scheduler/hook.rs` | Preserved wholesale as `workflows/hook.rs` — see §5.4. Its refusal list gets *shorter* only because the refused fields no longer exist. |
| `db/schedules.rs` | Replaced by `db/workflows.rs`. `insert_run`'s prune-on-insert, `claim_run_key`, `record_fire`, `record_manual`, `advance_next`, `soft_delete_for_session`, `copy_for_session` all carry over (retyped). |
| `sessions/mod.rs` | **No change** — `CreateInput.bypass_permissions` stays (the create panel and the Shift+Tab toggle use it). Only the *scheduler's* call site goes. |

Migration columns `bypass_permissions` (0021), `boot_dir`/`boot_provider`/`boot_worktree`,
`done_pattern`, `confirm_finish` (0020), `kind`, `recurrence`, `run_at`, `watch` all cease to exist
because the table they live on is dropped. **No existing migration file is edited.**

### 4.2 CHECK-constraint implications

The three 0003 CHECKs cannot be changed. They can only be made **unreachable**, which requires the
table to go. Recommendation (see §7 for the mechanics and §10 for the risk):

> **Port then `DROP TABLE schedules` in 0038.** Keeping a table whose CHECK still admits
> `kind='shell'` and `done_action LIKE 'command:%'` means the removal is a UI removal, not a real
> one — a restored backup, a future writer, or a hand-run `sqlite3` re-arms the dragon. The
> `workflows_import_log` preserves every pre-drop row as JSON, so nothing is destroyed; and every
> writer of that table is deleted in the same commit, so there is nothing left to serve.

The new tables' CHECKs are exhaustive enumerations with **no `LIKE` escape hatch anywhere** —
that single `OR done_action LIKE 'command:%'` clause is how the dragon got in.

### 4.3 Web

| Path | Disposition |
|---|---|
| `components/scheduler/schedule-form.tsx` | **DELETE** (874 lines — the kind toggle lives here) |
| `components/scheduler/schedule-editor.tsx`, `schedule-detail-sheet.tsx` | **DELETE** (superseded by the composer route) |
| `components/scheduler/helpers.ts` | **SALVAGE** → `components/workflows/cadence.ts`. `describeSchedule`, `exprToRecurrence`, `recurrenceToExpr`, `FREQUENCY_CHIPS`, `WEEKDAYS`, `formatFull` are good and tested. Drop `KIND_LABEL`, `PROVIDERS`. |
| `components/scheduler/prompt-field.tsx` | **SALVAGE** → `components/workflows/step-prompt.tsx`. The fused textarea + inline slash autocomplete is the best thing in the current UI. Retarget to `GET /api/workflows/commands`. Keep `splitCommandAndPrompt`/`mergeCommandAndPrompt` — they are what preserve the §0.3 two-line delivery. |
| `components/scheduler/enable-toggle.tsx` | **SALVAGE**, retyped to `WorkflowRow`. |
| `components/scheduler/fire-log.tsx` | **DELETE** → replaced by `run-timeline.tsx` (a flat fire log cannot express a chain). |
| `components/settings/schedules-section.tsx` (+ `.helpers`) | **DELETE**. Settings keeps a single row: *Workflows → /workflows*. |
| `components/session-schedules/*` | **DELETE** → the BotPanel Workflows tab is the per-bot answer. `schedule-href.ts` → `workflow-href.ts`. |
| `components/focus-mode/session-info-panel.tsx::SchedulesList` | → `WorkflowsList` (same shape, new source). |
| `lib/api/scheduler.ts` | → `lib/api/workflows.ts`. Delete the dead "stub domain types" block at its head while we're there. |
| `hooks/use-scheduler.ts` | → `hooks/use-workflows.ts` (same SSE-invalidation pattern). |
| `App.tsx` | `/scheduler` and `/settings#schedules` → `Navigate to="/workflows"`. |

---

## 5. API surface

### 5.1 New — `/api/workflows` (bearer, merged into `http::protected_router`)

```
GET    /api/workflows                  ?session=&company_id=&include_disabled=   → [WorkflowRow] (steps inlined)
POST   /api/workflows                  create (title, session, trigger, steps[], on_complete)  → 201
GET    /api/workflows/{id}             → WorkflowRow + steps + last run summary
PATCH  /api/workflows/{id}             title | enabled | trigger | on_complete   (never session, never company_id)
PUT    /api/workflows/{id}/steps       replace the ordered list atomically       → steps[]
DELETE /api/workflows/{id}             soft delete
POST   /api/workflows/{id}/run         run now → 202 { run_id }
POST   /api/workflows/{id}/cancel      cancel the in-flight run → 202            (NEW — chains need a stop button)
GET    /api/workflows/{id}/runs        ?limit=20 → [Run + step rows]
GET    /api/workflows/runs             cross-workflow activity feed (limit 50)
POST   /api/workflows/preview          { expression } → { next_runs: [rfc3339 × 5] }   (verbatim port)
GET    /api/workflows/commands         ?cwd= → installed skills / commands / MCP  (verbatim port)
```

Envelope `{ok, data}` unchanged. Static segments registered alongside `{id}` (axum prioritises
static), exactly as `scheduler::router_for` does today.

**Scope:** every handler resolves `Scope::of(ctx)` and filters/404s on `scope.sees(workflow.company_id)`
— a member asking for another company's workflow gets a **uniform 404**, matching
`sessions/mod.rs`'s rule (a member must not be able to prove a row exists). `scope.rs::member_may_reach`
gains the `/api/workflows` prefix.

**Validation on write** (one funnel, `workflows::create`, called by the HTTP handler *and* the hook,
so there is one validator and two callers — today's shape):
- `reject_wrapper_markup` over `title`, every step's `title`/`prompt`/`command`. Same rule, same
  reason: a prompt that closes its own `<supermux-schedule>` wrapper can forge a
  `<supermux-delegation from="…">` at top level. Non-negotiable.
- `on_complete` parsed into a typed Rust enum; unknown `kind` → 400. No free-text field exists.
- step `files[].path` must canonicalise under `<data_dir>/uploads/` — a step may not reference an
  arbitrary host path. (New guard; today's schedules have no file concept, so this is not a regression
  but it *is* the obvious hole to close before it exists.)
- `connectors[]` ids must exist and be granted to `session` at save time (warn, don't hard-fail, if a
  grant disappears later — the chip renders "not connected" in the UI).
- Max **20 steps** per workflow, max **20 workflows** per session (`MAX_WORKFLOWS_PER_SESSION`,
  today's `MAX_SCHEDULES_PER_SESSION`).

### 5.2 Old `/api/schedules` — read-shim + `410 Gone` on writes

The PWA can be wedged on a stale bundle (this has happened here — the index.html/SW navigateFallback
incident). So:

- `GET /api/schedules` and `GET /api/schedules/{id}` and `GET /api/schedules/{id}/runs` →
  **kept for one minor release**, serving a *derived, read-only* projection of workflows in the old
  `Schedule` JSON shape (`kind` always `"tmux"`, `done_action` mapped back, `command`/`prompt` from
  step 0). A stale client renders a correct, if simplified, list instead of crashing.
- Every write verb (`POST /api/schedules`, `PATCH`, `DELETE`, `/run`, `/preview`, `/commands`) →
  **`410 Gone`** with `{ok:false, error:"Schedules were replaced by Workflows — reload supermux to continue."}`.
  Not a redirect: a 307/308 on POST re-plays a mutating body against a different contract.
  The web client's error path recognises 410 and triggers the service-worker update prompt.
- Both are deleted in the release after.

### 5.3 Completion actions — the curated replacement for `command:`

**Finding (verified):** the server has **no generic MCP client**. `connectors/` contains MCP
*servers* (`connect_server.rs`, `imap_mail_server.py`, `icloud_mail_server.py`, `browser/mcp.rs`);
`imap_connector.rs` only emits SMTP host/port as *env vars for the agent's MCP child*. There is no
`call_tool` path in Rust. Therefore **the server cannot send anything through a connector itself.**

The honest design — and the one that is genuinely *not* `command:` — is a **typed action the server
renders into a server-authored instruction**, executed by the bot that already holds the grant:

```rust
enum CompletionAction {
    None,
    Notify,                                                    // push to the owner (existing categories)
    Disable,                                                   // "run once, then pause"
    ConnectorSend { connector_id: String, account_ref: String,
                    to: String, subject: Option<String> },     // typed fields ONLY
    MessageBot   { session: String },                          // same-company teammate
}
```

- `Notify` / `Disable` — direct ports of today's `done_action`.
- `MessageBot` — server-side `agents::delegate::deliver_delegation`, scope-checked
  (same company, `scope.sees`). No text field: the message body is the server-generated run summary.
- `ConnectorSend` — appended as a **synthetic final step** whose prompt is built by the server from
  the typed fields:

  > `Use the <Gmail> connector (account sander@acme.com) to send the summary of this workflow run to
  > sander@example.com with subject "Weekly report". Do not include anything else.`

  Guardrails that make this categorically different from `command:<text>`:
  1. Every substituted value is a **typed field**, validated (connector id exists; `account_ref`
     belongs to it; `to` matches the connector's target shape), never operator free text.
  2. The grant is checked at save time **and** re-checked at fire time via
     `scope::authorize_connector_target`. A revoked grant → run `error` + push, never a silent skip.
  3. The instruction is defanged and wrapped like any other step body.
  4. **Refused outright on the agent hook path** (§5.4) — a session token must not be able to arm
     something that emails the world.
  5. There is no code path from any UI field to `send_text` with arbitrary content. That is the
     property `command:` violated.

Per-step `on_complete` supports the same vocabulary (in practice `Notify` and `ConnectorSend`);
the workflow-level one is the common case and the one the UI leads with.

### 5.4 The agent self-scheduling hook — preserved, including live footers

`scheduler/hook.rs` is the narrowest endpoint in the codebase and it is guarded by
`server/tests/schedule_hook_create.rs`, a negatives-first auth matrix. Every guarantee carries over
verbatim to `workflows/hook.rs`:

- Scope is **structural, not checked**: the row's `session` **is** the authenticated one; a payload
  `session` is used to authenticate and then discarded, so there is no check for a refactor to drop.
- Constant-time hook-token compare against `session_runtime.hook_token`; a bearer token cannot drive it.
- `LenientJson` (content-type agnostic) — the documented `curl -d` default is
  `x-www-form-urlencoded`, and `axum::Json` answers that with a bare 415 the agent cannot read.
- Refused with a *sentence*, never silently dropped: `kind`, `command`, `boot_*`,
  `bypass_permissions`, `_test_fire` — most of which no longer exist, and the refusals stay so an
  old payload gets a legible answer rather than a surprise.
- `on_complete` limited to `none` | `notify` | `disable`. **`connector_send` and `message_bot` are
  400 on this path.**
- Cap: `MAX_WORKFLOWS_PER_SESSION = 20`, answered `429` with actionable text.
- No natural-language parsing server-side — the agent brings a concrete `schedule_expr` from the
  grammar the skill teaches, validated by the same `parser::parse` the bearer path uses.
- v1 allows an agent to create a workflow with **up to 5 steps** (a follow-up chain is exactly what
  "schedule my own work" wants); the single-prompt form stays the default.

**Live-footer compatibility (hard requirement).** Confirm footers already delivered into running
panes contain the literal `"$SUPERMUX_URL/api/hook/schedule/done"` with a `schedule_id`. Both legacy
routes therefore stay registered **permanently** as thin aliases:

```
POST /api/hook/schedule/done    → resolves schedule_id as a workflow id (ported rows keep their id) → step-done
POST /api/hook/schedule/create  → workflow create with steps:[{prompt}]
```

This is why ported workflows **keep their `SCHED-…` id** (§7). A keep-list test asserts both routes
stay registered, in the `board-removal-keeplist.test.ts` idiom.

### 5.5 SSE

New event type `workflows` (list/step deltas) alongside the existing `alerts` frames, which change
`source:"scheduler"` → `source:"workflow"` and gain `run_id` + `step`. **Every frame is stamped**
via `SseEvent::for_company(…, wf.company_id)` — today's scheduler frames are all `company_id: None`
(owner-only). `web/src/hooks/use-sse.ts` + `use-workflows.ts` invalidate on both.

---

## 6. Web UI/UX

Design bar: grok-native, mobile-first, no surface that overflows at 390 px, `ResponsiveSheet` for
every modal (the `sheet-inventory.test.ts` ratchet forbids new raw-Vaul sites), motion from
`lib/springs.ts` only — never `transition: all` — and `useReducedMotion` honoured everywhere.

### 6.1 Nav

`web/src/components/layout.tsx`, the `NAV` array, immediately **after** the `/store` entry:

```ts
{ to: '/store',     label: 'Connectors', icon: Plug,     grokOnly: true },
{ to: '/workflows', label: 'Workflows',  icon: Workflow, grokOnly: true },   // ← new
```

`grokOnly: true` mirrors the Connectors precedent (base app byte-identical; still reachable there via
the command palette and Settings). Both nav surfaces — desktop `SideNav` and mobile `BottomNav` —
honour the flag already.

⚠️ **Layout task:** under grok the phone tab bar goes 4 → 5 cells. `--nav-n`, `data-tab-count` and
the sliding-pill geometry in `grok-mode.css` are cell-count-driven; verify the "Liquid Rail" pill at
390 px and 320 px before merge.

Route (lazy, mirroring `/store`):

```
/workflows                → WorkflowsView variant="page"   (list)
/workflows/new            → WorkflowComposer (create)
/workflows/:id            → WorkflowDetail (steps read-only + Runs)
/workflows/:id/edit       → WorkflowComposer (edit)
```

### 6.2 List — `WorkflowsView`

Renders in two scopes from one component: `variant="page"` (all workflows the viewer can see) and
`scope={sessionName}` (inside BotPanel). Same pattern `StoreView` already uses with `grantTarget`.

```
┌─────────────────────────────────────────────┐
│  Workflows                            [ + ] │
│  ┌───┐┌────────┐┌────────┐┌───────────────┐ │  ← scrollable filter chips
│  │All││ Active ││ Paused ││ ● Acme Corp   │ │
│  └───┘└────────┘└────────┘└───────────────┘ │
├─────────────────────────────────────────────┤
│ ⬤ scout   Weekly client report        [ ●─] │  ← bot face · title · EnableToggle
│   ●───●───○───○   4 steps                   │  ← the STEP RAIL (signature element)
│   every Mon 09:00 · next in 2d · ran ok     │
├─────────────────────────────────────────────┤
│ ⬤ inbox   Morning triage              [ ●─] │
│   ●───●   2 steps                           │
│   every weekday 08:00 · running · step 2/2  │  ← live
└─────────────────────────────────────────────┘
```

- **Step rail** — one dot per step on the spine under the title. Idle: all hollow. Running: filled
  left-to-right, the current dot pulsing. Done: all filled. Error: the failing dot turns red and the
  rail stops there. It is the whole "where is this thing" answer without opening anything, and it is
  what makes a workflow feel alive instead of feeling like a cron row. `aria-hidden`; an sr-only
  `aria-live="polite"` line says *"step 2 of 4: Draft the summary"*.
- Hint line reuses `scheduleHintParts` / `formatFull` from the salvaged cadence helpers.
- Row `…` / long-press → **Run now · Duplicate · Pause · Delete** (delete behind `ArmedButton`;
  copy must say *"Past runs stay in the log"*, which is the promise the soft delete actually keeps).
- **Empty state:** three tappable starter templates, client-side seeds, no server table:
  1. *Daily standup digest* — 2 steps.
  2. *Weekly report → email it* — 3 steps, completion action pre-filled with `ConnectorSend`.
  3. *Inbox triage* — 2 steps, connector hint pre-filled with the bot's mail connector if granted.
  Tapping one opens the composer pre-populated. This is the single highest-leverage onboarding move:
  nobody's first workflow should start at a blank textarea.

### 6.3 Create / Edit — the **Workflow Composer** (route, not a sheet)

**Decision: a full-height route (`/workflows/new`), not a `ResponsiveSheet`.** A chain with N steps,
file chips and a keyboard-heavy textarea is a document. Bottom sheets fight the iOS keyboard (this
codebase has the scars — the mode-9 visualViewport work), and a primary action that scrolls out of a
sheet is one users cannot find (the reason `schedule-editor.tsx` pinned its footer). Sheets are used
*inside* the composer for the pickers, where they are right.

```
┌─ ← Workflows ─────────────────── Save ─┐
│  ⬤ scout ▾   Weekly client report      │  ← bot picker + inline-editable title
│                                        │
│  ┌ Runs ─────────────────────────────┐ │
│  │ [When I say] [ Once ] [Repeating●]│ │  ← segmented trigger
│  │ every Monday at 09:00             │ │  ← live English render
│  │ next: Mon 1 Sep, 09:00 · +4 more ↓│ │  ← debounced /preview
│  │                        or type it →│ │  ← reveals the raw expression field
│  └───────────────────────────────────┘ │
│                                        │
│   ①━━ Pull this week's numbers    ⋮⋮   │  ← collapsed step: ordinal · preview · chips
│   ┃    📎 2   🔌 gmail                 │
│   ┃                                    │
│   ②━━ ┌───────────────────────────┐    │  ← EXPANDED step
│   ┃   │ Draft the summary…        │    │     the salvaged PromptField (slash autocomplete)
│   ┃   │                        /  │    │
│   ┃   └───────────────────────────┘    │
│   ┃   Files                            │
│   ┃   [📄 brief.pdf ×][🖼 chart.png ×] │  ← clickable chips → /api/uploads/…
│   ┃   [ + Attach files ]               │
│   ┃   Paths are pasted into the prompt │
│   ┃   when this step runs.             │  ← honest micro-copy
│   ┃   Must use                         │
│   ┃   [🔌 gmail ×] [ + ]               │
│   ┃   The bot is told to use these.    │
│   ┃   It may still choose others.      │
│   ┃   ▸ Advanced  (timeout · action)   │
│   ┃                                    │
│   ┼─ + ─────────────────────────────   │  ← hairline insert-between
│   ③━━ Email it to the client      ⋮⋮   │
│                                        │
│   [ + Add step ]                       │
│                                        │
│  When the whole workflow finishes:     │
│  [ Send with a connector ▾ ]           │
│   via [Gmail · sander@acme.com ▾]      │
│   to  [client@example.com        ]     │
│   → When done, scout will use Gmail    │  ← the preview sentence
│     to send the run summary to …       │
├────────────────────────────────────────┤
│  Step 3 has no prompt                  │  ← live validity line
│  [ Run now ]              [  Save  ]   │  ← pinned, pb-safe
└────────────────────────────────────────┘
```

Component-by-component:

- **Bot picker** — existing `SessionPicker` / `SessionPickerOption`, company-jailed to what
  `scope.sees` allows. In company mode the option rows carry the existing `CompanyMark` hue.
- **Trigger** — three segmented chips. *Repeating* reveals the salvaged recurrence composer
  (`FREQUENCY_CHIPS`, `WEEKDAYS`, time field) with `describeSchedule`'s live English render and the
  debounced next-5 preview. *"or type it →"* reveals the raw `schedule_expr` input, so the natural-
  language and cron grammars lose nothing — they just stop being the first thing a beginner meets.
- **Step card, collapsed** → ordinal in a circle on the spine, one-line prompt preview, chips
  (`📎 2`, `🔌 gmail`). Tap expands in place (spring on height+opacity; never `transition: all`).
- **Step card, expanded**, in this fixed order: *Prompt → Files → Must use → ▸ Advanced*.
  The order matters: prompt is always needed, files sometimes, connectors rarely, advanced almost
  never. Advanced holds `timeout_secs` as three chips (**30 min / 2 h / 8 h**) and the optional
  per-step action. No timeout *number* input — nobody wants to type 1800.
- **Files** — drop / pick / paste → `uploadForPrompt` (`POST /api/upload`, 20 MB) → an
  `AttachmentChip` per file with thumbnail for images, × to remove, tap to open
  `/api/uploads/{filename}`. Reuse `use-staged-attachments.ts`'s engine wholesale — it already keeps
  the 5 MB image guard, the parallel upload, the calm error toast and the leak-free object-URL
  revoke in one place. Save is blocked while any upload is in flight, with the reason shown.
- **Must use** — chips + `+` opening a `ResponsiveSheet` connector picker listing
  `GET /api/sessions/{name}/connectors` — **granted first**, each with its account label
  ("Gmail · sander@acme.com"). Ungranted connectors appear in a second group *"Not connected for this
  bot"* with a **Grant…** affordance that deep-links to the store. Never silently offer a connector
  the bot cannot use; never render a `disconnected`/`expired` account as available (the
  dead-connections-look-dead rule the connector store already enforces).
- **Reordering** — desktop: drag the `⋮⋮` handle. Mobile: `▲ ▼` buttons in the step's `⋮` menu.
  Drag-to-reorder inside a scrolling touch list is the classic mobile failure; we do not ship it.
  Both paths fire `navigator.vibrate?.(8)` — the nav already uses that exact haptic.
- **Completion row** — reads as a sentence. The dropdown holds exactly five options: *Do nothing ·
  Notify me · Send with a connector… · Message another bot… · Pause this workflow.* Choosing
  *Send with a connector* reveals two typed fields plus the preview sentence. **There is no free-text
  command box anywhere in this UI, and a test asserts it** (§9).
- **Footer** — pinned, `pb-safe`. `Save` primary, `Run now` secondary, and a live validity line that
  names the offending step ("Step 3 has no prompt"). Never a disabled button with no explanation.

**Micro-interactions worth naming:** step insert = spring on height + opacity from `springs`;
chip appearance = `scale .9→1` + fade; the ordinal circle cross-fades to a spinner when its step is
running; the spine between a done step and the next animates a 300 ms fill on advance; the step rail
in the list pulses only the current dot (one animated element per card, not four).

### 6.4 BotPanel — `Activity` → `Workflows`

`web/src/components/roster/bot-panel.tsx`:

```ts
type TabKey = 'overview' | 'instructions' | 'tools' | 'memory' | 'workflows'
const TABS = [ …, { key: 'workflows', label: 'Workflows' } ]
```

`ActivityTab` → `WorkflowsTab`, containing, in order:

1. `Field "Workflows"` — the bot-scoped `WorkflowsView` (same cards, same rail) + `+ New workflow`
   (opens the composer with the bot pre-selected).
2. `Field "Recent runs"` — the last 5 runs across this bot's workflows, each a compact timeline row.
3. `Field "Issues"` — **unchanged.** Deleting it would be a capability drop.
4. `Field "Git"` — **unchanged.**

⚠️ Mechanical fallout: `initialTab` prop union (twice in the file), `data-vr-tab="activity"` in the
visual-regression benches, `routes/dev-roster.tsx` and its `.cast.ts` fixture, and `TeamPanel` which
copies BotPanel's frame.

### 6.5 Run history / Activity

`WorkflowDetail` → **Runs** tab, and the same `RunTimeline` component inside the bot tab.

- Runs grouped by day with relative headers (*Today*, *Yesterday*, then dates).
- One run = a vertical timeline, one node per step:
  `② ✓ Draft the summary · 41 s · agent-confirmed`
  Status dots: running = pulse · ok = check · skipped = dash · error = ✕ · timeout = clock ·
  interrupted = broken-link. The dot vocabulary is the same as the list's step rail — one language.
- Tapping a node reveals the **delivered preview** (the plain prompt line; never the wrapper, never
  the footer — the same honesty rule `deliveries` already enforces for `last_send_text`) and
  *"Open the thread here →"*, which navigates to the bot's chat (`workflow-href.ts`, the descendant
  of `schedule-href.ts`).
- Live via the `workflows` SSE event, cached with the `useSchedulerStream` pattern
  (invalidate on `type==='workflows'` or `alerts && source==='workflow'`, plus the focus/visibility
  resync that hook already does).
- 20 runs kept per workflow (prune-on-insert, scoped by `workflow_id` so a busy workflow cannot evict
  a quiet one's history — exactly today's rule).

### 6.6 One honesty tell we owe the user

A workflow **occupies the bot's thread** for its duration, and the human can type into that pane
mid-chain. v1 does not lock the pane (locking a user out of their own agent is worse than the
interleaving). Instead: while a run is in flight, the bot's chat header shows a chip
**`Workflow · step 2/4`** with a tap target that opens the run timeline, and a **Stop** affordance
wired to `POST /api/workflows/{id}/cancel`. Accepted limitation, visibly disclosed.

---

## 7. Migration & porting plan

### 7.1 Principles

1. Nothing is destroyed — every pre-drop row is archived to `workflows_import_log` as JSON.
2. Nothing re-fires and nothing is skipped — `next_run`, `last_run`, `run_count`, `enabled` and the
   **fire-keys** all cross over unchanged.
3. Anything that cannot be ported honestly is **not** synthesised into something else. A shell job
   does not become a "notify" workflow; it becomes a log entry and a one-time in-app alert.

### 7.2 ID rule

**Ported workflows keep the old `SCHED-xxxxxxxx` id verbatim.** Fire-keys, audit rows,
`<supermux-schedule id="…">` wrappers already written into transcripts on disk, and confirm footers
already sitting in live panes all reference that exact string. Reusing it makes the legacy hook
aliases (§5.4) resolve with no mapping table. New workflows get `WF-xxxxxxxx`.

### 7.3 Column mapping

| `schedules` | → | `workflows` / `workflow_steps` |
|---|---|---|
| `id` | → | `workflows.id` (verbatim) |
| `title` | → | `workflows.title` |
| `session` | → | `workflows.session`; `company_id` ← `(SELECT company_id FROM sessions WHERE name = session)` |
| `kind='tmux'` | → | ported |
| `kind='shell'` | ✗ | import log, `reason='shell jobs were removed in Workflows v1'` |
| `kind='boot'` | ✗ | import log, `reason='boot jobs were removed in Workflows v1'` |
| `command` | → | `workflow_steps.command` (**kept separate** — the bare slash line must stay its own submission) |
| `prompt` | → | `workflow_steps.prompt` |
| `sched_type='once'` | → | `trigger_kind='once'` |
| `sched_type='recurring'` | → | `trigger_kind='recurring'` |
| `schedule_expr` | → | `schedule_expr`; when NULL, synthesised in SQL from `recurrence`+`run_at` using the same rules as `synth_expr` (the four `hourly/daily/weekly/monthly` shapes) |
| `next_run` / `last_run` / `run_count` / `enabled` | → | 1:1 (**cadence continuity**) |
| `watch_timeout` | → | `workflow_steps.timeout_secs` (0 → 1800) |
| `watch`, `confirm_finish` | ✗ | dropped: done-detection is now unconditional |
| `done_pattern` | ✗ | dropped; preserved in the import-log JSON |
| `done_action='disable'` | → | `on_complete = {"kind":"disable"}` |
| `done_action='notify'` | → | `on_complete = {"kind":"notify"}` |
| `done_action LIKE 'command:%'` | ⚠ | `on_complete = {"kind":"disable"}` **plus** an import-log row with `ported=1, reason='done_action command:… was removed; the follow-up text is preserved here'`. Never auto-converted to a connector send — we would be guessing what the user meant. |
| `schedule_runs` | → | `workflow_runs` (one single-step historical run each; `status`/`note`/`ran_at` preserved) + a matching `workflow_step_runs` row, so *"Past runs stay in the log"* holds |
| `schedule_run_keys` | → | `workflow_run_keys` keyed by the same id. **Critical:** without this, a window missed across the upgrade double-fires. |
| `deleted IS NOT NULL` | ✗ | not ported (they are already tombstones); archived to the import log anyway |

### 7.4 Order of operations inside 0038

1. `CREATE` all new tables + indexes + the company trigger.
2. `INSERT INTO workflows_import_log` — **every** row of `schedules` (ported or not), as
   `json_object(...)`.
3. `INSERT INTO workflows … SELECT … WHERE kind='tmux' AND deleted IS NULL`.
4. `INSERT INTO workflow_steps` — one step per ported workflow, `position=0`, id
   `'WS-' || lower(hex(randomblob(4)))`.
5. `INSERT INTO workflow_runs` / `workflow_step_runs` from `schedule_runs`.
6. `INSERT INTO workflow_run_keys` from `schedule_run_keys` (only for ported ids).
7. `DROP TABLE schedule_runs; DROP TABLE schedule_run_keys; DROP TABLE schedules;`

All in one migration = one transaction. There is no window where both systems are live and both
could fire.

### 7.5 Post-upgrade reconciliation (Rust, at boot, idempotent)

`workflows::port::reconcile(state)` runs once on the first boot after 0038:

- Re-derive `company_id` for every workflow (SQL cannot be trusted to have seen a session row that
  was created between the migration and boot in a restored DB).
- If `workflows_import_log` holds any `ported=0` row or any `command:` note, raise **one** SSE
  `alerts` frame + a single push: *"3 old schedules could not be carried over to Workflows — review
  them."* linking to a read-only *Settings → Imported schedules* list rendered from the log. Never
  silent, never spammed per-row.
- Write one `audit_log` row (`workflows.port`) with the counts.

### 7.6 The one-shot "delay send" primitive

A one-shot delay-send is, structurally, a workflow with `trigger_kind='once'` and exactly one step:

```json
POST /api/workflows
{ "title": "Delayed send", "session": "scout", "trigger_kind": "once",
  "schedule_expr": "at 2026-08-24T18:30:00Z",
  "steps": [{ "prompt": "…" }], "on_complete": { "kind": "none" } }
```

The 6-hour `ONESHOT_GRACE` behaviour is preserved verbatim, which is what makes a delayed send
survive a server restart.

⚠️ **A repo-wide search found no caller of `schedulerApi.create` outside the scheduler UI itself**
(`web/src/hooks/use-scheduler.ts` is the only one). If the delay-send primitive lives outside this
repo — a skill, the mobile client, an external caller of `POST /api/schedules` — it needs the write
shim rather than the read shim. **Open question #2.**

---

## 8. Isolation & boundaries

Nine units, each with one responsibility and an explicit contract. No unit reaches past its neighbour.

| # | Unit | Owns | Must not |
|---|---|---|---|
| 1 | `server/migrations/0038_workflows.sql` | schema + port + drop | — (never edited after ship) |
| 2 | `server/src/db/workflows.rs` | rows, queries, prune, fire-key claim, session cascades | know about HTTP, prompts, or connectors |
| 3 | `server/src/workflows/mod.rs` | HTTP router, handlers, tick loop, validation funnel | build prompts or send anything |
| 4 | `server/src/workflows/engine.rs` | chain advance, `deliveries()`, watcher, reaper | format a completion message |
| 5 | `server/src/workflows/complete.rs` | the 5 typed completion actions | be reachable with untyped text; **the only unit that may originate a non-step send** |
| 6 | `server/src/workflows/hook.rs` | hook-token endpoints + the 2 legacy aliases | accept `connector_send` / `message_bot` |
| 7 | `server/src/workflows/parser.rs` | cadence grammar (moved, unchanged) | grow a new grammar in v1 |
| 8 | `web/src/lib/api/workflows.ts` + `hooks/use-workflows.ts` | transport, cache, SSE invalidation | hold layout state |
| 9 | `web/src/components/workflows/*` | `workflows-view` · `workflow-composer` · `step-card` · `step-prompt` · `connector-hint-picker` · `completion-action-row` · `trigger-picker` · `run-timeline` · `cadence.ts` · `workflow-href.ts` | call `fetch` directly |

Key contract: **4 → 5 is a function call with a typed enum.** `engine` never formats a message; it
calls `complete::fire(state, &run, &action) -> CompletionOutcome`. That single seam is what keeps
`command:` from growing back.

Suggested build order (each step independently shippable and testable):
**1 → 2 → 3(CRUD only) → 8 → 9(list) → 4 → 9(composer) → 5 → 6 → 7(move) → removals → port test.**

---

## 9. Test plan

### 9.1 Server — new

| File | Asserts |
|---|---|
| `tests/workflows_chain.rs` | 3-step chain advances on the status→idle edge; **step 2 is not delivered before step 1's edge**; a timeout **halts** (step 3 never delivered) and records `timeout`; a mid-chain session archive halts with a readable `skipped` and never starts the session; two due ticks while a run is `running` produce one `skipped`, not a second run |
| `tests/workflows_port.rs` | fixture DB at 0037 with one tmux + one shell + one boot + one `command:` schedule, plus a run row and a fire-key → after 0038: 2 workflows (tmux + `command:`), `next_run`/`run_count`/fire-keys identical, 2 unported rows in the import log with reasons, `command:` text preserved, run history carried over, `schedules` table gone |
| `tests/workflows_removals.rs` | source-scan keep-list-inverse (`board-removal-keeplist.test.ts` idiom): the strings `execute_shell`, `execute_boot`, `bypass_permissions`, `done_action LIKE 'command:'`, `done_pattern` do not appear under `server/src/workflows/`; **and** `/api/hook/schedule/done` + `/api/hook/schedule/create` **are** still registered |
| `tests/workflows_completion.rs` | `connector_send` with a revoked grant → run `error` + push, never a silent skip; `message_bot` to another company → refused; the hook path 400s on both |
| `tests/workflows_reaper.rs` | a `running` run whose `heartbeat` is older than `timeout+60` is reaped to `interrupted` on the next tick, and the workflow fires again on its next cadence |

### 9.2 Server — ported / rewritten

- `tests/scheduler.rs` → `tests/workflows_http.rs`. Its `kind=shell` marker-file assertion **dies
  with the feature** (that test proves a capability we are deleting); the bearer CRUD round-trip
  survives, retargeted.
- `tests/schedule_hook_create.rs` → `tests/workflow_hook_create.rs`. The negatives-first matrix is
  preserved verbatim, plus: the **legacy alias** enforces the identical forced fields; a hook-created
  workflow may hold at most 5 steps; `on_complete.connector_send` is 400.
- `tests/schedule_missed_tick.rs` → `tests/workflow_missed_tick.rs`, unchanged in spirit.
- `tests/archive_schedule_contract.rs` → `tests/archive_workflow_contract.rs`. Both halves survive,
  including the negative one (no other caller may bypass `send_harness_text`'s archive refusal).
- `tests/delete_disposition.rs` — extend: session delete soft-deletes its workflows; **duplicate
  copies workflows AND their steps, DISABLED, with reset counters**; rename re-points
  `workflows.session`.
- `tests/scope_p3b.rs` / `tests/role_p3d.rs` — extend: a member gets a uniform 404 on another
  company's workflow; `member_may_reach` admits `/api/workflows*`.
- Unit tests inside `engine.rs`: port all of `runner.rs`'s `deliveries`/`wrap_schedule`/`truncate`
  tests (escaping, defanging, preview-free-of-wrapper-and-footer, multibyte truncation) and add:
  the attachment sentence is byte-identical to `attachmentSentence`; the connector-hint sentence is
  built only from validated ids.

### 9.3 Web — new

| File | Asserts |
|---|---|
| `tests/unit/workflows-view.test.tsx` | the **anti-drop** test, in `schedules-section.test.tsx`'s idiom: title, human cadence, next fire, last fired, enable toggle, create, edit, run-now, run log and delete are all present on the new list. A capability that vanishes with the redesign fails here. |
| `tests/unit/workflow-composer.test.tsx` | add / reorder / delete steps; a step with no prompt blocks Save **and names itself**; file chips render the uploaded path and Save is blocked mid-upload; the connector picker shows granted connectors first and labels the rest "not connected" |
| `tests/unit/workflow-completion.test.ts` | the completion dropdown has **exactly** the five curated options, and no free-text input exists anywhere in the completion subtree (the `command:` regression guard) |
| `tests/unit/workflow-run-timeline.test.tsx` | a node shows the plain preview, never a `<supermux-` substring, never the `— — —` footer sentinel |
| `tests/unit/workflow-href.test.ts` | port of `schedule-href.test.ts` |

### 9.4 Web — amended / deleted

- **Delete** `schedules-section.test.tsx`, `session-schedules.test.tsx`, `schedule-href.test.ts`.
- `sse-events.test.ts` — add `workflows`.
- `tour-anchors.test.ts` + a nav assertion — the Workflows item exists and sits **immediately after**
  Connectors in `NAV`.
- `sheet-inventory.test.ts` — the composer must add **zero** raw-Vaul sites (the allowlist may only
  shrink).
- `chat-wrapper-parity.test.ts` — unchanged (the tag does not change in v1); add a case for a title
  carrying the `· step 2/4` suffix so escaping is proven on the new shape.
- e2e: `tests/e2e/smoke/scheduler-fold.spec.ts` → `workflows.spec.ts` — create → add 2 steps → run
  now → watch the rail advance → open the run timeline → delete.
- **Mobile rig:** screenshot the list, the composer (collapsed + expanded step), the connector picker
  and the run timeline at **390 px** and **320 px**, light and dark, grok on and off, per the
  mobile-first rule. Verify no horizontal overflow and that the pinned footer clears the iOS keyboard.

---

## 10. Open questions & risks

### DECISIONS LOCKED (owner, 2026-08-24)
1. **Drop `schedules` in 0038** — port every row + archive as JSON in `workflows_import_log`, then DROP in the same transaction. (Q1 below resolved: "drop".)
2. **Workflows nav item is `grokOnly: true`** — matches the Connectors precedent; base rail stays 4 items, no phone tab-bar geometry respec. (Q3 below resolved: "grok-only".)
3. **The one-shot "delay-send" caller is known** — it is the composer delay-send feature being built in parallel (`feat/composer-delay-send`). Resolution: when Workflows ships, delay-send is repointed at the new workflows one-shot endpoint; NO compat write-shim for `POST /api/schedules` is needed (the read-shim + `410 Gone` on writes in §5.2 stands). (Q2 below resolved.)

### (Historical) The three the owner was asked to decide before implementation started

1. **Drop `schedules` in 0038, or keep it read-only for one release?**
   Recommendation: **drop**, with the full JSON archive in `workflows_import_log`. It is the only way
   the removal is real — the 0003 CHECK that admits `kind='shell'` and `done_action LIKE 'command:%'`
   cannot be edited, only made unreachable. The cost: it is irreversible for anyone who restores an
   old backup *after* upgrading, and the read-shim (§5.2) must be built against the new tables rather
   than the old ones. If the owner prefers belt-and-braces, the alternative is drop in **0039**, one
   release later — at the price of a release in which the dragon's table still exists.

2. **Where does the one-shot "delay send" primitive actually live?**
   A repo-wide search found only the scheduler UI calling `schedulerApi.create`; no other in-repo
   caller of `POST /api/schedules` exists. If delay-send is implemented in a skill, in the mobile
   client, or by an external caller, it needs the **write** shim (a real `POST /api/schedules` →
   workflows translation), not the read shim. I need to see that caller before finalising §5.2.

3. **Should the Workflows nav item be `grokOnly` (like Connectors) or in the base rail too?**
   `grokOnly: true` keeps the base app byte-identical and matches the Connectors precedent. Making it
   always-on takes the base rail from 4 items to 5 and forces a respec of the phone tab-bar geometry
   (`--nav-n`, `data-tab-count`, the Liquid Rail pill). One-word change either way — but the geometry
   work is real, so it should be a decision, not a discovery.

### Risks logged, with mitigations

- **The wrapper tag stays `<supermux-schedule>`.** Cosmetically wrong for a feature called Workflows;
  correct for transcript compatibility. Renaming with a dual-reader is a tracked v1.1 item.
- **The bot's thread is shared.** A human typing mid-chain interleaves with the workflow. Mitigated
  by the header chip + Stop (§6.6), not by locking. Accepted.
- **A step's "done" is still an inference when the agent forgets the footer.** The idle edge is the
  fallback and it is good, but a bot that goes idle *while thinking about* step 1 will get step 2.
  Mitigation: the footer is now unconditional (not opt-in as today), which is the reliable tier;
  plus the per-step timeout halts rather than cascading.
- **Connector-send depends on the bot cooperating.** There is no server-side MCP client, so the
  action is an instruction, not an execution. The run timeline must therefore say *"asked scout to
  send via Gmail"*, never *"sent"*. Honesty rule; enforced by copy review and the timeline test.
- **`NotifCategory` DB values must not be renamed** — a renamed category silently un-mutes a user
  who muted it. Relabel the UI strings only.
- **The port is the only irreversible step in the plan.** It gets its own test file, its own fixture
  DB, and it should be rehearsed against a copy of the production SQLite before the release is cut.
