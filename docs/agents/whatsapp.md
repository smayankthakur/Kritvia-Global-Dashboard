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

## Connecting a number (Settings → Connectors → Connect WhatsApp)

The owner presses **Connect WhatsApp** on `/v/<business>/whatsapp-connect`, logs in with Facebook in
Meta's window (Embedded Signup) and picks or adds their number; a new number is verified by SMS or call.
A number already on the **WhatsApp Business app** can be connected and stays usable on the phone
(coexistence). Kritvia then, on the server (`POST /ventures/{v}/connectors/whatsapp/signup`):

1. exchanges Meta's 30-second code for the business's token (app id + app secret);
2. finds the number when Meta's window didn't name it, and checks the token reaches it (ids from the
   browser are never trusted alone);
3. subscribes Kritvia's app to the WhatsApp account, so messages arrive at `/hooks/whatsapp`;
4. registers a new number on the Cloud API with a random two-step PIN (skipped for app numbers; reset the
   PIN in WhatsApp Manager if it is ever needed);
5. saves the number and the token (encrypted).

The manual way (phone number id + permanent token) stays on that page under "Advanced".

## Server set-up (once)

- `.env`: `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`, `META_APP_ID` and `WHATSAPP_SIGNUP_CONFIG_ID`.
- Meta app (Kritvia's): WhatsApp product with the webhook `https://api.<domain>/hooks/whatsapp`
  (`messages`; also `smb_message_echoes` for app numbers); Facebook Login for Business → Configurations →
  a "WhatsApp Embedded Signup" configuration (its id is `WHATSAPP_SIGNUP_CONFIG_ID`); allowed domain
  `app.<domain>`.
- Meta requires Kritvia to be a **Tech Provider** (business verification and app review for
  `whatsapp_business_management` and `whatsapp_business_messaging`) before other businesses can use
  the signup. Until then only people with a role on Kritvia's Meta app can complete it.
- The connect page alone allows Meta's hosts and popups (`docs/compliance/third-party-register.md`).

## Not built yet

Message templates (to write first or after 24 hours), offering meeting slots from the calendar,
media (photos, voice notes) beyond their captions, read receipts, and showing messages the owner sends
from the WhatsApp Business app (`smb_message_echoes`) in the chat.
