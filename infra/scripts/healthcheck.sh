#!/usr/bin/env bash
# Health watchdog, run by cron every minute as root (see install-ops.sh).
#
# Every minute: API ready, web up, every service running, the workers' heartbeats (/livez).
# Every 5 minutes also: sandbox isolated, public URL through the Cloudflare tunnel, disk space,
# backup freshness (once backups are configured), and a spike of application errors or security events.
# Self-healing: a stopped service is started; a worker whose heartbeat is older than 3 minutes is
# restarted; the API or web app failing 3 minutes in a row is restarted.
# Outages users can see (API, web, public URL, a stopped service) are also recorded as public
# incidents in $STATE_DIR/status/incidents.json, which the web app's /status page shows.
# A stopped service is restarted. Email alerts go out through AWS SNS when
# ALERT_SNS_TOPIC_ARN is set in .env (independent of Kritvia itself, so they still
# arrive when Kritvia is down), and to Telegram when ALERT_TELEGRAM_BOT_TOKEN and ALERT_TELEGRAM_CHAT_ID are
# set: on the first failure, every 6 hours while it lasts, and once on recovery. Everything is also written
# to syslog (tag: kritvia-health).
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
. scripts/load-env.sh; load_env ../.env || true
STATE_DIR=/var/lib/kritvia; mkdir -p "$STATE_DIR"
STATE="$STATE_DIR/health.state"; LAST_ALERT="$STATE_DIR/health.alerted"
# A deploy is restarting services on purpose (deploy.sh): stand down, so it doesn't count as an
# outage, restart things behind it or email anyone. A deploy older than 30 minutes is treated as
# stuck and checked as usual.
if [ -f "$STATE_DIR/deploying" ] && [ $(( $(date +%s) - $(cat "$STATE_DIR/deploying" 2>/dev/null || echo 0) )) -lt 1800 ]; then
  logger -t kritvia-health "deploy in progress; checks skipped"
  exit 0
fi
# A deploy holds its lock until it exits, even if another one's exit removed the mark above.
if [ -f "$STATE_DIR/deploy.lock" ] && ! flock -n "$STATE_DIR/deploy.lock" true 2>/dev/null; then
  logger -t kritvia-health "deploy in progress (lock held); checks skipped"
  exit 0
fi
DC="docker compose -f docker-compose.yml"
[ -n "${MANAGED_DATABASE_URL:-}" ] && DC="$DC -f docker-compose.managed.yml"   # postgres lives elsewhere
fails=()

