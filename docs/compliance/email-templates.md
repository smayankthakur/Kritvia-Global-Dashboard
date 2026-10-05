# System email rules and template

Two kinds of system email (sent from our domain through Amazon SES, `services/mailer.py`):

| Kind | Examples | Unsubscribe? | How to send |
| --- | --- | --- | --- |
| Transactional | Sign-in codes, security notices, invitations, receipts, replies to a request | No (people need them) | `get_mailer().send(to, subject, body)` |
| Product | Weekly summaries, tips, announcements, anything promotional | **Yes, always** | `send_product_email(conn, user_id, to, subject, body)` in `routers/privacy.py` |

`send_product_email` skips anyone who opted out or deleted their account, adds a visible unsubscribe
link, and sets the `List-Unsubscribe` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` headers
(RFC 2369, RFC 8058) that Gmail and Yahoo require from bulk senders. The link is signed (HMAC with the
server secret), works without signing in, and can be undone. Every system email ends with who sent it:
legal name, CIN, address and support email (`email_footer()`).

Agent emails a business sends to its own customers go through the business's Gmail after approval;
for marketing-style campaigns the business must include its own opt-out (Terms 9, acceptable use).

## Template: product email

```text
Subject: Your Kritvia week: 12 drafts approved, 3 waiting

Hi {first_name},

This week Kritvia drafted 15 replies for {business}. You approved 12; 3 are waiting for you:
{app_url}/inbox

What's new: task boards — drag cards between lists and boards.

— The Kritvia team

--
Kritvia by Sitelytc Digital Media Private Limited (CIN U63121DL2025PTC453508)
{registered office address}
Questions: support@sitelytc.com
Don't want these emails? Unsubscribe in one click: {unsubscribe_url}
```

Rules: a subject that matches the content (no "Re:" or "Fwd:" tricks, no false urgency); the sender is
clearly Kritvia; no tracking pixels or link-tracking redirects; send only to people who have an account
and haven't opted out.
