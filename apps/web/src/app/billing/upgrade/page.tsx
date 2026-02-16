"use client";

import Link from "next/link";
import { AppShell } from "../../../components/app-shell";
import { useAuthUser } from "../../../lib/use-auth-user";

export default function BillingUpgradePage() {
  const { user, loading, error } = useAuthUser();

  if (loading || !user) {
    return <main className="kv-main">Loading...</main>;
  }
  if (error) {
    return <main className="kv-main">401: {error}</main>;
  }

  return (
    <AppShell user={user} title="Upgrade Plan">
      <section className="kv-card">
        <h2 className="kv-section-title">Upgrade Coming Soon</h2>
        <p className="kv-note">Self-serve billing checkout will be available in a later phase.</p>
        <div className="kv-row" style={{ marginTop: "12px" }}>
          <Link href="/billing" className="kv-btn-primary kv-link-btn">
            Back to Billing
          </Link>
        </div>
      </section>
    </AppShell>
  );
}
