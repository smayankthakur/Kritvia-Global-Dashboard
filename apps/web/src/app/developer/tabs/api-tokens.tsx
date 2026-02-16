"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import {
  ApiError,
  ApiTokenRecord,
  ApiTokenRole,
  createOrgApiToken,
  listOrgApiTokens,
  revokeOrgApiToken
} from "../../../lib/api";

interface ApiTokensTabProps {
  token: string;
}

const ROLE_OPTIONS: ApiTokenRole[] = ["ADMIN", "CEO", "OPS", "SALES", "FINANCE", "READ_ONLY"];
const KNOWN_SCOPES = [
  "read:deals",
  "write:deals",
  "read:invoices",
  "write:invoices",
  "read:work-items",
  "write:work-items",
  "read:audit",
  "read:users",
  "write:users",
  "read:shield",
  "write:webhooks"
];

function formatDateTime(value: string | null | undefined): string {
  if (!value) {
    return "-";
  }
  return new Date(value).toLocaleString();
}

function formatScopes(scopes: string[] | null | undefined): string {
  if (!scopes || scopes.length === 0) {
    return "Full (role-based)";
  }
  return scopes.join(", ");
}

export function ApiTokensTab({ token }: ApiTokensTabProps) {
  const [items, setItems] = useState<ApiTokenRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [role, setRole] = useState<ApiTokenRole>("ADMIN");
  const [rateLimitPerHour, setRateLimitPerHour] = useState(1000);
  const [selectedScopes, setSelectedScopes] = useState<string[]>([]);
  const [createdRawToken, setCreatedRawToken] = useState<string | null>(null);

  const sortedItems = useMemo(
    () =>
      [...items].sort((a, b) => {
        if (a.revokedAt && !b.revokedAt) {
          return 1;
        }
        if (!a.revokedAt && b.revokedAt) {
          return -1;
        }
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      }),
    [items]
  );

  const loadTokens = useCallback(async (): Promise<void> => {
    try {
      setLoading(true);
      setRequestError(null);
      const response = await listOrgApiTokens(token);
      setItems(response);
    } catch (requestFailure) {
      if (requestFailure instanceof ApiError && requestFailure.code === "UPGRADE_REQUIRED") {
        setRequestError("Upgrade required for API tokens. Open Billing to continue.");
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
        requestFailure instanceof Error ? requestFailure.message : "Failed to load API tokens"
      );
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void loadTokens();
  }, [loadTokens]);

  useEffect(() => {
    if (!toast) {
      return;
    }
    const timer = window.setTimeout(() => setToast(null), 2400);
    return () => window.clearTimeout(timer);
  }, [toast]);

  async function onCreate(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    try {
      setCreating(true);
      setRequestError(null);
      const response = await createOrgApiToken(token, {
        name: name.trim(),
        role,
        scopes: selectedScopes.length > 0 ? selectedScopes : undefined,
        rateLimitPerHour
      });
      setCreatedRawToken(response.token);
      setCreateOpen(false);
      setName("");
      setRole("ADMIN");
      setRateLimitPerHour(1000);
      setSelectedScopes([]);
      await loadTokens();
    } catch (requestFailure) {
      if (requestFailure instanceof ApiError && requestFailure.code === "UPGRADE_REQUIRED") {
        setRequestError("Upgrade required for API tokens. Open Billing to continue.");
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
        requestFailure instanceof Error ? requestFailure.message : "Failed to create API token"
      );
    } finally {
      setCreating(false);
    }
  }

  async function onRevoke(id: string): Promise<void> {
    const confirmed = window.confirm("Revoke this token? It will stop working immediately.");
    if (!confirmed) {
      return;
    }

    try {
      setRevokingId(id);
      setRequestError(null);
      await revokeOrgApiToken(token, id);
      await loadTokens();
      setToast("Token revoked.");
    } catch (requestFailure) {
      if (requestFailure instanceof ApiError && requestFailure.code === "UPGRADE_REQUIRED") {
        setRequestError("Upgrade required for API tokens. Open Billing to continue.");
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
        requestFailure instanceof Error ? requestFailure.message : "Failed to revoke API token"
      );
    } finally {
      setRevokingId(null);
    }
  }

  async function onCopyRawToken(): Promise<void> {
    if (!createdRawToken) {
      return;
    }
    await navigator.clipboard.writeText(createdRawToken);
    setToast("Token copied.");
  }

  function onToggleScope(scope: string): void {
    setSelectedScopes((currentScopes) =>
      currentScopes.includes(scope)
        ? currentScopes.filter((value) => value !== scope)
        : [...currentScopes, scope]
    );
  }

  return (
    <section className="kv-stack" aria-live="polite">
      <div className="kv-row" style={{ justifyContent: "space-between" }}>
        <h2 className="kv-section-title" style={{ margin: 0 }}>
          Manage API tokens
        </h2>
        <button
          type="button"
          className="kv-btn-primary"
          onClick={() => {
            setCreateOpen(true);
            setRequestError(null);
          }}
        >
          Create token
        </button>
      </div>

      {requestError ? (
        <p className="kv-error">
          {requestError}{" "}
          {requestError.includes("Upgrade required") ? <Link href="/billing">Open Billing</Link> : null}
        </p>
      ) : null}
      {toast ? <p style={{ color: "var(--warning-color)", margin: 0 }}>{toast}</p> : null}

      {createdRawToken ? (
        <div className="kv-card">
          <p style={{ margin: "0 0 6px", fontWeight: 600 }}>Token value (shown once)</p>
          <p className="kv-subtitle" style={{ marginBottom: "8px" }}>
            Save this token now, you can&apos;t view it again.
          </p>
          <div className="kv-row">
            <input readOnly value={createdRawToken} />
            <button type="button" onClick={() => void onCopyRawToken()}>
              Copy
            </button>
          </div>
        </div>
      ) : null}

      <div className="kv-table-wrap">
        <table>
          <thead>
            <tr>
              <th align="left">Name</th>
              <th align="left">Role</th>
              <th align="left">Scopes</th>
              <th align="left">Rate Limit</th>
              <th align="left">Last Used</th>
              <th align="left">Status</th>
              <th align="left">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={7}>Loading tokens...</td>
              </tr>
            ) : null}
            {!loading && sortedItems.length === 0 ? (
              <tr>
                <td colSpan={7}>No API tokens created yet.</td>
              </tr>
            ) : null}
            {!loading
              ? sortedItems.map((apiToken) => (
                  <tr key={apiToken.id}>
                    <td>{apiToken.name}</td>
                    <td>{apiToken.role}</td>
                    <td>{formatScopes(apiToken.scopes)}</td>
                    <td>{apiToken.rateLimitPerHour ?? 1000}/hour</td>
                    <td>{formatDateTime(apiToken.lastUsedAt)}</td>
                    <td>
                      <span className="kv-pill">{apiToken.revokedAt ? "Revoked" : "Active"}</span>
                    </td>
                    <td>
                      <button
                        type="button"
                        onClick={() => void onRevoke(apiToken.id)}
                        disabled={Boolean(apiToken.revokedAt) || revokingId === apiToken.id}
                      >
                        Revoke
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
            <h2 style={{ marginTop: 0 }}>Create API token</h2>
            <form onSubmit={onCreate} className="kv-form">
              <label>
                Token name
                <input
                  placeholder="e.g. Zapier Sync"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  required
                />
              </label>
              <label>
                Role
                <select value={role} onChange={(event) => setRole(event.target.value as ApiTokenRole)}>
                  {ROLE_OPTIONS.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Rate limit (per hour)
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={rateLimitPerHour}
                  onChange={(event) =>
                    setRateLimitPerHour(Math.max(1, Number.parseInt(event.target.value || "1", 10)))
                  }
                />
              </label>
              <fieldset style={{ border: "1px solid var(--border-color)", borderRadius: "8px" }}>
                <legend style={{ padding: "0 6px" }}>Scopes</legend>
                <p className="kv-subtitle" style={{ marginTop: 0 }}>
                  Leave empty for full role-based access.
                </p>
                <div className="kv-grid-2">
                  {KNOWN_SCOPES.map((scope) => (
                    <label key={scope} style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                      <input
                        type="checkbox"
                        checked={selectedScopes.includes(scope)}
                        onChange={() => onToggleScope(scope)}
                        style={{ width: "auto" }}
                      />
                      <span>{scope}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <div className="kv-row" style={{ justifyContent: "flex-end" }}>
                <button type="button" onClick={() => setCreateOpen(false)}>
                  Cancel
                </button>
                <button type="submit" className="kv-btn-primary" disabled={creating}>
                  {creating ? "Creating..." : "Create token"}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </section>
  );
}
