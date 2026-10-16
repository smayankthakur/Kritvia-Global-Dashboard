# Getting paid: UPI and Razorpay on every invoice

Every invoice has a payment page, `https://app…/pay/<token>`. The token is 32 random hex characters
and cannot be guessed. The team copies the link from the invoice, or sends it with **Send on WhatsApp**
(a wa.me link the person sends themselves). Payment reminder emails include it automatically once the
business has a way to be paid.

The page shows the business, the invoice number, the customer's name, what is still owed and the due
date. Nothing else.

## UPI (any business)

Settings → Connectors → **Getting paid**: an admin enters the business's UPI ID and the name customers
see. The page then shows:

- a QR code;
- an **Open my UPI app** button;

Both use a standard `upi://pay` link with the amount and invoice number filled in.

Kritvia can't see a payment made straight to a UPI ID. Instead:

1. The customer taps **I've paid** on the page, optionally with the UPI reference.
2. The team gets a notification, and the invoice shows "says paid".
3. A person confirms it on the invoice: **It arrived: paid in full**. This records a UPI payment with
   that reference.

Nothing is marked paid on the customer's word alone.

## Razorpay (the business's own account)

**Connect your Razorpay** takes the key id and key secret from Razorpay Dashboard → Account &
Settings → API keys.

- Kritvia checks the keys with Razorpay and stores the secret encrypted.
- It then shows a webhook address and a secret, **once**. The admin adds them in Razorpay → Webhooks
  with the event `payment_link.paid`.
- Money goes straight to the business. Kritvia never holds it.

When a customer taps **Pay online**:

- Kritvia creates a Razorpay payment link for exactly what is still owed. Razorpay's own SMS and email
  are off.
- It reuses the link until that amount changes.

When the payment goes through, Razorpay calls `/hooks/razorpay/<connector>`, signed with the secret.

- Kritvia records the payment once, keyed by Razorpay's payment id, so a repeated delivery is
  counted once.
- It marks the invoice paid when nothing is left, which stops reminders.
- It tells the team.

## Code

- `services/payments.py`: UPI link, Razorpay client, webhook verification.
- `routers/payments.py`: settings, connect, public page, webhook.
- `routers/invoices.py`: `pay_url`; payments are recorded with a method and reference.
- `workflows/collections.py`: the payment link in reminders.
- Migration `0041_invoice_payments.sql`.
- Web:
  - `app/pay/[token]`;
  - `components/settings/payments.tsx`;
  - the invoice dialog.
