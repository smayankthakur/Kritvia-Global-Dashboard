# Invoices and Payment reminders

The **Invoices** page keeps what customers owe the business; the **Payment reminders** agent
(`workflows/collections.py`, a core agent, Accounts on the board) chases it politely, with a person's
yes for every message. Code: `routers/invoices.py`, `workflows/collections.py`, the `invoices.search`
tool; web: `app/(app)/v/[ventureId]/invoices`, `components/invoices`. Migration `0037_invoices.sql`.

## Invoices

- **Add** one by typing it, **from a photo or PDF** (`POST /ventures/{v}/invoices/read`: the text is
  read on the server, OCR included, and a model copies the printed fields; nothing is saved until a
  person checks and adds it; an invoice carrying an ID or account number only goes to the private
  model), or **from Tally** (the customers Tally shows as owing money fill the name and amount).
- Amounts are whole paise; a 10-digit Indian mobile is read as +91. Invoice numbers are unique per
  business (case-insensitive).
- **Record a payment** (part or full). Paid in full: the invoice is paid and reminders stop.
- **Pause reminders** for one invoice (a promise to pay, a query), **cancel** it, or (admins) delete it.
- Approvers and viewers can see invoices; changing them needs a role that can write.

## Payment reminders

Every day at the set time (default 10:00 IST), for each open, unpaused invoice with money still owed:

1. `days_before` days before the due date (default 2; 0 = none), a friendly heads-up;
2. the day after the due date;
3. then every `repeat_days` days (default 7), up to `max_reminders` (default 4); the last one asks the
   customer to reply if there's a problem.

**By email** when the invoice has one (Gmail, approval `gmail.send`): the model writes the subject and
text from the invoice's facts; the amount, number and dates are formatted by code; the owner's *How
customers can pay* line is always included. An email that mentions any other amount always waits for a
person, whatever the agent's trust.
**By WhatsApp** when there's no email but a phone number of a customer who chats with the business
(they opted in) and a reminder template is chosen: the template's blanks are filled from the facts
(approval `whatsapp.template`). Otherwise the run ends with `no_way_to_reach` and tries again on the usual
rhythm.

A reminder turned down moves the next one on by the same rhythm. If the invoice is paid, paused or
changed while a reminder waits for approval, it is not sent (`not_needed`).

The assistant can answer "who owes us money?" with `invoices.search`.

## Not built yet

Automatic payment matching (bank feeds, UPI or Razorpay payment links), sending the invoice PDF with
the reminder, and creating invoices (Kritvia keeps and chases them; billing software issues them).
