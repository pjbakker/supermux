#!/usr/bin/env bash
# The upgrade test that actually tests an upgrade: install a REAL released
# older version (pre-0038, when the `schedules` table still existed), seed a
# populated scheduler DB, then upgrade to the freshly-built tarball and assert
# the destructive 0038 migration chain did exactly what it promises — expected
# ported/refused split, history + fire-keys carried, non-scheduler data intact,
# service healthy. The plain `upgrade` scenario cannot see any of this: it
# installs the same tarball twice and short-circuits at "already at VERSION",
# so its migrations only ever run against an empty database.
#
# OLD VERSION PIN — bump deliberately, not to "latest":
#   v0.5.0 is the newest release whose schema is pre-0038 (migrations end at
#   0024), which is what makes the seeded port meaningful. When a future
#   schema fork needs the same treatment, point this at the newest release
#   BEFORE the destructive migration and update seed-schedules.py +
#   assert-upgraded.py (they document their expectations in lockstep).
#   The release must have a supermux-<arch>.tar.gz asset + checksums.txt
#   (every release since v0.4.x does).
set -euo pipefail

OLD_VERSION="${SUPERMUX_SEED_OLD_VERSION:-v0.5.0}"

apt-get update -qq
apt-get install -y -qq curl ca-certificates python3

# ── 1. install the real released OLD version ─────────────────────────────────
# SUPERMUX_TARBALL_FROM (the locally-built tarball) must NOT leak into this
# step: unset it so install.sh downloads + checksum-verifies the release.
env -u SUPERMUX_TARBALL_FROM \
  SUPERMUX_INSTALL_CLAUDE=0 SUPERMUX_VERSION="$OLD_VERSION" bash /src/install.sh

[ "$(head -1 /usr/local/share/supermux/installed-version)" = "$OLD_VERSION" ] \
  || { echo "[scenario] expected installed-version $OLD_VERSION"; exit 1; }

AUTH=$(find /home -name auth_token -path '*.supermux*' | head -1)
TOK_BEFORE=$(cat "$AUTH")
DB="$(dirname "$AUTH")/data.db"
[ -f "$DB" ] || { echo "[scenario] old version never created $DB"; exit 1; }
DB_OWNER="$(stat -c '%U' "$DB")"

# ── 2. seed pre-0038 scheduler data while nothing writes the DB ──────────────
systemctl stop supermux
python3 /src/tests/install/seed-schedules.py "$DB"
for f in "$DB" "$DB-wal" "$DB-shm"; do
  [ -f "$f" ] && chown "$DB_OWNER:$DB_OWNER" "$f"
done

# The old server must accept the seed as genuine data — boot it and read the
# rows back through its own API, so we know we migrated a REAL pre-upgrade
# state, not python-flavoured garbage.
systemctl start supermux
for i in $(seq 1 30); do
  curl -fsS --max-time 2 http://127.0.0.1:8824/api/health >/dev/null 2>&1 && break
  [ "$i" = 30 ] && { echo "[scenario] old version unhealthy after seeding"; exit 1; }
  sleep 1
done
LIST=$(curl -fsS -H "Authorization: Bearer $TOK_BEFORE" http://127.0.0.1:8824/api/schedules)
for id in SCHED-seed-p1 SCHED-seed-p3 SCHED-seed-r-shell; do
  echo "$LIST" | grep -q "$id" \
    || { echo "[scenario] old server does not list seeded $id"; exit 1; }
done
echo "[scenario] old server ($OLD_VERSION) serves the seeded schedules"

# ── 3. upgrade to the freshly-built tarball ──────────────────────────────────
out=$(SUPERMUX_INSTALL_CLAUDE=0 bash /src/install.sh 2>&1) \
  || { echo "$out"; echo "[scenario] upgrade install failed"; exit 1; }
echo "$out" | grep -q "upgrading: ${OLD_VERSION} " \
  || { echo "$out"; echo "[scenario] installer did not take the upgrade path"; exit 1; }

# ── 4. assert the migration did what it promises ─────────────────────────────
[ "$(cat "$AUTH")" = "$TOK_BEFORE" ] \
  || { echo "[scenario] auth_token rotated across the upgrade"; exit 1; }
python3 /src/tests/install/assert-upgraded.py "$DB"

bash /src/tests/install/verify.sh
