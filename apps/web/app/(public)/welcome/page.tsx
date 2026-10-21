import { BUSINESS, PRICE_TAX_NOTE } from "@/lib/business";
import { ArrowRight, Lock, ShieldCheck } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { HeroLive } from "@/components/public/hero-live";
import { ConnectsMarquee, Reveal, RevealFallback, RevealGroup } from "@/components/public/landing-motion";
import { AgentsShowcase } from "@/components/public/agents-showcase";
import { Layers } from "@/components/public/layers";
import { PlatformShowcase } from "@/components/public/platform-showcase";
import { PublicPricing } from "@/components/public/pricing-table";
import { PublicShell } from "@/components/public/doc-page";
import { buttonClass } from "@/components/ui/button";
import { ENTERPRISE, PLAN_CARDS, TOKEN_PACKS, rupees } from "@/lib/pricing";
import { INDEX, SITE_URL, share } from "@/lib/site";

const TITLE = "Kritvia — AI agents for Indian businesses that draft; you approve";
const DESCRIPTION =
  "AI agents for Indian businesses: inbox replies, priced proposals, loan document checks and kitchen plans in Hindi, Hinglish or English. You approve first.";

export const metadata: Metadata = {
  title: { absolute: TITLE },
  description: DESCRIPTION,
  robots: INDEX,
  alternates: { canonical: "/" },
  ...share(TITLE, DESCRIPTION, "/"),
  keywords: ["AI agents", "business automation India", "WhatsApp automation", "lead management", "DPDP", "Hinglish AI"],
};

const TRUST = [
  "Each business is sealed off in the database itself (row-level security).",
  "Documents, emails and tokens are encrypted at rest with a key per business.",
  "Sensitive records are processed only by a model on Kritvia's own server in Mumbai.",
  "Every action is in a tamper-evident audit log you can verify.",
  "Download your data or delete your account any time.",
];

/** Structured data so search engines can show the product, its maker and its prices (only what the page shows). */
function JsonLd() {
  const org = {
    "@type": "Organization",
    "@id": `${SITE_URL}/#organization`,
    name: BUSINESS.legalName,
    alternateName: "Sitelytc",
    url: "https://sitelytc.com",
    email: BUSINESS.email,
    identifier: { "@type": "PropertyValue", propertyID: "CIN", value: BUSINESS.cin },
    ...(BUSINESS.address
      ? { address: { "@type": "PostalAddress", streetAddress: BUSINESS.address, addressRegion: "Delhi", addressCountry: "IN" } }
      : { address: { "@type": "PostalAddress", addressLocality: "New Delhi", addressCountry: "IN" } }),
  };
  const app = {
    "@type": "SoftwareApplication",
    "@id": `${SITE_URL}/#software`,
    name: "Kritvia",
    applicationCategory: "BusinessApplication",
    operatingSystem: "Web, Windows, Android, iOS",
    description: DESCRIPTION,
    url: SITE_URL,
    inLanguage: ["en-IN", "hi-IN"],
    featureList: [
      "Inbox assistant for email and WhatsApp",
      "Lead triage and proposals priced from your rate card",
      "Loan document checks",
      "Nightly kitchen plan from Swiggy and Zomato reports",
      "Business memory with citations",
      "Nothing is sent without your approval",
    ],
    publisher: { "@id": `${SITE_URL}/#organization` },
    offers: [
      ...PLAN_CARDS.map((p) => ({ "@type": "Offer", name: p.name, price: String(p.price_inr), priceCurrency: "INR" })),
      {
        "@type": "Offer",
        name: ENTERPRISE.name,
        priceSpecification: { "@type": "PriceSpecification", minPrice: String(ENTERPRISE.from_inr), priceCurrency: "INR" },
      },
    ],
  };
  const data = { "@context": "https://schema.org", "@graph": [org, app] };
  // A data block, not a script: JSON.stringify output with "<" escaped cannot close the tag.
  return (
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(data).replace(/</g, "\\u003c") }} />
  );
}

const STEPS = [
  { title: "Pick your business type", text: "Software studio, finance, kitchen or general. The right agents start switched on." },
  { title: "Connect what you use", text: "Gmail, Calendar, Drive, WhatsApp Business, your site's lead form or Tally exports." },
  { title: "Approve, edit or reject", text: "Agents draft; you decide. Nothing goes out until you say so." },
];

