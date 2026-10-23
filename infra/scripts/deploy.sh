#!/usr/bin/env bash
# Pull, rebuild and roll the stack on the VM, quietly. Used by the CD workflow over SSH and by hand:
#
#   sudo /opt/kritvia/infra/scripts/deploy.sh          # in the foreground, short summary at the end
#   sudo /opt/kritvia/infra/scripts/deploy.sh --bg     # in the background; follow /var/log/kritvia-deploy.log
#
# What makes it quiet:
#   - Images are built while the old containers keep serving; only services whose image or
#     settings changed are recreated, so most deploys restart api, worker and web only, for seconds.
#   - Only one deploy runs at a time ($STATE_DIR/deploy.lock); a second one exits at once.
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
# One deploy at a time. Two at once (a hand-run deploy while another was going) raced each other's
# "compose up", the loser rolled the code back to its own starting commit, and its exit removed the
# "deploying" mark while the other was still restarting services. The lock is held until this script
# exits, whatever way it exits; the health watchdog also stands down while it is held.
LOCK="$STATE_DIR/deploy.lock"
exec 9>"$LOCK"
if ! flock -n 9; then
  printf '%s  another deploy is already running; not starting a second one (it holds %s)\n' "$(date -u +%H:%M:%S)" "$LOCK"
  exit 1
fi
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
# App store hosted apps: the MCP runner (compose profile "apps") runs once .env has MCP_RUNNER_TOKEN.
PROFILES=(--profile tunnel); EXTRA=()
if [ -n "${MCP_RUNNER_TOKEN:-}" ]; then PROFILES+=(--profile apps); EXTRA+=(mcp-runner); fi
# The browser agent (profile "browser") runs only under gVisor: Chromium opens pages anyone wrote, so it never
# runs on the host's own kernel in production (test report S5). Without runsc the rest still deploys.
BROWSER_OFF=""
if [ -n "${BROWSER_TOKEN:-}" ]; then
  if [ "${BROWSER_RUNTIME:-}" = "runsc" ] && docker info 2>/dev/null | grep -qi runsc; then
    PROFILES+=(--profile browser); EXTRA+=(browser-chromium browser-egress browser)
  else
    BROWSER_OFF="BROWSER_RUNTIME isn't runsc (or gVisor isn't installed), so the browser agent stays off"
  fi
fi

step "building images (old containers keep serving)"
if ! "${COMPOSE[@]}" build --pull --quiet migrate sandbox-jobs api worker worker-priority web sandbox "${EXTRA[@]}" >"$BUILD_LOG" 2>&1; then
  step "BUILD FAILED; nothing was restarted. Last lines of $BUILD_LOG:"
  tail -25 "$BUILD_LOG"
  exit 1
fi

# Containers that are recreated lose their logs: archive everything since the last archive first.
bash "$ROOT/infra/scripts/archive-logs.sh" >>"$BUILD_LOG" 2>&1 || step "warning: log archive before restart failed"

if [ -n "$BROWSER_OFF" ]; then
  step "warning: $BROWSER_OFF (set BROWSER_RUNTIME=runsc in .env)"
  "${COMPOSE[@]}" --profile browser rm -sf browser browser-chromium browser-egress >>"$BUILD_LOG" 2>&1 || true
fi
step "starting changed services"
if ! "${COMPOSE[@]}" "${PROFILES[@]}" up -d --remove-orphans --quiet-pull >>"$BUILD_LOG" 2>&1; then
  # Most often a migration that failed (it runs before api and worker start, so the old containers keep
  # serving). Say why, and put the code and images back to the previous version so a later restart
  # (the health watchdog, a reboot) doesn't start new code against the old database.
  step "STARTING FAILED. Migration log (last lines):"
  "${COMPOSE[@]}" logs --tail=40 --no-color migrate 2>/dev/null || true
  step "other output (last lines of $BUILD_LOG):"
  tail -15 "$BUILD_LOG"
  if [ "$before" != "$after" ]; then
    step "rolling the code back to $before and rebuilding its images"
    cd "$ROOT" && git reset --quiet --hard "$before" && cd infra
    "${COMPOSE[@]}" build --quiet migrate api worker worker-priority web "${EXTRA[@]}" >>"$BUILD_LOG" 2>&1 \
      || step "rebuilding the previous images failed too; see $BUILD_LOG"
    "${COMPOSE[@]}" "${PROFILES[@]}" up -d --quiet-pull >>"$BUILD_LOG" 2>&1 || true
  fi
  exit 1
fi

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
