/**
 * Privacy Policy, version 2026-10-04. Master copy: the Claude Doc "Kritvia — Terms of Service and
 * Privacy Policy" (tab Privacy Policy). Every factual statement here was checked against the code;
 * if routing, retention or providers change (infra/litellm/tiers.yaml, migrations, worker purges),
 * change this text too and bump terms_version in the API settings.
 */
export const PRIVACY_UPDATED = "4 October 2026";

export const PRIVACY_MD = `## 1. Who we are and what this policy covers

Sitelytc Digital Media Private Limited, New Delhi, India (**Sitelytc**, **we**) provides Kritvia, a business operating system that stores a business's records and runs AI agents that draft work for the business to approve. This policy explains how we handle personal data in connection with Kritvia, its website app.sitelytc.com, its desktop and installable apps, and our support channels.

We handle personal data in two different roles:

| | Account Data | Customer Data |
| --- | --- | --- |
| Whose data | People who use Kritvia: owners, staff, invited members | People whose details a business puts into Kritvia: its customers, leads, loan applicants, suppliers, meeting participants |
| Our role under the DPDP Act | **Data Fiduciary**: we decide why and how it is processed | **Data Processor**: the business (our customer) decides, and we act on its instructions |
| Whom to contact | Us | The business that holds your data first; we will help it respond |

This policy fully governs Account Data. For Customer Data it describes what we do as processor; the business that uses Kritvia is responsible for giving you its own notice and handling your rights. Our [Terms of Service](/terms) set out our processing commitments to businesses.

This policy is published under the Digital Personal Data Protection Act, 2023 and the Digital Personal Data Protection Rules, 2025 (together, the **DPDP Act**), and under section 43A of the Information Technology Act, 2000 and the Information Technology (Reasonable Security Practices and Procedures and Sensitive Personal Data or Information) Rules, 2011 for as long as those continue to apply.

## 2. What we collect, and why

**Account Data (we are the Data Fiduciary).** We collect only what we need for the purposes below. Where we rely on consent, you give it when you sign up and can withdraw it at any time (section 6); withdrawing consent needed to run your account means closing it.

| What | Where it comes from | Why we use it | Basis |
| --- | --- | --- | --- |
| Name, email address, password (stored only as an Argon2 hash), organisation and role | You, at sign-up or when invited; Google, if you sign in with Google (name and email) | To create and run your account and sign you in | Consent; data you provided for this purpose (DPDP Act s.7(a)) |
| Sign-in and security records: time, IP address, device and browser, session tokens, one-time codes | Your use of Kritvia | To keep accounts secure, detect misuse, and investigate incidents | Data you provided for this purpose; legal duties to keep security logs |
| Billing details: legal name, GSTIN, billing address, billing contact, plan, payment status and invoices | You; Razorpay (payment status only) | To bill you and issue GST tax invoices | Data you provided for this purpose; compliance with tax law |
| Support messages and contact-form details | You | To answer you and improve help content | Data you provided for this purpose |
| Usage metadata: features used, agent runs, AI-model usage counts and costs, error records | Your use of Kritvia | To operate, secure and bill the service, enforce plan limits, and fix faults | Data you provided for this purpose |
| Voice dictation: audio while you dictate | You, when you use dictation | To turn speech into text | Consent (you start each dictation) |
| Notification subscription: the browser push address and keys | Your browser, when you switch on notifications | To alert you when a draft needs approval | Consent (you can switch it off) |

We do not keep dictation audio. We keep the length, language and word count of each dictation; the text is kept only where you save it as a note. The Kritvia desktop app's auto-learn feature, if you switch it on, briefly holds your keystrokes in memory for up to 8 seconds after you paste dictated text, only to learn your corrections; it does not store or send those keystrokes.

**Customer Data (we are a Data Processor).** Businesses using Kritvia put in or connect data that may include personal data of their own customers and contacts: emails and attachments, WhatsApp messages, calendar events, Drive files, uploaded documents (including loan papers and identity documents), meeting recordings and transcripts, leads, proposals and accounting entries. We process this only to provide Kritvia to that business: to store and search it, extract facts, and run the agents it switches on. We do not use it for our own purposes, sell it, use it for advertising, or use it to train AI models.

## 3. How AI is used

Kritvia uses AI models to read Customer Data and draft replies, summaries, proposals and extracted fields. Five rules govern this:

1. **Sensitive records stay on our servers.** A document or message marked sensitive, kept in a role-restricted area, uploaded as a loan document, or in which we detect an Aadhaar, PAN, passport, bank-account or card number, is processed only by AI models running on our own servers in India. Search indexes (embeddings) and text recognition (OCR) always run on our own servers.
2. **By default, only models that do not train.** Other tasks go to the free hosted AI providers in section 4 whose terms do not let them use the content to train their models (they keep it, if at all, only briefly for abuse monitoring). A business's owner may also switch on free models whose providers may learn from the content they receive (Google Gemini free tier, OpenRouter free models, Mistral free tier). We never use those for sensitive records, or for a business that has connected Google Workspace. The business's privacy notice to its customers then says so.
3. **A business may use its own AI provider.** If a business adds its own key for a provider such as OpenAI, Anthropic or Google, its ordinary tasks go to that provider under the business's own agreement with it. Sensitive records still stay on our servers.
4. **A person approves before anything is sent.** Drafts wait for a person's approval before they leave Kritvia, unless the business has expressly allowed a specific agent to act on its own.
5. **No automated decisions about you.** Kritvia does not make decisions with legal or similarly significant effects about individuals; the business makes them, and outputs are suggestions only.

**Google user data.** If a business connects Google, Kritvia accesses Gmail (to read incoming mail and send replies the business approves), Google Calendar (to create events) and Google Drive (to import files the business chooses). Kritvia's use and transfer to any other app of information received from Google APIs will adhere to the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including the Limited Use requirements. The use of information received from Google Workspace APIs will adhere to the Google User Data Policy, including the Limited Use requirements. In particular:

- we use Google user data only to provide the features the business switches on, which are visible in Kritvia;
- we transfer it to others only as needed to provide those features (for example, to an AI provider in section 4 that does not train on it, to draft a reply), for security, or to comply with law, and never to an AI model whose provider may train on it;
- we do not use it for advertising, sell it, or use it to train generalised AI or machine-learning models;
- our staff do not read it unless the business asks for support with specific items, it is needed to investigate security or abuse, or the law requires it.

You can remove Kritvia's access at any time at [myaccount.google.com/permissions](https://myaccount.google.com/permissions) or in Kritvia's settings.

## 4. Who we share data with

We share personal data only with the service providers below, who process it on our instructions under contracts that require them to protect it, and only to the extent each needs. We do not sell personal data.

| Provider | What they do for Kritvia | Data they receive | Where |
| --- | --- | --- | --- |
| Amazon Web Services | Hosting, database, encrypted backups, sending sign-in codes and support email (Amazon SES), system alerts | All data stored in Kritvia (encrypted backups cannot be read by AWS) | India (Mumbai) |
| Cloudflare | Secure network connection between your browser and our servers; Workers AI models for drafting (not used for training) | All traffic, encrypted in transit; text of specific tasks, never sensitive records | Global network; nearest location to you |
| Groq | Hosted AI models for drafting and extraction; meeting and dictation transcription | Text or audio of the specific task, never sensitive records; not used for training | United States |
| Cerebras | Hosted AI models for drafting and extraction | Text of the specific task, never sensitive records; not retained | United States |
| Only if a business opts in: Google (Gemini free tier), OpenRouter free models, Mistral | Extra free AI capacity | Text of the specific task, never sensitive records and never Google Workspace data; may be used to improve the provider's models | United States, European Union and other provider locations |
| The AI provider a business connects with its own key | Drafting for that business | Text of the specific task, never sensitive records; under the business's agreement with that provider | Where that provider operates |
| Razorpay | Subscription payments | Billing name, GSTIN, email, plan; you enter card or UPI details directly with Razorpay | India |
| Browser push services (Google, Apple, Mozilla, Microsoft) | Delivering notifications you switched on | An encrypted notification with the draft's title | Global |

**Services a business connects.** When a business connects Google Workspace or the WhatsApp Business Platform (Meta), Kritvia reads from and sends through the business's own account with that provider. That provider handles the data under its agreement with the business.

**Other disclosures.** We may disclose personal data (a) where the law, a court order or a government agency with lawful authority requires it, after checking the request is valid and disclosing no more than required; (b) to protect the security of Kritvia, our customers or the public; or (c) to a buyer or successor if our business is reorganised or sold, who must honour this policy.

**Transfers outside India.** Data is stored in India. The AI providers and push services above may process the text of individual tasks outside India, as shown. The DPDP Act permits this except to countries the Government of India restricts; we will stop any transfer to a restricted country. We will update this list, and notify business customers at least 15 days ahead, before adding a provider.

## 5. How long we keep data, and how we protect it

We keep personal data only as long as the purpose needs it or the law requires, then delete it or make it anonymous.

| Data | How long |
| --- | --- |
| Account Data | While your account exists. When you delete your account, your name and email are removed at once, your sessions end, and your memberships, voice settings and notification subscriptions are deleted. |
| Customer Data | Until the business deletes it, or for any shorter period the business sets for a type of document. When a business closes its organisation, all its Customer Data is deleted 30 days later. |
| Encrypted backups | Up to 30 days, for disaster recovery only. |
| Security and system logs | One year, then deleted, as Indian cyber-security rules require. |
| Sign-in codes | One day. |
| Support messages | Two years. |
| Tax invoices and billing records | Eight years, as tax and company law require. |
| Audit log of actions in a workspace | For the life of the organisation and as a tamper-evident legal record after it. It records who did what and when, by internal ID, and never the content of documents. |

**Security.** We protect personal data with reasonable security safeguards, including:

- encryption of all traffic in transit, and AES-256 encryption at rest of documents, messages, recordings, drafts and connection tokens, with a separate key for each business;
- database-level isolation so that one organisation can never read another's data;
- passwords stored only as Argon2 hashes; short-lived sessions, revoked when you change your password; limits on repeated sign-in attempts;
- role-based access within each organisation, and a tamper-evident audit log;
- nightly backups encrypted with a key kept offline, tested by restoring them;
- monitoring every five minutes with alerts to our team; and
- access by our staff only where needed, under confidentiality duties.

More detail is on our [Security page](/security). No system is perfectly secure, and you help by keeping your sign-in details private.

**If there is a breach.** If a personal data breach affects you, we will tell you without delay through your account or email: what happened, the likely consequences for you, what we are doing about it, the steps you can take, and whom to contact. We will report it to the Data Protection Board of India, with a full report within 72 hours of becoming aware of it, and to CERT-In within 6 hours where the law requires. Where the breach affects Customer Data, we will tell the business within 24 hours so it can inform you.

## 6. Your rights

Under the DPDP Act you have the right to:

- **access** a summary of the personal data we process about you and how, and the providers we share it with;
- **correct, complete or update** it;
- **erase** it, unless the law requires us to keep it;
- **withdraw consent** at any time, as easily as you gave it (this does not affect processing already done);
- **nominate** someone to exercise your rights if you die or become unable to; and
- **have a grievance resolved**, and then complain to the Data Protection Board of India if you are not satisfied.

**How to use them.** In Kritvia, go to **Your account** to download your data or delete your account. For anything else, email support@sitelytc.com with "Privacy" in the subject, from the address on your account, or write to the grievance officer below. We may ask you to confirm your identity. We acknowledge requests within 2 business days and respond within 30 days, and in any case within the 90 days the law allows.

**If a business holds your data in Kritvia** (for example you are its customer or a loan applicant), please contact that business: it decides how your data is used. If you write to us, we will pass your request to the business and help it respond.

**Grievance officer.** Mayank Thakur, Grievance Officer, Sitelytc Digital Media Private Limited, New Delhi, India. Email: support@sitelytc.com with "Grievance" in the subject. If you are not satisfied with our answer, you may complain to the Data Protection Board of India through the digital platform the Board provides.

## 7. Children

Kritvia is for businesses and is not meant for anyone under 18. We do not knowingly collect children's personal data for our own purposes. Businesses that put children's data into Kritvia must obtain verifiable consent from a parent or lawful guardian as the DPDP Act requires.

## 8. Cookies and similar technology

We use only cookies and browser storage that Kritvia needs to work. We use no advertising or analytics cookies and no third-party trackers.

| Name | Purpose | Lasts |
| --- | --- | --- |
| kv_at, kv_rt | Keep you signed in securely (cannot be read by page scripts) | 60 minutes; 30 days |
| kv_oauth, kv_signin | Protect Google sign-in and connection steps | 10 minutes |
| kv_theme, kv_org, kv_venture | Remember your theme and the organisation and business you last used | 1 year |
| Local and session storage (kv_voice_*, kv_terms_intent) | Remember voice settings on this device; carry your acceptance of these terms from the sign-up page | Until you clear it; until the tab closes |

The installable app also stores the app's layout on your device so it opens quickly; it never stores your business data there.

## 9. Changes to this policy

We will update this policy when our practices or the law change, and change the date at the top. For a material change we will tell you by email or in the app at least 15 days before it takes effect. Where a change needs your consent, we will ask for it.
`;
