"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AppShell } from "../../../components/app-shell";
import {
  ApiError,
  HygieneItem,
  UserSummary,
  createNudge,
  getHygieneInbox,
  listUsers,
  updateWorkItem
} from "../../../lib/api";
import { useAuthUser } from "../../../lib/use-auth-user";

export default function OpsHygienePage() {
  const { user, token, loading, error } = useAuthUser();
  const [items, setItems] = useState<HygieneItem[]>([]);
  const [users, setUsers] = useState<UserSummary[]>([]);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  const canWrite = user?.role === "OPS" || user?.role === "ADMIN";

  const financeUsers = useMemo(
    () => users.filter((candidate) => candidate.role === "FINANCE" || candidate.role === "ADMIN"),
    [users]
  );

  const reload = useCallback(async (): Promise<void> => {
    if (!token) {
      return;
    }

    try {
      setRequestError(null);
      const [inbox, orgUsers] = await Promise.all([getHygieneInbox(token), listUsers(token)]);
      setItems(inbox);
      setUsers(orgUsers);
      setForbidden(false);
    } catch (requestFailure) {
      if (requestFailure instanceof ApiError && requestFailure.status === 403) {
        setForbidden(true);
        return;
      }
      setRequestError(
        requestFailure instanceof Error ? requestFailure.message : "Failed to load hygiene inbox"
      );
    }
  }, [token]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const workOverdue = items.filter((item) => item.type === "WORK_OVERDUE" && item.workItem);
  const workUnassigned = items.filter((item) => item.type === "WORK_UNASSIGNED" && item.workItem);
  const invoiceOverdue = items.filter((item) => item.type === "INVOICE_OVERDUE" && item.invoice);

  async function onAssign(workItemId: string, assignedToUserId: string): Promise<void> {
    if (!token || !canWrite) {
      return;
    }

    try {
      await updateWorkItem(token, workItemId, { assignedToUserId: assignedToUserId || null });
      await reload();
    } catch (requestFailure) {
      setRequestError(requestFailure instanceof Error ? requestFailure.message : "Failed to assign work item");
    }
  }

  async function onChangeDueDate(workItemId: string, dueDate: string): Promise<void> {
    if (!token || !canWrite) {
      return;
    }

    try {
      await updateWorkItem(token, workItemId, { dueDate: dueDate || null });
      await reload();
    } catch (requestFailure) {
      setRequestError(requestFailure instanceof Error ? requestFailure.message : "Failed to update due date");
    }
  }

  async function onNudgeWorkOwner(workItemId: string, title: string, targetUserId: string | null): Promise<void> {
    if (!token || !targetUserId) {
      setRequestError("Cannot nudge unassigned item. Assign owner first.");
      return;
    }

    try {
      await createNudge(token, {
        targetUserId,
        entityType: "WORK_ITEM",
        entityId: workItemId,
        message: `Please action overdue work item: ${title}`
      });
      await reload();
    } catch (requestFailure) {
      setRequestError(requestFailure instanceof Error ? requestFailure.message : "Failed to create nudge");
    }
  }

  async function onNudgeFinance(invoiceId: string, invoiceNumber: string): Promise<void> {
    if (!token) {
      return;
    }

    const target = financeUsers[0];
    if (!target) {
      setRequestError("No active FINANCE or ADMIN user available for invoice nudges.");
      return;
    }

    try {
      await createNudge(token, {
        targetUserId: target.id,
        entityType: "INVOICE",
        entityId: invoiceId,
        message: `Please follow up overdue invoice ${invoiceNumber}`
      });
      await reload();
    } catch (requestFailure) {
      setRequestError(requestFailure instanceof Error ? requestFailure.message : "Failed to create invoice nudge");
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
      <AppShell user={user} title="Hygiene Inbox">
        <p>403: Forbidden</p>
      </AppShell>
    );
  }

  return (
    <AppShell user={user} title="Hygiene Inbox">
      {requestError ? <p className="kv-error">{requestError}</p> : null}

      <section className="kv-stack">
        <h2 className="kv-section-title">Work Overdue</h2>
        <div className="kv-table-wrap">
        <table>
          <thead>
            <tr>
              <th align="left">Title</th>
              <th align="left">Owner</th>
              <th align="left">Due date</th>
              <th align="left">Actions</th>
            </tr>
          </thead>
          <tbody>
            {workOverdue.map((item) => {
              const workItem = item.workItem!;
              return (
                <tr key={workItem.id}>
                  <td>
                    <Link href={`/work/${workItem.id}`}>{workItem.title}</Link>
                  </td>
                  <td>{workItem.assignedToUser?.name ?? "Unassigned"}</td>
                  <td>{workItem.dueDate ? new Date(workItem.dueDate).toLocaleDateString() : "-"}</td>
                  <td style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                    <button
                      type="button"
                      onClick={() => void onNudgeWorkOwner(workItem.id, workItem.title, workItem.assignedToUserId)}
                      disabled={!workItem.assignedToUserId}
                    >
                      Nudge owner
                    </button>
                    {canWrite ? (
                      <input
                        type="date"
                        defaultValue={workItem.dueDate ? new Date(workItem.dueDate).toISOString().slice(0, 10) : ""}
                        onBlur={(event) => void onChangeDueDate(workItem.id, event.target.value)}
                      />
                    ) : null}
                  </td>
                </tr>
              );
            })}
            {workOverdue.length === 0 ? (
              <tr>
                <td colSpan={4}>No overdue work items</td>
              </tr>
            ) : null}
        </tbody>
      </table>
      </div>
      </section>

      <section className="kv-stack">
        <h2 className="kv-section-title">Work Unassigned</h2>
        <div className="kv-table-wrap">
        <table>
          <thead>
            <tr>
              <th align="left">Title</th>
              <th align="left">Status</th>
              <th align="left">Assign owner</th>
            </tr>
          </thead>
          <tbody>
            {workUnassigned.map((item) => {
              const workItem = item.workItem!;
              return (
                <tr key={workItem.id}>
                  <td>
                    <Link href={`/work/${workItem.id}`}>{workItem.title}</Link>
                  </td>
                  <td>{workItem.status}</td>
                  <td>
                    {canWrite ? (
                      <select
                        defaultValue=""
                        onChange={(event) => void onAssign(workItem.id, event.target.value)}
                      >
                        <option value="">Select user</option>
                        {users.map((candidate) => (
                          <option key={candidate.id} value={candidate.id}>
                            {candidate.name} ({candidate.role})
                          </option>
                        ))}
                      </select>
                    ) : (
                      "Read only"
                    )}
                  </td>
                </tr>
              );
            })}
            {workUnassigned.length === 0 ? (
              <tr>
                <td colSpan={3}>No unassigned work items</td>
              </tr>
            ) : null}
        </tbody>
      </table>
      </div>
      </section>

      <section className="kv-stack">
        <h2 className="kv-section-title">Invoice Overdue</h2>
        <div className="kv-table-wrap">
        <table>
          <thead>
            <tr>
              <th align="left">Invoice</th>
              <th align="left">Company</th>
              <th align="left">Amount</th>
              <th align="left">Due date</th>
              <th align="left">Actions</th>
            </tr>
          </thead>
          <tbody>
            {invoiceOverdue.map((item) => {
              const invoice = item.invoice!;
              const label = invoice.invoiceNumber ?? invoice.id.slice(0, 8);
              return (
                <tr key={invoice.id}>
                  <td>{label}</td>
                  <td>{invoice.company?.name ?? "-"}</td>
                  <td>
                    {invoice.currency} {invoice.amount}
                  </td>
                  <td>{new Date(invoice.dueDate).toLocaleDateString()}</td>
                  <td style={{ display: "flex", gap: "0.5rem" }}>
                    <Link href={`/finance/invoices/${invoice.id}`}>View invoice</Link>
                    <button type="button" onClick={() => void onNudgeFinance(invoice.id, label)}>
                      Nudge finance
                    </button>
                  </td>
                </tr>
              );
            })}
            {invoiceOverdue.length === 0 ? (
              <tr>
                <td colSpan={5}>No overdue invoices</td>
              </tr>
            ) : null}
        </tbody>
      </table>
      </div>
      </section>
    </AppShell>
  );
}
