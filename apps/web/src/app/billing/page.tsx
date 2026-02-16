"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { AppShell } from "../../components/app-shell";
import {
  ApiError,
  BillingPlanPayload,
  OrgUsagePayload,
  createBillingSubscription,
  getBillingPlan,
  getOrgUsage
} from "../../lib/api";
import { useAuthUser } from "../../lib/use-auth-user";

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => { open: () => void };
  }
}

function nextPlanKey(current: string): "growth" | "pro" | "enterprise" | null {
  if (current === "starter") {
    return "growth";
  }
  if (current === "growth") {
    return "pro";
  }
  if (current === "pro") {
    return "enterprise";
  }
  return null;
}

async function loadRazorpayScript(): Promise<boolean> {
  if (typeof window === "undefined") {
    return false;
  }
  if (window.Razorpay) {
    return true;
  }
  return new Promise((resolve) => {
    const script = document.createElement("script");
    script.src = "https://checkout.razorpay.com/v1/checkout.js";
    script.async = true;
    script.onload = () => resolve(true);
    script.onerror = () => resolve(false);
    document.body.appendChild(script);
  });
}

export default function BillingPage() {
  const router = useRouter();
  const { user, token, loading, error } = useAuthUser();
  const [planData, setPlanData] = useState<BillingPlanPayload | null>(null);
  const [usageData, setUsageData] = useState<OrgUsagePayload | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [loadingData, setLoadingData] = useState(true);
  const [submittingUpgrade, setSubmittingUpgrade] = useState(false);

  const forbidden = user && user.role !== "CEO" && user.role !== "ADMIN";

  useEffect(() => {
    if (!token || !user || forbidden) {
      return;
    }

    const currentToken = token;

    async function load(): Promise<void> {
      try {
        setLoadingData(true);
        setRequestError(null);
        const [plan, usage] = await Promise.all([
          getBillingPlan(currentToken),
          getOrgUsage(currentToken)
        ]);
        setPlanData(plan);
        setUsageData(usage);
      } catch (requestFailure) {
        if (requestFailure instanceof ApiError && requestFailure.status === 403) {
          setRequestError("403: Forbidden");
          return;
        }
        setRequestError(
          requestFailure instanceof Error ? requestFailure.message : "Failed to load billing data"
        );
      } finally {
        setLoadingData(false);
      }
    }

    void load();
  }, [token, user, forbidden]);

  const features = useMemo(() => {
    if (!planData) {
      return [];
    }
    return [
      { label: "Autopilot", enabled: planData.plan.autopilotEnabled },
      { label: "Shield", enabled: planData.plan.shieldEnabled },
      { label: "Portfolio", enabled: planData.plan.portfolioEnabled },
      { label: "Revenue Intelligence", enabled: planData.plan.revenueIntelligenceEnabled }
    ];
  }, [planData]);

  const targetPlan = planData ? nextPlanKey(planData.plan.key) : null;

  function renderMeter(label: string, used: number, limit: number | null) {
    const ratio = limit ? Math.min(100, Math.round((used / Math.max(limit, 1)) * 100)) : null;
    const warning = ratio !== null && ratio >= 80;

    return (
      <article className="kv-card">
        <div className="kv-row" style={{ justifyContent: "space-between" }}>
          <p className="kv-note" style={{ margin: 0 }}>
            {label}
          </p>
          <strong>
            {used} / {limit ?? "infinite"}
          </strong>
        </div>
        {ratio !== null ? (
          <div style={{ marginTop: "10px" }}>
            <div className="kv-progress-track">
              <div
                className={`kv-progress-fill${warning ? " kv-progress-warning" : ""}`}
                style={{ width: `${ratio}%` }}
              />
            </div>
            <p className="kv-note" style={{ margin: "6px 0 0" }}>
              {ratio}% used
            </p>
          </div>
        ) : (
          <p className="kv-note" style={{ marginTop: "10px" }}>
            Unlimited
          </p>
        )}
      </article>
    );
  }

  if (loading || !user) {
    return <main className="kv-main">Loading...</main>;
  }

  if (error) {
    return <main className="kv-main">401: {error}</main>;
  }

  if (forbidden) {
    return (
      <AppShell user={user} title="Billing">
        <div className="kv-state">
          <p style={{ margin: 0 }}>403: Forbidden</p>
          <Link href="/">Back to dashboard</Link>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell user={user} title="Billing">
      {requestError ? <p className="kv-error">{requestError}</p> : null}
      {loadingData ? (
        <div className="kv-stack">
          <div className="kv-revenue-skeleton" />
          <div className="kv-revenue-skeleton" />
          <div className="kv-revenue-skeleton" />
        </div>
      ) : planData && usageData ? (
        <div className="kv-stack">
          <section className="kv-card">
            <div className="kv-row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
              <div>
                <h2 className="kv-revenue-title" style={{ marginBottom: "6px" }}>
                  {planData.plan.name} Plan
                </h2>
                <p className="kv-note" style={{ margin: 0 }}>
                  INR {planData.plan.priceMonthly} / month
                </p>
              </div>
              <span className="kv-pill">{planData.subscription.status}</span>
            </div>
            <div className="kv-row" style={{ marginTop: "12px", flexWrap: "wrap", gap: "8px" }}>
              {features.map((feature) => (
                <span
                  key={feature.label}
                  className="kv-pill"
                  style={feature.enabled ? undefined : { opacity: 0.55 }}
                >
                  {feature.label}
                </span>
              ))}
            </div>
          </section>

          <section className="kv-grid kv-grid-3">
            {renderMeter("Seats Used", usageData.seatsUsed, usageData.seatLimit)}
            {renderMeter("Work Items", usageData.workItemsUsed, usageData.maxWorkItems)}
            {renderMeter("Invoices", usageData.invoicesUsed, usageData.maxInvoices)}
          </section>

          <section className="kv-card">
            <div className="kv-row" style={{ justifyContent: "space-between", alignItems: "center" }}>
              <p className="kv-note" style={{ margin: 0 }}>
                Updated {new Date(usageData.updatedAt).toLocaleString()}
              </p>
              <button
                type="button"
                className="kv-btn-primary"
                disabled={!token || !targetPlan || submittingUpgrade}
                onClick={async () => {
                  if (!token || !targetPlan) {
                    return;
                  }
                  try {
                    setSubmittingUpgrade(true);
                    setRequestError(null);
                    const loaded = await loadRazorpayScript();
                    if (!loaded || !window.Razorpay) {
                      throw new Error("Failed to load Razorpay checkout.");
                    }

                    const checkout = await createBillingSubscription(token, targetPlan);
                    const razorpay = new window.Razorpay({
                      key: checkout.razorpayKeyId,
                      subscription_id: checkout.subscriptionId,
                      name: "Kritviya",
                      description: `Upgrade to ${targetPlan.toUpperCase()} plan`,
                      prefill: {
                        name: user.name,
                        email: user.email
                      },
                      notes: {
                        orgId: user.activeOrgId ?? user.orgId,
                        planKey: targetPlan
                      },
                      handler: () => {
                        router.push("/billing/success");
                      }
                    });
                    razorpay.open();
                  } catch (upgradeError) {
                    setRequestError(
                      upgradeError instanceof Error
                        ? upgradeError.message
                        : "Failed to create billing subscription"
                    );
                  } finally {
                    setSubmittingUpgrade(false);
                  }
                }}
              >
                {submittingUpgrade
                  ? "Launching..."
                  : targetPlan
                    ? `Upgrade to ${targetPlan.toUpperCase()}`
                    : "Already on highest plan"}
              </button>
            </div>
          </section>
        </div>
      ) : (
        <div className="kv-state">
          <p style={{ margin: 0 }}>No billing data available.</p>
        </div>
      )}
    </AppShell>
  );
}
