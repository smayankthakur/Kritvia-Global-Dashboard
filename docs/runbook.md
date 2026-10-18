# Kritvia runbook — Oracle ARM VM (dogfooding) and day-2 operations

## 0. Quick path — one command

Create the VM as in step 1 (Ampere A1, Ubuntu 24.04, SSH only), SSH in as `ubuntu`, then:
```bash
curl -fsSL https://raw.githubusercontent.com/smayankthakur/Kritvia-Global-Dashboard/main/scripts/server-setup.sh | bash -s -- <domain>
```
`scripts/server-setup.sh` does steps 1–3 below: Docker, gVisor, code in `/opt/kritvia`, `.env` with generated secrets, hidden prompts for the provider keys and the Cloudflare tunnel token, build, start, local models, health checks. Re-run it any time to update. Then do the Cloudflare hostnames and the `bootstrap` command it prints.

## 0a. Moving an existing install to a new server (AWS → Oracle Always Free)

To cut hosting to about $0 (Oracle Cloud Always Free: Ampere A1, 2 OCPU / 12 GB from 18 Aug 2026, 200 GB disk):

1. **You:** sign up at cloud.oracle.com with **home region Mumbai or Hyderabad** (free Ampere capacity is only in
   the home region, and Customer Data must stay in India). Upgrade the account to **Pay As You Go** (still $0
   inside the Always Free limits; free-only accounts can have idle VMs reclaimed). Create a VM: shape
   `VM.Standard.A1.Flex`, 2 OCPU, 12 GB, Ubuntu 24.04 (aarch64), 100 GB boot volume, your SSH key; ingress SSH
   only. If it says "out of capacity", retry later or in the other Indian region's availability domain.
2. **You:** `ssh -A ubuntu@<new ip>` (the `-A` lets it reach the old server with your key), then
   ```bash
   curl -fsSLO https://raw.githubusercontent.com/smayankthakur/Kritvia-Global-Dashboard/main/infra/scripts/move-server.sh
   bash move-server.sh ubuntu@3.110.224.90
   ```
   It copies `.env` (never printed), builds and pulls models while the old server serves, then asks you to type
   `MOVE`: it stops the old app, copies the database, starts here and stops the old stack. The Cloudflare tunnel
   token is the same, so no DNS change. Downtime is usually 5–15 minutes; the old server keeps its data, so going
   back is stopping here and starting there.
3. Add the new server's IP to the Google Places key's IP restriction.
4. After a week: snapshot and terminate the EC2 instance and release its IP. Keep S3 (backups) and SES (email).

## 0b. Moving the root disk to a smaller volume (150 GB → 50 GB)

The server used 31 GB of its 150 GB disk (18 Oct 2026; 6 GB of that is the swap file, about 4 GB
Docker build cache, which deploys now trim). A 50 GB gp3 volume saves roughly $9 a month and still
leaves room for builds; 40 GB works but is tight. AWS can't shrink a volume, so the files are copied
to a new one with `infra/scripts/shrink-root.sh`, which gives it the same layout and identifiers
(GPT disk and partition GUIDs, filesystem UUIDs and labels), so GRUB and fstab boot from it unchanged.
Rehearsed on disk images with the server's exact layout (p15 ESP, p16 /boot, p1 root).

Downtime: about 5 minutes for the last copy, plus a stop/start (~2 minutes).

1. **Fixed IP first** (EC2 → Elastic IPs → Allocate → Associate with `i-0177e8d81131819d7`). The
   address changes to the Elastic IP once now and then stays through every stop/start; it costs the
   same as the current public IP while attached. Put the new address on both Google Places keys'
   IP restriction (Google Cloud → Credentials).
