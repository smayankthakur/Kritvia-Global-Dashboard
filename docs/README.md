# Docs

* [architecture.md](architecture.md) — the approved plan (v1.0) with exit criteria mapped to tests
* [decisions.md](decisions.md) — as-built decisions (ADR log) and known limitations
* [runbook.md](runbook.md) — VM provisioning, configuration, first start, backups, deploys, incidents
* [agents/prospector.md](agents/prospector.md) — the outbound sales agent: how it finds and contacts businesses, and the rules it follows (Google Maps terms, WhatsApp, TRAI, DPDP)
* [agents/whatsapp.md](agents/whatsapp.md) — the WhatsApp front door: customer chats, drafts with the chat in mind, taking over, STOP and the 24-hour window
* [agents/telegram.md](agents/telegram.md) — the Telegram front door: connecting the business's bot, and how its chats differ from WhatsApp
* [agents/slack.md](agents/slack.md) — Slack for the team: a channel hears when a draft waits for a yes or a chat needs a person
* [agents/collections.md](agents/collections.md) — invoices and the Payment reminders agent: adding invoices (typed, from a photo/PDF, from Tally), recording payments and when reminders go out