function SectionHead({ id, eyebrow, title, text }: { id: string; eyebrow: string; title: string; text?: string }) {
  return (
    <div className="max-w-2xl">
      <p className="text-xs font-semibold tracking-wider text-accent uppercase">{eyebrow}</p>
      <h2 id={id} className="mt-2 text-2xl font-semibold tracking-tight text-fg sm:text-[28px]">
        {title}
      </h2>
      {text ? <p className="mt-2 text-[15px] text-muted">{text}</p> : null}
    </div>
  );
}

/** The centred heading used above the animated showcases (layers, agents, platform). */
function ShowcaseHead({ id, eyebrow, title, text }: { id: string; eyebrow: string; title: string; text: string }) {
  return (
    <Reveal className="mx-auto max-w-2xl text-center">
      <p className="inline-flex rounded-full border border-border bg-surface-strong px-3 py-1 text-xs font-semibold tracking-wider text-accent uppercase">
        {eyebrow}
      </p>
      <h2 id={id} className="mt-4 text-3xl font-bold tracking-tight text-fg sm:text-4xl">
        {title}
      </h2>
      <p className="mt-3 text-[15px] text-muted">{text}</p>
    </Reveal>
  );
}

export default function WelcomePage() {
  return (
    <PublicShell wide>
      <JsonLd />
      <RevealFallback />
      <section className="relative isolate -mx-4 -mt-10 px-4 pt-12 pb-10 sm:pt-20 sm:pb-16">
        <div className="kv-grid-bg pointer-events-none absolute inset-0 -z-10" aria-hidden />
        <div className="grid items-center gap-12 lg:grid-cols-[1.05fr_1fr]">
          <div className="kv-stagger text-center lg:text-left">
            <p className="inline-flex items-center gap-2 glass rounded-full border px-3 py-1 text-xs font-medium text-muted">
              <span className="h-1.5 w-1.5 rounded-full bg-success" aria-hidden />
              For Indian SMBs · Hindi, Hinglish, English
            </p>
            <h1 className="mx-auto mt-5 max-w-xl text-4xl leading-[1.1] font-bold tracking-tight text-fg sm:text-5xl lg:mx-0">
              AI agents that do the work. <span className="text-accent">You approve</span> what goes out.
            </h1>
            <p className="mx-auto mt-5 max-w-xl text-base leading-relaxed text-muted sm:text-lg lg:mx-0">
              Kritvia reads your inbox, drafts replies, proposals and follow-ups, and keeps a memory of your business with citations. Nothing is
              sent, paid or changed without your approval.
            </p>
            <div className="mt-8 flex flex-wrap justify-center gap-3 lg:justify-start">
              <Link href="/register" className={buttonClass("primary", "md", "h-11 px-6 text-[15px]")}>
                Start 15-day free trial <ArrowRight className="h-4 w-4" aria-hidden />
              </Link>
              <Link href="/login" className={buttonClass("secondary", "md", "h-11 px-6 text-[15px]")}>
                Sign in
              </Link>
            </div>
            <p className="mt-4 text-xs text-subtle">No card needed. Sign in with Google or an emailed code.</p>
          </div>
          <HeroLive className="mx-auto w-full max-w-md lg:max-w-none" />
        </div>
      </section>

      <section aria-label="What Kritvia connects to" className="py-4">
        <p className="mb-3 text-center text-xs font-semibold tracking-wider text-subtle uppercase">Works with what you already use</p>
        <ConnectsMarquee />
      </section>

      <section aria-labelledby="layers" className="scroll-mt-20 py-14">
        <Reveal className="mx-auto max-w-2xl text-center">
          <p className="inline-flex rounded-full border border-border bg-surface-strong px-3 py-1 text-xs font-semibold tracking-wider text-accent uppercase">
            One app, four layers
          </p>
          <h2 id="layers" className="mt-4 text-3xl font-bold tracking-tight text-fg sm:text-4xl">
            Each layer feeds the <span className="kv-gradient-text">next.</span>
          </h2>
          <p className="mt-3 text-[15px] text-muted">
            The inbox gives it your conversations. Memory gives it your business. Agents give it a pen. Your approval gives it the go-ahead.
          </p>
        </Reveal>
        <Reveal className="mt-10" delay={0.1}>
          <Layers />
        </Reveal>
      </section>

      <section aria-labelledby="how" className="py-12">
        <Reveal>
          <SectionHead id="how" eyebrow="How it works" title="Up and running in minutes" />
        </Reveal>
        <RevealGroup as="ol" className="mt-8 grid gap-4 sm:grid-cols-3">
          {STEPS.map((st, i) => (
            <div key={st.title} className="kv-lift glass glass-sheen relative h-full rounded-2xl border p-5">
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-accent text-xs font-semibold text-accent-fg">{i + 1}</span>
              <h3 className="mt-4 font-semibold text-fg">{st.title}</h3>
              <p className="mt-1 text-sm text-muted">{st.text}</p>
            </div>
          ))}
        </RevealGroup>
      </section>

      <section aria-labelledby="agents" className="scroll-mt-20 py-14">
        <ShowcaseHead
          id="agents"
          eyebrow="Agents"
          title="Agents you can switch on today"
          text="Pick your kind of business at sign-up; the right agents start switched on. Tell them how you work in plain language."
        />
        <Reveal className="mt-10" delay={0.1}>
          <AgentsShowcase />
        </Reveal>
      </section>

      <section aria-labelledby="platform" className="scroll-mt-20 py-14">
        <ShowcaseHead
          id="platform"
          eyebrow="Platform"
          title="Built on a memory of your business"
          text="Underneath every agent: what it knows, who works with whom, your voice, and the trust it has earned."
        />
        <Reveal className="mt-10" delay={0.1}>
          <PlatformShowcase />
        </Reveal>
      </section>

      <section aria-labelledby="pricing" className="py-12">
        <Reveal>
        <SectionHead
          id="pricing"
          eyebrow="Pricing"
          title="Plans that grow with your business"
          text={`Cheaper than a part-time operations assistant. ${PRICE_TAX_NOTE} Cancel any time and keep the month you paid for.`}
        />
        </Reveal>
        <div className="mt-8">
          <PublicPricing plans={PLAN_CARDS} />
        </div>
        <p className="mt-4 text-center text-sm text-muted">
          Need more AI in a busy month? Add {TOKEN_PACKS.map((t) => `${t.tokens / 1_000_000}M tokens for ${rupees(t.price_inr)}`).join(", ")}.
        </p>
      </section>

      <section aria-labelledby="trust" className="py-12">
        <Reveal className="glass glass-sheen grid gap-8 rounded-3xl border p-6 sm:p-10 lg:grid-cols-[1fr_1.3fr]">
          <div>
            <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-success-soft text-success">
              <Lock className="h-5 w-5" aria-hidden />
            </span>
            <h2 id="trust" className="mt-4 text-2xl font-semibold tracking-tight text-fg">
              Your data stays yours
            </h2>
            <p className="mt-4 flex flex-col gap-1 text-sm">
              <Link href="/security" className="font-medium text-accent hover:underline">
                How Kritvia keeps your business safe
              </Link>
              <Link href="/privacy" className="font-medium text-accent hover:underline">
                Privacy policy (DPDP)
              </Link>
            </p>
          </div>
          <ul className="space-y-3 text-sm text-muted">
            {TRUST.map((t) => (
              <li key={t} className="flex gap-3">
                <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden />
                {t}
              </li>
            ))}
          </ul>
        </Reveal>
      </section>

      <section className="relative isolate mt-4 mb-2 overflow-hidden rounded-3xl border border-white/10 bg-[#0b1324] px-6 py-12 text-center text-white sm:py-16">
        <div className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(30rem_20rem_at_15%_0%,rgb(37_99_235/0.5),transparent_70%),radial-gradient(28rem_20rem_at_90%_100%,rgb(8_145_178/0.45),transparent_70%)]" aria-hidden />
        <h2 className="relative text-2xl font-semibold tracking-tight sm:text-3xl">See a first result in minutes</h2>
        <p className="relative mx-auto mt-3 max-w-xl text-[15px] text-slate-300">
          Sign up, pick your business type, and watch an agent handle a sample enquiry before you connect anything.
        </p>
        <Link
          href="/register"
          className="relative mt-7 inline-flex h-11 items-center gap-1.5 rounded-md bg-white px-6 text-[15px] font-medium text-slate-900 shadow-card transition-[background-color,transform] duration-150 hover:bg-slate-100 active:scale-[0.98] motion-reduce:active:scale-100"
        >
          Create your account <ArrowRight className="h-4 w-4" aria-hidden />
        </Link>
      </section>
    </PublicShell>
  );
}
