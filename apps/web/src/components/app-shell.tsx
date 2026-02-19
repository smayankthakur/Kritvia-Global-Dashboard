"use client";

import { APP_NAME } from "@kritviya/shared";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ModeSwitcher } from "./mode-switcher";
import { OrgSwitcher } from "./org-switcher";
import { ThemeToggle } from "./theme-toggle";
import { AuthMeResponse, Role } from "../types/auth";
import { FeedItem, getBillingPlan, listFeed, listShieldEvents, logoutRequest } from "../lib/api";
import { clearAccessToken, getAccessToken } from "../lib/auth";

interface AppShellProps {
  user: AuthMeResponse;
  title?: string;
  children: React.ReactNode;
}

const navByRole: Record<Role, Array<{ label: string; href: string }>> = {
  CEO: [
    { label: "Home", href: "/" },
    { label: "Marketplace", href: "/marketplace" },
    { label: "CEO Dashboard", href: "/ceo/dashboard" },
    { label: "Risk", href: "/ceo/risk" },
    { label: "Impact Radius", href: "/ceo/impact-radius" },
    { label: "Revenue", href: "/ceo/revenue" },
    { label: "Portfolio", href: "/portfolio" },
    { label: "Action Mode", href: "/ceo/action-mode" },
    { label: "Incidents", href: "/developer?tab=incidents" },
    { label: "Sudarshan Shield", href: "/shield" },
    { label: "Hygiene Inbox", href: "/ops/hygiene" },
    { label: "Nudges", href: "/nudges" },
    { label: "Finance Invoices", href: "/finance/invoices" },
    { label: "Work Board", href: "/ops/work/board" },
    { label: "Work List", href: "/ops/work/list" },
    { label: "User Management", href: "/admin/users" },
    { label: "Execution Graph", href: "/admin/graph" },
    { label: "Autopilot", href: "/admin/autopilot" },
    { label: "Companies", href: "/sales/companies" },
    { label: "Leads", href: "/sales/leads" },
    { label: "Deals", href: "/sales/deals" }
  ],
  OPS: [
    { label: "Home", href: "/" },
    { label: "Marketplace", href: "/marketplace" },
    { label: "Risk", href: "/ceo/risk" },
    { label: "Impact Radius", href: "/ceo/impact-radius" },
    { label: "Hygiene Inbox", href: "/ops/hygiene" },
    { label: "Nudges", href: "/nudges" },
    { label: "Work Board", href: "/ops/work/board" },
    { label: "Work List", href: "/ops/work/list" }
  ],
  SALES: [
    { label: "Home", href: "/" },
    { label: "Marketplace", href: "/marketplace" },
    { label: "Nudges", href: "/nudges" },
    { label: "Companies", href: "/sales/companies" },
    { label: "Leads", href: "/sales/leads" },
    { label: "Deals", href: "/sales/deals" }
  ],
  FINANCE: [
    { label: "Home", href: "/" },
    { label: "Marketplace", href: "/marketplace" },
    { label: "Nudges", href: "/nudges" },
    { label: "Finance Invoices", href: "/finance/invoices" }
  ],
  ADMIN: [
    { label: "Home", href: "/" },
    { label: "Marketplace", href: "/marketplace" },
    { label: "CEO Dashboard", href: "/ceo/dashboard" },
    { label: "Risk", href: "/ceo/risk" },
    { label: "Impact Radius", href: "/ceo/impact-radius" },
    { label: "Revenue", href: "/ceo/revenue" },
    { label: "Portfolio", href: "/portfolio" },
    { label: "Action Mode", href: "/ceo/action-mode" },
    { label: "Incidents", href: "/developer?tab=incidents" },
    { label: "Sudarshan Shield", href: "/shield" },
    { label: "Hygiene Inbox", href: "/ops/hygiene" },
    { label: "Nudges", href: "/nudges" },
    { label: "Finance Invoices", href: "/finance/invoices" },
    { label: "Work Board", href: "/ops/work/board" },
    { label: "Work List", href: "/ops/work/list" },
    { label: "User Management", href: "/admin/users" },
    { label: "Execution Graph", href: "/admin/graph" },
    { label: "Autopilot", href: "/admin/autopilot" },
    { label: "Companies", href: "/sales/companies" },
    { label: "Leads", href: "/sales/leads" },
    { label: "Deals", href: "/sales/deals" }
  ]
};

const settingsNavByRole: Partial<Record<Role, Array<{ label: string; href: string }>>> = {
  CEO: [
    { label: "Billing", href: "/billing" },
    { label: "Policies", href: "/settings/policies" },
    { label: "Audit Export", href: "/settings/audit" },
    { label: "Org Members", href: "/settings/org/members" }
  ],
  ADMIN: [
    { label: "Billing", href: "/billing" },
    { label: "Policies", href: "/settings/policies" },
    { label: "Audit Export", href: "/settings/audit" },
    { label: "Org Members", href: "/settings/org/members" }
  ]
};

