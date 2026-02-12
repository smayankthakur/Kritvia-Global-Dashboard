"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AppShell } from "../../components/app-shell";
import { ApiError, Nudge, listNudges, resolveNudge } from "../../lib/api";
import { useAuthUser } from "../../lib/use-auth-user";

type NudgeFilter = "OPEN" | "RESOLVED";
type TabKey = "assigned" | "created";

export default function NudgesPage() {
  const { user, token, loading, error } = useAuthUser();
  const [tab, setTab] = useState<TabKey>("assigned");
  const [status, setStatus] = useState<NudgeFilter>("OPEN");
  const [nudges, setNudges] = useState<Nudge[]>([]);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(20);
  const [total, setTotal] = useState(0);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  const reload = useCallback(async (): Promise<void> => {
    if (!token) {
      return;
    }

    try {
      setRequestError(null);
      const rows = await listNudges(token, {
        mine: true,
        status,
        page,
        pageSize,
        sortBy: "createdAt",
        sortDir: "desc"
      });
      setNudges(rows.items);
      setTotal(rows.total);
      setForbidden(false);
    } catch (requestFailure) {
      if (requestFailure instanceof ApiError && requestFailure.status === 403) {
        setForbidden(true);
        return;
      }
      setRequestError(requestFailure instanceof Error ? requestFailure.message : "Failed to load nudges");
    }
  }, [token, status, page, pageSize]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    setPage(1);
  }, [status, tab]);

  const assignedToMe = useMemo(() => {
    if (!user) {
      return [];
    }
    return nudges.filter((nudge) => nudge.targetUserId === user.id);
  }, [nudges, user]);

  const createdByMe = useMemo(() => {
    if (!user) {
      return [];
    }
    return nudges.filter((nudge) => nudge.createdByUserId === user.id);
  }, [nudges, user]);

  const visibleRows = tab === "assigned" ? assignedToMe : createdByMe;
  const canGoPrev = page > 1;
  const canGoNext = page * pageSize < total;

  async function onResolve(id: string): Promise<void> {
    if (!token) {
      return;
    }
    try {
      await resolveNudge(token, id);
      await reload();
    } catch (requestFailure) {
      setRequestError(requestFailure instanceof Error ? requestFailure.message : "Failed to resolve nudge");
    }
  }

  function entityHref(nudge: Nudge): string {
    if (nudge.entityType === "WORK_ITEM") {
      return `/work/${nudge.entityId}`;
    }
    if (nudge.entityType === "INVOICE") {
      return `/finance/invoices/${nudge.entityId}`;
    }
    if (nudge.entityType === "COMPANY") {
      return `/sales/companies/${nudge.entityId}`;
    }
    if (nudge.entityType === "DEAL") {
      return "/sales/deals";
    }
    if (nudge.entityType === "LEAD") {
      return "/sales/leads";
    }
    return "/";
  }

  if (loading || !user) {
    return <main className="kv-main">Loading...</main>;
  }

  if (error) {
    return <main className="kv-main">401: {error}</main>;
  }

  if (forbidden) {
    return (
      <AppShell user={user} title="Nudges">
        <p>403: Forbidden</p>
      </AppShell>
    );
  }

  return (
    <AppShell user={user} title="Nudges">
      {requestError ? <p className="kv-error">{requestError}</p> : null}
      <div className="kv-row" style={{ marginBottom: "0.75rem" }}>
        <button type="button" onClick={() => setTab("assigned")} disabled={tab === "assigned"}>
          Assigned to me
        </button>
        <button type="button" onClick={() => setTab("created")} disabled={tab === "created"}>
          Created by me
        </button>
        <select value={status} onChange={(event) => setStatus(event.target.value as NudgeFilter)}>
          <option value="OPEN">OPEN</option>
          <option value="RESOLVED">RESOLVED</option>
        </select>
      </div>

      <div className="kv-table-wrap">
      <table>
        <thead>
          <tr>
            <th align="left">Message</th>
            <th align="left">Entity</th>
            <th align="left">From</th>
            <th align="left">To</th>
            <th align="left">Status</th>
            <th align="left">Created</th>
            <th align="left">Action</th>
          </tr>
        </thead>
        <tbody>
          {visibleRows.map((nudge) => (
            <tr key={nudge.id}>
              <td>{nudge.message}</td>
              <td>
                <Link href={entityHref(nudge)}>
                  {nudge.entityType} #{nudge.entityId.slice(0, 8)}
                </Link>
              </td>
              <td>{nudge.createdByUser?.name ?? nudge.createdByUserId}</td>
              <td>{nudge.targetUser?.name ?? nudge.targetUserId}</td>
              <td>{nudge.status}</td>
              <td>{new Date(nudge.createdAt).toLocaleString()}</td>
              <td>
                {tab === "assigned" && nudge.status === "OPEN" ? (
                  <button type="button" onClick={() => void onResolve(nudge.id)}>
                    Resolve
                  </button>
                ) : (
                  "-"
                )}
              </td>
            </tr>
          ))}
          {visibleRows.length === 0 ? (
            <tr>
              <td colSpan={7}>No nudges found</td>
            </tr>
          ) : null}
        </tbody>
      </table>
      </div>
      <div className="kv-pagination">
        <button type="button" onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={!canGoPrev}>
          Previous
        </button>
        <span>
          Page {page} of {Math.max(1, Math.ceil(total / pageSize))}
        </span>
        <button type="button" onClick={() => setPage((current) => current + 1)} disabled={!canGoNext}>
          Next
        </button>
      </div>
    </AppShell>
  );
}
