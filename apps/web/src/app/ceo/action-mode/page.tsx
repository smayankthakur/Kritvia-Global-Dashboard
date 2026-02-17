"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AppShell } from "../../../components/app-shell";
import {
  AIAction,
  AIActionStatus,
  AIInsight,
  approveAiAction,
  ApiError,
  computeAiActions,
  computeAiInsights,
  CeoBriefingPayload,
  executeAiAction,
  executeNudge,
  generateCeoBriefing,
  getIncidentMetrics,
  listCeoBriefingHistory,
  listAiActions,
  listCeoInsights,
  listNudges,
  Nudge,
  resolveCeoInsight,
  undoAiAction,
  undoNudge
} from "../../../lib/api";
import { useAuthUser } from "../../../lib/use-auth-user";

interface ExecutedState {
  undoExpiresAt: string;
}

const ACTION_STATUS_TABS: AIActionStatus[] = ["PROPOSED", "APPROVED", "EXECUTED", "FAILED"];

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

function insightSeverityClass(severity: AIInsight["severity"]): string {
  if (severity === "CRITICAL") {
    return "kv-badge-danger";
  }
  if (severity === "HIGH") {
    return "kv-badge-warning";
  }
  return "kv-badge";
}

function getInsightLink(type: AIInsight["type"]): string {
  if (type === "DEAL_STALL") {
    return "/sales/deals?filter=stale";
  }
  if (type === "CASHFLOW_ALERT") {
    return "/finance/invoices?filter=overdue";
  }
  if (type === "OPS_RISK") {
    return "/ops/work/list?due=overdue";
  }
  if (type === "SHIELD_RISK") {
    return "/shield";
  }
  return "/ceo/dashboard";
}

function formatMetaValue(value: unknown): string {
  if (typeof value === "number") {
    return Number.isInteger(value) ? String(value) : value.toFixed(1);
  }
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value);
}

function remainingSeconds(undoExpiresAt: string, nowMs: number): number {
  const delta = new Date(undoExpiresAt).getTime() - nowMs;
  return Math.max(0, Math.ceil(delta / 1000));
}

function canUndoAction(action: AIAction, nowMs: number): boolean {
  if (action.status !== "EXECUTED" || !action.undoExpiresAt) {
    return false;
  }
  return remainingSeconds(action.undoExpiresAt, nowMs) > 0;
}

function safeBriefingLink(link?: string): string {
  if (!link || !link.startsWith("/")) {
    return "/ceo/dashboard";
  }
  return link;
}

function toBriefingText(payload: CeoBriefingPayload): string {
  const risks = payload.topRisks
    .map((risk, index) => `${index + 1}. ${risk.title}${risk.summary ? ` - ${risk.summary}` : ""}`)
    .join("\n");
  const actions = payload.recommendedNextActions
    .map((item, index) => `${index + 1}. ${item.title}${item.summary ? ` - ${item.summary}` : ""}`)
    .join("\n");

  return [
    "# CEO Briefing",
    "",
    "## Executive Summary",
    payload.executiveSummary || "No summary available.",
    "",
    "## Top Risks",
    risks || "No risks.",
    "",
    "## Recommended Next Actions",
    actions || "No actions."
  ].join("\n");
}

