// @vitest-environment node
import { describe, expect, it } from "vitest";
import { isSameOrigin } from "@/lib/bff/origin";

function req(method: string, headers: Record<string, string>, url = "http://app.kritvia.in/api/k/orgs") {
  return new Request(url, { method, headers });
}

describe("isSameOrigin (CSRF check)", () => {
  it("lets safe methods through without an Origin", () => {
    expect(isSameOrigin(req("GET", {}), [])).toBe(true);
    expect(isSameOrigin(req("HEAD", {}), [])).toBe(true);
  });
  it("accepts writes whose Origin matches the Host", () => {
    expect(isSameOrigin(req("POST", { origin: "http://app.kritvia.in", host: "app.kritvia.in" }), [])).toBe(true);
    expect(isSameOrigin(req("DELETE", { origin: "http://localhost:3000", host: "localhost:3000" }, "http://localhost:3000/api/k/x"), [])).toBe(true);
  });
  it("uses X-Forwarded-Host behind a tunnel", () => {
    const r = req("PUT", { origin: "https://ops.sitelytc.com", host: "127.0.0.1:3000", "x-forwarded-host": "ops.sitelytc.com" });
    expect(isSameOrigin(r, [])).toBe(true);
  });
  it("rejects writes from another site, a missing Origin or a null Origin", () => {
    expect(isSameOrigin(req("POST", { origin: "https://evil.example", host: "app.kritvia.in" }), [])).toBe(false);
    expect(isSameOrigin(req("POST", { host: "app.kritvia.in" }), [])).toBe(false);
    expect(isSameOrigin(req("PATCH", { origin: "null", host: "app.kritvia.in" }), [])).toBe(false);
    expect(isSameOrigin(req("POST", { origin: "not a url", host: "app.kritvia.in" }), [])).toBe(false);
  });
  it("rejects a different port on the same host name", () => {
    expect(isSameOrigin(req("POST", { origin: "http://app.kritvia.in:8080", host: "app.kritvia.in" }), [])).toBe(false);
  });
  it("accepts explicitly trusted origins", () => {
    const r = req("POST", { origin: "https://admin.kritvia.in", host: "app.kritvia.in" });
    expect(isSameOrigin(r, ["https://admin.kritvia.in"])).toBe(true);
  });
});

describe("proxies that rewrite Origin (GitHub Codespaces)", () => {
  it("accepts an Origin matching the internal Host while X-Forwarded-Host is public", async () => {
    const { isSameOrigin } = await import("@/lib/bff/origin");
    const req = new Request("http://localhost:3000/api/auth/login", {
      method: "POST",
      headers: { origin: "http://localhost:3000", host: "localhost:3000", "x-forwarded-host": "abc-3000.app.github.dev" },
    });
    expect(isSameOrigin(req, [])).toBe(true);
  });
  it("still refuses a different site", async () => {
    const { isSameOrigin } = await import("@/lib/bff/origin");
    const req = new Request("http://localhost:3000/api/auth/login", {
      method: "POST",
      headers: { origin: "https://evil.example", host: "localhost:3000", "x-forwarded-host": "abc-3000.app.github.dev" },
    });
    expect(isSameOrigin(req, [])).toBe(false);
  });
});
