# The 0037 fixture DB — how the port test builds its "before" picture

`tests/workflows_port.rs` must exercise `0038_workflows.sql` against a database that
looks exactly like a deployed install did the moment before the upgrade: schema at
**0037**, with real `schedules` / `schedule_runs` / `schedule_run_keys` rows in it.

There is no checked-in binary fixture. The DB is regenerated per test run, in a
tempdir, and thrown away — **the migration is never pointed at a real database**.

## How it is produced

1. Open a fresh on-disk SQLite pool in a per-test tempdir, with the same pragmas
   `db::init` uses (WAL, `synchronous=NORMAL`, `foreign_keys=ON`).
2. Walk `sqlx::migrate!("./migrations")` and, for every migration with
   `version <= 37`, execute its SQL and write the row sqlx itself would have
   written into `_sqlx_migrations` (`version`, `description`, `success=TRUE`,
   the migration's own `checksum`, `execution_time=-1`).
   The database is now byte-compatible with a real install at 0037: a later
   `Migrator::run` sees 0001–0037 as applied (checksums validate) and applies
   only what is new.
3. Seed by hand (`seed_0037`), so every branch of the port has a witness:

   | row | why it is there |
   |---|---|
   | `SCHED-tmux0001` — `kind='tmux'`, recurring, `done_action='notify'`, a run + a fire-key | the happy path: cadence, history and idempotency must all cross over |
   | `SCHED-tmux0002` — `kind='tmux'`, once, `schedule_expr IS NULL` (`recurrence='daily'`, `run_at='09:00'`) | the `synth_expr` branch — the expression is synthesised in SQL |
   | `SCHED-shel0003` — `kind='shell'` | must NOT be ported; import log, with a reason |
   | `SCHED-boot0004` — `kind='boot'` | must NOT be ported; import log, with a reason |
   | `SCHED-cmd00005` — `kind='tmux'`, `done_action='command:say hi'` | ported with `on_complete={"kind":"disable"}`, and the literal `say hi` survives in the import log's JSON |
   | `SCHED-gone0006` — soft-deleted (`deleted` set) | already a tombstone: archived, never ported |
   | one `schedule_runs` row against `SCHED-tmux0001` | becomes a `workflow_runs` + `workflow_step_runs` pair |
   | one `schedule_run_keys` row against `SCHED-tmux0001` | becomes a `workflow_run_keys` row — without it the upgrade window double-fires |

   Plus a `sessions` row (`scout`, `company_id = 7`) so the derived
   `workflows.company_id` has something to derive from, and one schedule
   pointed at a session that does not exist, so the NULL case is covered too.
4. Run the real migrator. It applies `0038_workflows.sql` and nothing else.
5. Assert against the post-state.

The seed SQL lives inline in `tests/workflows_port.rs` (`seed_0037`) so it is
version-controlled as code, reviewed in the same diff as the migration it pins,
and reusable by the Phase 8 rehearsal.

## Baseline (pre-change, `main` @ d6b73cb + spec/plan commits)

```
tests/scheduler.rs                  9 passed
tests/schedule_hook_create.rs      18 passed
tests/schedule_missed_tick.rs       2 passed
tests/archive_schedule_contract.rs  3 passed
                                   -- 32 total
```

Recipe every task re-runs:

```bash
cd server
export OPENSSL_NO_VENDOR=1 OPENSSL_LIB_DIR=/usr/lib/x86_64-linux-gnu
cargo test --test <name>          # debug only; never --release, never cargo fmt
```

Web baseline (the seven suites this plan touches): **89 pass / 0 fail across 7 files**.

> ⚠️ Plan correction: the web suites are **bun tests** (`import … from 'bun:test'`),
> not vitest. `npx vitest run tests/unit/…` fails with *Cannot find package 'bun:test'*
> before running a single case. Use `bun test tests/unit/…` from `web/`.