2. **New volume**: EC2 → Volumes → Create volume: gp3, 50 GiB, 3000 IOPS, 125 MB/s, availability zone
   **ap-south-1b** (the instance's), tag Name=kritvia-root-50. Actions → Attach volume → instance
   `i-0177e8d81131819d7`, device `/dev/sdf`. On the server it appears as `/dev/nvme1n1` (check with
   `lsblk`: the empty 50G disk).
3. **Copy while running** (safe, repeatable; takes a few minutes):
   ```bash
   # after the patch with the script is pushed and deployed (deploy.sh pulls main):
   sudo bash /opt/kritvia/infra/scripts/shrink-root.sh copy /dev/nvme1n1
   ```
   It refuses the disk the server runs from, a disk with partitions it didn't make (FORCE=1 to wipe),
   and a disk without 8 GB to spare.
4. **Final copy** (downtime starts): `sudo bash /opt/kritvia/infra/scripts/shrink-root.sh final /dev/nvme1n1`.
   It stops Kritvia and Docker, copies the last changes, gives the new disk the old identifiers,
   checks the filesystems and prints "same" for every identifier. If anything says DIFFERENT, don't
   swap: `sudo systemctl start docker && cd /opt/kritvia/infra && sudo docker compose --profile tunnel up -d`.
   Then `sudo poweroff`.
5. **Swap the disks** (EC2 console, instance stopped): Storage tab → note the **Root device name**
   (e.g. `/dev/sda1`) and the old volume ID. Volumes → old volume → Create snapshot (name
   kritvia-root-150-before-shrink). Detach the old volume, detach the new one, attach the new one to
   the instance with the root device name. Start the instance.
6. **Check**: `sudo bash /opt/kritvia/infra/scripts/shrink-root.sh verify` (disk 50G, swap back on,
   readyz 200, containers up), then open app.sitelytc.com and run a sample enquiry.
7. **Going back** if it doesn't boot: stop, detach the new volume, attach the old one as the root
   device name, start. Nothing on the old volume was changed.
8. **After a week** of normal running: delete the old 150 GB volume, then the snapshot.

Never boot with both disks attached after `final`: they share identifiers.

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

Push to `main` → CI (API tests, web lint/types/tests/build, image builds, sandbox network probe) → `deploy` workflow SSHes to the VM and runs `infra/scripts/deploy.sh` (pull, rebuild, `up -d`, wait for `/readyz`).

By hand on the VM: `sudo /opt/kritvia/infra/scripts/deploy.sh --bg`, then `tail -f /var/log/kritvia-deploy.log` (it ends with `DEPLOY-DONE`). Deploys are quiet:

- Images build while the old containers keep serving, and only changed services restart.
- While `/var/lib/kritvia/deploying` exists, the health watchdog skips its checks, so a deploy doesn't open a status-page incident or send an alert email. A marker older than 30 minutes is ignored, so a stuck deploy is still reported.
- Build output goes to `/var/lib/kritvia/deploy-build.log`.
- The deploy ends with a one-line summary: commit, migration count, health. Secrets: `DEPLOY_SSH_KEY`, `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_KNOWN_HOSTS` in the `production` environment (add a required reviewer).

Migrations are forward-only and checksummed: never edit an applied file — add `0006_*.sql`.

## 7a. Growing beyond one server

The VM runs everything today. The first step out is a managed Postgres, which makes the app
servers stateless; after that a second VM runs the same compose file against the same database.

1. **Managed Postgres** (RDS in ap-south-1, Postgres 16, `db.t4g.small` or larger, private subnet,
   security group allowing 5432 from the VM only, automated backups and deletion protection on).
   Run `infra/postgres/managed-roles.sql` once as the master user: it creates the database, the
   `kritvia_owner` / `kritvia_app` roles and the `vector` and `pgcrypto` extensions.
2. Put `MANAGED_DATABASE_URL` and `MANAGED_MIGRATION_DATABASE_URL` in `/opt/kritvia/.env`
   (see `.env.example`). Keep Valkey local unless you also want ElastiCache (`MANAGED_REDIS_URL`).
3. `sudo infra/scripts/migrate-to-managed-db.sh` — stops api and worker, dumps, restores into the
   managed instance (ownership to `kritvia_owner`, grants preserved), checks row counts, starts
   the stack with `docker-compose.managed.yml`. Minutes of downtime; the old volume is untouched.
4. From then on every compose command carries `-f docker-compose.yml -f docker-compose.managed.yml`
   (`deploy.sh` adds it when `MANAGED_DATABASE_URL` is set). `WORKER_REPLICAS` scales workers;
   arq coordinates through Valkey so two workers never run the same job.
5. **Second VM**: same `server-setup.sh`, same `.env` (same `MASTER_KEK_B64` — the data keys are
   wrapped with it), same compose overlay; put both behind the Cloudflare tunnel (two `cloudflared`
   replicas on one tunnel) or a load balancer. Uploads live in Postgres, so nothing on local disk
   needs sharing. The `migrate` service is idempotent; only one VM needs to run it per deploy.
6. Backups: keep the nightly age-encrypted `pg_dump` (point `backup.sh` at the managed host) **and**
   the provider's snapshots; the monthly restore drill stays mandatory.

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

## Paid AI through OpenRouter

Free models stay first. Paid models are used when the free ones are busy or rate-limited, when a business is
past its fair share of the free pool (`AI_FREE_POOL_DAILY_TOKENS`), and for planning (tier `plan`).

1. openrouter.ai → Settings → Privacy: switch **off** "Enable training and logging" (only providers that do
   not train are used). Settings → Credits: add credit and set a monthly limit.
2. Use the account's key as `OPENROUTER_API_KEY` and set `OPENROUTER_PAID_ENABLED=1` in `.env`.
3. `docker compose up -d --force-recreate litellm api worker`.

Paid calls count against each plan's monthly AI allowance like any hosted call; the cost of each call is
recorded in `model_calls.cost_usd`.

## Email forwarding and the Drive picker (no restricted Google permissions)

Customers no longer give Kritvia Gmail read access or all-of-Drive access (Google's restricted scopes need a
paid yearly security assessment past 100 users). Instead their mail is forwarded to Kritvia and they pick
Drive files one by one. Organisations on plans in `GOOGLE_READ_PLANS` (default `internal`) keep full access.

**Inbound mail (once):**
1. Cloudflare → sitelytc.com → Email → Email Routing → enable it for the subdomain `in.sitelytc.com`
   (Cloudflare adds its MX and SPF records for the subdomain only; mail for sitelytc.com itself is untouched).
2. Workers & Pages → Create → Worker `kritvia-email-in`, paste `infra/cloudflare/email-worker.js`, deploy.
   Add variable `KRITVIA_INBOUND_URL=https://api.sitelytc.com/public/email-in` and secret
   `KRITVIA_INBOUND_SECRET` (generate with `openssl rand -hex 32`).
3. Email Routing → Routing rules → Catch-all for `in.sitelytc.com` → Send to Worker `kritvia-email-in`.
4. Server `.env`: `INBOUND_EMAIL_DOMAIN=in.sitelytc.com` and `INBOUND_EMAIL_SECRET=<the same secret>`;
   recreate api (`docker compose up -d --force-recreate api worker`).
5. Test: Settings → Connectors → Email forwarding → Set up forwarding, then send a mail to the address.
6. If the catch-all for `sitelytc.com` itself also goes to this Worker, add the variables
   `KRITVIA_DOMAIN=in.sitelytc.com` and `FORWARD_OTHER_TO=<a verified Email Routing destination>`. Then mail
   to any other `@sitelytc.com` address is forwarded there instead of bouncing. Paste the latest
   `email-worker.js` and deploy again after changing it.

**Drive picker (once):** in the Google Cloud project used for sign-in, enable **Google Picker API**, create a
browser API key restricted to HTTP referrer `https://app.sitelytc.com/*` and to the Picker API, then set
`GOOGLE_PICKER_API_KEY` and `GOOGLE_APP_ID` (the project **number**) in `.env`. Add the `drive.file` scope to
the OAuth consent screen (it is not a restricted scope).

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
