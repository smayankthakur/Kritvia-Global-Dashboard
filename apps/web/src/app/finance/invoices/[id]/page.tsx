"use client";

import { useParams } from "next/navigation";
import { FormEvent, useCallback, useEffect, useState } from "react";
import { AppShell } from "../../../../components/app-shell";
import {
  ApiError,
  Invoice,
  InvoiceActivity,
  getInvoice,
  listInvoiceActivity,
  markInvoicePaid,
  sendInvoice,
  unlockInvoice,
  updateInvoice
} from "../../../../lib/api";
import { useAuthUser } from "../../../../lib/use-auth-user";

export default function FinanceInvoiceDetailPage() {
  const params = useParams<{ id: string }>();
  const { user, token, loading, error } = useAuthUser();
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [activity, setActivity] = useState<InvoiceActivity[]>([]);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [saving, setSaving] = useState(false);

  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [amount, setAmount] = useState("0");
  const [currency, setCurrency] = useState("INR");
  const [issueDate, setIssueDate] = useState("");
  const [dueDate, setDueDate] = useState("");

  const canWrite = user?.role === "FINANCE" || user?.role === "ADMIN";

  const loadData = useCallback(async (): Promise<void> => {
    if (!token || !params.id) {
      return;
    }
    try {
      setRequestError(null);
      const [invoiceRow, timeline] = await Promise.all([
        getInvoice(token, params.id),
        listInvoiceActivity(token, params.id)
      ]);
      setInvoice(invoiceRow);
      setActivity(timeline.items);
      setInvoiceNumber(invoiceRow.invoiceNumber ?? "");
      setAmount(String(invoiceRow.amount));
      setCurrency(invoiceRow.currency);
      setIssueDate(new Date(invoiceRow.issueDate).toISOString().slice(0, 10));
      setDueDate(new Date(invoiceRow.dueDate).toISOString().slice(0, 10));
      setForbidden(false);
      setNotFound(false);
    } catch (requestFailure) {
      if (requestFailure instanceof ApiError && requestFailure.status === 403) {
        setForbidden(true);
        return;
      }
      if (requestFailure instanceof ApiError && requestFailure.status === 404) {
        setNotFound(true);
        return;
      }
      setRequestError(
        requestFailure instanceof Error ? requestFailure.message : "Failed to load invoice"
      );
    }
  }, [token, params.id]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  async function onSave(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!token || !params.id || !canWrite) {
      return;
    }
    try {
      setSaving(true);
      await updateInvoice(token, params.id, {
        invoiceNumber: invoiceNumber || undefined,
        amount: Number(amount),
        currency,
        issueDate,
        dueDate
      });
      await loadData();
    } catch (requestFailure) {
      setRequestError(requestFailure instanceof Error ? requestFailure.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  async function onSend(): Promise<void> {
    if (!token || !params.id || !canWrite) {
      return;
    }
    try {
      await sendInvoice(token, params.id);
      await loadData();
    } catch (requestFailure) {
      setRequestError(
        requestFailure instanceof Error ? requestFailure.message : "Failed to send invoice"
      );
    }
  }

  async function onMarkPaid(): Promise<void> {
    if (!token || !params.id || !canWrite) {
      return;
    }
    try {
      await markInvoicePaid(token, params.id);
      await loadData();
    } catch (requestFailure) {
      setRequestError(
        requestFailure instanceof Error ? requestFailure.message : "Failed to mark paid"
      );
    }
  }

  async function onUnlock(): Promise<void> {
    if (!token || !params.id || !canWrite) {
      return;
    }
    try {
      await unlockInvoice(token, params.id);
      await loadData();
    } catch (requestFailure) {
      setRequestError(
        requestFailure instanceof Error ? requestFailure.message : "Failed to unlock invoice"
      );
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
      <AppShell user={user} title="Invoice Detail">
        <p>403: Forbidden</p>
      </AppShell>
    );
  }
  if (notFound) {
    return (
      <AppShell user={user} title="Invoice Detail">
        <p>404: Invoice not found</p>
      </AppShell>
    );
  }
  if (!invoice) {
    return (
      <AppShell user={user} title="Invoice Detail">
        <p>Loading...</p>
      </AppShell>
    );
  }

  const locked = invoice.isLocked;

  return (
    <AppShell user={user} title="Invoice Detail">
      {requestError ? <p className="kv-error">{requestError}</p> : null}
      <div className="kv-grid-2">
        <section className="kv-card">
          <p style={{ marginTop: 0 }}>
            Status: <strong>{invoice.effectiveStatus}</strong>{" "}{locked ? <span className="kv-pill">Locked</span> : null}
          </p>
          <form onSubmit={onSave} className="kv-form-compact" style={{ maxWidth: "640px" }}>
            <input
              value={invoiceNumber}
              onChange={(event) => setInvoiceNumber(event.target.value)}
              placeholder="Invoice #"
              disabled={!canWrite || locked}
              title={locked ? "Locked invoices cannot be edited until unlock." : ""}
            />
            <input
              type="number"
              min={0}
              step="0.01"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              disabled={!canWrite || locked}
              title={locked ? "Locked invoices cannot be edited until unlock." : ""}
            />
            <input
              value={currency}
              onChange={(event) => setCurrency(event.target.value)}
              disabled={!canWrite || locked}
              title={locked ? "Locked invoices cannot be edited until unlock." : ""}
            />
            <input
              type="date"
              value={issueDate}
              onChange={(event) => setIssueDate(event.target.value)}
              disabled={!canWrite || locked}
              title={locked ? "Locked invoices cannot be edited until unlock." : ""}
            />
            <input
              type="date"
              value={dueDate}
              onChange={(event) => setDueDate(event.target.value)}
              disabled={!canWrite || locked}
              title={locked ? "Locked invoices cannot be edited until unlock." : ""}
            />
            <button type="submit" disabled={!canWrite || locked || saving}>
              {saving ? "Saving..." : "Save"}
            </button>
          </form>

          <div className="kv-row" style={{ marginTop: "0.75rem" }}>
            <button type="button" className="kv-btn-primary" onClick={() => void onSend()} disabled={!canWrite || invoice.status !== "DRAFT"}>
              Send
            </button>
            <button
              type="button"
              onClick={() => void onMarkPaid()}
              disabled={!canWrite || (invoice.effectiveStatus !== "SENT" && invoice.effectiveStatus !== "OVERDUE")}
            >
              Mark Paid
            </button>
            <button type="button" onClick={() => void onUnlock()} disabled={!canWrite || !locked}>
              Unlock
            </button>
          </div>
        </section>
        <aside className="kv-card">
          <h3 style={{ marginTop: 0 }}>Activity Timeline</h3>
          <ul style={{ margin: 0, paddingLeft: "1rem" }}>
            {activity.map((entry) => (
              <li key={entry.id} style={{ marginBottom: "0.5rem" }}>
                <strong>{entry.action}</strong>{" "}
                <span style={{ color: "var(--text-secondary)" }}>
                  by {entry.actorUser?.name ?? "System"} on{" "}
                  {new Date(entry.createdAt).toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        </aside>
      </div>
    </AppShell>
  );
}
