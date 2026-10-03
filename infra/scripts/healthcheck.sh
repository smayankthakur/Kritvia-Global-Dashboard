#!/usr/bin/env bash
# Health watchdog, run by cron every 5 minutes as root (see install-ops.sh).
#
# Checks: API ready, web up, every service running, sandbox isolated, public URL through
# the Cloudflare tunnel, disk space, and (once backups are configured) backup freshness.
# A stopped service is restarted. Email alerts go out through AWS SNS when
# ALERT_SNS_TOPIC_ARN is set in .env (independent of Kritvia itself, so they still
# arrive when Kritvia is down): on the first failure, every 6 hours while it lasts,
# and once on recovery. Everything is also written to syslog (tag: kritvia-health).
set -uo pipefail
cd "$(dirname "$0")/.."
set -a; source ../.env 2>/dev/null; set +a
STATE_DIR=/var/lib/kritvia; mkdir -p "$STATE_DIR"
STATE="$STATE_DIR/health.state"; LAST_ALERT="$STATE_DIR/health.alerted"
DC="docker compose -f docker-compose.yml"
[ -n "${MANAGED_DATABASE_URL:-}" ] && DC="$DC -f docker-compose.managed.yml"   # postgres lives elsewhere
fails=()

ok_http() { curl -fsS -m 10 -o /dev/null "$1"; }

ok_http http://127.0.0.1:8000/readyz || fails+=("API not ready (127.0.0.1:8000/readyz)")
code=$(curl -s -m 10 -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/ || echo 000)
[[ "$code" =~ ^[23] ]] || fails+=("web app answered HTTP $code")

expected=$($DC config --services 2>/dev/null | grep -vE '^(migrate|sandbox-jobs|whisper|diarization)$')
[ -z "${CLOUDFLARE_TUNNEL_TOKEN:-}" ] && expected=$(echo "$expected" | grep -v '^cloudflared$')
running=$($DC ps --status running --services 2>/dev/null)
restarted=()
for s in $expected; do
  if ! grep -qx "$s" <<<"$running"; then
    if [ "$s" = cloudflared ]; then $DC --profile tunnel up -d cloudflared >/dev/null 2>&1; else $DC up -d "$s" >/dev/null 2>&1; fi
    restarted+=("$s")
  fi
done
[ ${#restarted[@]} -gt 0 ] && fails+=("service(s) were down and restarted: ${restarted[*]}")

sb=$($DC exec -T sandbox python -c "import urllib.request;print(urllib.request.urlopen('http://127.0.0.1:8100/healthz',timeout=20).read().decode())" 2>/dev/null)
grep -q '"network_isolated":true' <<<"$sb" || fails+=("sandbox health check failed or not isolated")

if [ -n "${PUBLIC_API_URL:-}" ] && [ -n "${CLOUDFLARE_TUNNEL_TOKEN:-}" ]; then
  ok_http "${PUBLIC_API_URL%/}/readyz" || fails+=("public URL ${PUBLIC_API_URL%/}/readyz not reachable (tunnel or DNS)")
fi

use=$(df --output=pcent / | tail -1 | tr -dc 0-9)
[ "${use:-0}" -lt 85 ] || fails+=("disk ${use}% full")

if [ -n "${BACKUP_AGE_RECIPIENT:-}" ] && [ -n "${BACKUP_RCLONE_REMOTE:-}" ]; then
  last=$(stat -c %Y "$STATE_DIR/last-backup" 2>/dev/null || echo 0)
  [ $(( $(date +%s) - last )) -lt $(( 26 * 3600 )) ] || fails+=("no successful backup in the last 26 hours")
fi

host=$(hostname)
alert() {  # alert SUBJECT MESSAGE
  logger -t kritvia-health "$1: $2"
  if [ -n "${ALERT_SNS_TOPIC_ARN:-}" ] && command -v aws >/dev/null; then
    region=$(cut -d: -f4 <<<"$ALERT_SNS_TOPIC_ARN")
    aws sns publish --region "$region" --topic-arn "$ALERT_SNS_TOPIC_ARN" \
      --subject "$1" --message "$2" >/dev/null 2>&1 || logger -t kritvia-health "SNS publish failed"
  fi
  date +%s > "$LAST_ALERT"
}

prev=$(cat "$STATE" 2>/dev/null || echo ok)
if [ ${#fails[@]} -eq 0 ]; then
  echo ok > "$STATE"
  [ "$prev" = fail ] && alert "Kritvia recovered ($host)" "All checks pass again at $(date -u '+%F %T UTC')."
  exit 0
fi

msg=$(printf -- '- %s\n' "${fails[@]}")
echo fail > "$STATE"
since=$(( $(date +%s) - $(cat "$LAST_ALERT" 2>/dev/null || echo 0) ))
if [ "$prev" = ok ] || [ $since -ge $(( 6 * 3600 )) ]; then
  alert "Kritvia problem ($host)" "$(date -u '+%F %T UTC') — failing checks:
$msg

Logs: cd /opt/kritvia/infra && sudo docker compose logs --tail=100 <service>"
else
  logger -t kritvia-health "still failing: ${fails[*]}"
fi
exit 1
