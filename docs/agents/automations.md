# Automations from plain words

**Automations** page. Type what you want regularly, in English, Hindi or Hinglish. For example:

- "Every Monday at 9 send me last week's sales";
- "Har din shaam 7 baje aaj ki payments batao on Telegram";
- "On the 1st of every month email last month's overdue invoices to ca@example.com".

## Setting one up

1. **Understand.** The model (extract tier) turns the words into a draft:
   - a name and a task;
   - the period it covers: today, yesterday, last 7 days, last week (Monday–Sunday), this month,
     last month or last 30 days;
   - when it runs: daily, weekly on some weekdays, or monthly on day 1–28, at HH:MM in the business's
     time zone;
   - where it goes;
   - other people's email addresses, if the words name any.
2. **Confirm.** The person sees the schedule in words ("Every Monday at 9:00 AM") and can change the
   name, period, time and channel, then saves.

A business can have up to 25 automations. Only the person who made one, or an admin, can switch it
off, run it now or remove it.

## Running

The worker's `fire_automations` runs every minute. It claims due automations with `FOR UPDATE SKIP
LOCKED`, so one worker takes each, starts an `automation` run, and sets the next time. If the run
didn't start, the error shows on the automation and it tries again at its next time.

The run:

1. Computes the business's numbers for the period in code:
   - money received;
   - invoices issued;
   - still to collect and overdue (with the five largest);
   - bookings;
   - new and won leads;
   - drafts by the agents.
2. The model writes a short report from **only** those numbers. If a figure the request asks for isn't
   tracked, the report says so.
3. The result is stored encrypted and readable under **Results**.
4. It is delivered to the person who made it, with no approval needed because it's their own data:
   - **email**, from Kritvia's own mail;
   - **their Telegram**, through the business's bot, if they linked it under Approve from your phone;
   - **the business's Slack**;
   - **only in Kritvia**.
5. **Other people's emails** go as one Gmail draft that waits for a yes each time, like every other
   agent's sends.

## Code

- `services/automations.py`: schedule maths, period ranges, the numbers, `fire_due`.
- `workflows/automation.py`.
- `routers/automations.py`.
- Migration `0046_automations.sql`.
- The worker's `fire_automations`.
