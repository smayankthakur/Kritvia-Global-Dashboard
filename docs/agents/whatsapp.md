# WhatsApp front door (customer chats)

Customers message a business's WhatsApp Business number. Kritvia keeps every chat, drafts each reply
with the whole chat in mind, and waits for a person's yes. The team reads and answers chats on the
**WhatsApp** page. Code: `services/wa_inbox.py`, `routers/whatsapp_chats.py`, the WhatsApp parts of
`workflows/inbox.py` and `routers/connectors.py` (`/hooks/whatsapp`); web: `app/(app)/v/[ventureId]/whatsapp`.
Migration `0034_whatsapp_front_door.sql`.

## What happens to a message

1. Meta posts it to `/hooks/whatsapp`. The signature is checked, the business is found by its
   phone number id, and the message is stored in the customer's chat (`wa_contacts`, `wa_messages`;
   the text is encrypted with the business's key, purpose `whatsapp.message`). A redelivered message
   is stored once.
2. If a person is handling the chat, or the customer wrote STOP, nothing is drafted. When a person
   has the chat, the team gets a push notification.
3. Otherwise an inbox-assistant run starts:
   - **The customer wrote again** before the draft was made: the run stops ("superseded"); the newer
     message's run answers everything.
   - **Enquiry:** the chat gets a lead (source `whatsapp`, linked to the chat). It stays in the
     chat; Lead triage is for email and web forms.
   - **The customer asks for a person** (or is angry, or wants a refund or dispute handled): the chat
     is handed to the team, who get a push notification; nothing is drafted.
   - **A reply is needed:** the draft is written from the last 12 messages of the chat plus the
     business's knowledge, and goes to the Inbox for approval like any other draft. An earlier
     draft for the same chat that is still waiting is withdrawn, since the new one answers both.
4. An approved reply is sent through the business's number and stored in the chat as "Kritvia".

## The WhatsApp page

- Chats, newest first, with unread counts. Opening a chat marks it read (approvers too).
- **Take over / Give back to Kritvia** switches who replies. Sending a message from the page takes
  the chat over automatically, so the customer never gets two answers.
- A draft waiting for approval shows in the chat with a link to it.
- Admins can delete a chat and all its messages (for a customer's erasure request).
- Read-only roles (approver, viewer) can read chats but not answer or switch them.

## Rules

- **24-hour window:** WhatsApp only allows free-form messages within 24 hours of the customer's
  last message. Kritvia checks this before sending (agent replies and the page) and says so clearly;
  Meta is not asked. Messages outside the window need an approved template (not built yet).
- **STOP:** "stop", "unsubscribe", "band karo", "mat bhejo" and similar opt the customer out. Their
  messages are still kept; nothing more is drafted or sent to them.
- **Privacy:** push notifications name who needs attention, never what they wrote. Chat text is
  treated as the customer's words, never as instructions to the agent. An ID, card or account number
  anywhere in the recent chat keeps the draft on the private model.

## Set-up

- Server `.env`: `WHATSAPP_APP_SECRET` and `WHATSAPP_VERIFY_TOKEN` of Kritvia's Meta app. In the Meta
  app, the webhook is `https://api.<domain>/hooks/whatsapp` with the `messages` field subscribed.
- Each business connects its number in Settings → Connectors → WhatsApp with the phone number id and
  a permanent access token. The number must belong to a WhatsApp Business account that has Kritvia's
  Meta app added, because Meta sends webhooks only to that app.
- Today that link is made by hand (for the pilot, on the set-up call). Self-serve connection needs
  Meta's Embedded Signup, which requires Kritvia to be a Meta Tech Provider: the next step for this
  feature.

## Not built yet

Message templates (to write first or after 24 hours), offering meeting slots from the calendar,
media (photos, voice notes) beyond their captions, and read receipts.