ok_http() { curl -fsS -m 10 -o /dev/null "$1"; }
FULL=0; [ $(( 10#$(date +%M) % 5 )) -eq 0 ] && FULL=1          # the heavier checks every 5 minutes
streak() {  # streak NAME ok|fail -> prints how many minutes in a row NAME has failed
  local f="$STATE_DIR/streak.$1" n=0
  if [ "$2" = fail ]; then n=$(( $(cat "$f" 2>/dev/null || echo 0) + 1 )); fi
  echo "$n" > "$f"; echo "$n"
}
heal=()

# /readyz answers 503 with "queue":"down" when the API is fine but Valkey (the run queue) isn't: then
# Valkey is what gets restarted, not the API.
ready=$(curl -sS -m 10 http://127.0.0.1:8000/readyz 2>/dev/null || true)
if grep -q '"queue":"down"' <<<"$ready"; then
  streak api ok >/dev/null
  fails+=("Valkey (the run queue) is not answering; new runs wait until it is back")
  if [ "$(streak valkey fail)" -ge 3 ]; then $DC restart valkey >/dev/null 2>&1; heal+=("valkey"); streak valkey ok >/dev/null; fi
elif grep -q '"status":"ok"' <<<"$ready"; then streak api ok >/dev/null; streak valkey ok >/dev/null; else
  fails+=("API not ready (127.0.0.1:8000/readyz)")
  if [ "$(streak api fail)" -ge 3 ]; then $DC restart api >/dev/null 2>&1; heal+=("api"); streak api ok >/dev/null; fi
fi
code=$(curl -s -m 10 -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/ || echo 000)
if [[ "$code" =~ ^[23] ]]; then streak web ok >/dev/null; else
  fails+=("web app answered HTTP $code")
  if [ "$(streak web fail)" -ge 3 ]; then $DC restart web >/dev/null 2>&1; heal+=("web"); streak web ok >/dev/null; fi
fi

# Workers: their heartbeats (every 30 s) must be under 3 minutes old, else the worker is restarted.
live=$(curl -s -m 10 http://127.0.0.1:8000/livez || true)
if [ -n "$live" ]; then
  for w in worker:worker_age_s worker-priority:priority_age_s; do
    svc=${w%%:*}; key=${w#*:}
    age=$(python3 -c "import json,sys; v=json.loads(sys.argv[1]).get(sys.argv[2]); print('' if v is None else v)" "$live" "$key" 2>/dev/null)
    if [ -n "$age" ] && [ "$age" -ge 180 ]; then
      cid=$($DC ps -q "$svc" 2>/dev/null | head -1)
      up=$(( $(date +%s) - $(date -d "$(docker inspect -f '{{.State.StartedAt}}' "$cid" 2>/dev/null || echo now)" +%s 2>/dev/null || date +%s) ))
      if [ -n "$cid" ] && [ "$up" -ge 180 ]; then      # a worker that just started hasn't had time to beat
        $DC restart "$svc" >/dev/null 2>&1; heal+=("$svc (heartbeat ${age}s old)")
      fi
    fi
  done
fi

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
[ ${#heal[@]} -gt 0 ] && fails+=("service(s) were not working and restarted: ${heal[*]}")

nquick=${#fails[@]}
if [ "$FULL" = 1 ]; then
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
errs=$($DC logs --since 5m --no-color api worker worker-priority 2>/dev/null | grep -cE 'Traceback \(most recent call last\)|\bERROR\b' || true)
[ "${errs:-0}" -lt "${ERROR_ALERT_THRESHOLD:-10}" ] || fails+=("${errs} application errors in the last 5 minutes (api/worker logs)")

# Security events (apps/api/kritvia_api/services/security_log.py): any critical event (e.g. a payment
# that doesn't match its plan) or a burst of warnings (failed sign-ins, bad webhook signatures,
# suspected prompt injection) alerts the owner. Never shown on the public status page.
if [ -z "${MANAGED_DATABASE_URL:-}" ]; then
  sec=$($DC exec -T postgres psql -U postgres -d kritvia -tAF'|' -c "SELECT * FROM private.security_alert_counts(5)" 2>/dev/null | head -1)
  crit=$(cut -d'|' -f1 <<<"$sec"); warn=$(cut -d'|' -f2 <<<"$sec"); top=$(cut -d'|' -f3 <<<"$sec")
  if [ "${crit:-0}" -gt 0 ] 2>/dev/null || [ "${warn:-0}" -ge "${SECURITY_WARN_THRESHOLD:-30}" ] 2>/dev/null; then
    fails+=("security: ${crit:-0} critical and ${warn:-0} warning event(s) in 5 minutes (most: ${top:-n/a}); see docs/security/security-events.md")
  fi
fi

fi   # FULL
# Between the 5-minute checks, their last findings still count (so the state doesn't flap ok/fail).
if [ "$FULL" = 1 ]; then
  printf '%s\n' "${fails[@]:$nquick}" > "$STATE_DIR/full.fails"
elif [ -s "$STATE_DIR/full.fails" ]; then
  while IFS= read -r line; do [ -n "$line" ] && fails+=("$line"); done < "$STATE_DIR/full.fails"
fi

# Public incidents for the status page (no internal detail: what users would have noticed, and when).
public=()
for f in "${fails[@]}"; do
  case "$f" in
    "API not ready"*) public+=("The API and agents were not responding") ;;
    "Valkey"*) public+=("New agent runs were delayed") ;;
    "web app"*) public+=("The web app was not responding") ;;
    "public URL"*) public+=("Kritvia could not be reached from the internet") ;;
    "service(s) were down"*|"service(s) were not working"*) public+=("A service stopped and was restarted automatically") ;;
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
  if [ -n "${ALERT_TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${ALERT_TELEGRAM_CHAT_ID:-}" ]; then
    curl -s -m 15 "https://api.telegram.org/bot${ALERT_TELEGRAM_BOT_TOKEN}/sendMessage" \
      --data-urlencode "chat_id=${ALERT_TELEGRAM_CHAT_ID}" --data-urlencode "text=$1
$2" >/dev/null 2>&1 || logger -t kritvia-health "Telegram alert failed"
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
