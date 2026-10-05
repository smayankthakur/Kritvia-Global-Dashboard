# Third-party code and data processors

Two different things are covered here: **code we ship** (libraries running in our app or the
visitor's browser) and **processors** (companies that receive personal data). The Privacy Policy
section 4 is the public list of processors; this register is the internal record behind it.

## Rules

1. **No third-party code in the browser that talks to anyone but us.** The Content-Security-Policy
   (`apps/web/lib/csp.ts`) allows scripts, connections, images and fonts from our own origin only, so an
   analytics tag, chat widget, pixel or font CDN cannot load even by accident. `trust-scan.mjs` fails the
   build if markup or the CSP mentions another origin.
2. **Before adding any SDK, widget or processor**, answer the questions below in the pull request. If any
   answer is "yes" to personal data leaving us, it also needs: a Privacy Policy section 4 row, 15 days'
   notice to business customers (Terms 6.5), a contract with data-protection terms, and — if it sets
   non-essential cookies — an entry in `OPTIONAL_TOOLS` (`lib/consent.ts`) so it loads only after consent.
3. **Review quarterly**: re-run `node apps/web/scripts/trust-scan.mjs --licences`, `pnpm audit --prod`, and
   `pip-audit` for the API; remove anything unused; check each processor's terms (training, retention,
   location) still match what the Privacy Policy says.

### Questions for a new SDK or processor

| Question | Why it matters |
| --- | --- |
| What personal data does it receive, if any? Could it see Customer Data or Google data? | Google Limited Use; DPDP processor duties |
| Does it run in the visitor's browser? Does it set cookies or read storage? | Consent (lib/consent.ts), CSP, Cookie Policy |
| Where is data processed and stored? | Cross-border transfer disclosures |
| Does the provider use the data to train models, advertise, or sell it? | Privacy Policy section 3 and 4 promises |
| How long does it keep data, and can we delete it? | Retention table, erasure requests |
| Licence of the code? | No GPL/AGPL/SSPL in what we ship (see asset-licences.md) |
| Is there a way to do this without it? | Data minimisation |

## Code we ship (5 October 2026)

**Web app (browser and Next.js server)** — no third-party network calls from the browser.

| Package | Purpose | Sends data anywhere? | Licence |
| --- | --- | --- | --- |
| next, react, react-dom | Framework | No | MIT |
| @tanstack/react-query, openapi-fetch | Calls to our own API | Only to our API | MIT |
| @dnd-kit/* | Drag and drop on task boards | No | MIT |
| motion | Animation | No | MIT |
| lucide-react | Icons | No | ISC |
| react-markdown, remark-gfm | Rendering policy and help text | No | MIT |
| recharts | Charts | No | MIT |
| @fontsource-variable/plus-jakarta-sans | Font, self-hosted (no Google Fonts call) | No | OFL-1.1 |

**API and worker (our servers)** — fastapi, uvicorn, sqlalchemy, asyncpg, pydantic-settings,
email-validator, pyjwt, argon2-cffi, cryptography, httpx, pyyaml, python-multipart, pypdf, arq,
defusedxml, pywebpush. None send data anywhere by themselves; outbound calls go only to the processors
below, through code we wrote.

## Processors (must match Privacy Policy section 4)

| Processor | Data | Location | Trains on it? | Terms to keep on file |
| --- | --- | --- | --- | --- |
| Amazon Web Services (hosting, SES email, backups) | All stored data; email addresses for codes | India (Mumbai) | No | AWS Customer Agreement and its data processing addendum |
| Cloudflare (network, tunnel, Workers AI) | All traffic; text of non-sensitive tasks | Global | No | Cloudflare self-serve terms and DPA |
| Groq | Text/audio of non-sensitive tasks | US | No | Groq terms |
| Cerebras | Text of non-sensitive tasks | US | No | Cerebras terms |
| Google Gemini free / OpenRouter free / Mistral (opt-in per business only) | Text of non-sensitive tasks, never Google Workspace data | US/EU | **May** | Provider terms; opt-in recorded per organisation |
| Razorpay | Billing name, GSTIN, email, plan | India | No | Razorpay merchant agreement |
| Browser push services (Google, Apple, Mozilla, Microsoft) | Encrypted notification | Global | No | Platform terms |

Connected by a business itself (the business's own account and contract): Google Workspace, Meta
WhatsApp Business Platform, any AI provider the business adds with its own key.
