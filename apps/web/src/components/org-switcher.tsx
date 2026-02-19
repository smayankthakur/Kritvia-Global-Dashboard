"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ApiError, createOrganization, meRequest, switchOrgRequest } from "../lib/api";
import { getAccessToken, setAccessToken } from "../lib/auth";
import { AuthMeResponse, OrgMembership } from "../types/auth";

interface OrgSwitcherProps {
  user: AuthMeResponse;
}

function sortedMemberships(memberships: OrgMembership[]): OrgMembership[] {
  return [...memberships].sort((left, right) => left.orgName.localeCompare(right.orgName));
}

export function OrgSwitcher({ user }: OrgSwitcherProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busyOrgId, setBusyOrgId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createSlug, setCreateSlug] = useState("");
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const memberships = sortedMemberships(user.memberships ?? []);
  const activeOrgId = user.activeOrgId ?? user.orgId;
  const activeMembership = memberships.find((membership) => membership.orgId === activeOrgId) ?? null;
  const showDropdown = memberships.length > 1;

  useEffect(() => {
    if (!toast) {
      return;
    }
    const timer = window.setTimeout(() => setToast(null), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  async function onSwitchOrg(orgId: string, orgName: string): Promise<void> {
    if (orgId === activeOrgId) {
      setOpen(false);
      return;
    }
    const token = getAccessToken();
    if (!token) {
      setToast("Session missing. Please login again.");
      return;
    }
    try {
      setBusyOrgId(orgId);
      const switched = await switchOrgRequest(token, orgId);
      setAccessToken(switched.accessToken);
      await meRequest(switched.accessToken);
      setToast(`Switched to ${orgName}`);
      setOpen(false);
      router.refresh();
      window.setTimeout(() => {
        window.location.reload();
      }, 120);
    } catch (requestFailure) {
      if (requestFailure instanceof ApiError && (requestFailure.status === 401 || requestFailure.status === 403)) {
        setToast("Organization switch denied.");
      } else {
        setToast(requestFailure instanceof Error ? requestFailure.message : "Failed to switch organization.");
      }
    } finally {
      setBusyOrgId(null);
    }
  }

  async function onCreateOrg(): Promise<void> {
    const token = getAccessToken();
    if (!token) {
      setCreateError("Session missing. Please login again.");
      return;
    }
    if (!createName.trim()) {
      setCreateError("Organization name is required.");
      return;
    }
    try {
      setCreateBusy(true);
      setCreateError(null);
      const created = await createOrganization(token, {
        name: createName.trim(),
        slug: createSlug.trim() ? createSlug.trim() : undefined
      });
      const switched = await switchOrgRequest(token, created.org.id);
      setAccessToken(switched.accessToken);
      await meRequest(switched.accessToken);
      setCreateOpen(false);
      setCreateName("");
      setCreateSlug("");
      setToast(`Created and switched to ${created.org.name}`);
      router.replace("/");
      router.refresh();
      window.setTimeout(() => {
        window.location.reload();
      }, 120);
    } catch (requestFailure) {
      if (requestFailure instanceof ApiError) {
        setCreateError(requestFailure.message);
        return;
      }
      setCreateError(
        requestFailure instanceof Error ? requestFailure.message : "Failed to create organization."
      );
    } finally {
      setCreateBusy(false);
    }
  }

  return (
    <div className="kv-org-switcher-wrap">
      {showDropdown ? (
        <div className="kv-org-switcher">
          <button
            type="button"
            className="kv-org-switcher-trigger"
            onClick={() => setOpen((current) => !current)}
            aria-label="Switch organization"
          >
            <span>{activeMembership?.orgName ?? "Current Org"}</span>
            <span aria-hidden>▾</span>
          </button>
          {open ? (
            <div className="kv-org-dropdown">
              {memberships.map((membership) => {
                const isActive = membership.orgId === activeOrgId;
                const disabled = membership.status !== "ACTIVE" || busyOrgId !== null;
                return (
                  <button
                    key={membership.orgId}
                    type="button"
                    className={`kv-org-option${isActive ? " kv-org-option-active" : ""}`}
                    onClick={() => void onSwitchOrg(membership.orgId, membership.orgName)}
                    disabled={disabled}
                  >
                    <div className="kv-org-row">
                      <span>{membership.orgName}</span>
                      <span className="kv-pill">{membership.role}</span>
                    </div>
                    <div className="kv-org-row">
                      <span className={`kv-org-status kv-org-status-${membership.status.toLowerCase()}`}>
                        {membership.status}
                      </span>
                      {busyOrgId === membership.orgId ? <span className="kv-note">Switching...</span> : null}
                    </div>
                  </button>
                );
              })}
              <button
                type="button"
                className="kv-org-create-btn"
                onClick={() => {
                  setOpen(false);
                  setCreateOpen(true);
                }}
                disabled={busyOrgId !== null}
              >
                + Create new organization
              </button>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="kv-org-static-wrap">
          <span className="kv-org-static">{activeMembership?.orgName ?? "Current Org"}</span>
          <button
            type="button"
            className="kv-org-create-inline-btn"
            onClick={() => setCreateOpen(true)}
          >
            + New Org
          </button>
        </div>
      )}
      {toast ? <span className="kv-org-toast">{toast}</span> : null}
      {createOpen ? (
        <div className="kv-modal-backdrop">
          <div className="kv-modal">
            <h3 className="kv-org-create-title">Create Organization</h3>
            <p className="kv-note">Create a new org and switch to it immediately.</p>
            {createError ? <p className="kv-error">{createError}</p> : null}
            <div className="kv-form">
              <label htmlFor="orgCreateName">Organization Name</label>
              <input
                id="orgCreateName"
                value={createName}
                onChange={(event) => setCreateName(event.target.value)}
                placeholder="Acme Ventures"
                maxLength={80}
              />
              <label htmlFor="orgCreateSlug">Slug (optional)</label>
              <input
                id="orgCreateSlug"
                value={createSlug}
                onChange={(event) => setCreateSlug(event.target.value)}
                placeholder="acme-ventures"
                maxLength={80}
              />
              <p className="kv-note">Leave slug blank to auto-generate.</p>
              <div className="kv-row kv-org-create-actions">
                <button type="button" onClick={() => setCreateOpen(false)} disabled={createBusy}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="kv-btn-primary"
                  onClick={() => void onCreateOrg()}
                  disabled={createBusy}
                >
                  {createBusy ? "Creating..." : "Create & Switch"}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
