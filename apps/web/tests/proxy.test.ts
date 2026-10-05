// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { proxyRequest, resetRefreshCache } from "@/lib/bff/proxy";

const API = "http://api.test";
const ORIGIN = "http://app.test";
const CSRF = "csrf-token-0123456789abcdef";

type Call = { url: string; method: string; headers: Record<string, string>; body: string | null; contentType: string | null };

function mockApi(handler: (c: Call, n: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    let body: string | null = null;
    if (init?.body instanceof ArrayBuffer) body = new TextDecoder().decode(init.body);
    else if (typeof init?.body === "string") body = init.body;
    const call: Call = { url: String(input), method: init?.method ?? "GET", headers, body, contentType: headers["content-type"] ?? null };
    calls.push(call);
    return handler(call, calls.length);
  });
  return { fetchMock: fetchMock as unknown as typeof fetch, calls };
}

function browserReq(path: string, init: { method?: string; cookie?: string; body?: BodyInit; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { host: "app.test", ...(init.headers ?? {}) };
  if (init.cookie) headers.cookie = init.cookie;
  if (init.method && init.method !== "GET") {
    headers.origin = ORIGIN;
    headers["x-kv-csrf"] = CSRF;
    headers.cookie = `${headers.cookie ? `${headers.cookie}; ` : ""}kv_csrf=${CSRF}`;
  }
  return new Request(`${ORIGIN}/api/k/${path}`, { method: init.method ?? "GET", headers, body: init.body });
}

const json = (status: number, data: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });

