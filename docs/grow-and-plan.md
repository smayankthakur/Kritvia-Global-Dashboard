# Grow and plan ahead (roadmap phase 5, patch 0091)

Phase 5 takes the weakest parts of the automation scorecard (Money and Marketing) a step further, and fixes
one email being answered twice when a business both connects Gmail and forwards mail. Migration 0064.

## Cash ahead (Money → Cash ahead)

`services/cash.py`, `routers/cash.py`, worker cron `cash_week` (Mondays 09:05 IST).

- **Coming in.** Each open invoice's balance is expected on its due date plus how late that customer usually
  pays (the median of their last year's payments). A new customer gets the business's usual lateness. Overdue
  invoices are expected within the week. Invoices more than 90 days overdue are counted as doubtful: they
  are listed but left out of the totals.
- **Going out.** Open supplier bills fall on their due dates (overdue ones this week). Staff salaries from
  People → Attendance and the other fixed monthly costs the owner types both fall on the 1st of each month.
- **Starting balance.** Whichever is newer: the last statement's closing balance, or the one the owner typed.
  Without either, the view shows net flows only.
- **The view.** Thirteen weeks are shown as a chart with a table view, plus the next 30, 60 and 90 days. A
  "Warn me below" level marks tight weeks.
- **The Monday note.** It goes to owners and admins (push, else Telegram, else email), at most once a day.
- All of it is arithmetic in code; no model is involved. The note says it is a forecast, not a promise.

## Bank statements by email (Money → Bank)

`services/bank.py` (`statement_attachment`, `pdf_text`), `services/pollers.py` (`statement_mail`,
`poll_statements`), `routers/bank.py` (`import_statement`).

- **Which emails count.** Only mail from Indian banks' own domains (`bank.BANK_DOMAINS`, subdomains
  included) with "statement" in the subject and a PDF, CSV or Excel attachment. Credit-card statements are
  skipped.
- **How they arrive.** Kritvia reads them from the connected Gmail (the last 3 days, each email once), or
  from mail forwarded to the business's Kritvia address. They are matched like an upload, and the owners
  are told how many lines and matches came in.
- **Password-protected PDFs.** Most e-statements need a password. An admin saves it once on Money → Bank. It
  is encrypted with the business's key, never shown again, and used only in memory to open statements.
- **Trust.** A forwarded statement can't be checked for who really sent it, so it is stored with
  `verified = false`. Its matches are never "sure": they don't go into the one-tap "Record all", and each
  line shows "check with your bank". A statement read from Gmail is verified when Gmail's own sender check
  passes.
- Owners can switch this off on Money → Bank (`cash_settings.statements_by_email`).

## One answer per email

Before this patch, a business that both connected Gmail with read access and forwarded the same mailbox got
two replies to every email. Now `deliver_forwarded` checks `gmail_reads()`: if Gmail is connected for the
mailbox the email was forwarded from (`X-Forwarded-For`) or sent to (`To`), the forwarded copy only feeds the
attachment readers (CVs, supplier bills and statements, which the Gmail poller doesn't read). Everything
else is left to the poller. If the Gmail connection has an error, forwarding carries the mail again.

Settings → Connectors → Email forwarding now says "Forwarding works", with when the last email arrived and
from which mailbox. Once Gmail itself forwards, the old confirmation link is cleared.

## Campaign ideas (agent `campaign_ideas`)

`workflows/campaign_ideas.py`, `services/occasions.py`.

- **When it looks.** Once a week, on the chosen day (default Monday) at 10:30 IST.
- **What it looks for.**
  - An occasion 7–21 days away. Major festivals by default; smaller ones by name ("Extra occasions"); any
    can be skipped.
  - A slow fortnight: fewer than 60% of the usual new leads and bookings, measured against the 12 weeks
    before, once the business has that much history.
- **What it does.** It writes an email campaign from the brief and only the offers the owner typed, saves
  it as `suggested` with its `occasion`, and starts the Campaigns agent. That agent fixes the list and asks
  for the one `campaign.send` yes.
- **Limits.** At most one campaign per occasion (unique index), none if a campaign was made that week, and
  never to anyone who unsubscribed.
- **Occasion dates.** 2026–2027 dates are from calendarific.com's India lists (Eid dates are provisional).
  Add 2028 before December 2027; `test_occasions_are_found_two_to_three_weeks_ahead` checks the list runs
  far enough ahead.

## Google listing check (agent `google_listing`)

`workflows/google_listing.py`, `services/gbp.py`, tool `google.listing_update` (WRITE).

- **When it runs.** Weekly, default Tuesday at 09:30 IST.
- **What it compares.** The Business Profile's opening hours against Kritvia's: the booking hours if set,
  else the phone assistant's office hours.
- **When they differ.** It offers to put Kritvia's hours on Google. The yes can't be edited, and a no is
  remembered for those exact hours.
- **Website and phone.** If the listing has neither, the Reviews page says so.
- It needs Google connected with Business Profile access, and Google's approval of the Business Profile
  API. Until then the check ends with `google_refused`.

## Ads (Marketing → Ads)

`services/ads.py`, `routers/ads.py`, `workflows/lead_triage.ad_tags`, assistant tool `ads.summary`.

- **Spend.** Upload the campaign report exported from Meta Ads Manager or Google Ads (CSV or Excel). The
  platform and dates are read from the file; a later upload of the same campaign and days replaces the
  earlier one.
- **Where leads came from.** Website-form leads carry `ad_source` (meta or google) and `ad_campaign`. These
  come from UTM tags (paid media only), `gclid` or `fbclid` in the form webhook payload.
- **The numbers.** Spend is set against leads and won customers per platform and per campaign, with cost
  per lead and per sale. Campaign names match case- and punctuation-insensitively, so `diwali_sale` matches
  "Diwali Sale".
- **"What should I change?"** A model words 3–5 suggestions from those numbers only. Kritvia never spends
  and never touches an ad account.

## Scorecard

Autonomy goes from 75 to 79 out of 100, with every job now in Kritvia.

| Area | Before | After |
|---|---|---|
| Marketing | 44 | 72 (its target) |
| Money | 67 | 72 |

| Job | Level now |
|---|---|
| Cash forecast | 3 |
| Bank reconciliation | 3 |
| Campaigns | 3 |
| Content writing | 3 |
| Local SEO | 3 |
| Ads | 2 |

## Owner set-up

- **Turn on the new agents.** Campaign ideas and Google listing check are on the Agents page (off by
  default). Add offers to Campaign ideas so it can mention them.
- **Money → Cash ahead.** Type the bank balance (or upload a statement), other fixed monthly costs, and a
  warning level.
- **Money → Bank.** Save the bank's statement PDF password. Then either keep Gmail connected, or forward the
  bank's statement emails to the business's Kritvia address.
- **Ads.** Tag ad links with `utm_source`, `utm_medium=cpc` (or `paid_social`) and `utm_campaign`, and pass
  them, plus `gclid`/`fbclid`, in the website form webhook.
