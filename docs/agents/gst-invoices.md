# GST invoices made in Kritvia

## Setting up

An admin fills in **Settings → Connectors → GST invoices** once:

- legal name (as registered), and trade name if any;
- GSTIN. It is checked: format, state code and the check character. The business's state comes from
  its first two digits;
- address, plus the email and phone to print;
- the number prefix, 1–5 letters or digits;
- text for the foot of the invoice, such as bank details or terms.

## Issuing

**Invoices → New GST invoice**:

- **Customer**: name, GSTIN (if registered), address, email and WhatsApp number.
- **Place of supply**: defaults to the customer's GSTIN state, otherwise the business's own state.
  - Same state: CGST + SGST, each at half the rate.
  - Another state: IGST at the full rate.
- **Lines**: description, HSN/SAC (4–8 digits), quantity (up to 3 decimals), unit, rate, discount, and
  GST rate. The rates offered are 0, 0.1, 0.25, 1, 1.5, 3, 5, 6, 12, 18, 28 and 40%; since GST 2.0 most
  goods and services are 5%, 18% or 40%.
- Each line's tax is rounded to the paisa, half up, and the totals are the sums. The dialog shows the
  same totals while typing (`gst-math.ts` mirrors `services/gst.py`, with tests on both sides).
- **Number**: `PREFIX/26-27/0001`, at most 16 characters. There is one gapless counter per business
  and financial year (April–March), taken in the same transaction as the invoice.
- The supplier's details are copied onto the invoice when it is issued, so later edits to the profile
  don't change invoices already issued.

## After issuing

- An issued tax invoice keeps its number, customer name, date and amount. The fix is to cancel it and
  issue a new one, or to issue a credit note, which Kritvia doesn't make yet. Contacts, due date,
  notes, payments and reminders work as for any invoice.
- The invoice opens as a page to **Print or save as PDF** (`/print/invoice/<business>/<invoice>`).
- The customer sees the same page from the payment link (`/pay/<token>/invoice`).
- The printed page carries:
  - "Tax Invoice";
  - both parties, with their GSTINs and states;
  - the place of supply and reverse charge;
  - a line table and an HSN/rate tax summary;
  - the total in words, in the Indian numbering system;
  - the foot text and an "Authorised signatory" line.

## Code and not built yet

Code:

- `services/gst.py`;
- `routers/gst.py`;
- migration `0043_gst_invoices.sql`;
- web: `components/invoices/{gst-invoice-dialog,invoice-document,gst-math}`, `components/settings/gst.tsx`.

Not built yet:

- credit and debit notes;
- e-invoicing (IRN/QR from the IRP, required above the turnover limit);
- e-way bills;
- cess;
- export invoices (LUT/IGST);
- GSTR-1 export.
