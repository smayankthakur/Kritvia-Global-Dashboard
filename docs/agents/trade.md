# Trade: exporters, importers and C&F agents

Patch 0067. A business of kind **trade** ("Exporter, importer or C&F agent" at sign-up, or Settings → Venture → kind) gets **Shipments** and **Trade profile** in its menu, plus leads, proposals and the rate card for buyer enquiries.

## Trade profile (`/v/<id>/trade-profile`)

What the business does (exporter, importer, C&F / customs broker), and what goes on its documents: legal name, address, IEC, GSTIN, AD code, bank details, LUT ARN and validity, customs broker licence, default currency, the months allowed to realise export proceeds (RBI rule, 9 by default; change it if the rule or your bank says otherwise), the declaration printed on invoices, and file number prefixes (EXP, IMP, JOB → `EXP/26-27/0001`, a new series each April). Admins change it.

## Shipment files (`/v/<id>/shipments`)

One file per consignment, of four kinds:

| Kind | Stages |
| --- | --- |
| Our export | order → production → booking → documents → shipping bill filed → shipped → arrived → payment realised → closed |
| Our import | order → shipped → arrived → bill of entry filed → duty paid → out of charge → delivered → supplier paid → closed |
| Client's export (C&F job) | documents → shipping bill filed → let export order → shipped → closed |
| Client's import (C&F job) | arrived → documents → bill of entry filed → duty paid → out of charge → delivered → closed |

Each file keeps the party (buyer, supplier or client), reference, Incoterm and place, mode, ports, carrier, vessel or flight, booking, containers, BL/AWB, shipping bill or bill of entry, cut-off, ETD/ETA, shipped and arrived dates; invoice lines with HS codes in the file's currency (the value is their total), freight and insurance; a packing list; payment terms, LC number, latest shipment date and expiry, money received or paid, realisation date and BRC; import duty; a C&F agent's fee and reimbursable costs; notes and a timeline.

- **Document checklist**: made from the kind of file, Incoterm (insurance for CIF/CIP exports, and for imports where the supplier doesn't insure) and payment terms (LC copy). Add extras (phytosanitary, fumigation, FSSAI NOC, COA, BIS, e-way bill…) or anything by name. Each has a status, number, date and an attached file (kept in business memory, not extracted).
- **Stages**: moving to *shipped* or *arrived* fills those dates; *shipped* on our export sets "realise proceeds by" = shipped date + the profile's months; *payment realised* fills the realisation date.
- **Export invoice and packing list**: `/print/shipment/<venture>/<file>?doc=invoice|packing`, printable or saved as PDF: exporter with IEC, GSTIN and AD code, buyer, consignee/notify, ports, vessel, origin India, destination, delivery and payment terms, lines with HS codes, freight, insurance, total in figures and words in the currency, packages and weights, the LUT line ("Supply meant for export under LUT … without payment of IGST", or with IGST), bank details, declaration and signatory.
- **Bill a C&F job**: makes an ordinary invoice (number = the job number) for fee + reimbursable costs, due in 15 days; payment reminders then follow it.
- **Needs attention** (the list page, the file, and the Shipment watch agent), from `services/trade.py alerts()`: cut-off within 48 h or passed (with documents still needed), ETD within 2 days or passed and not shipped, ETA within 2 days or passed and not arrived (imports and jobs), cargo at port 3+ days and not cleared (demurrage), LC latest shipment date within 7 days and expiry within 15 days, export proceeds due within 30 days or overdue, documents whose stage has passed, C&F jobs closed but not billed, and the LUT missing or expiring within 30 days.

## Agents

- **Shipment watch** (`trade_watch`, the trade kind's agent: Starter and up, every morning at 09:00 IST by default): the attention list, written by code from the files, to each owner and venture admin (Telegram if they linked it, otherwise email), a phone notification and Slack, and kept in the run. Quiet on days with nothing to say (option).
- **Shipment updates** (`trade_update`, all plans): "Send update" on a file drafts a status message from the file (stage, vessel, BL/AWB, containers, ETD/ETA, shipping bill or bill of entry, plus an optional line) to the party by email or WhatsApp; it waits for a yes, then is noted on the timeline. WhatsApp only within 24 hours of the party's last message.
- The assistant can look files up with `shipments.search` (file, party, reference, BL, container or customs number).

## Not done

No filing or data exchange with ICEGATE, DGFT, the GST portal or banks; no customs duty calculator; no finding buyers abroad (the Prospector searches Google Maps). Terms 7.12 says the business checks and files its documents itself.

Code: `migrations/0051_trade.sql`, `kritvia_api/services/trade.py`, `kritvia_api/routers/trade.py`, `kritvia_api/workflows/trade.py`; web `app/(app)/v/[ventureId]/shipments`, `trade-profile`, `components/trade/*`, `lib/trade.ts`, `app/print/shipment`. Tests: `apps/api/tests/test_trade.py`, `apps/web/tests/trade.test.ts`, `apps/web/e2e/trade.spec.ts`.
