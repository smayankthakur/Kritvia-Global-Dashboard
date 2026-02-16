"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ApiError, meRequest, switchOrgRequest } from "../lib/api";
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
            </div>
          ) : null}
        </div>
      ) : (
        <span className="kv-org-static">{activeMembership?.orgName ?? "Current Org"}</span>
      )}
      {toast ? <span className="kv-org-toast">{toast}</span> : null}
    </div>
  );
}

