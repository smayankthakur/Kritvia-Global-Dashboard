"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { FormEvent, useCallback, useEffect, useState } from "react";
import { AppShell } from "../../../components/app-shell";
import {
  ApiError,
  WorkItem,
  WorkItemActivity,
  completeWorkItem,
  getWorkItem,
  listWorkItemActivity,
  updateWorkItem
} from "../../../lib/api";
import { useAuthUser } from "../../../lib/use-auth-user";
import { WorkItemStatus } from "../../../types/auth";

const statuses: WorkItemStatus[] = ["TODO", "IN_PROGRESS", "BLOCKED", "DONE"];

function isOverdue(item: WorkItem): boolean {
  if (!item.dueDate || item.status === "DONE") {
    return false;
  }
  const due = new Date(item.dueDate);
  const today = new Date();
  due.setHours(0, 0, 0, 0);
  today.setHours(0, 0, 0, 0);
  return due < today;
}

export default function WorkItemDetailPage() {
  const params = useParams<{ id: string }>();
  const { user, token, loading, error } = useAuthUser();
  const [item, setItem] = useState<WorkItem | null>(null);
  const [activity, setActivity] = useState<WorkItemActivity[]>([]);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [forbidden, setForbidden] = useState(false);
  const [saving, setSaving] = useState(false);

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState("2");
  const [dueDate, setDueDate] = useState("");
  const [assignedToUserId, setAssignedToUserId] = useState("");
  const [status, setStatus] = useState<WorkItemStatus>("TODO");

  const canWrite = user?.role === "OPS" || user?.role === "ADMIN";

  const reload = useCallback(async (): Promise<void> => {
    if (!token || !params.id) {
      return;
    }
    try {
      setRequestError(null);
      const [workItem, timeline] = await Promise.all([
        getWorkItem(token, params.id),
        listWorkItemActivity(token, params.id)
      ]);
      setItem(workItem);
      setActivity(timeline.items);
      setTitle(workItem.title);
      setDescription(workItem.description ?? "");
      setPriority(String(workItem.priority));
      setDueDate(workItem.dueDate ? new Date(workItem.dueDate).toISOString().slice(0, 10) : "");
      setAssignedToUserId(workItem.assignedToUserId ?? "");
      setStatus(workItem.status);
      setNotFound(false);
      setForbidden(false);
    } catch (requestFailure) {
      if (requestFailure instanceof ApiError && requestFailure.status === 404) {
        setNotFound(true);
        return;
      }
      if (requestFailure instanceof ApiError && requestFailure.status === 403) {
        setForbidden(true);
        return;
      }
      setRequestError(
        requestFailure instanceof Error ? requestFailure.message : "Failed to load work item"
      );
    }
  }, [token, params.id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function onSave(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!token || !params.id || !canWrite) {
      return;
    }
    try {
      setSaving(true);
      await updateWorkItem(token, params.id, {
        title,
        description: description || null,
        priority: Number(priority),
        dueDate: dueDate || null,
        assignedToUserId: assignedToUserId || null,
        status
      });
      await reload();
    } catch (requestFailure) {
      setRequestError(requestFailure instanceof Error ? requestFailure.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  async function onComplete(): Promise<void> {
    if (!token || !params.id || !canWrite) {
      return;
    }
    try {
      await completeWorkItem(token, params.id);
      await reload();
    } catch (requestFailure) {
      setRequestError(
        requestFailure instanceof Error ? requestFailure.message : "Failed to complete"
      );
    }
  }

  if (loading || !user) {
    return <main className="kv-main">Loading...</main>;
  }
  if (error) {
    return <main className="kv-main">401: {error}</main>;
  }
  if (forbidden) {
    return (
      <AppShell user={user} title="Work Item">
        <p>403: Forbidden</p>
      </AppShell>
    );
  }
  if (notFound) {
    return (
      <AppShell user={user} title="Work Item">
        <p>404: Work item not found</p>
      </AppShell>
    );
  }
  if (!item) {
    return (
      <AppShell user={user} title="Work Item">
        <p>Loading...</p>
      </AppShell>
    );
  }

  return (
    <AppShell user={user} title="Work Item Detail">
      {requestError ? <p className="kv-error">{requestError}</p> : null}
      <div className="kv-grid-2">
        <section className="kv-card">
          <p style={{ margin: "0 0 0.5rem" }}>
            Status: <strong>{item.status}</strong>{" "}
            {isOverdue(item) ? <span className="kv-pill" style={{ color: "var(--danger-color)" }}>(Overdue)</span> : null}
          </p>
          <form onSubmit={onSave} className="kv-form-compact" style={{ maxWidth: "720px" }}>
            <input value={title} onChange={(event) => setTitle(event.target.value)} disabled={!canWrite} />
            <textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={4}
              placeholder="Description"
              disabled={!canWrite}
            />
            <select
              value={status}
              onChange={(event) => setStatus(event.target.value as WorkItemStatus)}
              disabled={!canWrite}
            >
              {statuses.map((next) => (
                <option key={next} value={next}>
                  {next}
                </option>
              ))}
            </select>
            <input
              type="number"
              min={1}
              max={3}
              value={priority}
              onChange={(event) => setPriority(event.target.value)}
              disabled={!canWrite}
            />
            <input
              type="date"
              value={dueDate}
              onChange={(event) => setDueDate(event.target.value)}
              disabled={!canWrite}
            />
            <input
              value={assignedToUserId}
              placeholder="Assignee User UUID"
              onChange={(event) => setAssignedToUserId(event.target.value)}
              disabled={!canWrite}
            />
            <div className="kv-row">
              <button type="submit" className="kv-btn-primary" disabled={!canWrite || saving}>
                {saving ? "Saving..." : "Save"}
              </button>
              <button type="button" onClick={() => void onComplete()} disabled={!canWrite}>
                Complete
              </button>
            </div>
          </form>
          <p style={{ marginTop: "0.75rem", fontSize: "0.9rem" }}>
            Company:{" "}
            {item.company ? <Link href={`/sales/companies/${item.company.id}`}>{item.company.name}</Link> : "-"}
          </p>
          <p style={{ marginTop: "0.25rem", fontSize: "0.9rem" }}>
            Deal: {item.deal ? <Link href="/sales/deals">{item.deal.title}</Link> : "-"}
          </p>
        </section>
        <aside className="kv-card">
          <h3 style={{ marginTop: 0 }}>Activity Timeline</h3>
          <ul style={{ paddingLeft: "1rem", margin: 0 }}>
            {activity.map((entry) => (
              <li key={entry.id} style={{ marginBottom: "0.5rem" }}>
                <strong>{entry.action}</strong>{" "}
                <span style={{ color: "var(--text-secondary)" }}>
                  by {entry.actorUser?.name ?? "System"} on{" "}
                  {new Date(entry.createdAt).toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        </aside>
      </div>
    </AppShell>
  );
}
