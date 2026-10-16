# Approve from your phone (Telegram and Slack)

Drafts that wait for a yes can reach each team member in Telegram or Slack, as a card with
**Approve**, **Reject** and **Ask for changes** (plus **Open in Kritvia**).

- A press decides **as that person**. It goes through the same `decide_approval()` path as the app,
  with the same role checks, so linking never gives anyone more rights.
- Cards go only to linked people who could decide that draft in the app.
- **Sensitive** drafts arrive without a preview or buttons and are reviewed in the app.
- **Ask for changes** rejects the draft with the person's note, so the agent redrafts it.
  - In Telegram, the next message in the chat is the note.
  - In Slack, a short form opens.
- Once a draft is decided anywhere (app, Telegram or Slack), every card about it is edited to say
  so (for example "Approved by Asha") and loses its buttons.

Code:

- `services/chat_approvals.py`: cards, button handling, settle.
- `routers/chat_approvals.py`: linking, Add to Slack, the Slack interaction hook.
- `telegram_inbound` hands team members' updates to `chat_approvals.telegram_update` before
  anything becomes a customer chat.
- The runner calls `chat_approvals.announce` when it opens an approval.
- `approvals.decide` calls `chat_approvals.settle_later`.

Migration: `0040_chat_approvals.sql`, with:

- `approver_links`;
- `approval_notes`;
- one-time link codes, stored hashed, valid 15 minutes.

## Telegram

This needs the business's Telegram bot (Settings → Connectors). Each person then does this:

1. Go to **Your account → Approve from your phone → Link Telegram**.
2. Kritvia shows a one-time `t.me/<bot>?start=link_…` link. Open it on the phone that has Telegram
   and tap **Start**.
3. The bot answers "Linked".

A code works once. If it is opened in someone else's chat, that chat is linked to the person who asked
for the code, so don't share it.

A linked person's messages to the bot are never treated as customer chats. Unlink from the same
card. An admin can also remove anyone's link.

The bot's webhook now also receives `callback_query` (button presses). New bots get this when they
are connected. A bot connected before this release is re-pointed automatically, with a fresh webhook
secret, the first time anyone asks for a Telegram link (`ensure_buttons`).

## Slack

This needs Kritvia's Slack app, set up once per server:

1. At api.slack.com/apps, choose **Create New App → From a manifest** and paste
   `infra/slack/manifest.yml`. Change the two addresses if Kritvia isn't at app/api.sitelytc.com.
2. Under **Basic Information**, copy these into the server's `.env`:
   - `SLACK_CLIENT_ID`
   - `SLACK_CLIENT_SECRET`
   - `SLACK_SIGNING_SECRET`
   - `SLACK_REDIRECT_URI` is optional: when empty it is `PUBLIC_WEB_URL` + `/api/oauth/slack/callback`.
3. Turn on **Manage Distribution**, so other businesses' workspaces can add it.
4. Restart the API.

Then, for each business:

1. An admin opens **Settings → Connectors → Slack → Add to Slack**, picks a channel and allows.
   - The channel gets the notices.
   - The admin's own Slack account is linked at once.
2. Each other team member goes to **Your account → Link Slack**. Kritvia DMs the Slack member who has
   that person's Kritvia email a **Link** button. Pressing it links them, so an email match alone
   never links anyone.

Slack signs every button press and form. Requests that are unsigned, wrongly signed, or older than
five minutes are refused (`/hooks/slack/interact`). Presses from a different workspace than the
business's are ignored.

The pasted incoming-webhook mode still works for notices only.
