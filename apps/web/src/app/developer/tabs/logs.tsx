"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  ApiError,
  WebhookDeliveryRecord,
  WebhookEndpointRecord,
  exportOrgAuditCsv,
  listOrgWebhooks,
  listWebhookDeliveries,
  retryWebhookDelivery
} from "../../../lib/api";

interface LogsTabProps {
  token: string;
}

interface TokenUsageLogRow {
  createdAt: string;
  endpoint: string;
  statusCode: string;
  ip: string;
  tokenId: string;
}

interface CsvRowRecord {
  [key: string]: string;
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) {
    return "-";
  }
  return new Date(value).toLocaleString();
}

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (char === "," && !inQuotes) {
      values.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  values.push(current);
  return values;
}

function parseCsv(text: string): CsvRowRecord[] {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length <= 1) {
    return [];
  }

  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    const row: CsvRowRecord = {};
    headers.forEach((header, index) => {
      row[header] = values[index] ?? "";
    });
    return row;
  });
}

function parseTokenUsageLogs(csvText: string): TokenUsageLogRow[] {
  const rows = parseCsv(csvText);
  const usageRows: TokenUsageLogRow[] = [];

  for (const row of rows) {
    if (row.action !== "API_TOKEN_USED") {
      continue;
    }

    let endpoint = "-";
    let statusCode = "-";
    let ip = "-";
    try {
      const meta = JSON.parse(row.metaJson ?? "{}") as {
        endpoint?: string;
        statusCode?: string | number;
        ip?: string;
      };
      endpoint = meta.endpoint ?? "-";
      statusCode = String(meta.statusCode ?? "-");
      ip = meta.ip ?? "-";
    } catch {
      // Ignore invalid meta JSON and use fallback values.
    }

    usageRows.push({
      createdAt: row.createdAt ?? "",
      endpoint,
      statusCode,
      ip,
      tokenId: row.entityId ?? "-"
    });
  }

  return usageRows
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 200);
}

