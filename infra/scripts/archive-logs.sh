#!/usr/bin/env bash
# Daily archive of the stack's container logs, kept on this server (in India) for one year, then
# deleted. CERT-In's 2022 directions require 180 days of logs within India; the DPDP Rules 2025
# (rule 6) ask for one year. The Privacy Policy promises "one year, then deleted".
# Scheduled by infra/scripts/install-ops.sh (root, 00:10 UTC). Archives are readable by root only.
set -euo pipefail
cd "$(dirname "$0")/.."
DIR=/var/log/kritvia; mkdir -p "$DIR"; chmod 700 "$DIR"
OUT="$DIR/app-$(date -u +%F).log.gz"
docker compose logs --no-color --timestamps --since 24h 2>&1 | gzip -9 > "$OUT.tmp"
mv "$OUT.tmp" "$OUT"; chmod 600 "$OUT"
find "$DIR" -name 'app-*.log.gz' -mtime +365 -delete
echo "$(date -u) logs archived: $(basename "$OUT") $(du -h "$OUT" | cut -f1)"
