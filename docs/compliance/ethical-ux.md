# Ethical UX: dark patterns, fees, reviews and claims

India's Consumer Protection Act 2019 and the CCPA (India) Guidelines for Prevention and Regulation of
Dark Patterns 2023 list 13 banned patterns; the EU DSA, GDPR and the US FTC take the same view. A
violation is an unfair trade practice whether or not anyone complains.

## Run the scan

```bash
cd apps/web
node scripts/trust-scan.mjs              # copy, prices, third-party embeds, CSP
node scripts/trust-scan.mjs --licences   # + production dependency licences
```

It also runs on every test run (`tests/compliance.test.ts`). A reviewed exception goes in `ALLOW` in
the script with a reason; never delete a rule to make it pass.

## Checklist (the 13 patterns, as they apply to Kritvia)

| Pattern | Rule for Kritvia | How it is checked |
| --- | --- | --- |
| False urgency | No countdowns, "only N left", "offer ends" unless literally true and dated | Scan rule `false-urgency` |
| Basket sneaking | Nothing added to a plan or invoice that the person didn't choose; AI packs are bought separately | Review of billing flow |
| Confirm shaming | Decline buttons say "Cancel" / "No", never guilt ("No, I don't want to grow") | Scan rule `confirmshaming` |
| Forced action | Using Kritvia never requires sharing contacts, subscribing to emails, or connecting Google | Review |
| Subscription trap | Cancel in-app in a few clicks; no "contact us to cancel"; renewal date visible | `/refunds` section 2; billing page |
| Interface interference | "Reject all" as prominent as "Accept all"; destructive actions in red with confirmation | `components/legal/consent.tsx`; review |
| Bait and switch | What a plan card lists is what the plan gives | `tests/pricing.test.ts` (unbuilt features only under "Coming soon") |
| Drip pricing | Every price says GST is extra; no other fees | Scan rules `hidden-fee`, `price-without-gst` |
| Disguised advertisement | No sponsored content; any partner mention is labelled | Review |
| Nagging | One terms dialog per version; no repeated upgrade pop-ups | Review |
| Trick question | Checkbox labels say exactly what ticking does, in the positive ("I am 18 or older") | Review |
| SaaS billing | Upgrade/downgrade effects shown before payment (Terms 10.4) | Review of billing flow when Razorpay goes live |
| Rogue malware | No third-party scripts at all; CSP blocks them | Scan rules `third-party-embed`, `csp-third-party` |

Also banned: fake reviews, testimonials or ratings (Consumer Protection (E-Commerce) Rules; BIS IS
19000:2022 on online reviews), invented customer counts or logos, and absolute claims we cannot prove
("100% secure", "bank-grade", "#1"). Scan rules `social-proof` and `unsupported-claim`.

## Findings on 5 October 2026

Fixed in this change:

- Pricing listed analytics, API access, SSO, custom workflows and priority processing as included, but
  they are not built. They now appear under **Coming soon** with an explanation, Terms 10.1 says they
  are not part of a plan until released, and a test stops them moving back into the included list.
- "Learn from my corrections" (voice) was on by default while the Privacy Policy says it runs only if
  switched on. It is now off by default on the web, API and desktop app (existing choices kept).
- The refund policy draft promised a renewal reminder email that does not exist; removed.

### Findings that need a decision

| # | Where | Copy | Issue | Suggestion |
| --- | --- | --- | --- | --- |
| 1 | Landing page, Platform | "Voice in 22 languages" | 22 Indian languages are listed, but 9 of them (Assamese, Kashmiri, Dogri, Manipuri, Bodo, Maithili, Santali, Konkani, Odia) are not supported by the default Whisper engine; check whether the configured engines really cover each one. | Say "Voice in Hindi, English and 11 more Indian languages", or confirm all 22 work as configured |
| 2 | Landing page metadata | operatingSystem "Web, Windows, Android, iOS" | There is no iOS or Android app; the web app installs to the home screen. | "Web (installable on Android and iOS), Windows" |
| 3 | Landing page, Pricing | "Cheaper than a part-time operations assistant" | Comparative claim without a stated basis. | Add the basis ("a part-time assistant in Delhi costs about ₹X a month") or drop it |
| 4 | Help page | "We reply within one business day" | A service promise; fine if you can keep it, otherwise it is a misleading claim. | Keep only if you can staff it; otherwise "within two business days" |

## Licensed fonts, images and media

See [asset-licences.md](asset-licences.md). Rule: no image, font, icon, video or sound goes into the
product or website unless its licence and source are recorded there first.
