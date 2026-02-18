"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AppShell } from "../../../components/app-shell";
import {
  AutopilotPolicy,
  createAutopilotPolicy,
  deleteAutopilotPolicy,
  getFixActionTemplates,
  listAutopilotPolicies,
  updateAutopilotPolicy
} from "../../../lib/api";
import { useAuthUser } from "../../../lib/use-auth-user";

const ENTITY_TYPES = ["INVOICE", "WORK_ITEM", "INCIDENT"] as const;

type EntityType = (typeof ENTITY_TYPES)[number];

function canManage(role: string): boolean {
  return role === "CEO" || role === "ADMIN";
}

export default function AdminAutopilotPage() {
  const { user, token, loading, error } = useAuthUser();
  const [policies, setPolicies] = useState<AutopilotPolicy[]>([]);
  const [templates, setTemplates] = useState<Array<{ key: string; title: string }>>([]);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [loadingData, setLoadingData] = useState(false);

  const [name, setName] = useState("");
  const [entityType, setEntityType] = useState<EntityType>("INVOICE");
  const [actionTemplateKey, setActionTemplateKey] = useState("");
  const [conditionText, setConditionText] = useState('{"field":"riskScore","op":"gte","value":70}');
  const [riskThreshold, setRiskThreshold] = useState("");
  const [autoExecute, setAutoExecute] = useState(false);
  const [maxExecutionsPerHour, setMaxExecutionsPerHour] = useState("10");

  useEffect(() => {
    if (!token || !user || !canManage(user.role)) {
      return;
    }
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, user]);

  async function load(): Promise<void> {
    if (!token) {
      return;
    }

    setLoadingData(true);
    setRequestError(null);
    try {
      const [policyRows, templateRows] = await Promise.all([
        listAutopilotPolicies(token),
        getFixActionTemplates(token)
      ]);
      setPolicies(policyRows);
      setTemplates(templateRows.map((item) => ({ key: item.key, title: item.title })));
      if (!actionTemplateKey && templateRows.length > 0) {
        setActionTemplateKey(templateRows[0].key);
      }
    } catch (requestFailure) {
      setRequestError(
        requestFailure instanceof Error ? requestFailure.message : "Failed to load autopilot settings"
      );
    } finally {
      setLoadingData(false);
    }
  }

  async function onCreatePolicy(): Promise<void> {
    if (!token) {
      return;
    }
    let condition: Record<string, unknown>;
    try {
      condition = JSON.parse(conditionText) as Record<string, unknown>;
    } catch {
      setRequestError("Condition must be valid JSON");
      return;
    }

    try {
      await createAutopilotPolicy(token, {
        name: name.trim(),
        isEnabled: true,
        entityType,
        condition,
        actionTemplateKey,
        riskThreshold: riskThreshold ? Number(riskThreshold) : null,
        autoExecute,
        maxExecutionsPerHour: Number(maxExecutionsPerHour)
      });
      setName("");
      await load();
    } catch (requestFailure) {
      setRequestError(requestFailure instanceof Error ? requestFailure.message : "Failed to create policy");
    }
  }

  async function onTogglePolicy(policy: AutopilotPolicy): Promise<void> {
    if (!token) {
      return;
    }

    try {
      await updateAutopilotPolicy(token, policy.id, {
        isEnabled: !policy.isEnabled
      });
      await load();
    } catch (requestFailure) {
      setRequestError(requestFailure instanceof Error ? requestFailure.message : "Failed to update policy");
    }
  }

  async function onDeletePolicy(policyId: string): Promise<void> {
    if (!token) {
      return;
    }

    try {
      await deleteAutopilotPolicy(token, policyId);
      await load();
    } catch (requestFailure) {
      setRequestError(requestFailure instanceof Error ? requestFailure.message : "Failed to delete policy");
    }
  }

  if (loading) {
    return <p style={{ padding: "24px" }}>Loading...</p>;
  }

  if (error || !user || !token) {
    return <p style={{ padding: "24px" }}>{error ?? "Authentication required."}</p>;
  }

  if (!canManage(user.role)) {
    return (
      <AppShell user={user} title="Autopilot Policies">
        <div className="kv-card" style={{ padding: "16px" }}>
          <h2 style={{ marginTop: 0 }}>403: Forbidden</h2>
          <p>Only CEO and ADMIN can manage autopilot policies.</p>
          <Link href="/">Back to dashboard</Link>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell user={user} title="Autopilot Policies">
      <div className="kv-card" style={{ padding: "16px", marginBottom: "16px" }}>
        <h2 style={{ marginTop: 0 }}>Create Policy</h2>
        {requestError ? <p style={{ color: "var(--danger-text)" }}>{requestError}</p> : null}
        <div style={{ display: "grid", gap: "8px", maxWidth: "760px" }}>
          <input placeholder="Policy name" value={name} onChange={(event) => setName(event.target.value)} />

          <label>
            Entity Type
            <select value={entityType} onChange={(event) => setEntityType(event.target.value as EntityType)}>
              {ENTITY_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
          </label>

          <label>
            Action Template
            <select value={actionTemplateKey} onChange={(event) => setActionTemplateKey(event.target.value)}>
              <option value="">Select template</option>
              {templates.map((template) => (
                <option key={template.key} value={template.key}>
                  {template.title}
                </option>
              ))}
            </select>
          </label>

          <label>
            Condition JSON
            <textarea
              value={conditionText}
              onChange={(event) => setConditionText(event.target.value)}
              rows={4}
            />
          </label>

          <label>
            Risk Threshold
            <input
              type="number"
              min={0}
              max={100}
              value={riskThreshold}
              onChange={(event) => setRiskThreshold(event.target.value)}
            />
          </label>

          <label>
            Max Executions / Hour
            <input
              type="number"
              min={1}
              max={200}
              value={maxExecutionsPerHour}
              onChange={(event) => setMaxExecutionsPerHour(event.target.value)}
            />
          </label>

          <label style={{ display: "flex", gap: "8px", alignItems: "center" }}>
            <input
              type="checkbox"
              checked={autoExecute}
              onChange={(event) => setAutoExecute(event.target.checked)}
            />
            Auto execute (otherwise approval required)
          </label>

          <button
            type="button"
            className="kv-btn-primary"
            onClick={() => void onCreatePolicy()}
            disabled={!name.trim() || !actionTemplateKey}
          >
            Create Policy
          </button>
        </div>
      </div>

      <div className="kv-card" style={{ padding: "16px" }}>
        <h2 style={{ marginTop: 0 }}>Policies</h2>
        {loadingData ? <p>Loading policies...</p> : null}
        {!loadingData && policies.length === 0 ? <p>No autopilot policies configured.</p> : null}
        {policies.length > 0 ? (
          <table className="kv-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Entity</th>
                <th>Template</th>
                <th>Enabled</th>
                <th>Auto</th>
                <th>Max/Hr</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {policies.map((policy) => (
                <tr key={policy.id}>
                  <td>{policy.name}</td>
                  <td>{policy.entityType}</td>
                  <td>{policy.actionTemplateKey}</td>
                  <td>{policy.isEnabled ? "Yes" : "No"}</td>
                  <td>{policy.autoExecute ? "Yes" : "No"}</td>
                  <td>{policy.maxExecutionsPerHour}</td>
                  <td style={{ display: "flex", gap: "8px" }}>
                    <button type="button" onClick={() => void onTogglePolicy(policy)}>
                      {policy.isEnabled ? "Disable" : "Enable"}
                    </button>
                    <button type="button" onClick={() => void onDeletePolicy(policy.id)}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </div>
    </AppShell>
  );
}
