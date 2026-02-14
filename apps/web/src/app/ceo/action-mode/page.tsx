"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AppShell } from "../../../components/app-shell";
import { ApiError, Nudge, executeNudge, listNudges, undoNudge } from "../../../lib/api";
import { useAuthUser } from "../../../lib/use-auth-user";

interface ExecutedState {
  undoExpiresAt: string;
}

function canAccess(role: string): boolean {
  return role === "CEO" || role === "ADMIN";
}

function severityClass(severity: Nudge["severity"]): string {
  if (severity === "CRITICAL") {
    return "kv-badge-danger";
  }
  if (severity === "HIGH") {
    return "kv-badge-warning";
  }
  return "kv-badge";
}

function remainingSeconds(undoExpiresAt: string, nowMs: number): number {
  const delta = new Date(undoExpiresAt).getTime() - nowMs;
  return Math.max(0, Math.ceil(delta / 1000));
}

export default function CeoActionModePage() {
  const { user, token, loading, error } = useAuthUser();
  const [items, setItems] = useState<Nudge[]>([]);
  const [executedMap, setExecutedMap] = useState<Record<string, ExecutedState>>({});
  const [requestError, setRequestError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [loadingQueue, setLoadingQueue] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [tickMs, setTickMs] = useState(Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => {
      setTickMs(Date.now());
      setExecutedMap((current) => {
        const next = Object.fromEntries(
          Object.entries(current).filter(([, state]) => remainingSeconds(state.undoExpiresAt, Date.now()) > 0)
        );
        return next;
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  const loadTopNudges = useCallback(async (): Promise<void> => {
    if (!token) {
      return;
    }

    try {
      setLoadingQueue(true);
      setRequestError(null);
      let payload;
      try {
        payload = await listNudges(token, {
          mine: false,
          status: "OPEN",
          page: 1,
          pageSize: 5,
          sortBy: "priorityScore",
          sortDir: "desc"
        });
      } catch (requestFailure) {
        if (requestFailure instanceof ApiError && requestFailure.status === 403) {
          payload = await listNudges(token, {
            mine: true,
            status: "OPEN",
            page: 1,
            pageSize: 20,
            sortBy: "priorityScore",
            sortDir: "desc"
          });
        } else {
          throw requestFailure;
        }
      }

      const sortedTop = [...payload.items]
        .sort((left, right) => right.priorityScore - left.priorityScore)
        .slice(0, 5);
      setItems(sortedTop);
      setForbidden(false);
    } catch (requestFailure) {
      if (requestFailure instanceof ApiError && requestFailure.status === 403) {
        setForbidden(true);
        return;
      }
      setRequestError(
        requestFailure instanceof Error ? requestFailure.message : "Failed to load action queue"
      );
    } finally {
      setLoadingQueue(false);
    }
  }, [token]);

  useEffect(() => {
    if (!user || !token || !canAccess(user.role)) {
      return;
    }
    void loadTopNudges();
  }, [loadTopNudges, token, user]);

  useEffect(() => {
    if (!toast) {
      return;
    }
    const timer = window.setTimeout(() => setToast(null), 2500);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const hasUrgent = useMemo(() => items.length > 0, [items]);

  async function onExecute(id: string): Promise<void> {
    if (!token) {
      return;
    }
    try {
      setBusyId(id);
      const response = await executeNudge(token, id);
      setExecutedMap((current) => ({
        ...current,
        [id]: { undoExpiresAt: response.undoExpiresAt }
      }));
      setToast("Nudge executed.");
    } catch (requestFailure) {
      setRequestError(
        requestFailure instanceof Error ? requestFailure.message : "Failed to execute nudge"
      );
    } finally {
      setBusyId(null);
    }
  }

  async function onUndo(id: string): Promise<void> {
    if (!token) {
      return;
    }
    try {
      setBusyId(id);
      await undoNudge(token, id);
      setExecutedMap((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      await loadTopNudges();
      setToast("Undo successful.");
    } catch (requestFailure) {
      setRequestError(requestFailure instanceof Error ? requestFailure.message : "Failed to undo");
    } finally {
      setBusyId(null);
    }
  }

  if (loading || !user) {
    return <main className="kv-main">Loading...</main>;
  }

  if (error) {
    return <main className="kv-main">401: {error}</main>;
  }

  if (!canAccess(user.role)) {
    return (
      <AppShell user={user} title="Action Mode">
        <div className="kv-state">
          <h2 style={{ marginTop: 0 }}>403: Forbidden</h2>
          <p>Action Mode is available only for CEO and ADMIN.</p>
          <Link href="/">Go to dashboard</Link>
        </div>
      </AppShell>
    );
  }

  if (forbidden) {
    return (
      <AppShell user={user} title="Action Mode">
        <div className="kv-state">
          <h2 style={{ marginTop: 0 }}>403: Forbidden</h2>
          <p>You do not have permission to view this queue.</p>
          <Link href="/">Go to dashboard</Link>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell user={user} title="CEO Action Mode">
      {requestError ? (
        <div className="kv-state" style={{ marginBottom: "12px" }}>
          <p className="kv-error" style={{ marginTop: 0 }}>
            {requestError}
          </p>
          <button type="button" onClick={() => void loadTopNudges()}>
            Retry
          </button>
        </div>
      ) : null}
      {toast ? <p style={{ color: "var(--success-color)" }}>{toast}</p> : null}

      <section className="kv-grid-4" style={{ marginBottom: "12px" }}>
        <article className="kv-card">
          <h3 style={{ margin: 0 }}>Execution Score</h3>
          <p className="kv-subtitle">Org execution health snapshot</p>
          <p style={{ margin: "10px 0 0", fontWeight: 700 }}>Coming soon</p>
          <Link href="/ceo/dashboard" className="kv-note">
            View CEO dashboard
          </Link>
        </article>
      </section>

      <section className="kv-card">
        <h2 className="kv-section-title">Top Priorities</h2>
        <p className="kv-subtitle">Highest-priority open nudges ranked by score</p>

        {loadingQueue ? (
          <div className="kv-stack" style={{ marginTop: "10px" }}>
            <div className="kv-timeline-skeleton" />
            <div className="kv-timeline-skeleton" />
            <div className="kv-timeline-skeleton" />
          </div>
        ) : !hasUrgent ? (
          <div className="kv-state" style={{ marginTop: "10px" }}>
            <p style={{ margin: 0 }}>All clear. No urgent nudges.</p>
          </div>
        ) : (
          <div className="kv-stack" style={{ marginTop: "10px" }}>
            {items.map((item) => {
              const execution = executedMap[item.id];
              const secondsLeft = execution ? remainingSeconds(execution.undoExpiresAt, tickMs) : 0;

              return (
                <article key={item.id} className="kv-action-item">
                  <div className="kv-row" style={{ justifyContent: "space-between" }}>
                    <div className="kv-row">
                      <span className={severityClass(item.severity)}>{item.severity}</span>
                      <span className="kv-pill">Score {item.priorityScore}</span>
                    </div>
                  </div>

                  <p style={{ margin: "8px 0 4px", fontWeight: 600 }}>{item.message}</p>
                  <p className="kv-note" style={{ marginTop: 0 }}>
                    {item.entityType} #{item.entityId.slice(0, 8)}
                  </p>

                  <div className="kv-row" style={{ marginBottom: "8px" }}>
                    {item.meta?.daysOverdue !== undefined ? (
                      <span className="kv-pill">Days overdue: {item.meta.daysOverdue}</span>
                    ) : null}
                    {item.meta?.amount !== undefined ? (
                      <span className="kv-pill">Amount: {item.meta.amount}</span>
                    ) : null}
                    {item.meta?.dealValue !== undefined ? (
                      <span className="kv-pill">Deal value: {item.meta.dealValue}</span>
                    ) : null}
                    {item.meta?.idleDays !== undefined ? (
                      <span className="kv-pill">Idle days: {item.meta.idleDays}</span>
                    ) : null}
                  </div>

                  <div className="kv-row">
                    {!execution || secondsLeft === 0 ? (
                      <button
                        type="button"
                        className="kv-btn-primary"
                        onClick={() => void onExecute(item.id)}
                        disabled={busyId === item.id}
                      >
                        {busyId === item.id ? "Fixing..." : "Fix now"}
                      </button>
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={() => void onUndo(item.id)}
                          disabled={busyId === item.id || secondsLeft === 0}
                        >
                          {busyId === item.id ? "Undoing..." : "Undo"}
                        </button>
                        <span className="kv-note">Undo available for {secondsLeft}s</span>
                      </>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      <div className="kv-row" style={{ justifyContent: "flex-end", marginTop: "12px" }}>
        <Link href="/nudges" className="kv-btn-primary kv-link-btn">
          View all nudges
        </Link>
      </div>
    </AppShell>
  );
}
