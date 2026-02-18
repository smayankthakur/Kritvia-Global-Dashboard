"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AppShell } from "../../../components/app-shell";
import {
  approveAutopilotRun,
  AutopilotRun,
  ApiError,
  CeoRiskSummaryPayload,
  confirmFixActionRun,
  createFixActionRun,
  FixActionRun,
  FixActionTemplate,
  generateRiskNudgesNow,
  getCeoRisk,
  getCeoRiskNudges,
  getCeoRiskWhy,
  getFixActionTemplates,
  listAutopilotRuns,
  listFixActionRuns,
  recomputeRisk,
  rollbackAutopilotRun,
  RiskAutoNudgeItem,
  RiskDriver
} from "../../../lib/api";
import { useAuthUser } from "../../../lib/use-auth-user";

function canView(role: string): boolean {
  return role === "CEO" || role === "ADMIN" || role === "OPS";
}

function canRecompute(role: string): boolean {
  return role === "CEO" || role === "ADMIN";
}

function formatCurrency(cents?: number): string {
  if (typeof cents !== "number") {
    return "-";
  }
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0
  }).format(cents / 100);
}

function formatDate(value?: string): string {
  if (!value) {
    return "-";
  }
  return new Date(value).toLocaleString();
}

function reasonSummary(driver: RiskDriver): string {
  if (!driver.reasonCodes.length) {
    return "No explicit reasons available.";
  }
  return driver.reasonCodes.join(", ");
}

function toFixEntityType(nudge: RiskAutoNudgeItem): "INVOICE" | "WORK_ITEM" | "INCIDENT" | null {
  if (nudge.entityType === "INVOICE") {
    return "INVOICE";
  }
  if (nudge.entityType === "WORK_ITEM") {
    return "WORK_ITEM";
  }
  if (nudge.entityType === "ALERT") {
    return "INCIDENT";
  }
  return null;
}

function actionRequiresInput(templateKey: FixActionTemplate["key"]): boolean {
  return templateKey === "REASSIGN_WORK" || templateKey === "SET_DUE_DATE";
}

function templateMatchesEntity(template: FixActionTemplate, entityType: "INVOICE" | "WORK_ITEM" | "INCIDENT") {
  if (template.key === "SEND_INVOICE_REMINDER") {
    return entityType === "INVOICE";
  }
  if (template.key === "REASSIGN_WORK") {
    return entityType === "WORK_ITEM";
  }
  if (template.key === "ESCALATE_INCIDENT") {
    return entityType === "INCIDENT";
  }
  if (template.key === "SET_DUE_DATE") {
    return entityType === "WORK_ITEM" || entityType === "INVOICE";
  }
  return false;
}

type SelectedNudgeForFix = {
  nudgeId: string;
  entityType: "INVOICE" | "WORK_ITEM" | "INCIDENT";
  entityId: string;
  message: string;
};

