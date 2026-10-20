import { describe, expect, it, vi } from "vitest";
import { shortName } from "@/components/apps/app-store";
import { OAUTH_COOKIE, completeMcp, startMcp } from "@/lib/bff/oauth";

const deps = (fetchImpl: typeof fetch) => ({ apiUrl: "http://api", fetch: fetchImpl, secureCookies: false, trustedOrigins: [] });
const V = "11111111-2222-3333-4444-555555555555";
const TOK = "csrf-token-0123456789abcdef";

describe("App store sign-in (MCP OAuth) BFF", () => {
  it("start sends the app and a nonce to the API and pins the nonce", async () => {
    const f = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(new TextDecoder().decode(init?.body as ArrayBuffer));
      expect(body).toMatchObject({ name: "notion", url: "https://mcp.notion.com/mcp", catalog_id: "kritvia:notion" });
      expect(body.nonce).toMatch(/^[0-9a-f]{64}$/);
      return new Response(JSON.stringify({ authorize_url: "https://mcp.notion.com/authorize?x" }), { status: 200 });
    });
    const req = new Request("http://app.test/api/oauth/mcp/start", {
      method: "POST",
      headers: { origin: "http://app.test", host: "app.test", cookie: `kv_at=tok; kv_csrf=${TOK}`, "x-kv-csrf": TOK, "content-type": "application/json" },
      body: JSON.stringify({ venture_id: V, name: "notion", url: "https://mcp.notion.com/mcp", catalog_id: "kritvia:notion" }),
    });
    const res = await startMcp(req, deps(f as unknown as typeof fetch));
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain(`${OAUTH_COOKIE}=`);
    expect((f.mock.calls[0] as unknown[])[0]).toBe(`http://api/ventures/${V}/apps/oauth/start`);
  });

  it("start refuses cross-site posts", async () => {
    const f = vi.fn();
    const req = new Request("http://app.test/api/oauth/mcp/start", {
      method: "POST",
      headers: { origin: "https://evil.example", host: "app.test", "content-type": "application/json" },
      body: JSON.stringify({ venture_id: V }),
    });
    expect((await startMcp(req, deps(f as unknown as typeof fetch))).status).toBe(403);
    expect(f).not.toHaveBeenCalled();
  });

  it("callback completes with code, state, iss and the cookie nonce, then goes to the business's App store", async () => {
    const f = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(new TextDecoder().decode(init?.body as ArrayBuffer))).toEqual({ code: "c", state: "s", iss: "https://auth.x", nonce: "n".repeat(64) });
      return new Response(JSON.stringify({ venture_id: V, app: { name: "notion" } }), { status: 200 });
    });
    const req = new Request("http://app.test/api/oauth/mcp/callback?code=c&state=s&iss=https%3A%2F%2Fauth.x", {
      headers: { host: "app.test", cookie: `kv_at=tok; ${OAUTH_COOKIE}=${"n".repeat(64)}` },
    });
    const res = await completeMcp(req, deps(f as unknown as typeof fetch));
    const loc = res.headers.get("location") ?? "";
    expect(loc).toContain(`/v/${V}/apps`);
    expect(loc).toContain("app=connected");
    expect(loc).toContain("name=notion");
    expect(res.headers.get("set-cookie")).toContain(`${OAUTH_COOKIE}=;`);
  });

  it("callback without the cookie never reaches the API; a refusal maps to its outcome", async () => {
    const f = vi.fn();
    const res = await completeMcp(new Request("http://app.test/api/oauth/mcp/callback?code=c&state=s", { headers: { host: "app.test" } }), deps(f as unknown as typeof fetch));
    expect(f).not.toHaveBeenCalled();
    expect(res.headers.get("location")).toContain("app=invalid_state");
    const g = vi.fn(async () => new Response("{}", { status: 422 }));
    const bad = await completeMcp(
      new Request("http://app.test/api/oauth/mcp/callback?code=c&state=s", { headers: { host: "app.test", cookie: `kv_at=tok; ${OAUTH_COOKIE}=abc` } }),
      deps(g as unknown as typeof fetch),
    );
    expect(bad.headers.get("location")).toContain("app=exchange_failed");
    const denied = await completeMcp(new Request("http://app.test/api/oauth/mcp/callback?error=access_denied", { headers: { host: "app.test" } }), deps(f as unknown as typeof fetch));
    expect(denied.headers.get("location")).toContain("app=denied");
  });
});

describe("shortName", () => {
  it("makes a name the assistant can use", () => {
    expect(shortName("Jira & Confluence")).toBe("jira_confluence");
    expect(shortName("123 Hugging Face")).toBe("hugging_face");
    expect(shortName("Exa web search, built for AI agents everywhere")).toHaveLength(24);
    expect(shortName("!!!")).toBe("app");
  });
});
