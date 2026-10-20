# Coupons

Kritvia's team creates coupons on **Kritvia team → Coupons** (`/staff/coupons`, for `STAFF_EMAILS`).
Migrations 0049 and 0065.

## What a coupon can give (`kind`)

| Kind | What the business gets | Charged? |
|---|---|---|
| `free_plan` | A paid plan (Starter, Growth or Scale) free for some months (1–12) or days (1–365) | Never |
| `percent_off` | A percentage off a paid plan when it subscribes, optionally only for some plans and monthly or annual billing | Less, through Razorpay |
| `trial_days` | Extra days on the free trial (1–365), without unlocking a higher plan | Never |
| `ai_tokens` | Extra hosted-AI tokens on the monthly allowance, for some months | Never |

The launch coupon **FIRST50** gives the Scale plan free for 3 months to the first 50 businesses not on a
paid plan.

### How a percentage off works

Razorpay has no API for offers, so the offer is set up once in the Razorpay dashboard.

1. In Razorpay, go to Subscriptions → Offers and create an offer with the same percent and number of
   billing cycles.
2. Paste its `offer_…` id on the coupon.

When the business subscribes to a matching plan and period, Kritvia attaches the offer to the subscription
and writes the coupon code into the subscription's notes. Only Kritvia's server writes those notes.

- **Lower charges.** The Razorpay webhook accepts the lower amount only for a subscription made with the
  coupon.
- **Used once.** The first paid charge marks the coupon used, so a later subscription doesn't get it again.
- **Partner offers.** A coupon wins over a partner's 10% offer; Razorpay allows one offer per subscription.

## Who can use it

- **Businesses (`who`).**
  - `new`: only organisations created after the coupon started. Optionally it must also be used within N
    days of signing up (`signup_days`).
  - `unpaid`: any organisation not on a paid plan (FIRST50).
  - `anyone`: paying organisations too. A paying business gets a percentage off on its next subscription.
    A free plan or trial days never apply to a paying organisation.
- **Industries.** Only organisations with a business of these industries. The industry is the onboarding
  template:

  | Value | Industry |
  |---|---|
  | `agency` | Agency or services |
  | `loans` | Loans & real estate |
  | `kitchen` | Restaurant or cloud kitchen |
  | `trade` | Exporter, importer or C&F agent |
  | `retail` | Shop or e-commerce |
  | `clinic` | Clinic, salon or local services |
  | `coaching` | Coaching or education |
  | `freelancer` | Freelancer or consultant |
  | `other` | Something else |

  Businesses set up before 0065 count by their kind: software is agency, finance is loans, and general is
  other. `venture_settings.industry` holds it.
- **Private codes.** A list of email addresses and/or email domains. Only those people can use the code;
  anyone else is told it was given to someone else.
- **Dates and places.**
  - `starts_at` and `expires_at` are optional.
  - `max_uses` is the number of businesses that can use the code.
  - `active` is an on/off switch.

## Rules (`private.use_coupon`)

- **Who applies.** Only an organisation's owner can apply a coupon.
- **Limits.**
  - An organisation holds at most one coupon of each kind; for example, free plan time and extra AI usage
    together are fine.
  - Each person can use a given code once.
- **Places.** They are counted under a row lock, so a code is never used more than `max_uses` times.
- **Free plan time.**
  - `private.applied_plan` picks the plan that applies; every plan check reads it.
  - A paid plan always wins.
  - When the free time ends, the organisation is back on Free, with 7 days to choose a plan.
- **Extra trial days.** They move the trial's end (`private.trial_end`).
- **Extra AI usage.** It is added to the monthly allowance while it runs (`coupon_bonus_tokens`, shown as
  `bonus_tokens` on the plan).
- **When a code is applied from a link.**
  - With a sign-up link (`/register?coupon=CODE`), the code is applied at onboarding, after the
    businesses are created, so an industry coupon can check them.
  - Owners can also enter a code under Plan & billing → Coupons.
- **Terms.** People accept clause 10.10 of the Terms when they apply a coupon.

## Kritvia's team page

| What | How |
|---|---|
| Create | Give a code (or press Generate) and choose what it gives, who can use it, the dates and the places. The form shows the offer in the exact words customers will read. |
| Edit | Change who can use it, the dates, the places, the note and on/off at any time. Once someone has used a code, what it gives can't change; duplicate it into a new code instead. |
| Find | Tabs by status (open, starts later, all places taken, ended, off) and a search box. |
| Per code | Copy the sign-up link, duplicate, switch on/off, download who used it as a CSV, delete an unused code. |

API:

- `GET /staff/coupons` and `GET /staff/coupons/options`.
- `POST /staff/coupons` creates a code.
- `PUT /staff/coupons/{code}` edits a code; `PATCH /staff/coupons/{code}` switches it on/off and changes its
  places.
- `DELETE /staff/coupons/{code}` deletes an unused code.
- `GET /staff/coupons/{code}/uses.csv` downloads who used it.
