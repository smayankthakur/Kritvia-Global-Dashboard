"use client";

import Link from "next/link";
import { FormEvent, useState } from "react";

const API_BASE = (process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000").replace(/\/$/, "");

export function StatusLoginClient({ orgSlug }: { orgSlug: string }) {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setMessage(null);
    try {
      const response = await fetch(`${API_BASE}/status-auth/request-link`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgSlug, email: email.trim().toLowerCase() })
      });
      const payload = (await response.json().catch(() => ({}))) as {
        message?: string;
        error?: { message?: string };
      };
      if (!response.ok) {
        setMessage(payload.error?.message ?? "Unable to request login link.");
        return;
      }
      setMessage(payload.message ?? "Check your email for the login link.");
    } catch {
      setMessage("Unable to request login link.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="kv-main" style={{ maxWidth: "560px", margin: "0 auto" }}>
      <h1 style={{ marginTop: 0 }}>Status Login</h1>
      <p className="kv-subtitle">Request a secure one-time magic link.</p>
      <form className="kv-card" onSubmit={onSubmit}>
        <label style={{ display: "block", marginBottom: "10px" }}>
          <span className="kv-subtitle">Work Email</span>
          <input
            className="kv-input"
            type="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@client.com"
          />
        </label>
        <button className="kv-button kv-button-primary" type="submit" disabled={loading}>
          {loading ? "Sending..." : "Send Magic Link"}
        </button>
        {message ? <p style={{ marginTop: "10px" }}>{message}</p> : null}
      </form>
      <p style={{ marginTop: "12px" }}>
        <Link href={`/status/o/${orgSlug}`}>Back to status page</Link>
      </p>
    </main>
  );
}
