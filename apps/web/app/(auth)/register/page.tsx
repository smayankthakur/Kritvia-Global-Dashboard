"use client";

import Link from "next/link";
import { useState } from "react";
import { EmailCodeForm, GoogleButton, OrDivider } from "@/components/auth/sign-in";
import { AuthCard } from "@/components/shell/auth-card";
import { Checkbox, FormError } from "@/components/ui/field";
import { safeNext } from "@/lib/auth-client";
import { markTermsIntent } from "@/lib/terms";

export default function RegisterPage() {
  const [googleError, setGoogleError] = useState<string | null>(null);
  const [agreed, setAgreed] = useState(false);
  const done = () => {
    const next = new URLSearchParams(window.location.search).get("next");
    window.location.assign(next ? safeNext(next) : "/onboarding");
  };

  return (
    <AuthCard
      title="Create your account"
      subtitle="Free to start. No card, no password to remember."
      footer={
        <>
          Already have an account?{" "}
          <Link href="/login" className="font-medium text-accent hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      <Checkbox
        className="mb-4"
        checked={agreed}
        onChange={(e) => {
          setAgreed(e.target.checked);
          markTermsIntent(e.target.checked);
        }}
        label={
          <>
            I accept the{" "}
            <Link href="/terms" target="_blank" className="text-accent underline">
              Terms of Service
            </Link>{" "}
            and{" "}
            <Link href="/privacy" target="_blank" className="text-accent underline">
              Privacy Policy
            </Link>{" "}
            for my business.
          </>
        }
        hint="Nothing is sent on your behalf without your approval."
      />
      <fieldset disabled={!agreed} aria-describedby={agreed ? undefined : "terms-first"} className="min-w-0 disabled:opacity-60">
        <FormError message={googleError} />
        <div className={googleError ? "mt-4" : undefined}>
          <GoogleButton label="Sign up with Google" onError={setGoogleError} />
        </div>
        <OrDivider />
        <EmailCodeForm askName onSignedIn={done} />
      </fieldset>
      {agreed ? null : (
        <p id="terms-first" className="mt-3 text-center text-xs text-subtle">
          Tick the box above to sign up.
        </p>
      )}
    </AuthCard>
  );
}
