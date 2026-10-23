"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { EmailCodeForm, GoogleButton, OrDivider } from "@/components/auth/sign-in";
import { AuthCard } from "@/components/shell/auth-card";
import { Checkbox, FormError } from "@/components/ui/field";
import { safeNext } from "@/lib/auth-client";
import { api } from "@/lib/api";
import { rememberCoupon } from "@/lib/coupon";
import { rememberReferral } from "@/lib/referral";
import { markTermsIntent } from "@/lib/terms";

export default function RegisterPage() {
  const [googleError, setGoogleError] = useState<string | null>(null);
  const [terms, setTerms] = useState(false);
  const [adult, setAdult] = useState(false);
  const agreed = terms && adult;
  const [offer, setOffer] = useState<{ code: string; offer: string; places_left: number; open: boolean; conditions?: string[] } | null>(null);
  useEffect(() => rememberReferral(window.location.search), []);
  useEffect(() => {
    const code = rememberCoupon(window.location.search);
    if (!code) return;
    void api.GET("/public/coupons/{code}", { params: { path: { code } } }).then((r) => {
      if (r.data) setOffer(r.data);
    });
  }, []);
  const done = () => {
    const next = new URLSearchParams(window.location.search).get("next");
    window.location.assign(next ? safeNext(next) : "/onboarding");
  };

  return (
    <AuthCard
      title="Create your account"
      subtitle="15 days free. No card, no password to remember."
      footer={
        <>
          Already have an account?{" "}
          <Link href="/login" className="font-medium text-accent hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      {offer ? (
        <p className={`mb-4 rounded-lg border px-3 py-2 text-sm ${offer.open ? "border-success/40 bg-success-soft" : "border-border bg-surface-2"}`}>
          {offer.open ? (
            <>
              <strong>{offer.code}</strong>: {offer.offer}
              {offer.conditions?.length ? ` (${offer.conditions.join("; ")})` : ""}. {offer.places_left} {offer.places_left === 1 ? "place" : "places"} left;
              it&apos;s applied when you create your organisation (Terms, clause 10.10).
            </>
          ) : (
            <>{offer.code} can&apos;t be used right now. You still get 15 days free.</>
          )}
        </p>
      ) : null}
      <Checkbox
        className="mb-3"
        checked={adult}
        onChange={(e) => {
          setAdult(e.target.checked);
          markTermsIntent(terms && e.target.checked);
        }}
        label="I am 18 or older"
        hint="Kritvia is a business tool for adults. We don't ask for your date of birth."
      />
      <Checkbox
        className="mb-4"
        checked={terms}
        onChange={(e) => {
          setTerms(e.target.checked);
          markTermsIntent(adult && e.target.checked);
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
        hint="Nothing is sent on your behalf without your approval, unless you switch on automatic replies."
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
          {adult ? "Accept the terms above to sign up." : terms ? "Confirm you are 18 or older to sign up." : "Tick both boxes above to sign up."}
        </p>
      )}
    </AuthCard>
  );
}