export function AppShell({ user, title, children }: AppShellProps) {
  const router = useRouter();
  const pathname = usePathname();
  const nav = navByRole[user.role];
  const settingsNav = settingsNavByRole[user.role] ?? [];
  const [feedOpen, setFeedOpen] = useState(false);
  const [feedItems, setFeedItems] = useState<FeedItem[]>([]);
  const [criticalThreatCount, setCriticalThreatCount] = useState(0);
  const [developerNavVisible, setDeveloperNavVisible] = useState(false);

  useEffect(() => {
    const token = getAccessToken();
    if (!token) {
      return;
    }
    listFeed(token)
      .then((items) => setFeedItems(items))
      .catch(() => setFeedItems([]));

    if (user.role === "CEO" || user.role === "ADMIN") {
      listShieldEvents(token, {
        severity: "CRITICAL",
        resolved: false,
        page: 1,
        pageSize: 1
      })
        .then((payload) => setCriticalThreatCount(payload.total))
        .catch(() => setCriticalThreatCount(0));

      getBillingPlan(token)
        .then((payload) => {
          const allowed =
            payload.plan.enterpriseControlsEnabled ||
            payload.plan.developerPlatformEnabled === true;
          setDeveloperNavVisible(allowed);
        })
        .catch(() => setDeveloperNavVisible(false));
    } else {
      setDeveloperNavVisible(false);
    }
  }, [user.role]);

  const navWithDeveloper =
    (user.role === "CEO" || user.role === "ADMIN") && developerNavVisible
      ? [...nav, { label: "Developer", href: "/developer" }]
      : nav;

  async function onLogout(): Promise<void> {
    await logoutRequest().catch(() => undefined);
    clearAccessToken();
    router.replace("/login");
  }

  const myOpenNudges = feedItems.filter(
    (item) => item.status === "OPEN" && item.targetUserId === user.id
  );

  return (
    <div className="kv-app">
      <header className="kv-header">
        <div className="kv-header-brand">
          <p className="kv-brand">{APP_NAME}</p>
          <p className="kv-role">Role: {user.role}</p>
        </div>
        <div className="kv-toolbar">
          <OrgSwitcher user={user} />
          <div className="kv-toolbar-dropdown-wrap">
            <button type="button" onClick={() => setFeedOpen((prev) => !prev)} className="kv-btn-primary">
              Bell ({myOpenNudges.length})
            </button>
            {feedOpen ? (
              <div className="kv-dropdown">
                <p className="kv-dropdown-title">Latest Nudges</p>
                <ul>
                  {feedItems.slice(0, 5).map((item) => (
                    <li key={item.id}>
                      <Link href="/nudges">{item.message}</Link>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
          {user.role === "CEO" || user.role === "ADMIN" ? (
            <Link
              href="/shield"
              className={`kv-shield-btn${criticalThreatCount > 0 ? " kv-shield-btn-alert" : ""}`}
              aria-label="Open Sudarshan Shield dashboard"
              title={criticalThreatCount > 0 ? "Critical threats detected" : "Sudarshan Shield"}
            >
              Shield
              {criticalThreatCount > 0 ? <span className="kv-shield-dot" /> : null}
            </Link>
          ) : null}
          <ModeSwitcher role={user.role} />
          <ThemeToggle />
          <div className="kv-avatar" title={user.name}>
            {user.name.slice(0, 1).toUpperCase()}
          </div>
          <button type="button" onClick={() => void onLogout()}>
            Logout
          </button>
        </div>
      </header>

      <div className="kv-content">
        <aside className="kv-sidebar">
          <p className="kv-sidebar-title">Navigation</p>
          <nav className="kv-nav">
            {navWithDeveloper.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={`kv-nav-link${pathname === item.href ? " kv-nav-link-active" : ""}`}
              >
                {item.label}
              </Link>
            ))}
          </nav>
          {settingsNav.length > 0 ? (
            <>
              <p className="kv-sidebar-title kv-sidebar-title-gap">
                Settings
              </p>
              <nav className="kv-nav">
                {settingsNav.map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`kv-nav-link${pathname === item.href ? " kv-nav-link-active" : ""}`}
                  >
                    {item.label}
                  </Link>
                ))}
              </nav>
            </>
          ) : null}
        </aside>

        <main className="kv-main">
          {title ? <h1 className="kv-main-title">{title}</h1> : null}
          {children}
        </main>
      </div>
    </div>
  );
}
