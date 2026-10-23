import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isPrivatePath, isPublicPath } from "@/middleware";

const APP = path.resolve(__dirname, "../app");
const dirs = (d: string) => readdirSync(d).filter((n) => statSync(path.join(d, n)).isDirectory());

describe("which addresses need a sign-in (U24)", () => {
  it("every page in the app is either public or behind sign-in", () => {
    const top = dirs(APP).filter((n) => !n.startsWith("(") && n !== "api");
    const signedIn = dirs(path.join(APP, "(app)"));
    const open = [...dirs(path.join(APP, "(public)")), ...dirs(path.join(APP, "(auth)"))];
    for (const n of signedIn) expect(isPrivatePath(`/${n}`), `/${n}`).toBe(true);
    for (const n of open) expect(isPublicPath(`/${n}`), `/${n}`).toBe(true);
    for (const n of top) expect(isPublicPath(`/${n}/x`) || isPrivatePath(`/${n}/x`) || isPublicPath(`/${n}`), `/${n}`).toBe(true);
  });
  it("a mistyped public address is a 404, not a sign-in prompt", () => {
    for (const p of ["/feature", "/pricing", "/about-us", "/contact"]) {
      expect(isPublicPath(p)).toBe(false);
      expect(isPrivatePath(p)).toBe(false);
    }
  });
  it("signed-in areas still send visitors to sign in", () => {
    for (const p of ["/", "/inbox", "/v/123/leads", "/onboarding", "/invite/abc", "/settings/connectors", "/print/invoice/a/b"]) expect(isPrivatePath(p)).toBe(true);
    // a prefix is a whole segment: /vacancies isn't /v
    expect(isPrivatePath("/vacancies")).toBe(false);
  });
});
