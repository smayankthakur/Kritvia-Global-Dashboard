import { BookOpen, Check, Inbox, Landmark, Mic, Network, ShieldCheck, Sparkles, Users } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { PublicShell } from "@/components/public/doc-page";
import { buttonClass } from "@/components/ui/button";

export const metadata: Metadata = {
  title: "Kritvia — AI agents for Indian businesses that draft; you approve",
  description:
    "An inbox assistant, lead triage with priced proposals, loan document checks and a nightly kitchen plan — in Hindi, Hinglish or English. Nothing is sent without your approval.",
};

/** Only what is live today. Prices match the Plan & billing page (plans.py). */
const AGENTS = [
  {
    icon: Inbox,
    title: "Inbox assistant",
    text: "Sorts every email and WhatsApp message, files it, pulls out tasks and drafts a reply in your voice from what it knows about your business.",
  },
  {
    icon: Users,
    title: "Lead triage & proposals",
    text: "Scores each enquiry, prices it from your rate card — never a made-up number — and drafts a proposal citing your past work, plus a call invite.",
  },
  {
    icon: Landmark,
    title: "Loan document checks",
    text: "Reads KYC, bank statements and salary slips on a private model, checks them against your checklist and drafts the follow-up for what's missing.",
  },
  {
    icon: Sparkles,
    title: "Nightly kitchen plan",
    text: "Forecasts tomorrow's demand per dish from your Swiggy and Zomato reports, converts it to ingredients and drafts vendor purchase orders.",
  },
];

const PLATFORM = [
  { icon: BookOpen, title: "Memory with citations", text: "Upload documents or connect Drive; every answer says which page it came from." },
  { icon: Network, title: "Mind map", text: "See the people, companies and deals Kritvia has learned about and how they connect." },
  { icon: Mic, title: "Voice in 22 languages", text: "Dictate notes in Hindi, Hinglish or English; Kritvia learns your names and terms." },
  { icon: ShieldCheck, title: "Earned autonomy", text: "An agent acts alone on one action only after a long run of approvals without edits — and you can take it back." },
];

const PLANS = [
  { name: "Free", price: "₹0", lines: ["300k AI tokens a month", "1 business, 2 people", "Agents always ask before acting", "Memory, voice, mind map"] },
  { name: "Starter", price: "₹1,999", lines: ["3M AI tokens a month", "3 businesses, 5 people", "Agents can earn the right to act alone", "Everything in Free"], featured: true },
  { name: "Pro", price: "₹5,999", lines: ["15M AI tokens a month", "10 businesses, 20 people", "Agents can earn the right to act alone", "Everything in Starter"] },
];

const TRUST = [
  "Each business is sealed off in the database itself (row-level security).",
  "Documents, emails and tokens are encrypted at rest with a key per business.",
  "Sensitive records are processed only by a model on Kritvia's own server in Mumbai.",
  "Every action is in a tamper-evident audit log you can verify.",
  "Download your data or delete your account any time.",
];

export default function WelcomePage() {
  return (
    <PublicShell>
      <section className="py-6 text-center sm:py-12">
        <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-accent">For Indian SMBs · Hindi, Hinglish, English</p>
        <h1 className="mx-auto max-w-2xl text-3xl font-semibold tracking-tight text-fg sm:text-4xl">AI agents that do the work. You approve what goes out.</h1>
        <p className="mx-auto mt-4 max-w-xl text-base text-muted">
          Kritvia reads your inbox, drafts replies, proposals and follow-ups, and keeps a memory of your business with citations. Nothing is sent,
          paid or changed without your approval.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <Link href="/register" className={buttonClass("primary", "md", "px-5")}>
            Start free
          </Link>
          <Link href="/login" className={buttonClass("secondary", "md", "px-5")}>
            Sign in
          </Link>
        </div>
        <p className="mt-3 text-xs text-subtle">No card needed. Sign in with Google or an emailed code.</p>
      </section>

      <section aria-labelledby="agents" className="py-8">
        <h2 id="agents" className="text-xl font-semibold text-fg">
          Agents you can switch on today
        </h2>
        <p className="mt-1 text-sm text-muted">Pick your kind of business at sign-up; the right agents start switched on. Tell them how you work in plain language.</p>
        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          {AGENTS.map((a) => (
            <div key={a.title} className="rounded-xl border border-border bg-surface p-5">
              <a.icon className="h-5 w-5 text-accent" aria-hidden />
              <h3 className="mt-3 font-semibold text-fg">{a.title}</h3>
              <p className="mt-1 text-sm text-muted">{a.text}</p>
            </div>
          ))}
        </div>
      </section>

      <section aria-labelledby="platform" className="py-8">
        <h2 id="platform" className="text-xl font-semibold text-fg">
          Built on a memory of your business
        </h2>
        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          {PLATFORM.map((a) => (
            <div key={a.title} className="flex gap-3">
              <a.icon className="mt-0.5 h-5 w-5 shrink-0 text-accent" aria-hidden />
              <div>
                <h3 className="font-semibold text-fg">{a.title}</h3>
                <p className="mt-1 text-sm text-muted">{a.text}</p>
              </div>
            </div>
          ))}
        </div>
        <p className="mt-5 text-sm text-muted">
          Connects to Google Workspace (Gmail, Calendar, Drive), WhatsApp Business, your website&apos;s lead form and Tally exports.
        </p>
      </section>

      <section aria-labelledby="pricing" className="py-8">
        <h2 id="pricing" className="text-xl font-semibold text-fg">
          Simple monthly plans
        </h2>
        <p className="mt-1 text-sm text-muted">Prices per month, plus 18% GST. Paid through Razorpay; cancel any time and finish the month.</p>
        <div className="mt-5 grid gap-4 sm:grid-cols-3">
          {PLANS.map((p) => (
            <div key={p.name} className={"rounded-xl border bg-surface p-5 " + (p.featured ? "border-accent ring-1 ring-accent" : "border-border")}>
              <h3 className="font-semibold text-fg">{p.name}</h3>
              <p className="mt-1 text-2xl font-semibold text-fg">
                {p.price}
                <span className="text-sm font-normal text-subtle">/month</span>
              </p>
              <ul className="mt-4 space-y-2 text-sm text-muted">
                {p.lines.map((l) => (
                  <li key={l} className="flex gap-2">
                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden />
                    {l}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>

      <section aria-labelledby="trust" className="py-8">
        <h2 id="trust" className="text-xl font-semibold text-fg">
          Your data stays yours
        </h2>
        <ul className="mt-4 space-y-2 text-sm text-muted">
          {TRUST.map((t) => (
            <li key={t} className="flex gap-2">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden />
              {t}
            </li>
          ))}
        </ul>
        <p className="mt-4 text-sm">
          <Link href="/security" className="text-accent hover:underline">
            How Kritvia keeps your business safe
          </Link>
          {" · "}
          <Link href="/privacy" className="text-accent hover:underline">
            Privacy policy (DPDP)
          </Link>
        </p>
      </section>

      <section className="rounded-xl border border-border bg-surface-2 p-6 text-center">
        <h2 className="text-lg font-semibold text-fg">See a first result in minutes</h2>
        <p className="mt-1 text-sm text-muted">Sign up, pick your business type, and watch an agent handle a sample enquiry before you connect anything.</p>
        <Link href="/register" className={buttonClass("primary", "md", "mt-4")}>
          Create your account
        </Link>
      </section>
    </PublicShell>
  );
}
