import { describe, expect, it, vi } from "vitest";
import { OAUTH_COOKIE, completeGoogle, startGoogle } from "@/lib/bff/oauth";

const deps = (fetchImpl: typeof fetch) => ({ apiUrl: "http://api", fetch: fetchImpl, secureCookies: false, trustedOrigins: [] });
const V = "11111111-2222-3333-4444-555555555555";

describe("Google OAuth BFF", () => {
  it("start: sends a nonce to the API and pins it in an httpOnly cookie", async () => {
    const f = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(new TextDecoder().decode(init?.body as ArrayBuffer));
      expect(body.nonce).toMatch(/^[0-9a-f]{64}$/);
      return new Response(JSON.stringify({ url: "https://accounts.google.com/o/oauth2?x" }), { status: 200 });
    });
    const req = new Request("http://app.test/api/oauth/google/start", {
      method: "POST",
      headers: { origin: "http://app.test", host: "app.test", cookie: "kv_at=tok", "content-type": "application/json" },
      body: JSON.stringify({ venture_id: V }),
    });
    const res = await startGoogle(req, deps(f as unknown as typeof fetch));
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${OAUTH_COOKIE}=`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Path=/api/oauth");
    expect(f.mock.calls[0]![0]).toBe(`http://api/ventures/${V}/connectors/google/start`);
  });

  it("callback without the nonce cookie never reaches the API", async () => {
    const f = vi.fn();
    const req = new Request("http://app.test/api/oauth/google/callback?code=c&state=s", { headers: { host: "app.test", cookie: "kv_at=tok" } });
    const res = await completeGoogle(req, deps(f as unknown as typeof fetch));
    expect(f).not.toHaveBeenCalled();
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("google=invalid_state");
  });

  it("callback forwards code, state and the cookie nonce, then clears the cookie", async () => {
    const f = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(new TextDecoder().decode(init?.body as ArrayBuffer))).toEqual({ code: "c", state: "s", nonce: "n".repeat(64) });
      return new Response(JSON.stringify({ venture_id: V }), { status: 200 });
    });
    const req = new Request("http://app.test/api/oauth/google/callback?code=c&state=s", {
      headers: { host: "app.test", cookie: `kv_at=tok; ${OAUTH_COOKIE}=${"n".repeat(64)}` },
    });
    const res = await completeGoogle(req, deps(f as unknown as typeof fetch));
    expect(res.headers.get("location")).toContain(`google=connected`);
    expect(res.headers.get("location")).toContain(`venture=${V}`);
    expect(res.headers.get("set-cookie")).toContain(`${OAUTH_COOKIE}=;`);
  });

  it("a completion refused by the API maps to forbidden", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ detail: "not started in this session" }), { status: 403 }));
    const req = new Request("http://app.test/api/oauth/google/callback?code=c&state=s", {
      headers: { host: "app.test", cookie: `kv_at=tok; ${OAUTH_COOKIE}=abc` },
    });
    const res = await completeGoogle(req, deps(f as unknown as typeof fetch));
    expect(res.headers.get("location")).toContain("google=forbidden");
  });
});
