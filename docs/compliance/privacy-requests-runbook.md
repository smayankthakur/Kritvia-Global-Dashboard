# Handling privacy requests

Who: the Grievance Officer (Mayank Thakur). Where requests arrive: the `privacy_requests` table, and an
email to `SUPPORT_INBOX` for each one (subject `[Kritvia privacy PR-XXXXXXXX]`). Emails to
support@sitelytc.com with "Privacy" or "Grievance" in the subject are handled the same way: log them
with the SQL below so every request has a reference and deadlines.

Deadlines (Privacy Policy section 6): acknowledge within **2 business days**; respond in full within
**30 days** (GDPR: one month, extendable by two with reasons; DPDP Rules: within 90 days at most).
Requests are free.

## Daily or weekly check

```bash
cd /opt/kritvia && sudo docker compose -f infra/docker-compose.yml exec -T postgres psql -U postgres -d kritvia -c \
"SELECT reference, kind, relationship, email, status, acknowledge_by::date, respond_by::date
   FROM privacy_requests WHERE status NOT IN ('done','refused') ORDER BY respond_by;"
```

Update a request as you go (status: received → verifying → in_progress / forwarded → done or refused):

```sql
UPDATE privacy_requests SET status = 'done', handled_at = now(),
       outcome = 'Erased account data; invoices kept 8 years for tax law'
 WHERE reference = 'PR-XXXXXXXX';
```

Log an emailed request:

```sql
SELECT * FROM privacy_request_submit('erase', 'account_holder', 'Name', 'person@example.com', '', 'What they asked', NULL);
```

## Steps

1. **Acknowledge** (by `acknowledge_by`): reply from support@sitelytc.com to the address given, quoting the
   reference. This reply is also the identity check: act only when the person answers from that address,
   and for account holders only if it matches the account email. Never ask for ID documents by email;
   if the email can't be confirmed, ask for something only the real person would know (e.g. the business
   name and roughly when they signed up).
2. **Decide who acts.**
   - Account holder: we are the Data Fiduciary — act ourselves.
   - Customer of a business on Kritvia: the business is the fiduciary. Forward to the organisation owner
     within 2 business days (status `forwarded`), tell the requester we have, and help the business
     respond. Do not edit the business's data ourselves unless it asks us to.
   - Nominee: ask for the nomination or proof of authority before acting.
3. **Act.**
   - Access: run `GET /auth/me/export` data for the user (or a psql query of the same tables) and send the
     JSON, plus the list of processors in Privacy Policy section 4.
   - Correct: change the field, or ask the person to change it in Your account.
   - Erase: the person can use Your account → Delete my account (an emailed sign-in code gets them back in
     if they lost access). If they cannot, an engineer runs the same deletion as `public.delete_my_account`
     does, as the database owner, only after identity is confirmed. Keep invoices (8 years), security logs (1 year) and the audit
     log, and say so in the reply.
   - Withdraw consent: switch off the feature (push, dictation auto-learn, product emails) or, for consent
     needed to run the account, explain that withdrawal means closing it.
   - Grievance: investigate, answer with what happened and what changed. Tell them they may complain to
     the Data Protection Board of India if not satisfied.
4. **Close**: set `status`, `handled_at` and a short `outcome`. Closed requests are deleted automatically
   three years after `handled_at`.

## Reply templates

**Acknowledgement**

> Subject: Your privacy request PR-XXXXXXXX
>
> Hello {name}, we've received your request to {action} (reference PR-XXXXXXXX). To make sure it's you,
> please reply to this email from the same address. We'll complete your request by {respond_by}.
> — Mayank Thakur, Grievance Officer, Sitelytc Digital Media Private Limited

**Completed**

> Your request PR-XXXXXXXX is complete: {what we did}. We have kept {what, why, how long} because the
> law requires it. If you're not satisfied, reply to this email, or you can complain to the Data
> Protection Board of India.

**Forwarded to a business**

> {Business} uses Kritvia to run its operations and decides how your data is used, so we have passed
> your request to them today and will help them respond. Reference PR-XXXXXXXX.