export default function CeoActionModePage() {
  const { user, token, loading, error } = useAuthUser();
  const [items, setItems] = useState<Nudge[]>([]);
  const [insights, setInsights] = useState<AIInsight[]>([]);
  const [actions, setActions] = useState<AIAction[]>([]);
  const [actionTab, setActionTab] = useState<AIActionStatus>("PROPOSED");
  const [executedMap, setExecutedMap] = useState<Record<string, ExecutedState>>({});
  const [requestError, setRequestError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [loadingQueue, setLoadingQueue] = useState(false);
  const [loadingInsights, setLoadingInsights] = useState(false);
  const [loadingActions, setLoadingActions] = useState(false);
  const [briefing, setBriefing] = useState<CeoBriefingPayload | null>(null);
  const [briefingHistory, setBriefingHistory] = useState<CeoBriefingPayload[]>([]);
  const [loadingBriefing, setLoadingBriefing] = useState(false);
  const [loadingBriefingHistory, setLoadingBriefingHistory] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [busyInsightId, setBusyInsightId] = useState<string | null>(null);
  const [busyActionId, setBusyActionId] = useState<string | null>(null);
  const [refreshingInsights, setRefreshingInsights] = useState(false);
  const [generatingActions, setGeneratingActions] = useState(false);
  const [tickMs, setTickMs] = useState(Date.now());
  const [incidentMetrics, setIncidentMetrics] = useState<{
    totalIncidents: number;
    avgMTTA: number;
    avgMTTR: number;
    openIncidents: number;
    resolvedIncidents: number;
    rangeDays: number;
  } | null>(null);

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

  const loadInsights = useCallback(async (): Promise<void> => {
    if (!token) {
      return;
    }

    try {
      setLoadingInsights(true);
      const payload = await listCeoInsights(token);
      setInsights(payload.slice(0, 5));
      setForbidden(false);
    } catch (requestFailure) {
      if (requestFailure instanceof ApiError && requestFailure.status === 403) {
        setForbidden(true);
        return;
      }
      setRequestError(
        requestFailure instanceof Error ? requestFailure.message : "Failed to load AI insights"
      );
    } finally {
      setLoadingInsights(false);
    }
  }, [token]);

  const loadAiActions = useCallback(
    async (status: AIActionStatus): Promise<void> => {
      if (!token) {
        return;
      }

      try {
        setLoadingActions(true);
        const payload = await listAiActions(token, {
          status,
          page: 1,
          pageSize: 10
        });
        setActions(payload.items);
        setForbidden(false);
      } catch (requestFailure) {
        if (requestFailure instanceof ApiError && requestFailure.status === 403) {
          setForbidden(true);
          return;
        }
        setRequestError(
          requestFailure instanceof Error ? requestFailure.message : "Failed to load AI actions"
        );
      } finally {
        setLoadingActions(false);
      }
    },
    [token]
  );

  useEffect(() => {
    if (!user || !token || !canAccess(user.role)) {
      return;
    }
    void loadTopNudges();
    void loadInsights();
  }, [loadInsights, loadTopNudges, token, user]);

  useEffect(() => {
    if (!token || !user || !canAccess(user.role)) {
      return;
    }
    getIncidentMetrics(token, { range: "30d" })
      .then((payload) => setIncidentMetrics(payload))
      .catch(() => setIncidentMetrics(null));
  }, [token, user]);

  useEffect(() => {
    if (!user || !token || !canAccess(user.role)) {
      return;
    }
    void loadAiActions(actionTab);
  }, [actionTab, loadAiActions, token, user]);

  useEffect(() => {
    if (!toast) {
      return;
    }
    const timer = window.setTimeout(() => setToast(null), 2500);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const hasUrgent = useMemo(() => items.length > 0, [items]);
  const hasCriticalInsight = useMemo(
    () => insights.some((insight) => insight.severity === "CRITICAL"),
    [insights]
  );

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

  async function onResolveInsight(id: string): Promise<void> {
    if (!token) {
      return;
    }
    const snapshot = insights;
    setBusyInsightId(id);
    setInsights((prev) => prev.filter((item) => item.id !== id));
    try {
      await resolveCeoInsight(token, id);
      setToast("Insight resolved.");
    } catch (requestFailure) {
      setInsights(snapshot);
      setRequestError(
        requestFailure instanceof Error ? requestFailure.message : "Failed to resolve insight"
      );
    } finally {
      setBusyInsightId(null);
    }
  }

  async function onRefreshInsights(): Promise<void> {
    if (!token || !user || user.role !== "ADMIN") {
      return;
    }
    try {
      setRefreshingInsights(true);
      const summary = await computeAiInsights(token);
      await loadInsights();
      setToast(
        `Insights refreshed: ${summary.total} total, ${summary.critical} critical, ${summary.high} high.`
      );
    } catch (requestFailure) {
      if (requestFailure instanceof ApiError && requestFailure.code === "UPGRADE_REQUIRED") {
        setRequestError("Upgrade required. Open /billing to enable AI insights.");
        return;
      }
      setRequestError(
        requestFailure instanceof Error ? requestFailure.message : "Failed to refresh insights"
      );
    } finally {
      setRefreshingInsights(false);
    }
  }

  async function onGenerateActions(): Promise<void> {
    if (!token || !user || user.role !== "ADMIN") {
      return;
    }
    try {
      setGeneratingActions(true);
      const summary = await computeAiActions(token);
      await loadAiActions(actionTab);
      setToast(
        `Actions generated: ${summary.created} created, ${summary.skipped} skipped, ${summary.totalProposed} proposed.`
      );
    } catch (requestFailure) {
      if (requestFailure instanceof ApiError && requestFailure.code === "UPGRADE_REQUIRED") {
        setRequestError("Upgrade required. Open /billing to enable AI actions.");
        return;
      }
      setRequestError(
        requestFailure instanceof Error ? requestFailure.message : "Failed to generate actions"
      );
    } finally {
      setGeneratingActions(false);
    }
  }

  async function onApproveAction(id: string): Promise<void> {
    if (!token) {
      return;
    }
    try {
      setBusyActionId(id);
      await approveAiAction(token, id);
      await loadAiActions(actionTab);
      setToast("AI action approved.");
    } catch (requestFailure) {
      setRequestError(
        requestFailure instanceof Error ? requestFailure.message : "Failed to approve AI action"
      );
    } finally {
      setBusyActionId(null);
    }
  }

  async function onExecuteAction(id: string): Promise<void> {
    if (!token) {
      return;
    }
    try {
      setBusyActionId(id);
      await executeAiAction(token, id);
      await loadAiActions(actionTab);
      setToast("AI action executed.");
    } catch (requestFailure) {
      setRequestError(
        requestFailure instanceof Error ? requestFailure.message : "Failed to execute AI action"
      );
    } finally {
      setBusyActionId(null);
    }
  }

  async function onUndoAction(id: string): Promise<void> {
    if (!token) {
      return;
    }
    try {
      setBusyActionId(id);
      await undoAiAction(token, id);
      await loadAiActions(actionTab);
      setToast("AI action undone.");
    } catch (requestFailure) {
      setRequestError(requestFailure instanceof Error ? requestFailure.message : "Failed to undo AI action");
    } finally {
      setBusyActionId(null);
    }
  }

  async function onGenerateBriefing(): Promise<void> {
    if (!token) {
      return;
    }
    try {
      setLoadingBriefing(true);
      const payload = await generateCeoBriefing(token, 7);
      setBriefing(payload);
      setToast(payload.cached ? "CEO briefing loaded from cache." : "CEO briefing generated.");
    } catch (requestFailure) {
      if (requestFailure instanceof ApiError) {
        if (requestFailure.code === "LLM_DISABLED") {
          setRequestError("LLM is disabled. Enable it in settings to generate CEO briefing.");
          return;
        }
        if (requestFailure.code === "UPGRADE_REQUIRED") {
          setRequestError("Upgrade required. Open /billing to enable CEO briefing.");
          return;
        }
        if (requestFailure.code === "LLM_INVALID_OUTPUT") {
          setRequestError("Briefing output was invalid. Retry generation.");
          return;
        }
      }
      setRequestError(
        requestFailure instanceof Error ? requestFailure.message : "Failed to generate CEO briefing"
      );
    } finally {
      setLoadingBriefing(false);
    }
  }

  async function onOpenHistory(): Promise<void> {
    if (!token) {
      return;
    }
    try {
      setHistoryOpen(true);
      setLoadingBriefingHistory(true);
      const payload = await listCeoBriefingHistory(token);
      setBriefingHistory(payload);
    } catch (requestFailure) {
      setRequestError(
        requestFailure instanceof Error ? requestFailure.message : "Failed to load briefing history"
      );
    } finally {
      setLoadingBriefingHistory(false);
    }
  }

  async function onCopyBriefing(): Promise<void> {
    if (!briefing) {
      return;
    }
    try {
      const text = briefing.contentText?.trim().length ? briefing.contentText : toBriefingText(briefing);
      await navigator.clipboard.writeText(text);
      setToast("Briefing copied.");
    } catch {
      setRequestError("Copy failed. Please retry.");
    }
  }

  function onDownloadBriefing(): void {
    if (!briefing) {
      return;
    }
    const text = briefing.contentText?.trim().length ? briefing.contentText : toBriefingText(briefing);
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = window.URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `ceo_briefing_${new Date().toISOString().slice(0, 10)}.txt`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.URL.revokeObjectURL(url);
    setToast("Briefing downloaded.");
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
          <button
            type="button"
            onClick={() => {
              void loadTopNudges();
              void loadInsights();
              void loadAiActions(actionTab);
              if (historyOpen) {
                void onOpenHistory();
              }
            }}
          >
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
        <article className="kv-card">
          <h3 style={{ margin: 0 }}>Open Incidents</h3>
          <p className="kv-subtitle">Incident load (last 30 days)</p>
          <p style={{ margin: "10px 0 0", fontWeight: 700 }}>
            {incidentMetrics?.openIncidents ?? 0}
          </p>
          <Link href="/developer?tab=incidents" className="kv-note">
            Open incidents panel
          </Link>
        </article>
        <article className="kv-card">
          <h3 style={{ margin: 0 }}>SLA Metrics</h3>
          <p className="kv-subtitle">Avg acknowledge and resolve speed</p>
          <p style={{ margin: "10px 0 0", fontWeight: 700 }}>
            MTTA {incidentMetrics?.avgMTTA ?? 0}m | MTTR {incidentMetrics?.avgMTTR ?? 0}m
          </p>
          <Link href="/developer?tab=incidents" className="kv-note">
            View incident timelines
          </Link>
        </article>
      </section>

      <section className="kv-card" style={{ marginBottom: "12px" }}>
        <div className="kv-row" style={{ justifyContent: "space-between" }}>
          <div>
            <h2 className="kv-section-title" style={{ marginBottom: "4px" }}>
              CEO Briefing (AI)
            </h2>
            <p className="kv-subtitle" style={{ margin: 0 }}>
              Weekly executive digest with linked risks and action recommendations
            </p>
          </div>
          <div className="kv-row">
            <button type="button" onClick={() => void onGenerateBriefing()} disabled={loadingBriefing}>
              {loadingBriefing ? "Generating..." : "Generate Briefing"}
            </button>
            <button type="button" onClick={() => void onOpenHistory()} disabled={loadingBriefingHistory}>
              History
            </button>
          </div>
        </div>

        {loadingBriefing ? (
          <div className="kv-stack" style={{ marginTop: "10px" }}>
            <div className="kv-timeline-skeleton" />
            <div className="kv-timeline-skeleton" />
            <div className="kv-timeline-skeleton" />
          </div>
        ) : !briefing ? (
          <div className="kv-state" style={{ marginTop: "10px" }}>
            <p style={{ margin: 0 }}>No briefing generated yet. Generate one for the last 7 days.</p>
          </div>
        ) : (
          <div className="kv-stack" style={{ marginTop: "10px" }}>
            <div className="kv-row" style={{ justifyContent: "space-between" }}>
              <p style={{ margin: 0, fontWeight: 600 }}>Executive Summary</p>
              <div className="kv-row">
                {briefing.cached ? <span className="kv-pill">Cached</span> : null}
                <button type="button" onClick={() => void onCopyBriefing()}>
                  Copy
                </button>
                <button type="button" onClick={onDownloadBriefing}>
                  Download
                </button>
              </div>
            </div>
            <p style={{ margin: 0 }}>{briefing.executiveSummary}</p>

            <div>
              <p style={{ marginBottom: "6px", fontWeight: 600 }}>Top Risks</p>
              {briefing.topRisks.length === 0 ? (
                <p className="kv-note" style={{ margin: 0 }}>No top risks.</p>
              ) : (
                <div className="kv-stack">
                  {briefing.topRisks.map((risk, index) => (
                    <div key={`${risk.title}-${index}`} className="kv-action-item">
                      <div className="kv-row" style={{ justifyContent: "space-between" }}>
                        <p style={{ margin: 0, fontWeight: 600 }}>{risk.title}</p>
                        <Link href={safeBriefingLink(risk.deepLink)} className="kv-btn-primary kv-link-btn">
                          Open
                        </Link>
                      </div>
                      {risk.summary ? <p className="kv-note" style={{ marginBottom: 0 }}>{risk.summary}</p> : null}
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div>
              <p style={{ marginBottom: "6px", fontWeight: 600 }}>Recommended Next Actions</p>
              {briefing.recommendedNextActions.length === 0 ? (
                <p className="kv-note" style={{ margin: 0 }}>No recommendations.</p>
              ) : (
                <div className="kv-stack">
                  {briefing.recommendedNextActions.map((actionItem, index) => (
                    <div key={`${actionItem.title}-${index}`} className="kv-action-item">
                      <div className="kv-row" style={{ justifyContent: "space-between" }}>
                        <p style={{ margin: 0, fontWeight: 600 }}>{actionItem.title}</p>
                        <Link
                          href={safeBriefingLink(actionItem.deepLink)}
                          className="kv-btn-primary kv-link-btn"
                        >
                          Open
                        </Link>
                      </div>
                      {actionItem.summary ? (
                        <p className="kv-note" style={{ marginBottom: 0 }}>{actionItem.summary}</p>
                      ) : null}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </section>

      {historyOpen ? (
        <section className="kv-card" style={{ marginBottom: "12px" }}>
          <div className="kv-row" style={{ justifyContent: "space-between" }}>
            <h2 className="kv-section-title" style={{ marginBottom: 0 }}>
              CEO Briefing History
            </h2>
            <button type="button" onClick={() => setHistoryOpen(false)}>
              Close
            </button>
          </div>
          {loadingBriefingHistory ? (
            <div className="kv-stack" style={{ marginTop: "10px" }}>
              <div className="kv-timeline-skeleton" />
              <div className="kv-timeline-skeleton" />
            </div>
          ) : briefingHistory.length === 0 ? (
            <div className="kv-state" style={{ marginTop: "10px" }}>
              <p style={{ margin: 0 }}>No historical briefings yet.</p>
            </div>
          ) : (
            <div className="kv-stack" style={{ marginTop: "10px" }}>
              {briefingHistory.map((item, index) => (
                <article key={item.id ?? `${item.createdAt ?? "history"}-${index}`} className="kv-action-item">
                  <div className="kv-row" style={{ justifyContent: "space-between" }}>
                    <span className="kv-pill">{item.type ?? "CEO_DAILY_BRIEF"}</span>
                    <span className="kv-note">
                      {item.createdAt ? new Date(item.createdAt).toLocaleString() : "Unknown time"}
                    </span>
                  </div>
                  <p style={{ marginTop: "8px", marginBottom: 0 }}>
                    {item.executiveSummary || "No summary available"}
                  </p>
                </article>
              ))}
            </div>
          )}
        </section>
      ) : null}

      <section className="kv-card" style={{ marginBottom: "12px" }}>
        <div
          className={`kv-row ${hasCriticalInsight ? "kv-insights-header-alert" : ""}`}
          style={{ justifyContent: "space-between" }}
        >
          <div>
            <h2 className="kv-section-title" style={{ marginBottom: "4px" }}>
              AI Execution Insights
            </h2>
            <p className="kv-subtitle" style={{ margin: 0 }}>
              Deterministic risk signals for the CEO action queue
            </p>
          </div>
          <div className="kv-row">
            <span className="kv-pill">{insights.length} showing</span>
            {user.role === "ADMIN" ? (
              <button
                type="button"
                onClick={() => void onRefreshInsights()}
                disabled={refreshingInsights}
              >
                {refreshingInsights ? "Refreshing..." : "Refresh insights"}
              </button>
            ) : null}
          </div>
        </div>

        {loadingInsights ? (
          <div className="kv-stack" style={{ marginTop: "10px" }}>
            <div className="kv-timeline-skeleton" />
            <div className="kv-timeline-skeleton" />
            <div className="kv-timeline-skeleton" />
          </div>
        ) : insights.length === 0 ? (
          <div className="kv-state" style={{ marginTop: "10px" }}>
            <p style={{ margin: 0 }}>All clear - no critical execution risks detected.</p>
          </div>
        ) : (
          <div className="kv-stack" style={{ marginTop: "10px" }}>
            {insights.map((insight) => {
              const meta = insight.meta ?? {};
              const chips = [
                ["overdueAmount", "Overdue INR"],
                ["stalledDeals", "Stalled deals"],
                ["overdueInvoices", "Overdue invoices"],
                ["overdueWork", "Overdue work"],
                ["criticalEvents", "Critical events"],
                ["delta", "Delta"]
              ] as const;

              return (
                <article key={insight.id} className="kv-action-item">
                  <div className="kv-row" style={{ justifyContent: "space-between" }}>
                    <span className={insightSeverityClass(insight.severity)}>{insight.severity}</span>
                    <span className="kv-pill">Impact +{insight.scoreImpact}</span>
                  </div>

                  <h3 className="kv-insight-title">{insight.title}</h3>
                  <p className="kv-insight-explanation">{insight.explanation}</p>

                  <div className="kv-row" style={{ marginBottom: "8px" }}>
                    {chips.map(([key, label]) =>
                      key in meta ? (
                        <span className="kv-pill" key={key}>
                          {label}: {formatMetaValue((meta as Record<string, unknown>)[key])}
                        </span>
                      ) : null
                    )}
                  </div>

                  <div className="kv-row">
                    <Link href={getInsightLink(insight.type)} className="kv-btn-primary kv-link-btn">
                      Open
                    </Link>
                    <button
                      type="button"
                      onClick={() => void onResolveInsight(insight.id)}
                      disabled={busyInsightId === insight.id}
                    >
                      {busyInsightId === insight.id ? "Resolving..." : "Resolve"}
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      <section className="kv-card">
        <div className="kv-row" style={{ justifyContent: "space-between" }}>
          <div>
            <h2 className="kv-section-title" style={{ marginBottom: "4px" }}>
              AI Actions Inbox
            </h2>
            <p className="kv-subtitle" style={{ margin: 0 }}>
              Review, approve, execute, and undo deterministic action proposals
            </p>
          </div>
          <div className="kv-row">
            <span className="kv-pill">{actions.length} in tab</span>
            {user.role === "ADMIN" ? (
              <button
                type="button"
                onClick={() => void onGenerateActions()}
                disabled={generatingActions}
              >
                {generatingActions ? "Generating..." : "Generate actions"}
              </button>
            ) : null}
          </div>
        </div>
        <div className="kv-row" style={{ marginTop: "10px", marginBottom: "10px", gap: "8px" }}>
          {ACTION_STATUS_TABS.map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setActionTab(tab)}
              className={actionTab === tab ? "kv-btn-primary" : ""}
              disabled={loadingActions}
            >
              {tab}
            </button>
          ))}
        </div>

        {loadingActions ? (
          <div className="kv-stack" style={{ marginTop: "10px", marginBottom: "12px" }}>
            <div className="kv-timeline-skeleton" />
            <div className="kv-timeline-skeleton" />
            <div className="kv-timeline-skeleton" />
          </div>
        ) : actions.length === 0 ? (
          <div className="kv-state" style={{ marginTop: "10px", marginBottom: "12px" }}>
            <p style={{ margin: 0 }}>No {actionTab.toLowerCase()} AI actions right now.</p>
          </div>
        ) : (
          <div className="kv-stack" style={{ marginTop: "10px", marginBottom: "12px" }}>
            {actions.map((action) => {
              const undoable = canUndoAction(action, tickMs);
              return (
                <article key={action.id} className="kv-action-item">
                  <div className="kv-row" style={{ justifyContent: "space-between" }}>
                    <div className="kv-row">
                      <span className="kv-pill">{action.type}</span>
                      <span className={action.status === "FAILED" ? "kv-badge-danger" : "kv-badge"}>
                        {action.status}
                      </span>
                    </div>
                    <span className="kv-note">{new Date(action.createdAt).toLocaleString()}</span>
                  </div>

                  <h3 className="kv-insight-title">{action.title}</h3>
                  <p className="kv-insight-explanation">{action.rationale}</p>

                  <div className="kv-row" style={{ marginBottom: "8px" }}>
                    {action.insightId ? (
                      <span className="kv-pill">Insight: {action.insightId.slice(0, 8)}</span>
                    ) : null}
                    {action.error ? <span className="kv-badge-danger">Error: {action.error}</span> : null}
                    {undoable && action.undoExpiresAt ? (
                      <span className="kv-note">
                        Undo available for {remainingSeconds(action.undoExpiresAt, tickMs)}s
                      </span>
                    ) : null}
                  </div>

                  <div className="kv-row">
                    {action.status === "PROPOSED" ? (
                      <button
                        type="button"
                        onClick={() => void onApproveAction(action.id)}
                        disabled={busyActionId === action.id}
                      >
                        {busyActionId === action.id ? "Approving..." : "Approve"}
                      </button>
                    ) : null}
                    {(action.status === "APPROVED" || action.status === "PROPOSED") ? (
                      <button
                        type="button"
                        className="kv-btn-primary"
                        onClick={() => void onExecuteAction(action.id)}
                        disabled={busyActionId === action.id || action.status !== "APPROVED"}
                        title={action.status !== "APPROVED" ? "Approve first" : undefined}
                      >
                        {busyActionId === action.id ? "Executing..." : "Execute"}
                      </button>
                    ) : null}
                    {action.status === "EXECUTED" ? (
                      <button
                        type="button"
                        onClick={() => void onUndoAction(action.id)}
                        disabled={busyActionId === action.id || !undoable}
                      >
                        {busyActionId === action.id ? "Undoing..." : "Undo"}
                      </button>
                    ) : null}
                  </div>
                </article>
              );
            })}
          </div>
        )}

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
