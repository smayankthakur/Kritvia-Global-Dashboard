"use client";

import { useQuery } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { api, unwrap, type Schemas } from "./api";
import { readCookie, writeCookie } from "./cookies-client";

export type Access = Schemas["AccessOut"];
export type OrgSummary = Schemas["OrgSummary"];
export type VentureKind = "software" | "finance" | "kitchen" | "general";

export const accessKey = ["me", "access"] as const;
export const meKey = ["me"] as const;
const ORG = "kv_org";
const VENTURE = "kv_venture";

interface AccessCtx {
  me: Schemas["MeOut"] | undefined;
  orgs: OrgSummary[];
  org: OrgSummary | null;
  ventures: Access[];
  /** The venture from the URL (/v/<id>/...) or the last one used in this org. */
  venture: Access | null;
  setOrg: (id: string) => void;
  rememberVenture: (id: string) => void;
  isOwner: boolean;
}

const Ctx = createContext<AccessCtx | null>(null);

export function useAccessQuery() {
  return useQuery({ queryKey: accessKey, queryFn: () => unwrap(api.GET("/me/access")), staleTime: 60_000 });
}

export function AccessProvider({ access, children }: { access: Schemas["MeAccessOut"]; children: ReactNode }) {
  const params = useParams<{ ventureId?: string }>();
  const me = useQuery({ queryKey: meKey, queryFn: () => unwrap(api.GET("/auth/me")), staleTime: 5 * 60_000 });
  const [orgId, setOrgId] = useState<string | null>(() => readCookie(ORG));
  const [lastVenture, setLastVenture] = useState<string | null>(() => readCookie(VENTURE));

  const urlVenture = params?.ventureId ? access.ventures.find((v) => v.venture_id === params.ventureId) : undefined;
  const org =
    (urlVenture && access.orgs.find((o) => o.id === urlVenture.org_id)) ||
    access.orgs.find((o) => o.id === orgId) ||
    access.orgs[0] ||
    null;
  const ventures = useMemo(
    () => access.ventures.filter((v) => v.org_id === org?.id).sort((a, b) => a.venture_name.localeCompare(b.venture_name)),
    [access.ventures, org?.id],
  );
  const venture = urlVenture ?? ventures.find((v) => v.venture_id === lastVenture) ?? ventures[0] ?? null;

  const setOrg = useCallback((id: string) => {
    writeCookie(ORG, id);
    setOrgId(id);
  }, []);
  const rememberVenture = useCallback((id: string) => {
    writeCookie(VENTURE, id);
    setLastVenture(id);
  }, []);

  const value = useMemo<AccessCtx>(
    () => ({
      me: me.data,
      orgs: access.orgs,
      org,
      ventures,
      venture,
      setOrg,
      rememberVenture,
      isOwner: Boolean(org?.is_owner),
    }),
    [me.data, access.orgs, org, ventures, venture, setOrg, rememberVenture],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAccess(): AccessCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useAccess outside AccessProvider");
  return c;
}

/** The venture addressed by the current /v/<ventureId> route (null if not visible to the user). */
export function useRouteVenture(): Access | null {
  const params = useParams<{ ventureId?: string }>();
  const { venture } = useAccess();
  return venture && venture.venture_id === params?.ventureId ? venture : null;
}

export function kindOf(v: Pick<Access, "kind"> | null | undefined): VentureKind {
  const k = v?.kind;
  return k === "software" || k === "finance" || k === "kitchen" ? k : "general";
}

export function hasRole(v: Access | null | undefined, ...roles: string[]): boolean {
  if (!v) return false;
  return roles.some((r) => v.roles.includes(r));
}
