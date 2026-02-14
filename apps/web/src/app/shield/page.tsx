"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AppShell } from "../../components/app-shell";
import {
  ApiError,
  SecurityEvent,
  listShieldEvents,
  resolveShieldEvent
} from "../../lib/api";
import { useAuthUser } from "../../lib/use-auth-user";

function canAccess(role: string): boolean {
  return role === "CEO" || role === "ADMIN";
}

function severityClass(severity: SecurityEvent["severity"]): string {
  if (severity === "CRITICAL") {
    return "kv-badge-danger";
  }
  if (severity === "HIGH") {
    return "kv-badge-warning";
  }
  return "kv-badge";
}

function entityHref(event: SecurityEvent): string {
  if (!event.entityType || !event.entityId) {
    return "#";
  }
  if (event.entityType === "INVOICE") {
    return `/finance/invoices/${event.entityId}`;
  }
  if (event.entityType === "WORK_ITEM") {
    return `/work/${event.entityId}`;
  }
  if (event.entityType === "DEAL") {
    return "/sales/deals";
  }
  if (event.entityType === "USER") {
    return "/admin/users";
  }
  return "#";
}

export default function ShieldPage() {
  const { user, token, loading, error } = useAuthUser();
  const [events, setEvents] = useState<SecurityEvent[]>([]);
  const [loadingEvents, setLoadingEvents] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [busyEventId, setBusyEventId] = useState<string | null>(null);

  const loadEvents = useCallback(async (): Promise<void> => {
    if (!token) {
      return;
    }

    try {
      setLoadingEvents(true);
      setRequestError(null);
      const payload = await listShieldEvents(token, {
        resolved: false,
        page: 1,
        pageSize: 50,
        sortBy: "createdAt",
        sortDir: "desc"
      });
      setEvents(payload.items);
      setForbidden(false);
    } catch (requestFailure) {
      if (requestFailure instanceof ApiError && requestFailure.status === 403) {
        setForbidden(true);
        return;
      }
      setRequestError(
        requestFailure instanceof Error ? requestFailure.message : "Failed to load shield events"
      );
    } finally {
      setLoadingEvents(false);
    }
  }, [token]);

  useEffect(() => {
    if (!user || !token || !canAccess(user.role)) {
      return;
    }
    void loadEvents();
  }, [loadEvents, token, user]);

  useEffect(() => {
    if (!toast) {
      return;
    }
    const timer = window.setTimeout(() => setToast(null), 2500);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const severityCounts = useMemo(() => {
    const counts = {
      CRITICAL: 0,
      HIGH: 0,
      MEDIUM: 0,
      LOW: 0
    };
    for (const event of events) {
      if (event.severity in counts) {
        counts[event.severity as keyof typeof counts] += 1;
      }
    }
    return counts;
  }, [events]);

  const securityScore = Math.max(
    0,
    100 -
      severityCounts.CRITICAL * 25 -
      severityCounts.HIGH * 10 -
      severityCounts.MEDIUM * 5 -
      severityCounts.LOW * 2
  );

  async function onResolve(id: string): Promise<void> {
    if (!token) {
      return;
    }

    const previous = events;
    setEvents((current) => current.filter((entry) => entry.id !== id));
    setBusyEventId(id);
    try {
      await resolveShieldEvent(token, id);
      setToast("Threat resolved.");
    } catch (requestFailure) {
      setEvents(previous);
      setRequestError(
        requestFailure instanceof Error ? requestFailure.message : "Failed to resolve security event"
      );
    } finally {
      setBusyEventId(null);
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
      <AppShell user={user} title="Sudarshan Shield">
        <div className="kv-state">
          <h2 style={{ marginTop: 0 }}>403: Forbidden</h2>
          <p>Only CEO and ADMIN can access Sudarshan Shield.</p>
          <Link href="/">Back to dashboard</Link>
        </div>
      </AppShell>
    );
  }

  if (forbidden) {
    return (
      <AppShell user={user} title="Sudarshan Shield">
        <div className="kv-state">
          <h2 style={{ marginTop: 0 }}>403: Forbidden</h2>
          <p>You do not have permission to view shield events.</p>
          <Link href="/">Back to dashboard</Link>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell user={user} title="Sudarshan Shield">
      {toast ? <p style={{ color: "var(--success-color)" }}>{toast}</p> : null}

      {requestError ? (
        <div className="kv-state" style={{ marginBottom: "12px" }}>
          <p className="kv-error" style={{ marginTop: 0 }}>
            {requestError}
          </p>
          <button type="button" onClick={() => void loadEvents()}>
            Retry
          </button>
        </div>
      ) : null}

      <section className="kv-grid-2" style={{ marginBottom: "12px" }}>
        <article className="kv-card">
          <h3 style={{ margin: 0 }}>Security Score</h3>
          <p className="kv-subtitle">Real-time threat-weighted posture</p>
          <p className="kv-score">{securityScore}</p>
        </article>
        <article className="kv-card">
          <h3 style={{ margin: 0 }}>Threat Summary</h3>
          <div className="kv-row" style={{ marginTop: "10px" }}>
            <span className="kv-badge-danger">CRITICAL: {severityCounts.CRITICAL}</span>
            <span className="kv-badge-warning">HIGH: {severityCounts.HIGH}</span>
            <span className="kv-badge">MEDIUM: {severityCounts.MEDIUM}</span>
            <span className="kv-pill">LOW: {severityCounts.LOW}</span>
          </div>
        </article>
      </section>

      <section className="kv-card">
        <h2 className="kv-section-title">Active Security Events</h2>
        {loadingEvents ? (
          <div className="kv-stack">
            <div className="kv-timeline-skeleton" />
            <div className="kv-timeline-skeleton" />
            <div className="kv-timeline-skeleton" />
          </div>
        ) : events.length === 0 ? (
          <div className="kv-state">
            <p style={{ margin: 0 }}>Shield clear. No active threats.</p>
          </div>
        ) : (
          <div className="kv-stack">
            {events.map((event) => (
              <article key={event.id} className="kv-action-item">
                <div className="kv-row" style={{ justifyContent: "space-between" }}>
                  <div className="kv-row">
                    <span className={severityClass(event.severity)}>{event.severity}</span>
                    <span className="kv-pill">{event.type}</span>
                  </div>
                  <span className="kv-note">{new Date(event.createdAt).toLocaleString()}</span>
                </div>
                <p style={{ margin: "8px 0" }}>{event.description}</p>
                {event.entityType && event.entityId ? (
                  <p className="kv-note" style={{ marginTop: 0 }}>
                    <Link href={entityHref(event)}>
                      {event.entityType} #{event.entityId.slice(0, 8)}
                    </Link>
                  </p>
                ) : null}
                <div className="kv-row">
                  <button
                    type="button"
                    onClick={() => void onResolve(event.id)}
                    disabled={busyEventId === event.id}
                  >
                    {busyEventId === event.id ? "Resolving..." : "Resolve"}
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </AppShell>
  );
}
