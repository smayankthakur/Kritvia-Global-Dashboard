#!/usr/bin/env bash
# Health watchdog, run by cron every 5 minutes as root (see install-ops.sh).
#
# Checks: API ready, web up, every service running, sandbox isolated, public URL through
# the Cloudflare tunnel, disk space, (once backups are configured) backup freshness, and a
# spike of application errors in the API and worker logs.
# Outages users can see (API, web, public URL, a stopped service) are also recorded as public
# incidents in $STATE_DIR/status/incidents.json, which the web app's /status page shows.
# A stopped service is restarted. Email alerts go out through AWS SNS when
# ALERT_SNS_TOPIC_ARN is set in .env (independent of Kritvia itself, so they still
# arrive when Kritvia is down): on the first failure, every 6 hours while it lasts,
# and once on recovery. Everything is also written to syslog (tag: kritvia-health).
set -uo pipefail
cd "$(dirname "$0")/.."
. scripts/load-env.sh; load_env ../.env || true
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

# Application errors: a burst of tracebacks or ERROR lines in five minutes means something is
# failing for users even when every health endpoint answers. Only the count goes in the alert.
errs=$($DC logs --since 5m --no-color api worker 2>/dev/null | grep -cE 'Traceback \(most recent call last\)|\bERROR\b' || true)
[ "${errs:-0}" -lt "${ERROR_ALERT_THRESHOLD:-10}" ] || fails+=("${errs} application errors in the last 5 minutes (api/worker logs)")

# Public incidents for the status page (no internal detail: what users would have noticed, and when).
public=()
for f in "${fails[@]}"; do
  case "$f" in
    "API not ready"*) public+=("The API and agents were not responding") ;;
    "web app"*) public+=("The web app was not responding") ;;
    "public URL"*) public+=("Kritvia could not be reached from the internet") ;;
    "service(s) were down"*) public+=("A service stopped and was restarted automatically") ;;
  esac
done
mkdir -p "$STATE_DIR/status"; chmod 755 "$STATE_DIR/status"
incident() {  # incident open "summary" | incident close
  python3 - "$STATE_DIR/status/incidents.json" "$@" <<'PY'
import json, os, sys, time
path, action = sys.argv[1], sys.argv[2]
now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
try:
    items = json.load(open(path))
except Exception:
    items = []
opened = [i for i in items if not i.get("resolved_at")]
if action == "open" and not opened:
    items.insert(0, {"started_at": now, "resolved_at": None, "summary": sys.argv[3]})
elif action == "close":
    for i in opened:
        i["resolved_at"] = now
cutoff = time.time() - 90 * 86400
items = [i for i in items if time.mktime(time.strptime(i["started_at"], "%Y-%m-%dT%H:%M:%SZ")) >= cutoff][:50]
tmp = path + ".tmp"
json.dump(items, open(tmp, "w"), indent=1)
os.chmod(tmp, 0o644)
os.replace(tmp, path)
PY
}
if [ ${#public[@]} -gt 0 ]; then
  incident open "$(printf '%s; ' "${public[@]}" | sed 's/; $//')"
else
  incident close
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
