"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { AppShell } from "../../../components/app-shell";
import { ApiError, exportOrgAuditCsv } from "../../../lib/api";
import { useAuthUser } from "../../../lib/use-auth-user";

function canAccessAudit(role: string): boolean {
  return role === "ADMIN" || role === "CEO";
}

function defaultFromDate(): string {
  const now = new Date();
  const from = new Date(now.getTime() - 29 * 24 * 60 * 60 * 1000);
  return from.toISOString().slice(0, 10);
}

function defaultToDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function SettingsAuditPage() {
  const { user, token, loading, error } = useAuthUser();
  const [fromDate, setFromDate] = useState(defaultFromDate);
  const [toDate, setToDate] = useState(defaultToDate);
  const [downloadPending, setDownloadPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);

  const rangeDays = useMemo(() => {
    const from = new Date(`${fromDate}T00:00:00.000Z`);
    const to = new Date(`${toDate}T23:59:59.999Z`);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      return null;
    }
    return Math.floor((to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000)) + 1;
  }, [fromDate, toDate]);

  const rangeInvalid = rangeDays == null || rangeDays <= 0 || rangeDays > 180;

  async function onDownload(): Promise<void> {
    if (!token || rangeInvalid) {
      return;
    }

    try {
      setDownloadPending(true);
      setRequestError(null);
      setMessage(null);
      const result = await exportOrgAuditCsv(token, {
        from: fromDate,
        to: toDate
      });
      const objectUrl = URL.createObjectURL(result.blob);
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = result.filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(objectUrl);
      setMessage("Audit export downloaded.");
    } catch (requestFailure) {
      if (requestFailure instanceof ApiError && requestFailure.code === "UPGRADE_REQUIRED") {
        setRequestError(`${requestFailure.message} Open /billing to upgrade.`);
        return;
      }
      setRequestError(
        requestFailure instanceof Error ? requestFailure.message : "Failed to download audit export"
      );
    } finally {
      setDownloadPending(false);
    }
  }

  if (loading || !user) {
    return <main className="kv-main">Loading...</main>;
  }

  if (error) {
    return <main className="kv-main">401: {error}</main>;
  }

  if (!canAccessAudit(user.role)) {
    return (
      <AppShell user={user} title="Audit Export">
        <div className="kv-state">
          <h2 style={{ marginTop: 0 }}>403: Forbidden</h2>
          <p>You do not have access to audit export.</p>
          <Link href="/">Go to dashboard</Link>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell user={user} title="Audit Export">
      <section className="kv-card">
        <h2 className="kv-section-title">Audit Export</h2>
        <p className="kv-note" style={{ marginTop: 0 }}>
          Download organization activity logs as CSV. Max range 180 days.
        </p>
        <div className="kv-row" style={{ alignItems: "flex-end", gap: "12px", flexWrap: "wrap" }}>
          <div>
            <label htmlFor="audit-from">From</label>
            <input
              id="audit-from"
              type="date"
              value={fromDate}
              onChange={(event) => setFromDate(event.target.value)}
            />
          </div>
          <div>
            <label htmlFor="audit-to">To</label>
            <input
              id="audit-to"
              type="date"
              value={toDate}
              onChange={(event) => setToDate(event.target.value)}
            />
          </div>
          <button
            type="button"
            className="kv-btn-primary"
            onClick={() => void onDownload()}
            disabled={downloadPending || rangeInvalid}
          >
            {downloadPending ? "Downloading..." : "Download CSV"}
          </button>
        </div>
        {rangeInvalid ? (
          <p className="kv-error">Choose a valid date range up to 180 days.</p>
        ) : (
          <p className="kv-note">Selected range: {rangeDays} days</p>
        )}
        {requestError ? <p className="kv-error">{requestError}</p> : null}
        {message ? <p style={{ color: "var(--success-color)" }}>{message}</p> : null}
      </section>
    </AppShell>
  );
}
