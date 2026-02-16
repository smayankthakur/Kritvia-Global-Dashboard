"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError, meRequest, refreshAccessToken } from "./api";
import { clearAccessToken, getAccessToken, setAccessToken } from "./auth";
import { AuthMeResponse, OrgMembership, Role } from "../types/auth";

function normalizeUser(me: AuthMeResponse): AuthMeResponse {
  const activeOrgId = me.activeOrgId ?? me.orgId;
  const memberships: OrgMembership[] =
    me.memberships && me.memberships.length > 0
      ? me.memberships
      : [
          {
            orgId: me.orgId,
            orgName: "Current Org",
            role: me.role,
            status: "ACTIVE"
          }
        ];

  return {
    ...me,
    activeOrgId,
    memberships
  };
}

export function useAuthUser() {
  const router = useRouter();
  const [user, setUser] = useState<AuthMeResponse | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refreshMe = useCallback(async (): Promise<AuthMeResponse | null> => {
    const activeToken = getAccessToken();
    if (!activeToken) {
      return null;
    }
    const me = await meRequest(activeToken);
    const normalized = normalizeUser(me);
    setUser(normalized);
    setToken(activeToken);
    return normalized;
  }, []);

  useEffect(() => {
    let settled = false;
    const timeoutId = window.setTimeout(() => {
      if (!settled) {
        setError("Session check timed out. Please sign in again.");
        setLoading(false);
      }
    }, 12000);

    async function initialize(): Promise<void> {
      let activeToken = getAccessToken();

      if (!activeToken) {
        try {
          activeToken = await refreshAccessToken();
          setAccessToken(activeToken);
        } catch {
          clearAccessToken();
          router.replace("/login");
          setLoading(false);
          return;
        }
      }

      setToken(activeToken);

      try {
        const me = await meRequest(activeToken);
        setUser(normalizeUser(me));
      } catch (requestError) {
        if (requestError instanceof ApiError && requestError.status === 401) {
          clearAccessToken();
          router.replace("/login");
          return;
        }

        setError(requestError instanceof Error ? requestError.message : "Failed to load user");
      } finally {
        settled = true;
        window.clearTimeout(timeoutId);
        setLoading(false);
      }
    }

    void initialize();

    return () => {
      settled = true;
      window.clearTimeout(timeoutId);
    };
  }, [router]);

  const memberships = useMemo(() => user?.memberships ?? [], [user]);
  const activeOrgId = user?.activeOrgId ?? user?.orgId ?? null;
  const activeMembership = useMemo(
    () => memberships.find((membership) => membership.orgId === activeOrgId) ?? null,
    [activeOrgId, memberships]
  );
  const activeOrgName = activeMembership?.orgName ?? "Current Org";
  const roleForActiveOrg = (activeMembership?.role ?? user?.role ?? null) as Role | null;

  return {
    user,
    token,
    loading,
    error,
    memberships,
    activeOrgId,
    activeOrgName,
    roleForActiveOrg,
    refreshMe
  };
}
