"use client";

import { useEffect, useMemo, useState } from "react";
import {
  acknowledgeIncident,
  addPublicIncidentUpdate,
  addIncidentNote,
  ApiError,
  getIncident,
  getIncidentMetrics,
  getIncidentPostmortem,
  Incident,
  IncidentPostmortem,
  listIncidents,
  publishIncident,
  resolveIncident,
  unpublishIncident,
  updateIncidentSeverity,
  upsertIncidentPostmortem
} from "../../../lib/api";

interface IncidentsTabProps {
  token: string;
}

const statuses: Array<"OPEN" | "ACKNOWLEDGED" | "RESOLVED" | "POSTMORTEM"> = [
  "OPEN",
  "ACKNOWLEDGED",
  "RESOLVED",
  "POSTMORTEM"
];
const severities: Array<"CRITICAL" | "HIGH" | "MEDIUM" | "LOW"> = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];
const statusComponentKeys = ["api", "web", "db", "webhooks", "ai", "billing"];

export function IncidentsTab({ token }: IncidentsTabProps) {
  const [items, setItems] = useState<Incident[]>([]);
  const [selectedIncident, setSelectedIncident] = useState<Incident | null>(null);
  const [postmortem, setPostmortem] = useState<IncidentPostmortem | null>(null);
  const [note, setNote] = useState("");
  const [filters, setFilters] = useState<{
    status: "" | "OPEN" | "ACKNOWLEDGED" | "RESOLVED" | "POSTMORTEM";
    severity: "" | "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  }>({ status: "", severity: "" });
  const [metrics, setMetrics] = useState<{
    totalIncidents: number;
    avgMTTA: number;
    avgMTTR: number;
    openIncidents: number;
    resolvedIncidents: number;
    rangeDays: number;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [publicSummary, setPublicSummary] = useState("");
  const [publicUpdateText, setPublicUpdateText] = useState("");
  const [publicComponentKeys, setPublicComponentKeys] = useState<string[]>([]);

  const [postmortemDraft, setPostmortemDraft] = useState<{
    summary: string;
    rootCause: string;
    impact: string;
    detectionGap: string;
  }>({
    summary: "",
    rootCause: "",
    impact: "",
    detectionGap: ""
  });

  async function loadIncidents(): Promise<void> {
    try {
      setLoading(true);
      setError(null);
      const [listPayload, metricPayload] = await Promise.all([
        listIncidents(token, {
          status: filters.status || undefined,
          severity: filters.severity || undefined,
          page: 1,
          pageSize: 50
        }),
        getIncidentMetrics(token, { range: "30d" })
      ]);
      setItems(listPayload.items);
      setMetrics(metricPayload);
      if (selectedIncident) {
        const refreshed = listPayload.items.find((entry) => entry.id === selectedIncident.id);
        if (!refreshed) {
          setSelectedIncident(null);
          setPostmortem(null);
        }
      }
    } catch (requestFailure) {
      if (requestFailure instanceof ApiError && requestFailure.status === 403) {
        setError("Forbidden: only CEO/ADMIN/On-call can access incidents.");
      } else {
        setError(requestFailure instanceof Error ? requestFailure.message : "Failed to load incidents");
      }
    } finally {
      setLoading(false);
    }
  }

  async function loadIncidentDetail(incidentId: string): Promise<void> {
    try {
      setLoadingDetail(true);
      const [incidentPayload, postmortemPayload] = await Promise.all([
        getIncident(token, incidentId),
        getIncidentPostmortem(token, incidentId)
      ]);
      setSelectedIncident(incidentPayload);
      setPostmortem(postmortemPayload);
      setPostmortemDraft({
        summary: postmortemPayload?.summary ?? "",
        rootCause: postmortemPayload?.rootCause ?? "",
        impact: postmortemPayload?.impact ?? "",
        detectionGap: postmortemPayload?.detectionGap ?? ""
      });
      setPublicSummary(incidentPayload.publicSummary ?? "");
      setPublicComponentKeys(
        Array.isArray(incidentPayload.publicComponentKeys)
          ? incidentPayload.publicComponentKeys.map((entry) => String(entry))
          : []
      );
    } catch (requestFailure) {
      setError(requestFailure instanceof Error ? requestFailure.message : "Failed to load incident detail");
    } finally {
      setLoadingDetail(false);
    }
  }

  useEffect(() => {
    void loadIncidents();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, filters.status, filters.severity]);

  useEffect(() => {
    if (!toast) {
      return;
    }
    const timer = window.setTimeout(() => setToast(null), 2500);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const sortedTimeline = useMemo(
    () => [...(selectedIncident?.timeline ?? [])].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()),
    [selectedIncident?.timeline]
  );

  async function onAcknowledge(): Promise<void> {
    if (!selectedIncident) return;
    const updated = await acknowledgeIncident(token, selectedIncident.id);
    setSelectedIncident(updated);
    setToast("Incident acknowledged.");
    await loadIncidents();
  }

  async function onResolve(): Promise<void> {
    if (!selectedIncident) return;
    const updated = await resolveIncident(token, selectedIncident.id);
    setSelectedIncident(updated);
    setToast("Incident resolved.");
    await loadIncidents();
  }

  async function onChangeSeverity(severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW"): Promise<void> {
    if (!selectedIncident) return;
    const updated = await updateIncidentSeverity(token, selectedIncident.id, { severity });
    setSelectedIncident(updated);
    setToast("Severity updated.");
    await loadIncidents();
  }

  async function onAddNote(): Promise<void> {
    if (!selectedIncident || !note.trim()) return;
    await addIncidentNote(token, selectedIncident.id, { message: note.trim() });
    setNote("");
    await loadIncidentDetail(selectedIncident.id);
    setToast("Note added.");
  }

  async function onSavePostmortem(): Promise<void> {
    if (!selectedIncident) return;
    const saved = await upsertIncidentPostmortem(token, selectedIncident.id, {
      ...postmortemDraft
    });
    setPostmortem(saved);
    setToast("Postmortem saved.");
    await loadIncidents();
    await loadIncidentDetail(selectedIncident.id);
  }

  async function onPublishIncident(): Promise<void> {
    if (!selectedIncident || !publicSummary.trim()) return;
    const updated = await publishIncident(token, selectedIncident.id, {
      publicSummary: publicSummary.trim(),
      componentKeys: publicComponentKeys
    });
    setSelectedIncident(updated);
    setToast("Incident published.");
    await loadIncidentDetail(selectedIncident.id);
    await loadIncidents();
  }

  async function onUnpublishIncident(): Promise<void> {
    if (!selectedIncident) return;
    const updated = await unpublishIncident(token, selectedIncident.id);
    setSelectedIncident(updated);
    setToast("Incident unpublished.");
    await loadIncidentDetail(selectedIncident.id);
    await loadIncidents();
  }

  async function onAddPublicUpdate(): Promise<void> {
    if (!selectedIncident || !publicUpdateText.trim()) return;
    const updated = await addPublicIncidentUpdate(token, selectedIncident.id, {
      message: publicUpdateText.trim()
    });
    setSelectedIncident(updated);
    setPublicUpdateText("");
    setToast("Public update posted.");
    await loadIncidentDetail(selectedIncident.id);
  }

  return (
    <section className="kv-stack" aria-live="polite">
      {error ? <p className="kv-error">{error}</p> : null}
      {toast ? <p style={{ color: "var(--warning-color)", margin: 0 }}>{toast}</p> : null}

      <div className="kv-card">
        <h2 className="kv-section-title" style={{ marginTop: 0 }}>Incident Metrics (30d)</h2>
        <div className="kv-row" style={{ gap: "16px", flexWrap: "wrap" }}>
          <p style={{ margin: 0 }}>Open: <strong>{metrics?.openIncidents ?? 0}</strong></p>
          <p style={{ margin: 0 }}>Resolved: <strong>{metrics?.resolvedIncidents ?? 0}</strong></p>
          <p style={{ margin: 0 }}>Avg MTTA: <strong>{metrics?.avgMTTA ?? 0}m</strong></p>
          <p style={{ margin: 0 }}>Avg MTTR: <strong>{metrics?.avgMTTR ?? 0}m</strong></p>
        </div>
      </div>

      <div className="kv-card">
        <h2 className="kv-section-title" style={{ marginTop: 0 }}>Incidents</h2>
        <div className="kv-row" style={{ gap: "10px", flexWrap: "wrap" }}>
          <select value={filters.status} onChange={(event) => setFilters((prev) => ({ ...prev, status: event.target.value as typeof prev.status }))}>
            <option value="">All statuses</option>
            {statuses.map((status) => <option key={status} value={status}>{status}</option>)}
          </select>
          <select value={filters.severity} onChange={(event) => setFilters((prev) => ({ ...prev, severity: event.target.value as typeof prev.severity }))}>
            <option value="">All severities</option>
            {severities.map((severity) => <option key={severity} value={severity}>{severity}</option>)}
          </select>
        </div>
        <div className="kv-table-wrap" style={{ marginTop: "12px" }}>
          <table>
            <thead>
              <tr>
                <th align="left">Title</th>
                <th align="left">Severity</th>
                <th align="left">Status</th>
                <th align="left">Owner</th>
                <th align="left">Created</th>
                <th align="left">MTTA</th>
                <th align="left">MTTR</th>
                <th align="left">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={8}>Loading incidents...</td></tr>
              ) : items.length === 0 ? (
                <tr><td colSpan={8}>No incidents found.</td></tr>
              ) : (
                items.map((incident) => (
                  <tr key={incident.id}>
                    <td>{incident.title}</td>
                    <td>{incident.severity}</td>
                    <td>{incident.status}</td>
                    <td>{incident.owner?.name ?? "-"}</td>
                    <td>{new Date(incident.createdAt).toLocaleString()}</td>
                    <td>{incident.mttaMinutes ?? "-"}</td>
                    <td>{incident.mttrMinutes ?? "-"}</td>
                    <td><button type="button" onClick={() => void loadIncidentDetail(incident.id)}>Open</button></td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {selectedIncident ? (
        <div className="kv-card">
          <h2 className="kv-section-title" style={{ marginTop: 0 }}>{selectedIncident.title}</h2>
          {loadingDetail ? <p>Loading detail...</p> : null}
          <div className="kv-row" style={{ gap: "10px", flexWrap: "wrap" }}>
            <span className="kv-badge">{selectedIncident.status}</span>
            <span className="kv-badge">{selectedIncident.severity}</span>
            <button type="button" onClick={() => void onAcknowledge()}>Acknowledge</button>
            <button type="button" onClick={() => void onResolve()}>Resolve</button>
            <select value={selectedIncident.severity} onChange={(event) => void onChangeSeverity(event.target.value as Incident["severity"])}>
              {severities.map((entry) => <option key={entry} value={entry}>{entry}</option>)}
            </select>
          </div>

          <h3 className="kv-section-title">Timeline</h3>
          <ul>
            {sortedTimeline.length === 0 ? <li>No timeline entries.</li> : null}
            {sortedTimeline.map((entry) => (
              <li key={entry.id}>
                <strong>{entry.type}</strong> - {entry.message ?? "-"} ({new Date(entry.createdAt).toLocaleString()})
              </li>
            ))}
          </ul>

          <div className="kv-row" style={{ gap: "8px", flexWrap: "wrap" }}>
            <input value={note} onChange={(event) => setNote(event.target.value)} placeholder="Add timeline note" />
            <button type="button" onClick={() => void onAddNote()}>Add note</button>
          </div>

          <h3 className="kv-section-title">Postmortem</h3>
          <div className="kv-stack">
            <textarea value={postmortemDraft.summary} onChange={(event) => setPostmortemDraft((prev) => ({ ...prev, summary: event.target.value }))} placeholder="Summary" rows={3} />
            <textarea value={postmortemDraft.rootCause} onChange={(event) => setPostmortemDraft((prev) => ({ ...prev, rootCause: event.target.value }))} placeholder="Root cause" rows={3} />
            <textarea value={postmortemDraft.impact} onChange={(event) => setPostmortemDraft((prev) => ({ ...prev, impact: event.target.value }))} placeholder="Impact" rows={3} />
            <textarea value={postmortemDraft.detectionGap} onChange={(event) => setPostmortemDraft((prev) => ({ ...prev, detectionGap: event.target.value }))} placeholder="Detection gap" rows={3} />
            <button type="button" onClick={() => void onSavePostmortem()}>Save postmortem</button>
            {postmortem ? <p style={{ margin: 0 }}>Last updated: {new Date(postmortem.updatedAt).toLocaleString()}</p> : null}
          </div>

          <h3 className="kv-section-title">Public Status Publishing</h3>
          <div className="kv-stack">
            <textarea
              value={publicSummary}
              onChange={(event) => setPublicSummary(event.target.value)}
              placeholder="Public summary (no PII)"
              rows={3}
            />
            <div className="kv-row" style={{ flexWrap: "wrap", gap: "8px" }}>
              {statusComponentKeys.map((key) => (
                <label key={key} style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                  <input
                    type="checkbox"
                    checked={publicComponentKeys.includes(key)}
                    onChange={(event) =>
                      setPublicComponentKeys((current) => {
                        if (event.target.checked) {
                          return Array.from(new Set([...current, key]));
                        }
                        return current.filter((entry) => entry !== key);
                      })
                    }
                  />
                  {key}
                </label>
              ))}
            </div>
            <div className="kv-row" style={{ gap: "8px", flexWrap: "wrap" }}>
              <button type="button" onClick={() => void onPublishIncident()}>
                Publish
              </button>
              <button type="button" onClick={() => void onUnpublishIncident()}>
                Unpublish
              </button>
            </div>
            {selectedIncident.isPublic ? (
              <>
                <p style={{ margin: 0 }}>Public slug: {selectedIncident.publicSlug ?? "-"}</p>
                <div className="kv-row" style={{ gap: "8px", flexWrap: "wrap" }}>
                  <input
                    value={publicUpdateText}
                    onChange={(event) => setPublicUpdateText(event.target.value)}
                    placeholder="Public incident update"
                  />
                  <button type="button" onClick={() => void onAddPublicUpdate()}>
                    Post update
                  </button>
                </div>
              </>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}
