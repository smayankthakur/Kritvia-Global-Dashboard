# Google reviews agent

## Setting up

**Reviews** page: an admin searches Google Maps for the business and picks **This is us**. Only the
place ID is stored. The agent then runs daily on the Agents page, by default at 19:00 IST.

## What it does each day

1. **Reads the reviews Google shows** (up to five) through Places API (New), using the business's own
   Google Maps key, or the server key on internal plans.
2. **Drafts a reply** for each review it hasn't seen.
   - Warm and specific for 4–5 stars.
   - For 1–3 stars, an apology and an invitation to get in touch. No offers, refunds, prices or phone
     numbers.
   - Low ratings notify the team.
3. **Asks for reviews.** It looks for bookings marked *done* and invoices *paid* in the last 3 days.
   - One thank-you per customer, in their channel (WhatsApp, Telegram or email), with the business's
     "write a review" link.
   - Each one waits for a yes, unless you have given the agent autonomy.
   - Nobody is asked twice in 90 days.

Replies are **drafted, not posted**: Kritvia can't post to Google. The person edits a reply, copies it,
uses **Reply on Google**, then marks it **I posted it** or **No reply needed**.

## Google's terms

Maps Platform allows storing only place IDs. Kritvia stores:

- the place ID;
- for each review, a SHA-256 of its Google resource name, its star rating, and our own draft reply.

The review's text and author are fetched live whenever the page is shown, and are never written to the
database. There is a test for this.

## Code and not built yet

Code:

- `workflows/reviews.py`;
- `routers/reviews.py`;
- `PlacesClient.reviews`;
- migration `0045_reviews.sql`;
- web: `app/(app)/v/[ventureId]/reviews`.

Not built yet: posting replies through the Google Business Profile API, which needs Google's approval
for each business.
