"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { AppShell } from "../../../components/app-shell";
import {
  ApiError,
  graphDeeplink,
  graphImpactRadius,
  GraphImpactRadiusPayload,
  GraphNodeRecord,
  listGraphNodes
} from "../../../lib/api";
import { useAuthUser } from "../../../lib/use-auth-user";

const SEARCH_TYPES = ["", "DEAL", "WORK_ITEM", "INVOICE", "INCIDENT", "COMPANY"] as const;
const DIRECTION_OPTIONS = ["BOTH", "OUT", "IN"] as const;

function canAccess(role: string): boolean {
  return role === "CEO" || role === "ADMIN" || role === "OPS";
}

function formatCurrency(cents: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0
  }).format(cents / 100);
}

function formatDate(value: string | null): string {
  if (!value) {
    return "-";
  }
  return new Date(value).toLocaleString();
}

export default function ImpactRadiusPage() {
  const { user, token, loading, error } = useAuthUser();
  const [forbidden, setForbidden] = useState(false);
  const [searchType, setSearchType] = useState<string>("");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchPage, setSearchPage] = useState(1);
  const [searchResults, setSearchResults] = useState<GraphNodeRecord[]>([]);
  const [searchTotal, setSearchTotal] = useState(0);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const [selectedNode, setSelectedNode] = useState<GraphNodeRecord | null>(null);
  const [maxDepth, setMaxDepth] = useState(3);
  const [direction, setDirection] = useState<"BOTH" | "OUT" | "IN">("BOTH");
  const [activeTab, setActiveTab] = useState<"NODES" | "EDGES">("NODES");
  const [radiusData, setRadiusData] = useState<GraphImpactRadiusPayload | null>(null);
  const [radiusLoading, setRadiusLoading] = useState(false);
  const [radiusError, setRadiusError] = useState<string | null>(null);
  const [nodeFilterType, setNodeFilterType] = useState("");
  const [nodeFilterStatus, setNodeFilterStatus] = useState("");

  const pageSize = 20;
  const totalPages = Math.max(1, Math.ceil(searchTotal / pageSize));

  useEffect(() => {
    if (!token || !user || !canAccess(user.role)) {
      return;
    }
    void loadSearch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, user, searchPage]);

  async function loadSearch(): Promise<void> {
    if (!token) {
      return;
    }
    setSearchLoading(true);
    setSearchError(null);
    try {
      const payload = await listGraphNodes(token, {
        page: searchPage,
        pageSize,
        type: searchType || undefined,
        q: searchQuery.trim() || undefined,
        sortBy: "updatedAt",
        sortDir: "desc"
      });
      setSearchResults(payload.items);
      setSearchTotal(payload.total ?? payload.totalCount ?? 0);
      setForbidden(false);
    } catch (requestFailure) {
      if (requestFailure instanceof ApiError && requestFailure.status === 403) {
        setForbidden(true);
        setSearchError(null);
      } else {
        setSearchError(
          requestFailure instanceof Error ? requestFailure.message : "Failed to fetch graph nodes"
        );
      }
    } finally {
      setSearchLoading(false);
    }
  }

  async function recompute(): Promise<void> {
    if (!token || !selectedNode) {
      return;
    }
    setRadiusLoading(true);
    setRadiusError(null);
    try {
      const payload = await graphImpactRadius(token, {
        startNodeId: selectedNode.id,
        maxDepth,
        direction
      });
      setRadiusData(payload);
    } catch (requestFailure) {
      setRadiusError(
        requestFailure instanceof Error ? requestFailure.message : "Failed to compute impact radius"
      );
    } finally {
      setRadiusLoading(false);
    }
  }

  async function openHotspot(nodeId: string): Promise<void> {
    if (!token) {
      return;
    }
    try {
      const target = await graphDeeplink(token, nodeId);
      if (!target.url) {
        window.alert("No deep link configured for this node.");
        return;
      }
      window.location.href = target.url;
    } catch (requestFailure) {
      window.alert(requestFailure instanceof Error ? requestFailure.message : "Failed to open node");
    }
  }

  const filteredNodes = useMemo(() => {
    if (!radiusData) {
      return [];
    }
    return radiusData.nodes.filter((node) => {
      if (nodeFilterType && node.type !== nodeFilterType) {
        return false;
      }
      if (nodeFilterStatus && (node.status ?? "") !== nodeFilterStatus) {
        return false;
      }
      return true;
    });
  }, [radiusData, nodeFilterType, nodeFilterStatus]);

  if (loading) {
    return <p style={{ padding: "24px" }}>Loading...</p>;
  }

  if (error || !user || !token) {
    return <p style={{ padding: "24px" }}>{error ?? "Authentication required."}</p>;
  }

  if (!canAccess(user.role)) {
    return (
      <AppShell user={user} title="Impact Radius">
        <div className="kv-card" style={{ padding: "16px" }}>
          <h2 style={{ marginTop: 0 }}>403: Forbidden</h2>
          <p>Your role is not permitted to access impact radius.</p>
          <Link href="/">Back to dashboard</Link>
        </div>
      </AppShell>
    );
  }

  if (forbidden) {
    return (
      <AppShell user={user} title="Impact Radius">
        <div className="kv-card" style={{ padding: "16px" }}>
          <h2 style={{ marginTop: 0 }}>403: Forbidden</h2>
          <p>Your org role does not have permission for graph impact analysis.</p>
          <Link href="/">Back to dashboard</Link>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell user={user} title="Impact Radius">
      <div className="kv-card" style={{ padding: "16px", marginBottom: "16px" }}>
        <h2 style={{ marginTop: 0 }}>Select Start Node</h2>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center" }}>
          <select value={searchType} onChange={(event) => setSearchType(event.target.value)}>
            {SEARCH_TYPES.map((type) => (
              <option key={type || "ALL"} value={type}>
                {type || "ALL"}
              </option>
            ))}
          </select>
          <input
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Search title / id..."
            style={{ minWidth: "280px" }}
          />
          <button type="button" className="kv-btn-primary" onClick={() => void loadSearch()}>
            Search
          </button>
        </div>
        {searchError ? <p style={{ color: "var(--danger-text)" }}>{searchError}</p> : null}
        {searchLoading ? <p>Loading node matches...</p> : null}
        {!searchLoading && searchResults.length > 0 ? (
          <>
            <table className="kv-table" style={{ marginTop: "12px" }}>
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Title</th>
                  <th>Status</th>
                  <th>Risk</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {searchResults.map((node) => (
                  <tr key={node.id}>
                    <td>{node.type}</td>
                    <td>{node.title ?? node.id}</td>
                    <td>{node.status ?? "-"}</td>
                    <td>{node.riskScore}</td>
                    <td>
                      <button
                        type="button"
                        onClick={() => setSelectedNode(node)}
                        disabled={selectedNode?.id === node.id}
                      >
                        {selectedNode?.id === node.id ? "Selected" : "Select"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={{ marginTop: "10px", display: "flex", gap: "8px", alignItems: "center" }}>
              <button
                type="button"
                onClick={() => setSearchPage((current) => Math.max(1, current - 1))}
                disabled={searchPage <= 1}
              >
                Prev
              </button>
              <span>
                Page {searchPage} / {totalPages}
              </span>
              <button
                type="button"
                onClick={() => setSearchPage((current) => Math.min(totalPages, current + 1))}
                disabled={searchPage >= totalPages}
              >
                Next
              </button>
            </div>
          </>
        ) : null}
      </div>

      <div className="kv-card" style={{ padding: "16px", marginBottom: "16px" }}>
        <h2 style={{ marginTop: 0 }}>Compute Controls</h2>
        <p>Selected node: {selectedNode ? `${selectedNode.title ?? selectedNode.id} (${selectedNode.type})` : "None"}</p>
        <div style={{ display: "flex", gap: "16px", alignItems: "center", flexWrap: "wrap" }}>
          <label>
            Max depth: {maxDepth}
            <input
              type="range"
              min={1}
              max={5}
              value={maxDepth}
              onChange={(event) => setMaxDepth(Number(event.target.value))}
            />
          </label>
          <label>
            Direction
            <select
              value={direction}
              onChange={(event) => setDirection(event.target.value as "BOTH" | "OUT" | "IN")}
            >
              {DIRECTION_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="kv-btn-primary"
            onClick={() => void recompute()}
            disabled={!selectedNode || radiusLoading}
          >
            {radiusLoading ? "Computing..." : "Recompute"}
          </button>
        </div>
        {radiusError ? <p style={{ color: "var(--danger-text)" }}>{radiusError}</p> : null}
      </div>

      {radiusData ? (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(6, minmax(140px, 1fr))", gap: "12px" }}>
            <div className="kv-card" style={{ padding: "12px" }}>
              <p>Money at risk</p>
              <h3 style={{ margin: 0 }}>{formatCurrency(radiusData.summary.moneyAtRiskCents)}</h3>
            </div>
            <div className="kv-card" style={{ padding: "12px" }}>
              <p>Overdue invoices</p>
              <h3 style={{ margin: 0 }}>{radiusData.summary.overdueInvoicesCount}</h3>
            </div>
            <div className="kv-card" style={{ padding: "12px" }}>
              <p>Open work</p>
              <h3 style={{ margin: 0 }}>{radiusData.summary.openWorkCount}</h3>
            </div>
            <div className="kv-card" style={{ padding: "12px" }}>
              <p>Overdue work</p>
              <h3 style={{ margin: 0 }}>{radiusData.summary.overdueWorkCount}</h3>
            </div>
            <div className="kv-card" style={{ padding: "12px" }}>
              <p>Companies impacted</p>
              <h3 style={{ margin: 0 }}>{radiusData.summary.companiesImpactedCount}</h3>
            </div>
            <div className="kv-card" style={{ padding: "12px" }}>
              <p>Incidents</p>
              <h3 style={{ margin: 0 }}>{radiusData.summary.incidentsCount}</h3>
            </div>
          </div>

          <div className="kv-card" style={{ padding: "16px", marginTop: "16px" }}>
            <h2 style={{ marginTop: 0 }}>Hotspots</h2>
            {radiusData.hotspots.length === 0 ? <p>No hotspots found.</p> : null}
            {radiusData.hotspots.length > 0 ? (
              <table className="kv-table">
                <thead>
                  <tr>
                    <th>Title</th>
                    <th>Type</th>
                    <th>Status</th>
                    <th>Due</th>
                    <th>Amount</th>
                    <th>Risk</th>
                    <th>Open</th>
                  </tr>
                </thead>
                <tbody>
                  {radiusData.hotspots.map((node) => (
                    <tr key={node.id}>
                      <td>{node.title ?? node.id}</td>
                      <td>{node.type}</td>
                      <td>{node.status ?? "-"}</td>
                      <td>{formatDate(node.dueAt)}</td>
                      <td>{node.amountCents !== null ? formatCurrency(node.amountCents) : "-"}</td>
                      <td>{node.riskScore}</td>
                      <td>
                        <button type="button" onClick={() => void openHotspot(node.id)}>
                          Open
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
          </div>

          <div className="kv-card" style={{ padding: "16px", marginTop: "16px" }}>
            <div style={{ display: "flex", gap: "8px", marginBottom: "12px" }}>
              <button type="button" onClick={() => setActiveTab("NODES")} disabled={activeTab === "NODES"}>
                Nodes
              </button>
              <button type="button" onClick={() => setActiveTab("EDGES")} disabled={activeTab === "EDGES"}>
                Edges
              </button>
            </div>

            {activeTab === "NODES" ? (
              <>
                <div style={{ display: "flex", gap: "8px", marginBottom: "10px" }}>
                  <input
                    value={nodeFilterType}
                    onChange={(event) => setNodeFilterType(event.target.value)}
                    placeholder="Filter by type"
                  />
                  <input
                    value={nodeFilterStatus}
                    onChange={(event) => setNodeFilterStatus(event.target.value)}
                    placeholder="Filter by status"
                  />
                </div>
                <table className="kv-table">
                  <thead>
                    <tr>
                      <th>Type</th>
                      <th>Title</th>
                      <th>Status</th>
                      <th>Due</th>
                      <th>Amount</th>
                      <th>Risk</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredNodes.map((node) => (
                      <tr key={node.id}>
                        <td>{node.type}</td>
                        <td>{node.title ?? node.id}</td>
                        <td>{node.status ?? "-"}</td>
                        <td>{formatDate(node.dueAt)}</td>
                        <td>{node.amountCents !== null ? formatCurrency(node.amountCents) : "-"}</td>
                        <td>{node.riskScore}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            ) : (
              <table className="kv-table">
                <thead>
                  <tr>
                    <th>From</th>
                    <th>Type</th>
                    <th>To</th>
                    <th>Created</th>
                  </tr>
                </thead>
                <tbody>
                  {radiusData.edges.map((edge) => (
                    <tr key={edge.id}>
                      <td>{edge.fromNodeId}</td>
                      <td>{edge.type}</td>
                      <td>{edge.toNodeId}</td>
                      <td>{formatDate(edge.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      ) : null}
    </AppShell>
  );
}
