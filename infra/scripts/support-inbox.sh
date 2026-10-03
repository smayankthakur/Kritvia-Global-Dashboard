#!/usr/bin/env bash
# Help-page messages not yet handled (newest first). Mark one handled:
#   sudo infra/scripts/support-inbox.sh done <reference>
set -euo pipefail
cd "$(dirname "$0")/.."
if [ "${1:-}" = done ] && [ -n "${2:-}" ]; then
  docker compose exec -T postgres psql -U postgres -d kritvia -v ref="$2" -c \
    "UPDATE support_requests SET handled_at = now() WHERE id::text LIKE :'ref' || '%' AND handled_at IS NULL"
  exit 0
fi
docker compose exec -T postgres psql -U postgres -d kritvia -P pager=off -c \
  "SELECT left(id::text, 8) AS ref, created_at::timestamp(0) AS received, topic, name, email, left(message, 300) AS message
     FROM support_requests WHERE handled_at IS NULL ORDER BY created_at DESC LIMIT 50"
