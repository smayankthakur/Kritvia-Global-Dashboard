# Run the business from Telegram or WhatsApp (owner side of the front door)

A team member links their own chat once, on **Account → Approve from your phone**:

- **Telegram:** a one-time `t.me/<business bot>?start=link_<code>` link (unchanged from approvals in chat).
- **WhatsApp:** a one-time `wa.me/<business number>?text=link_<code>` link. Sending that code from the person's
  phone to the business's number links that number to them. A code works once, for 15 minutes; a code
  Kritvia didn't give out is just a customer message.

From then on, in that chat (`services/front_door.py`):

| They send | Kritvia does |
|---|---|
| a message | starts the Kritvia assistant **as that person** (their own history on the Assistant page, their role checks); the answer comes back in the chat |
| a voice note | downloads it (Telegram `getFile`; WhatsApp Graph media, only from Meta's file hosts), transcribes it like dictation with the business's vocabulary as hints, replies "Heard: …", then handles it like a message |
| `/today`, `/week` | the business's numbers for today / the last 7 days, computed in code (no AI call) |
| `/waiting` | the 5 oldest drafts this person can decide, sent again as cards |
| `/help` | what can be done there |
| a photo or file | a short note: messages and voice notes only |

Drafts the assistant makes (emails, WhatsApp messages, tasks, leads…) wait for a yes like every other
draft, and arrive in the linked chats of the people who can decide them, as cards:

- Telegram: inline buttons Approve / Reject / Ask for changes (as before).
- WhatsApp: reply buttons Approve / Reject / Ask for changes. "Ask for changes" asks what should change; the
  next message is the note. WhatsApp messages can't be edited, so a decided card isn't updated there.

## Rules

- **Roles:** asking the business to do something needs write access, as on the Assistant page. An approver
  can decide drafts, use `/today` and `/waiting`, and is told that asking needs an operator or admin role.
- **WhatsApp's 24-hour window:** a business may message someone freely only for 24 hours after they last
  wrote. `approver_links.last_inbound_at` records that; answers and cards go to WhatsApp only inside the
  window (they stay in the app, Telegram and Slack otherwise). The Account page says so.
- **Never a customer chat:** a linked person's messages are never stored as customer chats or answered by the
  inbox assistant.
- **Answers only to the asker:** an answer goes back only while that chat is still linked to the person who
  asked.
- **Not deduplicated:** Telegram and WhatsApp redeliver only when the webhook didn't answer 200, and it
  always does once the sender checks out.
- **Voice notes** count as dictation (surface `telegram` / `whatsapp`, mode `ask`) in the person's voice stats.

Code: `services/front_door.py`, `services/chat_approvals.py` (`telegram_update`, `whatsapp_update`, cards),
`routers/chat_approvals.py` (`POST /ventures/{v}/approver-links/whatsapp`), `workflows/assistant.py`
(`_reply_back`). Migration `0054_owner_front_door.sql`. Tests: `tests/test_front_door.py`.
