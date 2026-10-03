"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { AuthCard } from "@/components/shell/auth-card";
import { Button } from "@/components/ui/button";
import { Field, FormError, Input } from "@/components/ui/field";
import { ApiError, errorMessage } from "@/lib/api";
import { EMAIL_RE, postAuth } from "@/lib/auth-client";

/** Forgot password: email → 6-digit code + new password. Proving the address resets it;
 * every other session is signed out. */
export function ForgotForm() {
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const sendCode = async (e: FormEvent) => {
    e.preventDefault();
    if (!EMAIL_RE.test(email.trim())) return setErrors({ email: "Enter a valid email address" });
    setErrors({});
    setFormError(null);
    setBusy(true);
    try {
      await postAuth("email/start", { email: email.trim() });
      setStep("code");
    } catch (err) {
      setFormError(err instanceof ApiError && err.status === 503 ? "Email isn't set up on this server yet; ask your administrator." : errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const reset = async (e: FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!/^\d{6}$/.test(code.trim())) errs.code = "Enter the 6-digit code from the email";
    if (password.length < 12) errs.password = "Use at least 12 characters";
    setErrors(errs);
    setFormError(null);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      await postAuth("password/reset", { email: email.trim(), code: code.trim(), new_password: password });
      window.location.assign("/");
    } catch (err) {
      setBusy(false);
      if (err instanceof ApiError && err.status === 401) setFormError("That code is wrong or has expired. Request a new one.");
      else if (err instanceof ApiError && err.status === 404) setFormError("There is no account with that email. You can create one instead.");
      else if (err instanceof ApiError && Object.keys(err.fieldErrors).length) setErrors(err.fieldErrors);
      else setFormError(errorMessage(err));
    }
  };

  return (
    <AuthCard
      title="Reset your password"
      subtitle={step === "email" ? "We'll email you a code to prove it's you." : `Enter the code we sent to ${email.trim()} and choose a new password.`}
      footer={
        <>
          Remembered it?{" "}
          <Link href="/login" className="font-medium text-accent hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      {step === "email" ? (
        <form onSubmit={sendCode} noValidate className="space-y-4">
          <FormError message={formError} />
          <Field label="Email" error={errors.email} required>
            <Input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
          </Field>
          <Button type="submit" variant="primary" className="w-full" loading={busy}>
            Email me a code
          </Button>
        </form>
      ) : (
        <form onSubmit={reset} noValidate className="space-y-4">
          <FormError message={formError} />
          <Field label="6-digit code" error={errors.code} required>
            <Input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} autoFocus />
          </Field>
          <Field label="New password" error={errors.password} hint="At least 12 characters." required>
            <Input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <Button type="submit" variant="primary" className="w-full" loading={busy}>
            Set new password
          </Button>
          <button type="button" className="w-full text-center text-sm text-muted hover:text-fg" onClick={() => setStep("email")}>
            Send a new code
          </button>
        </form>
      )}
    </AuthCard>
  );
}
