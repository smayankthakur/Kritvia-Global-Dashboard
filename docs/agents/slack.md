# Slack for the team

A business can connect one Slack channel. Kritvia posts there:

- when a draft waits for a yes (every approval, from any agent);
- whenever the team gets a push notification: a customer chat that needs a person, a new message in
  a chat the team took over, or a WhatsApp template that was approved, rejected or paused.

Each post has an **Open in Kritvia** button. Posts say who needs attention, never what a customer wrote.

Code:

- `services/slack.py`;
- `push.also_slack`, called by `push.notify_venture`, and by the runner when it opens an approval;
- `POST /ventures/{v}/connectors/slack`.

Migration `0039_slack.sql`.

## Connecting

1. In Slack, add the **Incoming Webhooks** app to the channel the team watches.
2. Copy its Webhook URL into Settings → Connectors → Slack. A channel name to show there is optional.

Only admins can connect Slack, and only `https://hooks.slack.com/services/…` addresses are accepted.
Kritvia posts a hello to check the address works before saving it. The address is a secret, so it is
stored encrypted and never shown again.

## When Slack fails

- Kritvia posts in the background and never follows a redirect.
- A slow or failing Slack never holds up a run or a webhook.
- If Slack says the address no longer works (the webhook was removed or the channel archived), the
  connector shows that as its last error. Connect a new address to fix it.

## Not built yet

Approving from inside Slack (that needs a Slack app with interactivity), and daily summaries.
