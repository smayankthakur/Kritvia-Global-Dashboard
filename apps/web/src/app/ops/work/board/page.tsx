"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AppShell } from "../../../../components/app-shell";
import { ApiError, WorkItem, listWorkItems, transitionWorkItem } from "../../../../lib/api";
import { useAuthUser } from "../../../../lib/use-auth-user";
import { WorkItemStatus } from "../../../../types/auth";

const columns: WorkItemStatus[] = ["TODO", "IN_PROGRESS", "BLOCKED", "DONE"];

function isOverdue(item: WorkItem): boolean {
  if (!item.dueDate || item.status === "DONE") {
    return false;
  }
  const due = new Date(item.dueDate);
  const today = new Date();
  due.setHours(0, 0, 0, 0);
  today.setHours(0, 0, 0, 0);
  return due < today;
}

export default function OpsWorkBoardPage() {
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
        sortBy: "createdAt",
        sortDir: "desc"
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

  const byStatus = useMemo(() => {
    return columns.reduce<Record<WorkItemStatus, WorkItem[]>>((acc, status) => {
      acc[status] = items.filter((item) => item.status === status);
      return acc;
    }, { TODO: [], IN_PROGRESS: [], BLOCKED: [], DONE: [] });
  }, [items]);

  async function onMove(id: string, status: WorkItemStatus): Promise<void> {
    if (!token) {
      return;
    }
    try {
      await transitionWorkItem(token, id, status);
      await reload();
    } catch (requestFailure) {
      setRequestError(
        requestFailure instanceof Error ? requestFailure.message : "Failed to transition work item"
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
      <AppShell user={user} title="Ops Work Board">
        <p>403: Forbidden</p>
      </AppShell>
    );
  }

  return (
    <AppShell user={user} title="Ops Work Board">
      {requestError ? <p className="kv-error">{requestError}</p> : null}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, minmax(220px, 1fr))",
          gap: "0.75rem"
        }}
      >
        {columns.map((status) => (
          <section key={status} className="kv-card">
            <h3 style={{ marginTop: 0 }}>{status}</h3>
            <div style={{ display: "grid", gap: "0.5rem" }}>
              {byStatus[status].map((item) => (
                <article
                  key={item.id}
                  style={{
                    border: "1px solid #cbd5e1",
                    borderRadius: "0.5rem",
                    padding: "0.6rem",
                    background: isOverdue(item)
                      ? "color-mix(in srgb, var(--danger-color) 14%, var(--bg-card))"
                      : "var(--bg-card)"
                  }}
                >
                  <p style={{ margin: "0 0 0.4rem", fontWeight: 700 }}>
                    <Link href={`/work/${item.id}`}>{item.title}</Link>
                  </p>
                  <p style={{ margin: "0 0 0.3rem", fontSize: "0.85rem", color: "var(--text-secondary)" }}>
                    Assignee: {item.assignedToUser?.name ?? "Unassigned"}
                  </p>
                  <p style={{ margin: "0 0 0.3rem", fontSize: "0.85rem", color: isOverdue(item) ? "var(--danger-color)" : "var(--text-secondary)" }}>
                    Due: {item.dueDate ? new Date(item.dueDate).toLocaleDateString() : "No due date"}
                  </p>
                  {canWrite ? (
                    <select
                      value={item.status}
                      onChange={(event) => void onMove(item.id, event.target.value as WorkItemStatus)}
                    >
                      {columns.map((nextStatus) => (
                        <option key={nextStatus} value={nextStatus}>
                          Move to {nextStatus}
                        </option>
                      ))}
                    </select>
                  ) : null}
                </article>
              ))}
            </div>
          </section>
        ))}
      </div>
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
