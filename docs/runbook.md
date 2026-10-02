# Kritvia runbook — Oracle ARM VM (dogfooding) and day-2 operations

## 0. Quick path — one command

Create the VM as in step 1 (Ampere A1, Ubuntu 24.04, SSH only), SSH in as `ubuntu`, then:
```bash
curl -fsSL https://raw.githubusercontent.com/smayankthakur/Kritvia-Global-Dashboard/main/scripts/server-setup.sh | bash -s -- <domain>
```
`scripts/server-setup.sh` does steps 1–3 below: Docker, gVisor, code in `/opt/kritvia`, `.env` with generated secrets, hidden prompts for the provider keys and the Cloudflare tunnel token, build, start, local models, health checks. Re-run it any time to update. Then do the Cloudflare hostnames and the `bootstrap` command it prints.

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
cd /opt/kritvia && bash scripts/make-env.sh app.<domain> api.<domain>
```
This creates `.env` (mode 600) and generates every internal secret on the VM itself: database and queue passwords, `JWT_SECRET`, `MASTER_KEK_B64`, sandbox/diarization tokens and the LiteLLM key. It also sets the public URLs, then lists the keys only you can get (Groq, Gemini, OpenRouter, Sarvam, Cloudflare tunnel, Google OAuth, Hugging Face, backup target). Re-running it only fills values that are still empty.
**Back up `MASTER_KEK_B64` offline (password manager + paper).** Without it every encrypted column and file is unrecoverable, backups included.

Cloudflare: create a tunnel, route `app.<domain>` → `http://web:3000` and `api.<domain>` → `http://api:8000`, put the token in `CLOUDFLARE_TUNNEL_TOKEN`. Set `PUBLIC_WEB_URL`, `PUBLIC_API_URL`, `ALLOWED_ORIGINS`, `CLIENT_IP_HEADER=cf-connecting-ip`.

## 3. First start

```bash
cd /opt/kritvia/infra
docker compose build sandbox-jobs
docker compose --profile tunnel up -d            # add --profile speech for local whisper + diarization
docker compose exec ollama ollama pull qwen2.5:7b-instruct
docker compose exec ollama ollama pull bge-m3
curl -s localhost:8000/readyz                     # {"status":"ok","migrations":7}
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
| All | Voice: `SARVAM_API_KEY` in `.env` for Hindi/Hinglish (restart api); shared vocabulary (client, product and staff names); decide whether hosted speech models may get spelling hints | `.env`; Voice → Vocabulary; Settings → General |

Google OAuth app: Google Cloud console → OAuth consent screen "External, Testing", scopes gmail.readonly, gmail.send, calendar.events, drive.readonly; redirect URI `https://app.<domain>/api/oauth/google/callback`.

## 5. Daily operation

* Kitchen: 23:30 plan → 06:30 check (alerts in the audit log + worker log if missing/failed) → manager approves POs in the Inbox.
* Inbox is the single place for decisions. Edits count against earned autonomy; clean approvals build it.
* Dashboard: failed runs have a Retry button (resumes from the failed step's checkpoint).

## 5a. Voice and the desktop companion

* Dictation works in the web app as soon as the speech tier works. Each person picks engine, language, hotkey and filters in **Voice → Settings**; their statistics are under **Voice → Insights**.
* Sarvam: create a key at sarvam.ai, put it in `SARVAM_API_KEY`, `docker compose up -d api worker`. Until then dictation silently uses Whisper. Review Sarvam's data terms before changing its `data_policy` in `infra/litellm/tiers.yaml` (that is what decides whether sensitive audio may go there).
* Desktop app: run the **desktop** workflow (Actions → desktop → Run workflow) or push a tag `desktop-v1.0.0` to publish installers on the Releases page. Users sign in with the **API** address (`https://api.<domain>`). Add `CSC_LINK`/`CSC_KEY_PASSWORD` secrets to sign Windows/macOS builds.

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

## Operations: backups, alerts, Stage 2 gate (AWS)

One-time AWS resources (already created for the production server): S3 bucket `kritvia-backups-<account>` (private, 30-day expiry), SNS topic `kritvia-alerts` (email subscription), IAM role + instance profile `kritvia-server` (S3 put/get/list on that bucket, SNS publish; no delete) attached to the instance. Then on the server:

```bash
cd /opt/kritvia && sudo bash infra/scripts/configure-aws-ops.sh
```
It installs the AWS CLI, writes `/etc/cron.d/kritvia` (health watchdog every 5 min, encrypted backup 02:15 IST), creates the backup key pair, takes a first backup, and sends a test alert. Save the printed private key offline and shred it from the server.

- Watchdog log: `sudo journalctl -t kritvia-health -n 50` · backup log: `/var/log/kritvia-backup.log`
- Stage 2 gate (each workflow 10 consecutive days on real data): `sudo infra/scripts/dogfood-report.sh`

## Sign-up: Google and email codes

New people sign up at `/register` with **Sign up with Google** or an emailed 6-digit code; there is no
password to set. Then a one-step setup asks for the business name and type (agency/services, loans &
real estate, restaurant/kitchen, something else), which decides the agents and workflows it gets.

- **Google sign-in** needs only `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and
  `GOOGLE_REDIRECT_URI=https://app.<domain>/api/oauth/google/callback` (the same client and redirect URI as
  the Gmail/Calendar connector). It asks Google for name and email only. While the Google app is in
  "Testing", only the test users listed in Google Cloud can sign in; publish the app (basic scopes need
  no review) before outside users sign up.
- **Email codes** need an SMTP sender: set `MAIL_TRANSPORT=smtp` and `SMTP_*`. With `MAIL_TRANSPORT=log`
  (the default) codes are not emailed but written to the API log — fine for the owner alone:
  `sudo docker compose logs api | grep "sign-in code"`.
- `SIGNUP_OPEN=false` closes sign-up: existing accounts still sign in, new addresses get no code.
- Safety: codes are stored only as HMAC hashes, last 10 minutes, are single use and die after 5 wrong
  tries. If someone registered an address with a password but never proved it, the real owner signing in
  with a code or Google removes that password and ends its sessions.
