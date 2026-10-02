"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState, type FormEvent } from "react";
import { EmailCodeForm, GoogleButton, OrDivider } from "@/components/auth/sign-in";
import { AuthCard } from "@/components/shell/auth-card";
import { Button } from "@/components/ui/button";
import { Field, FormError, Input } from "@/components/ui/field";
import { ApiError, errorMessage } from "@/lib/api";
import { EMAIL_RE, GOOGLE_ERRORS, postAuth, safeNext } from "@/lib/auth-client";

function PasswordForm({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!EMAIL_RE.test(email.trim())) errs.email = "Enter a valid email address";
    if (!password) errs.password = "Enter your password";
    setErrors(errs);
    setFormError(null);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      await postAuth("login", { email: email.trim(), password });
      onDone();
    } catch (err) {
      setBusy(false);
      if (err instanceof ApiError && err.status === 401) setFormError("Email or password is incorrect.");
      else if (err instanceof ApiError && Object.keys(err.fieldErrors).length) setErrors(err.fieldErrors);
      else setFormError(errorMessage(err));
    }
  };

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <FormError message={formError} />
      <Field label="Email" error={errors.email} required>
        <Input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
      </Field>
      <Field label="Password" error={errors.password} required>
        <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
      </Field>
      <Button type="submit" variant="primary" className="w-full" loading={busy}>
        Sign in
      </Button>
    </form>
  );
}

export function LoginForm() {
  const params = useSearchParams();
  const [usePassword, setUsePassword] = useState(false);
  const [googleError, setGoogleError] = useState<string | null>(GOOGLE_ERRORS[params.get("google") ?? ""] ?? null);
  const next = params.get("next");
  const done = () => window.location.assign(safeNext(next));

  return (
    <AuthCard
      title="Sign in"
      subtitle="Welcome back to your command center."
      footer={
        <>
          New to Kritvia?{" "}
          <Link href={next ? `/register?next=${encodeURIComponent(next)}` : "/register"} className="font-medium text-accent hover:underline">
            Create an account
          </Link>
        </>
      }
    >
      <FormError message={googleError} />
      <div className={googleError ? "mt-4" : undefined}>
        <GoogleButton onError={setGoogleError} />
      </div>
      <OrDivider />
      {usePassword ? <PasswordForm onDone={done} /> : <EmailCodeForm onSignedIn={done} />}
      <button type="button" className="mt-4 w-full text-center text-sm text-muted hover:text-fg" onClick={() => setUsePassword((v) => !v)}>
        {usePassword ? "Email me a code instead" : "Sign in with a password"}
      </button>
    </AuthCard>
  );
}
