# Prospector (outbound sales agent)

Finds businesses on Google Maps that have no website, writes to each one, follows up, and stops the moment
they reply or say no. Built first for Sitelytc selling websites to Delhi restaurants. It's available on plans
where every agent is included (Growth, Scale, Enterprise, Internal). Code: `apps/api/kritvia_api/workflows/prospector.py`.

## What it does each day (at the time set on the Agents page, default 10:30 IST)

1. **Find.** Runs the owner's Google Maps searches (up to 5, separated by `;`) through the Places API.
   It keeps a place only if all of these hold:
   - it is open;
   - it has a phone number;
   - it has no website of its own (an Instagram, Swiggy or Zomato page counts as none, unless that option is off);
   - it has at least the minimum number of reviews and meets the minimum rating.

   It skips places already in Leads, and phone numbers that already belong to a lead or customer. Busiest places
   (most reviews) come first. It adds up to *New prospects a day* (server ceiling `PROSPECTOR_DAILY_CAP`, default 25).
2. **Queue.** Starts one *touch* run for every prospect whose next message is due.
3. **Touch.**
   - Looks the business up again by place ID, and the AI writes one message from those facts and the owner's
     offer.
   - **Email** (when the lead has an email address) goes from the venture's Gmail. It goes out without asking
     when *Send emails and answer replies without asking me* is on.
   - **WhatsApp:** the message waits on the lead for the owner to send with one tap ("Open in WhatsApp" → send →
     "I sent it").
   - First message, then up to *Follow-ups* more, *Days between messages* apart. The last one says it is the last.

## Replies and opt-outs

- An email reply is matched to the prospect by Gmail thread or email address. The match happens in the
  Inbox assistant, or in the Gmail poller when the Inbox assistant is off.
- A matched reply:
  - stops the follow-ups;
  - marks the lead *replied*;
  - is answered by the Inbox assistant as the Prospector, within the same trust.
- If the lead-triage agent is on, an enquiry goes on to it pinned to the same lead.
- WhatsApp replies arrive on the owner's own phone, because that's where the first message came from. The owner
  taps **They replied** on the lead and can save the name and number the business gave them. It is then an
  ordinary lead.
- "STOP", "not interested", "mat bhejo", "nahi chahiye" and similar replies opt the business out for good. They get
  no answer, the lead becomes *lost*, and the agent never contacts them again. The owner can also tap **They
  asked us to stop**.
- Every message carries an opt-out line. Emails also carry the business's privacy-notice link when that is turned
  on.

## Guardrails

- **Prices:** the AI may quote only prices that appear in the *offer* line. A message or reply containing any
  other amount always waits for a person, even with "send without asking" on.
- **Unsure replies:** a reply the AI is not sure about always waits for a person.
- **"Send without asking":**
  - It grants the Prospector's own trust for `gmail.send` and `whatsapp.send` through
    `set_prospector_autonomy` (venture admins only, audited by `agent_trust`'s trigger).
  - It works only on plans where agents may act alone.
  - It does not touch any other agent's trust. Turning the agent off withdraws it.
  - The database's own check on auto-approvals (`guard_approval_insert`) is unchanged. Sensitive drafts and
    drafts the run flagged for prompt injection still wait for a person.
- **Calls:** the agent does not place calls. The lead shows the number with a call button, and the owner logs the
  call.

## Rules this design follows

- **Google Maps Platform terms.**
  - Only the **place ID** is stored. Name, phone, address, rating and website are fetched live when the agent
    writes, when a lead is opened (full details), and when the Leads list loads (name only, at most 60 per
    load).
  - Nothing from Google is written to the lead row, run state, run notes or approval titles.
  - Details are shown with "Business details: Google Maps" attribution and a link to the place.
  - Each lookup is billed by Google, so the list asks only for names.
- **WhatsApp Business Platform policy.** Businesses may message someone first only with their opt-in and an
  approved template. So the first WhatsApp always goes from the owner's own phone, one-to-one. The agent never
  sends cold WhatsApp messages through the API.
- **TRAI (commercial calls).**
  - Automated or AI sales calls from ordinary 10-digit numbers count as unregistered telemarketing; the penalty
    is disconnection and blacklisting.
  - AI calling needs a registered provider: DLT registration, 140/1600-series numbers, and consent and DND
    checks. Owner decision: build this later.
- **DPDP Act.**
  - The customer privacy notice has a *Prospector* entry: public business details from Google Maps, used to
    offer services once, follow up a few times, and stop on request.
  - A sole proprietor's phone number is personal data. Not storing it, plus the permanent opt-out, keeps
    processing minimal.

## Set-up (owner)

1. In Google Cloud:
   - create a project with billing and enable **Places API (New)**;
   - create an API key restricted to the server's IP and to that one API;
   - set a daily quota cap so a mistake cannot run up a bill.
2. On the server, add `GOOGLE_PLACES_API_KEY=…` to `.env` and restart the API and worker.
3. Make sure the venture's Gmail is connected (Settings → Connectors) so emails go out from it.
4. Agents page → Prospector:
   - add searches (e.g. `restaurants in Nangloi, Delhi; dhaba in Laxmi Nagar, Delhi`);
   - write the offer line;
   - pick the daily time and save;
   - press **Find leads now** to try it.
5. Each day, open **Leads**. The banner shows how many WhatsApp messages are ready. Send them, tap "I sent it",
   and log calls.
