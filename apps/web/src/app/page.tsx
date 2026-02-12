"use client";

import { AppShell } from "../components/app-shell";
import { useAuthUser } from "../lib/use-auth-user";

export default function HomePage() {
  const { user, loading, error } = useAuthUser();

  if (loading) {
    return <main className="kv-main">Loading...</main>;
  }

  if (error) {
    return <main className="kv-main">401: {error}</main>;
  }

  if (!user) {
    return <main className="kv-main">Redirecting to login...</main>;
  }

  return (
    <AppShell user={user} title="Kritviya Web OK">
      <p>Welcome, {user.name}</p>
      <p>Org: {user.orgId}</p>
    </AppShell>
  );
}
