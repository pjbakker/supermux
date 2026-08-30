#!/usr/bin/env python3
"""Seed a PRE-0038 supermux data.db with representative scheduler data.

Runs against a STOPPED old-version server (schema = migrations 0001..0024,
the v0.5.0 release). Inserts one row per port outcome the 0038 migration can
produce, plus run history and a fire-key, so the upgrade lane can assert the
exact ported/refused split instead of migrating an empty database.

Usage: seed-schedules.py <path-to-data.db>

The expected post-0038 outcome for these rows (asserted by
assert-upgraded.py, keep the two files in sync):
  SCHED-seed-p1      tmux, daily 09:30, notify      -> ported, recurring '30 9 * * *'
  SCHED-seed-p2      tmux, bad run_at, command:...  -> ported as MANUAL, on_complete disable
  SCHED-seed-p3      tmux, once, explicit expr      -> ported, trigger 'once', timeout 600
  SCHED-seed-r-shell shell job                      -> refused (shell removed in v1)
  SCHED-seed-r-boot  boot job                       -> refused (boot removed in v1)
  SCHED-seed-r-del   tmux but already deleted       -> refused (already deleted)
  SCHED-seed-r-empty tmux, no command, no prompt    -> refused (nothing to deliver)
"""
import sqlite3
import sys
import time

NOW = int(time.time())
FUTURE = "2030-01-01T00:00:00Z"  # never due: neither scheduler may fire during the test

db = sqlite3.connect(sys.argv[1])

# The owning session for the portable jobs. archived=1 so neither the old nor
# the new server tries to reconcile a live agent for it inside the container.
# Doubles as the "representative non-scheduler data" marker the post-upgrade
# assertions check survived the migration chain untouched.
db.execute(
    "INSERT INTO sessions (name, dir, [desc], archived, created_at) VALUES (?,?,?,?,?)",
    ("seed-bot", "/tmp", "seeded pre-upgrade marker session", 1, NOW),
)

SCHED_COLS = (
    "id, title, session, command, prompt, kind, boot_dir, sched_type, recurrence, "
    "run_at, schedule_expr, next_run, enabled, run_count, watch, watch_timeout, "
    "done_action, created, updated, deleted"
)


def sched(**kw):
    row = {
        "title": kw["id"], "session": "seed-bot", "command": "", "prompt": "",
        "kind": "tmux", "boot_dir": "", "sched_type": "recurring", "recurrence": None,
        "run_at": None, "schedule_expr": None, "next_run": FUTURE, "enabled": 1,
        "run_count": 0, "watch": 0, "watch_timeout": 0, "done_action": "disable",
        "created": NOW, "updated": NOW, "deleted": None,
    }
    row.update(kw)
    db.execute(
        f"INSERT INTO schedules ({SCHED_COLS}) VALUES ({','.join('?' * 20)})",
        [row[c.strip().strip('[]')] for c in SCHED_COLS.split(",")],
    )


sched(id="SCHED-seed-p1", command="/hello", prompt="daily standup ping",
      recurrence="daily", run_at="09:30", run_count=12, done_action="notify")
sched(id="SCHED-seed-p2", prompt="poke the build",
      recurrence="daily", run_at="garbage", done_action="command:echo hi")
sched(id="SCHED-seed-p3", command="/report", sched_type="once",
      schedule_expr="0 6 * * *", watch_timeout=600)
sched(id="SCHED-seed-r-shell", kind="shell", command="echo hi")
sched(id="SCHED-seed-r-boot", kind="boot", command="/boot", boot_dir="/tmp")
sched(id="SCHED-seed-r-del", command="/x", deleted=NOW)
sched(id="SCHED-seed-r-empty", command="   ", prompt="")

# Run history: two finished runs for p1 (agent-confirmed + error) and one for
# the shell job (must NOT survive: its schedule is refused).
db.execute("INSERT INTO schedule_runs (schedule_id, ran_at, status, note) VALUES (?,?,?,?)",
           ("SCHED-seed-p1", NOW - 3600, "done", "seeded ok run"))
db.execute("INSERT INTO schedule_runs (schedule_id, ran_at, status, note) VALUES (?,?,?,?)",
           ("SCHED-seed-p1", NOW - 1800, "error", "seeded failed run"))
db.execute("INSERT INTO schedule_runs (schedule_id, ran_at, status, note) VALUES (?,?,?,?)",
           ("SCHED-seed-r-shell", NOW - 900, "ok", "seeded shell run"))

# Fire-keys: p1's must cross the upgrade (double-fire protection), shell's not.
db.execute("INSERT INTO schedule_run_keys (schedule_id, scheduled_for_ts, fired_at) VALUES (?,?,?)",
           ("SCHED-seed-p1", NOW - 3600, NOW - 3599))
db.execute("INSERT INTO schedule_run_keys (schedule_id, scheduled_for_ts, fired_at) VALUES (?,?,?)",
           ("SCHED-seed-r-shell", NOW - 900, NOW - 899))

db.commit()
n = db.execute("SELECT count(*) FROM schedules").fetchone()[0]
db.close()
print(f"seeded {n} schedules + 3 runs + 2 fire-keys + 1 session")
assert n == 7, f"expected 7 seeded schedules, found {n}"
