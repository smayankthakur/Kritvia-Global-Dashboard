import { describe, expect, it, vi } from "vitest";
import { OAUTH_COOKIE, SIGNIN_COOKIE, completeGoogle, startGoogle, startGoogleSignin, stateType } from "@/lib/bff/oauth";

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

const signinState = (typ = "signin") =>
  `h.${btoa(JSON.stringify({ typ, nh: "x", exp: 9 })).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_")}.sig`;

describe("Sign in with Google BFF", () => {
  it("start: no session needed; pins the nonce in kv_signin", async () => {
    const f = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("http://api/auth/google/start");
      expect(JSON.parse(String(init?.body)).nonce).toMatch(/^[0-9a-f]{64}$/);
      return Response.json({ url: "https://accounts.google.com/o/oauth2?x" });
    });
    const req = new Request("http://app.test/api/auth/google/start", {
      method: "POST",
      headers: { origin: "http://app.test", host: "app.test" },
    });
    const res = await startGoogleSignin(req, deps(f as unknown as typeof fetch));
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${SIGNIN_COOKIE}=`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Path=/api/oauth");
  });

  it("start refuses cross-site posts", async () => {
    const f = vi.fn();
    const req = new Request("http://app.test/api/auth/google/start", {
      method: "POST",
      headers: { origin: "https://evil.example", host: "app.test" },
    });
    expect((await startGoogleSignin(req, deps(f as unknown as typeof fetch))).status).toBe(403);
    expect(f).not.toHaveBeenCalled();
  });

  it("callback with a signin state sets session cookies and lands on the app", async () => {
    const state = signinState();
    const f = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("http://api/auth/google/complete");
      expect(JSON.parse(String(init?.body))).toEqual({ code: "c", state, nonce: "n".repeat(64) });
      return Response.json({ access_token: "AT", refresh_token: "RT", expires_in: 3600 });
    });
    const req = new Request(`http://app.test/api/oauth/google/callback?code=c&state=${state}`, {
      headers: { host: "app.test", cookie: `${SIGNIN_COOKIE}=${"n".repeat(64)}` },
    });
    const res = await completeGoogle(req, deps(f as unknown as typeof fetch));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("http://app.test/");
    const cookies = res.headers.getSetCookie();
    expect(cookies.some((c) => c.startsWith("kv_at=AT;") && c.includes("HttpOnly"))).toBe(true);
    expect(cookies.some((c) => c.startsWith(`${SIGNIN_COOKIE}=;`))).toBe(true);
  });

  it("signin callback without the nonce cookie never reaches the API", async () => {
    const f = vi.fn();
    const req = new Request(`http://app.test/api/oauth/google/callback?code=c&state=${signinState()}`, { headers: { host: "app.test" } });
    const res = await completeGoogle(req, deps(f as unknown as typeof fetch));
    expect(f).not.toHaveBeenCalled();
    expect(res.headers.get("location")).toBe("http://app.test/login?google=invalid_state");
  });

  it("signin refused by the API goes back to login without cookies", async () => {
    const f = vi.fn(async () => Response.json({ detail: "disabled" }, { status: 403 }));
    const req = new Request(`http://app.test/api/oauth/google/callback?code=c&state=${signinState()}`, {
      headers: { host: "app.test", cookie: `${SIGNIN_COOKIE}=abc` },
    });
    const res = await completeGoogle(req, deps(f as unknown as typeof fetch));
    expect(res.headers.get("location")).toBe("http://app.test/login?google=forbidden");
    expect(res.headers.getSetCookie().some((c) => c.startsWith("kv_at="))).toBe(false);
  });

  it("stateType reads only well-formed claims", () => {
    expect(stateType(signinState())).toBe("signin");
    expect(stateType(signinState("oauth"))).toBe("oauth");
    expect(stateType("garbage")).toBeNull();
    expect(stateType(null)).toBeNull();
  });
});

describe("Google OAuth behind a tunnel", () => {
  it("start works when req.url is the internal address and Host is the public one", async () => {
    const f = vi.fn(async () => Response.json({ url: "https://accounts.google.com/o/oauth2?x" }));
    const req = new Request("http://localhost:3000/api/oauth/google/start", {
      method: "POST",
      headers: { origin: "https://app.sitelytc.com", host: "app.sitelytc.com", cookie: "kv_at=tok", "content-type": "application/json" },
      body: JSON.stringify({ venture_id: V }),
    });
    const res = await startGoogle(req, deps(f as unknown as typeof fetch));
    expect(res.status).toBe(200);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("start refuses a cross-site post", async () => {
    const f = vi.fn();
    const req = new Request("http://localhost:3000/api/oauth/google/start", {
      method: "POST",
      headers: { origin: "https://evil.example", host: "app.sitelytc.com", cookie: "kv_at=tok" },
      body: JSON.stringify({ venture_id: V }),
    });
    expect((await startGoogle(req, deps(f as unknown as typeof fetch))).status).toBe(403);
    expect(f).not.toHaveBeenCalled();
  });

  it("the connector callback (a GET with no Origin) reaches the API behind a tunnel", async () => {
    const f = vi.fn(async () => Response.json({ venture_id: V }));
    const req = new Request("http://localhost:3000/api/oauth/google/callback?code=c&state=s", {
      headers: { host: "app.sitelytc.com", cookie: `kv_at=tok; ${OAUTH_COOKIE}=${"n".repeat(64)}` },
    });
    const res = await completeGoogle(req, deps(f as unknown as typeof fetch));
    expect(f).toHaveBeenCalledTimes(1);
    expect(res.headers.get("location")).toContain("google=connected");
  });
});

describe("OAuth redirects behind a tunnel", () => {
  it("send the browser back to the public host, never the container address", async () => {
    const f = vi.fn(async () => Response.json({ venture_id: V }));
    const req = new Request("http://0.0.0.0:3000/api/oauth/google/callback?code=c&state=s", {
      headers: { host: "app.sitelytc.com", "x-forwarded-proto": "https", cookie: `kv_at=tok; ${OAUTH_COOKIE}=${"n".repeat(64)}` },
    });
    const res = await completeGoogle(req, deps(f as unknown as typeof fetch));
    expect(res.headers.get("location")).toMatch(/^https:\/\/app\.sitelytc\.com\/settings\/connectors\?/);
  });

  it("sign-in lands on the public host too", async () => {
    const f = vi.fn(async () => Response.json({ access_token: "AT", refresh_token: "RT", expires_in: 3600 }));
    const req = new Request(`http://0.0.0.0:3000/api/oauth/google/callback?code=c&state=${signinState()}`, {
      headers: { host: "app.sitelytc.com", "x-forwarded-proto": "https", cookie: `${SIGNIN_COOKIE}=${"n".repeat(64)}` },
    });
    const res = await completeGoogle(req, deps(f as unknown as typeof fetch));
    expect(res.headers.get("location")).toBe("https://app.sitelytc.com/");
  });
});
