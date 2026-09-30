#!/usr/bin/env bash
# Start a demo Kritvia (API + web) with seed data. Safe to re-run.
#   Sign in: demo@example.com / kritvia-demo-2026
# No model keys are needed for the demo: the kitchen plan runs without an LLM (its
# numbers are code); lead triage and loan checks need a model gateway (see docs/runbook.md).
set -euo pipefail
cd "$(dirname "$0")/.."
export PGPASSWORD=postgres PGHOST=localhost
mkdir -p .dev && chmod 700 .dev
for i in $(seq 1 30); do pg_isready -q -h localhost -U postgres && break; sleep 1; done

if [ ! -f .dev/env ]; then
  bash infra/postgres/local-bootstrap.sh kritvia >/dev/null
  {
    echo "export DATABASE_URL=postgresql+asyncpg://kritvia_app:app@localhost/kritvia"
    echo "export JWT_SECRET=$(python -c 'import secrets;print(secrets.token_urlsafe(48))')"
    echo "export MASTER_KEK_B64=$(python -m kritvia_api.cli new-kek)"
    echo "export DISPATCH_MODE=background ENVIRONMENT=development MESSAGING_FALLBACK=log"
    echo "export AUTH_RATE_LIMIT_PER_MINUTE=100"
  } > .dev/env
fi
source .dev/env
if [ -n "${CODESPACE_NAME:-}" ]; then
  WEB="https://${CODESPACE_NAME}-3000.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}"
else
  WEB="http://localhost:3000"
fi
export PUBLIC_WEB_URL="$WEB" ALLOWED_ORIGINS="[\"$WEB\", \"http://localhost:3000\"]"
MIGRATION_DATABASE_URL=postgresql://kritvia_owner:owner@localhost/kritvia python -m kritvia_api.db.migrate

for f in .dev/api.pid .dev/web.pid; do [ -f "$f" ] && kill -- "-$(cat "$f")" 2>/dev/null || true; done
(cd apps/api; setsid nohup uvicorn kritvia_api.main:app --host 0.0.0.0 --port 8000 > ../../.dev/api.log 2>&1 < /dev/null &
 echo $! > ../../.dev/api.pid)
for i in $(seq 1 30); do curl -fs localhost:8000/readyz >/dev/null && break; sleep 1; done

[ -f .dev/seeded ] || { python scripts/seed_demo.py && touch .dev/seeded; }

KRITVIA_API_URL=http://localhost:8000 KRITVIA_TRUSTED_ORIGINS="$WEB" KRITVIA_COOKIE_SECURE=false \
  setsid nohup pnpm --filter @kritvia/web dev > .dev/web.log 2>&1 < /dev/null &
echo $! > .dev/web.pid
for i in $(seq 1 90); do curl -fs -o /dev/null localhost:3000/login && break; sleep 2; done
echo
echo "Kritvia is running:  $WEB"
echo "Sign in with:        demo@example.com / kritvia-demo-2026"
echo "Logs:                .dev/api.log  .dev/web.log"
