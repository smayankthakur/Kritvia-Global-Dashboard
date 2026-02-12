"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ApiError, meRequest, refreshAccessToken } from "./api";
import { clearAccessToken, getAccessToken, setAccessToken } from "./auth";
import { AuthMeResponse } from "../types/auth";

export function useAuthUser() {
  const router = useRouter();
  const [user, setUser] = useState<AuthMeResponse | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
        setUser(me);
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

  return { user, token, loading, error };
}
