"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { AppShell } from "../../../components/app-shell";
import {
  ApiError,
  ManagedUser,
  createManagedUser,
  deactivateManagedUser,
  listManagedUsers,
  reactivateManagedUser,
  updateManagedUser
} from "../../../lib/api";
import { useAuthUser } from "../../../lib/use-auth-user";
import { Role } from "../../../types/auth";

type ActiveFilter = "active" | "inactive" | "all";

const ROLE_OPTIONS: Role[] = ["CEO", "OPS", "SALES", "FINANCE", "ADMIN"];

function canManageUsers(role: Role): boolean {
  return role === "ADMIN" || role === "CEO";
}

function roleOptionsForActor(role: Role): Role[] {
  if (role === "CEO") {
    return ROLE_OPTIONS.filter((option) => option !== "ADMIN");
  }
  return ROLE_OPTIONS;
}

export default function AdminUsersPage() {
  const { user, token, loading, error } = useAuthUser();
  const [items, setItems] = useState<ManagedUser[]>([]);
  const [filter, setFilter] = useState<ActiveFilter>("active");
  const [page, setPage] = useState(1);
  const [pageSize] = useState(10);
  const [total, setTotal] = useState(0);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [busyUserId, setBusyUserId] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [createSubmitting, setCreateSubmitting] = useState(false);
  const [createdTempPassword, setCreatedTempPassword] = useState<string | null>(null);
  const [createName, setCreateName] = useState("");
  const [createEmail, setCreateEmail] = useState("");
  const [createRole, setCreateRole] = useState<Role>("OPS");
  const [createPassword, setCreatePassword] = useState("");

  const [editOpen, setEditOpen] = useState(false);
  const [editSubmitting, setEditSubmitting] = useState(false);
  const [editTarget, setEditTarget] = useState<ManagedUser | null>(null);
  const [editName, setEditName] = useState("");
  const [editRole, setEditRole] = useState<Role>("OPS");

  const rolesForActor = useMemo(
    () => (user ? roleOptionsForActor(user.role) : ROLE_OPTIONS),
    [user]
  );

  const loadUsers = useCallback(
    async (currentToken: string): Promise<void> => {
      try {
        setRequestError(null);
        const response = await listManagedUsers(currentToken, {
          active: filter,
          page,
          pageSize,
          sortBy: "createdAt",
          sortDir: "desc"
        });
        setItems(response.items);
        setTotal(response.total);
        setForbidden(false);
      } catch (requestFailure) {
        if (requestFailure instanceof ApiError && requestFailure.status === 403) {
          setForbidden(true);
          return;
        }
        setRequestError(
          requestFailure instanceof Error ? requestFailure.message : "Failed to load users"
        );
      }
    },
    [filter, page, pageSize]
  );

  useEffect(() => {
    if (!token || !user || !canManageUsers(user.role)) {
      return;
    }
    void loadUsers(token);
  }, [token, user, loadUsers]);

  useEffect(() => {
    setPage(1);
  }, [filter]);

  function resetCreateForm(): void {
    setCreateName("");
    setCreateEmail("");
    setCreateRole(rolesForActor[0] ?? "OPS");
    setCreatePassword("");
  }

  function openEditModal(target: ManagedUser): void {
    setEditTarget(target);
    setEditName(target.name);
    setEditRole(target.role);
    setEditOpen(true);
  }

  async function onCreate(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!token || !user) {
      return;
    }

    try {
      setCreateSubmitting(true);
      const response = await createManagedUser(token, {
        name: createName,
        email: createEmail,
        role: createRole,
        password: createPassword || undefined
      });
      setCreatedTempPassword(response.tempPassword ?? null);
      resetCreateForm();
      await loadUsers(token);
    } catch (requestFailure) {
      setRequestError(
        requestFailure instanceof Error ? requestFailure.message : "Failed to create user"
      );
    } finally {
      setCreateSubmitting(false);
    }
  }

  async function onEdit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!token || !editTarget) {
      return;
    }

    try {
      setEditSubmitting(true);
      await updateManagedUser(token, editTarget.id, {
        name: editName,
        role: editRole
      });
      setEditOpen(false);
      setEditTarget(null);
      await loadUsers(token);
    } catch (requestFailure) {
      setRequestError(
        requestFailure instanceof Error ? requestFailure.message : "Failed to update user"
      );
    } finally {
      setEditSubmitting(false);
    }
  }

  async function onToggleActive(target: ManagedUser): Promise<void> {
    if (!token || !user) {
      return;
    }
    if (target.id === user.id && target.isActive) {
      return;
    }

    const actionLabel = target.isActive ? "deactivate" : "reactivate";
    const confirmed = window.confirm(`Are you sure you want to ${actionLabel} ${target.email}?`);
    if (!confirmed) {
      return;
    }

    try {
      setBusyUserId(target.id);
      if (target.isActive) {
        await deactivateManagedUser(token, target.id);
      } else {
        await reactivateManagedUser(token, target.id);
      }
      await loadUsers(token);
    } catch (requestFailure) {
      setRequestError(
        requestFailure instanceof Error
          ? requestFailure.message
          : `Failed to ${actionLabel} user`
      );
    } finally {
      setBusyUserId(null);
    }
  }

  async function onCopyTempPassword(): Promise<void> {
    if (!createdTempPassword) {
      return;
    }
    await navigator.clipboard.writeText(createdTempPassword);
  }

  if (loading || !user) {
    return <main className="kv-main">Loading...</main>;
  }

  if (error) {
    return <main className="kv-main">401: {error}</main>;
  }

  if (!canManageUsers(user.role)) {
    return (
      <AppShell user={user} title="User Management">
        <div className="kv-state">
          <h2 style={{ marginTop: 0 }}>403: Forbidden</h2>
          <p>You do not have access to user management.</p>
          <Link href="/">Go to dashboard</Link>
        </div>
      </AppShell>
    );
  }

  if (forbidden) {
    return (
      <AppShell user={user} title="User Management">
        <div className="kv-state">
          <h2 style={{ marginTop: 0 }}>403: Forbidden</h2>
          <p>Your role is not permitted to view users.</p>
          <Link href="/">Go to dashboard</Link>
        </div>
      </AppShell>
    );
  }

  const canGoPrev = page > 1;
  const canGoNext = page * pageSize < total;

  return (
    <AppShell user={user} title="User Management">
      <div className="kv-row" style={{ justifyContent: "space-between", marginBottom: "0.75rem" }}>
        <div className="kv-row">
          <label htmlFor="statusFilter">Filter</label>
          <select
            id="statusFilter"
            value={filter}
            onChange={(event) => setFilter(event.target.value as ActiveFilter)}
          >
            <option value="active">Active</option>
            <option value="inactive">Deactivated</option>
            <option value="all">All</option>
          </select>
        </div>
        <button
          type="button"
          className="kv-btn-primary"
          onClick={() => {
            setCreateOpen(true);
            setCreatedTempPassword(null);
            resetCreateForm();
          }}
        >
          Add user
        </button>
      </div>

      {requestError ? <p className="kv-error">{requestError}</p> : null}
      {createdTempPassword ? (
        <div className="kv-card" style={{ marginBottom: "0.75rem" }}>
          <p style={{ margin: "0 0 6px", fontWeight: 600 }}>Temporary password (shown only once)</p>
          <div className="kv-row">
            <input readOnly value={createdTempPassword} />
            <button type="button" onClick={() => void onCopyTempPassword()}>
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
              <th align="left">Email</th>
              <th align="left">Role</th>
              <th align="left">Status</th>
              <th align="left">Created</th>
              <th align="left">Actions</th>
            </tr>
          </thead>
          <tbody>
            {items.map((managedUser) => {
              const isSelf = managedUser.id === user.id;
              return (
                <tr key={managedUser.id}>
                  <td>{managedUser.name}</td>
                  <td>{managedUser.email}</td>
                  <td>{managedUser.role}</td>
                  <td>
                    <span className="kv-pill">
                      {managedUser.isActive ? "Active" : "Deactivated"}
                    </span>
                  </td>
                  <td>{new Date(managedUser.createdAt).toLocaleDateString()}</td>
                  <td style={{ display: "flex", gap: "0.5rem" }}>
                    <button type="button" onClick={() => openEditModal(managedUser)}>
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => void onToggleActive(managedUser)}
                      disabled={busyUserId === managedUser.id || (isSelf && managedUser.isActive)}
                    >
                      {managedUser.isActive ? "Deactivate" : "Reactivate"}
                    </button>
                  </td>
                </tr>
              );
            })}
            {items.length === 0 ? (
              <tr>
                <td colSpan={6}>No users found</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <div className="kv-pagination">
        <button
          type="button"
          onClick={() => setPage((currentPage) => Math.max(1, currentPage - 1))}
          disabled={!canGoPrev}
        >
          Previous
        </button>
        <span>
          Page {page} of {Math.max(1, Math.ceil(total / pageSize))}
        </span>
        <button
          type="button"
          onClick={() => setPage((currentPage) => currentPage + 1)}
          disabled={!canGoNext}
        >
          Next
        </button>
      </div>

      {createOpen ? (
        <div className="kv-modal-backdrop">
          <div className="kv-modal">
            <h2 style={{ marginTop: 0 }}>Add user</h2>
            <form onSubmit={onCreate} className="kv-form">
              <input
                placeholder="Name"
                value={createName}
                onChange={(event) => setCreateName(event.target.value)}
                required
              />
              <input
                placeholder="Email"
                type="email"
                value={createEmail}
                onChange={(event) => setCreateEmail(event.target.value)}
                required
              />
              <select value={createRole} onChange={(event) => setCreateRole(event.target.value as Role)}>
                {rolesForActor.map((roleOption) => (
                  <option key={roleOption} value={roleOption}>
                    {roleOption}
                  </option>
                ))}
              </select>
              <input
                placeholder="Password (optional)"
                type="password"
                value={createPassword}
                onChange={(event) => setCreatePassword(event.target.value)}
              />
              <div className="kv-row" style={{ justifyContent: "flex-end" }}>
                <button type="button" onClick={() => setCreateOpen(false)}>
                  Cancel
                </button>
                <button type="submit" className="kv-btn-primary" disabled={createSubmitting}>
                  {createSubmitting ? "Creating..." : "Create user"}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {editOpen && editTarget ? (
        <div className="kv-modal-backdrop">
          <div className="kv-modal">
            <h2 style={{ marginTop: 0 }}>Edit user</h2>
            <form onSubmit={onEdit} className="kv-form">
              <input
                value={editName}
                onChange={(event) => setEditName(event.target.value)}
                required
              />
              <input value={editTarget.email} disabled />
              <select value={editRole} onChange={(event) => setEditRole(event.target.value as Role)}>
                {rolesForActor.map((roleOption) => (
                  <option key={roleOption} value={roleOption}>
                    {roleOption}
                  </option>
                ))}
              </select>
              <div className="kv-row" style={{ justifyContent: "flex-end" }}>
                <button type="button" onClick={() => setEditOpen(false)}>
                  Cancel
                </button>
                <button type="submit" className="kv-btn-primary" disabled={editSubmitting}>
                  {editSubmitting ? "Saving..." : "Save changes"}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </AppShell>
  );
}

