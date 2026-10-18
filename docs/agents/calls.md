# AI phone calls

**Calls** (next to Browser). Kritvia answers the business's own phone number, and phones customers back
after a yes. Growth, Scale and Enterprise.

## Answering the business's number

1. An admin connects the business's **Twilio** number (Account SID, auth token, the number). Kritvia checks
   them with Twilio, stores the token encrypted, and points the number's voice and status webhooks at
   `/hooks/voice/twilio/<connector>/incoming` and `/status`.
2. Switch **answering** on, pick Hindi/Hinglish or Indian English and a voice (Amazon Polly Aditi, Kajal or
   Raveena, spoken by Twilio), a greeting, opening days and hours, a number to put callers through to, and the
   longest call (2–20 minutes, default 8).
3. A call goes turn by turn: Twilio says Kritvia's words and listens with its own speech recognition (or a key:
   **0** asks for a person), and posts what the caller said; Kritvia answers with the next words. No audio passes
   through Kritvia. Every request is checked with Twilio's signature (HMAC-SHA1 with the business's own token).

What the assistant on the phone does:

| Caller wants | Kritvia |
|---|---|
| A question | answers from the business's details and its memory (top 3 notes for what was said); if it doesn't know, it offers a callback |
| To leave a message | takes name and what they need, reads it back → a **task** "Call back …" |
| A booking or appointment | takes the service and the day and time → a **task** "Booking request …" (never confirms a slot itself) |
| A person | in opening hours, with a put-through number: rings it for 25 s; nobody picks up → it offers to take a message |
| "Don't call me" | says sorry and goodbye; the number goes on the business's **do-not-call list** |
| Card numbers, OTPs, bank details, payments | never asks for or takes them |

The greeting always says it is the business's AI assistant (a custom greeting without the words gets that
sentence in front). Limits: 24 replies, the longest call, two silences in a row.

When the call ends (Twilio's status webhook): a short summary for the owner, a **lead** for a new caller
(source `phone`), the tasks above, and a push "A caller left a message" with the number masked (no call content).
The Calls page lists every call with its summary and what was said.

## Test calls (no phone needed)

**Try a call**: you play the caller (type, or speak with the voice button); Kritvia answers exactly as on the
phone and can read its replies aloud in the browser. Test calls make no leads, tasks or pushes.

## Phoning customers

**Phone a customer** (or ask the assistant: "call Priya about tomorrow's 4 pm appointment", tool `voice.call`).
Every call is an approval showing who, why and the exact opening line ("Hello Priya! This is Sharma Sweets's
AI assistant, calling about …"); the number can't be changed, and a person always reviews it.

Rules (enforced when the call is placed, not only by the model):

- Only for people the business already deals with, for service (a reminder, a callback they asked for), never
  promotion.
- 9 am to 9 pm in the business's time zone; at most one Kritvia call a day to a number; never a number on the
  do-not-call list.
- **Outbound calling is off** until an admin records the business's TRAI **DLT** registration (Principal Entity
  ID) and its caller id type (a 160-series service number or a registered landline) and confirms the rules.
  Until then an approved call is a **test call**: nothing is dialled and it shows in the list to answer in the
  app.

## Pieces

- Migration 0057: `phone_settings`, `calls` (number encrypted plus a per-business hash, conversation and summary
  encrypted), `voice_dnd`, connectors provider `twilio_voice` (number = `external_id`, account SID in `meta`, token
  in `connector_tokens`), `private.voice_principal`.
- `services/twilio_voice.py` (signatures, TwiML, REST), `services/voice_calls.py` (the call: greeting, turns,
  finish, place), `workflows/voice_call.py` (approval → dial), tool `voice.call`, `routers/calls.py`.
- Web: `app/(app)/v/[ventureId]/calls/page.tsx`, `components/calls/calls.tsx`, `components/calls/speech.tsx`; the
  approval card shows calls.
- Patch 0081: migration 0058 (`exotel_voice`, `voice_keys`, speech settings, `private.exotel_principal`),
  `services/voice_media.py` (mu-law, resampling, WAV, turn detection), `services/voice_speech.py` (BYOK STT/TTS),
  `services/voice_stream.py` (live calls over media streams), `services/exotel.py`, WebSockets
  `/hooks/voice/stream/exotel/<id>` and `/hooks/voice/stream/twilio/<id>`, `/hooks/voice/exotel/<id>/status`.

## Calls within India: Exotel (patch 0081)

Twilio can't carry calls within India (its India guidelines: domestic calling isn't supported, and calls to
India must come from non-Indian numbers). Indian businesses use an **Exotel** number (ExoPhone) instead:

- **Connect:** Calls → Phone settings → Indian number: API key, API token (checked with Exotel, stored
  encrypted), account SID, the ExoPhone and the region (India `api.in.exotel.com`, or Singapore). Kritvia shows a
  **Voicebot link** once (`wss://…/hooks/voice/stream/exotel/<id>?k=<secret>&sample-rate=16000`); only its hash is
  kept, and "New Voicebot link" replaces it.
