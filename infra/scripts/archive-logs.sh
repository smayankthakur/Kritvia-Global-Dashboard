#!/usr/bin/env bash
# Archive of the stack's container logs, kept on this server (in India) for one year, then deleted.
# CERT-In's 2022 directions require 180 days of logs within India; the DPDP Rules 2025 (rule 6) ask
# for one year. The Privacy Policy promises "one year, then deleted". Archives are readable by root only.
#
# Runs every hour (install-ops.sh) and just before a deploy recreates containers (deploy.sh), each time
# from where the last archive stopped ($STATE/logs.archived-until). So nothing is lost when a deploy
# replaces a container (its logs go with it) or when a busy container rotates its logs within a day.
set -euo pipefail
cd "$(dirname "$0")/.."
. scripts/load-env.sh; load_env ../.env || true
DIR=/var/log/kritvia; mkdir -p "$DIR"; chmod 700 "$DIR"
STATE=/var/lib/kritvia; mkdir -p "$STATE"; MARK="$STATE/logs.archived-until"
COMPOSE=(docker compose -f docker-compose.yml)
[ -n "${MANAGED_DATABASE_URL:-}" ] && COMPOSE+=(-f docker-compose.managed.yml)
now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
since=$(cat "$MARK" 2>/dev/null || date -u -d '-25 hours' +%Y-%m-%dT%H:%M:%SZ)
OUT="$DIR/app-$(date -u +%F-%H%M%S).log.gz"
"${COMPOSE[@]}" logs --no-color --timestamps --since "$since" --until "$now" 2>&1 | gzip -9 > "$OUT.tmp"
mv "$OUT.tmp" "$OUT"; chmod 600 "$OUT"
echo "$now" > "$MARK"
find "$DIR" -name 'app-*.log.gz' -mtime +365 -delete
echo "$(date -u) logs archived from $since: $(basename "$OUT") $(du -h "$OUT" | cut -f1)"
