# Security events

Every security-relevant event is written twice: a JSON line on the `kritvia.security` logger
(API, worker and web containers) and, for the API and worker, a row in the `security_events`
table. The table is append-only for the app (it can insert through `security_event()` but can't
read, change or delete), keeps no email addresses (a keyed hash in `subject` lets repeated events
for one address be grouped) and no business content, and is purged after one year.

## Event catalogue

| Event | Severity | When |
| --- | --- | --- |
| `auth.login_failed` | info → warning from the 5th in a row | Wrong password |
| `auth.code_failed`, `auth.reset_code_failed` | info → warning | Wrong sign-in or reset code |
| `auth.current_password_failed` | info → warning | Wrong current password when changing it |
| `auth.locked` | warning | An address reached 5 failures; attempts paused |
| `auth.refresh_rejected` | warning | Expired, invalid or **reused** refresh token (reuse revokes the whole session family) |
| `auth.password_changed`, `auth.password_reset` | info | Password changed or reset (all other sessions signed out) |
| `webhook.bad_signature`, `webhook.stale` | warning | Razorpay, WhatsApp or lead-form webhook with a bad signature or old timestamp |
| `billing.amount_mismatch` | **critical** | A paid amount is below the plan's price; the plan is not granted |
| `billing.unknown_plan` | warning | A Razorpay plan id we didn't configure |
| `billing.plan_changed` | info | A verified payment changed an organisation's plan |
| `ai.injection_suspected` | warning | Text sent to the AI tried to give it instructions (patterns listed in `details`) |
| `ai.autonomy_withheld` | warning | A draft that would have gone out on earned autonomy was held for a person |
| `upload.refused` | info | A file failed the type allowlist or magic-number check |
| `privacy.request_received` | info | A privacy request was filed (reference in `details`) |
| `csrf.refused`, `origin.refused` | warning | Web app refused a cross-site or token-less change (web logs only) |

## Alerts

The health watchdog (`infra/scripts/healthcheck.sh`, every 5 minutes) emails through SNS when, in
the last 5 minutes, there is **any critical event** or **30 or more warnings**
(`SECURITY_WARN_THRESHOLD` in `.env`). Security alerts never appear on the public status page.

## Looking at events

```bash
cd /opt/kritvia && sudo docker compose -f infra/docker-compose.yml exec -T postgres psql -U postgres -d kritvia -c \
"SELECT at, kind, severity, ip, org_id, details FROM security_events WHERE at > now() - interval '24 hours'
  ORDER BY at DESC LIMIT 50;"

# the noisiest sources today
... -c "SELECT kind, ip, count(*) FROM security_events WHERE at > now() - interval '1 day'
        GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 20;"

# web app refusals
cd /opt/kritvia/infra && sudo docker compose logs --since 24h web | grep kritvia.security
```

## Responding

- **Many `auth.*` warnings from one IP:** a password-guessing attempt; the per-address lock and
  rate limits are already holding it. If it continues, block the IP in Cloudflare (Security → WAF →
  Tools → IP Access Rules).
- **`billing.amount_mismatch`:** compare the payment in the Razorpay dashboard with the plan's
  price; check the Razorpay plan's amount wasn't changed. Refund or set the plan by hand.
- **`webhook.bad_signature` bursts:** someone is probing the webhook URL, or a secret was rotated on
  one side only. Check `RAZORPAY_WEBHOOK_SECRET` / the WhatsApp app secret match.
- **`ai.injection_suspected`:** look at the run (Runs page, flagged); the draft waited for a person.
  If an agent keeps seeing these from one sender, block the sender in Gmail.
