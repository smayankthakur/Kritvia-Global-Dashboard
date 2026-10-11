# Prospector (outbound sales agent)

Finds businesses on Google Maps that have no website, writes to each one, follows up, and stops the moment
they reply or say no. Built first for Sitelytc selling websites to Delhi restaurants. It's available on plans
where every agent is included (Growth, Scale, Enterprise, Internal). Code: `apps/api/kritvia_api/workflows/prospector.py`.

## What it does each day (at the time set on the Agents page, default 10:30 IST)

1. **Find.** Runs the owner's Google Maps searches (up to 5, separated by `;`) through the Places API.
   It keeps a place only if all of these hold:
   - it is open;
   - it has a phone number;
   - it has no website of its own (an Instagram, Swiggy or Zomato page counts as none, unless that option is off).
     With *Only businesses without their own website* off, places that have a website are kept too, and the
     first message is about the offer rather than about the missing website (for selling software or services);
   - it has at least the minimum number of reviews and meets the minimum rating;
   - it is not a chain or franchise (a known brand such as Domino's or Haldiram's, or a name found at two or
     more addresses in the day's results), unless *Skip chains and franchises* is off;
   - it is not somewhere to stay by Google's own place type (hotel, guest house, hostel…), unless *Skip hotels*
     is off. The name is not used, because in India a "Sharma Hotel" is usually a restaurant.

   It skips places already in Leads, and phone numbers that already belong to a lead or customer. Busiest places
   (most reviews) come first. It adds up to *New prospects a day* (server ceiling `PROSPECTOR_DAILY_CAP`, default 25).
2. **Queue.** Starts one *touch* run for every prospect whose next message is due.
3. **Touch.**
   - Looks the business up again by place ID, and the AI writes one message from those facts and the owner's
     offer.
   - In Hinglish (the default), the WhatsApp message is Hindi in Roman letters mixed with English. If the model
     answers in plain English, it is asked once more to rewrite it in Hinglish.
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
    writes and when a lead is opened. The Leads list makes no Google calls; it shows the search that found
    each prospect until the lead is opened.
  - Nothing from Google is written to the lead row, run state, run notes or approval titles.
  - Details are shown with "Business details: Google Maps" attribution and a link to the place.
  - Each lookup is billed by Google, to the organisation's own key (see below).
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

## Whose Google key pays

- Each organisation adds its **own Google Maps key** (Settings → AI models → Google Maps key). Lookups are
  billed by Google to that account; at the default settings (10 new prospects a day, 2 follow-ups) a business
  makes about 270 searches and 1,200 detail lookups a month, mostly inside Google's free monthly calls.
- Kritvia's server key (`GOOGLE_PLACES_API_KEY`) is used only for organisations on the **internal** plan.
- The key is tested with one ID-only search before it is saved, stored wrapped by the master key
  (`org_service_keys`, migration 0029), and never shown again. If Google later rejects it, the owner sees
  why on the AI models page and the Prospector pauses lookups until it is fixed.

## Set-up (owner)

1. In Google Cloud:
   - create a project with billing and enable **Places API (New)**;
   - create an API key restricted to the server's IP and to that one API;
   - set a daily quota cap so a mistake cannot run up a bill.
2. Paste the key in Settings → AI models → Google Maps key. (Internal organisations only: the server's
   `GOOGLE_PLACES_API_KEY` in `.env` works instead.)
3. Make sure the venture's Gmail is connected (Settings → Connectors) so emails go out from it.
4. Agents page → Prospector:
   - add searches (e.g. `restaurants in Nangloi, Delhi; dhaba in Laxmi Nagar, Delhi`);
   - write the offer line;
   - pick the daily time and save;
   - press **Find leads now** to try it.
5. Each day, open **Leads**. The banner shows how many WhatsApp messages are ready. Send them, tap "I sent it",
   and log calls.
