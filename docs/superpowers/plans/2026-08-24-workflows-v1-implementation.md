# Workflows v1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `schedules` with **Workflows** — a bot + an ordered list of prompt steps + a trigger + a typed completion action — deleting the shell/boot/`command:`/`done_pattern`/`bypass_permissions` dragon in the same commit series.

**Architecture:** One new migration (`0038_workflows.sql`) creates five tables, ports every `schedules` row, archives every pre-drop row as JSON in `workflows_import_log`, and **drops `schedules` in the same transaction**. The execution engine is not new machinery: it is `scheduler/watch.rs`'s status→idle edge (plus the agent confirm-footer hook) in a loop — `send step k → await (idle-edge | agent-confirm | timeout) → record → k+1`. Nine units with hard boundaries (spec §8); the seam that keeps `command:` from growing back is `engine → complete::fire(state, &run, &action)` taking a **typed enum**, never text.

**Tech Stack:** Rust (axum, sqlx/SQLite, tokio) · React 18 + TypeScript + Vite + TanStack Query · Vitest (unit) + Playwright (e2e) · `cargo test` (debug only).

**Spec:** [`docs/superpowers/specs/2026-08-24-workflows-v1-design.md`](../specs/2026-08-24-workflows-v1-design.md) — read it alongside this plan. Every `§` reference below points into it.

**Branch:** `feat/workflows` in the worktree `/opt/projects/supermux-workflows` (based on `main` @ `d6b73cb`; spec committed at `b43f5c9`).

---

## Global Constraints

Copied verbatim from the spec and the repo's standing rules. **Every task's requirements implicitly include this section.**

- **Never `cargo build/test --release`.** Debug only. Build/test recipe that works in-sandbox:
  `OPENSSL_NO_VENDOR=1 OPENSSL_LIB_DIR=/usr/lib/x86_64-linux-gnu cargo test --test <name>` from `server/`.
- **Never `cargo fmt`** in this repo (it reflows ~150 hand-formatted files). Hand-edit + `cargo check`.
- **Never edit an existing migration file.** sqlx checksums migrations; a `VersionMismatch` bricks deployed installs. `0003`'s three CHECK constraints can only be made *unreachable*, never changed.
- **Grep safety:** never use bounded quantifiers `{m,n}` with `-o`-style matching (shell `grep -oE` *or* the Grep tool). Use fixed strings (`-F`) or plain patterns.
- **Decisions locked (owner, 2026-08-24):**
  1. `schedules` is **dropped** in 0038 after a full JSON archive.
  2. The Workflows nav item is **`grokOnly: true`** — the base rail stays 4 items, no phone tab-bar geometry respec.
  3. Delay-send is **repointed** at the new one-shot workflows endpoint. **No `POST /api/schedules` write-shim.**
