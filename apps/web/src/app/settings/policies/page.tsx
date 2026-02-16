"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AppShell } from "../../../components/app-shell";
import {
  ApiError,
  PolicySettings,
  getPolicySettings,
  runAutopilotNow,
  updatePolicySettings
} from "../../../lib/api";
import { useAuthUser } from "../../../lib/use-auth-user";

type PolicyForm = Omit<PolicySettings, "id" | "orgId" | "createdAt" | "updatedAt">;

type RangeErrors = Partial<Record<keyof PolicyForm, string>>;

function canManagePolicies(role: string): boolean {
  return role === "ADMIN" || role === "CEO";
}

function pickPolicyForm(policy: PolicySettings): PolicyForm {
  return {
    lockInvoiceOnSent: policy.lockInvoiceOnSent,
    overdueAfterDays: policy.overdueAfterDays,
    defaultWorkDueDays: policy.defaultWorkDueDays,
    staleDealAfterDays: policy.staleDealAfterDays,
    leadStaleAfterHours: policy.leadStaleAfterHours,
    requireDealOwner: policy.requireDealOwner,
    requireWorkOwner: policy.requireWorkOwner,
    requireWorkDueDate: policy.requireWorkDueDate,
    autoLockInvoiceAfterDays: policy.autoLockInvoiceAfterDays,
    preventInvoiceUnlockAfterPartialPayment: policy.preventInvoiceUnlockAfterPartialPayment,
    autopilotEnabled: policy.autopilotEnabled,
    autopilotCreateWorkOnDealStageChange: policy.autopilotCreateWorkOnDealStageChange,
    autopilotNudgeOnOverdue: policy.autopilotNudgeOnOverdue,
    autopilotAutoStaleDeals: policy.autopilotAutoStaleDeals,
    auditRetentionDays: policy.auditRetentionDays,
    securityEventRetentionDays: policy.securityEventRetentionDays,
    ipRestrictionEnabled: policy.ipRestrictionEnabled,
    ipAllowlist: policy.ipAllowlist ?? []
  };
}

function isValidIpAllowlistEntry(entry: string): boolean {
  const trimmed = entry.trim();
  const exactIp = /^(?:\d{1,3}\.){3}\d{1,3}$/.test(trimmed);
  const cidr = /^(?:\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/.test(trimmed);
  return exactIp || cidr;
}

function validatePolicyForm(policy: PolicyForm): RangeErrors {
  const errors: RangeErrors = {};

  if (policy.defaultWorkDueDays < 0 || policy.defaultWorkDueDays > 30) {
    errors.defaultWorkDueDays = "Default work due days must be between 0 and 30.";
  }
  if (policy.staleDealAfterDays < 1 || policy.staleDealAfterDays > 60) {
    errors.staleDealAfterDays = "Stale deal days must be between 1 and 60.";
  }
  if (policy.leadStaleAfterHours < 1 || policy.leadStaleAfterHours > 720) {
    errors.leadStaleAfterHours = "Lead stale hours must be between 1 and 720.";
  }
  if (policy.autoLockInvoiceAfterDays < 0 || policy.autoLockInvoiceAfterDays > 30) {
    errors.autoLockInvoiceAfterDays = "Auto lock invoice days must be between 0 and 30.";
  }
  if (policy.auditRetentionDays < 30 || policy.auditRetentionDays > 3650) {
    errors.auditRetentionDays = "Audit retention days must be between 30 and 3650.";
  }
  if (policy.securityEventRetentionDays < 30 || policy.securityEventRetentionDays > 3650) {
    errors.securityEventRetentionDays =
      "Security event retention days must be between 30 and 3650.";
  }

  const invalidIpEntries = (policy.ipAllowlist ?? [])
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && !isValidIpAllowlistEntry(entry));
  if (invalidIpEntries.length > 0) {
    errors.ipAllowlist = "IP allowlist contains invalid IP/CIDR values.";
  }

  return errors;
}

