"use client";

import { Mail } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Field, FormError, Input } from "@/components/ui/field";
import { ApiError, errorMessage } from "@/lib/api";
import { EMAIL_RE, postAuth, startGoogleSignin } from "@/lib/auth-client";

function GoogleMark() {
  return (
    <svg viewBox="0 0 18 18" aria-hidden className="h-4 w-4">
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z" />
      <path fill="#FBBC05" d="M3.97 10.72A5.4 5.4 0 0 1 3.68 9c0-.6.1-1.18.29-1.72V4.95H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.05l3.01-2.33z" />
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z" />
    </svg>
  );
}

export function GoogleButton({ label = "Continue with Google", onError }: { label?: string; onError: (m: string) => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      className="w-full"
      icon={<GoogleMark />}
      loading={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await startGoogleSignin();
        } catch (err) {
          setBusy(false);
          onError(err instanceof ApiError && err.status === 503 ? "Google sign-in isn't switched on for this server yet." : errorMessage(err));
        }
      }}
    >
      {label}
    </Button>
  );
}

export function OrDivider({ text = "or" }: { text?: string }) {
  return (
    <div className="my-5 flex items-center gap-3 text-xs text-subtle" role="separator">
      <span className="h-px flex-1 bg-border" />
      {text}
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

/** Two steps: email (and name, when signing up) → 6-digit code. Proving the address is the sign-up. */
export function EmailCodeForm({ askName, onSignedIn }: { askName?: boolean; onSignedIn: () => void }) {
  const [step, setStep] = useState<"email" | "code">("email");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resent, setResent] = useState(false);

  const send = async () => {
    await postAuth("email/start", { email: email.trim() });
  };

  const submitEmail = async (e: FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (askName && !name.trim()) errs.name = "Enter your name";
    if (!EMAIL_RE.test(email.trim())) errs.email = "Enter a valid email address";
    setErrors(errs);
    setFormError(null);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      await send();
      setStep("code");
    } catch (err) {
      setFormError(
        err instanceof ApiError && err.status === 503
          ? "Email sign-in isn't switched on for this server yet. Use Google, or ask the owner."
          : errorMessage(err),
      );
    } finally {
      setBusy(false);
    }
  };

  const submitCode = async (e: FormEvent) => {
    e.preventDefault();
    if (!/^\d{6}$/.test(code.trim())) {
      setErrors({ code: "Enter the 6-digit code from the email" });
      return;
    }
    setErrors({});
    setFormError(null);
    setBusy(true);
    try {
      await postAuth("email/verify", { email: email.trim(), code: code.trim(), full_name: name.trim() });
      onSignedIn();
    } catch (err) {
      setBusy(false);
      if (err instanceof ApiError && err.status === 401) setErrors({ code: "That code is wrong or has expired" });
      else if (err instanceof ApiError && err.status === 403) setFormError("Sign-up is closed on this server. Ask the owner for an invitation.");
      else setFormError(errorMessage(err));
    }
  };

  if (step === "code") {
    return (
      <form onSubmit={submitCode} noValidate className="space-y-4">
        <FormError message={formError} />
        <p className="text-sm text-muted">
          We sent a 6-digit code to <span className="font-medium text-fg">{email.trim()}</span>. It works for 10 minutes.
        </p>
        <Field label="Code" error={errors.code} required>
          <Input
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            autoFocus
            className="text-center font-mono text-lg tracking-[0.4em]"
          />
        </Field>
        <Button type="submit" variant="primary" className="w-full" loading={busy}>
          {askName ? "Create account" : "Sign in"}
        </Button>
        <div className="flex justify-between text-sm">
          <button type="button" className="text-muted hover:text-fg" onClick={() => { setStep("email"); setCode(""); }}>
            Use another email
          </button>
          <button
            type="button"
            className="font-medium text-accent hover:underline disabled:opacity-50"
            disabled={resent}
            onClick={async () => {
              try {
                await send();
                setResent(true);
              } catch (err) {
                setFormError(errorMessage(err));
              }
            }}
          >
            {resent ? "Code sent again" : "Send a new code"}
          </button>
        </div>
      </form>
    );
  }

  return (
    <form onSubmit={submitEmail} noValidate className="space-y-4">
      <FormError message={formError} />
      {askName ? (
        <Field label="Your name" error={errors.name} required>
          <Input autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoFocus />
        </Field>
      ) : null}
      <Field label="Work email" error={errors.email} required>
        <Input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus={!askName} />
      </Field>
      <Button type="submit" variant="primary" className="w-full" icon={<Mail className="h-4 w-4" />} loading={busy}>
        Email me a code
      </Button>
    </form>
  );
}
