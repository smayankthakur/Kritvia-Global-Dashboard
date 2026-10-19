# Money and marketing (Phase 3, migration 0062)

Everything here either needs a person's yes or only tells a person what to do. Kritvia never pays a bill,
files a return, or sends a campaign by itself.

## Money page (`/v/{id}/money`)

**Bank.** Upload a statement as CSV or Excel from any bank's netbanking (HDFC, ICICI, SBI, Axis, Kotak and the
rest: the header row is found by its words), or a PDF (read line by line; the running balance tells credit from
debit). Password-protected PDFs are refused with a hint to download the CSV. Lines already uploaded are skipped
(fingerprint of date, amount, narration, reference). Matching is code (`services/bank.py`), never a model:

- **sure**: the amount is exactly what is owed and the narration names the customer or supplier, the invoice
  or bill number, or the UPI reference the customer typed on the payment page;
- **likely**: the amount is exactly what is owed and only one invoice (or bill) owes that.

"Record all" confirms the sure ones: a credit records an invoice payment (method `bank`, linked to the line), a
debit marks the bill paid. Lines can be ignored (salary, transfers) and brought back.

**Bills.** Supplier bills typed, read from a photo or PDF (the fields come back for a person to check), or found
in a forwarded email ("invoice" or "bill" in the subject, with a PDF or photo; marked *from email: check it is
real*). The same supplier's bill number twice is refused as a double bill. The worker's `bills_due` job (09:15
IST) tells the owners about bills due within 3 days or overdue, once a day.

**GST returns.** GSTR-1 for a month from the tax invoices made in Kritvia: an Excel workbook with the GST offline
tool's sheets (b2b, b2cl, b2cs, hsn, docs) and GSTR-1 JSON. B2CL is inter-state B2C above ₹1 lakh. Lines
without an HSN/SAC are flagged. The worker's `gstr1_ready` job tells the owners on the 3rd. An accountant checks
and files; credit notes, exports and advances aren't made in Kritvia.

**Tally.** Tally has no cloud API, so `infra/tally/kritvia_tally_sync.py` (also offered for download on the page)
runs on the Tally PC every hour from Windows Task Scheduler. With the business's sync key it sends Tally's Day
Book to `POST /hooks/tally/{connector}/import`, fetches Kritvia's invoices that Tally doesn't have from
`GET /hooks/tally/{connector}/sales` (one Tally import request each: the customer's ledger under Sundry Debtors,
and a Sales voucher posted to the ledger names set on the page), and acknowledges the ones Tally created. The key
is shown once and kept only as a hash; a new key stops the old one.

## Marketing page (`/v/{id}/marketing`)

**Social posts.** The `social` agent (clock, 10:00 IST) runs on the days the owner picks (default Mon, Wed, Fri)
and writes one post from the business's description, the offers the owner wrote (it never invents offers or
prices) and what it posted lately. After a yes (the text can be edited) it goes to the Google Business Profile as
a "What's new" update and to the Facebook Page. Each channel's result is kept; one failing doesn't stop the other.

**Campaigns.** One WhatsApp template (to people who agreed to hear from the business; never anyone who wrote STOP)
or one email (to customers, with a one-click unsubscribe link; never anyone who unsubscribed). Audiences: everyone
opted in (WhatsApp), customers, customers of the last 90 days. The list is fixed when the campaign asks for its
one yes ("Send 'Diwali offer' to 214 people?"); that approval can't be edited, can't be auto-approved, and sends
to exactly that list in batches of 40. The outbox allows each recipient once. A campaign can be stopped while it
waits or sends.

## Google Business Profile

Connect Google with "Business Profile" (scope `business.manage`), then choose the listing. New reviews without a
reply get a drafted reply that is posted on Google after a yes (`google.review_reply`), or by pressing "Post on
Google" on the Reviews page. Google must approve the Cloud project for the Business Profile APIs once; until then
calls fail and replies stay drafts copied by hand.
