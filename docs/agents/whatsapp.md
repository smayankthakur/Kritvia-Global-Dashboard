# WhatsApp front door (customer chats)

Customers message a business's WhatsApp Business number. Kritvia keeps every chat, drafts each reply
with the whole chat in mind, and waits for a person's yes. The team reads and answers chats on the
**Chats** page (shared with [Telegram](telegram.md)). Code: `services/wa_inbox.py`, `routers/whatsapp_chats.py`, the WhatsApp parts of
`workflows/inbox.py` and `routers/connectors.py` (`/hooks/whatsapp`); web: `app/(app)/v/[ventureId]/whatsapp`.
Migrations `0034_whatsapp_front_door.sql`, `0035_whatsapp_templates.sql`.

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

## Templates (writing first, or after 24 hours)

WhatsApp only lets a business start a chat, or answer after the 24 hours, with a message template
Meta approved in advance. On the WhatsApp page, **Templates** tab:

- **New template:** a name for the team, the kind of message (*Update*: about an order, booking or
  payment, Meta's UTILITY; *Offer or news*: MARKETING, which costs more), the language, and the text
  with blanks `{{1}}`, `{{2}}` plus a sample for each. Meta's wording rules are checked first (blanks
  numbered in order, not at the start or end, enough words around them). Kritvia sends it for review;
  Meta's answer arrives at the webhook (`message_template_status_update`) and the team gets a push
  notification. Rejected templates show Meta's reason.
- **Refresh** picks up templates written in WhatsApp Manager and drops ones deleted there. Templates
  that need a photo, a link with a blank or a code show as approved but are sent from WhatsApp Manager.
- **Sending:** in a chat whose 24 hours are over, the composer becomes a template picker with the
  blanks and a preview. **New chat** writes first to a number, with a template, after the team member
  confirms the person agreed to get WhatsApp messages. Their answer is drafted like any other chat.
- Only admins delete templates (also from the WhatsApp account; Meta blocks the name for 30 days).
- Templates are tied to the WhatsApp Business Account (WABA). The one-click signup stores it; a number
  connected with a token needs its WABA id too (optional field) to write templates in Kritvia.

API: `GET/POST /ventures/{v}/whatsapp/templates` (`?refresh=true`), `DELETE …/templates/{id}`,
`POST …/whatsapp/chats/{id}/template`, `POST …/whatsapp/chats` (new chat).

## Agents that send templates

Who may be written to: only people who **agreed to hear from the business**. A customer who wrote first
counts (`wa_contacts.opt_in_source = 'wrote_first'`); so does a number a team member started with
**New chat** after confirming consent (`'team_confirmed'`). Never a cold number: a Prospector's first
WhatsApp still goes from the owner's own phone, because WhatsApp bans numbers that message strangers.

- **WhatsApp follow-ups** (`workflows/whatsapp_followup.py`, a core agent, Sales on the board). Every
  day at the set time (default 11:00 IST) it finds chats where the business answered last and the
  customer has been quiet for *after_days* (default 2): Kritvia handles the chat, the customer opted in,
  no STOP, fewer than *max_followups* (default 1) since they last wrote, and by default an open lead.
  For each, it fills the blanks of the owner's chosen template from the chat (or skips the chat if a
  follow-up would be wrong, e.g. they already said no) and asks for approval (`whatsapp.template`).
  A reply resets the count; a chat turned down or skipped isn't asked about again until the next quiet
  spell.
- **The assistant** can list the templates (`whatsapp.templates`) and send one on request
  (`whatsapp.template`), with approval, to someone who opted in.

`whatsapp.template` approvals show the message as the customer will get it. They can be approved or
rejected but not edited (WhatsApp approved the wording); the send renders the text again from the same
template. A WhatsApp approval's recipient can never be changed (`validate_edit`).
`services/wa_templates.py` holds these rules for every sender. Migration `0036_whatsapp_followups.sql`.

## Messages sent from the phone

A number kept on the **WhatsApp Business app** (coexistence) can still be used on the phone. Meta sends
those messages to the webhook as `smb_message_echoes`; Kritvia stores them in the chat as "You, from the
phone", takes the chat over for the team ("Answered from the WhatsApp Business app") and withdraws any
draft still waiting, so the customer never gets a second answer. Replying on the WhatsApp page does the
same.

## Rules

- **24-hour window:** WhatsApp only allows free-form messages within 24 hours of the customer's
  last message. Kritvia checks this before sending (agent replies and the page) and says so clearly;
  Meta is not asked. Outside the window the team sends an approved template.
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
  (fields `messages`, `message_template_status_update`, and `smb_message_echoes` for app numbers); Facebook Login for Business → Configurations →
  a "WhatsApp Embedded Signup" configuration (its id is `WHATSAPP_SIGNUP_CONFIG_ID`); allowed domain
  `app.<domain>`.
- Meta requires Kritvia to be a **Tech Provider** (business verification and app review for
  `whatsapp_business_management` and `whatsapp_business_messaging`) before other businesses can use
  the signup. Until then only people with a role on Kritvia's Meta app can complete it.
- The connect page alone allows Meta's hosts and popups (`docs/compliance/third-party-register.md`).

## Not built yet

Payment reminders (Kritvia has no invoice records with phone numbers yet), templates with photos or
buttons, offering meeting slots from the calendar, media (photos,
voice notes) beyond their captions, read receipts, and importing chat history from the WhatsApp
Business app.
