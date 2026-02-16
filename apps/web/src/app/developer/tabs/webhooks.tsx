"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import {
  ApiError,
  WebhookEndpointRecord,
  createOrgWebhook,
  deleteOrgWebhook,
  listOrgWebhooks
} from "../../../lib/api";

interface WebhooksTabProps {
  token: string;
}

const SUPPORTED_EVENTS = [
  "deal.created",
  "deal.updated",
  "invoice.status_changed",
  "work-item.completed",
  "ai-insight.created",
  "ai-action.executed"
];

function formatDateTime(value: string | null | undefined): string {
  if (!value) {
    return "-";
  }
  return new Date(value).toLocaleString();
}

function joinEvents(events: string[]): string {
  if (!events || events.length === 0) {
    return "-";
  }
  return events.join(", ");
}

function isValidHttpsUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function WebhooksTab({ token }: WebhooksTabProps) {
  const [items, setItems] = useState<WebhookEndpointRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [selectedEvents, setSelectedEvents] = useState<string[]>([]);
  const [createdSecret, setCreatedSecret] = useState<string | null>(null);
  const [urlError, setUrlError] = useState<string | null>(null);

  const sortedItems = useMemo(
    () => [...items].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
    [items]
  );

  const loadWebhooks = useCallback(async (): Promise<void> => {
    try {
      setLoading(true);
      setRequestError(null);
      const response = await listOrgWebhooks(token);
      setItems(response);
    } catch (requestFailure) {
      if (requestFailure instanceof ApiError && requestFailure.code === "UPGRADE_REQUIRED") {
        setRequestError("Upgrade required for webhooks. Open Billing to continue.");
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
        requestFailure instanceof Error ? requestFailure.message : "Failed to load webhooks"
      );
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void loadWebhooks();
  }, [loadWebhooks]);

  useEffect(() => {
    if (!toast) {
      return;
    }
    const timer = window.setTimeout(() => setToast(null), 2400);
    return () => window.clearTimeout(timer);
  }, [toast]);

  function onToggleEvent(eventName: string): void {
    setSelectedEvents((currentEvents) =>
      currentEvents.includes(eventName)
        ? currentEvents.filter((value) => value !== eventName)
        : [...currentEvents, eventName]
    );
  }

  async function onCreate(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!isValidHttpsUrl(url.trim())) {
      setUrlError("Endpoint URL must be a valid HTTPS URL.");
      return;
    }
    if (selectedEvents.length === 0) {
      setRequestError("Select at least one event.");
      return;
    }

    try {
      setCreating(true);
      setRequestError(null);
      setUrlError(null);
      const response = await createOrgWebhook(token, {
        url: url.trim(),
        events: selectedEvents
      });
      setCreatedSecret(response.secret ?? null);
      setCreateOpen(false);
      setUrl("");
      setSelectedEvents([]);
      await loadWebhooks();
    } catch (requestFailure) {
      if (requestFailure instanceof ApiError && requestFailure.code === "UPGRADE_REQUIRED") {
        setRequestError("Upgrade required for webhooks. Open Billing to continue.");
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
        requestFailure instanceof Error ? requestFailure.message : "Failed to create webhook"
      );
    } finally {
      setCreating(false);
    }
  }

  async function onDelete(id: string): Promise<void> {
    const confirmed = window.confirm("Delete this webhook endpoint?");
    if (!confirmed) {
      return;
    }
    try {
      setDeletingId(id);
      setRequestError(null);
      await deleteOrgWebhook(token, id);
      await loadWebhooks();
      setToast("Webhook deleted.");
    } catch (requestFailure) {
      if (requestFailure instanceof ApiError && requestFailure.code === "UPGRADE_REQUIRED") {
        setRequestError("Upgrade required for webhooks. Open Billing to continue.");
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
        requestFailure instanceof Error ? requestFailure.message : "Failed to delete webhook"
      );
    } finally {
      setDeletingId(null);
    }
  }

  async function onCopySecret(): Promise<void> {
    if (!createdSecret) {
      return;
    }
    await navigator.clipboard.writeText(createdSecret);
    setToast("Secret copied.");
  }

  return (
    <section className="kv-stack" aria-live="polite">
      <div className="kv-row" style={{ justifyContent: "space-between" }}>
        <h2 className="kv-section-title" style={{ margin: 0 }}>
          Configure webhook endpoints
        </h2>
        <button
          type="button"
          className="kv-btn-primary"
          onClick={() => {
            setCreateOpen(true);
            setUrlError(null);
            setRequestError(null);
          }}
        >
          Add endpoint
        </button>
      </div>

      {requestError ? (
        <p className="kv-error">
          {requestError}{" "}
          {requestError.includes("Upgrade required") ? <Link href="/billing">Open Billing</Link> : null}
        </p>
      ) : null}
      {toast ? <p style={{ color: "var(--warning-color)", margin: 0 }}>{toast}</p> : null}

      {createdSecret ? (
        <div className="kv-card">
          <p style={{ margin: "0 0 6px", fontWeight: 600 }}>Webhook secret (shown once)</p>
          <p className="kv-subtitle" style={{ marginBottom: "8px" }}>
            Save this secret now. You cannot view it again.
          </p>
          <div className="kv-row">
            <input readOnly value={createdSecret} />
            <button type="button" onClick={() => void onCopySecret()}>
              Copy
            </button>
          </div>
        </div>
      ) : null}

      <div className="kv-card">
        <h3 style={{ marginTop: 0 }}>Signing instructions</h3>
        <p className="kv-subtitle" style={{ marginBottom: "6px" }}>
          Verify each request body with HMAC SHA256 using your webhook secret.
        </p>
        <p style={{ margin: "0 0 4px" }}>
          <strong>X-Kritviya-Signature</strong> = HMAC SHA256(body, secret)
        </p>
        <p style={{ margin: 0 }}>
          <strong>X-Kritviya-Event</strong> = event name
        </p>
      </div>

      <div className="kv-table-wrap">
        <table>
          <thead>
            <tr>
              <th align="left">URL</th>
              <th align="left">Events</th>
              <th align="left">Active</th>
              <th align="left">Failures</th>
              <th align="left">Last Failure</th>
              <th align="left">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={6}>Loading webhooks...</td>
              </tr>
            ) : null}
            {!loading && sortedItems.length === 0 ? (
              <tr>
                <td colSpan={6}>No webhook endpoints configured.</td>
              </tr>
            ) : null}
            {!loading
              ? sortedItems.map((item) => (
                  <tr key={item.id}>
                    <td>{item.url}</td>
                    <td>{joinEvents(item.events)}</td>
                    <td>
                      <span className="kv-pill">{item.isActive ? "Yes" : "No"}</span>
                    </td>
                    <td>{item.failureCount ?? 0}</td>
                    <td>{formatDateTime(item.lastFailureAt)}</td>
                    <td>
                      <button
                        type="button"
                        onClick={() => void onDelete(item.id)}
                        disabled={deletingId === item.id}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))
              : null}
          </tbody>
        </table>
      </div>

      {createOpen ? (
        <div className="kv-modal-backdrop">
          <div className="kv-modal">
            <h2 style={{ marginTop: 0 }}>Add webhook endpoint</h2>
            <form onSubmit={onCreate} className="kv-form">
              <label>
                Endpoint URL
                <input
                  type="url"
                  placeholder="https://example.com/hooks/kritviya"
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  required
                />
              </label>
              {urlError ? <p className="kv-error">{urlError}</p> : null}

              <fieldset style={{ border: "1px solid var(--border-color)", borderRadius: "8px" }}>
                <legend style={{ padding: "0 6px" }}>Events</legend>
                <div className="kv-grid-2">
                  {SUPPORTED_EVENTS.map((eventName) => (
                    <label key={eventName} style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                      <input
                        type="checkbox"
                        checked={selectedEvents.includes(eventName)}
                        onChange={() => onToggleEvent(eventName)}
                        style={{ width: "auto" }}
                      />
                      <span>{eventName}</span>
                    </label>
                  ))}
                </div>
              </fieldset>

              <div className="kv-row" style={{ justifyContent: "flex-end" }}>
                <button type="button" onClick={() => setCreateOpen(false)}>
                  Cancel
                </button>
                <button type="submit" className="kv-btn-primary" disabled={creating}>
                  {creating ? "Creating..." : "Create webhook"}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </section>
  );
}
