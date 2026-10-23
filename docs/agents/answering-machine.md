# The answering machine

Kritvia answers questions on every channel the business connects (WhatsApp, Telegram, email, Slack) with
the business's real records.

- **The owner and the team** ask anything from their own linked chats and get the answer with actual
  numbers: see [Run the business from Telegram or WhatsApp](front-door.md) (owner side).
- **Customers** asking about their *own* records get an answer straight away, if the business switched it
  on (below). Everything else a customer writes still gets a draft that waits for a yes.

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
