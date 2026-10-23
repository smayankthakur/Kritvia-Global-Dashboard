# The answering machine

Kritvia answers questions on every channel the business connects (WhatsApp, Telegram, email, Slack) with
the business's real records.

- **The owner and the team** ask anything from their own linked chats and get the answer with actual
  numbers: see [Run the business from Telegram or WhatsApp](front-door.md) (owner side).
- **Customers** asking about their *own* records get an answer straight away, if the business switched it
  on (below). Everything else a customer writes still gets a draft that waits for a yes, unless the
  business lets the inbox assistant **reply by itself** (last section).

## Customers: questions about their own records

**Switch:** Chats page → "Answer customers' questions about their own records by themselves", or Agents →
Inbox assistant → the same option (`answer_facts`, off by default).

| The customer asks | The answer (from the records) |
|---|---|
| how much they owe / is an invoice paid (`balance`) | each open invoice with what is still due and its due date, the total, and the payment link(s) |
| how or where to pay (`pay_link`) | the payment link of each open invoice, with what is due |
| when their booking is (`booking`) | their next confirmed booking(s), in IST |
| where their order or shipment is (`shipment`) | each active shipment file: stage, vessel, departure or arrival date |

Every answer ends with "for anything else, just reply and someone from our team will get back to you". It
is written in the customer's language (English, Hindi in Devanagari, or Hinglish), or in the inbox
assistant's reply language when that is set.

### How it works (`workflows/inbox.py` step `facts`, `services/customer_facts.py`)

1. The inbox assistant's classifier names the question (`fact_question`: none, balance, pay_link, booking,
   shipment). That is all the model does: it never writes the answer, a number, a date or a link.
2. Code finds the records of the person who wrote, by **verified identity** only:
   - WhatsApp: the number Meta delivered the message from (the same digits, or the same last 10 digits);
   - Telegram: the chat id (bookings made in that chat; invoices carry no chat id);
   - email: the From address, only when Gmail authenticated the sender's domain.
   Another customer's records, and other businesses' records, can never be included.
3. Code writes the answer from fixed wording. When the records have nothing for the question, the normal
   reply draft runs instead.
4. The answer is an ordinary approval card for the channel's send action (`whatsapp.send`,
   `telegram.send`, `gmail.send`). With the switch on, it is created `auto_approved`
   (`ApprovalRequest.auto_option = "answer_facts"`), the same way earned autonomy works, and it is sent
   at once. With the switch off, it waits for a yes like any draft, already written.

### Limits and safety

- **Never automatic** for: a sensitive message (an ID, card or account number in it); a run the injection
  guard flagged, or a draft the guardrails object to; an email whose sender Gmail didn't authenticate; a
  customer who wrote STOP or whose chat a person took over; more than 5 automatic answers to the same
  sender in an hour (the 6th waits for a yes).
- The database enforces the switch too (migration 0075): an approval may be created `auto_approved` only
  by earned autonomy, or for the inbox agent's three reply actions in a business whose inbox assistant
  has `answer_facts` switched on; never for a sensitive draft.
- No internal knowledge (documents, notes, proposals) is used in these answers, and no outward tool is
  called.
- Every automatic answer leaves its card (status *auto-approved*, title "From your records: …") on the
  Activity and Inbox history, a `ai.auto_option_used` security event, and the run's summary records the
  question (`fact_answer`) and whether it went by itself (`fact_auto`).

Tests: `tests/test_customer_facts.py`.

## Replying by itself

**Switch:** Chats page → "Reply to every customer message by itself", or Agents → Inbox assistant. Options
(all on the inbox assistant, `workflows/inbox.py`; helpers in `services/auto_reply.py`):

| Option | Default | Meaning |
|---|---|---|
| `auto_reply` | off | every customer message on a chosen channel gets an answer straight away |
| `auto_reply_channels` | WhatsApp, Telegram, Email | the channels it answers on by itself |
| `reply_tone` | `warm` | `warm` (friendly), `professional` (polite) or `playful` (fun) |

### The voice (`auto_reply.persona`)

Short, WhatsApp-style messages on chats; a proper email on email. It mirrors the customer's language (Hindi
in Devanagari, Hinglish in Roman script, English), uses light humour, and uses emojis only if the customer
did. Small talk gets a friendly line and a steer back to the business. A message that needs no answer
("hi", "thanks") gets one short friendly line.

- **Honesty:** it never says or suggests it is a human. Asked sincerely whether they are talking to a bot,
  it says it is the business's AI assistant and offers a person.
- **No invention:** it never makes up prices, offers, discounts, stock, timings or policies. In auto mode
  the rate card (`rate_cards`) and booking services' prices are put in the prompt as the prices it may quote.

