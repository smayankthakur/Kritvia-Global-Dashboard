#!/usr/bin/env bash
# Move Kritvia's data from the VM's Postgres container to a managed Postgres, then switch the
# stack to docker-compose.managed.yml. Downtime: the length of one dump + restore (minutes).
#
#   1. Create the instance (Postgres 16, pgvector available; RDS: db.t4g.small+ in ap-south-1,
#      private subnet, security group allowing 5432 from this VM only, automated backups on).
#   2. psql … -f infra/postgres/managed-roles.sql   (creates the database, roles, extensions)
#   3. Put MANAGED_DATABASE_URL and MANAGED_MIGRATION_DATABASE_URL in /opt/kritvia/.env
#   4. sudo infra/scripts/migrate-to-managed-db.sh
#
# The old container data is left in place (volume pgdata) until you remove it yourself.
set -euo pipefail
cd "$(dirname "$0")/.."
. scripts/load-env.sh; load_env ../.env
: "${MANAGED_MIGRATION_DATABASE_URL:?set in .env}" "${MANAGED_DATABASE_URL:?set in .env}"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

echo "1/5 target reachable?"
docker compose exec -T postgres psql "$MANAGED_MIGRATION_DATABASE_URL" -At -c "select version()" | head -1
EXT=$(docker compose exec -T postgres psql "$MANAGED_MIGRATION_DATABASE_URL" -At -c "select count(*) from pg_extension where extname in ('vector','pgcrypto')")
[ "$EXT" = "2" ] || { echo "run infra/postgres/managed-roles.sql on the target first"; exit 1; }
ROWS=$(docker compose exec -T postgres psql "$MANAGED_MIGRATION_DATABASE_URL" -At -c "select count(*) from information_schema.tables where table_schema='public'")
[ "$ROWS" = "0" ] || { echo "target already has tables; refusing to overwrite"; exit 1; }

echo "2/5 stopping writers (api, worker) — maintenance window starts"
docker compose stop api worker

echo "3/5 dumping"
# ACLs are kept: the GRANTs to kritvia_app that the migrations made travel with the data.
docker compose exec -T postgres pg_dump -U postgres -d kritvia -Fc --no-owner > "$TMP/db.dump"
LOCAL_COUNT=$(docker compose exec -T postgres psql -U postgres -d kritvia -At -c "select count(*) from audit_log")

echo "4/5 restoring as kritvia_owner (so every table and SECURITY DEFINER function is owned by it)"
docker compose exec -T postgres pg_restore -d "$MANAGED_MIGRATION_DATABASE_URL" --no-owner --exit-on-error < "$TMP/db.dump"
REMOTE_COUNT=$(docker compose exec -T postgres psql "$MANAGED_DATABASE_URL" -At -c "select count(*) from audit_log" 2>/dev/null || echo "?")
echo "audit_log rows: local=$LOCAL_COUNT remote=$REMOTE_COUNT"

echo "5/5 checking migrations match, then starting on the managed database"
docker compose -f docker-compose.yml -f docker-compose.managed.yml run --rm migrate
docker compose -f docker-compose.yml -f docker-compose.managed.yml --profile tunnel up -d --build api worker
sleep 10
curl -fsS http://127.0.0.1:8000/readyz && echo
echo "done. Add '-f docker-compose.managed.yml' to every compose command from now on (infra/scripts/deploy.sh does)."
