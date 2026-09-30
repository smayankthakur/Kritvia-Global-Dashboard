#!/usr/bin/env bash
# Pull, rebuild and roll the stack on the VM. Invoked by the CD workflow over SSH.
set -euo pipefail
cd "$(dirname "$0")/../.."
git fetch --quiet origin main && git reset --hard origin/main
cd infra
docker compose build --pull sandbox-jobs api worker web sandbox
docker compose up -d --remove-orphans
docker compose ps
for i in $(seq 1 30); do
  curl -fsS http://127.0.0.1:8000/readyz >/dev/null && { echo "api ready"; exit 0; }; sleep 2
done
echo "api did not become ready"; docker compose logs --tail=100 api; exit 1
