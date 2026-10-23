# Run the business from WhatsApp, Telegram, Slack or Email (owner side of the front door)

A team member links their own chat once, on **Account → Ask Kritvia from anywhere**:

- **Telegram:** a one-time `t.me/<business bot>?start=link_<code>` link (unchanged from approvals in chat).
- **WhatsApp:** a one-time `wa.me/<business number>?text=link_<code>` link. Sending that code from the person's
  phone to the business's number links that number to them. A code works once, for 15 minutes; a code
  Kritvia didn't give out is just a customer message.

- **Slack:** a DM from Kritvia's Slack app with a Link button (unchanged from approvals in chat). Then the
  person asks by messaging the app directly, or by mentioning it in a channel (the answer goes in that
  message's thread).
- **Email:** a private *ask address* per person per business, `ask-<128 random bits>@<inbound domain>`
  (`POST /ventures/{v}/ask-address`; shown once, only its sha256 is stored; a new one replaces the old;
  `DELETE` removes it). Needs write access, like the Assistant page.

From then on, in that chat (`services/front_door.py`):

| They send | Kritvia does |
|---|---|
| a message | starts the Kritvia assistant **as that person** (their own history on the Assistant page, their role checks); the answer comes back in the chat |
| a voice note | downloads it (Telegram `getFile`; WhatsApp Graph media, only from Meta's file hosts), transcribes it like dictation with the business's vocabulary as hints, replies "Heard: …", then handles it like a message |
| `/today`, `/week` | the business's numbers for today / the last 7 days, computed in code (no AI call) |
| `/waiting` | the 5 oldest drafts this person can decide, sent again as cards |
| `/help` | what can be done there |
| a photo or file | a short note: messages and voice notes only (by email: the text is used, attachments ignored, and the answer says so) |

Drafts the assistant makes (emails, WhatsApp messages, tasks, leads…) wait for a yes like every other
draft, and arrive in the linked chats of the people who can decide them, as cards:

- Telegram: inline buttons Approve / Reject / Ask for changes (as before).
- WhatsApp: reply buttons Approve / Reject / Ask for changes. "Ask for changes" asks what should change; the
  next message is the note. WhatsApp messages can't be edited, so a decided card isn't updated there.

## Email and Slack (`services/ask_anywhere.py`, migration 0076)

- **Email is answered only when** Cloudflare verified the From domain (the topmost `ARC-Authentication-Results`
  from `mx.cloudflare.net` shows a pass: services/email_in.py) **and** From is the person's own account email.
  Anything else to an ask address is dropped silently (a security event, no bounce), so trying addresses tells
  nobody anything. An unknown ask address gets a 404 (the email worker bounces it) like any unknown address.
- The answer goes by email to the person's **account email**, never to an address taken from the message, as
  "Re: <subject>" with In-Reply-To/References and Reply-To set to the ask address (so a reply asks again). By
  email there is no "On it." message: one answer per question. The subject or first line can be a command.
- The request is the subject plus the new text of the mail: quoted history ("On … wrote:", "> …") and the
  signature ("-- ") are cut off. Each mail is taken once (Message-ID).
- **Slack** events arrive at `POST /hooks/slack/events`, signed with the app's signing secret (5 minutes).
  `url_verification` is answered; Slack's retries (`X-Slack-Retry-Num`) are acknowledged and dropped; each
  event_id is taken once; the app's own posts, edits and channel chatter (not a mention) are ignored; the work
  runs after the 200 Slack needs within 3 seconds. A member who isn't linked gets one line on how to link. A
  member linked to several businesses in the same workspace starts with the business's name and a colon.
- Answers go back only while the ask address is still that person's, or the Slack member still linked to them.

### Owner set-up for Slack (once)

In the Kritvia Slack app's settings at api.slack.com/apps:

1. **Event Subscriptions** → on → Request URL `https://api.sitelytc.com/hooks/slack/events` (Slack checks it
   at once: the API answers the challenge).
2. **Subscribe to bot events:** `message.im` and `app_mention`.
3. **OAuth & Permissions → Bot Token Scopes:** add `im:history`, `app_mentions:read` (and keep `chat:write`).
4. **App Home → Messages Tab:** on, with "Allow users to send Slash commands and messages from the messages tab".
5. **Reinstall the app** to the workspace (Slack asks because the scopes changed). In Kritvia: Settings →
   Connectors → Slack → Add to Slack again if the old install doesn't pick up the new scopes.

Email needs nothing new: ask addresses use the same inbound domain and email worker as forwarding.

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

Code: `services/front_door.py`, `services/ask_anywhere.py` (email and Slack), `services/chat_approvals.py`
(`telegram_update`, `whatsapp_update`, cards), `routers/email_in.py` (ask addresses), `routers/chat_approvals.py`
(`/hooks/slack/events`),
`routers/chat_approvals.py` (`POST /ventures/{v}/approver-links/whatsapp`), `workflows/assistant.py`
(`_reply_back`). Migrations `0054_owner_front_door.sql`, `0076_ask_anywhere.sql`. Tests: `tests/test_front_door.py`,
`tests/test_ask_anywhere.py`.
