"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

const API_BASE = (process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000").replace(/\/$/, "");

export function StatusCallbackClient({ orgSlug }: { orgSlug: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const token = searchParams.get("token");
    const email = searchParams.get("email");
    const returnTo = searchParams.get("returnTo");
    if (!token || !email) {
      setError("Invalid login link.");
      return;
    }

    const verify = async () => {
      try {
        const query = new URLSearchParams({
          orgSlug,
          email,
          token
        });
        const response = await fetch(`${API_BASE}/status-auth/verify?${query.toString()}`, {
          method: "GET",
          credentials: "include"
        });
        if (!response.ok) {
          setError("This login link is invalid or expired.");
          return;
        }
        router.replace(returnTo || `/status/o/${orgSlug}`);
      } catch {
        setError("Unable to verify login link.");
      }
    };

    void verify();
  }, [orgSlug, router, searchParams]);

  return (
    <main className="kv-main" style={{ maxWidth: "560px", margin: "0 auto" }}>
      <h1 style={{ marginTop: 0 }}>Verifying Magic Link</h1>
      {!error ? (
        <p className="kv-subtitle">Please wait while we sign you in.</p>
      ) : (
        <>
          <p>{error}</p>
          <p>
            <Link href={`/status/o/${orgSlug}/login`}>Request a new link</Link>
          </p>
        </>
      )}
    </main>
  );
}
