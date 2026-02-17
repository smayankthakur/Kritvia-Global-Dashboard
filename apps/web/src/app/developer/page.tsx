"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import { AppShell } from "../../components/app-shell";
import { ApiError, getBillingPlan } from "../../lib/api";
import { useAuthUser } from "../../lib/use-auth-user";
import { AppsTab } from "./tabs/apps";
import { ApiTokensTab } from "./tabs/api-tokens";
import { DocsTab } from "./tabs/docs";
import { LogsTab } from "./tabs/logs";
import { IncidentsTab } from "./tabs/incidents";
import { OnCallTab } from "./tabs/oncall";
import { WebhooksTab } from "./tabs/webhooks";

type DeveloperTab = "tokens" | "webhooks" | "logs" | "incidents" | "docs" | "apps" | "oncall";

const TABS: Array<{ key: DeveloperTab; label: string }> = [
  { key: "tokens", label: "Tokens" },
  { key: "webhooks", label: "Webhooks" },
  { key: "logs", label: "Logs" },
  { key: "incidents", label: "Incidents" },
  { key: "oncall", label: "On-call" },
  { key: "docs", label: "Docs" },
  { key: "apps", label: "Apps" }
];

function canAccess(role: string): boolean {
  return role === "CEO" || role === "ADMIN";
}

function parseTab(value: string | null): DeveloperTab {
  if (
    value === "tokens" ||
    value === "webhooks" ||
    value === "logs" ||
    value === "incidents" ||
    value === "oncall" ||
    value === "docs" ||
    value === "apps"
  ) {
    return value;
  }
  return "tokens";
}

function tabContent(tab: DeveloperTab): { title: string; description: string } {
  if (tab === "tokens") {
    return {
      title: "Manage API tokens",
      description: "Create and rotate service-account tokens for secure machine access."
    };
  }
  if (tab === "webhooks") {
    return {
      title: "Configure webhook endpoints",
      description: "Register endpoints and subscribe to Kritviya events for real-time sync."
    };
  }
  if (tab === "logs") {
    return {
      title: "Review deliveries and usage",
      description: "Inspect token usage and webhook delivery outcomes with request traces."
    };
  }
  if (tab === "apps") {
    return {
      title: "Test installed apps",
      description: "Run test triggers and review app-specific delivery and command activity."
    };
  }
  if (tab === "incidents") {
    return {
      title: "Incident timelines and postmortems",
      description: "Track acknowledge/resolve SLAs, mitigation history, and incident notes."
    };
  }
  if (tab === "oncall") {
    return {
      title: "Manage on-call rotations",
      description: "Configure escalation targets for primary and secondary incident responders."
    };
  }
  return {
    title: "API reference and examples",
    description: "Explore versioned endpoints, auth headers, and request/response samples."
  };
}

function DeveloperPortalPageInner() {
  const searchParams = useSearchParams();
  const { user, token, loading, error } = useAuthUser();
  const [gatingLoading, setGatingLoading] = useState(false);
  const [upgradeRequired, setUpgradeRequired] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);

  const activeTab = useMemo(() => parseTab(searchParams.get("tab")), [searchParams]);

  useEffect(() => {
    async function loadGate(): Promise<void> {
      if (!token || !user || !canAccess(user.role)) {
        return;
      }
      try {
        setGatingLoading(true);
        setRequestError(null);
        const billing = await getBillingPlan(token);
        const allowed =
          billing.plan.enterpriseControlsEnabled || billing.plan.developerPlatformEnabled === true;
        setUpgradeRequired(!allowed);
      } catch (requestFailure) {
        if (requestFailure instanceof ApiError && requestFailure.code === "UPGRADE_REQUIRED") {
          setUpgradeRequired(true);
          return;
        }
        setRequestError(
          requestFailure instanceof Error
            ? requestFailure.message
            : "Failed to load developer portal access"
        );
      } finally {
        setGatingLoading(false);
      }
    }

    void loadGate();
  }, [token, user]);

  if (loading || !user) {
    return <main className="kv-main">Loading...</main>;
  }

  if (error) {
    return <main className="kv-main">401: {error}</main>;
  }

  if (!token) {
    return <main className="kv-main">401: Unauthorized</main>;
  }

  if (!canAccess(user.role)) {
    return (
      <AppShell user={user} title="Developer Portal">
        <div className="kv-state">
          <h2 style={{ marginTop: 0 }}>403: Forbidden</h2>
          <p>Developer Portal is available only to CEO and ADMIN.</p>
          <Link href="/">Go to dashboard</Link>
        </div>
      </AppShell>
    );
  }

  if (gatingLoading) {
    return (
      <AppShell user={user} title="Developer Portal">
        <div className="kv-stack">
          <div className="kv-revenue-skeleton" />
          <div className="kv-revenue-skeleton" />
        </div>
      </AppShell>
    );
  }

  if (upgradeRequired) {
    return (
      <AppShell user={user} title="Developer Portal">
        <div className="kv-state">
          <h2 style={{ marginTop: 0 }}>Upgrade Required</h2>
          <p>Developer Portal is available on enterprise-enabled plans.</p>
          <Link href="/billing">Open Billing</Link>
        </div>
      </AppShell>
    );
  }

  const content = tabContent(activeTab);

  return (
    <AppShell user={user} title="Developer Portal">
      <p className="kv-subtitle" style={{ marginBottom: "12px" }}>
        API access, webhooks and integration tools
      </p>

      {requestError ? <p className="kv-error">{requestError}</p> : null}

      <div className="kv-dev-tabs" role="tablist" aria-label="Developer portal tabs">
        {TABS.map((tab) => {
          const active = tab.key === activeTab;
          return (
            <Link
              key={tab.key}
              href={`/developer?tab=${tab.key}`}
              className={`kv-dev-tab${active ? " is-active" : ""}`}
              role="tab"
              aria-selected={active}
              aria-current={active ? "page" : undefined}
            >
              {tab.label}
            </Link>
          );
        })}
      </div>

      {activeTab === "tokens" ? <ApiTokensTab token={token} /> : null}
      {activeTab === "webhooks" ? <WebhooksTab token={token} /> : null}
      {activeTab === "logs" ? <LogsTab token={token} /> : null}
      {activeTab === "incidents" ? <IncidentsTab token={token} /> : null}
      {activeTab === "oncall" ? <OnCallTab token={token} /> : null}
      {activeTab === "docs" ? <DocsTab token={token} /> : null}
      {activeTab === "apps" ? <AppsTab token={token} /> : null}
      {activeTab !== "tokens" &&
      activeTab !== "webhooks" &&
      activeTab !== "logs" &&
      activeTab !== "incidents" &&
      activeTab !== "oncall" &&
      activeTab !== "docs" &&
      activeTab !== "apps" ? (
        <section className="kv-card kv-dev-card" aria-live="polite">
          <h2 className="kv-section-title" style={{ marginTop: 0 }}>{content.title}</h2>
          <p className="kv-subtitle" style={{ marginBottom: 0 }}>{content.description}</p>
        </section>
      ) : null}
    </AppShell>
  );
}

export default function DeveloperPortalPage() {
  return (
    <Suspense fallback={<main className="kv-main">Loading...</main>}>
      <DeveloperPortalPageInner />
    </Suspense>
  );
}
