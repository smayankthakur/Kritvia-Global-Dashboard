#!/usr/bin/env bash
# Nightly encrypted Postgres backup, shipped off the VM.
#   - pg_dump custom format from the running container
#   - encrypted with age to a PUBLIC key (the private key is kept offline, not on the VM)
#   - copied with rclone to object storage; local copies kept 7 days, remote retention set on the bucket
# Scheduled by infra/scripts/install-ops.sh (root, 02:15 IST). BACKUP_RCLONE_REMOTE can be any rclone
# remote; for S3 through the instance's IAM role (no keys on the VM):
#   BACKUP_RCLONE_REMOTE=:s3,provider=AWS,env_auth=true,region=ap-south-1:<bucket>
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source ../.env; set +a
: "${BACKUP_AGE_RECIPIENT:?set in .env}" "${BACKUP_RCLONE_REMOTE:?set in .env}"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
DIR=/var/backups/kritvia; mkdir -p "$DIR"; chmod 700 "$DIR"
OUT="$DIR/kritvia-$STAMP.dump.age"
docker compose exec -T postgres pg_dump -U postgres -d kritvia -Fc --no-owner \
  | age -r "$BACKUP_AGE_RECIPIENT" > "$OUT"
[ -s "$OUT" ] || { echo "backup is empty"; exit 1; }
sha256sum "$OUT" > "$OUT.sha256"
rclone copy "$OUT" "$BACKUP_RCLONE_REMOTE/" && rclone copy "$OUT.sha256" "$BACKUP_RCLONE_REMOTE/"
find "$DIR" -name 'kritvia-*.age*' -mtime +7 -delete
mkdir -p /var/lib/kritvia && date +%s > /var/lib/kritvia/last-backup
echo "$(date -u) backup ok: $(basename "$OUT") $(du -h "$OUT" | cut -f1)"
