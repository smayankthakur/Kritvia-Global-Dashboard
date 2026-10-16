# First win in ten minutes

A new business sees a checklist at the top of the Dashboard until it is set up. The goal is the
first approved draft, which a new owner can reach in about ten minutes.

1. **Tell Kritvia about your business**: name and city.
2. **Switch on the Inbox assistant.**
3. **See your first draft.** *Send a practice message* gives the Inbox assistant a pretend customer
   email that fits the business:
   - a website enquiry for an agency;
   - home-loan documents for a loan business;
   - catering for a kitchen;
   - prices and Saturday opening for anything else.

   The email is addressed **from the person who pressed the button**, so the reply (after their yes)
   lands in their own inbox and never reaches a stranger.
4. **Say yes to it** in the Inbox.
5. **Get drafts on your phone**: push notifications, or Approve buttons in Telegram or Slack.
6. **Connect where customers write**: Gmail, WhatsApp, a Telegram bot, or email forwarding.
7. *(Optional)* **Add an invoice and share its payment link.**

Progress is read from what the business has done; nothing extra is stored.

- The card refreshes every 15 seconds until the first yes.
- After the first yes it shows how many minutes it took from sign-up.
- It disappears once the six required steps are done. **Hide** dismisses it in this browser.

## Pilot health (Kritvia's team)

People whose sign-in email is in `STAFF_EMAILS` see **Kritvia team → Pilot health**. It lists every
organisation with:

- its owner's email and plan;
- how many of the six steps are done;
- the hours to its first yes;
- drafts and decisions this week;
- when it was last active.

Each organisation gets a label:

- **first win**: active in the last 7 days after a first yes;
- **getting started**;
- **stuck**: two days without a yes;
- **gone quiet**: no activity for 7 days after a first win.

It shows counts and dates only, never customer data.

- Code: `routers/first_win.py` and migration `0042_first_win.sql`, with `private.first_win` and
  `private.pilot_health`.
- Web:
  - `components/first-win/first-win-card.tsx`;
  - `app/(app)/staff`.