export default function SettingsPoliciesPage() {
  const { user, token, loading, error } = useAuthUser();
  const [initial, setInitial] = useState<PolicyForm | null>(null);
  const [draft, setDraft] = useState<PolicyForm | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [loadingPolicy, setLoadingPolicy] = useState(false);
  const [savePending, setSavePending] = useState(false);
  const [jobPending, setJobPending] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const canRunAutopilot = user?.role === "ADMIN";

  const validationErrors = useMemo(() => (draft ? validatePolicyForm(draft) : {}), [draft]);

  const isDirty =
    initial && draft ? JSON.stringify(initial) !== JSON.stringify(draft) : false;

  const hasValidationErrors = Object.keys(validationErrors).length > 0;

  const loadPolicy = useCallback(async (): Promise<void> => {
    if (!token) {
      return;
    }

    try {
      setLoadingPolicy(true);
      setRequestError(null);
      const policy = await getPolicySettings(token);
      const mapped = pickPolicyForm(policy);
      setInitial(mapped);
      setDraft(mapped);
      setForbidden(false);
    } catch (requestFailure) {
      if (requestFailure instanceof ApiError && requestFailure.status === 403) {
        setForbidden(true);
        return;
      }
      setRequestError(
        requestFailure instanceof Error ? requestFailure.message : "Failed to load settings"
      );
    } finally {
      setLoadingPolicy(false);
    }
  }, [token]);

  useEffect(() => {
    if (!token || !user || !canManagePolicies(user.role)) {
      return;
    }
    void loadPolicy();
  }, [loadPolicy, token, user]);

  function updateBooleanField<K extends keyof PolicyForm>(field: K, value: boolean): void {
    setDraft((current) => (current ? { ...current, [field]: value } : current));
  }

  function updateIntField<K extends keyof PolicyForm>(field: K, value: string): void {
    const parsed = Number.parseInt(value, 10);
    setDraft((current) =>
      current
        ? {
            ...current,
            [field]: Number.isNaN(parsed) ? 0 : parsed
          }
        : current
    );
  }

  function updateIpAllowlist(value: string): void {
    const entries = value
      .split("\n")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    setDraft((current) => (current ? { ...current, ipAllowlist: entries } : current));
  }

  async function onSave(): Promise<void> {
    if (!token || !draft || hasValidationErrors || !isDirty) {
      return;
    }

    try {
      setSavePending(true);
      setRequestError(null);
      const updated = await updatePolicySettings(token, draft);
      const mapped = pickPolicyForm(updated);
      setInitial(mapped);
      setDraft(mapped);
      setSuccessMessage("Policy saved.");
    } catch (requestFailure) {
      setRequestError(
        requestFailure instanceof Error ? requestFailure.message : "Failed to save policy"
      );
    } finally {
      setSavePending(false);
    }
  }

  async function onRunAutopilotNow(): Promise<void> {
    if (!token) {
      return;
    }

    try {
      setJobPending(true);
      setRequestError(null);
      const summary = await runAutopilotNow(token);
      setSuccessMessage(
        `Autopilot completed. Orgs: ${summary.processedOrgs}, invoices locked: ${summary.invoicesLocked}, deals staled: ${summary.dealsStaled}, nudges created: ${summary.nudgesCreated}.`
      );
    } catch (requestFailure) {
      setRequestError(
        requestFailure instanceof Error ? requestFailure.message : "Failed to run autopilot"
      );
    } finally {
      setJobPending(false);
    }
  }

  if (loading || !user) {
    return <main className="kv-main">Loading...</main>;
  }

  if (error) {
    return <main className="kv-main">401: {error}</main>;
  }

  if (!canManagePolicies(user.role)) {
    return (
      <AppShell user={user} title="Policy Settings">
        <div className="kv-state">
          <h2 style={{ marginTop: 0 }}>403: Forbidden</h2>
          <p>You do not have access to policy settings.</p>
          <Link href="/">Go to dashboard</Link>
        </div>
      </AppShell>
    );
  }

  if (forbidden) {
    return (
      <AppShell user={user} title="Policy Settings">
        <div className="kv-state">
          <h2 style={{ marginTop: 0 }}>403: Forbidden</h2>
          <p>Your role is not permitted to access policy settings.</p>
          <Link href="/">Go to dashboard</Link>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell user={user} title="Policies">
      <p className="kv-subtitle" style={{ marginBottom: "12px" }}>
        Configure guardrails, SLA defaults, invoice discipline, and autopilot behavior.
      </p>

      {requestError ? <p className="kv-error">{requestError}</p> : null}
      {successMessage ? <p style={{ color: "var(--success-color)" }}>{successMessage}</p> : null}

      {loadingPolicy || !draft ? (
        <div className="kv-stack">
          <div className="kv-timeline-skeleton" />
          <div className="kv-timeline-skeleton" />
          <div className="kv-timeline-skeleton" />
          <div className="kv-timeline-skeleton" />
        </div>
      ) : (
        <>
          <div className="kv-policy-grid">
            <section className="kv-card kv-policy-card">
              <h2 className="kv-section-title">Guardrails</h2>
              <div className="kv-policy-row">
                <label htmlFor="requireDealOwner">Require deal owner</label>
                <input
                  id="requireDealOwner"
                  type="checkbox"
                  checked={draft.requireDealOwner}
                  onChange={(event) => updateBooleanField("requireDealOwner", event.target.checked)}
                  aria-label="Require deal owner"
                />
              </div>
              <div className="kv-policy-row">
                <label htmlFor="requireWorkOwner">Require work owner</label>
                <input
                  id="requireWorkOwner"
                  type="checkbox"
                  checked={draft.requireWorkOwner}
                  onChange={(event) => updateBooleanField("requireWorkOwner", event.target.checked)}
                  aria-label="Require work owner"
                />
              </div>
              <div className="kv-policy-row">
                <label htmlFor="requireWorkDueDate">Require work due date</label>
                <input
                  id="requireWorkDueDate"
                  type="checkbox"
                  checked={draft.requireWorkDueDate}
                  onChange={(event) =>
                    updateBooleanField("requireWorkDueDate", event.target.checked)
                  }
                  aria-label="Require work due date"
                />
              </div>
            </section>

            <section className="kv-card kv-policy-card">
              <h2 className="kv-section-title">SLA Defaults</h2>
              <label htmlFor="defaultWorkDueDays">Default work due days (0-30)</label>
              <input
                id="defaultWorkDueDays"
                type="number"
                min={0}
                max={30}
                value={draft.defaultWorkDueDays}
                onChange={(event) => updateIntField("defaultWorkDueDays", event.target.value)}
              />
              {validationErrors.defaultWorkDueDays ? (
                <p className="kv-error">{validationErrors.defaultWorkDueDays}</p>
              ) : null}

              <label htmlFor="staleDealAfterDays">Stale deal after days (1-60)</label>
              <input
                id="staleDealAfterDays"
                type="number"
                min={1}
                max={60}
                value={draft.staleDealAfterDays}
                onChange={(event) => updateIntField("staleDealAfterDays", event.target.value)}
              />
              {validationErrors.staleDealAfterDays ? (
                <p className="kv-error">{validationErrors.staleDealAfterDays}</p>
              ) : null}

              <label htmlFor="leadStaleAfterHours">Lead stale after hours (1-720)</label>
              <input
                id="leadStaleAfterHours"
                type="number"
                min={1}
                max={720}
                value={draft.leadStaleAfterHours}
                onChange={(event) => updateIntField("leadStaleAfterHours", event.target.value)}
              />
              {validationErrors.leadStaleAfterHours ? (
                <p className="kv-error">{validationErrors.leadStaleAfterHours}</p>
              ) : null}
            </section>

            <section className="kv-card kv-policy-card">
              <h2 className="kv-section-title">Invoice Discipline</h2>
              <label htmlFor="autoLockInvoiceAfterDays">Auto lock invoice after days (0-30)</label>
              <input
                id="autoLockInvoiceAfterDays"
                type="number"
                min={0}
                max={30}
                value={draft.autoLockInvoiceAfterDays}
                onChange={(event) =>
                  updateIntField("autoLockInvoiceAfterDays", event.target.value)
                }
              />
              {validationErrors.autoLockInvoiceAfterDays ? (
                <p className="kv-error">{validationErrors.autoLockInvoiceAfterDays}</p>
              ) : null}

              <div className="kv-policy-row">
                <label htmlFor="preventInvoiceUnlockAfterPartialPayment">
                  Prevent invoice unlock after partial payment
                </label>
                <input
                  id="preventInvoiceUnlockAfterPartialPayment"
                  type="checkbox"
                  checked={draft.preventInvoiceUnlockAfterPartialPayment}
                  onChange={(event) =>
                    updateBooleanField(
                      "preventInvoiceUnlockAfterPartialPayment",
                      event.target.checked
                    )
                  }
                  aria-label="Prevent invoice unlock after partial payment"
                />
              </div>
            </section>

            <section className="kv-card kv-policy-card">
              <h2 className="kv-section-title">Autopilot</h2>
              <div className="kv-policy-row">
                <label htmlFor="autopilotEnabled">Autopilot enabled</label>
                <input
                  id="autopilotEnabled"
                  type="checkbox"
                  checked={draft.autopilotEnabled}
                  onChange={(event) => updateBooleanField("autopilotEnabled", event.target.checked)}
                  aria-label="Autopilot enabled"
                />
              </div>
              <div className="kv-policy-row">
                <label htmlFor="autopilotCreateWorkOnDealStageChange">
                  Create work on deal stage change
                </label>
                <input
                  id="autopilotCreateWorkOnDealStageChange"
                  type="checkbox"
                  checked={draft.autopilotCreateWorkOnDealStageChange}
                  onChange={(event) =>
                    updateBooleanField(
                      "autopilotCreateWorkOnDealStageChange",
                      event.target.checked
                    )
                  }
                  aria-label="Create work on deal stage change"
                />
              </div>
              <div className="kv-policy-row">
                <label htmlFor="autopilotNudgeOnOverdue">Nudge on overdue</label>
                <input
                  id="autopilotNudgeOnOverdue"
                  type="checkbox"
                  checked={draft.autopilotNudgeOnOverdue}
                  onChange={(event) =>
                    updateBooleanField("autopilotNudgeOnOverdue", event.target.checked)
                  }
                  aria-label="Nudge on overdue"
                />
              </div>
              <div className="kv-policy-row">
                <label htmlFor="autopilotAutoStaleDeals">Auto stale deals</label>
                <input
                  id="autopilotAutoStaleDeals"
                  type="checkbox"
                  checked={draft.autopilotAutoStaleDeals}
                  onChange={(event) =>
                    updateBooleanField("autopilotAutoStaleDeals", event.target.checked)
                  }
                  aria-label="Auto stale deals"
                />
              </div>
            </section>

            <section className="kv-card kv-policy-card">
              <h2 className="kv-section-title">Retention</h2>
              <label htmlFor="auditRetentionDays">Audit retention days (30-3650)</label>
              <input
                id="auditRetentionDays"
                type="number"
                min={30}
                max={3650}
                value={draft.auditRetentionDays}
                onChange={(event) => updateIntField("auditRetentionDays", event.target.value)}
              />
              {validationErrors.auditRetentionDays ? (
                <p className="kv-error">{validationErrors.auditRetentionDays}</p>
              ) : null}

              <label htmlFor="securityEventRetentionDays">
                Security event retention days (30-3650)
              </label>
              <input
                id="securityEventRetentionDays"
                type="number"
                min={30}
                max={3650}
                value={draft.securityEventRetentionDays}
                onChange={(event) =>
                  updateIntField("securityEventRetentionDays", event.target.value)
                }
              />
              {validationErrors.securityEventRetentionDays ? (
                <p className="kv-error">{validationErrors.securityEventRetentionDays}</p>
              ) : null}

              <div className="kv-policy-row" style={{ marginTop: "12px" }}>
                <label htmlFor="ipRestrictionEnabled">Enable IP allowlist restrictions</label>
                <input
                  id="ipRestrictionEnabled"
                  type="checkbox"
                  checked={draft.ipRestrictionEnabled}
                  onChange={(event) =>
                    updateBooleanField("ipRestrictionEnabled", event.target.checked)
                  }
                />
              </div>

              <label htmlFor="ipAllowlist">IP allowlist (one IP/CIDR per line)</label>
              <textarea
                id="ipAllowlist"
                rows={4}
                value={(draft.ipAllowlist ?? []).join("\n")}
                onChange={(event) => updateIpAllowlist(event.target.value)}
              />
              {validationErrors.ipAllowlist ? (
                <p className="kv-error">{validationErrors.ipAllowlist}</p>
              ) : null}
            </section>
          </div>

          <div className="kv-row" style={{ justifyContent: "space-between", marginTop: "12px" }}>
            <button
              type="button"
              onClick={() => void onRunAutopilotNow()}
              disabled={jobPending || !canRunAutopilot}
              className="kv-btn-primary"
              title={!canRunAutopilot ? "Only ADMIN can trigger autopilot jobs." : undefined}
            >
              {jobPending ? "Running..." : "Run Autopilot Now"}
            </button>
            <button
              type="button"
              onClick={() => void onSave()}
              disabled={!isDirty || hasValidationErrors || savePending}
              className="kv-btn-primary"
            >
              {savePending ? "Saving..." : "Save Policy"}
            </button>
          </div>
        </>
      )}
    </AppShell>
  );
}