describe("BFF proxy", () => {
  beforeEach(() => resetRefreshCache());

  it("adds the bearer token from the httpOnly cookie and streams the response back", async () => {
    const { fetchMock, calls } = mockApi(() => json(200, { orgs: [] }));
    const res = await proxyRequest(browserReq("me/access?x=1", { cookie: "kv_at=AT1; kv_rt=RT1" }), ["me", "access"], { apiUrl: API, fetch: fetchMock });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ orgs: [] });
    expect(calls[0]!.url).toBe(`${API}/me/access?x=1`);
    expect(calls[0]!.headers.authorization).toBe("Bearer AT1");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("on a 401 refreshes once, sets rotated cookies and retries", async () => {
    const { fetchMock, calls } = mockApi((c) => {
      if (c.url.endsWith("/auth/refresh")) return json(200, { access_token: "AT2", refresh_token: "RT2", expires_in: 900 });
      return c.headers.authorization === "Bearer AT2" ? json(200, { ok: true }) : json(401, { detail: "invalid or expired token" });
    });
    const res = await proxyRequest(browserReq("auth/me", { cookie: "kv_at=OLD; kv_rt=RT1" }), ["auth", "me"], { apiUrl: API, fetch: fetchMock, secureCookies: true });
    expect(res.status).toBe(200);
    expect(calls.map((c) => c.url)).toEqual([`${API}/auth/me`, `${API}/auth/refresh`, `${API}/auth/me`]);
    expect(JSON.parse(calls[1]!.body!)).toEqual({ refresh_token: "RT1" });
    const cookies = res.headers.getSetCookie();
    expect(cookies.find((c) => c.startsWith("kv_at=AT2"))).toMatch(/HttpOnly; Secure; SameSite=Lax/);
    expect(cookies.find((c) => c.startsWith("kv_at=AT2"))).toContain("Max-Age=900");
    expect(cookies.find((c) => c.startsWith("kv_rt=RT2"))).toContain("Max-Age=2592000");
  });

  it("refreshes proactively when the access cookie has expired", async () => {
    const { fetchMock, calls } = mockApi((c) =>
      c.url.endsWith("/auth/refresh") ? json(200, { access_token: "AT9", refresh_token: "RT9", expires_in: 3600 }) : json(200, {}),
    );
    const res = await proxyRequest(browserReq("orgs", { cookie: "kv_rt=RT1" }), ["orgs"], { apiUrl: API, fetch: fetchMock });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.headers.authorization).toBe("Bearer AT9");
  });

  it("does not retry more than once and clears the session when refresh fails", async () => {
    const { fetchMock, calls } = mockApi((c) =>
      c.url.endsWith("/auth/refresh") ? json(401, { detail: "refresh token invalid, expired or reused" }) : json(401, { detail: "expired" }),
    );
    const res = await proxyRequest(browserReq("auth/me", { cookie: "kv_at=OLD; kv_rt=STOLEN" }), ["auth", "me"], { apiUrl: API, fetch: fetchMock });
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(2);
    const cookies = res.headers.getSetCookie();
    expect(cookies).toHaveLength(2);
    expect(cookies.every((c) => c.includes("Max-Age=0"))).toBe(true);
  });

  it("passes a 401 through when there is no refresh cookie", async () => {
    const { fetchMock, calls } = mockApi(() => json(401, { detail: "missing bearer token" }));
    const res = await proxyRequest(browserReq("auth/me"), ["auth", "me"], { apiUrl: API, fetch: fetchMock });
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(1);
  });

  it("coalesces concurrent refreshes of the same token (reuse would revoke the family)", async () => {
    let refreshes = 0;
    const { fetchMock } = mockApi(async (c) => {
      if (c.url.endsWith("/auth/refresh")) {
        refreshes++;
        await new Promise((r) => setTimeout(r, 20));
        return json(200, { access_token: "AT2", refresh_token: "RT2" });
      }
      return c.headers.authorization === "Bearer AT2" ? json(200, {}) : json(401, {});
    });
    const results = await Promise.all(
      ["a", "b", "c"].map((p) => proxyRequest(browserReq(p, { cookie: "kv_at=OLD; kv_rt=RT1" }), [p], { apiUrl: API, fetch: fetchMock })),
    );
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(refreshes).toBe(1);
  });

  it("resends a multipart body with its original boundary on retry", async () => {
    const form = new FormData();
    form.append("file", new Blob(["date,dish,qty\n2026-09-29,paneer,4\n"], { type: "text/csv" }), "sales.csv");
    const probe = new Request("http://x/", { method: "POST", body: form });
    const contentType = probe.headers.get("content-type")!;
    const raw = await probe.arrayBuffer();
    expect(contentType).toMatch(/^multipart\/form-data; boundary=/);

    const { fetchMock, calls } = mockApi((c) => {
      if (c.url.endsWith("/auth/refresh")) return json(200, { access_token: "AT2", refresh_token: "RT2" });
      return c.headers.authorization === "Bearer AT2" ? json(200, { upserted: 1, errors: [] }) : json(401, {});
    });
    const res = await proxyRequest(
      browserReq("ventures/v1/kitchen/sales/csv", { method: "POST", cookie: "kv_at=OLD; kv_rt=RT1", body: raw, headers: { "content-type": contentType } }),
      ["ventures", "v1", "kitchen", "sales", "csv"],
      { apiUrl: API, fetch: fetchMock },
    );
    expect(res.status).toBe(200);
    const uploads = calls.filter((c) => c.url.endsWith("/sales/csv"));
    expect(uploads).toHaveLength(2);
    for (const u of uploads) {
      expect(u.contentType).toBe(contentType);
      expect(u.body).toContain("paneer");
      expect(u.body).toContain(contentType.split("boundary=")[1]!);
    }
  });

  it("passes binary downloads through with their headers", async () => {
    const bytes = new Uint8Array([37, 80, 68, 70, 0, 255]);
    const { fetchMock } = mockApi(
      () =>
        new Response(bytes, {
          status: 200,
          headers: { "content-type": "application/pdf", "content-disposition": 'attachment; filename="pan.pdf"', "set-cookie": "evil=1" },
        }),
    );
    const res = await proxyRequest(browserReq("ventures/v/documents/d/raw", { cookie: "kv_at=AT" }), ["ventures", "v", "documents", "d", "raw"], {
      apiUrl: API,
      fetch: fetchMock,
    });
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="pan.pdf"');
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
  });

  it("sends public endpoints without a token", async () => {
    const { fetchMock, calls } = mockApi(() => json(200, { reference: "TRU" }));
    await proxyRequest(browserReq("public/upload/tok", { cookie: "kv_at=AT" }), ["public", "upload", "tok"], { apiUrl: API, fetch: fetchMock });
    expect(calls[0]!.headers.authorization).toBeUndefined();
  });

  it("never exposes token-issuing auth endpoints", async () => {
    const { fetchMock, calls } = mockApi(() => json(200, { access_token: "leak" }));
    for (const p of ["login", "register", "refresh", "logout"]) {
      const res = await proxyRequest(browserReq(`auth/${p}`, { method: "POST", body: "{}" }), ["auth", p], { apiUrl: API, fetch: fetchMock });
      expect(res.status).toBe(404);
    }
    expect(calls).toHaveLength(0);
  });

  it("refuses cross-site writes before contacting the API", async () => {
    const { fetchMock, calls } = mockApi(() => json(200, {}));
    const r = new Request(`${ORIGIN}/api/k/orgs`, { method: "POST", headers: { host: "app.test", origin: "https://evil.example", cookie: "kv_at=AT" }, body: "{}" });
    const res = await proxyRequest(r, ["orgs"], { apiUrl: API, fetch: fetchMock });
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it("rejects path traversal", async () => {
    const { fetchMock } = mockApi(() => json(200, {}));
    const res = await proxyRequest(browserReq("x"), ["..", "admin"], { apiUrl: API, fetch: fetchMock });
    expect(res.status).toBe(400);
  });

  it("reports an unreachable API as 502", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const res = await proxyRequest(browserReq("orgs", { cookie: "kv_at=AT" }), ["orgs"], { apiUrl: API, fetch: fetchMock });
    expect(res.status).toBe(502);
  });

  it("refuses a state-changing request without a matching CSRF token", async () => {
    const { fetchMock, calls } = mockApi(() => json(200, {}));
    const base = { host: "app.test", origin: ORIGIN };
    const noToken = new Request(`${ORIGIN}/api/k/orgs`, { method: "POST", headers: { ...base, cookie: "kv_at=AT" }, body: "{}" });
    const mismatch = new Request(`${ORIGIN}/api/k/orgs`, {
      method: "POST",
      headers: { ...base, cookie: `kv_at=AT; kv_csrf=${CSRF}`, "x-kv-csrf": "someone-elses-token-0000000" },
      body: "{}",
    });
    for (const r of [noToken, mismatch]) {
      const res = await proxyRequest(r, ["orgs"], { apiUrl: API, fetch: fetchMock });
      expect(res.status).toBe(403);
    }
    expect(calls).toHaveLength(0);
    // the same request with the token goes through, and GETs never need one
    const ok = await proxyRequest(browserReq("orgs", { method: "POST", cookie: "kv_at=AT", body: "{}" }), ["orgs"], { apiUrl: API, fetch: fetchMock });
    expect(ok.status).toBe(200);
  });
});
