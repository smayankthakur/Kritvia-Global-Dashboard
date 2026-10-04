"use client";

import { ChevronDown } from "lucide-react";
import { useState, type FormEvent } from "react";
import { PublicShell, SUPPORT_EMAIL } from "@/components/public/doc-page";
import { Button } from "@/components/ui/button";
import { Field, FormError, Input, Select, Textarea } from "@/components/ui/field";

const ARTICLES: { q: string; a: string[] }[] = [
  { q: "Getting started in 10 minutes", a: [
    "Sign up with Google or an email code, then tell Kritvia your business name and type. It switches on the right agents.",
    "Go to Settings → General and fill in your Business profile (city, what you do, sign-off). Agents write as your business.",
    "Add a few documents under Knowledge (a past proposal, a price list, a policy). Every answer Kritvia gives cites them.",
  ]},
  { q: "Connect Gmail and Calendar", a: [
    "Open Settings → Connectors → Connect Google and approve access. Kritvia reads new inquiries, and sends emails or invites only after you approve each one.",
    "You can disconnect at any time from the same page, or from your Google account's security settings.",
  ]},
  { q: "Teach the agents how you work", a: [
    "Open Agents in a business. Each agent has an Instructions box: write in plain language — 'reply in Hinglish', 'we only take projects above ₹1 lakh', 'never promise delivery under 2 weeks'. It follows them on every run.",
    "Switch optional steps on or off (draft proposals, book a call, draft replies) and use Try with a sample enquiry to see the result before anything real arrives.",
  ]},
  { q: "The inbox assistant (any business)", a: [
    "Every new email or WhatsApp message is sorted (enquiry, support, payment, scheduling), filed in Knowledge so tasks are pulled out, and answered with a draft reply you approve.",
    "If Lead triage is on, enquiries are handed to it so they are scored and priced instead of merely answered.",
  ]},
  { q: "WhatsApp Business", a: [
    "Settings → Connectors → Connect WhatsApp needs a WhatsApp Business (Meta Cloud API) number: paste the phone number id and a permanent token; Kritvia checks them with Meta before saving.",
    "Replies are free-form within 24 hours of the customer's last message. After that, WhatsApp requires an approved template, and Kritvia tells you instead of guessing.",
  ]},
  { q: "Tally", a: [
    "Tally has no cloud API, so export: Day Book → Alt+E → XML, then Settings → Connectors → Import from Tally. Vouchers, totals by type and who still owes you become searchable, with a cited document in Knowledge.",
    "Re-importing an overlapping period updates rather than duplicates. Nothing is written back to Tally.",
  ]},
  { q: "Forgot your password?", a: [
    "On the sign-in page choose Forgot your password. We email a 6-digit code; enter it with a new password. Every other session is signed out.",
    "If you signed up with Google or email codes you have no password — just keep signing in that way.",
  ]},
  { q: "Approvals: nothing goes out without you", a: [
    "Drafts wait in your Inbox. Approve, edit then approve, or reject with a note so the agent redrafts.",
    "After many approvals without edits, an agent becomes eligible to act alone on that one action. You choose whether to allow it (paid plans).",
  ]},
  { q: "Lead triage and proposals (agencies)", a: [
    "Fill in your Rate card first: prices in proposals always come from it.",
    "Inquiries arrive from Gmail, your website form (Settings → Connectors → webhook) or Leads → Add inquiry.",
  ]},
  { q: "Loan document checks (lenders, DSAs)", a: [
    "Set the documents each loan type needs under Checklists. Create a loan application, then upload documents or send the applicant a secure upload link.",
    "Kritvia checks names, dates of birth, PAN format and statement coverage, and drafts a follow-up for what is missing.",
  ]},
  { q: "The mind map", a: [
    "Mind map shows the people, companies and deals Kritvia has learned about and how they connect. Click anything to see its sources; double-click to centre on it.",
  ]},
  { q: "Plans, AI allowance and GST invoices", a: [
    "Plans: Free (₹0), Starter (₹2,499 a month), Growth (₹6,999) and Scale (₹14,999), plus Enterprise from ₹29,999. Pay yearly and get two months free. Prices are plus 18% GST.",
    "Each plan includes a monthly AI allowance. If it runs out, Kritvia keeps working on its private model; add a usage pack or upgrade on Plan & billing for more.",
    "Add your GSTIN under Plan & billing → Billing details to get it on your invoices.",
  ]},
  { q: "Your data: download or delete", a: [
    "Your account → Download my data gives you a file of everything held about you. Delete my account removes your access and personal data.",
  ]},
];

