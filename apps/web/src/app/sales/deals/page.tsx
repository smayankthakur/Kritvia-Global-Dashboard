"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { AppShell } from "../../../components/app-shell";
import {
  ApiError,
  Company,
  Deal,
  createDeal,
  listCompanies,
  listDeals,
  markDealLost,
  markDealWon
} from "../../../lib/api";
import { useAuthUser } from "../../../lib/use-auth-user";
import { DealStage } from "../../../types/auth";

const dealStages: DealStage[] = ["OPEN", "WON", "LOST"];

export default function SalesDealsPage() {
  const { user, token, loading, error } = useAuthUser();
  const [deals, setDeals] = useState<Deal[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [selectedStage, setSelectedStage] = useState<DealStage | "">("");
  const [page, setPage] = useState(1);
  const [pageSize] = useState(20);
  const [total, setTotal] = useState(0);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const [title, setTitle] = useState("");
  const [companyId, setCompanyId] = useState("");
  const [valueAmount, setValueAmount] = useState("0");

  const loadData = useCallback(async (currentToken: string): Promise<void> => {
    try {
      setRequestError(null);
      const [dealRows, companyRows] = await Promise.all([
        listDeals(currentToken, {
          stage: selectedStage || undefined,
          page,
          pageSize,
          sortBy: "createdAt",
          sortDir: "desc"
        }),
        listCompanies(currentToken, { page: 1, pageSize: 100, sortBy: "name", sortDir: "asc" })
      ]);
      setDeals(dealRows.items);
      setTotal(dealRows.total);
      setCompanies(companyRows.items);
      setForbidden(false);
    } catch (requestFailure) {
      if (requestFailure instanceof ApiError && requestFailure.status === 403) {
        setForbidden(true);
        return;
      }
      setRequestError(
        requestFailure instanceof Error ? requestFailure.message : "Failed to load deals"
      );
    }
  }, [selectedStage, page, pageSize]);

  useEffect(() => {
    if (!token) {
      return;
    }

    void loadData(token);
  }, [token, loadData]);

  useEffect(() => {
    setPage(1);
  }, [selectedStage]);

  const canGoPrev = page > 1;
  const canGoNext = page * pageSize < total;

  async function onCreate(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!token) {
      return;
    }

    try {
      setSubmitting(true);
      await createDeal(token, {
        title,
        companyId,
        valueAmount: Number(valueAmount) || 0
      });
      setTitle("");
      setCompanyId("");
      setValueAmount("0");
      await loadData(token);
    } catch (requestFailure) {
      setRequestError(
        requestFailure instanceof Error ? requestFailure.message : "Failed to create deal"
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function onMarkWon(id: string): Promise<void> {
    if (!token) {
      return;
    }
    try {
      await markDealWon(token, id);
      await loadData(token);
    } catch (requestFailure) {
      setRequestError(
        requestFailure instanceof Error ? requestFailure.message : "Failed to mark won"
      );
    }
  }

  async function onMarkLost(id: string): Promise<void> {
    if (!token) {
      return;
    }
    try {
      await markDealLost(token, id);
      await loadData(token);
    } catch (requestFailure) {
      setRequestError(
        requestFailure instanceof Error ? requestFailure.message : "Failed to mark lost"
      );
    }
  }

  if (loading || !user) {
    return <main className="kv-main">Loading...</main>;
  }

  if (error) {
    return <main className="kv-main">{error}</main>;
  }

  if (forbidden) {
    return (
      <AppShell user={user} title="Sales Deals">
        <p>Forbidden</p>
      </AppShell>
    );
  }

  return (
    <AppShell user={user} title="Sales Deals">
      {requestError ? <p className="kv-error">{requestError}</p> : null}

      <div className="kv-row" style={{ marginBottom: "0.75rem" }}>
        <label htmlFor="deal-stage-filter">Stage Filter: </label>
        <select
          id="deal-stage-filter"
          value={selectedStage}
          onChange={(event) => setSelectedStage(event.target.value as DealStage | "")}
        >
          <option value="">All</option>
          {dealStages.map((stage) => (
            <option key={stage} value={stage}>
              {stage}
            </option>
          ))}
        </select>
      </div>

      <form onSubmit={onCreate} className="kv-form kv-card" style={{ maxWidth: "520px" }}>
        <h3 style={{ marginBottom: "0.25rem" }}>Create Deal</h3>
        <input
          placeholder="Title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          required
          disabled={user.role === "CEO"}
        />
        <select
          value={companyId}
          onChange={(event) => setCompanyId(event.target.value)}
          required
          disabled={user.role === "CEO"}
        >
          <option value="">Select company</option>
          {companies.map((company) => (
            <option key={company.id} value={company.id}>
              {company.name}
            </option>
          ))}
        </select>
        <input
          type="number"
          min={0}
          value={valueAmount}
          onChange={(event) => setValueAmount(event.target.value)}
          disabled={user.role === "CEO"}
        />
        <button type="submit" disabled={submitting || user.role === "CEO"} className="kv-btn-primary">
          {submitting ? "Creating..." : "Create Deal"}
        </button>
      </form>

      <div className="kv-table-wrap" style={{ marginTop: "1rem" }}>
      <table>
        <thead>
          <tr>
            <th align="left">Title</th>
            <th align="left">Company</th>
            <th align="left">Value</th>
            <th align="left">Stage</th>
            <th align="left">Owner</th>
            <th align="left">Created</th>
            <th align="left">Actions</th>
          </tr>
        </thead>
        <tbody>
          {deals.map((deal) => (
            <tr key={deal.id}>
              <td>
                <Link href={`/deals/${deal.id}`}>{deal.title}</Link>
              </td>
              <td>{deal.company?.name ?? "-"}</td>
              <td>
                {deal.currency} {deal.valueAmount}
              </td>
              <td>{deal.stage}</td>
              <td>{deal.owner?.name ?? "-"}</td>
              <td>{new Date(deal.createdAt).toLocaleDateString()}</td>
              <td>
                {deal.stage === "OPEN" ? (
                  <>
                    <button
                      type="button"
                      onClick={() => void onMarkWon(deal.id)}
                      disabled={user.role === "CEO"}
                    >
                      Mark Won
                    </button>
                    <button
                      type="button"
                      onClick={() => void onMarkLost(deal.id)}
                      disabled={user.role === "CEO"}
                    >
                      Mark Lost
                    </button>
                  </>
                ) : (
                  "-"
                )}
              </td>
            </tr>
          ))}
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
