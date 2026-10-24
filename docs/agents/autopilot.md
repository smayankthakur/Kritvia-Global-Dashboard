# Autopilot

One switch per business that lets the agents do routine work by themselves (`services/autopilot.py`,
migration `0080_autopilot.sql`). It is off until the business switches it on: onboarding asks ("Autopilot" or
"I'll approve everything", nothing pre-ticked), and existing businesses see a card on the dashboard and a
switch in Settings → General.

## What it does by itself

| Agent | By itself | Still asks |
|---|---|---|
| Inbox (WhatsApp, Telegram, email) | Answers customers; answers their own invoice, booking and shipment questions from the records | Refunds, discounts, prices not on the rate card, complaints, legal matters, orders and payments, anyone asking for a person, email senders Gmail couldn't verify |
| Booking reminders | The day-before reminder | — |
| Payment reminders | The first two reminders of an invoice | Third and later |
| Reviews | Replies to 4-5 star reviews; asks happy customers for a review | 1-3 star reviews |
| Social posts | Posts on the chosen days | A post quoting an amount or offer the owner didn't write |
| WhatsApp follow-ups | The follow-up to an enquiry that went quiet | — |
| Prospector | First messages and follow-ups from the offer line | A price the offer doesn't contain |
| Bank | Records money in that surely matches an invoice (undo on each line) | Money going out, unsure matches |

Never by autopilot: invoices, purchase orders, proposals, refunds, campaigns, payments, calls, actions in
other apps, changes to Kritvia itself.

## Plans

- Free trial: the inbox replies only (as "reply by itself" always could). The other agents keep asking, as the
  pricing page says.
- Starter: each agent's first kind of action (all its channels count as one).
- Growth and up: everything in the table.

## How it is enforced

1. The workflow marks a draft as autopilot work only when its own checks pass (`ApprovalRequest.autopilot`):
   a 4-5 star review, the first two reminders, a reply with no hand-off words or unknown amounts.
2. The runner approves it only when the business's autopilot is on and the plan allows the agent's action
   (`autopilot.allowed`), never a sensitive or always-review draft, never in a flagged run, and under the
   automatic-reply caps for inbox replies (checked under a per-business lock).
3. The database refuses an automatic card for anything outside the list (`private.autopilot_allows`, called by
   `private.guard_approval_insert`), whatever the code asks for.

## Staying in control

- 8 pm IST every day: a summary on push, Telegram and email (what went out by itself, what is waiting, what
  came to the owner, anything that failed).
- Reply PAUSE (or `/pause`) from a linked Telegram or WhatsApp chat to stop it; RESUME (or `/resume`) to start
  it again. Only admins of the business can.
- `GET/PUT /ventures/{v}/autopilot` for the dashboard card and the switch; every change is in the audit log.
