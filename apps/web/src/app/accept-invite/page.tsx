"use client";

import Link from "next/link";
import { FormEvent, Suspense, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { acceptOrgInvite, ApiError } from "../../lib/api";
import { getAccessToken, setAccessToken } from "../../lib/auth";

function AcceptInviteContent() {
  const searchParams = useSearchParams();
  const tokenParam = searchParams.get("token") ?? "";
  const orgIdParam = searchParams.get("orgId") ?? "";
  const hasSession = Boolean(getAccessToken());
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const canSubmit = useMemo(
    () => Boolean(tokenParam && orgIdParam),
    [orgIdParam, tokenParam]
  );

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!canSubmit) {
      return;
    }
    try {
      setSubmitting(true);
      setError(null);
      const payload = {
        token: tokenParam,
        orgId: orgIdParam,
        name: hasSession ? undefined : name,
        password: hasSession ? undefined : password
      };
      const response = await acceptOrgInvite(payload);
      if (response.accessToken) {
        setAccessToken(response.accessToken);
      }
      setSuccess("Invite accepted. You can continue to dashboard.");
      window.setTimeout(() => {
        window.location.href = "/";
      }, 1200);
    } catch (requestFailure) {
      if (requestFailure instanceof ApiError) {
        setError(requestFailure.message);
      } else {
        setError("Failed to accept invite");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="kv-login-wrap">
      <section className="kv-login-card">
        <h1 style={{ marginBottom: "12px" }}>Accept Invite</h1>
        {!canSubmit ? (
          <div className="kv-state">
            <p style={{ margin: 0 }}>Invalid invite link.</p>
            <Link href="/login">Go to login</Link>
          </div>
        ) : (
          <form onSubmit={(event) => void onSubmit(event)} className="kv-form">
            {!hasSession ? (
              <>
                <label htmlFor="inviteName">Name</label>
                <input
                  id="inviteName"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  required
                />
                <label htmlFor="invitePassword">Password</label>
                <input
                  id="invitePassword"
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  minLength={8}
                  required
                />
              </>
            ) : (
              <p className="kv-note">You are signed in. Accept invite for this account.</p>
            )}
            {error ? <p className="kv-error">{error}</p> : null}
            {success ? <p style={{ color: "var(--success-color)" }}>{success}</p> : null}
            <button type="submit" className="kv-btn-primary" disabled={submitting}>
              {submitting ? "Accepting..." : "Accept Invite"}
            </button>
          </form>
        )}
      </section>
    </main>
  );
}

export default function AcceptInvitePage() {
  return (
    <Suspense fallback={<main className="kv-main">Loading...</main>}>
      <AcceptInviteContent />
    </Suspense>
  );
}
