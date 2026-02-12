"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AppShell } from "../../../../components/app-shell";
import {
  ApiError,
  WorkItem,
  listWorkItems,
  updateWorkItem,
  transitionWorkItem
} from "../../../../lib/api";
import { useAuthUser } from "../../../../lib/use-auth-user";
import { WorkItemStatus } from "../../../../types/auth";

const statuses: WorkItemStatus[] = ["TODO", "IN_PROGRESS", "BLOCKED", "DONE"];

function startOfDay(date: Date): Date {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function classify(item: WorkItem): "Overdue" | "Today" | "Upcoming (7 days)" | "No due date" {
  if (!item.dueDate) {
    return "No due date";
  }
  const due = startOfDay(new Date(item.dueDate));
  const today = startOfDay(new Date());
  const weekEnd = new Date(today);
  weekEnd.setDate(today.getDate() + 7);
  if (due < today) {
    return "Overdue";
  }
  if (due.getTime() === today.getTime()) {
    return "Today";
  }
  if (due <= weekEnd) {
    return "Upcoming (7 days)";
  }
  return "No due date";
}

export default function OpsWorkListPage() {
  const { user, token, loading, error } = useAuthUser();
  const [items, setItems] = useState<WorkItem[]>([]);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(40);
  const [total, setTotal] = useState(0);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  const canWrite = user?.role === "OPS" || user?.role === "ADMIN";

  const reload = useCallback(async (): Promise<void> => {
    if (!token) {
      return;
    }
    try {
      setRequestError(null);
      const rows = await listWorkItems(token, {
        due: "all",
        page,
        pageSize,
        sortBy: "dueDate",
        sortDir: "asc"
      });
      setItems(rows.items);
      setTotal(rows.total);
      setForbidden(false);
    } catch (requestFailure) {
      if (requestFailure instanceof ApiError && requestFailure.status === 403) {
        setForbidden(true);
        return;
      }
      setRequestError(
        requestFailure instanceof Error ? requestFailure.message : "Failed to load work items"
      );
    }
  }, [token, page, pageSize]);

  const canGoPrev = page > 1;
  const canGoNext = page * pageSize < total;

  useEffect(() => {
    void reload();
  }, [reload]);

  const grouped = useMemo(() => {
    return items.reduce<Record<string, WorkItem[]>>(
      (acc, item) => {
        const key = classify(item);
        acc[key].push(item);
        return acc;
      },
      {
        Overdue: [],
        Today: [],
        "Upcoming (7 days)": [],
        "No due date": []
      }
    );
  }, [items]);

  async function onStatusChange(id: string, status: WorkItemStatus): Promise<void> {
    if (!token) {
      return;
    }
    try {
      await transitionWorkItem(token, id, status);
      await reload();
    } catch (requestFailure) {
      setRequestError(
        requestFailure instanceof Error ? requestFailure.message : "Failed to update status"
      );
    }
  }

  async function onAssign(id: string, assignedToUserId: string): Promise<void> {
    if (!token) {
      return;
    }
    try {
      await updateWorkItem(token, id, { assignedToUserId: assignedToUserId || null });
      await reload();
    } catch (requestFailure) {
      setRequestError(
        requestFailure instanceof Error ? requestFailure.message : "Failed to assign"
      );
    }
  }

  async function onDueDate(id: string, dueDate: string): Promise<void> {
    if (!token) {
      return;
    }
    try {
      await updateWorkItem(token, id, { dueDate: dueDate || null });
      await reload();
    } catch (requestFailure) {
      setRequestError(
        requestFailure instanceof Error ? requestFailure.message : "Failed to change due date"
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
      <AppShell user={user} title="Ops Work List">
        <p>403: Forbidden</p>
      </AppShell>
    );
  }

  return (
    <AppShell user={user} title="Ops Work List">
      {requestError ? <p className="kv-error">{requestError}</p> : null}
      {Object.entries(grouped).map(([group, rows]) => (
        <section key={group} className="kv-stack">
          <h3 className="kv-section-title">{group}</h3>
          <div className="kv-table-wrap">
          <table>
            <thead>
              <tr>
                <th align="left">Title</th>
                <th align="left">Status</th>
                <th align="left">Assignee</th>
                <th align="left">Due Date</th>
                <th align="left">Priority</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((item) => (
                <tr key={item.id}>
                  <td>
                    <Link href={`/work/${item.id}`}>{item.title}</Link>
                  </td>
                  <td>
                    {canWrite ? (
                      <select
                        value={item.status}
                        onChange={(event) =>
                          void onStatusChange(item.id, event.target.value as WorkItemStatus)
                        }
                      >
                        {statuses.map((status) => (
                          <option key={status} value={status}>
                            {status}
                          </option>
                        ))}
                      </select>
                    ) : (
                      item.status
                    )}
                  </td>
                  <td>
                    {canWrite ? (
                      <input
                        defaultValue={item.assignedToUserId ?? ""}
                        placeholder="User UUID"
                        onBlur={(event) => void onAssign(item.id, event.target.value)}
                      />
                    ) : (
                      item.assignedToUser?.name ?? "-"
                    )}
                  </td>
                  <td>
                    {canWrite ? (
                      <input
                        type="date"
                        defaultValue={item.dueDate ? new Date(item.dueDate).toISOString().slice(0, 10) : ""}
                        onBlur={(event) => void onDueDate(item.id, event.target.value)}
                      />
                    ) : item.dueDate ? (
                      new Date(item.dueDate).toLocaleDateString()
                    ) : (
                      "-"
                    )}
                  </td>
                  <td>{item.priority}</td>
                </tr>
              ))}
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={5}>No items</td>
                </tr>
              ) : null}
            </tbody>
          </table>
          </div>
        </section>
      ))}
      <div className="kv-pagination">
        <button type="button" onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={!canGoPrev}>
          Previous
        </button>
        <span>
          Page {page} of {Math.max(1, Math.ceil(total / pageSize))}
        </span>
        <button type="button" onClick={() => setPage((current) => current + 1)} disabled={!canGoNext}>
          Next
        </button>
      </div>
    </AppShell>
  );
}
