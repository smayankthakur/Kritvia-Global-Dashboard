# Partner programme (CAs, agencies, consultants)

## The deal

| What | Who gets it |
|---|---|
| **10% off the first 3 months** | the business that signs up with the code |
| **20% of what the business pays** for 12 months from sign-up | the partner, paid to their UPI ID |

These terms are shown on the partner page (`TERMS` in `routers/partners.py`).

## Flow

1. **Apply.** Any signed-in person can open **Partner programme** in the account menu and apply:
   - name, firm, kind, city and phone;
   - a UPI ID for payouts;
   - optionally the code they'd like (otherwise one is made).
2. **Approve.** Kritvia's team (`STAFF_EMAILS`) uses **Kritvia team → Partners** to approve, pause or
   reject. A code works only while the partner is active.
3. **Refer.** The partner shares `https://app…/register?ref=CODE`.
   - The code is remembered in the browser and linked to the organisation when it is created at
     onboarding.
   - An owner can also enter it under **Plan & billing → Partner**.
   - Limits:
     - one partner per organisation;
     - only in the organisation's first 30 days;
     - only before it first pays;
     - never the partner's own organisation.
4. **Discount.** At checkout the subscription gets the Razorpay offer `RAZORPAY_PARTNER_OFFER_ID`. The
   owner creates it once in Razorpay → Subscriptions → Offers: 10% off for 3 billing cycles, linked to
   the plans. While the discount applies, the webhook accepts a payment down to 90% of the listed price.
5. **Commission.** Every `subscription.charged` webhook for a referred organisation, within 12 months
   of sign-up, records 20% of the amount paid, once per Razorpay payment id. Kritvia doesn't charge
   GST yet (Terms 10.3), so the commission is on the full amount.
6. **Payout.** The team pays the partner's UPI ID, then uses **Record payout** with the transfer
   reference. That marks everything due as paid.

## What a partner sees

- Their code and link.
- Their referred businesses: name, plan, sign-up date, and how long they earn from each. Never the
  businesses' data.
- Earned, paid and due amounts, and their payouts.

## Code and owner actions

Code:

- migration `0047_partners.sql`: tables with forced RLS, plus SECURITY DEFINER functions for code
  use, commissions and the staff actions;
- `routers/partners.py`;
- the `billing.py` offer, the minimum check and the commission;
- web:
  - `app/(app)/partners`;
  - `app/(app)/staff/partners`;
  - `components/partners/partner-code-card.tsx`;
  - `lib/referral.ts`.

Owner actions:

- create the Razorpay offer and set `RAZORPAY_PARTNER_OFFER_ID`;
- add a partner clause to the Terms (done in the legal update).
