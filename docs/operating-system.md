# The operating system (Phase 4, migration 0063)

## One stream of events

Database triggers write a short, non-sensitive event whenever something happens: `lead.new`, `lead.qualified`,
`lead.won`, `lead.lost`, `invoice.drafted`, `invoice.issued`, `invoice.paid`, `payment.received`, `booking.new`,
`booking.done`, `booking.cancelled`, `booking.no_show`, `bill.new`, `bill.paid`, `review.new`,
`customer.opted_out`, `campaign.sent`, `candidate.new`, `candidate.shortlisted`. Because they come from the
tables themselves, nothing changes without its event, whoever changed it (a person, an agent, a webhook).

The worker's `dispatch_events` job (every minute) claims new events once (`private.claim_events`, SKIP LOCKED) and:

- starts skills whose trigger is `on_event` ("right after an invoice is paid, draft a thank-you"), one run per
  event, told about the record;
- sends "tell me when" alerts (`event_alerts`, optionally only above an amount) to the owners and admins.

The Activity page shows the stream and the alerts; the assistant reads it with `events.recent`.

## Routines the assistant sets up

When someone asks for something regular ("every Monday send me the overdue invoices", "whenever a payment
comes in, thank the customer"), or agrees to a routine the assistant suggests, it uses `routines.create`. The
card shows the routine and when it runs, in words ("Every Monday at 09:00"); after one yes it is saved as a
skill (schedule or `on_event`). What the routine drafts later still waits for a yes as usual. An incomplete
routine (an unknown event, no steps) never reaches the board.

## Hiring

Open a role with its must-haves and nice-to-haves; it gets a code (JOB-XXXX). CVs (PDF or Word) are uploaded
on the People page, or emailed to the business's Kritvia address with the code in the subject (or "application",
"resume" or "CV" while only one role is open). The `hiring` agent scores each CV 0-100 with reasons, judging
skills and experience only. Code decides the verdict: shortlist at 70+ with every must-have met, maybe at 45+.
Shortlisted people with an email get an interview invite after a yes. Nobody is rejected by email. CV text is
encrypted and deleted 180 days after the role closes (`purge_candidates`).

## Attendance

Add the team with their WhatsApp numbers, start times and pay. Staff send IN / OUT (also "aa gaya", "check in",
"ja raha", "check out") to the business's WhatsApp number; Kritvia notes the time and replies. Anything else they
write is an ordinary message. At 12:05 IST (`attendance_check`) the owners hear who hasn't checked in an hour
after their start time (Monday to Saturday). A person can mark present, half day, absent or leave. The month
sheet adds it up with a pay estimate (monthly pay in proportion to paid days; daily pay times days) and
downloads as Excel for the accountant.
