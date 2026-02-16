"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AppShell } from "../../../components/app-shell";
import {
  ApiError,
  RevenueCashflowPayload,
  RevenueVelocityPayload,
  getRevenueCashflow,
  getRevenueVelocity
} from "../../../lib/api";
import { useAuthUser } from "../../../lib/use-auth-user";

function canAccessRevenue(role: string): boolean {
  return role === "CEO" || role === "ADMIN";
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0
  }).format(Number.isFinite(value) ? value : 0);
}

function formatPct(value: number): string {
  const safe = Number.isFinite(value) ? value : 0;
  return `${safe.toFixed(1).replace(/\.0$/, "")}%`;
}

function formatDays(value: number): string {
  const safe = Number.isFinite(value) ? value : 0;
  return `${safe.toFixed(1).replace(/\.0$/, "")} days`;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(
    Number.isFinite(value) ? value : 0
  );
}

export default function CeoRevenuePage() {
  const { user, token, loading, error } = useAuthUser();
  const [velocity, setVelocity] = useState<RevenueVelocityPayload | null>(null);
  const [cashflow, setCashflow] = useState<RevenueCashflowPayload | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [loadingData, setLoadingData] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);

  const loadData = useCallback(async (): Promise<void> => {
    if (!token) {
      return;
    }
    try {
      setLoadingData(true);
      setRequestError(null);
      const [velocityPayload, cashflowPayload] = await Promise.all([
        getRevenueVelocity(token),
        getRevenueCashflow(token)
      ]);
      setVelocity(velocityPayload);
      setCashflow(cashflowPayload);
      setForbidden(false);
    } catch (requestFailure) {
      if (requestFailure instanceof ApiError && requestFailure.status === 403) {
        setForbidden(true);
        return;
      }
      setRequestError(
        requestFailure instanceof Error ? requestFailure.message : "Failed to load revenue intelligence"
      );
    } finally {
      setLoadingData(false);
    }
  }, [token]);

  useEffect(() => {
    if (!token || !user || !canAccessRevenue(user.role)) {
      return;
    }
    void loadData();
  }, [loadData, token, user]);

  const pipelineRows = useMemo(() => {
    if (!velocity) {
      return [];
    }
    const rows = [
      { label: "0-7 days", value: velocity.pipelineAging["0_7"] },
      { label: "8-14 days", value: velocity.pipelineAging["8_14"] },
      { label: "15-30 days", value: velocity.pipelineAging["15_30"] },
      { label: "30+ days", value: velocity.pipelineAging["30_plus"] }
    ];
    const max = Math.max(...rows.map((row) => row.value), 1);
    return rows.map((row) => ({
      ...row,
      widthPct: Math.round((row.value / max) * 100)
    }));
  }, [velocity]);

  if (loading || !user) {
    return <main className="kv-main">Loading...</main>;
  }

  if (error) {
    return <main className="kv-main">401: {error}</main>;
  }

  if (!canAccessRevenue(user.role)) {
    return (
      <AppShell user={user} title="Revenue Intelligence">
        <div className="kv-state">
          <h2 style={{ marginTop: 0 }}>403: Forbidden</h2>
          <p>Revenue Intelligence is available only for CEO and ADMIN.</p>
          <Link href="/">Go to dashboard</Link>
        </div>
      </AppShell>
    );
  }

  if (forbidden) {
    return (
      <AppShell user={user} title="Revenue Intelligence">
        <div className="kv-state">
          <h2 style={{ marginTop: 0 }}>403: Forbidden</h2>
          <p>Your role is not permitted to access this page.</p>
          <Link href="/">Go to dashboard</Link>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell user={user} title="Revenue Intelligence">
      <p className="kv-subtitle" style={{ marginBottom: "12px" }}>
        Velocity and cashflow signals for execution-linked revenue planning.
      </p>

      {requestError ? (
        <div className="kv-state" style={{ marginBottom: "12px" }}>
          <p className="kv-error" style={{ marginTop: 0 }}>
            {requestError}
          </p>
          <button type="button" onClick={() => void loadData()}>
            Retry
          </button>
        </div>
      ) : null}

      <section className="kv-grid-4">
        {(loadingData || !velocity || !cashflow) && !requestError ? (
          <>
            <div className="kv-revenue-skeleton" />
            <div className="kv-revenue-skeleton" />
            <div className="kv-revenue-skeleton" />
            <div className="kv-revenue-skeleton" />
          </>
        ) : (
          <>
            <article className="kv-card kv-revenue-card">
              <p className="kv-revenue-label">Avg Close Days</p>
              <p className="kv-revenue-value">{formatDays(velocity?.avgCloseDays ?? 0)}</p>
              <p className="kv-note">won deal lifecycle average</p>
            </article>
            <article className="kv-card kv-revenue-card">
              <p className="kv-revenue-label">Forecast 30 Days</p>
              <p className="kv-revenue-value">{formatCurrency(cashflow?.next30DaysForecast ?? 0)}</p>
              <p className="kv-note">invoice + weighted pipeline</p>
            </article>
            <article className="kv-card kv-revenue-card">
              <p className="kv-revenue-label">Outstanding Receivables</p>
              <p className="kv-revenue-value">
                {formatCurrency(cashflow?.outstandingReceivables ?? 0)}
              </p>
              <p className="kv-note">unpaid invoice total</p>
            </article>
            <article className="kv-card kv-revenue-card">
              <p className="kv-revenue-label">Avg Payment Delay</p>
              <p className="kv-revenue-value">{formatDays(cashflow?.avgPaymentDelayDays ?? 0)}</p>
              <p className="kv-note">paid invoices with sent history</p>
            </article>
          </>
        )}
      </section>

      <section className="kv-grid-2" style={{ marginTop: "12px" }}>
        <article className="kv-card kv-revenue-card">
          <h2 className="kv-section-title kv-revenue-title">Conversion</h2>
          {loadingData || !velocity ? (
            <div className="kv-stack">
              <div className="kv-revenue-skeleton-small" />
              <div className="kv-revenue-skeleton-small" />
            </div>
          ) : (
            <>
              <div className="kv-revenue-split">
                <div>
                  <p className="kv-revenue-label">Lead to Deal</p>
                  <p className="kv-revenue-value">{formatPct(velocity.stageConversion.leadToDealPct)}</p>
                </div>
                <div>
                  <p className="kv-revenue-label">Deal to Won</p>
                  <p className="kv-revenue-value">{formatPct(velocity.stageConversion.dealToWonPct)}</p>
                </div>
              </div>
              <p className="kv-note" style={{ marginTop: "8px" }}>
                Leads {formatNumber(velocity.counts.leads)} | Deals {formatNumber(velocity.counts.deals)}
                {" | "}Won {formatNumber(velocity.counts.won)} | Lost{" "}
                {formatNumber(velocity.counts.lost)} | Open {formatNumber(velocity.counts.open)}
              </p>
            </>
          )}
        </article>

        <article className="kv-card kv-revenue-card">
          <h2 className="kv-section-title kv-revenue-title">Pipeline Aging</h2>
          {loadingData || !velocity ? (
            <div className="kv-stack">
              <div className="kv-revenue-skeleton-small" />
              <div className="kv-revenue-skeleton-small" />
              <div className="kv-revenue-skeleton-small" />
              <div className="kv-revenue-skeleton-small" />
            </div>
          ) : (
            <div className="kv-stack">
              {pipelineRows.map((row) => (
                <div key={row.label} className="kv-revenue-bar-row">
                  <div className="kv-revenue-bar-meta">
                    <span>{row.label}</span>
                    <strong>{formatNumber(row.value)}</strong>
                  </div>
                  <div className="kv-revenue-bar-track">
                    <div className="kv-revenue-bar-fill" style={{ width: `${row.widthPct}%` }} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </article>
      </section>
    </AppShell>
  );
}

