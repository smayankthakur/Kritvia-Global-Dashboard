# IndiaMART enquiries

Settings → Connectors → **IndiaMART**. Every IndiaMART enquiry (direct enquiry, buy-lead, call, catalog
view, WhatsApp) becomes a lead by itself: Lead triage scores it, files the lead and drafts the reply for a
yes, exactly like a website form. Included in Growth and above (integration `indiamart`).

## Connecting

1. In IndiaMART: Lead Manager → ⋮ → Import/Export Leads → **Pull API**, or
   seller.indiamart.com/leadmanager/crmapi → **Generate Key**.
2. Paste the key in Kritvia. Kritvia fetches the last 24 hours once to check it (IndiaMART allows one call
   every 5 minutes), stores the key encrypted with the business's key (`connector.secret`), and hands
   those enquiries to Lead triage straight after the connection is saved.

A key stops working if it isn't used for 7 days, or when a new one is generated. Kritvia polls every 10
minutes, so a connected key stays alive.

## Polling

The worker's `poll_indiamart` runs every 10 minutes (`services/indiamart.py`):

- **Window:** from 5 minutes before the last window's end (the first time: the last 24 hours) to now,
  never more than 7 days, in IST as `DD-Mon-YYYYHH:MM:SS`. IndiaMART recommends the overlap.
- **Once each:** IndiaMART's `UNIQUE_QUERY_ID` is the run's dedupe key, so an enquiry seen in two windows
  starts one run.
- **Limit:** at most 50 runs per business per poll; the window only moves on once every enquiry in it has
  been handed over.
- **Input to Lead triage:** name, email (if valid), company, subject (or "IndiaMART enquiry: <product>"),
  and the message with product, phone, city and the kind of enquiry added as lines. Source `indiamart`
  (scored like a website form). Field names other than those IndiaMART documents in text
  (`SENDER_COMPANY`, `SENDER_CITY`, `QUERY_PRODUCT_NAME`, `SUBJECT`) are read when present.

## When IndiaMART says no

| IndiaMART answers | Kritvia does |
|---|---|
| 204 no leads | nothing; the window moves on |
| 401 wrong or expired key | the connector shows the reason and stops polling until a key is pasted again |
| 429 too soon, 5xx, unreachable | tries again at the next poll; the window doesn't move |
| Lead triage switched off | the connector shows "IndiaMART enquiries need Lead triage switched on"; the window doesn't move |

The assistant's `indiamart.enquiries` tool lists the latest IndiaMART leads.

Source: help.indiamart.com/knowledge-base/lms-crm-integration-v2 (checked 18 Oct 2026).
