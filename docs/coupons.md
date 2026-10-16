# Coupons

A coupon gives an organisation a paid plan free for a few months, for the first N organisations
that use it.

The launch coupon is **FIRST50**: the Scale plan free for 3 months, for the first 50
organisations. Migration 0049 creates it.

## How people use it

- **A sign-up link:** `https://app.sitelytc.com/register?coupon=FIRST50`. The register page shows
  the offer and how many places are left. The code is kept in the browser (`kv-coupon`) and applied
  when the organisation is created at onboarding.
- **Plan & billing → Coupon:** the owner types the code. Only owners can apply a coupon.

## Rules (`private.use_coupon`)

- A coupon can be used once per organisation and once per person.
- It can't be used by an organisation that already has a paid plan.
- It can be used only while places last; places are counted under a row lock, so there are never
  more than 50.
- While it runs, an organisation without a paid plan works on the coupon's plan, with that plan's
  limits. `private.applied_plan` decides this; every plan check reads it.
- A paid plan always wins over a coupon.
- When the free months end, the organisation is back on the Free plan. It has 7 days to choose a
  plan (the trial end becomes `ends_at` + 7 days), then becomes read-only, as at the end of a trial.
- Nothing is ever charged because of a coupon. The Terms (clause 10.10) set out the conditions, and
  people accept them when they apply a coupon.

## Kritvia's team

**Kritvia team → Coupons** (`/staff/coupons`, for `STAFF_EMAILS`) shows, for each code:

- how many places are used;
- who used it and when their free months end;
- whether they now pay.

It can switch a code off and copy the sign-up link.

To add another code, insert a row into `coupons`, for example:

```sql
INSERT INTO coupons (code, plan, months, max_uses, note)
VALUES ('DIWALI20', 'growth', 2, 20, 'Diwali offer');
```

You can change a code's places with `PATCH /staff/coupons/{code}` and `{"active": true, "max_uses": 100}`.
