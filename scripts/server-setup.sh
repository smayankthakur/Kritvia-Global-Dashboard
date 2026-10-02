#!/usr/bin/env bash
# One-command install of the whole Kritvia stack (API, worker, web, Postgres, queue, sandbox,
# model gateway, local models, Cloudflare tunnel) on a fresh Ubuntu 22.04/24.04 server —
# made for the Oracle Cloud Always Free Ampere A1 VM (arm64), works on x86 too.
#
#   curl -fsSL https://raw.githubusercontent.com/smayankthakur/Kritvia-Global-Dashboard/main/scripts/server-setup.sh \
#     | bash -s -- sitelytc.com
#
# It asks for the provider keys (input hidden) the first time; everything else is generated on
# the server. Safe to re-run: it updates the code and restarts, keeping .env and data.
set -euo pipefail

DOMAIN="${1:-}"
REPO="${KRITVIA_REPO:-https://github.com/smayankthakur/Kritvia-Global-Dashboard.git}"
DIR="${KRITVIA_DIR:-/opt/kritvia}"
[ -n "$DOMAIN" ] || { echo "usage: bash server-setup.sh <your-domain>   e.g. sitelytc.com"; exit 1; }
[ "$(id -u)" -ne 0 ] || { echo "run as your normal user (e.g. ubuntu), not root; it uses sudo"; exit 1; }
WEB_HOST="app.$DOMAIN"
API_HOST="api.$DOMAIN"
say() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }

# ------------------------------------------------------------------ packages --
say "Installing Docker, git and tools"
sudo apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ca-certificates curl gnupg git openssl python3 \
  age rclone unattended-upgrades docker.io >/dev/null
# compose v2 plugin (package name differs between Ubuntu releases)
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker-compose-v2 >/dev/null 2>&1 \
  || sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker-compose-plugin >/dev/null
sudo systemctl enable --now docker >/dev/null
sudo usermod -aG docker "$USER"
echo 'Unattended-Upgrade::Automatic-Reboot "false";' | sudo tee /etc/apt/apt.conf.d/52kritvia >/dev/null
DOCKER="sudo docker"   # group membership only applies to new logins

# ---------------------------------------------------------------- swap (small VMs) --
if [ "$(awk '/MemTotal/ {print int($2/1048576)}' /proc/meminfo)" -lt 12 ] && ! swapon --show | grep -q .; then
  say "Adding a 4 GB swap file (this machine has little RAM)"
  sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile >/dev/null && sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

# --------------------------------------------------------------------- gVisor --
if ! command -v runsc >/dev/null; then
  say "Installing gVisor (sandbox isolation)"
  curl -fsSL https://gvisor.dev/archive.key | sudo gpg --batch --yes --dearmor -o /usr/share/keyrings/gvisor-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases release main" \
    | sudo tee /etc/apt/sources.list.d/gvisor.list >/dev/null
  sudo apt-get update -qq && sudo apt-get install -y -qq runsc >/dev/null
  sudo runsc install >/dev/null && sudo systemctl restart docker
fi
$DOCKER info 2>/dev/null | grep -qi runsc || { echo "gVisor runtime not registered with Docker"; exit 1; }

# ----------------------------------------------------------------------- code --
say "Getting the code into $DIR"
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" fetch --quiet origin main && git -C "$DIR" reset --quiet --hard origin/main
else
  sudo mkdir -p "$DIR" && sudo chown "$USER" "$DIR"
  git clone --quiet "$REPO" "$DIR"
fi
cd "$DIR"