- **Exotel flow** (App Bazaar): Voicebot applet (paste the link, bidirectional) → Hangup applet; set the ExoPhone's
  flow to it.
- **On a call** Kritvia listens and speaks itself (services/voice_stream.py): the caller's audio arrives as 16-bit PCM
  (8 or 16 kHz, or mu-law, read from the start message), a turn ends after 0.7 s of quiet, speech-to-text, the same
  call brain as before, text-to-speech, audio back in chunks of 3,200+ bytes in multiples of 320, a "mark" to know
  when it finished playing, "clear" when the caller talks over it (barge-in), 8 s of silence counts as a silence.
  Putting callers through isn't offered on Exotel yet (it takes a message instead).
- **Outbound** (after a yes, same rules): `POST /v1/Accounts/<sid>/Calls/connect` with `StreamUrl` (a link signed for
  that one call) and `StreamType=bidirectional`; the status callback (signed too) records busy, no answer or failed.
  When both are connected, an Exotel number is used first.

## Voice and speech, with your own keys (BYOK)

Calls → Phone settings → Voice and speech. Used on Exotel, and on Twilio when its mode is "Kritvia's voice" (Media
Streams: `<Connect><Stream>` with the call's signed parameters; Twilio's own Polly voices remain the default and the
fallback when no voice is set up).

| | Speech-to-text | Voice |
|---|---|---|
| Kritvia's (`platform`) | Groq Whisper, then the server's own Whisper; never a provider whose terms allow training | the speech server on Kritvia's machine |
| Your Sarvam key | saaras/saarika (Indian languages) | Bulbul (`anushka` by default; any Bulbul speaker) |
| Your OpenAI key, or any OpenAI-compatible server (e.g. Groq) | `gpt-4o-mini-transcribe` by default | `gpt-4o-mini-tts`, voice `marin` |
| Your Deepgram key | nova-3, `language=multi` for Hindi-English | — |
| Your ElevenLabs key | — | `eleven_flash_v2_5`, any voice id |
| Speech server on Kritvia's machine (`local`) | faster-whisper (speaches) | Kokoro / Piper (speaches), `hf_alpha` Hindi voice by default |

Keys are stored encrypted (`voice_keys`) and never shown again; an OpenAI-compatible server must be a public
https address. "Hear it" plays the chosen voice. Only the text of what was said is kept, never audio. The LLM that
decides what to say follows the organisation's AI models page (its own keys there too).

## Kritvia's own speech system (works anywhere)

The speech server runs on Kritvia's server (compose profile `speech`, service `whisper` = speaches: faster-whisper
for hearing and Kokoro/Piper for speaking, OpenAI-compatible). With it, calls in India (Exotel) and anywhere else
(Twilio Media Streams) need no outside speech provider at all. Runbook: "Local speech for phone calls".

## Owner steps before real calls

**Calls within India (Exotel)**
1. Sign up at exotel.com with Sitelytc's KYC (company PAN, GST certificate, certificate of incorporation, address
   proof, an authorised signatory's ID); buy an ExoPhone (a landline-style virtual number) and a plan with the
   Voicebot / AgentStream applet enabled (ask Exotel sales to switch it on).
2. Developer settings → API key and token; account SID. Enter them on the Calls page yourself (Kritvia never sees
   or types them for you).
3. Build the flow (Voicebot → Hangup) with the link Kritvia shows, and assign it to the ExoPhone.
4. Choose the voice (your Sarvam key is the best fit for Hindi; or the local speech server), "Hear it", switch
   answering on, then call the number.

**Calling customers (TRAI)**
5. Register Sitelytc as a Principal Entity on a DLT portal (Jio, Airtel, Vi or BSNL; GST certificate, PAN and
   business registration documents; approval usually takes a few working days). Keep the Entity ID.
6. Use a registered caller id for service calls. Banks, insurers, stockbrokers and other RBI/SEBI/IRDAI/PFRDA
   entities must use the 1600/160 series; for other businesses, ask Exotel which registered number to use. Never
   promotional calls from Kritvia (those need the 140 series, DND scrubbing and opt-in consent).
7. Calls → Calling customers: enter the Entity ID, the caller-id type, confirm, switch on.

**Numbers outside India (Twilio)**
8. A Twilio account with a number in that country; enter the Account SID and auth token on the Calls page. Twilio's
   Polly voices work at once; "Kritvia's voice" uses the settings above.

## Credits

The call design (greeting with disclosure, message taking that is saved before the caller is told, put-through
with a fallback, silence and length limits, one summary when the call ends) was informed by studying
[AIReceptionist](https://github.com/kirklandsig/AIReceptionist). That project is AGPL-3.0, so none of its code or
prompts are used here; Kritvia's implementation is its own, on Twilio's turn-by-turn webhooks instead of LiveKit and
a speech-to-speech model.
