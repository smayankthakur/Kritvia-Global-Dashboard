#!/usr/bin/env bash
# Pull, rebuild and roll the stack on the VM, quietly. Used by the CD workflow over SSH and by hand:
#
#   sudo /opt/kritvia/infra/scripts/deploy.sh          # in the foreground, short summary at the end
#   sudo /opt/kritvia/infra/scripts/deploy.sh --bg     # in the background; follow /var/log/kritvia-deploy.log
#
# What makes it quiet:
#   - Images are built while the old containers keep serving; only services whose image or
#     settings changed are recreated, so most deploys restart api, worker and web only, for seconds.
#   - While a deploy runs, $STATE_DIR/deploying tells the health watchdog (healthcheck.sh) to stand
#     down: no restarts behind compose's back, no public incident on the status page, no alert email.
#     A deploy that hangs longer than 30 minutes stops counting, so a real outage is still reported.
#   - Build and pull output go to the log; the terminal gets one line per stage and a summary.
set -euo pipefail
LOG=/var/log/kritvia-deploy.log
if [ "${1:-}" = "--bg" ]; then
  nohup "$0" >"$LOG" 2>&1 &
  echo "deploying in the background (pid $!); follow it with: tail -f $LOG"
  exit 0
fi

cd "$(dirname "$0")/../.."
ROOT=$(pwd)
STATE_DIR=/var/lib/kritvia; mkdir -p "$STATE_DIR"
MARK="$STATE_DIR/deploying"
BUILD_LOG="$STATE_DIR/deploy-build.log"
date +%s > "$MARK"
trap 'rm -f "$MARK"' EXIT
step() { printf '%s  %s\n' "$(date -u +%H:%M:%S)" "$*"; }
started=$(date +%s)

before=$(git rev-parse --short HEAD)
git fetch --quiet origin main && git reset --quiet --hard origin/main
after=$(git rev-parse --short HEAD)
step "code: $before -> $after  $(git --no-pager log -1 --format=%s)"

cd infra
# With a managed database (.env has MANAGED_DATABASE_URL) the overlay is always applied.
. scripts/load-env.sh; load_env ../.env
COMPOSE=(docker compose -f docker-compose.yml)
[ -n "${MANAGED_DATABASE_URL:-}" ] && COMPOSE+=(-f docker-compose.managed.yml)

step "building images (old containers keep serving)"
if ! "${COMPOSE[@]}" build --pull --quiet migrate sandbox-jobs api worker worker-priority web sandbox browser >"$BUILD_LOG" 2>&1; then
  step "BUILD FAILED; nothing was restarted. Last lines of $BUILD_LOG:"
  tail -25 "$BUILD_LOG"
  exit 1
fi

step "starting changed services"
"${COMPOSE[@]}" --profile tunnel up -d --remove-orphans --quiet-pull >>"$BUILD_LOG" 2>&1

ready=no
for _ in $(seq 1 45); do
  if curl -fsS -m 5 http://127.0.0.1:8000/readyz >/dev/null 2>&1; then ready=yes; break; fi
  sleep 2
done
if [ "$ready" != yes ]; then
  step "API DID NOT BECOME READY. Last API log lines:"
  "${COMPOSE[@]}" logs --tail=60 --no-color api
  exit 1
fi

bash "$ROOT/infra/scripts/install-ops.sh" >/dev/null 2>&1 || step "warning: install-ops.sh failed (cron jobs may be stale)"
docker image prune -f >/dev/null 2>&1 || true   # old image layers, so disk doesn't fill up deploy by deploy
docker builder prune -f --keep-storage 3GB >/dev/null 2>&1 || docker builder prune -f >/dev/null 2>&1 || true   # build cache grew to 46 GB once; keep it small

rm -f "$MARK"
step "health check"
if bash "$ROOT/infra/scripts/healthcheck.sh" >/dev/null 2>&1; then health="all checks pass"; else health="CHECKS FAILING (see: journalctl -t kritvia-health -n 20)"; fi
migrations=$(curl -fsS -m 5 http://127.0.0.1:8000/readyz | python3 -c 'import json,sys; print(json.load(sys.stdin).get("migrations","?"))' 2>/dev/null || echo "?")
step "done in $(( $(date +%s) - started ))s: $after, $migrations migrations, $health"
echo DEPLOY-DONE