export function LogsTab({ token }: LogsTabProps) {
  const [webhooks, setWebhooks] = useState<WebhookEndpointRecord[]>([]);
  const [selectedWebhookId, setSelectedWebhookId] = useState<string>("");
  const [deliveries, setDeliveries] = useState<WebhookDeliveryRecord[]>([]);
  const [deliveryTotal, setDeliveryTotal] = useState(0);
  const [deliveryPage, setDeliveryPage] = useState(1);
  const [pageSize] = useState(20);
  const [selectedDelivery, setSelectedDelivery] = useState<WebhookDeliveryRecord | null>(null);
  const [tokenUsageLogs, setTokenUsageLogs] = useState<TokenUsageLogRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [deliveriesLoading, setDeliveriesLoading] = useState(false);
  const [retryingDeliveryId, setRetryingDeliveryId] = useState<string | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const canGoPrev = deliveryPage > 1;
  const canGoNext = deliveryPage * pageSize < deliveryTotal;

  const loadWebhooks = useCallback(async (): Promise<void> => {
    const response = await listOrgWebhooks(token);
    setWebhooks(response);
    if (response.length > 0) {
      setSelectedWebhookId((current) => current || response[0].id);
    } else {
      setSelectedWebhookId("");
    }
  }, [token]);

  const loadDeliveries = useCallback(
    async (webhookId: string, page: number): Promise<void> => {
      if (!webhookId) {
        setDeliveries([]);
        setDeliveryTotal(0);
        return;
      }
      setDeliveriesLoading(true);
      const response = await listWebhookDeliveries(token, webhookId, { page, pageSize });
      setDeliveries(response.items);
      setDeliveryTotal(response.totalCount ?? response.total);
      setDeliveriesLoading(false);
    },
    [pageSize, token]
  );

  const loadTokenUsageLogs = useCallback(async (): Promise<void> => {
    const now = new Date();
    const from = new Date(now);
    from.setDate(now.getDate() - 30);
    const payload = await exportOrgAuditCsv(token, {
      from: from.toISOString().slice(0, 10),
      to: now.toISOString().slice(0, 10)
    });
    const csvText = await payload.blob.text();
    setTokenUsageLogs(parseTokenUsageLogs(csvText));
  }, [token]);

  const loadAll = useCallback(async (): Promise<void> => {
    try {
      setLoading(true);
      setRequestError(null);
      await loadWebhooks();
      await loadTokenUsageLogs();
    } catch (requestFailure) {
      if (requestFailure instanceof ApiError && requestFailure.code === "UPGRADE_REQUIRED") {
        setRequestError("Upgrade required to view logs. Open Billing to continue.");
        return;
      }
      if (requestFailure instanceof ApiError && requestFailure.code === "IP_NOT_ALLOWED") {
        setRequestError("Your IP isn't permitted for this operation.");
        return;
      }
      if (requestFailure instanceof ApiError && requestFailure.code === "TOO_MANY_REQUESTS") {
        setToast("Too many requests. Please wait before retrying.");
        return;
      }
      setRequestError(
        requestFailure instanceof Error ? requestFailure.message : "Failed to load logs"
      );
    } finally {
      setLoading(false);
    }
  }, [loadTokenUsageLogs, loadWebhooks]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  useEffect(() => {
    if (!selectedWebhookId) {
      return;
    }
    void loadDeliveries(selectedWebhookId, deliveryPage).catch((requestFailure: unknown) => {
      setDeliveriesLoading(false);
      setRequestError(
        requestFailure instanceof Error ? requestFailure.message : "Failed to load deliveries"
      );
    });
  }, [deliveryPage, loadDeliveries, selectedWebhookId]);

  useEffect(() => {
    setDeliveryPage(1);
  }, [selectedWebhookId]);

  useEffect(() => {
    if (!toast) {
      return;
    }
    const timer = window.setTimeout(() => setToast(null), 2500);
    return () => window.clearTimeout(timer);
  }, [toast]);

  async function onRetryDelivery(delivery: WebhookDeliveryRecord): Promise<void> {
    if (!selectedWebhookId) {
      return;
    }
    try {
      setRetryingDeliveryId(delivery.id);
      await retryWebhookDelivery(token, selectedWebhookId, delivery.id);
      await loadDeliveries(selectedWebhookId, deliveryPage);
      setToast("Retry triggered.");
    } catch (requestFailure) {
      if (requestFailure instanceof ApiError && requestFailure.code === "TOO_MANY_REQUESTS") {
        setToast("Too many retry attempts. Try again later.");
        return;
      }
      setRequestError(
        requestFailure instanceof Error ? requestFailure.message : "Failed to retry delivery"
      );
    } finally {
      setRetryingDeliveryId(null);
    }
  }

  return (
    <section className="kv-stack" aria-live="polite">
      <div className="kv-card">
        <div className="kv-row" style={{ justifyContent: "space-between" }}>
          <h2 className="kv-section-title" style={{ margin: 0 }}>
            Webhook delivery logs
          </h2>
          <div className="kv-row">
            <label htmlFor="webhookSelect">Webhook</label>
            <select
              id="webhookSelect"
              value={selectedWebhookId}
              onChange={(event) => setSelectedWebhookId(event.target.value)}
              disabled={webhooks.length === 0}
            >
              {webhooks.map((webhook) => (
                <option key={webhook.id} value={webhook.id}>
                  {webhook.url}
                </option>
              ))}
            </select>
          </div>
        </div>

        {requestError ? (
          <p className="kv-error">
            {requestError}{" "}
            {requestError.includes("Upgrade required") ? <Link href="/billing">Open Billing</Link> : null}
          </p>
        ) : null}
        {toast ? <p style={{ color: "var(--warning-color)", margin: 0 }}>{toast}</p> : null}

        <div className="kv-table-wrap" style={{ marginTop: "12px" }}>
          <table>
            <thead>
              <tr>
                <th align="left">Time</th>
                <th align="left">Event</th>
                <th align="left">Status</th>
                <th align="left">Success</th>
                <th align="left">Attempts</th>
                <th align="left">Duration</th>
                <th align="left">Error</th>
                <th align="left">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading || deliveriesLoading ? (
                <tr>
                  <td colSpan={8}>Loading deliveries...</td>
                </tr>
              ) : null}
              {!loading && !deliveriesLoading && deliveries.length === 0 ? (
                <tr>
                  <td colSpan={8}>No deliveries found for this webhook.</td>
                </tr>
              ) : null}
              {!loading && !deliveriesLoading
                ? deliveries.map((delivery) => (
                    <tr key={delivery.id}>
                      <td>{formatDateTime(delivery.createdAt)}</td>
                      <td>{delivery.event}</td>
                      <td>{delivery.statusCode ?? "-"}</td>
                      <td>
                        <span className="kv-pill">{delivery.success ? "Yes" : "No"}</span>
                      </td>
                      <td>{delivery.attempt}</td>
                      <td>{delivery.durationMs}ms</td>
                      <td>{delivery.error ?? "-"}</td>
                      <td style={{ display: "flex", gap: "8px" }}>
                        <button type="button" onClick={() => setSelectedDelivery(delivery)}>
                          Details
                        </button>
                        {!delivery.success ? (
                          <button
                            type="button"
                            onClick={() => void onRetryDelivery(delivery)}
                            disabled={retryingDeliveryId === delivery.id}
                          >
                            Retry
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  ))
                : null}
            </tbody>
          </table>
        </div>

        <div className="kv-pagination">
          <button
            type="button"
            onClick={() => setDeliveryPage((currentPage) => Math.max(1, currentPage - 1))}
            disabled={!canGoPrev}
          >
            Previous
          </button>
          <span>
            Page {deliveryPage} of {Math.max(1, Math.ceil(deliveryTotal / pageSize))}
          </span>
          <button
            type="button"
            onClick={() => setDeliveryPage((currentPage) => currentPage + 1)}
            disabled={!canGoNext}
          >
            Next
          </button>
        </div>
      </div>

      <div className="kv-card">
        <h2 className="kv-section-title" style={{ marginTop: 0 }}>
          API token usage logs
        </h2>
        <p className="kv-subtitle" style={{ marginBottom: "12px" }}>
          Last 200 `API_TOKEN_USED` entries from activity logs.
        </p>
        <div className="kv-table-wrap">
          <table>
            <thead>
              <tr>
                <th align="left">Time</th>
                <th align="left">Endpoint</th>
                <th align="left">Status</th>
                <th align="left">IP</th>
                <th align="left">Token ID</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={5}>Loading token usage logs...</td>
                </tr>
              ) : null}
              {!loading && tokenUsageLogs.length === 0 ? (
                <tr>
                  <td colSpan={5}>No token usage logs found.</td>
                </tr>
              ) : null}
              {!loading
                ? tokenUsageLogs.map((logRow, index) => (
                    <tr key={`${logRow.tokenId}-${logRow.createdAt}-${index}`}>
                      <td>{formatDateTime(logRow.createdAt)}</td>
                      <td>{logRow.endpoint}</td>
                      <td>{logRow.statusCode}</td>
                      <td>{logRow.ip}</td>
                      <td>{logRow.tokenId}</td>
                    </tr>
                  ))
                : null}
            </tbody>
          </table>
        </div>
      </div>

      {selectedDelivery ? (
        <div className="kv-modal-backdrop">
          <div className="kv-modal">
            <h2 style={{ marginTop: 0 }}>Delivery details</h2>
            <div className="kv-stack">
              <div>
                <p style={{ margin: "0 0 6px", fontWeight: 600 }}>Headers</p>
                <pre className="kv-dev-pre">{`Content-Type: application/json\nX-Kritviya-Event: ${selectedDelivery.event}\nX-Kritviya-Signature: <hmac-sha256>`}</pre>
              </div>
              <div>
                <p style={{ margin: "0 0 6px", fontWeight: 600 }}>Request body hash</p>
                <pre className="kv-dev-pre">{selectedDelivery.requestBodyHash}</pre>
              </div>
              <div>
                <p style={{ margin: "0 0 6px", fontWeight: 600 }}>Response snippet</p>
                <pre className="kv-dev-pre">
                  {selectedDelivery.responseBodySnippet && selectedDelivery.responseBodySnippet.length > 0
                    ? selectedDelivery.responseBodySnippet
                    : "-"}
                </pre>
              </div>
            </div>
            <div className="kv-row" style={{ justifyContent: "flex-end", marginTop: "12px" }}>
              <button type="button" onClick={() => setSelectedDelivery(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
