"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { AuthCard } from "@/components/shell/auth-card";
import { Button } from "@/components/ui/button";
import { Field, FormError, Input } from "@/components/ui/field";
import { ApiError, errorMessage } from "@/lib/api";
import { EMAIL_RE, postAuth, safeNext } from "@/lib/auth-client";

export default function RegisterPage() {
  const [form, setForm] = useState({ full_name: "", email: "", password: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!form.full_name.trim()) errs.full_name = "Enter your name";
    if (!EMAIL_RE.test(form.email.trim())) errs.email = "Enter a valid email address";
    if (form.password.length < 12) errs.password = "Use at least 12 characters";
    setErrors(errs);
    setFormError(null);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      await postAuth("register", { full_name: form.full_name.trim(), email: form.email.trim(), password: form.password });
      const next = new URLSearchParams(window.location.search).get("next");
      window.location.assign(next ? safeNext(next) : "/onboarding");
    } catch (err) {
      setBusy(false);
      if (err instanceof ApiError && err.status === 409) setErrors({ email: "An account with this email already exists" });
      else if (err instanceof ApiError && Object.keys(err.fieldErrors).length) setErrors(err.fieldErrors);
      else setFormError(errorMessage(err));
    }
  };

  return (
    <AuthCard
      title="Create your account"
      subtitle="Set up the command center for your businesses."
      footer={
        <>
          Already have an account?{" "}
          <Link href="/login" className="font-medium text-accent hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      <form onSubmit={submit} noValidate className="space-y-4">
        <FormError message={formError} />
        <Field label="Full name" error={errors.full_name} required>
          <Input autoComplete="name" value={form.full_name} onChange={set("full_name")} maxLength={120} autoFocus />
        </Field>
        <Field label="Work email" error={errors.email} required>
          <Input type="email" autoComplete="email" value={form.email} onChange={set("email")} />
        </Field>
        <Field label="Password" error={errors.password} hint="At least 12 characters. A passphrase works well." required>
          <Input type="password" autoComplete="new-password" value={form.password} onChange={set("password")} minLength={12} />
        </Field>
        <Button type="submit" variant="primary" className="w-full" loading={busy}>
          Create account
        </Button>
      </form>
    </AuthCard>
  );
}
