# AI phone calls

**Calls** (next to Browser). Kritvia answers the business's own phone number, and phones customers back
after a yes. Growth, Scale and Enterprise.

## Answering the business's number

1. An admin connects the business's **Twilio** number (Account SID, auth token, the number). Kritvia checks
   them with Twilio, stores the token encrypted, and points the number's voice and status webhooks at
   `/hooks/voice/twilio/<connector>/incoming` and `/status`.
2. Switch **answering** on, pick Hindi/Hinglish or Indian English and a voice (Amazon Polly Aditi, Kajal or
   Raveena, spoken by Twilio), a greeting, opening days and hours, a number to put callers through to, and the
   longest call (2–20 minutes, default 8).
3. A call goes turn by turn: Twilio says Kritvia's words and listens with its own speech recognition (or a key:
   **0** asks for a person), and posts what the caller said; Kritvia answers with the next words. No audio passes
   through Kritvia. Every request is checked with Twilio's signature (HMAC-SHA1 with the business's own token).

What the assistant on the phone does:

| Caller wants | Kritvia |
|---|---|
| A question | answers from the business's details and its memory (top 3 notes for what was said); if it doesn't know, it offers a callback |
| To leave a message | takes name and what they need, reads it back → a **task** "Call back …" |
| A booking or appointment | takes the service and the day and time → a **task** "Booking request …" (never confirms a slot itself) |
| A person | in opening hours, with a put-through number: rings it for 25 s; nobody picks up → it offers to take a message |
| "Don't call me" | says sorry and goodbye; the number goes on the business's **do-not-call list** |
| Card numbers, OTPs, bank details, payments | never asks for or takes them |

The greeting always says it is the business's AI assistant (a custom greeting without the words gets that
sentence in front). Limits: 24 replies, the longest call, two silences in a row.

When the call ends (Twilio's status webhook): a short summary for the owner, a **lead** for a new caller
(source `phone`), the tasks above, and a push "A caller left a message" with the number masked (no call content).
The Calls page lists every call with its summary and what was said.

## Test calls (no phone needed)

**Try a call**: you play the caller (type, or speak with the voice button); Kritvia answers exactly as on the
phone and can read its replies aloud in the browser. Test calls make no leads, tasks or pushes.

## Phoning customers

**Phone a customer** (or ask the assistant: "call Priya about tomorrow's 4 pm appointment", tool `voice.call`).
Every call is an approval showing who, why and the exact opening line ("Hello Priya! This is Sharma Sweets's
AI assistant, calling about …"); the number can't be changed, and a person always reviews it.

Rules (enforced when the call is placed, not only by the model):

- Only for people the business already deals with, for service (a reminder, a callback they asked for), never
  promotion.
- 9 am to 9 pm in the business's time zone; at most one Kritvia call a day to a number; never a number on the
  do-not-call list.
- **Outbound calling is off** until an admin records the business's TRAI **DLT** registration (Principal Entity
  ID) and its caller id type (a 160-series service number or a registered landline) and confirms the rules.
  Until then an approved call is a **test call**: nothing is dialled and it shows in the list to answer in the
  app.

## Pieces

- Migration 0057: `phone_settings`, `calls` (number encrypted plus a per-business hash, conversation and summary
  encrypted), `voice_dnd`, connectors provider `twilio_voice` (number = `external_id`, account SID in `meta`, token
  in `connector_tokens`), `private.voice_principal`.
- `services/twilio_voice.py` (signatures, TwiML, REST), `services/voice_calls.py` (the call: greeting, turns,
  finish, place), `workflows/voice_call.py` (approval → dial), tool `voice.call`, `routers/calls.py`.
- Web: `app/(app)/v/[ventureId]/calls/page.tsx`, `components/calls/calls.tsx`; the approval card shows calls.

## Owner to do before real calls

- A Twilio account with an Indian number (Twilio's regulatory bundle for India) or another number that can reach
  Indian callers; put the Account SID and auth token in the Calls page yourself.
- For calling customers: register the business on a DLT platform (Jio, Airtel, Vi or BSNL) and get a 160-series or
  registered caller id with Twilio; then switch outbound calls on.
- Privacy policy and Terms: phone calls (caller number, what was said, summaries; AI disclosure; do-not-call list)
  — wording is the owner's decision.

## Credits

The call design (greeting with disclosure, message taking that is saved before the caller is told, put-through
with a fallback, silence and length limits, one summary when the call ends) was informed by studying
[AIReceptionist](https://github.com/kirklandsig/AIReceptionist). That project is AGPL-3.0, so none of its code or
prompts are used here; Kritvia's implementation is its own, on Twilio's turn-by-turn webhooks instead of LiveKit and
a speech-to-speech model.
