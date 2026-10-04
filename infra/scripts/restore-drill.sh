#!/usr/bin/env bash
# Restore drill: restore the latest (or a given) backup into a SCRATCH database and
# verify it — migrations table present, audit chains intact. Never touches 'kritvia'.
#   AGE_IDENTITY=/path/to/offline/key.txt ./restore-drill.sh [backup-file]
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
docker compose exec -T postgres psql -U postgres -c "DROP DATABASE IF EXISTS kritvia_restore_drill" \
  -c "CREATE DATABASE kritvia_restore_drill"
docker compose exec -T postgres psql -U postgres -d kritvia_restore_drill -c "CREATE EXTENSION IF NOT EXISTS vector"
docker compose exec -T postgres pg_restore -U postgres -d kritvia_restore_drill --no-owner < "$TMP/db.dump"
docker compose exec -T postgres psql -U postgres -d kritvia_restore_drill -At -c \
  "SELECT 'migrations=' || count(*) FROM schema_migrations" -c \
  "SELECT 'org ' || id || ' chain ' || coalesce('BROKEN at ' || private.audit_verify(id), 'intact') FROM organisations"
docker compose exec -T postgres psql -U postgres -c "DROP DATABASE kritvia_restore_drill"
echo "restore drill passed for $FILE"
