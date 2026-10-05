# Data inventory and minimisation

Rule: collect a field only if a feature the person can see needs it, keep it only as long as the
Privacy Policy's retention table says, and never ask "just in case". Re-check this table whenever a
form or table gains a column.

## What each form collects (5 October 2026)

| Form / flow | Fields | Needed for | Required? | Verdict |
| --- | --- | --- | --- | --- |
| Sign up (`/register`) | Email; name (email-code path); 18+ tick; terms tick | Sign-in; showing who did what; adults only; record of acceptance | Yes | Necessary. No phone, date of birth, company size or "how did you hear" |
| Sign in with Google | Name, email from Google (scopes `openid email profile`) | Same as above | Yes | Necessary |
| Onboarding | Business name, city, kind of business | Customer privacy notice, agent set-up | Yes | Necessary |
| Billing profile | Legal name, GSTIN, billing address, billing contact | GST tax invoice | Only to pay | Necessary for tax law |
| Help contact form | Name, email, topic, message | Replying | Yes | **Follow-up 1:** make name optional |
| Privacy request (`/privacy-request`) | Request type, relationship, name, email, business (optional), details | Handling the request and confirming identity by email | Yes, except business | Necessary. The form tells people not to send ID numbers |
| Voice dictation | Audio (not kept); length, language, word count | Transcription; "time saved" stats | Per use | Audio discarded. **Follow-up 2:** add dictation stats to the Privacy Policy retention table (today they are kept until the account is deleted) |
| Push notifications | Browser push endpoint and keys | Delivering alerts | Opt-in | Necessary |
| Loan document upload (`/upload/[token]`) | Files the applicant chooses | The lender's loan check (business is fiduciary) | Per upload | Consent notice shown on the page |
| Security records | Time, IP, device/browser of sign-ins | Account security; DPDP Rules log retention | Automatic | Necessary; kept one year |

## What we deliberately do not collect

Date of birth, gender, phone number at sign-up, precise location, contact lists, device fingerprints,
advertising IDs, analytics events from the browser, session recordings, or any data from a third-party
tracker. If a feature ever needs one of these, add a row here first and explain why.

## Where personal data is stored

PostgreSQL in AWS Mumbai (encrypted columns for documents, messages, drafts, card titles and connection
tokens, each business with its own key); encrypted nightly backups (30 days); the API log (no message
bodies). Nothing personal is kept in the browser except the session cookies and the settings listed in
the Cookie Policy.
