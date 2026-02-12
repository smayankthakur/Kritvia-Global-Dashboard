"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useState } from "react";
import { AppShell } from "../../../components/app-shell";
import { ApiError, Company, createCompany, listCompanies } from "../../../lib/api";
import { useAuthUser } from "../../../lib/use-auth-user";

export default function SalesCompaniesPage() {
  const { user, token, loading, error } = useAuthUser();
  const [companies, setCompanies] = useState<Company[]>([]);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(20);
  const [total, setTotal] = useState(0);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const [name, setName] = useState("");
  const [industry, setIndustry] = useState("");
  const [website, setWebsite] = useState("");

  const loadCompanies = useCallback(async (currentToken: string): Promise<void> => {
    try {
      setRequestError(null);
      const result = await listCompanies(currentToken, { page, pageSize, sortBy: "createdAt", sortDir: "desc" });
      setCompanies(result.items);
      setTotal(result.total);
      setForbidden(false);
    } catch (requestFailure) {
      if (requestFailure instanceof ApiError && requestFailure.status === 403) {
        setForbidden(true);
        return;
      }
      setRequestError(
        requestFailure instanceof Error ? requestFailure.message : "Failed to load companies"
      );
    }
  }, [page, pageSize]);

  useEffect(() => {
    if (!token) {
      return;
    }

    void loadCompanies(token);
  }, [token, loadCompanies]);

  const canGoPrev = page > 1;
  const canGoNext = page * pageSize < total;

  async function onCreate(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!token) {
      return;
    }

    try {
      setSubmitting(true);
      await createCompany(token, {
        name,
        industry: industry || undefined,
        website: website || undefined
      });
      setName("");
      setIndustry("");
      setWebsite("");
      await loadCompanies(token);
    } catch (requestFailure) {
      setRequestError(
        requestFailure instanceof Error ? requestFailure.message : "Failed to create company"
      );
    } finally {
      setSubmitting(false);
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
      <AppShell user={user} title="Sales Companies">
        <p>Forbidden</p>
      </AppShell>
    );
  }

  return (
    <AppShell user={user} title="Sales Companies">
      {requestError ? <p className="kv-error">{requestError}</p> : null}

      <form onSubmit={onCreate} className="kv-form kv-card" style={{ maxWidth: "520px" }}>
        <h3 style={{ marginBottom: "0.5rem" }}>Create Company</h3>
        <input
          placeholder="Name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          required
          disabled={user.role === "CEO"}
        />
        <input
          placeholder="Industry"
          value={industry}
          onChange={(event) => setIndustry(event.target.value)}
          disabled={user.role === "CEO"}
        />
        <input
          placeholder="Website"
          value={website}
          onChange={(event) => setWebsite(event.target.value)}
          disabled={user.role === "CEO"}
        />
        <button type="submit" disabled={submitting || user.role === "CEO"} className="kv-btn-primary">
          {submitting ? "Creating..." : "Create Company"}
        </button>
      </form>

      <div className="kv-table-wrap" style={{ marginTop: "1rem" }}>
      <table>
        <thead>
          <tr>
            <th align="left">Name</th>
            <th align="left">Industry</th>
            <th align="left">Owner</th>
            <th align="left">Created</th>
          </tr>
        </thead>
        <tbody>
          {companies.map((company) => (
            <tr key={company.id}>
              <td>
                <Link href={`/sales/companies/${company.id}`}>{company.name}</Link>
              </td>
              <td>{company.industry ?? "-"}</td>
              <td>{company.owner?.name ?? "-"}</td>
              <td>{new Date(company.createdAt).toLocaleDateString()}</td>
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
