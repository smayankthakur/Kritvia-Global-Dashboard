/**
 * /llms.txt: a plain-language description of Kritvia for machines that read the site (a young convention,
 * llmstxt.org). Facts only, built from the same sources as the landing page (lib/pricing.ts, lib/business.ts),
 * so prices and company details can't drift from what the site shows.
 */
import { BUSINESS, PRICE_TAX_NOTE } from "@/lib/business";
import { FEATURES, UNDERNEATH } from "@/lib/features";
import { ENTERPRISE, PLAN_CARDS, TOKEN_PACKS } from "@/lib/pricing";
import { SITE_URL } from "@/lib/site";

const inr = (n: number) => `₹${n.toLocaleString("en-IN")}`;
const tokens = (n: number) => (n >= 1_000_000 ? `${n / 1_000_000}M` : `${n / 1000}K`);

export function llmsTxt(): string {
  const plans = PLAN_CARDS.map((p) => {
    const ai = p.monthly_tokens ? `; ${tokens(p.monthly_tokens)} AI tokens a month included` : "";
    if (!p.price_inr) return `- ${p.name}: free for 15 days, no card needed, then choose a plan. ${p.highlights.slice(1, 3).join("; ")}${ai}.`;
    const price = `${inr(p.price_inr)} a month${p.price_annual_inr ? ` or ${inr(p.price_annual_inr)} a year` : ""}`;
    return `- ${p.name}: ${price}. ${p.tagline} ${p.highlights.slice(0, 3).join("; ")}${ai}.`;
  });
  const packs = TOKEN_PACKS.map((t) => `${tokens(t.tokens)} tokens for ${inr(t.price_inr)}`).join(", ");
  const address = BUSINESS.address ? `\nRegistered office: ${BUSINESS.address}` : `\nLocation: ${BUSINESS.city}`;
  return `# Kritvia

> Kritvia is an AI business operating system for Indian small and medium businesses. AI agents read the business's
> inbox (email, WhatsApp, Telegram, website forms), draft replies, proposals and follow-ups in Hindi, Hinglish or
> English, and keep a memory of the business with citations. Nothing is sent, paid or changed without a person's
> approval, unless the business switches on automatic replies to customers. Made by ${BUSINESS.legalName}, New Delhi, India.

## What it does
${FEATURES.map((f) => `- ${f.title}: ${f.answer} Plans: ${f.plans}`).join("\n")}
${UNDERNEATH.map((u) => `- ${u}`).join("\n")}

## Works with
Gmail, Google Calendar, Google Drive, WhatsApp Business, Telegram, Slack, website lead forms, Tally exports, Razorpay and UPI, Google reviews, uploaded documents, and any MCP server or web app with an API (App store).

## Plans (prices in Indian rupees)
${plans.join("\n")}
- ${ENTERPRISE.name}: from ${inr(ENTERPRISE.from_inr)} a month. ${ENTERPRISE.tagline}
- Extra AI usage: ${packs}.
- ${PRICE_TAX_NOTE} Cancel any time in the app.

## Privacy and security
- Each business's data is separated in the database (row-level security) and encrypted with a key per business.
- Sensitive records are processed only by a model on Kritvia's own server in Mumbai, India.
- Data export and account deletion are self-service, under India's Digital Personal Data Protection Act, 2023.

## Company
${BUSINESS.legalName} (CIN ${BUSINESS.cin})${address}
Email: ${BUSINESS.email}
Grievance officer: ${BUSINESS.grievanceOfficer}

## Key pages
- Product and pricing: ${SITE_URL}/
- Every feature, job by job: ${SITE_URL}/features
- Create an account (15-day free trial): ${SITE_URL}/register
- Help: ${SITE_URL}/help
- Security: ${SITE_URL}/security
- Privacy policy: ${SITE_URL}/privacy
- Terms of service: ${SITE_URL}/terms
- Cancellation and refunds: ${SITE_URL}/refunds
- Service status: ${SITE_URL}/status
`;
}
