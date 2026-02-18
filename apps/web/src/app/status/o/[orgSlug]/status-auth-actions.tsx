"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

const API_BASE = (process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000").replace(/\/$/, "");

export function StatusAuthActions({
  orgSlug,
  authRequired,
  authenticated
}: {
  orgSlug: string;
  authRequired: boolean;
  authenticated: boolean;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  const onLogout = async () => {
    setLoading(true);
    try {
      await fetch(`${API_BASE}/status-auth/logout`, {
        method: "POST",
        credentials: "include"
      });
    } finally {
      setLoading(false);
      router.replace(`/status/o/${orgSlug}/login`);
    }
  };

  if (authRequired && !authenticated) {
    return (
      <div className="kv-card">
        <p style={{ marginTop: 0 }}>This status page requires secure login.</p>
        <Link className="kv-button kv-button-primary" href={`/status/o/${orgSlug}/login`}>
          Login
        </Link>
      </div>
    );
  }

  if (authenticated) {
    return (
      <div style={{ marginBottom: "12px" }}>
        <button className="kv-button kv-button-secondary" type="button" onClick={onLogout} disabled={loading}>
          {loading ? "Logging out..." : "Logout"}
        </button>
      </div>
    );
  }

  return null;
}
