"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { AppShell } from "../../../components/app-shell";
import {
  ApiError,
  PortfolioSummaryPayload,
  getPortfolioSummary,
  switchOrgRequest
} from "../../../lib/api";
import { setAccessToken } from "../../../lib/auth";
import { useAuthUser } from "../../../lib/use-auth-user";

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0
  }).format(Number.isFinite(value) ? value : 0);
}

export default function PortfolioDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { user, token, loading, error } = useAuthUser();
  const [summary, setSummary] = useState<PortfolioSummaryPayload | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [loadingData, setLoadingData] = useState(false);
  const [switchingOrgId, setSwitchingOrgId] = useState<string | null>(null);

  const loadSummary = useCallback(async (): Promise<void> => {
    if (!token || !params.id) {
      return;
    }
    try {
      setLoadingData(true);
      setRequestError(null);
      const payload = await getPortfolioSummary(token, params.id);
      setSummary(payload);
      setForbidden(false);
    } catch (requestFailure) {
      if (requestFailure instanceof ApiError && requestFailure.status === 403) {
        setForbidden(true);
        return;
      }
      if (requestFailure instanceof ApiError && requestFailure.status === 404) {
        setRequestError("Portfolio not found");
        return;
      }
      setRequestError(
        requestFailure instanceof Error ? requestFailure.message : "Failed to load portfolio summary"
      );
    } finally {
      setLoadingData(false);
    }
  }, [params.id, token]);

  useEffect(() => {
    void loadSummary();
  }, [loadSummary]);

  async function onSwitchOrg(orgId: string): Promise<void> {
    if (!token) {
      return;
    }
    try {
      setSwitchingOrgId(orgId);
      const switched = await switchOrgRequest(token, orgId);
      setAccessToken(switched.accessToken);
      router.push("/ceo/dashboard");
      router.refresh();
    } catch (requestFailure) {
      setRequestError(requestFailure instanceof Error ? requestFailure.message : "Failed to switch org");
    } finally {
      setSwitchingOrgId(null);
    }
  }

  if (loading || !user) {
    return <main className="kv-main">Loading...</main>;
  }

  if (error) {
    return <main className="kv-main">401: {error}</main>;
  }

  if (forbidden) {
    return (
      <AppShell user={user} title="Portfolio">
        <div className="kv-state">
          <h2 style={{ marginTop: 0 }}>403: Forbidden</h2>
          <p>You are not a member of this portfolio.</p>
          <Link href="/portfolio">Back to portfolios</Link>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell user={user} title={summary ? summary.group.name : "Portfolio"}>
      {requestError ? <p className="kv-error">{requestError}</p> : null}
      {summary ? (
        <div className="kv-row" style={{ marginBottom: "12px" }}>
          <span className="kv-pill">Role: {summary.group.role}</span>
        </div>
      ) : null}

      {loadingData ? (
        <div className="kv-stack">
          <div className="kv-revenue-skeleton" />
          <div className="kv-revenue-skeleton" />
          <div className="kv-revenue-skeleton" />
        </div>
      ) : summary && summary.rows.length === 0 ? (
        <div className="kv-state">
          <p style={{ margin: 0 }}>No orgs attached to this portfolio yet.</p>
        </div>
      ) : (
        <div className="kv-portfolio-grid">
          {summary?.rows.map((row) => (
            <article key={row.org.id} className="kv-card kv-portfolio-card kv-portfolio-glow">
              <h3 className="kv-revenue-title" style={{ marginTop: 0, marginBottom: "8px" }}>
                {row.org.name}
              </h3>
              <div className="kv-portfolio-kpis">
                <p>
                  Health Score: <strong>{row.kpis.healthScore ?? "—"}</strong>
                </p>
                <p>
                  Open Nudges: <strong>{row.kpis.openNudgesCount}</strong>
                </p>
                <p>
                  Receivables: <strong>{formatCurrency(row.kpis.outstandingReceivables)}</strong>
                </p>
                <p>
                  Overdue Work: <strong>{row.kpis.overdueWorkCount}</strong>
                </p>
                <p>
                  Critical Shield: <strong>{row.kpis.criticalShieldCount}</strong>
                </p>
              </div>
              <div className="kv-row" style={{ marginTop: "8px" }}>
                <button
                  type="button"
                  className="kv-btn-primary"
                  onClick={() => void onSwitchOrg(row.org.id)}
                  disabled={switchingOrgId === row.org.id}
                >
                  {switchingOrgId === row.org.id ? "Switching..." : "Switch to this org"}
                </button>
              </div>
              <div className="kv-row" style={{ marginTop: "10px" }}>
                <Link href={row.deepLinks.viewOpsOverdue} className="kv-note">
                  Ops overdue
                </Link>
                <Link href={row.deepLinks.viewInvoicesOverdue} className="kv-note">
                  Invoices overdue
                </Link>
                <Link href={row.deepLinks.viewShield} className="kv-note">
                  Shield
                </Link>
              </div>
            </article>
          ))}
        </div>
      )}
    </AppShell>
  );
}

