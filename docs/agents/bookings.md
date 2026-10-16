# Bookings from chat

## Setting up

**Bookings → Hours & services**. An admin sets:

- **opening hours** per weekday, up to two spans a day (for a lunch break);
- **start times every** 10–120 minutes;
- **at the same time**: how many bookings can overlap (chairs, rooms, staff);
- **notice** needed, in hours, and **days ahead** customers can book;
- whether to **check Google Calendar** and add bookings to it (needs Google connected);
- the **services**: name, minutes, and an optional price.

## In a chat or email

When the Inbox assistant sorts a message as *scheduling* or *enquiry* and the business takes bookings:

- It gets the free times for each service. These are computed from opening hours, minus confirmed
  bookings (up to the capacity) and minus busy Google Calendar events. Up to 8 times are spread over the
  coming days, each with a code.
- The reply offers two or three of them and never any other time.
- When the customer has clearly picked one, the reply confirms it and the draft carries the booking.
  The approval shows "Approving also books Haircut, Sat 18 Oct 10:00 AM", and so do the Telegram and
  Slack cards.

When it is approved:

1. Kritvia books first, under a per-business lock, after checking the time again against bookings and
   the calendar.
2. Then it sends the reply.
3. It adds a Google Calendar event if that is switched on.

If the time was taken meanwhile, nothing is sent: the agent redrafts, apologises and offers other
times (twice at most).

## Day before

The **Booking reminders** agent (Agents page, daily at the time you set, default 18:00 IST) drafts a
reminder for each of tomorrow's bookings, in the channel the customer booked on.

- The text is written by code from the booking, plus an optional standing note.
- Each reminder waits for a yes, unless you have given the agent autonomy.
- WhatsApp only delivers within 24 hours of the customer's last message. Outside that window the send
  fails with that reason.

## Bookings page

- **Upcoming** lists bookings by day, with Done / No-show / Cancel.
- **Add booking** is for phone calls and walk-ins. It picks from free times; the API's
  `outside_hours: true` books outside opening hours, but never over capacity.

## Code and not built yet

Code:

- `services/bookings.py`;
- `routers/bookings.py`;
- `workflows/booking_reminders.py`;
- the booking offer and `_make_booking` in `workflows/inbox.py`;
- `google.busy`;
- migration `0044_bookings.sql`.

Not built yet:

- rescheduling from chat (a person changes it on the page; cancelling frees the time);
- deposits at booking (use an invoice payment link);
- per-staff calendars.
