#!/usr/bin/env bash
# Reopen an organisation closed less than 30 days ago (Terms of Service 18.5).
#   sudo bash infra/scripts/restore-org.sh <org id> <email of the owner's new account>
# The owner must first sign up again with that email (their old account was anonymised).
# Agents stay off and connectors must be reconnected by the owner.
set -euo pipefail
[ $# -eq 2 ] || { echo "usage: $0 <org id> <owner email>"; exit 2; }
[[ "$1" =~ ^[0-9a-fA-F-]{36}$ ]] || { echo "org id must be a UUID"; exit 2; }
[[ "$2" =~ ^[^[:space:]@\']+@[^[:space:]@\']+$ ]] || { echo "that email looks wrong"; exit 2; }
cd "$(dirname "$0")/.."
docker compose exec -T postgres psql -U postgres -d kritvia -v ON_ERROR_STOP=1 -tAc \
  "SELECT private.restore_org('$1'::uuid, '$2')" \
  && echo "restored: the owner can sign in, switch agents back on and reconnect Google/WhatsApp."