function Contact() {
  const [form, setForm] = useState({ name: "", email: "", topic: "question", message: "", website: "" });
  const [state, setState] = useState<"idle" | "busy" | "done">("idle");
  const [err, setErr] = useState<string | null>(null);
  const [ref, setRef] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    setState("busy");
    try {
      const r = await fetch("/api/support", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(form) });
      if (!r.ok) throw new Error(r.status === 429 ? "Too many messages from here — try again in a minute." : r.status === 422 ? "Check your email address and message." : "Could not send. Email us instead.");
      setRef(((await r.json()) as { reference?: string }).reference ?? "");
      setState("done");
    } catch (x) {
      setErr((x as Error).message);
      setState("idle");
    }
  };
  if (state === "done")
    return (
      <p className="rounded-lg border border-success/40 bg-success/10 p-4 text-sm" role="status">
        Thanks — we&apos;ve got your message{ref ? ` (reference ${ref})` : ""} and will reply by email within one business day.
      </p>
    );
  return (
    <form onSubmit={submit} className="space-y-3">
      <FormError message={err} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Your name" required>
          <Input value={form.name} maxLength={120} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label="Email" required>
          <Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </Field>
      </div>
      <Field label="Topic">
        <Select value={form.topic} onChange={(e) => setForm({ ...form, topic: e.target.value })}>
          <option value="question">A question</option>
          <option value="problem">Something isn&apos;t working</option>
          <option value="billing">Billing and invoices</option>
          <option value="privacy">Privacy and my data</option>
          <option value="security">Security</option>
          <option value="sales">Plans for my team</option>
        </Select>
      </Field>
      <Field label="Message" required>
        <Textarea rows={5} value={form.message} maxLength={5000} onChange={(e) => setForm({ ...form, message: e.target.value })} />
      </Field>
      <input tabIndex={-1} autoComplete="off" aria-hidden className="hidden" value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} name="website" />
      <Button type="submit" variant="primary" loading={state === "busy"} disabled={!form.name.trim() || !form.email.trim() || form.message.trim().length < 5}>
        Send
      </Button>
    </form>
  );
}

export default function HelpPage() {
  const [open, setOpen] = useState<number | null>(0);
  return (
    <PublicShell>
      <h1 className="text-2xl font-semibold tracking-tight">Help</h1>
      <p className="mt-2 text-muted">Short answers to the common questions. Can&apos;t find yours? Write to us below.</p>
      <div className="mt-6 divide-y divide-border rounded-lg border border-border bg-surface">
        {ARTICLES.map((art, i) => (
          <section key={art.q}>
            <h2>
              <button type="button" className="flex w-full items-center justify-between px-4 py-3 text-left font-medium" aria-expanded={open === i} onClick={() => setOpen(open === i ? null : i)}>
                {art.q}
                <ChevronDown className={`h-4 w-4 text-subtle transition-transform ${open === i ? "rotate-180" : ""}`} aria-hidden />
              </button>
            </h2>
            {open === i ? (
              <div className="space-y-2 px-4 pb-4 text-sm leading-relaxed text-muted">
                {art.a.map((p) => (
                  <p key={p}>{p}</p>
                ))}
              </div>
            ) : null}
          </section>
        ))}
      </div>
      <h2 className="mt-10 text-lg font-semibold" id="contact">
        Contact us
      </h2>
      <p className="mt-1 mb-4 text-sm text-muted">
        We reply within one business day. Or email{" "}
        <a href={`mailto:${SUPPORT_EMAIL}`} className="text-accent hover:underline">
          {SUPPORT_EMAIL}
        </a>
        .
      </p>
      <Contact />
    </PublicShell>
  );
}