export default function CeoRiskPage() {
  const { user, token, loading, error } = useAuthUser();
  const [forbidden, setForbidden] = useState(false);
  const [data, setData] = useState<CeoRiskSummaryPayload | null>(null);
  const [drivers, setDrivers] = useState<RiskDriver[]>([]);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [loadingData, setLoadingData] = useState(false);
  const [recomputing, setRecomputing] = useState(false);
  const [riskNudges, setRiskNudges] = useState<RiskAutoNudgeItem[]>([]);
  const [generatingNudges, setGeneratingNudges] = useState(false);
  const [templates, setTemplates] = useState<FixActionTemplate[]>([]);
  const [selectedNudge, setSelectedNudge] = useState<SelectedNudgeForFix | null>(null);
  const [selectedTemplateKey, setSelectedTemplateKey] = useState<FixActionTemplate["key"] | "">("");
  const [assigneeUserId, setAssigneeUserId] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [actionReason, setActionReason] = useState("");
  const [submittingFix, setSubmittingFix] = useState(false);
  const [actionRuns, setActionRuns] = useState<FixActionRun[]>([]);
  const [selectedRunsEntity, setSelectedRunsEntity] = useState<{ entityType: string; entityId: string } | null>(null);
  const [autopilotRuns, setAutopilotRuns] = useState<AutopilotRun[]>([]);
  const [processingAutopilotRunId, setProcessingAutopilotRunId] = useState<string | null>(null);

  useEffect(() => {
    if (!token || !user || !canView(user.role)) {
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
      const [summary, why, nudges, fixTemplates, autopilotRunPayload] = await Promise.all([
        getCeoRisk(token),
        getCeoRiskWhy(token),
        getCeoRiskNudges(token),
        getFixActionTemplates(token),
        listAutopilotRuns(token, { page: 1, pageSize: 10 })
      ]);
      setData(summary);
      setDrivers(why.drivers);
      setRiskNudges(nudges.items);
      setTemplates(fixTemplates);
      setAutopilotRuns(autopilotRunPayload.items);
      setForbidden(false);
    } catch (requestFailure) {
      if (requestFailure instanceof ApiError && requestFailure.status === 403) {
        setForbidden(true);
        return;
      }
      setRequestError(
        requestFailure instanceof Error ? requestFailure.message : "Failed to load risk data"
      );
    } finally {
      setLoadingData(false);
    }
  }

  async function onApproveAutopilotRun(runId: string): Promise<void> {
    if (!token) {
      return;
    }
    setProcessingAutopilotRunId(runId);
    try {
      await approveAutopilotRun(token, runId);
      await load();
    } catch (requestFailure) {
      setRequestError(
        requestFailure instanceof Error ? requestFailure.message : "Failed to approve autopilot run"
      );
    } finally {
      setProcessingAutopilotRunId(null);
    }
  }

  async function onRollbackAutopilotRun(runId: string): Promise<void> {
    if (!token) {
      return;
    }
    setProcessingAutopilotRunId(runId);
    try {
      await rollbackAutopilotRun(token, runId);
      await load();
    } catch (requestFailure) {
      setRequestError(
        requestFailure instanceof Error ? requestFailure.message : "Failed to rollback autopilot run"
      );
    } finally {
      setProcessingAutopilotRunId(null);
    }
  }

  async function onRecompute(): Promise<void> {
    if (!token) {
      return;
    }
    setRecomputing(true);
    setRequestError(null);
    try {
      await recomputeRisk(token, { scope: "ORG" });
      await load();
    } catch (requestFailure) {
      setRequestError(
        requestFailure instanceof Error ? requestFailure.message : "Failed to recompute risk"
      );
    } finally {
      setRecomputing(false);
    }
  }

  async function onGenerateNudges(): Promise<void> {
    if (!token) {
      return;
    }
    setGeneratingNudges(true);
    setRequestError(null);
    try {
      await generateRiskNudgesNow(token);
      await load();
    } catch (requestFailure) {
      setRequestError(
        requestFailure instanceof Error ? requestFailure.message : "Failed to generate risk nudges"
      );
    } finally {
      setGeneratingNudges(false);
    }
  }

  async function onOpenRuns(entityType: string, entityId: string): Promise<void> {
    if (!token) {
      return;
    }
    setSelectedRunsEntity({ entityType, entityId });
    try {
      const runs = await listFixActionRuns(token, {
        entityType,
        entityId,
        page: 1,
        pageSize: 10
      });
      setActionRuns(runs.items);
    } catch (requestFailure) {
      setRequestError(
        requestFailure instanceof Error ? requestFailure.message : "Failed to load action runs"
      );
    }
  }

  function openFixModal(nudge: RiskAutoNudgeItem): void {
    const entityType = toFixEntityType(nudge);
    if (!entityType) {
      setRequestError("No compatible fix action for this nudge entity type.");
      return;
    }

    setSelectedNudge({
      nudgeId: nudge.id,
      entityType,
      entityId: nudge.entityId,
      message: nudge.message
    });
    setSelectedTemplateKey("");
    setAssigneeUserId("");
    setDueAt("");
    setActionReason("");
  }

  async function submitFixAction(): Promise<void> {
    if (!token || !selectedNudge || !selectedTemplateKey) {
      return;
    }

    const template = templates.find((item) => item.key === selectedTemplateKey);
    if (!template) {
      setRequestError("Selected fix template not found.");
      return;
    }

    const payload: {
      templateKey: FixActionTemplate["key"];
      nudgeId: string;
      entityType: "INVOICE" | "WORK_ITEM" | "INCIDENT";
      entityId: string;
      input?: Record<string, unknown>;
    } = {
      templateKey: template.key,
      nudgeId: selectedNudge.nudgeId,
      entityType: selectedNudge.entityType,
      entityId: selectedNudge.entityId
    };

    if (template.key === "REASSIGN_WORK") {
      if (!assigneeUserId.trim()) {
        setRequestError("assigneeUserId is required for reassignment.");
        return;
      }
      payload.input = {
        assigneeUserId: assigneeUserId.trim(),
        reason: actionReason.trim() || undefined
      };
    }

    if (template.key === "SET_DUE_DATE") {
      if (!dueAt) {
        setRequestError("dueAt is required for due date update.");
        return;
      }
      payload.input = {
        dueAt: new Date(dueAt).toISOString(),
        reason: actionReason.trim() || undefined
      };
    }

    setSubmittingFix(true);
    setRequestError(null);
    try {
      const run = await createFixActionRun(token, payload);
      if (run.requiresConfirmation) {
        await confirmFixActionRun(token, run.id);
      }
      await load();
      await onOpenRuns(selectedNudge.entityType, selectedNudge.entityId);
      setSelectedNudge(null);
      window.alert("Fix action submitted successfully.");
    } catch (requestFailure) {
      setRequestError(
        requestFailure instanceof Error ? requestFailure.message : "Failed to execute fix action"
      );
    } finally {
      setSubmittingFix(false);
    }
  }

  const availableTemplates = useMemo(() => {
    if (!selectedNudge) {
      return [];
    }
    return templates.filter((item) => templateMatchesEntity(item, selectedNudge.entityType));
  }, [templates, selectedNudge]);

  const selectedTemplate = useMemo(
    () => templates.find((item) => item.key === selectedTemplateKey) ?? null,
    [templates, selectedTemplateKey]
  );

  if (loading) {
    return <p style={{ padding: "24px" }}>Loading...</p>;
  }

  if (error || !user || !token) {
    return <p style={{ padding: "24px" }}>{error ?? "Authentication required."}</p>;
  }

  if (!canView(user.role) || forbidden) {
    return (
      <AppShell user={user} title="Org Risk">
        <div className="kv-card" style={{ padding: "16px" }}>
          <h2 style={{ marginTop: 0 }}>403: Forbidden</h2>
          <p>Your role is not permitted to access org risk analysis.</p>
          <Link href="/">Back to dashboard</Link>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell user={user} title="Org Risk">
      <div className="kv-card" style={{ padding: "16px", marginBottom: "16px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: "8px", flexWrap: "wrap" }}>
          <div>
            <p style={{ margin: 0, opacity: 0.8 }}>Execution Risk</p>
            <h2 style={{ margin: "6px 0" }}>{data?.orgRiskScore ?? 0}</h2>
            <p style={{ margin: 0, opacity: 0.8 }}>
              Delta vs yesterday: {typeof data?.deltaVsYesterday === "number" ? data.deltaVsYesterday : "-"}
            </p>
            <p style={{ margin: "6px 0 0", opacity: 0.8 }}>
              Generated at: {formatDate(data?.generatedAt)}
            </p>
          </div>
          {canRecompute(user.role) ? (
            <button
              type="button"
              className="kv-btn-primary"
              onClick={() => void onRecompute()}
              disabled={recomputing}
            >
              {recomputing ? "Recomputing..." : "Recompute now"}
            </button>
          ) : null}
        </div>
      </div>

      <div className="kv-card" style={{ padding: "16px" }}>
        <h2 style={{ marginTop: 0 }}>Top Drivers</h2>
        {requestError ? <p style={{ color: "var(--danger-text)" }}>{requestError}</p> : null}
        {loadingData ? <p>Loading risk drivers...</p> : null}
        {!loadingData && drivers.length === 0 ? (
          <p>No graph data available yet. Run graph backfill and recompute risk.</p>
        ) : null}

        {!loadingData && drivers.length > 0 ? (
          <table className="kv-table">
            <thead>
              <tr>
                <th>Title</th>
                <th>Type</th>
                <th>Risk</th>
                <th>Reason</th>
                <th>Evidence</th>
                <th>Open</th>
              </tr>
            </thead>
            <tbody>
              {drivers.map((driver) => (
                <tr key={driver.nodeId}>
                  <td>{driver.title ?? driver.nodeId}</td>
                  <td>{driver.type}</td>
                  <td>{driver.riskScore}</td>
                  <td>{reasonSummary(driver)}</td>
                  <td>
                    <div>Due: {formatDate(driver.evidence.dueAt)}</div>
                    <div>Amount: {formatCurrency(driver.evidence.amountCents)}</div>
                    <div>Status: {driver.evidence.status ?? "-"}</div>
                  </td>
                  <td>
                    {driver.deeplink?.url ? (
                      <Link href={driver.deeplink.url}>Open</Link>
                    ) : (
                      <span>-</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </div>

      <div className="kv-card" style={{ padding: "16px", marginTop: "16px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: "8px", flexWrap: "wrap" }}>
          <h2 style={{ marginTop: 0 }}>Auto Nudges created today</h2>
          {canRecompute(user.role) ? (
            <button
              type="button"
              onClick={() => void onGenerateNudges()}
              disabled={generatingNudges}
            >
              {generatingNudges ? "Generating..." : "Generate nudges now"}
            </button>
          ) : null}
        </div>
        {riskNudges.length === 0 ? <p>No risk auto nudges in the last 24 hours.</p> : null}
        {riskNudges.length > 0 ? (
          <table className="kv-table">
            <thead>
              <tr>
                <th>Title</th>
                <th>Severity</th>
                <th>Assigned To</th>
                <th>Status</th>
                <th>Open</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {riskNudges.map((nudge) => {
                const fixEntityType = toFixEntityType(nudge);
                return (
                  <tr key={nudge.id}>
                    <td>{nudge.message}</td>
                    <td>{nudge.severity}</td>
                    <td>{nudge.targetUser?.name ?? "-"}</td>
                    <td>{nudge.status}</td>
                    <td>
                      {nudge.deeplink?.url ? (
                        <Link href={nudge.deeplink.url}>Open</Link>
                      ) : (
                        <span>-</span>
                      )}
                    </td>
                    <td>
                      {fixEntityType ? (
                        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                          <button type="button" onClick={() => openFixModal(nudge)}>
                            Fix
                          </button>
                          <button
                            type="button"
                            onClick={() => void onOpenRuns(fixEntityType, nudge.entityId)}
                          >
                            Action Runs
                          </button>
                        </div>
                      ) : (
                        <span>-</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : null}
      </div>

      {selectedRunsEntity ? (
        <div className="kv-card" style={{ padding: "16px", marginTop: "16px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: "8px", flexWrap: "wrap" }}>
            <h3 style={{ marginTop: 0 }}>
              Action Runs ({selectedRunsEntity.entityType}:{selectedRunsEntity.entityId})
            </h3>
            <button type="button" onClick={() => setSelectedRunsEntity(null)}>
              Close
            </button>
          </div>
          {actionRuns.length === 0 ? <p>No action runs yet.</p> : null}
          {actionRuns.length > 0 ? (
            <table className="kv-table">
              <thead>
                <tr>
                  <th>Template</th>
                  <th>Status</th>
                  <th>Requested By</th>
                  <th>Created</th>
                  <th>Error</th>
                </tr>
              </thead>
              <tbody>
                {actionRuns.map((run) => (
                  <tr key={run.id}>
                    <td>{run.template?.title ?? run.templateId}</td>
                    <td>{run.status}</td>
                    <td>{run.requestedByUser?.name ?? run.requestedByUserId}</td>
                    <td>{formatDate(run.createdAt)}</td>
                    <td>{run.error ?? "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </div>
      ) : null}

      {selectedNudge ? (
        <div className="kv-card" style={{ padding: "16px", marginTop: "16px" }}>
          <h3 style={{ marginTop: 0 }}>One-click Fix</h3>
          <p style={{ opacity: 0.8 }}>{selectedNudge.message}</p>
          <p style={{ opacity: 0.8 }}>
            Entity: {selectedNudge.entityType} / {selectedNudge.entityId}
          </p>

          <label htmlFor="fix-template-select" style={{ display: "block", marginBottom: "6px" }}>
            Action template
          </label>
          <select
            id="fix-template-select"
            value={selectedTemplateKey}
            onChange={(event) => setSelectedTemplateKey(event.target.value as FixActionTemplate["key"] | "")}
            style={{ minWidth: "320px", marginBottom: "12px" }}
          >
            <option value="">Select template</option>
            {availableTemplates.map((template) => (
              <option key={template.id} value={template.key}>
                {template.title}
              </option>
            ))}
          </select>

          {selectedTemplate?.key === "REASSIGN_WORK" ? (
            <div style={{ marginBottom: "12px" }}>
              <label htmlFor="assignee-user-id" style={{ display: "block", marginBottom: "6px" }}>
                Assignee user id
              </label>
              <input
                id="assignee-user-id"
                value={assigneeUserId}
                onChange={(event) => setAssigneeUserId(event.target.value)}
                placeholder="UUID"
                style={{ minWidth: "320px" }}
              />
            </div>
          ) : null}

          {selectedTemplate?.key === "SET_DUE_DATE" ? (
            <div style={{ marginBottom: "12px" }}>
              <label htmlFor="due-at" style={{ display: "block", marginBottom: "6px" }}>
                Due at
              </label>
              <input
                id="due-at"
                type="datetime-local"
                value={dueAt}
                onChange={(event) => setDueAt(event.target.value)}
                style={{ minWidth: "320px" }}
              />
            </div>
          ) : null}

          {selectedTemplate && actionRequiresInput(selectedTemplate.key) ? (
            <div style={{ marginBottom: "12px" }}>
              <label htmlFor="fix-reason" style={{ display: "block", marginBottom: "6px" }}>
                Reason (optional)
              </label>
              <input
                id="fix-reason"
                value={actionReason}
                onChange={(event) => setActionReason(event.target.value)}
                style={{ minWidth: "320px" }}
              />
            </div>
          ) : null}

          {selectedTemplate ? (
            <p style={{ opacity: 0.8 }}>
              {selectedTemplate.requiresConfirmation
                ? "This action requires confirmation and will execute immediately after confirmation."
                : "This action executes immediately."}
            </p>
          ) : null}

          <div style={{ display: "flex", gap: "8px" }}>
            <button type="button" onClick={() => setSelectedNudge(null)} disabled={submittingFix}>
              Cancel
            </button>
            <button
              type="button"
              className="kv-btn-primary"
              disabled={submittingFix || !selectedTemplateKey}
              onClick={() => void submitFixAction()}
            >
              {submittingFix ? "Running..." : "Run Fix"}
            </button>
          </div>
        </div>
      ) : null}

      <div className="kv-card" style={{ padding: "16px", marginTop: "16px" }}>
        <h2 style={{ marginTop: 0 }}>Autopilot Activity</h2>
        {autopilotRuns.length === 0 ? <p>No autopilot runs recorded yet.</p> : null}
        {autopilotRuns.length > 0 ? (
          <table className="kv-table">
            <thead>
              <tr>
                <th>Entity</th>
                <th>Policy</th>
                <th>Status</th>
                <th>Preview</th>
                <th>Created</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {autopilotRuns.map((run) => (
                <tr key={run.id}>
                  <td>
                    {run.entityType}:{run.entityId}
                  </td>
                  <td>{run.policy?.name ?? run.policyId}</td>
                  <td>{run.status}</td>
                  <td>
                    <pre style={{ maxWidth: "320px", whiteSpace: "pre-wrap", margin: 0 }}>
                      {run.preview ? JSON.stringify(run.preview, null, 2) : "-"}
                    </pre>
                  </td>
                  <td>{formatDate(run.createdAt)}</td>
                  <td style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                    {run.status === "APPROVAL_REQUIRED" && canRecompute(user.role) ? (
                      <button
                        type="button"
                        disabled={processingAutopilotRunId === run.id}
                        onClick={() => void onApproveAutopilotRun(run.id)}
                      >
                        Approve
                      </button>
                    ) : null}
                    {run.status === "EXECUTED" && canRecompute(user.role) ? (
                      <button
                        type="button"
                        disabled={processingAutopilotRunId === run.id}
                        onClick={() => void onRollbackAutopilotRun(run.id)}
                      >
                        Rollback
                      </button>
                    ) : null}
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