### The money and complaint gate

The draft returns `needs_owner` and `owner_reason` (`price_not_on_record`, `discount_or_offer`,
`refund_or_payment_dispute`, `commitment_or_deal`, `complaint`, `unsure`). Independently, **code** reads every
rupee amount and percentage in the draft (`₹`, `Rs`, `INR`, `rupees`, `रुपये`, `5k`, `2 lakh`, …) and holds it
if any is not in the sources it was given, the rate card, booking prices, the customer's own invoices or the
offer text. Phone numbers, dates and times are not amounts. Either check holds the reply:

1. the customer gets a **fixed holding line written by code** in their language ("Let me check this with the
   team and get back to you shortly", in English, Hindi or Hinglish; 🙏 only if they used an emoji), sent
   by itself (step `hold`, approval "Replied by itself: holding line…");
2. the team gets a push ("A customer's message needs you");
3. the real draft waits as a pending card "Needs you (<reason>): …" (step `owner_draft`, `always_review`).
   It is never sent by itself.

**Held by code, whatever the model says** (the owner chose these to see first): the classifier's `intent`
`order` or `payment` and any reply that confirms a booking (`booking` pick) → reason `order_booking_payment`;
`intent` `complaint` → `complaint`; `refund` → `refund_or_payment_dispute`; a reply that cites any of the
business's own documents, notes, Drive files or past proposals (`used_sources`) → `internal_source`; a reply
that says it is a person (`auto_reply.claims_human`: "I'm a real person", "not a bot", "main insaan hoon",
"मैं इंसान हूँ"…) → `claims_human`. Offering free booking times still goes out by itself; confirming one waits.

The holding line depends on the reason (`auto_reply.hold_kind`): complaints and refunds get "Sorry about this!
I've passed it to <business>'s team, and someone will get back to you personally soon"; orders, bookings,
payments and deals get "Got it! Let me confirm this with the team and get right back to you"; everything else
"Let me check this with the team…". All three in English, Hindi and Hinglish, written by code.

A customer who asks for a person goes down the existing hand-to-person path (chat marked, team notified)
and gets the holding line "…someone will reply to you soon" (the "sorry" line when they are complaining or
asking for a refund). An email enquiry that goes to Lead triage gets
a fixed thank-you ("…we'll send you the details and a quote shortly") while the proposal waits as usual.

### Loops, floods and what never gets a reply

- **Acknowledgements:** no automatic reply to a message that needs none if the business auto-replied to the
  same person in the last 10 minutes (no "thanks" ↔ "welcome" ping-pong with another bot).
- **Caps:** 15 automatic replies to one person an hour, 500 per business a day (counted from the inbox
  runs' summaries, `auto_to` and `auto_sent`), and none to a sender who wrote more than 30 messages that
  reached a reply in the last hour (a machine talking to us). Beyond that the draft waits for a yes, with no
  holding line.
- **The chat history** shows automatic replies as "Sent by Kritvia (auto)" (`MessageOut.auto`: the message's
  approval was `auto_approved`); approved ones stay "Kritvia (approved)".
- **Never automatic:** spam, updates and notifications; automated email senders (`no-reply@`,
  `mailer-daemon`, `Auto-Submitted`, `Precedence: bulk/list`, `List-Unsubscribe`/`List-Id`; the Gmail poller
  sets `automated`); STOP; chats a person took over; runs the injection guard flagged and drafts the
  guardrails object to; sensitive messages (an ID, card or account number); Prospector replies; a redraft
  the owner asked for. A reply to an email whose sender Gmail didn't authenticate that draws on the
  business's own documents or notes is held like a money promise (holding line, then "Needs you").
- The sender's own phone number is not counted when checking a message for ID numbers (a 12-digit
  WhatsApp number can pass the Aadhaar check digit).

### Engine and database

- Automatic sends use `ApprovalRequest.auto_option = "auto_reply"` and go through the runner like earned
  autonomy (it still withholds for sensitive, flagged, `always_review` and guardrail objections), each
  logging an `ai.auto_option_used` security event; titles start "Replied by itself:".
- Migration `0077_auto_reply.sql` replaces `private.guard_approval_insert`: besides earned autonomy and
  `answer_facts` (step `facts`), an `auto_approved` inbox send is allowed only for steps `draft`, `hold`
  and `facts` of an `inbox_assistant` run in a business whose inbox config is enabled with `auto_reply`
  on and the send's channel in `auto_reply_channels`. Never for a sensitive approval; never for
  `owner_draft`.
- `answer_facts` and `auto_reply` work together: questions about the customer's own records keep the
  code-written answer (`facts`), sent by itself when either switch is on.

Tests: `tests/test_auto_reply.py`.
