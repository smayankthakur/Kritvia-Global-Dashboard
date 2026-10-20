# Always on (24×7), patch 0094

Kritvia keeps itself running with three watchers, each covering what the others can't.

| Watcher | Where it runs | How often | What it does |
|---|---|---|---|
| In-app watchdog (`services/watchdog.py`) | inside the worker | every minute | Puts runs that should be running back on the queue. Tells Kritvia's team (`STAFF_EMAILS`, else the founder) by email when something keeps failing, at most once an hour, and once on recovery. |
| Server watchdog (`infra/scripts/healthcheck.sh`) | cron on the server, as root | every minute (heavier checks every 5 minutes) | Starts stopped services and restarts hung ones (see below). Writes incidents to the status page. Alerts by AWS SNS email and/or Telegram. |
| Outside monitor (`infra/cloudflare/uptime-worker.js`) | Cloudflare, outside AWS | every minute | Checks `readyz` and `livez` from the internet. Alerts on Telegram (and optionally email) when the whole server, its network or AWS is down, and again when it is back. |

## What the in-app watchdog alerts on

- Runs waiting more than 10 minutes to start.
- Runs that lost their worker more than 5 minutes ago.
- 10 or more failed runs in 15 minutes.
- Half or more of the AI calls failing (when there were at least 5 in 15 minutes).
- The priority worker going quiet.

## What the server watchdog restarts

- A worker whose heartbeat is more than 3 minutes old. A worker that has just started gets 3 minutes first.
- The API or the web app after 3 failed minutes in a row.

## Runs retry by themselves

A run that fails for a passing reason goes back on the queue by itself, after 2 minutes, then 10, then 60.
After three retries it stays failed, as before, and the owner sees it on the board. Passing reasons are
(`engine/runner.passing`):

- a timeout or a dropped connection;
- every AI provider failing at once;
- Google, Meta or an AI provider answering 429 or 5xx;
- a database deadlock or restart.

Bad input, a policy refusal or a missing setting is never retried. Sends can't be repeated by a retry:
each approval runs once.

## `/livez`

Shows the workers' heartbeat ages and the run queue, in counts only (no business data). It answers 503 when
a worker has gone quiet for 3 minutes, runs have waited 10 minutes, or runs are stuck. The server watchdog
and the outside monitor read it at `https://app.sitelytc.com/api/k/livez`.

## Set-up (owner)

### 1. Telegram alerts from the server

1. Create a bot with @BotFather, send it a message, then get your chat id (for example from
   `https://api.telegram.org/bot<token>/getUpdates`).
2. Add `ALERT_TELEGRAM_BOT_TOKEN` and `ALERT_TELEGRAM_CHAT_ID` to `/opt/kritvia/.env`.
3. Run `sudo /opt/kritvia/infra/scripts/install-ops.sh`. It also moves the watchdog to every minute.

### 2. Outside monitor

1. In Cloudflare, go to Workers & Pages → Create → Worker, name it **kritvia-uptime**, and paste
   `infra/cloudflare/uptime-worker.js`.
2. In its settings:
   - Variables: `READY_URL=https://app.sitelytc.com/api/k/readyz` and `LIVE_URL=https://app.sitelytc.com/api/k/livez`.
   - Secrets: `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` (the same bot is fine).
   - KV namespace binding `STATE`: create a namespace called "kritvia-uptime".
   - Triggers → Cron: `* * * * *`.
3. Optional email alerts: add an Email Routing "send email" binding named `MAIL`, plus `ALERT_TO` set to a
   verified destination address.
4. Open the worker's URL: it shows a fresh check without sending anything.

KV is written only when the state changes, and the worker makes about 1,440 requests a day, both well
inside Cloudflare's free tier.

## Not covered

One server is still one server. If the EC2 instance itself fails, the monitors tell you within about two
minutes and the server's own restart policy brings it back after a reboot, but there is no standby. A
standby server with a database replica is the next step (about ₹5,000–7,000 a month).
