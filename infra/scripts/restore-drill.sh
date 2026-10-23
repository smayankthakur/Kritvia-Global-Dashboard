#!/usr/bin/env bash
# Restore drill: restore the latest (or a given) backup into a SCRATCH database and
# verify it — migrations table present, audit chains intact. Never touches 'kritvia'.
#   AGE_IDENTITY=/path/to/offline/key.txt ./restore-drill.sh [backup-file]
# The private key is kept offline, so this runs by hand (monthly is a good rhythm); every nightly backup
# is already checked with pg_restore --list before it is uploaded (backup.sh). Works with the bundled
# postgres and with a managed database (restores into a throwaway server).
set -euo pipefail
cd "$(dirname "$0")/.."
. scripts/load-env.sh; load_env ../.env
: "${AGE_IDENTITY:?path to the offline age private key}"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
if [ -n "${1:-}" ] && [ -f "$1" ]; then
  SRC=$1; FILE=$1
else
  FILE=${1:-$(rclone lsf "$BACKUP_RCLONE_REMOTE/" --include 'kritvia-*.dump.age' | sort | tail -1)}
  rclone copy "$BACKUP_RCLONE_REMOTE/$FILE" "$TMP/"
  SRC="$TMP/$FILE"
fi
age -d -i "$AGE_IDENTITY" "$SRC" > "$TMP/db.dump"
if [ -n "${MANAGED_DATABASE_URL:-}" ]; then
  # With a managed database there is no local postgres service: restore into a throwaway server instead.
  CID=$(docker run -d --rm -e POSTGRES_PASSWORD="$(head -c 18 /dev/urandom | base64)" pgvector/pgvector:pg16)
  trap 'docker stop "$CID" >/dev/null 2>&1; rm -rf "$TMP"' EXIT
  for _ in $(seq 1 60); do docker exec "$CID" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
  PSQL=(docker exec -i "$CID" psql -U postgres); RESTORE=(docker exec -i "$CID" pg_restore -U postgres)
else
  PSQL=(docker compose exec -T postgres psql -U postgres); RESTORE=(docker compose exec -T postgres pg_restore -U postgres)
fi
"${PSQL[@]}" -c "DROP DATABASE IF EXISTS kritvia_restore_drill" -c "CREATE DATABASE kritvia_restore_drill"
"${PSQL[@]}" -d kritvia_restore_drill -c "CREATE EXTENSION IF NOT EXISTS vector"
"${RESTORE[@]}" -d kritvia_restore_drill --no-owner < "$TMP/db.dump"
"${PSQL[@]}" -d kritvia_restore_drill -At -c \
  "SELECT 'migrations=' || count(*) FROM schema_migrations" -c \
  "SELECT 'org ' || id || ' chain ' || coalesce('BROKEN at ' || private.audit_verify(id), 'intact') FROM organisations"
"${PSQL[@]}" -c "DROP DATABASE kritvia_restore_drill"
echo "restore drill passed for $FILE"
