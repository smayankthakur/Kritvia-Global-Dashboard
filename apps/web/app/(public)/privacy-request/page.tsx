"use client";

import { ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import { PublicShell } from "@/components/public/doc-page";
import { Button } from "@/components/ui/button";
import { Field, FormError, Input, Select, Textarea } from "@/components/ui/field";
import { BUSINESS } from "@/lib/business";
import { formatDate } from "@/lib/format";

const KINDS = [
  ["access", "See what data you hold about me"],
  ["correct", "Correct or update my data"],
  ["erase", "Delete my data"],
  ["withdraw", "Withdraw my consent"],
  ["nominate", "Nominate someone to act for me"],
  ["grievance", "Make a complaint (grievance)"],
  ["other", "Something else about my privacy"],
] as const;

const RELATIONSHIPS = [
  ["account_holder", "I have (or had) a Kritvia account"],
  ["business_customer", "I'm a customer or contact of a business that uses Kritvia"],
  ["nominee", "I'm acting for someone else (nominee or authorised agent)"],
  ["other", "Something else"],
] as const;

type Result = { reference: string; acknowledge_by: string; respond_by: string };

export default function PrivacyRequestPage() {
  const [form, setForm] = useState({ kind: "access", relationship: "account_holder", name: "", email: "", business_name: "", details: "", website: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<Result | null>(null);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const r = await fetch("/api/privacy-request", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(form) });
      if (!r.ok)
        throw new Error(r.status === 429 ? "Too many requests from here. Try again in a minute." : r.status === 422 ? "Check your email address and the details you entered." : `Could not send. Email ${BUSINESS.email} instead.`);
      setDone((await r.json()) as Result);
    } catch (x) {
      setErr((x as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <PublicShell>
      <h1 className="text-2xl font-semibold tracking-tight">Privacy request</h1>
      <p className="mt-2 max-w-2xl text-muted">
        Ask to see, correct or delete your personal data, withdraw consent, nominate someone, or make a complaint. It&apos;s free. If you have an account, you can also{" "}
        <Link href="/account" className="text-accent underline">
          download or delete your data
        </Link>{" "}
        yourself, straight away.
      </p>
      {done ? (
        <div className="glass mt-8 max-w-2xl rounded-2xl border p-6" role="status">
          <ShieldCheck className="h-6 w-6 text-success" aria-hidden />
          <h2 className="mt-3 text-lg font-semibold text-fg">We&apos;ve received your request</h2>
          <p className="mt-2 text-sm text-muted">
            Your reference is <strong className="font-mono text-fg">{done.reference}</strong>. Keep it for your records.
          </p>
          <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-muted">
            <li>We&apos;ll email you to confirm it&apos;s you by {formatDate(done.acknowledge_by)}. We never ask for identity documents through this form.</li>
            <li>We&apos;ll answer in full by {formatDate(done.respond_by)}.</li>
            <li>If a business that uses Kritvia holds your data, we pass your request to it and help it respond.</li>
            <li>
              Not happy with our answer? You can complain to the Data Protection Board of India (or, in the EU or UK, your data protection authority).
            </li>
          </ul>
        </div>
      ) : (
        <form onSubmit={submit} className="glass mt-8 max-w-2xl space-y-4 rounded-2xl border p-6" noValidate>
          <FormError message={err} />
          <Field label="What would you like to do?" required>
            <Select value={form.kind} onChange={set("kind")}>
              {KINDS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="How are you connected to Kritvia?" required>
            <Select value={form.relationship} onChange={set("relationship")}>
              {RELATIONSHIPS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </Select>
          </Field>
          {form.relationship === "business_customer" ? (
            <Field label="Which business holds your data?" hint="For example the shop, restaurant or lender you dealt with.">
              <Input value={form.business_name} maxLength={200} onChange={set("business_name")} />
            </Field>
          ) : null}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Your name" required>
              <Input value={form.name} maxLength={120} autoComplete="name" onChange={set("name")} />
            </Field>
            <Field label="Email address" required hint="We reply here, and use it to confirm it's you.">
              <Input type="email" value={form.email} autoComplete="email" maxLength={200} onChange={set("email")} />
            </Field>
          </div>
          <Field label="Details" required hint="What data, and what you'd like us to do. Please don't include ID numbers or documents.">
            <Textarea rows={5} value={form.details} maxLength={5000} onChange={set("details")} />
          </Field>
          <input tabIndex={-1} autoComplete="off" aria-hidden className="hidden" name="website" value={form.website} onChange={set("website")} />
          <p className="text-xs text-subtle">
            We use what you enter only to handle this request, and keep it for three years after we close it, as our{" "}
            <Link href="/privacy" className="text-accent underline">
              Privacy Policy
            </Link>{" "}
            explains.
          </p>
          <Button type="submit" variant="primary" loading={busy} disabled={!form.name.trim() || !form.email.trim() || form.details.trim().length < 5}>
            Send request
          </Button>
        </form>
      )}
      <p className="mt-6 max-w-2xl text-sm text-muted">
        Prefer email? Write to{" "}
        <a href={`mailto:${BUSINESS.email}?subject=Privacy`} className="text-accent underline">
          {BUSINESS.email}
        </a>{" "}
        with &ldquo;Privacy&rdquo; or &ldquo;Grievance&rdquo; in the subject. Grievance officer: {BUSINESS.grievanceOfficer}.
      </p>
    </PublicShell>
  );
}