# ------------------------------------------------------------------------ .env --
say "Preparing .env (secrets are generated here and never leave this server)"
bash scripts/make-env.sh "$WEB_HOST" "$API_HOST" >/dev/null
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
ask() {  # ask NAME "description" — hidden input, keeps an existing value
  local cur; cur="$(get "$1")"
  [ -n "$cur" ] && return 0
  local v=""
  if [ -r /dev/tty ]; then
    printf '  %s (%s) — paste and press Enter, or Enter to skip: ' "$1" "$2" > /dev/tty
    IFS= read -rs v < /dev/tty || true; echo > /dev/tty
  fi
  v="$(printf '%s' "$v" | tr -d '[:space:]')"
  [ -n "$v" ] && put "$1" "$v"
  return 0
}
ask GROQ_API_KEY "console.groq.com → API Keys; needed for the AI agents"
ask SARVAM_API_KEY "dashboard.sarvam.ai; Hindi/Hinglish dictation, optional"
ask GEMINI_API_KEY "aistudio.google.com → Get API key; optional"
ask OPENROUTER_API_KEY "openrouter.ai → Keys; optional"
ask CLOUDFLARE_TUNNEL_TOKEN "Cloudflare Zero Trust → Tunnels → the long eyJ… token"
chmod 600 .env
TUNNEL=""
TOKEN="$(get CLOUDFLARE_TUNNEL_TOKEN)"
if [[ "$TOKEN" == eyJ* ]]; then TUNNEL="--profile tunnel"
elif [ -n "$TOKEN" ]; then echo "  CLOUDFLARE_TUNNEL_TOKEN doesn't look like a tunnel token (should start with eyJ) — tunnel not started"
else echo "  no Cloudflare token yet — the site won't be reachable from outside until you add it and re-run"; fi

# ---------------------------------------------------------------------- start --
cd infra
say "Building images (first run takes 10–20 minutes)"
$DOCKER compose build sandbox-jobs
$DOCKER compose build api worker web sandbox
say "Starting Kritvia"
# shellcheck disable=SC2086
$DOCKER compose $TUNNEL up -d --remove-orphans
for i in $(seq 1 60); do curl -fsS http://127.0.0.1:8000/readyz >/dev/null 2>&1 && break; sleep 3; done
curl -fsS http://127.0.0.1:8000/readyz >/dev/null || { echo "API did not start — logs:"; $DOCKER compose logs --tail=80 api migrate; exit 1; }
echo "  API ready: $(curl -fsS http://127.0.0.1:8000/readyz)"

say "Downloading the local (private) AI models — about 6 GB, one time"
for m in qwen2.5:7b-instruct bge-m3; do
  if $DOCKER compose exec -T ollama ollama pull "$m" >/dev/null; then echo "  $m ready"
  else echo "  couldn't download $m — re-run this script later to retry"; fi
done

say "Sandbox isolation check"
$DOCKER compose exec -T sandbox python -c "import urllib.request;print(urllib.request.urlopen('http://127.0.0.1:8100/healthz').read().decode())" \
  || echo "  sandbox health check failed — see: sudo docker compose -f $DIR/infra/docker-compose.yml logs sandbox"

# nightly backups once the backup target is configured
if [ -n "$(cd .. && get BACKUP_AGE_RECIPIENT)" ] && [ -n "$(cd .. && get BACKUP_RCLONE_REMOTE)" ]; then
  ( crontab -l 2>/dev/null | grep -v kritvia/infra/scripts/backup.sh; \
    echo "15 2 * * * $DIR/infra/scripts/backup.sh >> \$HOME/kritvia-backup.log 2>&1" ) | crontab -
  echo "  nightly backup scheduled (02:15)"
fi

cat <<EOF

$(printf '\033[1;32m')Kritvia is running on this server.$(printf '\033[0m')

1. In Cloudflare (Zero Trust → Networks → Tunnels → your tunnel → Public hostnames) add:
     $WEB_HOST  →  http://web:3000
     $API_HOST  →  http://api:8000
2. Create your owner account (you'll choose the password yourself):
     cd $DIR/infra && sudo docker compose exec api python -m kritvia_api.cli bootstrap --email you@$DOMAIN --name "Your Name"
3. Open https://$WEB_HOST
4. BACK UP your encryption key now (password manager + paper):
     grep ^MASTER_KEK_B64= $DIR/.env

To update later: run this same command again.
EOF
