# Kritvia runbook — Oracle ARM VM (dogfooding) and day-2 operations

## 1. Provision the VM (once)

1. Oracle Cloud Always Free: Ampere A1, 4 OCPU / 24 GB, Ubuntu 24.04 (arm64), 150+ GB boot volume.
   Ingress: **SSH only** (22 from your IP). Nothing else is opened — traffic arrives through Cloudflare Tunnel.
2. Base setup:
   ```bash
   sudo apt-get update && sudo apt-get install -y docker.io docker-compose-v2 git age rclone unattended-upgrades
   sudo usermod -aG docker $USER && newgrp docker
   sudo dpkg-reconfigure -plow unattended-upgrades
   ```
3. gVisor (sandbox layer 1) — see `services/sandbox/README.md`, then `docker info | grep -i runsc`.
4. Code: `sudo mkdir -p /opt/kritvia && sudo chown $USER /opt/kritvia && git clone <repo> /opt/kritvia`.

## 2. Configure

```bash
cd /opt/kritvia && cp .env.example .env && chmod 600 .env
# fill every blank; generate with: openssl rand -base64 32
docker run --rm python:3.12-slim python -c "import os,base64;print(base64.b64encode(os.urandom(32)).decode())"  # MASTER_KEK_B64
```
**Back up `MASTER_KEK_B64` offline (password manager + paper).** Without it every encrypted column and file is unrecoverable, backups included.

Cloudflare: create a tunnel, route `app.<domain>` → `http://web:3000` and `api.<domain>` → `http://api:8000`, put the token in `CLOUDFLARE_TUNNEL_TOKEN`. Set `PUBLIC_WEB_URL`, `PUBLIC_API_URL`, `ALLOWED_ORIGINS`, `CLIENT_IP_HEADER=cf-connecting-ip`.

## 3. First start

```bash
cd /opt/kritvia/infra
docker compose build sandbox-jobs
docker compose --profile tunnel up -d            # add --profile speech for local whisper + diarization
docker compose exec ollama ollama pull qwen2.5:7b-instruct
docker compose exec ollama ollama pull bge-m3
curl -s localhost:8000/readyz                     # {"status":"ok","migrations":5}
docker compose exec sandbox python -c "import urllib.request;print(urllib.request.urlopen('http://127.0.0.1:8100/healthz').read())"  # network_isolated: true
docker compose exec api python -m kritvia_api.cli bootstrap --email you@sitelytc.com --name "Mayank Thakur"
```
`bootstrap` creates the organisation, the three ventures (software / finance / kitchen), gives you approver, loan_officer and kitchen_manager, and enables the workflows (kitchen at 23:30 IST). Then open `https://app.<domain>`.

Smoke-test each tier once through LiteLLM (a failing free provider just falls back — check `Settings → Model usage`).

## 4. Before the first real run (open decisions)

| Venture | What to enter | Where |
|---|---|---|
| Sitelytc | Rate card (codes, units, INR rates); past proposals as notes (kind "proposal") so drafts can cite them | Rate card; Knowledge |
| Truhome | Checklist per loan type (start from the template), **confirmed with the compliance advisor**; who holds `loan_officer` | Checklists; Settings → Members |
| Kitchen | Dishes, ingredients, recipes (BOM), vendors + vendor items (pack sizes, prices), a stock count, 4–8 weeks of sales CSV | Reference data; Sales & stock |
| All | Connect Google (testing mode OAuth app; add yourself as a test user), webhook for the website form, retention per data class | Settings |

Google OAuth app: Google Cloud console → OAuth consent screen "External, Testing", scopes gmail.readonly, gmail.send, calendar.events, drive.readonly; redirect URI `https://app.<domain>/api/oauth/google/callback`.

## 5. Daily operation

* Kitchen: 23:30 plan → 06:30 check (alerts in the audit log + worker log if missing/failed) → manager approves POs in the Inbox.
* Inbox is the single place for decisions. Edits count against earned autonomy; clean approvals build it.
* Dashboard: failed runs have a Retry button (resumes from the failed step's checkpoint).

## 6. Backups and restore drill

Host cron:
```
15 2 * * *  /opt/kritvia/infra/scripts/backup.sh >> /var/log/kritvia-backup.log 2>&1
```
Monthly drill (from a machine holding the age private key, or temporarily on the VM):
```bash
AGE_IDENTITY=~/kritvia-backup.key /opt/kritvia/infra/scripts/restore-drill.sh
```
It restores into a scratch database, checks migrations and that every organisation's audit chain verifies, then drops it.

## 7. Deploys

Push to `main` → CI (API tests, web lint/types/tests/build, image builds, sandbox network probe) → `deploy` workflow SSHes to the VM and runs `infra/scripts/deploy.sh` (pull, rebuild, `up -d`, wait for `/readyz`). Secrets: `DEPLOY_SSH_KEY`, `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_KNOWN_HOSTS` in the `production` environment (add a required reviewer).

Migrations are forward-only and checksummed: never edit an applied file — add `0006_*.sql`.

## 8. Incidents

| Symptom | Check | Fix |
|---|---|---|
| Runs stuck `queued` | `docker compose logs worker`, Valkey up? | restart worker; sweeper re-dispatches within a minute |
| Many `rate_limited` model calls | Settings → Model usage | reorder `infra/litellm/tiers.yaml` chains (no deploy of code needed: restart api/worker) |
| `PolicyViolation` in a run | a sensitive request met a tier with no local deployment | add a local/BYOK deployment to that tier |
| Audit verify shows broken chain | `python -m kritvia_api.cli verify-audit --org <id>` with the owner DSN | treat as a security incident: record in the breach register, restore comparison from backup |
| Suspected data breach | — | Compliance → Breach register (detected_at, severity, containment), notify board/principals per DPDP |
| Lost KEK | — | unrecoverable by design; restore `.env` from your offline copy |
