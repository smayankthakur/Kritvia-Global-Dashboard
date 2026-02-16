"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ApiError,
  OrgAppCommandLogRecord,
  OrgAppInstallRecord,
  WebhookDeliveryRecord,
  listOrgAppCommandLogs,
  listOrgAppDeliveries,
  listOrgAppInstalls,
  replayOrgAppDelivery,
  sendOrgAppTestTrigger
} from "../../../lib/api";

interface AppsTabProps {
  token: string;
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) {
    return "-";
  }
  return new Date(value).toLocaleString();
}

export function AppsTab({ token }: AppsTabProps) {
  const [apps, setApps] = useState<OrgAppInstallRecord[]>([]);
  const [selectedAppKey, setSelectedAppKey] = useState<string>("");
  const [eventName, setEventName] = useState<string>("");
  const [deliveries, setDeliveries] = useState<WebhookDeliveryRecord[]>([]);
  const [commandLogs, setCommandLogs] = useState<OrgAppCommandLogRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [replayingId, setReplayingId] = useState<string | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const selectedApp = useMemo(
    () => apps.find((install) => install.appKey === selectedAppKey) ?? null,
    [apps, selectedAppKey]
  );

  const supportedEvents = useMemo(() => selectedApp?.webhookEvents ?? [], [selectedApp]);

  const loadAppInstalls = useCallback(async (): Promise<void> => {
    const installs = await listOrgAppInstalls(token);
    const active = installs.filter((item) => item.status === "INSTALLED");
    setApps(active);
    setSelectedAppKey((current) => {
      if (current && active.some((item) => item.appKey === current)) {
        return current;
      }
      return active[0]?.appKey ?? "";
    });
  }, [token]);

  const loadSelectedAppLogs = useCallback(async (): Promise<void> => {
    if (!selectedAppKey) {
      setDeliveries([]);
      setCommandLogs([]);
      return;
    }

    const [deliveryResponse, commandResponse] = await Promise.all([
      listOrgAppDeliveries(token, selectedAppKey, { page: 1, pageSize: 20 }),
      listOrgAppCommandLogs(token, selectedAppKey, { page: 1, pageSize: 20 })
    ]);
    setDeliveries(deliveryResponse.items);
    setCommandLogs(commandResponse.items);
  }, [selectedAppKey, token]);

  const loadAll = useCallback(async (): Promise<void> => {
    try {
      setLoading(true);
      setRequestError(null);
      await loadAppInstalls();
    } catch (requestFailure) {
      if (requestFailure instanceof ApiError && requestFailure.code === "UPGRADE_REQUIRED") {
        setRequestError("Upgrade required to use app test console. Open Billing to continue.");
        return;
      }
      if (requestFailure instanceof ApiError && requestFailure.code === "IP_NOT_ALLOWED") {
        setRequestError("Your IP isn't permitted for this operation.");
        return;
      }
      setRequestError(
        requestFailure instanceof Error ? requestFailure.message : "Failed to load app installs"
      );
    } finally {
      setLoading(false);
    }
  }, [loadAppInstalls]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  useEffect(() => {
    void loadSelectedAppLogs().catch((requestFailure: unknown) => {
      setRequestError(
        requestFailure instanceof Error ? requestFailure.message : "Failed to load app logs"
      );
    });
  }, [loadSelectedAppLogs]);

  useEffect(() => {
    if (supportedEvents.length === 0) {
      setEventName("");
      return;
    }
    setEventName((current) => (current && supportedEvents.includes(current) ? current : supportedEvents[0]));
  }, [supportedEvents]);

  useEffect(() => {
    if (!toast) {
      return;
    }
    const timer = window.setTimeout(() => setToast(null), 2500);
    return () => window.clearTimeout(timer);
  }, [toast]);

  async function onSendTestTrigger(): Promise<void> {
    if (!selectedAppKey || !eventName) {
      return;
    }
    try {
      setSending(true);
      setRequestError(null);
      await sendOrgAppTestTrigger(token, selectedAppKey, eventName);
      await loadSelectedAppLogs();
      setToast("Test trigger sent.");
    } catch (requestFailure) {
      if (requestFailure instanceof ApiError && requestFailure.code === "TOO_MANY_REQUESTS") {
        setToast("Too many requests. Try again shortly.");
        return;
      }
      setRequestError(
        requestFailure instanceof Error ? requestFailure.message : "Failed to send test trigger"
      );
    } finally {
      setSending(false);
    }
  }

  async function onReplay(deliveryId: string): Promise<void> {
    if (!selectedAppKey) {
      return;
    }
    try {
      setReplayingId(deliveryId);
      setRequestError(null);
      await replayOrgAppDelivery(token, selectedAppKey, deliveryId);
      await loadSelectedAppLogs();
      setToast("Delivery replayed.");
    } catch (requestFailure) {
      setRequestError(
        requestFailure instanceof Error ? requestFailure.message : "Failed to replay delivery"
      );
    } finally {
      setReplayingId(null);
    }
  }

  return (
    <section className="kv-stack" aria-live="polite">
      <div className="kv-card kv-dev-card">
        <h2 className="kv-section-title" style={{ marginTop: 0 }}>
          App Test Console
        </h2>
        <p className="kv-subtitle">Send test triggers, inspect deliveries, and replay failed attempts.</p>

        {requestError ? <p className="kv-error">{requestError}</p> : null}
        {toast ? <p style={{ color: "var(--warning-color)", margin: "0 0 8px" }}>{toast}</p> : null}

        <div className="kv-grid-2">
          <label>
            Installed app
            <select value={selectedAppKey} onChange={(event) => setSelectedAppKey(event.target.value)}>
              {apps.map((install) => (
                <option key={install.id} value={install.appKey}>
                  {install.appName}
                </option>
              ))}
            </select>
          </label>
          <label>
            Event name
            <select
              value={eventName}
              onChange={(event) => setEventName(event.target.value)}
              disabled={supportedEvents.length === 0}
            >
              {supportedEvents.map((eventValue) => (
                <option key={eventValue} value={eventValue}>
                  {eventValue}
                </option>
              ))}
            </select>
          </label>
        </div>

        <p className="kv-subtitle" style={{ marginTop: "10px" }}>
          Webhook URL: <strong>{selectedApp?.webhookUrl ?? "Not configured"}</strong>
        </p>

        <div className="kv-row">
          <button
            type="button"
            className="kv-btn-primary"
            onClick={() => void onSendTestTrigger()}
            disabled={loading || sending || !selectedApp || !eventName || !selectedApp.webhookUrl}
          >
            {sending ? "Sending..." : "Send Test Trigger"}
          </button>
        </div>
      </div>

      <div className="kv-card">
        <h3 className="kv-section-title" style={{ marginTop: 0 }}>
          Last 20 Deliveries
        </h3>
        <div className="kv-table-wrap">
          <table>
            <thead>
              <tr>
                <th align="left">Time</th>
                <th align="left">Event</th>
                <th align="left">Status</th>
                <th align="left">Success</th>
                <th align="left">Duration</th>
                <th align="left">Error</th>
                <th align="left">Action</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={7}>Loading deliveries...</td>
                </tr>
              ) : null}
              {!loading && deliveries.length === 0 ? (
                <tr>
                  <td colSpan={7}>No deliveries yet.</td>
                </tr>
              ) : null}
              {!loading
                ? deliveries.map((delivery) => (
                    <tr key={delivery.id}>
                      <td>{formatDateTime(delivery.createdAt)}</td>
                      <td>{delivery.event}</td>
                      <td>{delivery.statusCode ?? "-"}</td>
                      <td>{delivery.success ? "Yes" : "No"}</td>
                      <td>{delivery.durationMs}ms</td>
                      <td>{delivery.error ?? "-"}</td>
                      <td>
                        {!delivery.success ? (
                          <button
                            type="button"
                            onClick={() => void onReplay(delivery.id)}
                            disabled={replayingId === delivery.id}
                          >
                            Replay
                          </button>
                        ) : (
                          "-"
                        )}
                      </td>
                    </tr>
                  ))
                : null}
            </tbody>
          </table>
        </div>
      </div>

      <div className="kv-card">
        <h3 className="kv-section-title" style={{ marginTop: 0 }}>
          Last 20 Command Logs
        </h3>
        <div className="kv-table-wrap">
          <table>
            <thead>
              <tr>
                <th align="left">Time</th>
                <th align="left">Command</th>
                <th align="left">Status</th>
                <th align="left">Success</th>
                <th align="left">Error</th>
                <th align="left">Request Hash</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={6}>Loading command logs...</td>
                </tr>
              ) : null}
              {!loading && commandLogs.length === 0 ? (
                <tr>
                  <td colSpan={6}>No command logs yet.</td>
                </tr>
              ) : null}
              {!loading
                ? commandLogs.map((log) => (
                    <tr key={log.id}>
                      <td>{formatDateTime(log.createdAt)}</td>
                      <td>{log.command}</td>
                      <td>{log.statusCode}</td>
                      <td>{log.success ? "Yes" : "No"}</td>
                      <td>{log.error ?? "-"}</td>
                      <td>{log.requestHash.slice(0, 12)}...</td>
                    </tr>
                  ))
                : null}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
