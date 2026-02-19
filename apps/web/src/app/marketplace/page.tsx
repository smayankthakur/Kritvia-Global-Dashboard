"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { AppShell } from "../../components/app-shell";
import { ApiError, MarketplaceAppRecord, listMarketplaceApps } from "../../lib/api";
import { useAuthUser } from "../../lib/use-auth-user";

export default function MarketplacePage() {
  const { user, token, loading, error } = useAuthUser();
  const [apps, setApps] = useState<MarketplaceAppRecord[]>([]);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [requestError, setRequestError] = useState<string | null>(null);
  const [loadingData, setLoadingData] = useState(false);

  const categories = useMemo(() => {
    const unique = new Set<string>();
    for (const app of apps) {
      if (app.category) {
        unique.add(app.category);
      }
    }
    return ["all", ...Array.from(unique).sort()];
  }, [apps]);

  async function loadApps(currentToken: string, q?: string, selectedCategory?: string): Promise<void> {
    try {
      setLoadingData(true);
      setRequestError(null);
      const items = await listMarketplaceApps(currentToken, {
        q,
        category: selectedCategory && selectedCategory !== "all" ? selectedCategory : undefined
      });
      setApps(items);
    } catch (requestFailure) {
      if (requestFailure instanceof ApiError && requestFailure.status === 403) {
        setRequestError("403: Forbidden");
        return;
      }
      setRequestError(
        requestFailure instanceof Error ? requestFailure.message : "Failed to load marketplace apps"
      );
    } finally {
      setLoadingData(false);
    }
  }

  useEffect(() => {
    if (!token) {
      return;
    }
    void loadApps(token);
  }, [token]);

  useEffect(() => {
    if (!token) {
      return;
    }
    const timer = window.setTimeout(() => {
      void loadApps(token, query, category);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [token, query, category]);

  if (loading || !user) {
    return <main className="kv-main">Loading...</main>;
  }

  if (error) {
    return <main className="kv-main">401: {error}</main>;
  }

  return (
    <AppShell user={user} title="Marketplace">
      <div className="kv-row kv-marketplace-head">
        <p className="kv-subtitle kv-marketplace-subtitle">
          Install and manage integrations for your organization.
        </p>
      </div>

      <div className="kv-row kv-marketplace-filters">
        <input
          className="kv-marketplace-search"
          placeholder="Search apps"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <select
          className="kv-marketplace-category"
          value={category}
          onChange={(event) => setCategory(event.target.value)}
        >
          {categories.map((categoryOption) => (
            <option key={categoryOption} value={categoryOption}>
              {categoryOption === "all" ? "All categories" : categoryOption}
            </option>
          ))}
        </select>
      </div>

      {requestError ? <p className="kv-error">{requestError}</p> : null}

      {loadingData ? (
        <div className="kv-stack">
          <div className="kv-revenue-skeleton" />
          <div className="kv-revenue-skeleton" />
        </div>
      ) : apps.length === 0 ? (
        <div className="kv-state">
          <p className="kv-marketplace-empty">No marketplace apps found.</p>
        </div>
      ) : (
        <div className="kv-grid-2">
          {apps.map((app) => (
            <article key={app.id} className="kv-card kv-portfolio-card kv-portfolio-glow">
              <h2 className="kv-section-title kv-revenue-title kv-marketplace-card-title">
                {app.name}
              </h2>
              <p className="kv-subtitle kv-marketplace-card-subtitle">
                {app.description}
              </p>
              <div className="kv-row kv-marketplace-card-meta">
                {app.category ? <span className="kv-pill">{app.category}</span> : null}
                <span className="kv-pill">{app.key}</span>
              </div>
              <Link href={`/marketplace/${app.key}`} className="kv-btn-primary kv-link-btn">
                View details
              </Link>
            </article>
          ))}
        </div>
      )}
    </AppShell>
  );
}
