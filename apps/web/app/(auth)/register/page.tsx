"use client";

import Link from "next/link";
import { useState } from "react";
import { EmailCodeForm, GoogleButton, OrDivider } from "@/components/auth/sign-in";
import { AuthCard } from "@/components/shell/auth-card";
import { FormError } from "@/components/ui/field";
import { safeNext } from "@/lib/auth-client";

export default function RegisterPage() {
  const [googleError, setGoogleError] = useState<string | null>(null);
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
      <FormError message={googleError} />
      <div className={googleError ? "mt-4" : undefined}>
        <GoogleButton label="Sign up with Google" onError={setGoogleError} />
      </div>
      <OrDivider />
      <EmailCodeForm askName onSignedIn={done} />
      <p className="mt-4 text-center text-xs text-subtle">
        By continuing you agree to the{" "}
        <Link href="/terms" className="underline hover:text-fg">
          Terms
        </Link>{" "}
        and{" "}
        <Link href="/privacy" className="underline hover:text-fg">
          Privacy policy
        </Link>
        . Nothing is sent on your behalf without your approval.
      </p>
    </AuthCard>
  );
}
