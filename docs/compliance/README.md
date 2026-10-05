# Kritvia compliance — Phase 1: legal, consent and trust

Owner: Mayank Thakur (Director, Grievance Officer). Last reviewed: 5 October 2026.
Laws in scope: India's DPDP Act 2023 and DPDP Rules 2025, IT Act s.43A and SPDI Rules, Consumer
Protection Act 2019 and the CCPA (India) Guidelines for Prevention and Regulation of Dark Patterns
2023, plus alignment with GDPR / UK GDPR, CCPA/CPRA (California) and COPPA (US).

> This is engineering and compliance groundwork, not legal advice. Have an Indian lawyer review
> the policy texts before paid launch, and again before you market to the EU, UK or US.

## Status by checklist item

| Item | Where it lives | Status |
| --- | --- | --- |
| Privacy Policy (DPDP; GDPR and California sections) | `apps/web/lib/legal/privacy.ts` → `/privacy` | Done |
| Terms of Service (18+, "Coming soon" clause, refund link) | `apps/web/lib/legal/terms.ts` → `/terms` | Done; version bumped to 2026-10-05, so everyone re-accepts |
| Cancellation, Refund and Delivery Policy | `apps/web/lib/legal/refunds.ts` → `/refunds` | Done (Razorpay needs this page) |
| Cookie Policy | `apps/web/lib/legal/cookies.ts` → `/cookies` | Done |
| Cookie consent | `apps/web/lib/consent.ts`, `components/legal/consent.tsx` | Consent-ready: no banner while every cookie is strictly necessary; the banner, settings and `<ConsentGate>` switch on when an optional tool is registered. Honours Global Privacy Control |
| Data deletion and other rights | In-app: Your account → Download my data / Delete my account. Anyone: `/privacy-request` → `POST /public/privacy-requests` → `privacy_requests` table | Done. Handling steps: [privacy-requests-runbook.md](privacy-requests-runbook.md) |
| Age (children) | 18+ confirmation at sign-up and in the terms dialog; `users.adult_confirmed_at`; the API refuses acceptance without it | Done. No date of birth collected (data minimisation) |
| Third-party SDK audit | [third-party-register.md](third-party-register.md); `scripts/trust-scan.mjs` | Done; enforced in tests |
| Explicit form consents | [consent-and-forms.md](consent-and-forms.md) | Audited; no pre-ticked boxes (enforced) |
| No unnecessary data | [data-inventory.md](data-inventory.md) | Audited; 2 follow-ups listed |
| Footer with business details | `apps/web/components/public/site-footer.tsx`, `lib/business.ts` | Done. **Registered office address and GSTIN are blank until you set them** (see below) |
| Unsubscribe in emails | `services/mailer.py` (footer, RFC 8058 headers), `routers/privacy.py` (`send_product_email`, signed links), `/unsubscribe` | Done. No product emails are sent today; any future one must use `send_product_email` |
| Dark patterns, hidden fees, fake reviews, unsupported claims | [ethical-ux.md](ethical-ux.md); `scripts/trust-scan.mjs` | Scan clean. Pricing now marks unbuilt features "Coming soon". 4 copy items need your decision |
| Licensed fonts and images | [asset-licences.md](asset-licences.md); `node scripts/trust-scan.mjs --licences` | Done |

## Owner actions

1. Set the registered office address (and GSTIN, if you want it shown): `NEXT_PUBLIC_COMPANY_ADDRESS`,
   `NEXT_PUBLIC_COMPANY_GSTIN` in the web build and `COMPANY_ADDRESS` in the API `.env`. The web values are
   build-time, so rebuild after setting them.
2. Decide the four copy items in [ethical-ux.md](ethical-ux.md#findings-that-need-a-decision).
3. Update the Claude Doc legal master copy to match the new Terms and Privacy Policy text.
4. Have a lawyer review `/privacy`, `/terms`, `/refunds` and `/cookies` before paid launch.
5. Check open privacy requests weekly ([runbook](privacy-requests-runbook.md)).

## How it is kept true

- `apps/web/tests/compliance.test.ts` fails the build if: a cookie the app sets is missing from the Cookie
  Policy; a banner would show with nothing to choose; copy contains fake urgency, fake social proof,
  absolute claims, confirmshaming, pre-ticked boxes or extra fees; a public page shows prices without
  mentioning GST; markup embeds a third-party script, frame or pixel; or the CSP allows an outside origin.
- `apps/web/tests/pricing.test.ts` fails if an unbuilt feature is listed as included.
- `apps/api/tests/test_privacy_rights.py` and `test_my_data.py` cover requests, unsubscribe, the email
  footer and the 18+ rule.
