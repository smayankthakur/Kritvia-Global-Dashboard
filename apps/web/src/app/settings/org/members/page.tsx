"use client";

import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";
import { AppShell } from "../../../../components/app-shell";
import { ApiError, OrgMemberRow, inviteOrgMember, listOrgMembers } from "../../../../lib/api";
import { useAuthUser } from "../../../../lib/use-auth-user";
import { Role } from "../../../../types/auth";

const roleOptions: Role[] = ["CEO", "OPS", "SALES", "FINANCE", "ADMIN"];

function canManage(role: string): boolean {
  return role === "CEO" || role === "ADMIN";
}

export default function OrgMembersPage() {
  const { user, token, loading, error } = useAuthUser();
  const [members, setMembers] = useState<OrgMemberRow[]>([]);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [loadingData, setLoadingData] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("OPS");
  const [inviteResult, setInviteResult] = useState<{ inviteLink: string; expiresAt: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function loadMembers(currentToken: string): Promise<void> {
    try {
      setLoadingData(true);
      setRequestError(null);
      const payload = await listOrgMembers(currentToken);
      setMembers(payload);
      setForbidden(false);
    } catch (requestFailure) {
      if (requestFailure instanceof ApiError && requestFailure.status === 403) {
        setForbidden(true);
        return;
      }
      setRequestError(
        requestFailure instanceof Error ? requestFailure.message : "Failed to load members"
      );
    } finally {
      setLoadingData(false);
    }
  }

  useEffect(() => {
    if (!token) {
      return;
    }
    void loadMembers(token);
  }, [token]);

  async function onInvite(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!token) {
      return;
    }
    try {
      setSubmitting(true);
      setRequestError(null);
      const response = await inviteOrgMember(token, { email, role });
      setInviteResult(response);
      setEmail("");
      await loadMembers(token);
    } catch (requestFailure) {
      setRequestError(requestFailure instanceof Error ? requestFailure.message : "Failed to invite");
    } finally {
      setSubmitting(false);
    }
  }

  async function copyInviteLink(): Promise<void> {
    if (!inviteResult) {
      return;
    }
    await navigator.clipboard.writeText(inviteResult.inviteLink);
  }

  if (loading || !user) {
    return <main className="kv-main">Loading...</main>;
  }
  if (error) {
    return <main className="kv-main">401: {error}</main>;
  }
  if (!canManage(user.role)) {
    return (
      <AppShell user={user} title="Org Members">
        <div className="kv-state">
          <h2 style={{ marginTop: 0 }}>403: Forbidden</h2>
          <p>You do not have access to membership management.</p>
          <Link href="/">Go to dashboard</Link>
        </div>
      </AppShell>
    );
  }
  if (forbidden) {
    return (
      <AppShell user={user} title="Org Members">
        <p>403: Forbidden</p>
      </AppShell>
    );
  }

  return (
    <AppShell user={user} title="Org Members">
      <div className="kv-row" style={{ justifyContent: "space-between", marginBottom: "12px" }}>
        <p className="kv-subtitle" style={{ margin: 0 }}>
          Invite and manage organization members.
        </p>
        <button type="button" className="kv-btn-primary" onClick={() => setInviteOpen(true)}>
          Invite Member
        </button>
      </div>

      {requestError ? <p className="kv-error">{requestError}</p> : null}

      {loadingData ? (
        <div className="kv-stack">
          <div className="kv-timeline-skeleton" />
          <div className="kv-timeline-skeleton" />
        </div>
      ) : (
        <div className="kv-table-wrap">
          <table>
            <thead>
              <tr>
                <th align="left">Name</th>
                <th align="left">Email</th>
                <th align="left">Role</th>
                <th align="left">Status</th>
                <th align="left">Joined</th>
              </tr>
            </thead>
            <tbody>
              {members.map((member) => (
                <tr key={`${member.email}-${member.userId ?? "pending"}`}>
                  <td>{member.name ?? "Pending"}</td>
                  <td>{member.email}</td>
                  <td>{member.role}</td>
                  <td>{member.status}</td>
                  <td>{member.joinedAt ? new Date(member.joinedAt).toLocaleString() : "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {inviteOpen ? (
        <div className="kv-modal-backdrop">
          <div className="kv-modal">
            <h3 style={{ marginTop: 0 }}>Invite Member</h3>
            <form onSubmit={(event) => void onInvite(event)} className="kv-form">
              <label htmlFor="inviteEmail">Email</label>
              <input
                id="inviteEmail"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
              />
              <label htmlFor="inviteRole">Role</label>
              <select
                id="inviteRole"
                value={role}
                onChange={(event) => setRole(event.target.value as Role)}
              >
                {roleOptions.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
              <div className="kv-row">
                <button type="submit" className="kv-btn-primary" disabled={submitting}>
                  {submitting ? "Inviting..." : "Send Invite"}
                </button>
                <button type="button" onClick={() => setInviteOpen(false)} disabled={submitting}>
                  Close
                </button>
              </div>
            </form>

            {inviteResult ? (
              <div className="kv-card" style={{ marginTop: "12px" }}>
                <p style={{ marginTop: 0, fontWeight: 600 }}>Invite link</p>
                <input readOnly value={inviteResult.inviteLink} />
                <p className="kv-note">
                  Expires: {new Date(inviteResult.expiresAt).toLocaleString()}
                </p>
                <button type="button" onClick={() => void copyInviteLink()}>
                  Copy
                </button>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </AppShell>
  );
}
