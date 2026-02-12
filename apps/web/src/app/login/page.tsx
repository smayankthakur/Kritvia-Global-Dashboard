"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { loginRequest } from "../../lib/api";
import { setAccessToken } from "../../lib/auth";
import { ThemeToggle } from "../../components/theme-toggle";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("admin@demo.kritviya.local");
  const [password, setPassword] = useState("kritviya123");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const response = await loginRequest(email, password);
      setAccessToken(response.accessToken);
      router.replace("/");
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Login failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <header className="kv-header kv-login-header">
        <div>
          <p className="kv-brand">KRITVIYA</p>
          <p className="kv-role">Execution OS</p>
        </div>
        <div className="kv-toolbar">
          <ThemeToggle />
          <div className="kv-avatar">KG</div>
        </div>
      </header>
      <main className="kv-login-wrap">
        <form onSubmit={onSubmit} className="kv-login-card kv-form">
          <h1>Login</h1>
          <p className="kv-note" style={{ marginTop: "-6px" }}>
            Sign in to continue to Kritviya OS.
          </p>

          <label htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />

          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
            minLength={8}
          />

          {error ? <p className="kv-error">{error}</p> : null}

          <button type="submit" disabled={loading} className="kv-btn-primary">
            {loading ? "Signing in..." : "Sign in"}
          </button>
        </form>
      </main>
    </>
  );
}
