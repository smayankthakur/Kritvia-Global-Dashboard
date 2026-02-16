"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { AppShell } from "../../../components/app-shell";
import { ApiError, getBillingPlan } from "../../../lib/api";
import { useAuthUser } from "../../../lib/use-auth-user";

export default function BillingSuccessPage() {
  const { user, token, loading, error } = useAuthUser();
  const [status, setStatus] = useState<string>("Checking status...");

  useEffect(() => {
    if (!token || !user) {
      return;
    }
    getBillingPlan(token)
      .then((payload) => {
        setStatus(`Subscription status: ${payload.subscription.status}`);
      })
      .catch((requestError) => {
        if (requestError instanceof ApiError) {
          setStatus(`Unable to refresh status: ${requestError.message}`);
          return;
        }
        setStatus("Unable to refresh subscription status.");
      });
  }, [token, user]);

  if (loading || !user) {
    return <main className="kv-main">Loading...</main>;
  }
  if (error) {
    return <main className="kv-main">401: {error}</main>;
  }

  return (
    <AppShell user={user} title="Billing Success">
      <section className="kv-card">
        <h2 className="kv-section-title">Checkout completed</h2>
        <p className="kv-note">
          Payment flow finished. Final plan activation is webhook-driven and may take a short moment.
        </p>
        <p>{status}</p>
        <div className="kv-row" style={{ marginTop: "12px" }}>
          <Link href="/billing" className="kv-btn-primary kv-link-btn">
            Back to Billing
          </Link>
        </div>
      </section>
    </AppShell>
  );
}
