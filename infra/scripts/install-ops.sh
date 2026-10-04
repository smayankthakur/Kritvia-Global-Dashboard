#!/usr/bin/env bash
# Install the operations jobs on the server (idempotent; run as root via sudo):
#   - health watchdog every 5 minutes (healthcheck.sh; email alerts via AWS SNS when configured)
#   - nightly encrypted backup at 02:15 IST, once BACKUP_AGE_RECIPIENT and BACKUP_RCLONE_REMOTE are set
#   - daily log archive kept one year on this server (archive-logs.sh)
#   - the AWS CLI (used for SNS alerts; S3 backups go through rclone with the instance role)
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "run with sudo"; exit 1; }
DIR="$(cd "$(dirname "$0")/../.." && pwd)"
. "$DIR/infra/scripts/load-env.sh"; load_env "$DIR/.env"

if ! command -v aws >/dev/null; then
  apt-get install -y -qq unzip >/dev/null
  arch=$(uname -m); tmp=$(mktemp -d)
  curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-${arch}.zip" -o "$tmp/aws.zip"
  unzip -q "$tmp/aws.zip" -d "$tmp" && "$tmp/aws/install" >/dev/null && rm -rf "$tmp"
fi
chmod +x "$DIR"/infra/scripts/*.sh
mkdir -p /var/lib/kritvia

{
  echo "# Managed by $DIR/infra/scripts/install-ops.sh — re-run it instead of editing"
  echo "SHELL=/bin/bash"
  echo "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
  echo "*/5 * * * * root $DIR/infra/scripts/healthcheck.sh >/dev/null 2>&1"
  echo "10 0 * * * root $DIR/infra/scripts/archive-logs.sh >> /var/log/kritvia-logs.log 2>&1   # 05:40 IST"
  if [ -n "${BACKUP_AGE_RECIPIENT:-}" ] && [ -n "${BACKUP_RCLONE_REMOTE:-}" ]; then
    echo "45 20 * * * root $DIR/infra/scripts/backup.sh >> /var/log/kritvia-backup.log 2>&1   # 02:15 IST"
  fi
} > /etc/cron.d/kritvia
chmod 644 /etc/cron.d/kritvia
echo "installed /etc/cron.d/kritvia:"; grep -v '^#' /etc/cron.d/kritvia
[ -n "${ALERT_SNS_TOPIC_ARN:-}" ] && echo "alerts: SNS $ALERT_SNS_TOPIC_ARN" || echo "alerts: syslog only (set ALERT_SNS_TOPIC_ARN in .env for email)"
