#!/usr/bin/env python3
"""Assert the 0038+ migration chain did the right thing to a SEEDED database.

Counterpart of seed-schedules.py (keep the expected outcomes in sync). Runs
after the old->new upgrade against the migrated data.db; read-only; exits
non-zero listing every failed expectation.

Usage: assert-upgraded.py <path-to-data.db>
"""
import json
import sqlite3
import sys

db = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
failures = []


def check(desc, cond):
    print(f"  {'PASS' if cond else 'FAIL'}  {desc}")
    if not cond:
        failures.append(desc)


def one(sql, *args):
    row = db.execute(sql, args).fetchone()
    return row[0] if row else None


tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}

# The one-way door actually opened: old tables dropped, new ones present.
for gone in ("schedules", "schedule_runs", "schedule_run_keys"):
    check(f"table {gone} is gone", gone not in tables)
for present in ("workflows", "workflow_steps", "workflow_runs",
                "workflow_run_keys", "workflows_import_log"):
    check(f"table {present} exists", present in tables)

# The full migration chain applied (0038 is the drop; 0041 is current head —
# assert ">= 41" so future migrations don't break this lane).
versions = {r[0] for r in db.execute("SELECT version FROM _sqlx_migrations")}
check("migration 0038 recorded", 38 in versions)
check(f"migration head >= 41 (got {max(versions)})", max(versions) >= 41)

# Archive: every seeded row, ported or not, with the exact split + reasons.
log = {r[0]: (r[1], r[2]) for r in
       db.execute("SELECT old_id, ported, reason FROM workflows_import_log")}
check(f"import log has all 7 seeded rows (got {len(log)})", len(log) == 7)
expected = {
    "SCHED-seed-p1": (1, ""),
    "SCHED-seed-p2": (1, "done_action command:… was removed; the follow-up text is preserved here"),
    "SCHED-seed-p3": (1, ""),
    "SCHED-seed-r-shell": (0, "shell jobs were removed in Workflows v1"),
    "SCHED-seed-r-boot": (0, "boot jobs were removed in Workflows v1"),
    "SCHED-seed-r-del": (0, "the job was already deleted before the upgrade; nothing to carry over"),
    "SCHED-seed-r-empty": (0, "the job had neither a command nor a prompt; there was nothing to deliver"),
}
for old_id, want in expected.items():
    check(f"import log {old_id}: ported={want[0]}", log.get(old_id) == want)
row_json = one("SELECT row_json FROM workflows_import_log WHERE old_id='SCHED-seed-r-shell'")
check("refused shell job's full row archived as JSON",
      bool(row_json) and json.loads(row_json)["command"] == "echo hi")

# Ported workflows: ids cross over verbatim; triggers + expr + on_complete map.
wf = {r[0]: r for r in db.execute(
    "SELECT id, trigger_kind, schedule_expr, on_complete, run_count, session FROM workflows")}
check(f"exactly 3 workflows ported (got {len(wf)})", len(wf) == 3)
check("p1 recurring '30 9 * * *' (daily 09:30 synthesised)",
      wf.get("SCHED-seed-p1", ())[1:3] == ("recurring", "30 9 * * *"))
check("p1 on_complete notify",
      "SCHED-seed-p1" in wf and json.loads(wf["SCHED-seed-p1"][3])["kind"] == "notify")
check("p1 run_count carried (12)",
      "SCHED-seed-p1" in wf and wf["SCHED-seed-p1"][4] == 12)
check("p2 unparseable run_at ported as MANUAL",
      wf.get("SCHED-seed-p2", ())[1:3] == ("manual", None))
check("p2 command:... became on_complete disable",
      "SCHED-seed-p2" in wf and json.loads(wf["SCHED-seed-p2"][3])["kind"] == "disable")
check("p3 trigger 'once' with explicit expr",
      wf.get("SCHED-seed-p3", ())[1:3] == ("once", "0 6 * * *"))

# Steps: command and prompt cross over SEPARATELY; watch_timeout semantics.
steps = {r[0]: r for r in db.execute(
    "SELECT workflow_id, command, prompt, timeout_secs FROM workflow_steps")}
check(f"one step per ported workflow (got {len(steps)})", len(steps) == 3)
check("p1 step keeps command AND prompt separate",
      steps.get("SCHED-seed-p1", ())[1:3] == ("/hello", "daily standup ping"))
check("p1 watch_timeout=0 meant unset -> 1800",
      "SCHED-seed-p1" in steps and steps["SCHED-seed-p1"][3] == 1800)
check("p3 watch_timeout=600 carried",
      "SCHED-seed-p3" in steps and steps["SCHED-seed-p3"][3] == 600)

# Run history: only the ported workflow's runs survive, statuses/signals map.
runs = list(db.execute(
    "SELECT workflow_id, status FROM workflow_runs ORDER BY started_at"))
check(f"2 runs carried, both p1's (got {runs})",
      [r[0] for r in runs] == ["SCHED-seed-p1"] * 2 and
      [r[1] for r in runs] == ["ok", "error"])
signals = sorted(r[0] for r in db.execute("SELECT signal FROM workflow_step_runs"))
check(f"step-run signals map done->agent-confirmed, error->send-error (got {signals})",
      signals == ["agent-confirmed", "send-error"])

# Fire-keys: p1's crossed (double-fire protection), the refused shell one didn't.
keys = [r[0] for r in db.execute("SELECT workflow_id FROM workflow_run_keys")]
check(f"exactly p1's fire-key crossed (got {keys})", keys == ["SCHED-seed-p1"])

# Representative non-scheduler data is intact.
sess = db.execute(
    "SELECT dir, archived FROM sessions WHERE name='seed-bot'").fetchone()
check("seeded session survived intact", sess == ("/tmp", 1))

# sqlite's own verdicts on the migrated file.
check("PRAGMA integrity_check ok", one("PRAGMA integrity_check") == "ok")
check("PRAGMA foreign_key_check clean",
      db.execute("PRAGMA foreign_key_check").fetchone() is None)

db.close()
if failures:
    print(f"\n{len(failures)} upgrade assertion(s) FAILED", file=sys.stderr)
    sys.exit(1)
print("\nall upgrade assertions passed")
