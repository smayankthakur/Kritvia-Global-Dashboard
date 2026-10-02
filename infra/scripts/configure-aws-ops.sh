#!/usr/bin/env bash
# One-time: connect the server to its AWS backup bucket and alert topic, then switch on
# nightly backups, the health watchdog and email alerts. Run on the server:
#
#   cd /opt/kritvia && sudo bash infra/scripts/configure-aws-ops.sh
#
# Expects (created once in AWS): bucket kritvia-backups-<account>, SNS topic kritvia-alerts,
# and the IAM role kritvia-server attached to this instance (no access keys on the server).
# Safe to re-run: existing settings and the backup key are kept.
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "run with sudo"; exit 1; }
cd "$(dirname "$0")/../.."
REGION=ap-south-1
say() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
get() { grep -E "^$1=" .env | head -1 | cut -d= -f2- | sed 's/[[:space:]]*#.*$//; s/[[:space:]]*$//'; }
put() { python3 - "$1" "$2" <<'PY'
import re, sys
n, v = sys.argv[1], sys.argv[2]
lines = open(".env").read().splitlines()
for i, l in enumerate(lines):
    if re.match(rf"^{re.escape(n)}=", l):
        lines[i] = f"{n}={v}"; break
else:
    lines.append(f"{n}={v}")
open(".env", "w").write("\n".join(lines) + "\n")
PY
}

say "Installing the AWS CLI and the watchdog"
bash infra/scripts/install-ops.sh >/dev/null

say "Checking the server's AWS role"
ACCT=$(aws sts get-caller-identity --query Account --output text 2>/dev/null) \
  || { echo "  The IAM role is not attached to this instance yet (EC2 -> Actions -> Security -> Modify IAM role -> kritvia-server)."; exit 1; }
BUCKET="kritvia-backups-$ACCT"; TOPIC="arn:aws:sns:$REGION:$ACCT:kritvia-alerts"
aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null && echo "  bucket $BUCKET reachable" \
  || { echo "  cannot reach bucket $BUCKET"; exit 1; }

say "Backup encryption key"
KEY=/root/kritvia-backup-key.txt
if [ -z "$(get BACKUP_AGE_RECIPIENT)" ]; then
  age-keygen -o "$KEY" 2>/dev/null && chmod 600 "$KEY"
  put BACKUP_AGE_RECIPIENT "$(age-keygen -y "$KEY")"
  NEWKEY=1
  echo "  new key pair created; public key saved in .env"
else
  echo "  keeping the existing key (BACKUP_AGE_RECIPIENT already set)"
fi
put BACKUP_RCLONE_REMOTE ":s3,provider=AWS,env_auth=true,region=$REGION:$BUCKET"
put ALERT_SNS_TOPIC_ARN "$TOPIC"
chmod 600 .env

say "Scheduling backups and alerts"
bash infra/scripts/install-ops.sh | sed 's/^/  /'

say "First backup now"
bash infra/scripts/backup.sh
rclone lsf ":s3,provider=AWS,env_auth=true,region=$REGION:$BUCKET" --include 'kritvia-*' | tail -2 | sed 's/^/  in S3: /'

say "Test alert"
aws sns publish --region "$REGION" --topic-arn "$TOPIC" --subject "Kritvia alerts are working" \
  --message "This is a test from $(hostname). You will get an email like this if Kritvia has a problem, and one when it recovers." \
  >/dev/null && echo "  sent (arrives only after you click 'Confirm subscription' in the AWS email)"

say "Health check"
if bash infra/scripts/healthcheck.sh; then echo "  all checks pass"; else echo "  some checks failed — see: sudo journalctl -t kritvia-health -n 20"; fi

if [ "${NEWKEY:-}" = 1 ]; then cat <<EOF

$(printf '\033[1;33m')IMPORTANT — save the backup PRIVATE key now, then delete it from this server.$(printf '\033[0m')
Without it the backups cannot be decrypted. Show it with:

    sudo cat $KEY

Copy the whole text (3 lines) into your password manager, then remove it from the server:

    sudo shred -u $KEY

(For a restore drill, put it back temporarily: AGE_IDENTITY=/path/to/key sudo -E infra/scripts/restore-drill.sh)
EOF
fi
