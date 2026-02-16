"use client";

import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";
import { AppShell } from "../../components/app-shell";
import { ApiError, PortfolioGroup, createPortfolio, listPortfolioGroups } from "../../lib/api";
import { useAuthUser } from "../../lib/use-auth-user";

export default function PortfolioIndexPage() {
  const { user, token, loading, error } = useAuthUser();
  const [groups, setGroups] = useState<PortfolioGroup[]>([]);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [loadingData, setLoadingData] = useState(false);
  const [saving, setSaving] = useState(false);

  async function loadGroups(currentToken: string): Promise<void> {
    try {
      setLoadingData(true);
      setRequestError(null);
      const response = await listPortfolioGroups(currentToken, {
        page: 1,
        pageSize: 100,
        sortBy: "createdAt",
        sortDir: "desc"
      });
      setGroups(response.items);
    } catch (requestFailure) {
      if (requestFailure instanceof ApiError && requestFailure.status === 403) {
        setRequestError("403: Forbidden");
        return;
      }
      setRequestError(requestFailure instanceof Error ? requestFailure.message : "Failed to load portfolios");
    } finally {
      setLoadingData(false);
    }
  }

  useEffect(() => {
    if (!token) {
      return;
    }
    void loadGroups(token);
  }, [token]);

  async function onCreate(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!token || !name.trim()) {
      return;
    }
    try {
      setSaving(true);
      setRequestError(null);
      await createPortfolio(token, { name: name.trim() });
      setName("");
      setCreateOpen(false);
      await loadGroups(token);
    } catch (requestFailure) {
      setRequestError(requestFailure instanceof Error ? requestFailure.message : "Failed to create portfolio");
    } finally {
      setSaving(false);
    }
  }

  if (loading || !user) {
    return <main className="kv-main">Loading...</main>;
  }

  if (error) {
    return <main className="kv-main">401: {error}</main>;
  }

  return (
    <AppShell user={user} title="Portfolio">
      <div className="kv-row" style={{ justifyContent: "space-between", marginBottom: "12px" }}>
        <p className="kv-subtitle" style={{ margin: 0 }}>
          Agency and holding-company view across multiple organizations.
        </p>
        <button type="button" className="kv-btn-primary" onClick={() => setCreateOpen(true)}>
          Create Portfolio
        </button>
      </div>

      {requestError ? <p className="kv-error">{requestError}</p> : null}

      {loadingData ? (
        <div className="kv-stack">
          <div className="kv-revenue-skeleton" />
          <div className="kv-revenue-skeleton" />
        </div>
      ) : groups.length === 0 ? (
        <div className="kv-state">
          <p style={{ margin: 0 }}>No portfolios yet. Create one to aggregate org execution KPIs.</p>
        </div>
      ) : (
        <div className="kv-stack">
          {groups.map((group) => (
            <article key={group.id} className="kv-card kv-portfolio-card">
              <div className="kv-row" style={{ justifyContent: "space-between" }}>
                <div>
                  <h2 className="kv-section-title kv-revenue-title" style={{ marginBottom: "4px" }}>
                    {group.name}
                  </h2>
                  <p className="kv-note" style={{ margin: 0 }}>
                    Org count: {group.orgCount}
                  </p>
                </div>
                <div className="kv-row">
                  <span className="kv-pill">{group.role}</span>
                  <Link href={`/portfolio/${group.id}`} className="kv-btn-primary kv-link-btn">
                    Open
                  </Link>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}

      {createOpen ? (
        <div className="kv-modal-backdrop">
          <div className="kv-modal">
            <h3 style={{ marginTop: 0 }}>Create Portfolio</h3>
            <form onSubmit={(event) => void onCreate(event)} className="kv-form">
              <label htmlFor="portfolioName">Portfolio name</label>
              <input
                id="portfolioName"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Agency Portfolio"
                required
              />
              <div className="kv-row">
                <button type="submit" className="kv-btn-primary" disabled={saving}>
                  {saving ? "Creating..." : "Create"}
                </button>
                <button type="button" onClick={() => setCreateOpen(false)} disabled={saving}>
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </AppShell>
  );
}
