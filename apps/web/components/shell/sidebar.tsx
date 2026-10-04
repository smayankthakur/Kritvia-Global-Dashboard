"use client";

import { useQuery } from "@tanstack/react-query";
import { LayoutGroup, motion } from "motion/react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { cn } from "@/components/ui/cn";
import { api, unwrap } from "@/lib/api";
import { kindOf, useAccess } from "@/lib/access";
import { accountNav, ownerNav, topNav, ventureNav, type NavItem } from "@/lib/nav";
import { Logo } from "./logo";

export const inboxKey = ["approvals", "inbox"] as const;

export function useInbox() {
  return useQuery({
    queryKey: inboxKey,
    queryFn: () => unwrap(api.GET("/approvals/inbox", { params: { query: { limit: 300 } } })),
    refetchInterval: 30_000,
  });
}

const COMMON = new Set(["runs", "knowledge", "meetings", "voice", "tasks", "trust", "compliance", "settings"]);

function isActive(pathname: string, item: NavItem): boolean {
  if (item.href === "/") return pathname === "/";
  return pathname === item.href || pathname.startsWith(item.href + "/");
}

function NavLink({ item, pathname, badge, onNavigate }: { item: NavItem; pathname: string; badge?: number; onNavigate?: () => void }) {
  const active = isActive(pathname, item);
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group relative flex h-8 items-center gap-2.5 rounded-md px-2.5 text-[13.5px] transition-colors duration-150",
        active ? "font-medium text-accent-soft-fg" : "text-muted hover:bg-surface-2 hover:text-fg",
      )}
    >
      {active ? (
        // The highlight glides to the newly selected item (disabled under reduced motion).
        <motion.span
          layoutId="nav-active"
          className="absolute inset-0 rounded-md bg-accent-soft"
          transition={{ type: "spring", stiffness: 520, damping: 42 }}
          aria-hidden
        >
          <span className="absolute top-1.5 bottom-1.5 left-0 w-[3px] rounded-full bg-accent" />
        </motion.span>
      ) : null}
      <Icon
        className={cn("relative h-4 w-4 shrink-0 transition-colors duration-150", active ? "text-accent" : "text-subtle group-hover:text-muted")}
        aria-hidden
      />
      <span className="relative truncate">{item.label}</span>
      {badge ? (
        <span
          className="relative ml-auto animate-scale-in rounded-full bg-accent px-1.5 text-[11px] leading-[18px] font-semibold text-accent-fg tabular-nums"
          aria-label={`${badge} pending`}
        >
          {badge > 99 ? "99+" : badge}
        </span>
      ) : null}
    </Link>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="mt-5 mb-1 truncate px-2.5 text-[11px] font-semibold tracking-wider text-subtle uppercase">{children}</div>;
}

export function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  // Separate groups so the desktop sidebar and the phone menu each animate their own highlight.
  return (
    <LayoutGroup id={onNavigate ? "nav-sheet" : "nav-aside"}>
      <SidebarBody onNavigate={onNavigate} />
    </LayoutGroup>
  );
}

function SidebarBody({ onNavigate }: { onNavigate?: () => void }) {
  const { orgs, org, ventures, venture, setOrg, rememberVenture, isOwner } = useAccess();
  const pathname = usePathname() ?? "/";
  const router = useRouter();
  const inbox = useInbox();
  const pending = inbox.data?.length ?? 0;

  const switchVenture = (id: string) => {
    rememberVenture(id);
    const target = ventures.find((v) => v.venture_id === id);
    const m = /^\/v\/[^/]+\/([^/]+)/.exec(pathname);
    if (m && target) {
      const section = m[1]!;
      const nav = ventureNav(id, kindOf(target));
      const same = [...nav.domain, ...nav.common].find((n) => n.href.split("/")[3] === section);
      const dest = same?.href ?? (COMMON.has(section) ? `/v/${id}/${section}` : nav.domain[0]?.href ?? `/v/${id}/runs`);
      router.push(dest);
      onNavigate?.();
    }
  };

  const nav = venture ? ventureNav(venture.venture_id, kindOf(venture)) : null;

  return (
    <div className="flex h-full flex-col">
      <div className="px-4 pt-4 pb-3">
        <Logo />
      </div>
      <div className="space-y-2 px-3 pb-2">
        {orgs.length > 1 ? (
          <div>
            <label htmlFor="org-switch" className="sr-only">
              Organisation
            </label>
            <select
              id="org-switch"
              value={org?.id ?? ""}
              onChange={(e) => {
                setOrg(e.target.value);
                router.push("/");
                onNavigate?.();
              }}
              className="kv-select h-8 w-full appearance-none rounded-md border border-border bg-surface pr-7 pl-2 text-[13px] font-medium transition-colors duration-150 hover:border-border-strong"
            >
              {orgs.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <div className="truncate px-1 text-[13px] font-medium text-fg" title="Organisation">
            {org?.name}
          </div>
        )}
        {ventures.length ? (
          <div>
            <div className="mb-1 flex items-center justify-between px-1">
              <label htmlFor="venture-switch" className="block text-[11px] font-medium text-subtle">
                Business
              </label>
              {org?.is_owner ? (
                <Link href="/businesses" onClick={() => onNavigate?.()} className="text-[11px] text-accent hover:underline">
                  Manage
                </Link>
              ) : null}
            </div>
            <select
              id="venture-switch"
              value={venture?.venture_id ?? ""}
              onChange={(e) => switchVenture(e.target.value)}
              className="kv-select h-8 w-full appearance-none rounded-md border border-border bg-surface pr-7 pl-2 text-[13px] transition-colors duration-150 hover:border-border-strong"
            >
              {ventures.map((v) => (
                <option key={v.venture_id} value={v.venture_id}>
                  {v.venture_name}
                </option>
              ))}
            </select>
          </div>
        ) : null}
      </div>
      <nav aria-label="Main" className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
        <div className="space-y-0.5">
          {topNav.map((item) => (
            <NavLink
              key={item.href}
              item={item}
              pathname={pathname}
              badge={item.href === "/inbox" ? pending : undefined}
              onNavigate={onNavigate}
            />
          ))}
        </div>
        {venture && nav ? (
          <>
            <SectionLabel>{venture.venture_name}</SectionLabel>
            <div className="space-y-0.5">
              {nav.domain.map((item) => (
                <NavLink key={item.href} item={item} pathname={pathname} onNavigate={onNavigate} />
              ))}
            </div>
            <div className="mt-3 space-y-0.5 border-t border-border pt-3">
              {nav.common.map((item) => (
                <NavLink key={item.href} item={item} pathname={pathname} onNavigate={onNavigate} />
              ))}
            </div>
          </>
        ) : null}
        {isOwner ? (
          <>
            <SectionLabel>Organisation</SectionLabel>
            <div className="space-y-0.5">
              {ownerNav.map((item) => (
                <NavLink key={item.href} item={item} pathname={pathname} onNavigate={onNavigate} />
              ))}
            </div>
          </>
        ) : null}
        <div className="mt-3 space-y-0.5 border-t border-border pt-3">
          {accountNav.map((item) => (
            <NavLink key={item.href} item={item} pathname={pathname} onNavigate={onNavigate} />
          ))}
        </div>
      </nav>
    </div>
  );
}
