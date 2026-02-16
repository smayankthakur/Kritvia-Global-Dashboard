"use client";

import Link from "next/link";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { AppShell } from "../../../components/app-shell";
import {
  ApiError,
  CeoDashboardPayload,
  UserSummary,
  createNudge,
  getCeoDashboard,
  listUsers
} from "../../../lib/api";
import { useAuthUser } from "../../../lib/use-auth-user";

export default function CeoDashboardPage() {
  const { user, token, loading, error } = useAuthUser();
  const [data, setData] = useState<CeoDashboardPayload | null>(null);
  const [users, setUsers] = useState<UserSummary[]>([]);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [nudgeOpen, setNudgeOpen] = useState(false);
  const [entityType, setEntityType] = useState<"WORK_ITEM" | "INVOICE">("WORK_ITEM");
  const [entityId, setEntityId] = useState("");
  const [targetUserId, setTargetUserId] = useState("");
  const [message, setMessage] = useState("");

  const financeUsers = useMemo(
    () => users.filter((u) => u.role === "FINANCE" || u.role === "ADMIN"),
    [users]
  );

  useEffect(() => {
    if (!token) {
      return;
    }
    Promise.all([getCeoDashboard(token), listUsers(token)])
      .then(([dashboard, allUsers]) => {
        setData(dashboard);
        setUsers(allUsers);
      })
      .catch((requestFailure) => {
        if (requestFailure instanceof ApiError && requestFailure.status === 403) {
          setForbidden(true);
          return;
        }
        setRequestError(
          requestFailure instanceof Error ? requestFailure.message : "Failed to load dashboard"
        );
      });
  }, [token]);

  function openNudgeModal(options: {
    type: "WORK_ITEM" | "INVOICE";
    entityId: string;
    defaultTargetUserId?: string;
    defaultMessage: string;
  }): void {
    setEntityType(options.type);
    setEntityId(options.entityId);
    setTargetUserId(options.defaultTargetUserId ?? "");
    setMessage(options.defaultMessage);
    setNudgeOpen(true);
  }

  async function onCreateNudge(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!token || !targetUserId) {
      return;
    }
    try {
      await createNudge(token, {
        targetUserId,
        entityType,
        entityId,
        message
      });
      setNudgeOpen(false);
    } catch (requestFailure) {
      setRequestError(
        requestFailure instanceof Error ? requestFailure.message : "Failed to create nudge"
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
      <AppShell user={user} title="CEO Dashboard">
        <p>403: Forbidden</p>
      </AppShell>
    );
  }
  if (!data) {
    return (
      <AppShell user={user} title="CEO Dashboard">
        <p>Loading...</p>
      </AppShell>
    );
  }

  return (
    <AppShell user={user} title="CEO Dashboard">
      {requestError ? <p className="kv-error">{requestError}</p> : null}

      <section className="kv-grid-4">
        <article className="kv-card">
          <h3 style={{ margin: 0 }}>Open Deals Value</h3>
          <p className="kv-subtitle">Total active pipeline value</p>
          <p>{data.kpis.openDealsValue}</p>
        </article>
        <article className="kv-card">
          <h3 style={{ margin: 0 }}>Overdue Work</h3>
          <p className="kv-subtitle">Items pending beyond due date</p>
          <p>{data.kpis.overdueWorkCount}</p>
        </article>
        <article className="kv-card">
          <h3 style={{ margin: 0 }}>Invoices Due (7d)</h3>
          <p className="kv-subtitle">Upcoming collections this week</p>
          <p>{data.kpis.invoicesDueTotal}</p>
        </article>
        <article className="kv-card">
          <h3 style={{ margin: 0 }}>Invoices Overdue</h3>
          <p className="kv-subtitle">Past due unpaid invoices</p>
          <p>{data.kpis.invoicesOverdueTotal}</p>
        </article>
      </section>
      <div className="kv-row" style={{ justifyContent: "flex-end", marginTop: "10px" }}>
        <Link href="/ceo/revenue" className="kv-btn-primary kv-link-btn">
          View Revenue Intelligence
        </Link>
      </div>

      <h2 className="kv-section-title">Overdue Work Items</h2>
      <div className="kv-table-wrap">
      <table>
        <thead>
          <tr>
            <th align="left">Title</th>
            <th align="left">Assignee</th>
            <th align="left">Due</th>
            <th align="left">Action</th>
          </tr>
        </thead>
        <tbody>
          {data.bottlenecks.overdueWorkItems.map((item) => (
            <tr key={item.id}>
              <td>{item.title}</td>
              <td>{item.assignedToUser?.name ?? "Unassigned"}</td>
              <td>{item.dueDate ? new Date(item.dueDate).toLocaleDateString() : "-"}</td>
              <td>
                <button
                  type="button"
                  onClick={() =>
                    openNudgeModal({
                      type: "WORK_ITEM",
                      entityId: item.id,
                      defaultTargetUserId: item.assignedToUserId ?? undefined,
                      defaultMessage: `Please action overdue work item: ${item.title}`
                    })
                  }
                  disabled={!item.assignedToUserId}
                  title={!item.assignedToUserId ? "Assign owner first." : ""}
                >
                  Nudge
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>

      <h2 className="kv-section-title">Overdue Invoices</h2>
      <div className="kv-table-wrap">
      <table>
        <thead>
          <tr>
            <th align="left">Invoice</th>
            <th align="left">Company</th>
            <th align="left">Amount</th>
            <th align="left">Due</th>
            <th align="left">Action</th>
          </tr>
        </thead>
        <tbody>
          {data.bottlenecks.overdueInvoices.map((invoice) => (
            <tr key={invoice.id}>
              <td>{invoice.invoiceNumber ?? invoice.id.slice(0, 8)}</td>
              <td>{invoice.company?.name ?? "-"}</td>
              <td>
                {invoice.currency} {invoice.amount}
              </td>
              <td>{invoice.dueDate ? new Date(invoice.dueDate).toLocaleDateString() : "-"}</td>
              <td>
                <button
                  type="button"
                  onClick={() =>
                    openNudgeModal({
                      type: "INVOICE",
                      entityId: invoice.id,
                      defaultTargetUserId: financeUsers[0]?.id,
                      defaultMessage: `Please follow up overdue invoice ${invoice.invoiceNumber ?? invoice.id.slice(0, 8)}`
                    })
                  }
                >
                  Nudge
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>

      {nudgeOpen ? (
        <div className="kv-card">
          <h3 style={{ marginTop: 0 }}>Create Nudge</h3>
          <form onSubmit={(event) => void onCreateNudge(event)} className="kv-form-compact" style={{ maxWidth: "560px" }}>
            <select value={targetUserId} onChange={(event) => setTargetUserId(event.target.value)} required>
              <option value="">Select target user</option>
              {(entityType === "INVOICE" ? financeUsers : users).map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name} ({u.role})
                </option>
              ))}
            </select>
            <textarea value={message} onChange={(event) => setMessage(event.target.value)} rows={3} required />
            <div className="kv-row">
              <button type="submit" className="kv-btn-primary">Send Nudge</button>
              <button type="button" onClick={() => setNudgeOpen(false)}>
                Cancel
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </AppShell>
  );
}
