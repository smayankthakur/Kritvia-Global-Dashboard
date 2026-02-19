"use client";

import { AppShell } from "../components/app-shell";
import { FocusTimerCard } from "../components/focus-timer-card";
import { TodaysHighlightCard } from "../components/todays-highlight-card";
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
    <AppShell user={user} title="Overview">
      <section className="kv-card kv-glass kv-stack">
        <p className="kv-subtitle">Welcome back</p>
        <h2 className="kv-section-title kv-serif">{user.name}</h2>
        <p className="kv-note">Active organization: {user.activeOrgId ?? user.orgId}</p>
      </section>
      <section className="kv-grid-2 kv-home-widgets">
        <FocusTimerCard />
        <TodaysHighlightCard />
      </section>
    </AppShell>
  );
}
