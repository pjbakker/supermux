#!/usr/bin/env bash
# Prove the self-deploy runner's auto-rollback restores the DATABASE, not just
# the binary. Migrations are a one-way door (an old binary refuses a migrated
# data.db with sqlx VersionMissing), so a binary-only rollback after a
# migrating deploy bricks the service — the runner must snapshot data.db
# before installing and put the snapshot back on rollback.
#
# Flow: fresh install → drop a deploy request pointing at a bad-but-valid ELF
# (/bin/false) → the path-unit fires the real runner under real systemd → the
# moment the runner's log shows the snapshot is taken (service stopped, binary
# about to be swapped) we MUTATE the DB the way a migration would → the deploy
# fails health verification → assert the runner rolled back the binary AND the
# mutation is gone, the pre-deploy marker survives, and the service is healthy.
set -euo pipefail

apt-get update -qq
apt-get install -y -qq curl ca-certificates python3

SUPERMUX_INSTALL_CLAUDE=0 bash /src/install.sh

AUTH=$(find /home -name auth_token -path '*.supermux*' | head -1)
DATA_DIR="$(dirname "$AUTH")"
DB="$DATA_DIR/data.db"
DB_OWNER="$(stat -c '%U' "$DB")"
USER_HOME="$(dirname "$DATA_DIR")"
DEPLOY_LOG="$DATA_DIR/deploy/log"
STATUS="$DATA_DIR/deploy/status"

# ── canary the DB while nothing writes it ────────────────────────────────────
systemctl stop supermux
python3 - "$DB" <<'EOF'
import sqlite3, sys
c = sqlite3.connect(sys.argv[1])
c.execute("CREATE TABLE rehearsal_canary (id TEXT PRIMARY KEY)")
c.execute("INSERT INTO rehearsal_canary VALUES ('pre-deploy-marker')")
c.commit(); c.close()
EOF
for f in "$DB" "$DB-wal" "$DB-shm"; do
  [ -f "$f" ] && chown "$DB_OWNER:$DB_OWNER" "$f"
done
systemctl start supermux
for i in $(seq 1 30); do
  curl -fsS --max-time 2 http://127.0.0.1:8824/api/health >/dev/null 2>&1 && break
  [ "$i" = 30 ] && { echo "[scenario] unhealthy after canary seed"; exit 1; }
  sleep 1
done

# ── background mutator: strike inside the deploy window ──────────────────────
# The runner stops the unit, snapshots the DB, then installs + starts the bad
# binary and polls health for ~10s before rolling back. Waiting for the
# "backed up current binary" log line (printed right AFTER the snapshot) puts
# this write squarely in that window; the flag files let the assertions verify
# the race was actually won rather than silently passing.
BAD="$USER_HOME/bad-deploy-elf"
cp /bin/false "$BAD"
rm -f /tmp/mutation-confirmed
(
  for i in $(seq 1 300); do
    grep -q 'backed up current binary' "$DEPLOY_LOG" 2>/dev/null && break
    sleep 0.2
  done
  python3 - "$DB" <<'EOF'
import sqlite3, sys
c = sqlite3.connect(sys.argv[1])
c.execute("INSERT INTO rehearsal_canary VALUES ('MUTANT-post-snapshot')")
c.commit()
n = c.execute("SELECT count(*) FROM rehearsal_canary WHERE id='MUTANT-post-snapshot'").fetchone()[0]
c.close()
open("/tmp/mutation-confirmed", "w").write(str(n))
EOF
) &
MUTATOR=$!

# ── drop the request; the enabled path-unit runs the real runner ─────────────
rm -f "$STATUS"
printf 'binary=%s\nsha=%s\nnonce=%s\n' "$BAD" "badbadbadbad0001" "$RANDOM" \
  > "$DATA_DIR/deploy/request.tmp"
mv "$DATA_DIR/deploy/request.tmp" "$DATA_DIR/deploy/request"

for i in $(seq 1 120); do
  [ -s "$STATUS" ] && break
  [ "$i" = 120 ] && { echo "[scenario] runner never wrote $STATUS"; journalctl -u supermux-deploy -n 50 --no-pager; exit 1; }
  sleep 1
done
wait "$MUTATOR" 2>/dev/null || true

# ── assertions ───────────────────────────────────────────────────────────────
echo "[scenario] deploy log tail:"; tail -30 "$DEPLOY_LOG"

fail() { echo "[scenario] FAIL: $*"; exit 1; }

grep -qx failed "$STATUS"                        || fail "expected status=failed, got: $(cat "$STATUS")"
grep -q 'snapshotted data.db' "$DEPLOY_LOG"      || fail "runner never snapshotted the DB"
grep -q 'restored data.db from snapshot' "$DEPLOY_LOG" || fail "runner never restored the DB snapshot"
grep -q 'step=rolled_back' "$DEPLOY_LOG"         || fail "runner never emitted the rolled_back step"
[ "$(cat /tmp/mutation-confirmed 2>/dev/null)" = "1" ] \
                                                 || fail "mutator lost the race — the restore was not actually exercised"
ls -d "$DATA_DIR"/deploy/db-backups/*/ >/dev/null || fail "no snapshot directory kept"

python3 - "$DB" <<'EOF'
import sqlite3, sys
c = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
rows = {r[0] for r in c.execute("SELECT id FROM rehearsal_canary")}
assert "pre-deploy-marker" in rows, f"pre-deploy marker lost: {rows}"
assert "MUTANT-post-snapshot" not in rows, "post-snapshot mutation SURVIVED - DB was not restored"
print("  DB restored: marker present, post-snapshot mutation gone")
EOF

# The rolled-back service must be the ORIGINAL binary, up and healthy.
cmp -s /usr/local/bin/supermux-server /usr/local/bin/supermux-server.prev \
                                                 || fail "binary was not rolled back"
for i in $(seq 1 30); do
  curl -fsS --max-time 2 http://127.0.0.1:8824/api/health >/dev/null 2>&1 && break
  [ "$i" = 30 ] && fail "service unhealthy after rollback"
  sleep 1
done
echo "[scenario] rollback restored binary + DB; service healthy again"
