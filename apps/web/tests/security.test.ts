import { describe, expect, it } from "vitest";
import { safeNext } from "@/lib/auth-client";
import { normalisePath } from "@/lib/bff/proxy";

describe("post-login redirect", () => {
  it("keeps same-site paths", () => {
    expect(safeNext("/v/abc/board?tab=1#x")).toBe("/v/abc/board?tab=1#x");
    expect(safeNext(null)).toBe("/");
  });
  it("refuses anything that could leave the site", () => {
    for (const bad of ["//evil.com", "/\\evil.com", "/\t/evil.com", "/%09/evil.com".replace("%09", "\t"), "https://evil.com", "/\n/evil.com", " /x"]) {
      expect(safeNext(bad)).toBe("/");
    }
  });
});

describe("proxy path", () => {
  it("passes ordinary segments", () => {
    expect(normalisePath(["ventures", "abc", "board"])).toBe("ventures/abc/board");
    expect(normalisePath(["vocabulary", "kreet via"])).toBe("vocabulary/kreet%20via");
  });
  it("refuses traversal and double-encoded slashes", () => {
    expect(normalisePath(["auth%2Flogin"])).toBeNull();
    expect(normalisePath(["auth%252Flogin"])).toBeNull();
    expect(normalisePath([".."])).toBeNull();
    expect(normalisePath(["a\\b"])).toBeNull();
    expect(normalisePath([])).toBeNull();
  });
});

describe("proxy body limits", () => {
  it("is tight for anonymous posts and roomy for uploads", async () => {
    const { bodyLimit } = await import("@/lib/bff/proxy");
    expect(bodyLimit("public/support", true, false)).toBe(1024 * 1024);
    expect(bodyLimit("public/upload/tok", true, false)).toBe(60 * 1024 * 1024);
    expect(bodyLimit("ventures/x/knowledge/upload", false, true)).toBe(60 * 1024 * 1024);
    expect(bodyLimit("ventures/x/knowledge/upload", false, false)).toBe(64 * 1024);
  });
});
