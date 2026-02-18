"use client";

import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";
import { AppShell } from "../../../components/app-shell";
import {
  ApiError,
  getGraphNode,
  GraphNodeDetailPayload,
  listGraphNodes
} from "../../../lib/api";
import { getAccessToken } from "../../../lib/auth";
import { useAuthUser } from "../../../lib/use-auth-user";

const NODE_TYPES = [
  "",
  "DEAL",
  "WORK_ITEM",
  "INVOICE",
  "COMPANY",
  "CONTACT",
  "LEAD",
  "PAYMENT",
  "INCIDENT",
  "USER",
  "NUDGE",
  "AI_INSIGHT",
  "AI_ACTION"
];

function canAccess(role: string): boolean {
  return role === "CEO" || role === "ADMIN";
}

export default function AdminGraphPage() {
  const { user, loading } = useAuthUser();
  const [nodeType, setNodeType] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [nodes, setNodes] = useState<
    Array<{ id: string; type: string; title: string | null; status: string | null; riskScore: number }>
  >([]);
  const [total, setTotal] = useState(0);
  const [pageSize] = useState(20);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedDetail, setSelectedDetail] = useState<GraphNodeDetailPayload | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [loadingNodes, setLoadingNodes] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);

  useEffect(() => {
    const token = getAccessToken();
    if (!token || !user || !canAccess(user.role)) {
      return;
    }
    setLoadingNodes(true);
    listGraphNodes(token, {
      page,
      pageSize,
      type: nodeType || undefined,
      q: query || undefined,
      sortBy: "updatedAt",
      sortDir: "desc"
    })
      .then((payload) => {
        setNodes(payload.items);
        setTotal(payload.total ?? payload.totalCount ?? 0);
        setRequestError(null);
        setForbidden(false);
      })
      .catch((requestFailure: unknown) => {
        if (requestFailure instanceof ApiError && requestFailure.status === 403) {
          setForbidden(true);
          setRequestError(null);
          return;
        }
        setRequestError(
          requestFailure instanceof Error ? requestFailure.message : "Failed to load graph nodes"
        );
      })
      .finally(() => setLoadingNodes(false));
  }, [user, page, pageSize, nodeType, query]);

  useEffect(() => {
    if (!selectedNodeId) {
      setSelectedDetail(null);
      return;
    }
    const token = getAccessToken();
    if (!token) {
      return;
    }
    setLoadingDetail(true);
    getGraphNode(token, selectedNodeId)
      .then((payload) => {
        setSelectedDetail(payload);
        setRequestError(null);
      })
      .catch((requestFailure: unknown) => {
        setRequestError(
          requestFailure instanceof Error ? requestFailure.message : "Failed to load graph node detail"
        );
      })
      .finally(() => setLoadingDetail(false));
  }, [selectedNodeId]);

  if (loading || !user) {
    return <p style={{ padding: "24px" }}>Loading...</p>;
  }

  if (!canAccess(user.role)) {
    return (
      <AppShell user={user} title="Execution Graph">
        <div className="kv-card" style={{ padding: "16px" }}>
          <h2 style={{ marginTop: 0 }}>403: Forbidden</h2>
          <p>Only CEO and ADMIN can access graph exploration.</p>
          <Link href="/">Back to dashboard</Link>
        </div>
      </AppShell>
    );
  }

  if (forbidden) {
    return (
      <AppShell user={user} title="Execution Graph">
        <div className="kv-card" style={{ padding: "16px" }}>
          <h2 style={{ marginTop: 0 }}>403: Forbidden</h2>
          <p>Your role does not have graph permissions in this organization.</p>
          <Link href="/">Back to dashboard</Link>
        </div>
      </AppShell>
    );
  }

  function onSearch(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setPage(1);
    setSelectedNodeId(null);
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <AppShell user={user} title="Execution Graph">
      <div className="kv-card" style={{ padding: "16px", marginBottom: "16px" }}>
        <form onSubmit={onSearch} style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
          <select value={nodeType} onChange={(event) => setNodeType(event.target.value)}>
            {NODE_TYPES.map((option) => (
              <option key={option || "ALL"} value={option}>
                {option || "ALL TYPES"}
              </option>
            ))}
          </select>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search title..."
            style={{ minWidth: "220px" }}
          />
          <button type="submit" className="kv-btn-primary">
            Search
          </button>
        </form>
      </div>

      {requestError ? <p style={{ color: "var(--danger-text)" }}>{requestError}</p> : null}

      <div style={{ display: "grid", gap: "16px", gridTemplateColumns: "1fr 1fr" }}>
        <div className="kv-card" style={{ padding: "16px" }}>
          <h2 style={{ marginTop: 0 }}>Nodes</h2>
          {loadingNodes ? <p>Loading nodes...</p> : null}
          {!loadingNodes && nodes.length === 0 ? <p>No nodes found.</p> : null}
          {!loadingNodes && nodes.length > 0 ? (
            <table className="kv-table">
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Title</th>
                  <th>Status</th>
                  <th>Risk</th>
                </tr>
              </thead>
              <tbody>
                {nodes.map((node) => (
                  <tr
                    key={node.id}
                    onClick={() => setSelectedNodeId(node.id)}
                    style={{
                      cursor: "pointer",
                      background: selectedNodeId === node.id ? "var(--bg-secondary)" : undefined
                    }}
                  >
                    <td>{node.type}</td>
                    <td>{node.title ?? "-"}</td>
                    <td>{node.status ?? "-"}</td>
                    <td>{node.riskScore}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
          <div style={{ marginTop: "12px", display: "flex", gap: "8px", alignItems: "center" }}>
            <button type="button" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}>
              Prev
            </button>
            <span>
              Page {page} / {totalPages}
            </span>
            <button
              type="button"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
            >
              Next
            </button>
          </div>
        </div>

        <div className="kv-card" style={{ padding: "16px" }}>
          <h2 style={{ marginTop: 0 }}>Node Detail</h2>
          {!selectedNodeId ? <p>Select a node to inspect neighbors.</p> : null}
          {loadingDetail ? <p>Loading node detail...</p> : null}
          {selectedDetail ? (
            <>
              <p>
                <strong>{selectedDetail.node.title ?? selectedDetail.node.id}</strong>
              </p>
              <p>
                Type: {selectedDetail.node.type} | Status: {selectedDetail.node.status ?? "-"}
              </p>
              <p>Connected edges: {selectedDetail.edges.length}</p>
              <ul style={{ margin: 0, paddingLeft: "16px" }}>
                {selectedDetail.edges.map((edge) => {
                  const neighbor =
                    edge.fromNodeId === selectedDetail.node.id ? edge.toNode : edge.fromNode;
                  return (
                    <li key={edge.id}>
                      [{edge.type}] {neighbor?.type ?? "NODE"} - {neighbor?.title ?? neighbor?.id ?? "Unknown"}
                    </li>
                  );
                })}
              </ul>
            </>
          ) : null}
        </div>
      </div>
    </AppShell>
  );
}
