#!/usr/bin/env bash
# Pull, rebuild and roll the stack on the VM. Invoked by the CD workflow over SSH.
set -euo pipefail
cd "$(dirname "$0")/../.."
git fetch --quiet origin main && git reset --hard origin/main
cd infra
# With a managed database (.env has MANAGED_DATABASE_URL) the overlay is always applied.
set -a; source ../.env; set +a
COMPOSE=(docker compose -f docker-compose.yml)
[ -n "${MANAGED_DATABASE_URL:-}" ] && COMPOSE+=(-f docker-compose.managed.yml)
"${COMPOSE[@]}" build --pull sandbox-jobs api worker web sandbox
"${COMPOSE[@]}" --profile tunnel up -d --remove-orphans
"${COMPOSE[@]}" ps
for i in $(seq 1 30); do
  curl -fsS http://127.0.0.1:8000/readyz >/dev/null && { echo "api ready"; exit 0; }; sleep 2
done
echo "api did not become ready"; docker compose logs --tail=100 api; exit 1