- **Honesty rule (`connector_send`):** the server has no MCP client. A connector completion action is an **instruction to the bot**, never an execution. Every string the user sees must read *"asked scout to send via Gmail"*, **never** *"sent"*. Enforced by `tests/unit/workflow-run-timeline.test.tsx` and copy review.
- **`NotifCategory` DB values must not be renamed.** `ScheduleError` / `ScheduleFinished` stay as `"schedule_error"` / `"schedule_finished"` in `db/push.rs` (they are persisted user mute toggles). Relabel only the UI strings in `push.rs:429-430`.
- **The `<supermux-schedule>` wrapper tag does not change in v1.** `SCHEDULE_TAG` (`scheduler/runner.rs:317`), `CONFIRM_FOOTER_SENTINEL` (`:323`), `sessions/recall.rs:27`, `agents/delegate.rs:71` and every transcript on disk agree on the current string. Step identity rides in the already-escaped `title` attribute: `title="Weekly report · step 2/4 — Draft the summary"`.
- **Ported workflows keep their `SCHED-xxxxxxxx` id verbatim.** New workflows get `WF-xxxxxxxx`; new steps get `WS-xxxxxxxx`.
- **Legacy hook routes stay registered permanently:** `POST /api/hook/schedule/done` and `POST /api/hook/schedule/create` (live panes hold footers with those literal URLs).
- **UI:** mobile-first, nothing overflows at 390 px **or** 320 px, `ResponsiveSheet` for every modal (the `sheet-inventory.test.ts` allowlist may only shrink — zero new raw-Vaul sites), motion from `lib/springs.ts` only (never `transition: all`), `useReducedMotion` honoured, `pb-safe` on pinned footers.
- **Caps:** `MAX_WORKFLOWS_PER_SESSION = 20`, max 20 steps per workflow, max 5 steps on the agent hook path, `RUN_HISTORY_KEEP = 20` per workflow.
- **Constants carried over verbatim:** `TICK_INTERVAL = 10s`, `MISSED_WINDOW = 60s`, `ONESHOT_GRACE = 6h`, `DEFAULT_STEP_TIMEOUT = 1800` (today's `DEFAULT_WATCH_TIMEOUT`, `scheduler/mod.rs:38-53`), `MissedTickBehavior::Skip`.
- **Commit cadence:** one commit per task, conventional message, tests included in the same commit.

---

## File Structure

### Server — created

| Path | Responsibility | Must not |
|---|---|---|
| `server/migrations/0038_workflows.sql` | schema + port + drop, one transaction | be edited after it ships |
| `server/src/db/workflows.rs` | rows, queries, prune-on-insert, fire-key claim, session cascades | know about HTTP, prompts, or connectors |
| `server/src/workflows/mod.rs` | HTTP router, handlers, tick loop, the single validation funnel | build prompts or send anything |
| `server/src/workflows/engine.rs` | `start`/`advance`/`watch_step`/`deliveries`/`reap` | format a completion message |
| `server/src/workflows/complete.rs` | the 5 typed completion actions | be reachable with untyped text; **the only unit that may originate a non-step send** |
| `server/src/workflows/hook.rs` | hook-token endpoints + the 2 legacy aliases | accept `connector_send` / `message_bot` |
| `server/src/workflows/parser.rs` | cadence grammar (moved from `scheduler/parser.rs`, unchanged) | grow a new grammar in v1 |
| `server/src/workflows/port.rs` | boot-time `reconcile` (idempotent) | mutate anything the migration owns |
| `server/src/workflows/shim.rs` | `/api/schedules` read projection + `410 Gone` writes | ever write |

### Server — deleted at the end of Phase 4

`server/src/scheduler/` (all 5 files) · `server/src/db/schedules.rs`

### Server — modified

| Path | Change |
|---|---|
| `server/src/http.rs:74,177` | `scheduler::hook_router_for` → `workflows::hook_router_for`; `scheduler::router_for` → `workflows::router_for` + `shim::router_for` |
| `server/src/main.rs:153` | `scheduler::spawn` → `workflows::spawn` |
| `server/src/db/sessions.rs:246-254, 278-280, 540-542` | `schedules::soft_delete_for_session` → `workflows::soft_delete_for_session`; `UPDATE schedules SET session = ?` → `UPDATE workflows SET session = ?` |
| `server/src/scope.rs:196` (`member_may_reach`) | admit `/api/workflows` |
| `server/src/sessions/recall.rs:27, 2003` | re-point the `SCHEDULE_TAG` / `escape_attr` / `wrap_schedule` imports at `workflows::engine` |
| `server/src/agents/delegate.rs:71, 154` | same re-point |
| `server/src/push.rs:429-430` | UI label strings only |
| `server/src/state.rs` | nothing structural — reuse `status_watch_for` (`:1599`) and `SseEvent::for_company` (`:193`) |

### Web — created (`web/src/components/workflows/`)

`workflows-view.tsx` · `workflow-composer.tsx` · `step-card.tsx` · `step-prompt.tsx` (salvage) · `step-rail.tsx` · `trigger-picker.tsx` · `connector-hint-picker.tsx` · `completion-action-row.tsx` · `run-timeline.tsx` · `cadence.ts` (salvage) · `workflow-href.ts` (salvage) · `enable-toggle.tsx` (salvage)
plus `web/src/lib/api/workflows.ts`, `web/src/hooks/use-workflows.ts`, `web/src/routes/workflows.tsx`.

### Web — deleted at the end of Phase 4B

`components/scheduler/*` · `components/session-schedules/*` · `components/settings/schedules-section.tsx` + `.helpers.ts` · `lib/api/scheduler.ts` · `hooks/use-scheduler.ts` · `tests/unit/schedules-section.test.tsx` · `tests/unit/session-schedules.test.tsx` · `tests/unit/schedule-href.test.ts` · `tests/e2e/smoke/scheduler-fold.spec.ts` · `tests/e2e/smoke/scheduler-fires.spec.ts`

---

## Phase & parallelism map

| Phase | Title | Depends on | Agents in parallel |
|---|---|---|---|
| **0** | Preflight | — | 1 |
| **1** | Data model + migration 0038 ⚠️ | 0 | 1 → then 2 |
| **2** | Execution engine | 1 | up to 3 |
| **3** | API | 1 (CRUD) / 2 (run) | up to 4 |
| **4A** | Server removals | 3 | 1 |
| **5** | Web — Workflows surface | 3 (T3.1) | up to 4 |
| **6** | Web — BotPanel | 5 (T5.3) | up to 2 |
| **4B** | Web removals | 5 + 6 | 1 |
| **7** | Delay-send repoint | 3 (T3.1) + external branch | 1 |
| **8** | Migration rehearsal + sweep | 4A + 4B | up to 3 |

**Phases that overlap in wall-clock:** 2 and 3.1/3.3 (both only need Phase 1). 5 and 6 start as soon as **T3.1** lands and run alongside 2/3.4-3.7. 7 is independent of 5/6 once T3.1 exists.

> ⚠️ **THE ONE IRREVERSIBLE STEP IS TASK 1.2** — `DROP TABLE schedules` inside `0038_workflows.sql`. The orchestrator **must pause for owner sign-off before T1.2 is written**, and again before Phase 8's release cut. Everything else in this plan is a normal reversible code change.

---

## Phase 0 — Preflight

*One agent, sequential. Nothing else starts until this is green.*

### Task 0.1: Baseline green + the fixture DB harness

**Intent:** Prove the pre-change suite passes and record the exact commands every later task will re-run.

**Files:**
- Create: `server/tests/fixtures/schema_0037.md` (a written note, not code — how the fixture is produced)
- Modify: none

**Interfaces:**
- Produces: the documented test recipe every task below cites.

- [ ] **Step 1: Run the four scheduler suites and record the pass counts**

```bash
cd /opt/projects/supermux-workflows/server
export OPENSSL_NO_VENDOR=1 OPENSSL_LIB_DIR=/usr/lib/x86_64-linux-gnu
cargo test --test scheduler --test schedule_hook_create --test schedule_missed_tick --test archive_schedule_contract 2>&1 | tail -30
```

Expected: all four green. Record the per-file test counts in the commit message — Phase 8 asserts nothing was silently dropped.

- [ ] **Step 2: Run the web unit suites that this plan touches**

```bash
cd /opt/projects/supermux-workflows/web
npx vitest run tests/unit/schedules-section.test.tsx tests/unit/session-schedules.test.tsx \
  tests/unit/schedule-href.test.ts tests/unit/sse-events.test.ts tests/unit/tour-anchors.test.ts \
  tests/unit/sheet-inventory.test.ts tests/unit/chat-wrapper-parity.test.ts
```

Expected: all green.

- [ ] **Step 3: Write down how the 0037 fixture DB is produced**

`server/tests/fixtures/schema_0037.md` must state, in prose an executor can follow:

> A fresh SQLite file migrated to **0037 only** (`sqlx::migrate!` stops there because 0038 does not exist yet on the parent commit), then seeded by hand with: one `kind='tmux'` schedule, one `kind='shell'`, one `kind='boot'`, one `kind='tmux'` whose `done_action='command:say hi'`, one soft-deleted row, one `schedule_runs` row against the tmux schedule, and one `schedule_run_keys` row. The seed SQL lives inline in `tests/workflows_port.rs` so the fixture is regenerated per test run and never checked in as a binary.

- [ ] **Step 4: Commit**

```bash
git add server/tests/fixtures/schema_0037.md
git commit -m "docs(workflows): record the pre-change baseline and the 0037 fixture recipe"
```

---

## Phase 1 — Data model, migration 0038, db layer

> ⚠️ **This phase contains the single irreversible step of the whole build (Task 1.2).**
> The orchestrator pauses here for owner sign-off. Do not start T1.2 without it.

**Existing tests that must stay green through this phase:** `server/tests/delete_disposition.rs`, `archive_recover.rs`, `archive_removes.rs` (they exercise `soft_delete_for_session` through session delete/archive/purge).

### Task 1.1: `tests/workflows_port.rs` — the port contract, as an executable spec

**Intent:** Write the port's acceptance test *before* the migration exists, so 0038 is written against a contract instead of a vibe.

**Files:**
- Create: `server/tests/workflows_port.rs`
- Read for reference: `server/migrations/0003_schedules.sql`, `0014`, `0020`, `0021`; `server/src/db/schedules.rs:18-79` (the `Schedule` struct = the column list)

**Interfaces:**
- Produces: `fn seed_0037(pool: &SqlitePool)` — the fixture seeder T8.1 reuses.
- Consumes: nothing (it is the first task).

**Dependencies:** T0.1. **Sequential** — T1.2 is written to satisfy it.

- [ ] **Step 1: Write the failing test file**

Six `#[tokio::test]` cases, each named for the promise it keeps:

```rust
// server/tests/workflows_port.rs
// The port is the only irreversible step in Workflows v1 (spec §10). It gets its
// own fixture, its own file, and a rehearsal against a copy of production before
// the release is cut (Phase 8).

#[tokio::test]
async fn every_tmux_schedule_becomes_a_one_step_workflow_with_its_id_intact() {
    // seed_0037 → migrate to 0038 → assert:
    //   SELECT id FROM workflows  == the two SCHED-… ids that were kind='tmux'
    //   the 'command:' one is ported too (its action becomes disable)
    //   workflow_steps: exactly one row per workflow, position = 0,
    //     command/prompt carried across SEPARATELY (never concatenated)
}

#[tokio::test]
async fn cadence_crosses_over_bit_for_bit() {
    // next_run, last_run, run_count, enabled identical to the pre-drop values.
    // A schedule whose schedule_expr was NULL gets the synth_expr shape
    // ('0 9 * * *' for recurrence='daily' + run_at='09:00', etc.).
}

#[tokio::test]
async fn fire_keys_cross_over_so_the_upgrade_window_cannot_double_fire() {
    // SELECT workflow_id, scheduled_for_ts FROM workflow_run_keys
    //   == the pre-drop schedule_run_keys rows for ported ids only.
}

#[tokio::test]
async fn run_history_survives_so_past_runs_stay_in_the_log() {
    // one workflow_runs row per old schedule_runs row (status/note/started_at
    // preserved) + one matching workflow_step_runs row at position 0.
}

#[tokio::test]
async fn nothing_is_destroyed_shell_and_boot_land_in_the_import_log_with_reasons() {
    // workflows_import_log holds EVERY pre-drop row incl. the soft-deleted one.
    // ported=0 for shell + boot, with reason
    //   'shell jobs were removed in Workflows v1' / 'boot jobs were removed in Workflows v1'
    // the command: row is ported=1 with reason
    //   'done_action command:… was removed; the follow-up text is preserved here'
    // and its row_json still contains the literal text 'say hi'.
}

#[tokio::test]
async fn the_dragons_table_is_gone() {
    // SELECT name FROM sqlite_master WHERE name IN
    //   ('schedules','schedule_runs','schedule_run_keys')  → 0 rows.
}
```

- [ ] **Step 2: Run it and watch it fail for the right reason**

```bash
cd server && OPENSSL_NO_VENDOR=1 OPENSSL_LIB_DIR=/usr/lib/x86_64-linux-gnu cargo test --test workflows_port
```

Expected: FAIL — `no such table: workflows`. **Not** a compile error; if it does not compile, the test is wrong, not the migration.

- [ ] **Step 3: Commit the failing test**

```bash
git add server/tests/workflows_port.rs && git commit -m "test(workflows): the port contract, ahead of 0038"
```

---

### Task 1.2: ⚠️ **`0038_workflows.sql` — THE IRREVERSIBLE STEP** ⚠️

> **STOP. OWNER SIGN-OFF REQUIRED BEFORE THIS TASK RUNS.**
> This migration ends with `DROP TABLE schedules`. Anyone who restores a pre-upgrade
> backup *after* upgrading cannot get the old rows back through the app — only through
> `workflows_import_log`'s JSON. This is the locked decision (spec §10, DECISIONS LOCKED #1)
> and it is the only step in this plan that cannot be reverted by a `git revert`.

**Intent:** One migration creates the five tables, ports every row, archives every pre-drop row as JSON, and drops the old three tables inside sqlx's single implicit transaction — so there is never a window where both systems are live.

**Files:**
- Create: `server/migrations/0038_workflows.sql`
- Test: `server/tests/workflows_port.rs` (from T1.1)

**Interfaces:**
- Produces: tables `workflows`, `workflow_steps`, `workflow_runs`, `workflow_step_runs`, `workflow_run_keys`, `workflows_import_log`; trigger `trg_company_delete_workflows`.
- Consumes: `schedules`, `schedule_runs`, `schedule_run_keys`, `sessions.company_id`.

**Dependencies:** T1.1 + **owner sign-off**. **Strictly sequential** — everything in Phases 1–3 depends on it.

- [ ] **Step 1: Write the DDL exactly as spec §2.2 prints it**

Copy the DDL block from spec §2.2 verbatim (tables + indexes) and append the trigger from §2.5:

```sql
CREATE TRIGGER trg_company_delete_workflows
AFTER DELETE ON companies BEGIN
    UPDATE workflows SET company_id = NULL WHERE company_id = OLD.id;
END;
```

Two properties that are load-bearing and must be re-read before committing:
- Every CHECK is an **exhaustive `IN (…)` enumeration**. There is **no `LIKE` clause anywhere** — that one `OR done_action LIKE 'command:%'` in `0003` is how the dragon got in.
- `workflow_step_runs.step_id` is **NOT** a foreign key (a step may be deleted after it ran; history must survive).

- [ ] **Step 2: Write the port statements in exactly the §7.4 order**

```
1. CREATE all tables + indexes + trigger
2. INSERT INTO workflows_import_log SELECT … json_object(…) FROM schedules   -- EVERY row, ported or not
3. INSERT INTO workflows … SELECT … FROM schedules WHERE kind='tmux' AND deleted IS NULL
4. INSERT INTO workflow_steps  … one row per ported workflow, position=0,
     id = 'WS-' || lower(hex(randomblob(4)))
5. INSERT INTO workflow_runs / workflow_step_runs  FROM schedule_runs
6. INSERT INTO workflow_run_keys FROM schedule_run_keys  (ported ids only)
7. DROP TABLE schedule_runs; DROP TABLE schedule_run_keys; DROP TABLE schedules;
```

Column mapping is spec §7.3, in full. The three that are easy to get wrong:
- `company_id ← (SELECT company_id FROM sessions WHERE name = schedules.session)` — a `LEFT` lookup; a missing session yields NULL, which is correct.
- `watch_timeout → workflow_steps.timeout_secs`, with `0 → 1800`.
- `schedule_expr` when NULL is synthesised **in SQL** from `recurrence` + `run_at` using the four `hourly`/`daily`/`weekly`/`monthly` shapes of `scheduler/mod.rs::synth_expr`. Read that function and transcribe its rules; do not invent a fifth shape.

`done_action` mapping:

| old | new `on_complete` | import-log row |
|---|---|---|
| `'disable'` | `{"kind":"disable"}` | ported=1, reason='' |
| `'notify'` | `{"kind":"notify"}` | ported=1, reason='' |
| `LIKE 'command:%'` | `{"kind":"disable"}` | ported=1, reason=`'done_action command:… was removed; the follow-up text is preserved here'` |

**Never** auto-convert a `command:` into a connector send — that would be guessing what the user meant.

- [ ] **Step 3: Run the port test**

```bash
cd server && OPENSSL_NO_VENDOR=1 OPENSSL_LIB_DIR=/usr/lib/x86_64-linux-gnu cargo test --test workflows_port
```

Expected: all six cases PASS.

- [ ] **Step 4: Confirm the file is now frozen**

Add the header comment from spec §2.2 (`-- IMMUTABLE ONCE SHIPPED (sqlx checksums migrations).`) and re-read the whole file once. After this commit **the file is never edited again** — a follow-up correction must be `0039`.

- [ ] **Step 5: Commit**

```bash
git add server/migrations/0038_workflows.sql
git commit -m "feat(workflows)!: migration 0038 — port schedules into workflows and drop the old tables

BREAKING: the schedules/schedule_runs/schedule_run_keys tables are dropped.
Every pre-drop row is archived as JSON in workflows_import_log."
```

---

### Task 1.3: `db/workflows.rs` — the row layer

**Intent:** One module owning every query, so no HTTP handler ever writes SQL.

**Files:**
- Create: `server/src/db/workflows.rs`
- Modify: `server/src/db/mod.rs` (add `pub mod workflows;`)
- Test: unit tests inline (`#[cfg(test)]`) + exercised by T1.1's fixture

**Interfaces:**
- Produces (retyped ports of `db/schedules.rs`, keep the names so reviewers can diff):
  `Workflow`, `WorkflowStep`, `WorkflowRun`, `WorkflowStepRun`, `RunSummary` structs;
  `list`, `get`, `get_with_steps`, `enabled_with_next`, `insert`, `patch(WorkflowPatch)`,
  `replace_steps(pool, workflow_id, Vec<StepInput>)`, `soft_delete`, `set_enabled`,
  `record_fire`, `record_manual`, `advance_next`, `claim_run_key`, `insert_run`,
  `open_run`, `close_run`, `bump_heartbeat`, `open_step_run`, `close_step_run`,
  `runs_for`, `recent_runs`, `running_for`, `stale_running(now)`,
  `soft_delete_for_session`, `copy_for_session`, `rename_session`.
  `pub const RUN_HISTORY_KEEP: i64 = 20;`
- Consumes: nothing above it.

**Dependencies:** T1.2. **Sequential.** T1.4 and T1.5 fan out from here.

- [ ] **Step 1: Write the failing tests**

Inline `#[cfg(test)]` module, in-memory pool migrated to 0038:

```rust
#[tokio::test]
async fn insert_run_prunes_to_twenty_per_workflow_not_globally() {
    // 25 runs on wf A + 3 on wf B → A keeps the newest 20, B keeps all 3.
    // This is db/schedules.rs::insert_run's rule, re-keyed by workflow_id.
}

#[tokio::test]
async fn claim_run_key_is_idempotent_for_the_same_scheduled_for_ts() {
    // first claim → true, second → false. Port of schedule_missed_tick.rs's
    // fire_key_is_idempotent, at the db layer.
}

#[tokio::test]
async fn replace_steps_rewrites_positions_atomically_and_history_survives() {
    // wf with steps [a,b,c]; a step_run exists against b's id.
    // replace_steps with [c,a] → positions 0,1 contiguous, b is gone from
    // workflow_steps, and b's workflow_step_runs row is STILL THERE.
}

#[tokio::test]
async fn stale_running_finds_a_run_whose_heartbeat_is_older_than_its_timeout_plus_sixty() {
    // and does NOT find a fresh one.
}
```

- [ ] **Step 2: Run them and confirm they fail**

```bash
cd server && OPENSSL_NO_VENDOR=1 OPENSSL_LIB_DIR=/usr/lib/x86_64-linux-gnu cargo test --lib db::workflows
```

- [ ] **Step 3: Implement**

Read `server/src/db/schedules.rs` end-to-end first — it is the template. Carry over, retyped:
`insert_run`'s prune-on-insert (`:444-496`), `claim_run_key` (`:528`), `record_fire` (`:242`),
`record_manual` (`:268`), `advance_next` (`:283`), `soft_delete_for_session` (`:185`, **keep its
post-mortem doc-comment** — it explains why the cascade is manual), `copy_for_session` (`:216`).

Two behaviour changes from the template, both mandated by the spec:
- `copy_for_session` **must copy the steps too** (new `WS-` ids, positions preserved), still **disabled**, still with `next_run`/`last_run`/`run_count` reset. Today's function copies zero children; a workflow whose steps did not come along is exactly the bug its doc-comment was written to prevent (§2.4).
- `company_id` is **re-derived on every write** from `sessions.company_id`. A caller-supplied value is ignored — the same rule `sessions::create` applies (`sessions/mod.rs` ~1144).

- [ ] **Step 4: Run the tests + the port test**

```bash
cd server && OPENSSL_NO_VENDOR=1 OPENSSL_LIB_DIR=/usr/lib/x86_64-linux-gnu \
  cargo test --lib db::workflows && cargo test --test workflows_port
```

- [ ] **Step 5: Commit**

---

### Task 1.4: The four session cascades

**Intent:** Session rename / delete / archive / duplicate must reach workflows, because `workflows.session` is deliberately an unkeyed `TEXT` (§2.4) and deferred-FK does not touch it.

**Files:**
- Modify: `server/src/db/sessions.rs:246-254` (delete), `:278-280` (purge), `:540-542` (rename)
- Modify: `server/src/sessions/lifecycle.rs` — the `duplicate` path's `copy_for_session` call site
- Test: `server/tests/delete_disposition.rs` (extend), `server/tests/archive_recover.rs`, `archive_removes.rs` (keep green)

**Interfaces:**
- Consumes: `db::workflows::{soft_delete_for_session, copy_for_session, rename_session}` from T1.3.

**Dependencies:** T1.3. **Can run in parallel with T1.5.**

- [ ] **Step 1: Write the failing tests in `delete_disposition.rs`**

```rust
#[tokio::test]
async fn deleting_a_session_soft_deletes_its_workflows_and_keeps_the_run_log() {
    // workflows.deleted IS NOT NULL; workflow_runs rows still present.
}

#[tokio::test]
async fn renaming_a_session_repoints_its_workflows() {
    // rename scout → recon; SELECT session FROM workflows == 'recon'.
}

#[tokio::test]
async fn duplicating_a_session_copies_workflows_and_their_steps_disabled_with_reset_counters() {
    // src has a 3-step workflow, enabled, run_count=7, next_run set.
    // after duplicate: dst has a 3-step workflow, SAME positions, NEW WS- ids,
    // enabled=0, run_count=0, next_run IS NULL, last_run IS NULL.
}
```

- [ ] **Step 2: Run and confirm failure**

```bash
cd server && OPENSSL_NO_VENDOR=1 OPENSSL_LIB_DIR=/usr/lib/x86_64-linux-gnu cargo test --test delete_disposition
```

- [ ] **Step 3: Make the four edits**

At `db/sessions.rs:540-542`, replace the statement but **keep the surrounding comment** (`// schedules.session has NO foreign key (migrations/0003), so deferred-FK …`) — update `schedules` → `workflows` inside it. The comment is the reason the line exists.

- [ ] **Step 4: Run `delete_disposition`, `archive_recover`, `archive_removes`**

- [ ] **Step 5: Commit**

---

### Task 1.5: `workflows/port.rs::reconcile` — post-upgrade boot reconciliation

**Intent:** SQL cannot be trusted to have seen a `sessions` row that appeared between the migration and boot (restored DB), and an unported schedule must never disappear silently.

**Files:**
- Create: `server/src/workflows/port.rs`
- Modify: `server/src/main.rs:153` area — call `workflows::port::reconcile(&state).await` once, before `workflows::spawn`
- Test: `server/tests/workflows_port.rs` (extend)

**Interfaces:**
- Produces: `pub async fn reconcile(state: &AppState) -> Result<ReconcileReport, AppError>` where `ReconcileReport { rederived: usize, unported: usize, command_notes: usize }`.

**Dependencies:** T1.3. **Parallel with T1.4.**

- [ ] **Step 1: Write the failing tests**

```rust
#[tokio::test]
async fn reconcile_rederives_company_id_for_a_session_that_appeared_after_the_migration() {
    // migrate; INSERT the session row afterwards with company_id=3;
    // reconcile → workflows.company_id == 3.
}

#[tokio::test]
async fn reconcile_raises_exactly_one_alert_for_all_unported_rows_and_is_idempotent() {
    // 2 shell + 1 boot in the import log → ONE alerts SSE frame + ONE push,
    // text naming the count ("3 old schedules could not be carried over…").
    // Running reconcile a second time raises ZERO further frames.
}
```

- [ ] **Step 2: Run and confirm failure**

- [ ] **Step 3: Implement**

Three things, in order (§7.5): re-derive every `company_id`; if `workflows_import_log` holds any `ported=0` row **or** any `command:` note, raise **one** SSE `alerts` frame + **one** push (never per-row); write one `audit_log` row (`workflows.port`) with the counts. Idempotency comes from the audit row: if a `workflows.port` audit row already exists, re-derive but do not re-alert.

- [ ] **Step 4: Run `cargo test --test workflows_port`**

- [ ] **Step 5: Commit**

---

## Phase 2 — Execution engine

*Depends on Phase 1. **T2.1 and T2.2 run in parallel** (two agents, no shared files). T2.3 joins them. T2.4/T2.5/T2.6 then fan out again.*

**Existing tests that must stay green / be ported in this phase:**
`server/tests/archive_schedule_contract.rs` → becomes `archive_workflow_contract.rs` in T2.3 (**all three cases survive, including the negative one**: `an_archived_sessions_schedule_does_not_resurrect_it`, `unarchiving_resumes_the_schedule_without_touching_its_row`, `send_text_refuses_an_archived_session_instead_of_starting_it`).
`server/tests/schedule_missed_tick.rs` → `workflow_missed_tick.rs` in T2.4 (`missed_window_skips_and_advances_without_firing`, `fire_key_is_idempotent`).
`server/tests/wait_race.rs`, `status_detector.rs`, `status_flow.rs` must stay green untouched — the engine consumes the same `status_watch_for` primitive.

### Task 2.1: Move the parser — `workflows/parser.rs`

**Intent:** The cadence grammar (cron, every-N, natural language) is good and tested. Move it byte-for-byte; grow nothing.

**Files:**
- Create: `server/src/workflows/parser.rs` ← `git mv server/src/scheduler/parser.rs`
- Create: `server/src/workflows/mod.rs` (stub: `pub mod parser;` + the constants table)
- Test: the parser's own inline `#[cfg(test)]` module travels with it, unchanged.

**Interfaces:**
- Produces: `parser::parse`, `recurrence.next_after`, and `preview_runs(expr, count)` (moved from `scheduler/mod.rs:559`).

**Dependencies:** T1.2. **Parallel with T2.2.**

- [ ] **Step 1: `git mv` the file, then fix the module path and delete `SHELL_TIMEOUT`**

The only permitted content edits: drop the `SHELL_TIMEOUT` const (dies with `execute_shell`), and re-path `use crate::scheduler::…` → `use crate::workflows::…`. **Every test in the file must survive.**

- [ ] **Step 2: Move `preview_runs` from `scheduler/mod.rs:559` into `workflows/mod.rs`, verbatim**

- [ ] **Step 3: Add the constants table to `workflows/mod.rs`**

```rust
const TICK_INTERVAL: Duration = Duration::from_secs(10);
const MISSED_WINDOW: chrono::Duration = chrono::Duration::seconds(60);
const ONESHOT_GRACE: chrono::Duration = chrono::Duration::hours(6);
pub const DEFAULT_STEP_TIMEOUT: i64 = 1800;   // today's DEFAULT_WATCH_TIMEOUT
pub const MAX_WORKFLOWS_PER_SESSION: usize = 20;
pub const MAX_STEPS_PER_WORKFLOW: usize = 20;
pub const MAX_STEPS_VIA_HOOK: usize = 5;
```

- [ ] **Step 4: `cargo test --lib workflows::parser`** — same count as before the move.

- [ ] **Step 5: Commit**

---

### Task 2.2: `engine::deliveries` — the pure function, with every runner test ported

**Intent:** Build the delivered bytes for one step as a pure, unit-tested function. This is the descendant of `runner::deliveries` (`scheduler/runner.rs:460`) and it carries all five of its escaping/defanging tests forward.

**Files:**
- Create: `server/src/workflows/engine.rs` (this task writes only the pure half)
- Test: inline `#[cfg(test)]` in `engine.rs`
- Read for reference: `scheduler/runner.rs:317-500` (the whole wrapper/footer/deliveries block, including its 10 tests at `:623-770`), `web/src/components/chat/composer-insert.ts:91` (`attachmentSentence`)

**Interfaces:**
- Produces:
  ```rust
  pub const SCHEDULE_TAG: &str = "supermux-schedule";          // MOVED, string unchanged
  pub const CONFIRM_FOOTER_SENTINEL: &str = "— — —";           // MOVED, unchanged
  pub fn wrap_schedule(id: &str, title: &str, prompt: &str) -> String;   // moved verbatim
  pub fn escape_attr(s: &str) -> String;                                  // moved verbatim
  pub fn unescape_attr(s: &str) -> String;                                // moved verbatim
  pub fn step_title(wf: &Workflow, step: &WorkflowStep, k: usize, n: usize) -> String;
  pub fn attachment_sentence(paths: &[String]) -> String;
  pub fn connector_sentence(ids: &[String]) -> String;
  pub fn confirm_footer(run_id: i64, session: &str) -> String;
  /// Returns (sent_bytes, preview_text) pairs — command line first, prompt line second.
  pub fn deliveries(wf: &Workflow, step: &WorkflowStep, run_id: i64, k: usize, n: usize)
      -> Vec<(String, String)>;
  ```
- Consumes: `db::workflows::{Workflow, WorkflowStep}`.

**Dependencies:** T1.3. **Parallel with T2.1.**

- [ ] **Step 1: Port the five existing runner tests, renamed to the new function**

From `scheduler/runner.rs:655-770`, keep every one:
`delivery_lines_command_then_prompt`, `delivery_lines_command_only`, `delivery_lines_prompt_only`, `delivery_lines_trims_and_drops_blank`, `wrap_schedule_escapes_the_title_attribute`, `wrap_schedule_defangs_a_body_that_tries_to_break_out`, `wrap_schedule_leaves_ordinary_prose_and_other_markup_alone`, `deliveries_wrap_the_prompt_and_leave_the_command_alone`, **`deliveries_keep_the_preview_free_of_wrapper_and_footer`** (the honesty test — the preview a user sees via `last-send-recall.tsx` must never contain the wrapper, the footer, or the attachment sentence), `deliveries_without_the_wrapper_are_todays_bytes`, `truncate_does_not_panic_on_multibyte_boundary`.

- [ ] **Step 2: Add the four new tests**

```rust
#[test]
fn the_attachment_sentence_is_byte_identical_to_the_web_helper() {
    // web/src/components/chat/composer-insert.ts::attachmentSentence:
    // quoted absolute paths, single-space separated, ONE trailing space.
    assert_eq!(
        attachment_sentence(&["/d/uploads/a.pdf".into(), "/d/uploads/b.png".into()]),
        "\"/d/uploads/a.pdf\" \"/d/uploads/b.png\" "
    );
}

#[test]
fn the_connector_sentence_is_built_only_from_validated_ids() {
    assert_eq!(
        connector_sentence(&["gmail".into(), "github".into()]),
        "Use these connectors for this step: gmail, github. You may use others if needed."
    );
    assert_eq!(connector_sentence(&[]), "");   // no ids → no sentence at all
}

#[test]
fn the_step_title_carries_the_position_and_survives_escaping() {
    // "Weekly report · step 2/4 — Draft the summary", and a title containing
    // a quote or a '<' comes back escaped by escape_attr.
}

#[test]
fn the_confirm_footer_is_unconditional_and_targets_the_step_done_hook() {
    // every step's LAST line carries it; it names /api/hook/workflow/step-done
    // and carries run_id + session. (confirm_finish was opt-in; in a chain the
    // done-edge is load-bearing, so it is now always on.)
}
```

- [ ] **Step 3: Run and confirm failure**

```bash
cd server && OPENSSL_NO_VENDOR=1 OPENSSL_LIB_DIR=/usr/lib/x86_64-linux-gnu cargo test --lib workflows::engine
```

- [ ] **Step 4: Implement, transcribing from `runner.rs`**

Order inside `deliveries` (spec §3.3.2): `command` (trimmed, non-empty) as its **own bare submission, never wrapped** — wrapping a slash line stops Claude executing it as a slash command; then the `prompt` line + attachment sentence + connector sentence + confirm footer, the whole thing wrapped. `preview` is the plain line only.

- [ ] **Step 5: Run tests green, commit**

---

### Task 2.3: `engine::start` / `advance` / `watch_step` — the chain

**Intent:** The linear chain: `send step k → await (idle-edge | agent-confirm | timeout) → record → k+1`.

**Files:**
- Modify: `server/src/workflows/engine.rs`
- Create: `server/tests/workflows_chain.rs`
- Create: `server/tests/archive_workflow_contract.rs` ← port of `archive_schedule_contract.rs`
- Read for reference: `scheduler/watch.rs:55-78` (the fire guard), `:92-180` (the poll loop — **only the idle-edge tier survives**), `server/src/state.rs:1599` (`status_watch_for`), `sessions/lifecycle.rs:2060` (`send_harness_text`), `db/sessions.rs:383` (`exists_active`)

**Interfaces:**
- Produces:
  ```rust
  pub enum Trigger { Tick, Manual, Agent }
  pub async fn start(state: &AppState, wf: Workflow, trigger: Trigger) -> Result<i64, AppError>;
  async fn advance(state: &AppState, run_id: i64, k: usize);
  async fn watch_step(state: &AppState, run_id: i64, step: &WorkflowStep, baseline: u64) -> StepSignal;
  pub async fn cancel(state: &AppState, run_id: i64) -> Result<(), AppError>;
  pub async fn confirm_step_done(state: &AppState, run_id: i64, session: &str);  // the hook entry point
  ```
- Consumes: T2.2's `deliveries`, T1.3's db layer, T2.6's `complete::fire` (stub it as `None` until T2.6 lands).

**Dependencies:** T2.1 + T2.2. **Sequential** — T2.4/T2.5/T2.6 fan out after it.

- [ ] **Step 1: Write `tests/workflows_chain.rs` — five cases, all failing**

```rust
#[tokio::test]
async fn a_three_step_chain_advances_only_on_the_idle_edge() {
    // Assert step 2's text is NOT in the pane before step 1's idle edge fires.
    // This is the single most important assertion in the file: it proves the
    // chain is edge-driven, not timer-driven.
}

#[tokio::test]
async fn a_step_timeout_halts_the_chain_loudly() {
    // step 2 times out → step_run status='timeout', run status='timeout',
    // step 3 is NEVER delivered, one ScheduleError-category push is raised.
}

#[tokio::test]
async fn archiving_the_session_mid_chain_halts_with_a_readable_skip_and_never_starts_it() {
    // run status='skipped', note contains "session archived mid-workflow",
    // and the session is still archived afterwards (never resurrected).
}

#[tokio::test]
async fn two_due_ticks_while_a_run_is_in_flight_produce_one_skipped_run_not_a_second_chain() {
    // the §3.2 rule-2 guard. next_run still advances.
}

#[tokio::test]
async fn the_idle_edge_and_the_agent_hook_cannot_both_advance_the_same_step() {
    // per-RUN_ID fire guard. Fire both; exactly one advance happens.
    // And: a SECOND run of the same recurring workflow must still be able to fire
    // (the guard is run_id-scoped, not workflow-scoped).
}
```

- [ ] **Step 2: Port `archive_schedule_contract.rs` → `archive_workflow_contract.rs`**

All three cases survive verbatim in spirit, including **the negative one** — no caller may bypass `send_harness_text`'s archive refusal. Rename the fixtures, not the assertions.

- [ ] **Step 3: Run both; confirm they fail**

- [ ] **Step 4: Implement `start` / `advance`**

`advance(k)`, in this exact order (§3.3):
1. **Guards** — `db::sessions::exists_active(session)`. Archived → step `skipped`, run `skipped`, note `"…is archived — its workflows are paused until you unarchive it"`. Gone → `skipped`. This guard is why the runner does not push a phone notification every tick for a deleted session; do not weaken it.
2. **Build** — `engine::deliveries(...)` from T2.2. File paths and connector ids are re-resolved **server-side at fire time** from `step.files` / `step.connectors`, so a stale client cannot smuggle a different shape. An id that no longer resolves is dropped from the sentence and **noted on the step run**.
3. **Subscribe BEFORE the send** — `let mut rx = state.status_watch_for(session); let baseline = rx.borrow().1;` Capturing the baseline *after* the send is a race that fires on the session's pre-existing idle. `watch.rs` carries the comment explaining this; carry it across.
4. **Send** — `sessions::lifecycle::send_harness_text(state, session, &sent, Some(&preview), None)`. A send error → step `error`, run `error`, chain halts, `ScheduleError` push.
5. **Watch** — `tokio::select!` on `rx.changed()` vs `tokio::time::sleep(timeout_secs)`.
   - `status == "idle" && version != baseline` → **done**.
   - `waiting` is explicitly **not** done — a session blocked on the user is the opposite of finished. It does not advance, and the step's timeout keeps running.
   - Sender dropped (session deleted mid-watch) → run `interrupted`.
   - **No `done_pattern` polling, no `capture-pane` shell-out, no `tail_anchor`, no `delta`.** Those three functions (`watch.rs:181,193,205`) are deleted in Phase 4, not ported here.
6. **Fire guard** — a per-`run_id` `HashSet` claim, the same fail-open-on-poisoned-lock rule as `watch.rs::claim_fire` (`:70`): a missed dedup is a duplicate ping, never a lost one.
7. **Record + advance** — close the step run (`ok`, `signal`), `bump_heartbeat`, fire the step's own `on_complete` if set, then `advance(k+1)` or finish.
8. **Finish** — run `ok` + `finished_at`, then the workflow's `on_complete`, then cadence: `Trigger::Tick` → `record_fire` (NULL `next_run` disables a finished one-shot); `Trigger::Manual` → `record_manual` (**never** touches `next_run` — the tick owns cadence).

- [ ] **Step 5: Run `workflows_chain`, `archive_workflow_contract`, and the untouched `wait_race` / `status_flow` suites**

- [ ] **Step 6: Commit**

---

### Task 2.4: The tick loop — `workflows::spawn`

**Intent:** A 10 s interval that dispatches due workflows, preserving the missed-window and one-shot-grace semantics exactly.

**Files:**
- Modify: `server/src/workflows/mod.rs`
- Modify: `server/src/main.rs:153` (`scheduler::spawn` → `workflows::spawn`)
- Create: `server/tests/workflow_missed_tick.rs` ← port of `schedule_missed_tick.rs`
- Read for reference: `scheduler/mod.rs:58-160` (`spawn` + `tick_once`)

**Dependencies:** T2.3. **Parallel with T2.5 and T2.6.**

- [ ] **Step 1: Port `schedule_missed_tick.rs`**

Both cases, unchanged in spirit: `missed_window_skips_and_advances_without_firing`, `fire_key_is_idempotent`.

- [ ] **Step 2: Add the one-run-at-a-time case** (it is the new rule §3.2/2 — assert it here too, at the tick level, not only at the engine level)

- [ ] **Step 3: Run; confirm failure**

- [ ] **Step 4: Implement**

`tokio::time::interval` with **`MissedTickBehavior::Skip`** — load-bearing: `Burst` fires every missed tick at once after a laptop sleep. Per due workflow, in order: parse `next_run` (skip if future) → the one-run-at-a-time guard → missed-window / one-shot-grace logic copied from `scheduler::tick_once` **including the `claim_run_key`-first ordering** (claiming before the skip is what distinguishes genuine downtime from an in-flight long job) → `engine::start(state, wf, Trigger::Tick)` → the reaper (T2.5).

The SSE `alerts` frame is now **company-stamped** via `SseEvent::for_company(…, wf.company_id)` (`state.rs:193`). Today every scheduler frame is `company_id: None`, i.e. owner-only, so a company member never sees their own bot's schedule fire.

- [ ] **Step 5: Run `workflow_missed_tick` + `workflows_chain`**

- [ ] **Step 6: Commit**

---

### Task 2.5: The reaper

**Intent:** Watchers are in-memory tokio tasks. A restart mid-watch loses the watcher; today the `done_action` silently never fires, and in a chain the run would sit `running` forever and block the workflow from ever firing again (§3.2 rule 2). The reaper makes that failure honest and self-healing.

**Files:**
- Modify: `server/src/workflows/engine.rs` (add `pub async fn reap(state: &AppState)`)
- Create: `server/tests/workflows_reaper.rs`

**Dependencies:** T2.3. **Parallel with T2.4 and T2.6.**

- [ ] **Step 1: Write the failing test**

```rust
#[tokio::test]
async fn a_run_whose_heartbeat_went_stale_is_reaped_to_interrupted_and_the_workflow_fires_again() {
    // heartbeat = now - (timeout + 61) → next tick reaps it:
    //   run.status='interrupted', the open step_run is closed 'interrupted',
    //   ONE ScheduleError-category push whose text names the step:
    //     "'Weekly report' was interrupted at step 2 of 4"
    // then the workflow's NEXT cadence fires normally (rule 2 no longer blocks).
}

#[tokio::test]
async fn a_fresh_running_run_is_not_reaped() { /* the negative */ }
```

- [ ] **Step 2: Run; confirm failure**

- [ ] **Step 3: Implement** — `db::workflows::stale_running` (from T1.3) driving the query in spec §3.6; call `reap` on every tick **and once at boot**.

- [ ] **Step 4: Run `workflows_reaper` + `workflow_missed_tick`**

- [ ] **Step 5: Commit**

---

### Task 2.6: `complete.rs` — the five typed completion actions

**Intent:** The curated replacement for `done_action: command:<text>`. This is the unit that keeps the dragon dead: `engine` never formats a message, it calls `complete::fire(state, &run, &action)` with a **typed enum**.

**Files:**
- Create: `server/src/workflows/complete.rs`
- Create: `server/tests/workflows_completion.rs`
- Read for reference: `server/src/scope.rs:314` (`authorize_connector_target`), `server/src/agents/delegate.rs:234` (`deliver_delegation`), `server/src/db/push.rs:91-129` (the `NotifCategory` enum — **do not rename its DB values**)

**Interfaces:**
- Produces:
  ```rust
  #[derive(Serialize, Deserialize)]
  #[serde(tag = "kind", rename_all = "snake_case")]
  pub enum CompletionAction {
      None,
      Notify,
      Disable,
      ConnectorSend { connector_id: String, account_ref: String, to: String, subject: Option<String> },
      MessageBot   { session: String },
  }
  pub enum CompletionOutcome { Nothing, Notified, Disabled, Asked(String), Failed(String) }
  pub async fn fire(state: &AppState, run: &WorkflowRun, action: &CompletionAction) -> CompletionOutcome;
  pub fn parse(json: &str) -> Result<CompletionAction, AppError>;   // unknown kind → 400
  ```

**Dependencies:** T2.3. **Parallel with T2.4 and T2.5.**

- [ ] **Step 1: Write `tests/workflows_completion.rs`, failing**

```rust
#[tokio::test]
async fn connector_send_with_a_revoked_grant_errors_the_run_and_pushes_never_silently_skips() {
    // grant exists at save time, revoked before the run finishes →
    //   run.status='error', note names the connector, ONE push. Not a skip.
}

#[tokio::test]
async fn message_bot_to_another_company_is_refused() {
    // scope.sees() says no → CompletionOutcome::Failed, run 'error', nothing delivered.
}

#[tokio::test]
async fn the_hook_path_400s_on_connector_send_and_on_message_bot() {
    // a session token must not be able to arm something that emails the world.
}

#[tokio::test]
async fn an_unknown_completion_kind_is_a_400_not_a_default() {
    // parse(r#"{"kind":"command","text":"rm -rf /"}"#) → Err(BadRequest)
}

#[test]
fn the_connector_instruction_is_built_only_from_typed_fields() {
    // every substituted value comes from a validated field; assert the exact
    // sentence shape and that no operator free-text can reach it.
}
```

- [ ] **Step 2: Run; confirm failure**

- [ ] **Step 3: Implement the five arms**

- `None` — nothing.
- `Notify` / `Disable` — direct ports of today's `done_action`, reusing the **existing** `NotifCategory::ScheduleFinished` / `ScheduleError` variants.
- `MessageBot { session }` — `agents::delegate::deliver_delegation(state, &wf.session, &session, &summary, None)`, scope-checked (same company via `scope.sees`). **No text field:** the body is the server-generated run summary.
- `ConnectorSend { … }` — appended as a **synthetic final step** whose prompt the server builds from the typed fields:

  > `Use the <Gmail> connector (account sander@acme.com) to send the summary of this workflow run to sander@example.com with subject "Weekly report". Do not include anything else.`

  Four guardrails, all asserted: (1) every substituted value is a typed, validated field — connector id exists, `account_ref` belongs to it, `to` matches the connector's target shape; (2) the grant is checked at save time **and** re-checked at fire time via `scope::authorize_connector_target`, and a revoked grant is an `error` + push, **never a silent skip**; (3) the instruction is defanged and wrapped like any other step body; (4) it is a hard 400 on the agent hook path.

- **HONESTY:** the returned `CompletionOutcome::Asked(_)` string, and every UI string built from it, says **"asked scout to send via Gmail"** — never "sent". The server has no MCP client; it cannot send anything itself.

- [ ] **Step 4: Run `workflows_completion` + `workflows_chain`**

- [ ] **Step 5: Commit**

---

## Phase 3 — API

*T3.1 and T3.3 need only Phase 1 + T2.1, so they can start **alongside Phase 2**. T3.2/T3.5 need T2.3. T3.4/T3.6/T3.7 fan out after T3.1.*

**Existing test that must be ported here:** `server/tests/scheduler.rs` → `server/tests/workflows_http.rs`.
Cases that survive, retargeted: `http_crud_roundtrip`, `bearer_schedule_writers_refuse_wrapper_markup`, `preview_returns_next_runs_without_persisting`, `commands_endpoint_excludes_builtins_and_requires_auth`, `job_accepts_command_or_prompt_and_rejects_neither`, `requires_auth`, `run_history_keeps_the_newest_twenty_per_schedule`.
Cases that **die with the feature** (they prove capabilities being deleted — do not resurrect them): `in_one_second_shell_job_fires`, `test_fire_runs_once_and_does_not_persist`.

### Task 3.1: `/api/workflows` CRUD + the single validation funnel

**Intent:** One router, one validator, two callers (HTTP and hook) — today's shape.

**Files:**
- Modify: `server/src/workflows/mod.rs` (add `router_for`, handlers, `create`)
- Modify: `server/src/http.rs:177` (merge `workflows::router_for` where `scheduler::router_for` sits)
- Create: `server/tests/workflows_http.rs`
- Read for reference: `scheduler/mod.rs:167` (`router_for` — static segments registered alongside `{id}`, axum prioritises static), `:253` (`create` — the validation funnel template), `:455` (`audit_schedule_create`)

**Interfaces:**
- Produces:
  ```
  GET    /api/workflows              ?session=&company_id=&include_disabled=  → [WorkflowRow] (steps inlined)
  POST   /api/workflows              → 201
  GET    /api/workflows/{id}         → WorkflowRow + steps + last run summary
  PATCH  /api/workflows/{id}         title | enabled | trigger | on_complete  (never session, never company_id)
  PUT    /api/workflows/{id}/steps   replace the ordered list atomically → steps[]
  DELETE /api/workflows/{id}         soft delete
  ```
  plus `pub async fn create(state: &AppState, input: CreateWorkflowInput) -> Result<Workflow, AppError>` — the funnel the hook also calls.
- Envelope `{ok, data}` unchanged.

**Dependencies:** T1.3, T2.1. **Parallel with all of Phase 2.**

- [ ] **Step 1: Port `scheduler.rs`'s surviving cases into `workflows_http.rs`, plus five new ones**

```rust
#[tokio::test]
async fn a_step_may_not_reference_a_path_outside_the_uploads_jail() {
    // files[].path must canonicalise under <data_dir>/uploads/ → 400 otherwise.
}

#[tokio::test]
async fn wrapper_markup_is_refused_in_the_title_and_in_every_step_field() {
    // reject_wrapper_markup over title + each step's title/prompt/command.
    // Reason: a prompt that closes its own <supermux-schedule> wrapper can forge
    // a <supermux-delegation from="…"> at top level. Non-negotiable.
}

#[tokio::test]
async fn the_caps_hold_at_the_boundary() {
    // 20 workflows per session → the 21st is 429 with actionable text.
    // 20 steps per workflow → the 21st is 400.
}

#[tokio::test]
async fn put_steps_replaces_the_list_atomically_and_leaves_run_history_alone() {}

#[tokio::test]
async fn company_id_is_never_taken_from_the_client() {
    // POST with company_id:99 against a session in company 3 → row says 3.
    // PATCH cannot reassign session OR company_id.
}
```

- [ ] **Step 2: Run; confirm failure**

- [ ] **Step 3: Implement**

The validation funnel, in `workflows::create`, called by the HTTP handler **and** the hook:
`reject_wrapper_markup` over title + every step field · `on_complete` through `complete::parse` (unknown kind → 400; no free-text field exists) · `files[].path` canonicalised under `<data_dir>/uploads/` · `connectors[]` ids exist and are granted to `session` at save time (**warn, do not hard-fail**, if a grant disappears later — the chip renders "not connected" in the UI) · the two caps.

Register static segments (`/preview`, `/commands`, `/runs`) alongside `{id}`, exactly as `scheduler::router_for` does.

Also port `audit_schedule_create` → `audit_workflow_create`.

- [ ] **Step 4: Run `workflows_http`**

- [ ] **Step 5: Commit**

---

### Task 3.2: Run-now, cancel, runs, activity feed

**Intent:** Chains need a start button, a stop button and a visible history.

**Files:** Modify `server/src/workflows/mod.rs`; extend `server/tests/workflows_http.rs`

**Interfaces:**
```
POST /api/workflows/{id}/run     → 202 { run_id }
POST /api/workflows/{id}/cancel  → 202                  (NEW — chains need a stop button)
GET  /api/workflows/{id}/runs    ?limit=20 → [Run + step rows]
GET  /api/workflows/runs         cross-workflow activity feed (limit 50)
```

**Dependencies:** T3.1 + T2.3. **Parallel with T3.4–T3.7.**

- [ ] **Step 1: Write the failing tests**

```rust
#[tokio::test]
async fn run_now_is_a_202_that_does_not_touch_next_run() {
    // Trigger::Manual: no fire-key claimed, cadence untouched, run_id returned.
}

#[tokio::test]
async fn cancel_stops_the_in_flight_run_and_the_next_step_is_never_delivered() {
    // run.status='cancelled', open step_run closed, step k+1 absent from the pane.
}

#[tokio::test]
async fn the_activity_feed_is_scope_filtered() {
    // a member sees only their company's runs.
}
```

- [ ] **Step 2: Run; confirm failure. Step 3: implement. Step 4: green. Step 5: commit.**

---

### Task 3.3: `preview` + `commands` — verbatim ports

**Intent:** The next-5-runs preview is one of the few genuinely good bits of today's UI. Move it, don't redesign it.

**Files:** Modify `server/src/workflows/mod.rs`; extend `server/tests/workflows_http.rs`

**Interfaces:** `POST /api/workflows/preview { expression } → { next_runs: [rfc3339 × 5] }` · `GET /api/workflows/commands ?cwd= → installed skills / commands / MCP`

**Dependencies:** T2.1. **Parallel with T3.1** (different handler block; coordinate the single `router_for` edit by landing T3.1 first).

- [ ] **Step 1: Port `preview_returns_next_runs_without_persisting` and `commands_endpoint_excludes_builtins_and_requires_auth`, retargeted.**
- [ ] **Step 2: Run; fail. Step 3: move the handler bodies verbatim. Step 4: green. Step 5: commit.**

---

### Task 3.4: Scope — `member_may_reach` + uniform 404

**Intent:** Without the allowlist entry a company member gets a blanket 403 on their own bot's workflows.

**Files:**
- Modify: `server/src/scope.rs:196` (`member_may_reach`)
- Test: extend `server/tests/scope_p3b.rs` and `server/tests/role_p3d.rs`

**Dependencies:** T3.1. **Parallel with T3.2/T3.5/T3.6/T3.7.**

- [ ] **Step 1: Write the failing tests**

```rust
#[tokio::test]
async fn a_member_may_reach_the_workflows_api() {
    assert!(member_may_reach(&Method::GET,  "/api/workflows"));
    assert!(member_may_reach(&Method::POST, "/api/workflows"));
    assert!(member_may_reach(&Method::GET,  "/api/workflows/WF-1/runs"));
    // segment boundary: "/api/workflowsx" must NOT be admitted (`under()` semantics).
}

#[tokio::test]
async fn another_companys_workflow_is_a_uniform_404_never_a_403() {
    // a member must not be able to PROVE a row exists — sessions/mod.rs's rule.
}
```

- [ ] **Step 2: Run; fail. Step 3: add `if under(path, "/api/workflows") { return true }` with a comment naming the scope layer that does the real filtering. Step 4: green. Step 5: commit.**

---

### Task 3.5: `workflows/hook.rs` — preserved wholesale, plus the two legacy aliases

**Intent:** `scheduler/hook.rs` is the narrowest endpoint in the codebase. **Every guarantee carries over byte-for-byte**, and the two legacy routes stay registered *permanently* because live panes already hold footers naming them.

**Files:**
- Create: `server/src/workflows/hook.rs` ← `git mv server/src/scheduler/hook.rs`, retyped
- Modify: `server/src/http.rs:74`
- Create: `server/tests/workflow_hook_create.rs` ← port of `schedule_hook_create.rs`

**Interfaces:**
```
POST /api/hook/workflow/step-done   { session, run_id }      (new canonical)
POST /api/hook/workflow/create      (new canonical)
POST /api/hook/schedule/done        → resolves schedule_id AS a workflow id → step-done
POST /api/hook/schedule/create      → workflow create with steps:[{prompt}]
```

**Dependencies:** T3.1 + T2.3. **Parallel with T3.2/T3.4/T3.6/T3.7.**

- [ ] **Step 1: Port all 16 cases of `schedule_hook_create.rs` verbatim in spirit**

The negatives-first matrix is the point. Keep every one:
`a_session_may_not_schedule_for_another_session` · `no_token_no_schedule` · `the_dashboard_bearer_buys_nothing_on_a_hook_route` · `a_prefix_of_the_real_token_is_not_the_real_token` · `a_session_with_no_stored_token_can_never_be_authenticated_as` · `a_session_that_does_not_exist_is_unauthorized_not_a_500` · `a_session_token_may_not_become_host_command_execution` · `the_fields_that_reach_beyond_the_pane_are_refused_by_name` · `wrapper_markup_is_refused_in_the_title_and_in_the_prompt` · `the_required_fields_are_required_and_the_grammar_is_the_servers` · `the_per_session_cap_holds_at_the_boundary_and_is_scoped_to_the_session` · `a_session_scheduling_its_own_prompt_lands_and_narrates_itself` · `notify_is_the_other_done_action_an_agent_may_choose` · `the_hook_route_is_outside_the_bearer_layer_and_the_admin_routes_are_not` · `the_documented_curl_d_form_creates_a_schedule` · `the_done_hook_takes_the_documented_curl_d_form_too` · `a_body_that_is_not_json_is_a_readable_400_not_a_bare_415`.

- [ ] **Step 2: Add the four new cases**

```rust
#[tokio::test]
async fn the_legacy_alias_enforces_the_identical_forced_fields() {
    // POST /api/hook/schedule/create through the alias == the canonical route,
    // including the refusal sentences.
}

#[tokio::test]
async fn a_hook_created_workflow_may_hold_at_most_five_steps() {
    // 5 → ok, 6 → 400. (v1 lets an agent chain its own follow-ups; the
    // single-prompt form stays the default.)
}

#[tokio::test]
async fn on_complete_connector_send_and_message_bot_are_400_on_the_hook_path() {}

#[tokio::test]
async fn the_legacy_done_route_resolves_a_sched_id_as_a_workflow_id() {
    // ported rows keep their SCHED-… id, so no mapping table is needed.
    // A footer already sitting in a live pane must still work.
}
```

- [ ] **Step 3: Run; fail. Step 4: implement.**

Preserved properties, each with its existing comment carried across:
- Scope is **structural, not checked** — the row's `session` **is** the authenticated one; a payload `session` authenticates and is then discarded, so there is no check for a refactor to drop.
- Constant-time hook-token compare against `session_runtime.hook_token`; a bearer token cannot drive it.
- `LenientJson` (content-type agnostic) — the documented `curl -d` default is `x-www-form-urlencoded`, and `axum::Json` answers that with a bare 415 the agent cannot read.
- Refused **with a sentence**, never silently dropped: `kind`, `command`, `boot_*`, `bypass_permissions`, `_test_fire`. Most of those fields no longer exist; **the refusals stay** so an old payload gets a legible answer rather than a surprise.
- `on_complete` limited to `none` | `notify` | `disable`.
- `MAX_WORKFLOWS_PER_SESSION = 20`, answered **429** with actionable text.
- No natural-language parsing server-side — the agent brings a concrete `schedule_expr` from the grammar the skill teaches, validated by the same `parser::parse` the bearer path uses.

- [ ] **Step 5: Green; commit.**

---

### Task 3.6: `/api/schedules` — read-shim + `410 Gone` on writes

**Intent:** The PWA can be wedged on a stale bundle (it has happened here). A stale client must render a correct, if simplified, list instead of crashing — and must never mutate through a dead contract.

**Files:**
- Create: `server/src/workflows/shim.rs`
- Modify: `server/src/http.rs` (merge `shim::router_for`)
- Test: extend `server/tests/workflows_http.rs`

**Dependencies:** T3.1. **Parallel with T3.2/T3.4/T3.5/T3.7.**

- [ ] **Step 1: Write the failing tests**

```rust
#[tokio::test]
async fn the_old_get_routes_serve_a_derived_read_only_projection() {
    // GET /api/schedules, /{id}, /{id}/runs → the old Schedule JSON shape,
    // built FROM WORKFLOWS: kind always "tmux", done_action mapped back,
    // command/prompt from step 0.
}

#[tokio::test]
async fn every_write_verb_is_410_gone_with_the_reload_sentence() {
    // POST/PATCH/DELETE /api/schedules, /run, /preview, /commands → 410 with
    // {ok:false, error:"Schedules were replaced by Workflows — reload supermux to continue."}
    // NOT a 307/308: a redirect on POST re-plays a mutating body against a
    // different contract.
}
```

- [ ] **Step 2: Run; fail. Step 3: implement (the shim reads the NEW tables — the old ones are gone). Step 4: green.**

- [ ] **Step 5: Write the deletion reminder**

Add to the module doc: `// DELETE THIS MODULE in the release after v1 ships. Tracked: spec §5.2.`

- [ ] **Step 6: Commit**

---

### Task 3.7: SSE — the `workflows` event, company-stamped

**Intent:** Make a company member able to see their own bot's workflow fire. Today every scheduler frame is `company_id: None` (owner-only).

**Files:**
- Modify: `server/src/workflows/mod.rs` + `engine.rs` (emit sites), `server/src/sse.rs` if the event list is enumerated there
- Modify: `web/src/hooks/use-sse.ts:70` (`SSE_NAMED_EVENTS` — add `'workflows'`)
- Test: extend `server/tests/workflows_http.rs`; `web/tests/unit/sse-events.test.ts`

**Dependencies:** T3.1. **Parallel with T3.2/T3.4/T3.5/T3.6.**

- [ ] **Step 1: Write the failing tests**

```rust
#[tokio::test]
async fn every_workflow_frame_is_company_stamped() {
    // SseEvent::for_company(…, wf.company_id) on BOTH the `workflows` frames
    // and the `alerts` frames, which now carry source:"workflow" + run_id + step.
}
```

```ts
// web/tests/unit/sse-events.test.ts — add 'workflows' to the named-event assertion
```

- [ ] **Step 2: Run; fail. Step 3: implement. Step 4: green. Step 5: commit.**

---

## Phase 4A — Server removals

*One agent, sequential, after all of Phase 3. Phase 4B (web) waits for Phases 5 + 6.*

### Task 4A.1: Delete the dragon and prove it stays dead

**Intent:** The removal must be real, not a UI removal.

**Files:**
- Delete: `server/src/scheduler/` (all five files), `server/src/db/schedules.rs`
- Delete: `server/tests/scheduler.rs`, `schedule_hook_create.rs`, `schedule_missed_tick.rs`, `archive_schedule_contract.rs` (their successors are green)
- Modify: `server/src/db/mod.rs`, `server/src/sessions/recall.rs:27,2003`, `server/src/agents/delegate.rs:71,154`, `server/src/push.rs:429-430`, `server/src/main.rs`, `server/src/http.rs`
- Create: `server/tests/workflows_removals.rs`

**Dependencies:** all of Phase 3. **Sequential.**

- [ ] **Step 1: Write `tests/workflows_removals.rs` — the keep-list-inverse, in the `board-removal-keeplist.test.ts` idiom**

```rust
// A source scan, not a behaviour test. It is the ratchet that stops the dragon
// growing back in a later refactor.

#[test]
fn the_dragon_strings_do_not_appear_under_server_src_workflows() {
    for needle in [
        "execute_shell", "execute_boot", "worktree_is_dirty", "boot_session_name",
        "bypass_permissions", "done_pattern", "done_action LIKE 'command:'",
        "starts_with(\"command:\")", "tail_anchor", "synth_expr",
    ] { /* assert absent from every file under server/src/workflows/ */ }
}

#[test]
fn the_scheduler_module_and_its_db_layer_are_gone() {
    // server/src/scheduler/ and server/src/db/schedules.rs do not exist.
}

#[test]
fn the_two_legacy_hook_routes_are_still_registered() {
    // POST /api/hook/schedule/done  → not 404
    // POST /api/hook/schedule/create → not 404
    // Live panes hold footers naming these literal URLs. PERMANENT.
}

#[test]
fn the_notif_category_db_values_are_unchanged() {
    // "schedule_error" and "schedule_finished" still serialise from
    // NotifCategory::{ScheduleError, ScheduleFinished}. A renamed category
    // silently un-mutes a user who muted it.
}
```

- [ ] **Step 2: Run; confirm the first two fail (the module still exists) and the last two pass.**

- [ ] **Step 3: Delete, re-point, and note what does NOT change**

`server/src/sessions/mod.rs` — **no change.** `CreateInput.bypass_permissions` stays; the create panel and the Shift+Tab toggle use it. Only the *scheduler's* call site goes.
`server/src/push.rs:429-430` — relabel the **UI strings only** ("Workflow errored" / "Workflow finished"); the `NotifCategory` DB values are frozen.
`recall.rs` / `delegate.rs` — re-point the `SCHEDULE_TAG` / `escape_attr` / `wrap_schedule` imports at `workflows::engine`. The **strings are unchanged**, so no transcript re-renders differently.

- [ ] **Step 4: Full server suite**

```bash
cd server && OPENSSL_NO_VENDOR=1 OPENSSL_LIB_DIR=/usr/lib/x86_64-linux-gnu cargo test 2>&1 | tail -40
```

- [ ] **Step 5: Commit**

```bash
git commit -m "refactor(workflows)!: delete the scheduler module — shell, boot, bypass_permissions, command: and done_pattern are gone

BREAKING: kind='shell'/'boot' jobs, done_action 'command:<text>', done_pattern
and the scheduler's bypass_permissions clamp no longer exist. The two legacy
hook routes stay registered permanently."
```

---

## Phase 5 — Web: the Workflows surface

*Starts as soon as **T3.1** lands, i.e. alongside Phase 2/3. Up to four agents in parallel once T5.1+T5.2 are in.*

**Existing tests that must be kept green (not deleted until Phase 4B):**
`web/tests/unit/schedules-section.test.tsx` (its two describes — *"every column of the old table survives the fold"* and *"the section wires every slot"* — are the **anti-drop contract** T5.3 re-expresses against the new list) · `session-schedules.test.tsx` · `schedule-href.test.ts` · `sheet-inventory.test.ts` · `tour-anchors.test.ts` · `chat-wrapper-parity.test.ts` · `sse-events.test.ts`.

### Task 5.1: `lib/api/workflows.ts` + `hooks/use-workflows.ts`

**Intent:** Transport and cache. Holds no layout state; nothing else in the app calls `fetch`.

**Files:**
- Create: `web/src/lib/api/workflows.ts`, `web/src/hooks/use-workflows.ts`
- Modify: `web/src/lib/api/index.ts`
- Test: `web/tests/unit/use-workflows.test.ts` (new)
- Read for reference: `web/src/lib/api/scheduler.ts` (the template — **drop its dead "stub domain types" block at the head**, lines 17-33), `web/src/hooks/use-scheduler.ts` (the SSE-invalidation pattern at `:138`, `useSchedulerStream`)

**Interfaces:**
- Produces: types `WorkflowRow`, `WorkflowStepRow`, `WorkflowRunRow`, `WorkflowStepRunRow`, `CompletionAction`, `TriggerKind`; `workflowsApi.{list,get,create,patch,replaceSteps,remove,run,cancel,runs,activity,preview,commands}`; hooks `useWorkflows`, `useWorkflow`, `useWorkflowRuns`, `useWorkflowActivity`, `useCreateWorkflow`, `usePatchWorkflow`, `useReplaceSteps`, `useRunWorkflow`, `useCancelRun`, `useDeleteWorkflow`, `useWorkflowsStream`, `useWorkflowCommands`.
- Later tasks rely on these exact names.

**Dependencies:** T3.1. **Parallel with T5.2.**

- [ ] **Step 1: Write the failing test**

```ts
// web/tests/unit/use-workflows.test.ts
it('invalidates on both the workflows event and the workflow-sourced alert', () => {
  // type === 'workflows'  → invalidate
  // type === 'alerts' && payload.source === 'workflow' → invalidate
  // type === 'alerts' && payload.source === 'board'    → do NOT invalidate
})

it('recognises a 410 and triggers the service-worker update prompt', () => {
  // the stale-bundle path from spec §5.2
})
```

- [ ] **Step 2: Run `npx vitest run tests/unit/use-workflows.test.ts`; confirm failure.**
- [ ] **Step 3: Implement, mirroring `use-scheduler.ts`'s focus/visibility resync. Step 4: green. Step 5: commit.**

---

### Task 5.2: Salvage — `cadence.ts`, `workflow-href.ts`, `enable-toggle.tsx`

**Intent:** Three files in `components/scheduler/` are genuinely good. Move them; drop the dead exports.

**Files:**
- Create: `web/src/components/workflows/cadence.ts` ← `components/scheduler/helpers.ts`
- Create: `web/src/components/workflows/workflow-href.ts` ← `components/session-schedules/schedule-href.ts`
- Create: `web/src/components/workflows/enable-toggle.tsx` ← `components/scheduler/enable-toggle.tsx`, retyped to `WorkflowRow`
- Test: `web/tests/unit/workflow-href.test.ts` (port of `schedule-href.test.ts`'s `describe('scheduleAdminHref')`)

**Interfaces:**
- Produces from `cadence.ts`: `describeSchedule`, `exprToRecurrence`, `recurrenceToExpr`, `FREQUENCY_CHIPS`, `WEEKDAYS`, `formatFull`, `scheduleHintParts`. **Dropped:** `KIND_LABEL`, `PROVIDERS`.
- Produces from `workflow-href.ts`: `workflowAdminHref`.

**Dependencies:** none beyond Phase 3 landing. **Parallel with T5.1.**

- [ ] **Step 1: Port `schedule-href.test.ts` → `workflow-href.test.ts`. Step 2: fail. Step 3: move + prune. Step 4: green. Step 5: commit.**

---

### Task 5.3: `WorkflowsView` — the list, with the step rail

**Intent:** The signature surface. One component renders both scopes: `variant="page"` (everything the viewer can see) and `scope={sessionName}` (inside BotPanel) — the pattern `StoreView` already uses with `grantTarget`.

**Files:**
- Create: `web/src/components/workflows/workflows-view.tsx`, `web/src/components/workflows/step-rail.tsx`
- Create: `web/src/routes/workflows.tsx`
- Test: `web/tests/unit/workflows-view.test.tsx`

**Interfaces:**
- Produces: `<WorkflowsView variant="page" | scope={string} />`, `<StepRail steps={n} current={k} status={…} />`.

**Dependencies:** T5.1 + T5.2. **Sequential before T5.4/T6.1; parallel with T5.5.**

- [ ] **Step 1: Write `workflows-view.test.tsx` — the anti-drop test**

Written in `schedules-section.test.tsx`'s idiom. **A capability that vanishes with the redesign fails here.** Assert the new list still offers: title · human cadence · next fire · last fired · the enable toggle · create · edit · run-now · the run log · delete.

```tsx
describe('every capability of the old schedules table survives the redesign', () => {
  it.each([
    'title', 'human cadence', 'next fire', 'last fired',
    'enable toggle', 'create', 'edit', 'run now', 'run log', 'delete',
  ])('%s is reachable on the workflows list', (capability) => { /* … */ })
})

describe('the step rail', () => {
  it('renders one dot per step and marks the current one', () => {})
  it('is aria-hidden and is narrated by an sr-only live region', () => {
    // "step 2 of 4: Draft the summary", aria-live="polite"
  })
  it('stops at the failing dot on error', () => {})
})

describe('the empty state', () => {
  it('offers three tappable starter templates, client-side, no server table', () => {
    // 1. Daily standup digest (2 steps)
    // 2. Weekly report → email it (3 steps, ConnectorSend pre-filled)
    // 3. Inbox triage (2 steps, connector hint pre-filled if the bot has mail granted)
    // Tapping one opens the composer PRE-POPULATED — nobody's first workflow
    // should start at a blank textarea.
  })
})

describe('the row menu', () => {
  it('offers Run now · Duplicate · Pause · Delete, delete behind ArmedButton', () => {})
  it('says "Past runs stay in the log" — the promise the soft delete actually keeps', () => {})
})
```

- [ ] **Step 2: Run; fail. Step 3: implement.**

Layout is spec §6.2. Step rail states: idle = all hollow · running = filled left-to-right, current dot pulsing · done = all filled · error = the failing dot red, rail stops there. **One animated element per card, not four.** Hint line reuses `scheduleHintParts` / `formatFull` from T5.2. Motion from `lib/springs.ts`; `useReducedMotion` honoured.

- [ ] **Step 4: green. Step 5: commit.**

---

### Task 5.4: Nav, routes, command palette, redirects

**Intent:** Make it reachable. `grokOnly: true` — the locked decision.

**Files:**
- Modify: `web/src/components/layout.tsx:94` area (the `NAV` array)
- Modify: `web/src/App.tsx:266-267` (`/scheduler` redirect), `:285` area (route registration)
- Modify: `web/src/components/command-palette/command-palette.tsx:331-336`
- Test: `web/tests/unit/tour-anchors.test.ts` + a new nav assertion in `workflows-view.test.tsx`

**Dependencies:** T5.3. **Sequential.**

- [ ] **Step 1: Write the failing assertions**

```ts
it('Workflows sits immediately after Connectors in NAV and is grokOnly', () => {
  const i = NAV.findIndex((n) => n.to === '/store')
  expect(NAV[i + 1]).toMatchObject({ to: '/workflows', label: 'Workflows', grokOnly: true })
})
```

- [ ] **Step 2: Fail. Step 3: implement.**

```ts
{ to: '/store',     label: 'Connectors', icon: Plug,     grokOnly: true },
{ to: '/workflows', label: 'Workflows',  icon: Workflow, grokOnly: true },   // ← new
```

Routes, lazy, mirroring `/store`:
```
/workflows        → WorkflowsView variant="page"
/workflows/new    → WorkflowComposer (create)
/workflows/:id    → WorkflowDetail (steps read-only + Runs)
/workflows/:id/edit → WorkflowComposer (edit)
```
`App.tsx`: `/scheduler` and `/settings#schedules` both `Navigate to="/workflows" replace`. Command palette: replace the `/settings#schedules` entry with a `/workflows` one, keeping the search keywords (`scheduler cron recurring timer prompt later` **+** `workflow steps chain`).

> **`grokOnly` means the base rail stays 4 items** — no `--nav-n` / `data-tab-count` / Liquid-Pill geometry respec is needed. Still screenshot the **grok** phone rail at 390 px and 320 px in T5.10, because grok goes 4 → 5 cells.

- [ ] **Step 4: green. Step 5: commit.**

---

### Task 5.5: `step-prompt.tsx` salvage + `step-card.tsx`

**Intent:** The fused textarea + inline slash autocomplete is the best thing in the current UI. Keep it. The step card is the composer's atom.

**Files:**
- Create: `web/src/components/workflows/step-prompt.tsx` ← `components/scheduler/prompt-field.tsx`
- Create: `web/src/components/workflows/step-card.tsx`
- Test: covered by `workflow-composer.test.tsx` (T5.6)

**Interfaces:**
- Produces: `<StepPrompt value onChange cwd />` (retargeted to `GET /api/workflows/commands`), and the **kept** `splitCommandAndPrompt` / `mergeCommandAndPrompt` — they are what preserve the §0.3 two-line delivery.
- Produces: `<StepCard step index total expanded onToggle onChange onMove onDelete />`.

**Dependencies:** T5.1. **Parallel with T5.3.**

- [ ] **Step 1: Move `prompt-field.tsx`, retarget the commands endpoint, keep the split/merge helpers.**
- [ ] **Step 2: Build the card in two states.** Collapsed: ordinal in a circle on the spine, one-line prompt preview, chips (`📎 2`, `🔌 gmail`). Expanded, in this **fixed order**: *Prompt → Files → Must use → ▸ Advanced*. Advanced holds `timeout_secs` as **three chips (30 min / 2 h / 8 h)** — no number input, nobody wants to type 1800 — and the optional per-step action.
- [ ] **Step 3: `npx vitest run` the composer suite once T5.6 exists. Step 4: commit.**

---

### Task 5.6: `WorkflowComposer` — the full-page route

**Intent:** A chain with N steps, file chips and a keyboard-heavy textarea is a **document**, not a sheet. Bottom sheets fight the iOS keyboard (this codebase has the mode-9 visualViewport scars) and a primary action that scrolls out of a sheet is one users cannot find.

**Files:**
- Create: `web/src/components/workflows/workflow-composer.tsx`, `trigger-picker.tsx`
- Test: `web/tests/unit/workflow-composer.test.tsx`

**Dependencies:** T5.1 + T5.5. **Sequential before T5.7/T5.8.**

- [ ] **Step 1: Write the failing tests**

```tsx
it('adds, reorders and deletes steps', () => {})
it('blocks Save when a step has no prompt AND names the offending step', () => {
  // "Step 3 has no prompt" — never a disabled button with no explanation.
})
it('blocks Save while an upload is in flight, with the reason shown', () => {})
it('renders the uploaded absolute path on the file chip', () => {})
it('reorders on mobile via ▲▼ in the step menu, not drag', () => {
  // Drag-to-reorder inside a scrolling touch list is the classic mobile
  // failure; we do not ship it. Desktop keeps the ⋮⋮ handle.
})
it('fires navigator.vibrate(8) on both reorder paths', () => {})
it('adds zero raw-Vaul sites', () => { /* asserted by sheet-inventory.test.ts */ })
```

- [ ] **Step 2: Fail. Step 3: implement.**

Layout is spec §6.3. Components: **Bot picker** = the existing `SessionPicker` / `SessionPickerOption`, company-jailed to what `scope.sees` allows, with the existing `CompanyMark` hue on the option rows. **Trigger** = three segmented chips (*When I say* / *Once* / *Repeating*); *Repeating* reveals the salvaged recurrence composer (`FREQUENCY_CHIPS`, `WEEKDAYS`, time field) with `describeSchedule`'s live English render and the debounced next-5 `/preview`; *"or type it →"* reveals the raw `schedule_expr` input, so the cron and natural-language grammars lose nothing — they just stop being the first thing a beginner meets. **Files** = `uploadForPrompt` (`POST /api/upload`, 20 MB) → an `AttachmentChip` per file; **reuse `components/focus-mode/use-staged-attachments.ts` wholesale** — it already holds the 5 MB image guard, the parallel upload, the calm error toast and the leak-free object-URL revoke in one place. **Footer** pinned, `pb-safe`, `Save` primary, `Run now` secondary, live validity line.

Micro-interactions: step insert = spring on height + opacity from `springs`; chip appearance = `scale .9→1` + fade; the ordinal circle cross-fades to a spinner when its step is running; the spine between a done step and the next animates a 300 ms fill on advance. **Never `transition: all`.**

- [ ] **Step 4: green + `sheet-inventory.test.ts` green. Step 5: commit.**

---

### Task 5.7: `connector-hint-picker.tsx`

**Intent:** Never silently offer a connector the bot cannot use; never render a dead account as available.

**Files:** Create `web/src/components/workflows/connector-hint-picker.tsx`; extend `workflow-composer.test.tsx`

**Dependencies:** T5.6. **Parallel with T5.8 and T5.9.**

- [ ] **Step 1: Write the failing tests**

```tsx
it('lists granted connectors first, each with its account label', () => {
  // "Gmail · sander@acme.com", from GET /api/sessions/{name}/connectors
})
it('groups ungranted ones under "Not connected for this bot" with a Grant… deep link', () => {})
it('never renders a disconnected or expired account as available', () => {
  // the dead-connections-look-dead rule the connector store already enforces
})
it('says "The bot is told to use these. It may still choose others."', () => {
  // honest micro-copy: a hint, not a guarantee
})
```

- [ ] **Step 2: Fail. Step 3: implement inside a `ResponsiveSheet`. Step 4: green. Step 5: commit.**

---

### Task 5.8: `completion-action-row.tsx` — and the `command:` regression guard

**Intent:** Exactly five curated options, and **no free-text box anywhere in this subtree, ever**.

**Files:** Create `web/src/components/workflows/completion-action-row.tsx`; create `web/tests/unit/workflow-completion.test.ts`

**Dependencies:** T5.6. **Parallel with T5.7 and T5.9.**

- [ ] **Step 1: Write the failing test — this is the guard that keeps the dragon dead on the client**

```ts
it('offers exactly five options and no more', () => {
  expect(COMPLETION_OPTIONS.map((o) => o.label)).toEqual([
    'Do nothing', 'Notify me', 'Send with a connector…',
    'Message another bot…', 'Pause this workflow',
  ])
})

it('has no free-text input anywhere in the completion subtree', () => {
  // render every option's expanded state; query for input[type=text] /
  // textarea / contenteditable that is NOT one of the typed fields
  // (to / subject / account picker). Zero results. This is the `command:`
  // regression guard.
})

it('renders the preview sentence and never claims the server sent anything', () => {
  // "When done, scout will use Gmail to send the run summary to …"
  // and NOWHERE the word "sent" in the past tense about the server.
})
```

- [ ] **Step 2: Fail. Step 3: implement.** Choosing *Send with a connector* reveals **two typed fields** (account picker + `to`, plus optional `subject`) and the preview sentence. Nothing else.
- [ ] **Step 4: green. Step 5: commit.**

---

### Task 5.9: `run-timeline.tsx` + `WorkflowDetail`

**Intent:** The run history the owner asked for — and the surface where the honesty rule is most visible.

**Files:** Create `web/src/components/workflows/run-timeline.tsx`, `web/src/routes/workflow-detail.tsx`; create `web/tests/unit/workflow-run-timeline.test.tsx`

**Dependencies:** T5.1 + T5.3. **Parallel with T5.7 and T5.8.**

- [ ] **Step 1: Write the failing tests**

```tsx
it('shows the plain delivered preview, never a "<supermux-" substring', () => {})
it('never shows the "— — —" confirm-footer sentinel', () => {})
it('says "asked scout to send via Gmail", never "sent"', () => {
  // THE HONESTY RULE. There is no server-side MCP client; a connector action
  // is an instruction, not an execution.
})
it('groups runs by day with Today / Yesterday / date headers', () => {})
it('uses the same dot vocabulary as the list step rail', () => {
  // running = pulse · ok = check · skipped = dash · error = ✕ ·
  // timeout = clock · interrupted = broken-link. One language.
})
it('offers "Open the thread here →" via workflowAdminHref', () => {})
```

- [ ] **Step 2: Fail. Step 3: implement.** Node shape: `② ✓ Draft the summary · 41 s · agent-confirmed`. Live via the `workflows` SSE event, cached with the `useWorkflowsStream` pattern.
- [ ] **Step 4: green. Step 5: commit.**

---

### Task 5.10: Mobile rig verification

**Intent:** The mobile-first rule is verified on the rig, not asserted in prose.

**Files:** no source changes expected; fixes land as follow-up edits to T5.3/T5.6/T5.7/T5.9

**Dependencies:** T5.3 + T5.6 + T5.7 + T5.9. **Sequential (it is a gate).**

- [ ] **Step 1: Screenshot the four surfaces** — list · composer (collapsed **and** expanded step) · connector picker · run timeline — at **390 px and 320 px**, **light and dark**, **grok on and off**, using the offline mobile UI review rig (worktree Vite + Playwright mobile chromium against a `/dev` route).
- [ ] **Step 2: Assert zero horizontal overflow at both widths.**
- [ ] **Step 3: Assert the pinned composer footer clears the iOS keyboard** (the mode-9 visualViewport contract).
- [ ] **Step 4: Verify the grok phone tab bar at 4 → 5 cells** — the Liquid Rail pill geometry at 390 px and 320 px.
- [ ] **Step 5: File any fix as an edit to the owning task's file, re-run its unit test, commit.**

---

## Phase 6 — Web: BotPanel

*Depends on T5.3. Two agents in parallel (T6.1+T6.2 share `bot-panel.tsx` — land T6.1 first, then T6.2; T6.3 is independent).*

### Task 6.1: `Activity` tab → `Workflows`

**Intent:** The per-bot answer, replacing the standalone session-schedules sheet.

**Files:**
- Modify: `web/src/components/roster/bot-panel.tsx:318-324` (`TabKey` union + `TABS`), `:552` (`ActivityTab` → `WorkflowsTab`), `:627`, `:765`, `:800` (the `initialTab` prop union — **it appears twice in the file**)
- Test: `web/tests/unit/workflows-view.test.tsx` (extend with the bot-scoped variant)

**Dependencies:** T5.3. **Sequential before T6.2.**

- [ ] **Step 1: Write the failing test**

```tsx
it('the bot panel tab is "workflows" and Issues + Git are untouched', () => {
  expect(TABS.map(t => t.key)).toEqual(
    ['overview', 'instructions', 'tools', 'memory', 'workflows'])
  // Issues and Git remain — deleting them would be a capability drop.
})
it('the workflows tab shows the bot-scoped list and the last 5 runs', () => {})
it('+ New workflow opens the composer with the bot pre-selected', () => {})
```

- [ ] **Step 2: Fail. Step 3: implement.** `WorkflowsTab` contains, in order: `Field "Workflows"` (bot-scoped `WorkflowsView` + `+ New workflow`) · `Field "Recent runs"` (last 5 across this bot's workflows, compact `RunTimeline` rows) · `Field "Issues"` **unchanged** · `Field "Git"` **unchanged**.
- [ ] **Step 4: green. Step 5: commit.**

---

### Task 6.2: The mechanical fallout of the tab rename

**Intent:** Four places copy BotPanel's shape and will silently break.

**Files:**
- Modify: the visual-regression benches carrying `data-vr-tab="activity"`
- Modify: `web/src/routes/dev-roster.tsx` and its `.cast.ts` fixture
- Modify: `web/src/components/roster/` — `TeamPanel` (it copies BotPanel's frame)
- Modify: `web/src/components/focus-mode/session-info-panel.tsx:292,613` (`SchedulesList` → `WorkflowsList`, same shape, new source; the `useSchedules` import at `:49` and the `components/scheduler/helpers` import at `:56` re-point to T5.1/T5.2)

**Dependencies:** T6.1. **Sequential.**

- [ ] **Step 1: `grep -rn -F 'data-vr-tab="activity"' web/src web/tests` and `grep -rn -F "'activity'" web/src/components/roster web/src/routes` — fix every hit.**
- [ ] **Step 2: Re-record the `.cast.ts` fixture. Step 3: run the full web unit suite. Step 4: commit.**

---

### Task 6.3: The honesty tell — the chat-header workflow chip

**Intent:** A workflow **occupies the bot's thread** and the human can type into that pane mid-chain. v1 does not lock the pane (locking a user out of their own agent is worse than the interleaving) — so it discloses instead.

**Files:**
- Modify: `web/src/components/chat/` — the session header component
- Test: `web/tests/unit/chat-header.test.tsx` (extend)

**Dependencies:** T3.2 + T5.1. **Parallel with T6.1/T6.2.**

- [ ] **Step 1: Write the failing test**

```tsx
it('shows a "Workflow · step 2/4" chip while a run is in flight', () => {})
it('the chip opens the run timeline', () => {})
it('offers Stop, wired to POST /api/workflows/{id}/cancel', () => {})
it('shows nothing when no run is in flight', () => {})
```

- [ ] **Step 2: Fail. Step 3: implement. Step 4: green. Step 5: commit.**

---

## Phase 4B — Web removals

*One agent, sequential, after Phases 5 and 6 are both green.*

### Task 4B.1: Delete the scheduler UI

**Files:**
- Delete: `web/src/components/scheduler/` (`schedule-form.tsx` — 874 lines, the kind toggle lives here — `schedule-editor.tsx`, `schedule-detail-sheet.tsx`, `fire-log.tsx`, `helpers.ts`, `prompt-field.tsx`, `enable-toggle.tsx`)
- Delete: `web/src/components/session-schedules/` (both files)
- Delete: `web/src/components/settings/schedules-section.tsx` + `schedules-section.helpers.ts`
- Delete: `web/src/lib/api/scheduler.ts`, `web/src/hooks/use-scheduler.ts`
- Delete: `web/tests/unit/schedules-section.test.tsx`, `session-schedules.test.tsx`, `schedule-href.test.ts`
- Delete: `web/tests/e2e/smoke/scheduler-fold.spec.ts`, `scheduler-fires.spec.ts`
- Modify: `web/src/components/settings/` — Settings keeps **a single row: *Workflows → /workflows***
- Modify: every remaining importer surfaced by the grep in Step 1

**Dependencies:** Phase 5 + Phase 6. **Sequential.**

- [ ] **Step 1: Find every importer before deleting anything**

```bash
cd /opt/projects/supermux-workflows/web
grep -rln -F -e "components/scheduler" -e "session-schedules" -e "lib/api/scheduler" \
  -e "use-scheduler" -e "schedules-section" src tests
```
Expected hit set (verified pre-change): `App.tsx`, `components/layout.tsx`, `components/command-palette/command-palette.tsx`, `components/focus-mode/session-info-panel.tsx`, `components/onboarding/floating-tip.tsx`, `components/onboarding/tour-overlay.tsx`, `components/session-tile/mock.ts`, `components/session-tile/new-session-sheet.tsx`, `components/session/session-picker.tsx`, `components/terminal/resume-picker.tsx`, `lib/api/index.ts`, `lib/api.ts`, `lib/entity.ts`, `lib/rank.ts`, `brand/copy.ts`, `routes/dev-chat-live.fixture.ts`. Re-run the grep and work the actual list — do not trust this snapshot.

- [ ] **Step 2: Delete + re-point, then create the e2e replacement**

`web/tests/e2e/smoke/workflows.spec.ts`: create → add 2 steps → run now → **watch the rail advance** → open the run timeline → delete.

- [ ] **Step 3: Full web suite + typecheck**

```bash
cd web && npx tsc --noEmit && npx vitest run && npx playwright test tests/e2e/smoke/workflows.spec.ts
```

- [ ] **Step 4: Update the amended tests**

`sse-events.test.ts` (add `workflows`) · `tour-anchors.test.ts` (the Workflows nav item, immediately after Connectors) · `sheet-inventory.test.ts` (the allowlist **shrank**; it may never grow) · `chat-wrapper-parity.test.ts` — **unchanged** (the tag does not change in v1), but **add a case** for a title carrying the `· step 2/4` suffix so escaping is proven on the new shape.

- [ ] **Step 5: Commit**

---

## Phase 7 — Delay-send repoint

*One agent. Independent of Phases 5/6 once **T3.1** lands. **Cross-branch — read the integration order below before touching anything.***

### Task 7.1: Point `feat/composer-delay-send`'s one-shot creation at `/api/workflows`

**Intent:** A one-shot delay-send is, structurally, a workflow with `trigger_kind='once'` and exactly one step. The locked decision (DECISIONS LOCKED #3) is: repoint it — **no `POST /api/schedules` write-shim is built**.

**Files (on `feat/composer-delay-send`, NOT on `feat/workflows`):**
- Modify: whichever module on that branch calls `schedulerApi.create` (a repo-wide search on `main` found **`web/src/hooks/use-scheduler.ts` as the only in-repo caller** — on the delay-send branch, find its equivalent with `grep -rn -F "schedulerApi.create" web/src`)
- Test: that branch's own delay-send unit test, retargeted

**Dependencies:** T3.1 must be **merged to `main`** first.

**Integration order — do not deviate:**
1. `feat/workflows` merges to `main` first (it carries the migration and the 410-on-writes shim).
2. `feat/composer-delay-send` rebases onto that `main`. Its `POST /api/schedules` call is now **410 Gone** — a hard, visible failure, which is the point: it cannot ship half-repointed.
3. This task's edit lands **on the delay-send branch**, in that rebase.

- [ ] **Step 1: Write the failing test on the delay-send branch**

```ts
it('creates a one-shot workflow, not a schedule', async () => {
  await sendLater(text, at)
  expect(fetchMock).toHaveBeenCalledWith('/api/workflows', expect.objectContaining({
    method: 'POST',
    body: expect.stringContaining('"trigger_kind":"once"'),
  }))
})
it('sends exactly one step and no completion action', () => {
  // { steps: [{ prompt }], on_complete: { kind: 'none' } }
})
```

- [ ] **Step 2: Fail. Step 3: repoint the call.**

```json
POST /api/workflows
{ "title": "Delayed send", "session": "scout", "trigger_kind": "once",
  "schedule_expr": "at 2026-08-24T18:30:00Z",
  "steps": [{ "prompt": "…" }], "on_complete": { "kind": "none" } }
```

The **6-hour `ONESHOT_GRACE`** behaviour is preserved verbatim by the engine — that is what makes a delayed send survive a server restart. Assert it in the delay-send branch's own integration test.

- [ ] **Step 4: green. Step 5: commit on `feat/composer-delay-send`.**

---

## Phase 8 — Migration rehearsal + release gate

*After 4A and 4B. Up to three agents in parallel (T8.1 / T8.2 / T8.3), then T8.4 is the gate.*

### Task 8.1: ⚠️ Rehearse 0038 against a **copy** of a real SQLite DB

**Intent:** Spec §10: *"The port is the only irreversible step in the plan… it should be rehearsed against a copy of the production SQLite before the release is cut."*

**Files:** Create `docs/superpowers/plans/2026-08-24-workflows-migration-rehearsal.md` (the recorded result — the only new doc this plan produces)

**Dependencies:** Phase 4A + 4B. **Parallel with T8.2/T8.3.**

- [ ] **Step 1: Copy, never touch, the live DB**

```bash
cp /path/to/live/supermux.db /tmp/rehearsal-$(date +%s).db   # a COPY. Read-only on the original.
```

- [ ] **Step 2: Record the pre-state**

```sql
SELECT kind, COUNT(*) FROM schedules WHERE deleted IS NULL GROUP BY kind;
SELECT COUNT(*) FROM schedule_runs;
SELECT COUNT(*) FROM schedule_run_keys;
SELECT id, next_run, run_count, enabled FROM schedules ORDER BY id;
```

- [ ] **Step 3: Run the server against the copy, let 0038 apply, record the post-state**

Assert, row by row: every `kind='tmux'` id survives with **identical** `next_run` / `run_count` / `enabled` · `workflow_run_keys` count == the pre-state `schedule_run_keys` count for ported ids · `workflows_import_log` row count == the **total** pre-state `schedules` row count (including soft-deleted) · the three old tables are gone.

- [ ] **Step 4: Boot twice and confirm `reconcile` is idempotent** — the second boot raises zero new alerts.

- [ ] **Step 5: Write the result up and commit.** If anything mismatches: **stop the release**, file `0039` as the fix. `0038` is frozen.

---

### Task 8.2: Server suite sweep + the ported-test census

**Intent:** Prove nothing was silently dropped in the port.

**Dependencies:** Phase 4A. **Parallel with T8.1/T8.3.**

- [ ] **Step 1: Full server suite**

```bash
cd server && OPENSSL_NO_VENDOR=1 OPENSSL_LIB_DIR=/usr/lib/x86_64-linux-gnu cargo test 2>&1 | tail -40
```

- [ ] **Step 2: The census — compare against T0.1's recorded counts**

| Old file | New file | Cases that must exist |
|---|---|---|
| `scheduler.rs` (10) | `workflows_http.rs` | 8 survive; `in_one_second_shell_job_fires` + `test_fire_runs_once_and_does_not_persist` **die with the feature** |
| `schedule_hook_create.rs` (17) | `workflow_hook_create.rs` | **all 17** + 4 new |
| `schedule_missed_tick.rs` (2) | `workflow_missed_tick.rs` | both + 1 new |
| `archive_schedule_contract.rs` (3) | `archive_workflow_contract.rs` | **all 3**, incl. the negative |
| `runner.rs` inline (11) | `engine.rs` inline | **all 11** + 4 new |

New files that must all be green: `workflows_port.rs` · `workflows_chain.rs` · `workflows_reaper.rs` · `workflows_completion.rs` · `workflows_removals.rs`.

- [ ] **Step 3: Commit the census as the commit message of a no-op docs touch, or paste it into the PR body.**

---

### Task 8.3: Web suite sweep + the skill/doc retarget

**Intent:** The prose that teaches agents to schedule their own work still says "schedule". Retarget the words; **keep the endpoint working**.

**Files:**
- Modify: `agents/supermux-schedule.md` (the skill) and its Skill registry entry
- Modify: `web/src/brand/copy.ts` and `web/src/brand/BRAND.md` (scheduler vocabulary → workflow vocabulary)
- Modify: `web/src/lib/entity.ts`, `web/src/lib/rank.ts` (schedule entity → workflow entity)

**Dependencies:** Phase 4B. **Parallel with T8.1/T8.2.**

- [ ] **Step 1: Full web sweep**

```bash
cd web && npx tsc --noEmit && npx vitest run && npx playwright test tests/e2e/smoke/
```

- [ ] **Step 2: Retarget the skill prose. Keep `POST /api/hook/schedule/create` documented as the working legacy alias** — an agent reading an old copy of the skill must still succeed. Teach the canonical `/api/hook/workflow/create` as the preferred form.
- [ ] **Step 3: Add the two new BRAND.md vocabularies** — the workflow **status dot** vocabulary (running / ok / skipped / error / timeout / interrupted, one language shared by the list rail and the run timeline) and the **completion-action** vocabulary (the five options, and the "asked, never sent" honesty rule).
- [ ] **Step 4: green. Step 5: commit.**

---

### Task 8.4: The release gate

**Dependencies:** T8.1 + T8.2 + T8.3. **Sequential — this is the gate.**

- [ ] **Step 1: Confirm the rehearsal (T8.1) passed with zero mismatches.**
- [ ] **Step 2: Confirm `workflows_removals.rs` is green** — the dragon strings are absent **and** both legacy hook routes are still registered.
- [ ] **Step 3: Confirm `sheet-inventory.test.ts`'s allowlist shrank and did not grow.**
- [ ] **Step 4: Confirm the mobile rig gate (T5.10) has screenshots for all four surfaces × 2 widths × 2 themes × 2 modes.**
- [ ] **Step 5: Open the PR and hand off.** `main` is branch-protected (code-owner review + green CI, no bypass). **Never auto-merge.** The PR body must carry: the census table (T8.2), the rehearsal result (T8.1), and a bold line naming the irreversible migration.

---

## Self-review — spec coverage

| Spec § | Covered by |
|---|---|
| §2.2 schema | T1.2 |
| §2.3 steps as rows | T1.2, T1.3 (`replace_steps` + the history-survives test) |
| §2.4 the four cascades | T1.4 |
| §2.5 derived `company_id` + the company trigger | T1.2 (trigger), T1.3 (re-derive on write), T3.1 (client value ignored) |
| §2.6 boot hazard deleted | T4A.1 (deletion, not a patch) |
| §2.7 call-site re-audit checklist | T1.4, T3.4, T3.7, T4A.1, T4B.1, T5.4, T8.3 |
| §3.1–3.3 the chain | T2.2, T2.3 |
| §3.4 wrapper kept | T2.2 (moved verbatim), Global Constraints, T4B.1 step 4 |
| §3.5 triggers | T2.1, T2.4, T3.2, T5.6 |
| §3.6 reaper | T2.5 |
| §4.1 server removals | T4A.1 |
| §4.2 CHECK implications | T1.2 (exhaustive `IN`, no `LIKE`) |
| §4.3 web removals + salvage | T5.2, T5.5, T4B.1 |
| §5.1 API + validation funnel | T3.1, T3.2, T3.3 |
| §5.2 read-shim + 410 | T3.6 |
| §5.3 completion actions | T2.6, T5.8 |
| §5.4 hook preserved + legacy aliases | T3.5, T4A.1 (keep-list) |
| §5.5 SSE | T3.7 |
| §6.1 nav (grokOnly) | T5.4 |
| §6.2 list + step rail + empty state | T5.3 |
| §6.3 composer | T5.5, T5.6, T5.7, T5.8 |
| §6.4 BotPanel | T6.1, T6.2 |
| §6.5 run history | T5.9 |
| §6.6 the honesty tell | T6.3 |
| §7 port + reconciliation | T1.1, T1.2, T1.5, T8.1 |
| §7.6 delay-send | T7.1 |
| §8 nine units | the File Structure table |
| §9 test plan | every task's Step 1 |
| §10 risks | T8.1 (rehearsal), T8.4 (gate), Global Constraints (honesty + NotifCategory) |
