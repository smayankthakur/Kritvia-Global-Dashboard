// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { exchangeCredentials, forwardAnonymous, logout } from "@/lib/bff/auth";

const req = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://app.test${path}`, {
    method: "POST",
    headers: { host: "app.test", origin: "http://app.test", "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

describe("auth route handlers", () => {
  it("login turns the token pair into httpOnly cookies and never returns tokens", async () => {
    const fetchMock = vi.fn(async () => Response.json({ access_token: "AT", refresh_token: "RT", expires_in: 3600, token_type: "bearer" }));
    const res = await exchangeCredentials(req("/api/auth/login", { email: "a@b.in", password: "x".repeat(12) }), "login", fetchMock as unknown as typeof fetch);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("AT");
    expect(text).not.toContain("RT");
    const cookies = res.headers.getSetCookie();
    expect(cookies.some((c) => c.startsWith("kv_at=AT;") && c.includes("HttpOnly") && c.includes("Max-Age=3600"))).toBe(true);
    expect(cookies.some((c) => c.startsWith("kv_rt=RT;") && c.includes("HttpOnly") && c.includes("SameSite=Lax"))).toBe(true);
  });

  it("passes API errors through (e.g. 401 invalid credentials, 429 with Retry-After)", async () => {
    const f401 = vi.fn(async () => Response.json({ detail: "invalid credentials" }, { status: 401 }));
    const r1 = await exchangeCredentials(req("/api/auth/login", {}), "login", f401 as unknown as typeof fetch);
    expect(r1.status).toBe(401);
    expect(await r1.json()).toEqual({ detail: "invalid credentials" });
    expect(r1.headers.getSetCookie()).toHaveLength(0);

    const f429 = vi.fn(async () => Response.json({ detail: "too many requests, slow down" }, { status: 429, headers: { "retry-after": "12" } }));
    const r2 = await exchangeCredentials(req("/api/auth/register", {}), "register", f429 as unknown as typeof fetch);
    expect(r2.status).toBe(429);
    expect(r2.headers.get("retry-after")).toBe("12");
  });

  it("refuses cross-site credential posts", async () => {
    const fetchMock = vi.fn();
    const res = await exchangeCredentials(req("/api/auth/login", {}, { origin: "https://evil.example" }), "login", fetchMock as unknown as typeof fetch);
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("logout revokes the refresh token and clears both cookies", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    const res = await logout(req("/api/auth/logout", {}, { cookie: "kv_at=AT; kv_rt=RT" }), fetchMock as unknown as typeof fetch);
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ refresh_token: "RT" });
    expect(res.headers.getSetCookie().every((c) => c.includes("Max-Age=0"))).toBe(true);
  });
});

describe("email code routes", () => {
  it("email/verify sets session cookies like login", async () => {
    const f = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toMatch(/\/auth\/email\/verify$/);
      return Response.json({ access_token: "AT", refresh_token: "RT", expires_in: 3600 });
    });
    const res = await exchangeCredentials(req("/api/auth/email/verify", { email: "a@b.in", code: "123456" }), "email/verify", f as unknown as typeof fetch);
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie().some((c) => c.startsWith("kv_at=AT;"))).toBe(true);
  });

  it("email/start forwards without tokens and refuses cross-site", async () => {
    const f = vi.fn(async () => Response.json({ sent: true, expires_in: 600 }, { status: 202 }));
    const ok = await forwardAnonymous(req("/api/auth/email/start", { email: "a@b.in" }), "auth/email/start", f as unknown as typeof fetch);
    expect(ok.status).toBe(202);
    expect(ok.headers.getSetCookie()).toHaveLength(0);
    const bad = await forwardAnonymous(req("/api/auth/email/start", {}, { origin: "https://evil.example" }), "auth/email/start", f as unknown as typeof fetch);
    expect(bad.status).toBe(403);
    expect(f).toHaveBeenCalledTimes(1);
  });
});
