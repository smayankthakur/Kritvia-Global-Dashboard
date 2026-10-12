# Telegram front door

Customers chat with the business's own Telegram bot, and the chats sit next to WhatsApp on the
**Chats** page. Everything works as in the [WhatsApp front door](whatsapp.md):

- every message is kept per customer;
- the Inbox assistant drafts each reply with the whole chat in mind and sends it only after a yes;
- enquiries become leads, with source `telegram`;
- the team can take a chat over, or a customer can ask for a person;
- `/stop` (or STOP) opts the customer out.

Code: `services/telegram.py`, the `telegram_*` routes in `routers/connectors.py`, `telegram.send` in
`tools.py`. The chats share `wa_contacts` and `wa_messages` with WhatsApp (`channel = 'telegram'`;
`phone` holds the Telegram chat id). Migration `0038_telegram.sql`.

## Connecting a bot

1. In Telegram, the owner opens @BotFather, sends `/newbot`, and picks a name and a username ending
   in "bot".
2. In Settings → Connectors → Telegram bot, the owner pastes the token BotFather gives. Only the
   business's admins can do this.

Kritvia then:

- checks the token with Telegram (`getMe`);
- stores the token encrypted (it is never shown again);
- points the bot's webhook at `PUBLIC_API_URL/hooks/telegram/<connector id>` with a random secret.

Telegram sends that secret with every update. Kritvia keeps only its SHA-256, and an update without
the right secret is refused (401).

- **HTTPS required.** Telegram only accepts an HTTPS webhook address, so `PUBLIC_API_URL` must be HTTPS.
- **One business per bot.** A bot can belong to only one business.
- **Disconnecting.** Kritvia also removes the bot's webhook.

The Chats page and the connector card both show the bot's `t.me/<username>` link. Share it on the
website, visiting cards and the Google Business profile.

## How it differs from WhatsApp

- **No 24-hour window and no templates.** A bot can answer a customer at any time.
- **Never first.** A bot can't write to someone who hasn't written to it, so there is no "New chat"
  for Telegram, and the follow-up and payment-reminder agents stay WhatsApp and email only.
- **No phone number.** Telegram doesn't share the customer's number, so a Telegram lead has no
  phone. Chats show the customer's name and @username.
- **`/start` is a hello.** Every Telegram chat begins with `/start`. It is kept in the chat (shown
  as "Opened the chat with your bot") and answered like a greeting.
- **Private chats only.** Groups, channels, edited messages and other bots are ignored.
- **Photos, voice notes and files** are noted in the chat as `[photo]`, `[voice message]` and so on,
  with any caption. Their content isn't read yet.
- **Blocked bot.** If the customer blocked the bot, a reply fails with that reason and stays in the
  chat marked as not delivered.

## Plans

Telegram is part of the Standard plan and above, like WhatsApp.
