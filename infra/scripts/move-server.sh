#!/usr/bin/env bash
# Move Kritvia to a new server (e.g. from AWS EC2 to an Oracle Cloud Always Free Ampere VM), keeping
# every secret and all data. Run it ON THE NEW SERVER as `ubuntu`, logged in with your SSH agent
# forwarded so it can reach the old server with your key:
#
#   ssh -A ubuntu@<new server ip>
#   curl -fsSLO https://raw.githubusercontent.com/smayankthakur/Kritvia-Global-Dashboard/main/infra/scripts/move-server.sh
#   bash move-server.sh ubuntu@3.110.224.90
#
# What it does:
#   1. installs Docker and the code in /opt/kritvia, adds swap on machines under 16 GB;
#   2. copies .env from the old server (same secrets: MASTER_KEK_B64, tunnel token, keys);
#   3. builds the images and pulls the local models while the old server keeps serving;
#   4. DOWNTIME STARTS: stops the old app, copies the database (pg_dump | pg_restore), stops the
#      old server's tunnel, and starts everything here. The Cloudflare tunnel token is the same, so
#      app.sitelytc.com and api.sitelytc.com follow without any DNS change. Usually 5–15 minutes.
#   5. checks health and prints what is left (Google key IP, old server shutdown).
# The old server's data is left untouched, so going back is: stop here, start there.
set -euo pipefail
OLD="${1:-}"
[ -n "$OLD" ] || { echo "usage: bash move-server.sh ubuntu@<old server ip>"; exit 1; }
[ "$(id -u)" -ne 0 ] || { echo "run as ubuntu, not root"; exit 1; }
REPO="${KRITVIA_REPO:-https://github.com/smayankthakur/Kritvia-Global-Dashboard.git}"
DIR=/opt/kritvia
OLD_DIR=/opt/kritvia
say() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
oldrun() { ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new "$OLD" "$@"; }

say "Checking the old server ($OLD)"
oldrun "test -f $OLD_DIR/.env && echo ok" | grep -q ok || { echo "can't read $OLD_DIR/.env on $OLD (log in with ssh -A?)"; exit 1; }

say "Installing Docker, git and tools"
sudo apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ca-certificates curl git openssl python3 age rclone \
  unattended-upgrades docker.io >/dev/null
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker-compose-v2 >/dev/null 2>&1 \
  || sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker-compose-plugin >/dev/null
sudo systemctl enable --now docker >/dev/null
sudo usermod -aG docker "$USER"
echo 'Unattended-Upgrade::Automatic-Reboot "false";' | sudo tee /etc/apt/apt.conf.d/52kritvia >/dev/null
if [ "$(awk '/MemTotal/ {print int($2/1048576)}' /proc/meminfo)" -lt 16 ] && ! swapon --show | grep -q .; then
  say "Adding a 6 GB swap file"
  sudo fallocate -l 6G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile >/dev/null && sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

say "Getting the code"
if [ ! -d "$DIR/.git" ]; then
  sudo mkdir -p "$DIR" && sudo chown "$USER" "$DIR"
  git clone -q "$REPO" "$DIR"
fi
git -C "$DIR" fetch -q origin main && git -C "$DIR" reset -q --hard origin/main

say "Copying .env from the old server (never printed)"
umask 077
oldrun "sudo cat $OLD_DIR/.env" > "$DIR/.env.new"
grep -q '^MASTER_KEK_B64=.' "$DIR/.env.new" || { rm -f "$DIR/.env.new"; echo "the old .env has no MASTER_KEK_B64"; exit 1; }
mv "$DIR/.env.new" "$DIR/.env" && chmod 600 "$DIR/.env"
umask 022

cd "$DIR/infra"
. scripts/load-env.sh; load_env ../.env
DC=(sudo docker compose -f docker-compose.yml)

say "Building images and pulling local models (the old server is still serving)"
"${DC[@]}" build --quiet migrate sandbox-jobs api worker worker-priority web sandbox
"${DC[@]}" pull --quiet postgres valkey ollama litellm cloudflared 2>/dev/null || true
"${DC[@]}" up -d ollama
sleep 5
"${DC[@]}" exec -T ollama ollama pull qwen2.5:7b-instruct >/dev/null
"${DC[@]}" exec -T ollama ollama pull bge-m3 >/dev/null

read -r -p $'\nReady to switch. The app will be down for a few minutes. Type MOVE to continue: ' answer
[ "$answer" = "MOVE" ] || { echo "stopped; nothing changed on the old server"; exit 1; }

say "Stopping the old app (its database stays up for the copy)"
oldrun "cd $OLD_DIR/infra && sudo docker compose --profile tunnel stop cloudflared web api worker worker-priority litellm >/dev/null 2>&1; true"

say "Copying the database"
"${DC[@]}" up -d postgres
for _ in $(seq 1 60); do "${DC[@]}" exec -T postgres pg_isready -U postgres -d kritvia >/dev/null 2>&1 && break; sleep 2; done
oldrun "cd $OLD_DIR/infra && sudo docker compose exec -T postgres pg_dump -U postgres -Fc kritvia" > /tmp/kritvia.dump
ls -lh /tmp/kritvia.dump
# The fresh database has only the roles and the vector extension (postgres/00-roles.sh); the dump
# creates the extension itself, so drop it first. The tables must not exist yet.
if [ "$("${DC[@]}" exec -T postgres psql -U postgres -d kritvia -tAc "SELECT count(*) FROM pg_tables WHERE schemaname IN ('public','private')")" != "0" ]; then
  echo "the new database already has tables; refusing to overwrite them"; exit 1
fi
"${DC[@]}" exec -T postgres psql -U postgres -d kritvia -qc "DROP EXTENSION IF EXISTS vector;" >/dev/null
"${DC[@]}" exec -T postgres pg_restore -U postgres -d kritvia --exit-on-error < /tmp/kritvia.dump
rm -f /tmp/kritvia.dump

say "Starting everything here"
sudo bash "$DIR/infra/scripts/deploy.sh"

say "Stopping the old server's stack (its data is kept, so you can go back)"
oldrun "cd $OLD_DIR/infra && sudo docker compose --profile tunnel stop >/dev/null 2>&1; true"

NEW_IP=$(curl -fsS -m 5 https://checkip.amazonaws.com 2>/dev/null || echo "?")
cat <<EOF

Moved. Left to do:
  1. Google Cloud -> Credentials -> "Places server key": add this server's IP ($NEW_IP) to the IP restriction
     (and remove the old one later), or the Prospector's Google lookups will be refused.
  2. Open https://app.sitelytc.com and check you can sign in and that Runs and Approvals look right.
  3. After a week of normal running: in AWS, snapshot then terminate the old EC2 instance and release its
     public IP, so it stops costing money. Keep S3 (backups) and SES (email): they cost cents.
EOF
