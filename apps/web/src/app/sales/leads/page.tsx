"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { AppShell } from "../../../components/app-shell";
import {
  ApiError,
  Company,
  Lead,
  convertLeadToDeal,
  createLead,
  listCompanies,
  listLeads
} from "../../../lib/api";
import { useAuthUser } from "../../../lib/use-auth-user";
import { LeadStage } from "../../../types/auth";

const leadStages: LeadStage[] = ["NEW", "QUALIFIED", "DISQUALIFIED"];

export default function SalesLeadsPage() {
  const { user, token, loading, error } = useAuthUser();
  const [companies, setCompanies] = useState<Company[]>([]);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [selectedStage, setSelectedStage] = useState<LeadStage | "">("");
  const [page, setPage] = useState(1);
  const [pageSize] = useState(20);
  const [total, setTotal] = useState(0);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const [title, setTitle] = useState("");
  const [companyId, setCompanyId] = useState("");
  const [source, setSource] = useState("");

  const loadData = useCallback(async (currentToken: string): Promise<void> => {
    try {
      setRequestError(null);
      const [leadRows, companyRows] = await Promise.all([
        listLeads(currentToken, {
          stage: selectedStage || undefined,
          page,
          pageSize,
          sortBy: "createdAt",
          sortDir: "desc"
        }),
        listCompanies(currentToken, { page: 1, pageSize: 100, sortBy: "name", sortDir: "asc" })
      ]);
      setLeads(leadRows.items);
      setTotal(leadRows.total);
      setCompanies(companyRows.items);
      setForbidden(false);
    } catch (requestFailure) {
      if (requestFailure instanceof ApiError && requestFailure.status === 403) {
        setForbidden(true);
        return;
      }
      setRequestError(
        requestFailure instanceof Error ? requestFailure.message : "Failed to load leads"
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
      await createLead(token, {
        title,
        source: source || undefined,
        companyId: companyId || undefined
      });
      setTitle("");
      setSource("");
      setCompanyId("");
      await loadData(token);
    } catch (requestFailure) {
      setRequestError(
        requestFailure instanceof Error ? requestFailure.message : "Failed to create lead"
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function onConvert(lead: Lead): Promise<void> {
    if (!token) {
      return;
    }

    try {
      await convertLeadToDeal(token, lead.id, lead.companyId ? undefined : { companyId });
      await loadData(token);
    } catch (requestFailure) {
      setRequestError(
        requestFailure instanceof Error ? requestFailure.message : "Failed to convert lead"
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
      <AppShell user={user} title="Sales Leads">
        <p>Forbidden</p>
      </AppShell>
    );
  }

  return (
    <AppShell user={user} title="Sales Leads">
      {requestError ? <p className="kv-error">{requestError}</p> : null}

      <div className="kv-row" style={{ marginBottom: "0.75rem" }}>
        <label htmlFor="lead-stage-filter">Stage Filter: </label>
        <select
          id="lead-stage-filter"
          value={selectedStage}
          onChange={(event) => setSelectedStage(event.target.value as LeadStage | "")}
        >
          <option value="">All</option>
          {leadStages.map((stage) => (
            <option key={stage} value={stage}>
              {stage}
            </option>
          ))}
        </select>
      </div>

      <form onSubmit={onCreate} className="kv-form kv-card" style={{ maxWidth: "520px" }}>
        <h3 style={{ marginBottom: "0.25rem" }}>Create Lead</h3>
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
          disabled={user.role === "CEO"}
        >
          <option value="">No company</option>
          {companies.map((company) => (
            <option key={company.id} value={company.id}>
              {company.name}
            </option>
          ))}
        </select>
        <input
          placeholder="Source"
          value={source}
          onChange={(event) => setSource(event.target.value)}
          disabled={user.role === "CEO"}
        />
        <button type="submit" disabled={submitting || user.role === "CEO"} className="kv-btn-primary">
          {submitting ? "Creating..." : "Create Lead"}
        </button>
      </form>

      <div className="kv-table-wrap" style={{ marginTop: "1rem" }}>
      <table>
        <thead>
          <tr>
            <th align="left">Title</th>
            <th align="left">Company</th>
            <th align="left">Stage</th>
            <th align="left">Owner</th>
            <th align="left">Created</th>
            <th align="left">Actions</th>
          </tr>
        </thead>
        <tbody>
          {leads.map((lead) => (
            <tr key={lead.id}>
              <td>{lead.title}</td>
              <td>{lead.company?.name ?? "-"}</td>
              <td>{lead.stage}</td>
              <td>{lead.owner?.name ?? "-"}</td>
              <td>{new Date(lead.createdAt).toLocaleDateString()}</td>
              <td>
                <button
                  type="button"
                  onClick={() => void onConvert(lead)}
                  disabled={user.role === "CEO" || (lead.companyId === null && !companyId)}
                >
                  Convert
                </button>
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
