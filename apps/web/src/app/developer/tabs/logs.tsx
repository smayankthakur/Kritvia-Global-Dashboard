"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  AlertChannel,
  AlertDelivery,
  AlertEscalation,
  AlertEvent,
  ApiError,
  EscalationPolicy,
  acknowledgeOrgAlert,
  createAlertChannel,
  deleteAlertChannel,
  WebhookDeliveryRecord,
  WebhookEndpointRecord,
  exportOrgAuditCsv,
  getEscalationPolicy,
  listAlertEscalations,
  listAlertChannels,
  listAlertDeliveries,
  listOrgAlerts,
  listOrgWebhooks,
  listWebhookDeliveries,
  retryWebhookDelivery,
  saveEscalationPolicy,
  testEscalationPolicy,
  testAlertChannel
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
  const [alerts, setAlerts] = useState<AlertEvent[]>([]);
  const [selectedAlert, setSelectedAlert] = useState<AlertEvent | null>(null);
  const [selectedAlertForEscalation, setSelectedAlertForEscalation] = useState<AlertEvent | null>(null);
  const [alertEscalations, setAlertEscalations] = useState<AlertEscalation[]>([]);
  const [escalationPolicy, setEscalationPolicy] = useState<EscalationPolicy | null>(null);
  const [savingEscalationPolicy, setSavingEscalationPolicy] = useState(false);
  const [testingEscalationPolicy, setTestingEscalationPolicy] = useState(false);
  const [alertChannels, setAlertChannels] = useState<AlertChannel[]>([]);
  const [alertDeliveries, setAlertDeliveries] = useState<AlertDelivery[]>([]);
  const [selectedAlertEventId, setSelectedAlertEventId] = useState<string>("");
  const [creatingChannel, setCreatingChannel] = useState(false);
  const [testingChannelId, setTestingChannelId] = useState<string | null>(null);
  const [deletingChannelId, setDeletingChannelId] = useState<string | null>(null);
  const [channelType, setChannelType] = useState<"WEBHOOK" | "EMAIL" | "SLACK">("WEBHOOK");
  const [channelName, setChannelName] = useState("");
  const [channelSeverity, setChannelSeverity] = useState<"MEDIUM" | "HIGH" | "CRITICAL">("HIGH");
  const [channelUrl, setChannelUrl] = useState("");
  const [channelSecret, setChannelSecret] = useState("");
  const [channelEmails, setChannelEmails] = useState("");
  const [channelSlack, setChannelSlack] = useState("");
  const [loading, setLoading] = useState(true);
  const [deliveriesLoading, setDeliveriesLoading] = useState(false);
  const [alertsLoading, setAlertsLoading] = useState(false);
  const [retryingDeliveryId, setRetryingDeliveryId] = useState<string | null>(null);
  const [acknowledgingAlertId, setAcknowledgingAlertId] = useState<string | null>(null);
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

  const loadAlerts = useCallback(async (): Promise<void> => {
    setAlertsLoading(true);
    try {
      const response = await listOrgAlerts(token, {
        acknowledged: false,
        page: 1,
        pageSize: 20
      });
      setAlerts(response.items);
    } finally {
      setAlertsLoading(false);
    }
  }, [token]);

  const loadAlertChannels = useCallback(async (): Promise<void> => {
    const response = await listAlertChannels(token);
    setAlertChannels(response);
  }, [token]);

  const loadEscalationPolicy = useCallback(async (): Promise<void> => {
    const response = await getEscalationPolicy(token);
    setEscalationPolicy(response);
  }, [token]);

  const loadAlertDeliveries = useCallback(async (): Promise<void> => {
    const response = await listAlertDeliveries(token, {
      alertEventId: selectedAlertEventId || undefined,
      page: 1,
      pageSize: 20
    });
    setAlertDeliveries(response.items);
  }, [selectedAlertEventId, token]);

  const loadAll = useCallback(async (): Promise<void> => {
    try {
      setLoading(true);
      setRequestError(null);
      await Promise.all([
        loadWebhooks(),
        loadTokenUsageLogs(),
        loadAlerts(),
        loadAlertChannels(),
        loadAlertDeliveries(),
        loadEscalationPolicy()
      ]);
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
  }, [
    loadAlertChannels,
    loadAlertDeliveries,
    loadAlerts,
    loadEscalationPolicy,
    loadTokenUsageLogs,
    loadWebhooks
  ]);

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

  useEffect(() => {
    void loadAlertDeliveries().catch((requestFailure: unknown) => {
      setRequestError(
        requestFailure instanceof Error ? requestFailure.message : "Failed to load alert deliveries"
      );
    });
  }, [loadAlertDeliveries]);

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

  async function onAcknowledgeAlert(alertId: string): Promise<void> {
    try {
      setAcknowledgingAlertId(alertId);
      await acknowledgeOrgAlert(token, alertId);
      await loadAlerts();
      setToast("Alert acknowledged.");
    } catch (requestFailure) {
      setRequestError(
        requestFailure instanceof Error ? requestFailure.message : "Failed to acknowledge alert"
      );
    } finally {
      setAcknowledgingAlertId(null);
    }
  }

  async function onCreateChannel(): Promise<void> {
    try {
      setCreatingChannel(true);
      const config: Record<string, unknown> =
        channelType === "WEBHOOK"
          ? { url: channelUrl.trim(), secret: channelSecret.trim() || undefined }
          : channelType === "EMAIL"
            ? { to: channelEmails.split(",").map((entry) => entry.trim()).filter(Boolean) }
            : { channel: channelSlack.trim() };

      await createAlertChannel(token, {
        type: channelType,
        name: channelName.trim(),
        minSeverity: channelSeverity,
        config
      });

      setChannelName("");
      setChannelUrl("");
      setChannelSecret("");
      setChannelEmails("");
      setChannelSlack("");
      await Promise.all([loadAlertChannels(), loadAlertDeliveries()]);
      setToast("Alert channel created.");
    } catch (requestFailure) {
      setRequestError(
        requestFailure instanceof Error ? requestFailure.message : "Failed to create alert channel"
      );
    } finally {
      setCreatingChannel(false);
    }
  }

  async function onTestChannel(channelId: string): Promise<void> {
    try {
      setTestingChannelId(channelId);
      await testAlertChannel(token, channelId, "HIGH");
      await loadAlertDeliveries();
      setToast("Channel test sent.");
    } catch (requestFailure) {
      setRequestError(
        requestFailure instanceof Error ? requestFailure.message : "Failed to test alert channel"
      );
    } finally {
      setTestingChannelId(null);
    }
  }

  async function onDeleteChannel(channelId: string): Promise<void> {
    try {
      setDeletingChannelId(channelId);
      await deleteAlertChannel(token, channelId);
      await Promise.all([loadAlertChannels(), loadAlertDeliveries()]);
      setToast("Alert channel deleted.");
    } catch (requestFailure) {
      setRequestError(
        requestFailure instanceof Error ? requestFailure.message : "Failed to delete alert channel"
      );
    } finally {
      setDeletingChannelId(null);
    }
  }

  async function onSaveEscalationPolicy(): Promise<void> {
    if (!escalationPolicy) {
      return;
    }
    try {
      setSavingEscalationPolicy(true);
      const saved = await saveEscalationPolicy(token, {
        name: escalationPolicy.name,
        isEnabled: escalationPolicy.isEnabled,
        timezone: escalationPolicy.timezone,
        quietHoursEnabled: escalationPolicy.quietHoursEnabled,
        quietHoursStart: escalationPolicy.quietHoursStart ?? undefined,
        quietHoursEnd: escalationPolicy.quietHoursEnd ?? undefined,
        businessDaysOnly: escalationPolicy.businessDaysOnly,
        slaCritical: escalationPolicy.slaCritical,
        slaHigh: escalationPolicy.slaHigh,
        slaMedium: escalationPolicy.slaMedium,
        slaLow: escalationPolicy.slaLow,
        steps: escalationPolicy.steps
      });
      setEscalationPolicy(saved);
      setToast("Escalation policy saved.");
    } catch (requestFailure) {
      setRequestError(
        requestFailure instanceof Error ? requestFailure.message : "Failed to save escalation policy"
      );
    } finally {
      setSavingEscalationPolicy(false);
    }
  }

  async function onTestEscalationPolicy(): Promise<void> {
    try {
      setTestingEscalationPolicy(true);
      const result = await testEscalationPolicy(token, "CRITICAL");
      await Promise.all([loadAlerts(), loadAlertDeliveries()]);
      setToast(`Escalation test ran: ${result.escalated} escalated, ${result.suppressed} suppressed.`);
    } catch (requestFailure) {
      setRequestError(
        requestFailure instanceof Error ? requestFailure.message : "Failed to run escalation policy test"
      );
    } finally {
      setTestingEscalationPolicy(false);
    }
  }

  async function onViewEscalations(alert: AlertEvent): Promise<void> {
    try {
      const history = await listAlertEscalations(token, alert.id);
      setAlertEscalations(history);
      setSelectedAlertForEscalation(alert);
    } catch (requestFailure) {
      setRequestError(
        requestFailure instanceof Error ? requestFailure.message : "Failed to load escalation history"
      );
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
          Alerts
        </h2>
        <p className="kv-subtitle" style={{ marginBottom: "12px" }}>
          Reliability and mitigation alerts for this org.
        </p>
        <div className="kv-table-wrap">
          <table>
            <thead>
              <tr>
                <th align="left">Time</th>
                <th align="left">Severity</th>
                <th align="left">Type</th>
                <th align="left">Title</th>
                <th align="left">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading || alertsLoading ? (
                <tr>
                  <td colSpan={5}>Loading alerts...</td>
                </tr>
              ) : null}
              {!loading && !alertsLoading && alerts.length === 0 ? (
                <tr>
                  <td colSpan={5}>No active alerts.</td>
                </tr>
              ) : null}
              {!loading && !alertsLoading
                ? alerts.map((alert) => (
                    <tr key={alert.id}>
                      <td>{formatDateTime(alert.createdAt)}</td>
                      <td>
                        <span className="kv-pill">{alert.severity}</span>
                      </td>
                      <td>{alert.type}</td>
                      <td>{alert.title}</td>
                      <td style={{ display: "flex", gap: "8px" }}>
                        <button type="button" onClick={() => setSelectedAlert(alert)}>
                          Details
                        </button>
                        <button type="button" onClick={() => void onViewEscalations(alert)}>
                          Escalations
                        </button>
                        <button
                          type="button"
                          onClick={() => void onAcknowledgeAlert(alert.id)}
                          disabled={acknowledgingAlertId === alert.id}
                        >
                          Acknowledge
                        </button>
                      </td>
                    </tr>
                  ))
                : null}
            </tbody>
          </table>
        </div>
      </div>

      <div className="kv-card">
        <h2 className="kv-section-title" style={{ marginTop: 0 }}>
          Escalation Policy
        </h2>
        <p className="kv-subtitle" style={{ marginBottom: "12px" }}>
          Route unacknowledged alerts by severity and response SLA.
        </p>
        {escalationPolicy ? (
          <div className="kv-stack">
            <div className="kv-row" style={{ flexWrap: "wrap", gap: "10px" }}>
              <input
                aria-label="Policy name"
                value={escalationPolicy.name}
                onChange={(event) =>
                  setEscalationPolicy((current) =>
                    current ? { ...current, name: event.target.value } : current
                  )
                }
              />
              <input
                aria-label="Timezone"
                value={escalationPolicy.timezone}
                onChange={(event) =>
                  setEscalationPolicy((current) =>
                    current ? { ...current, timezone: event.target.value } : current
                  )
                }
              />
              <label style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                <input
                  type="checkbox"
                  checked={escalationPolicy.isEnabled}
                  onChange={(event) =>
                    setEscalationPolicy((current) =>
                      current ? { ...current, isEnabled: event.target.checked } : current
                    )
                  }
                />
                Enabled
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                <input
                  type="checkbox"
                  checked={escalationPolicy.quietHoursEnabled}
                  onChange={(event) =>
                    setEscalationPolicy((current) =>
                      current ? { ...current, quietHoursEnabled: event.target.checked } : current
                    )
                  }
                />
                Quiet hours
              </label>
            </div>
            <div className="kv-row" style={{ flexWrap: "wrap", gap: "10px" }}>
              <input
                aria-label="Quiet hours start"
                placeholder="22:00"
                value={escalationPolicy.quietHoursStart ?? ""}
                onChange={(event) =>
                  setEscalationPolicy((current) =>
                    current ? { ...current, quietHoursStart: event.target.value } : current
                  )
                }
              />
              <input
                aria-label="Quiet hours end"
                placeholder="08:00"
                value={escalationPolicy.quietHoursEnd ?? ""}
                onChange={(event) =>
                  setEscalationPolicy((current) =>
                    current ? { ...current, quietHoursEnd: event.target.value } : current
                  )
                }
              />
              <label style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                <input
                  type="checkbox"
                  checked={escalationPolicy.businessDaysOnly}
                  onChange={(event) =>
                    setEscalationPolicy((current) =>
                      current ? { ...current, businessDaysOnly: event.target.checked } : current
                    )
                  }
                />
                Business days only
              </label>
            </div>
            <div className="kv-row" style={{ flexWrap: "wrap", gap: "10px" }}>
              <input
                type="number"
                aria-label="Critical SLA"
                value={escalationPolicy.slaCritical}
                onChange={(event) =>
                  setEscalationPolicy((current) =>
                    current ? { ...current, slaCritical: Number(event.target.value) } : current
                  )
                }
              />
              <input
                type="number"
                aria-label="High SLA"
                value={escalationPolicy.slaHigh}
                onChange={(event) =>
                  setEscalationPolicy((current) =>
                    current ? { ...current, slaHigh: Number(event.target.value) } : current
                  )
                }
              />
              <input
                type="number"
                aria-label="Medium SLA"
                value={escalationPolicy.slaMedium}
                onChange={(event) =>
                  setEscalationPolicy((current) =>
                    current ? { ...current, slaMedium: Number(event.target.value) } : current
                  )
                }
              />
              <input
                type="number"
                aria-label="Low SLA"
                value={escalationPolicy.slaLow}
                onChange={(event) =>
                  setEscalationPolicy((current) =>
                    current ? { ...current, slaLow: Number(event.target.value) } : current
                  )
                }
              />
            </div>
            <div className="kv-table-wrap">
              <table>
                <thead>
                  <tr>
                    <th align="left">Step</th>
                    <th align="left">After Minutes</th>
                    <th align="left">Min Severity</th>
                    <th align="left">Routes</th>
                  </tr>
                </thead>
                <tbody>
                  {escalationPolicy.steps.map((step, index) => (
                    <tr key={`step-${index}`}>
                      <td>{index + 1}</td>
                      <td>{step.afterMinutes}</td>
                      <td>{step.minSeverity}</td>
                      <td>{step.routeTo.join(", ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="kv-row">
              <button
                type="button"
                onClick={() => void onSaveEscalationPolicy()}
                disabled={savingEscalationPolicy}
              >
                Save escalation policy
              </button>
              <button
                type="button"
                onClick={() => void onTestEscalationPolicy()}
                disabled={testingEscalationPolicy}
              >
                Test escalation
              </button>
            </div>
          </div>
        ) : (
          <p style={{ margin: 0 }}>Loading escalation policy...</p>
        )}
      </div>

      <div className="kv-card">
        <h2 className="kv-section-title" style={{ marginTop: 0 }}>
          Alert Channels
        </h2>
        <p className="kv-subtitle" style={{ marginBottom: "12px" }}>
          Route alerts to webhook, email, and Slack.
        </p>
        <div className="kv-stack">
          <div className="kv-row" style={{ flexWrap: "wrap", gap: "10px" }}>
            <select
              aria-label="Channel type"
              value={channelType}
              onChange={(event) => setChannelType(event.target.value as "WEBHOOK" | "EMAIL" | "SLACK")}
            >
              <option value="WEBHOOK">Webhook</option>
              <option value="EMAIL">Email</option>
              <option value="SLACK">Slack</option>
            </select>
            <input
              aria-label="Channel name"
              placeholder="Channel name"
              value={channelName}
              onChange={(event) => setChannelName(event.target.value)}
            />
            <select
              aria-label="Minimum severity"
              value={channelSeverity}
              onChange={(event) =>
                setChannelSeverity(event.target.value as "MEDIUM" | "HIGH" | "CRITICAL")
              }
            >
              <option value="MEDIUM">MEDIUM</option>
              <option value="HIGH">HIGH</option>
              <option value="CRITICAL">CRITICAL</option>
            </select>
          </div>
          {channelType === "WEBHOOK" ? (
            <div className="kv-row" style={{ flexWrap: "wrap", gap: "10px" }}>
              <input
                aria-label="Webhook URL"
                placeholder="https://example.com/alerts"
                value={channelUrl}
                onChange={(event) => setChannelUrl(event.target.value)}
              />
              <input
                aria-label="Webhook secret"
                placeholder="Optional shared secret"
                value={channelSecret}
                onChange={(event) => setChannelSecret(event.target.value)}
              />
            </div>
          ) : null}
          {channelType === "EMAIL" ? (
            <input
              aria-label="Alert email recipients"
              placeholder="alice@company.com,bob@company.com"
              value={channelEmails}
              onChange={(event) => setChannelEmails(event.target.value)}
            />
          ) : null}
          {channelType === "SLACK" ? (
            <input
              aria-label="Slack channel"
              placeholder="#ops-alerts or C123456"
              value={channelSlack}
              onChange={(event) => setChannelSlack(event.target.value)}
            />
          ) : null}
          <div className="kv-row">
            <button
              type="button"
              onClick={() => void onCreateChannel()}
              disabled={creatingChannel || channelName.trim().length === 0}
            >
              Create channel
            </button>
          </div>
        </div>
        <div className="kv-table-wrap" style={{ marginTop: "12px" }}>
          <table>
            <thead>
              <tr>
                <th align="left">Name</th>
                <th align="left">Type</th>
                <th align="left">Min Severity</th>
                <th align="left">Enabled</th>
                <th align="left">Actions</th>
              </tr>
            </thead>
            <tbody>
              {alertChannels.length === 0 ? (
                <tr>
                  <td colSpan={5}>No alert channels configured.</td>
                </tr>
              ) : (
                alertChannels.map((channel) => (
                  <tr key={channel.id}>
                    <td>{channel.name}</td>
                    <td>{channel.type}</td>
                    <td>{channel.minSeverity}</td>
                    <td>{channel.isEnabled ? "Yes" : "No"}</td>
                    <td style={{ display: "flex", gap: "8px" }}>
                      <button
                        type="button"
                        onClick={() => void onTestChannel(channel.id)}
                        disabled={testingChannelId === channel.id}
                      >
                        Test
                      </button>
                      <button
                        type="button"
                        onClick={() => void onDeleteChannel(channel.id)}
                        disabled={deletingChannelId === channel.id}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="kv-card">
        <div className="kv-row" style={{ justifyContent: "space-between" }}>
          <h2 className="kv-section-title" style={{ marginTop: 0, marginBottom: 0 }}>
            Alert Deliveries
          </h2>
          <select
            aria-label="Filter by alert event"
            value={selectedAlertEventId}
            onChange={(event) => setSelectedAlertEventId(event.target.value)}
          >
            <option value="">All alerts</option>
            {alerts.map((alert) => (
              <option key={alert.id} value={alert.id}>
                {alert.type} - {alert.title}
              </option>
            ))}
          </select>
        </div>
        <div className="kv-table-wrap" style={{ marginTop: "12px" }}>
          <table>
            <thead>
              <tr>
                <th align="left">Time</th>
                <th align="left">Channel</th>
                <th align="left">Success</th>
                <th align="left">Status</th>
                <th align="left">Error</th>
              </tr>
            </thead>
            <tbody>
              {alertDeliveries.length === 0 ? (
                <tr>
                  <td colSpan={5}>No alert deliveries recorded.</td>
                </tr>
              ) : (
                alertDeliveries.map((delivery) => (
                  <tr key={delivery.id}>
                    <td>{formatDateTime(delivery.createdAt)}</td>
                    <td>{delivery.channel?.name ?? delivery.channelId}</td>
                    <td>{delivery.success ? "Yes" : "No"}</td>
                    <td>{delivery.statusCode ?? "-"}</td>
                    <td>{delivery.error ?? "-"}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
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

      {selectedAlert ? (
        <div className="kv-modal-backdrop">
          <div className="kv-modal">
            <h2 style={{ marginTop: 0 }}>Alert details</h2>
            <div className="kv-stack">
              <p style={{ margin: 0 }}>
                <strong>{selectedAlert.title}</strong>
              </p>
              <p style={{ margin: 0 }}>
                {selectedAlert.type} · {selectedAlert.severity}
              </p>
              <pre className="kv-dev-pre">
                {JSON.stringify(selectedAlert.details ?? {}, null, 2)}
              </pre>
            </div>
            <div className="kv-row" style={{ justifyContent: "flex-end", marginTop: "12px" }}>
              <button type="button" onClick={() => setSelectedAlert(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {selectedAlertForEscalation ? (
        <div className="kv-modal-backdrop">
          <div className="kv-modal">
            <h2 style={{ marginTop: 0 }}>Escalation history</h2>
            <p style={{ marginTop: 0 }}>
              {selectedAlertForEscalation.title} ({selectedAlertForEscalation.severity})
            </p>
            <div className="kv-table-wrap">
              <table>
                <thead>
                  <tr>
                    <th align="left">Step</th>
                    <th align="left">Attempted</th>
                    <th align="left">Routed To</th>
                    <th align="left">Suppressed</th>
                    <th align="left">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {alertEscalations.length === 0 ? (
                    <tr>
                      <td colSpan={5}>No escalation attempts yet.</td>
                    </tr>
                  ) : (
                    alertEscalations.map((entry) => (
                      <tr key={entry.id}>
                        <td>{entry.stepNumber}</td>
                        <td>{formatDateTime(entry.attemptedAt)}</td>
                        <td>{entry.routedTo.join(", ")}</td>
                        <td>{entry.suppressed ? "Yes" : "No"}</td>
                        <td>{entry.reason ?? "-"}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            <div className="kv-row" style={{ justifyContent: "flex-end", marginTop: "12px" }}>
              <button
                type="button"
                onClick={() => {
                  setSelectedAlertForEscalation(null);
                  setAlertEscalations([]);
                }}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
