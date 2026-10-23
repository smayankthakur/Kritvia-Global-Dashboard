import path from "node:path";
import { describe, expect, it } from "vitest";
import dict from "@/lib/i18n/hi.json";
import { translateString } from "@/lib/i18n/translate";
import ignore from "./i18n-ignore.json";
import { filesUnder, stringsIn } from "./helpers/ui-strings";

const ROOT = path.resolve(__dirname, "..");
const hi = dict as Record<string, string>;
const skipFiles = new Set(ignore.files);
const skipStrings = new Set(ignore.strings);

/** Screens an owner uses for money, staff, bookings, marketing and setup, and the customer's pay page:
 * every word on them has Hindi (test report round 2, U5). */
const COVERED = [
  "components/money",
  "components/people",
  "components/bookings",
  "components/marketing",
  "components/invoices",
  "components/settings/connectors.tsx",
  "app/pay",
  "app/(app)/v/[ventureId]/invoices",
  "app/(app)/v/[ventureId]/bookings",
  "app/(app)/v/[ventureId]/money",
  "app/(app)/v/[ventureId]/people",
  "app/(app)/v/[ventureId]/marketing",
  "app/(app)/v/[ventureId]/reviews",
];

function missing(file: string): string[] {
  return [...stringsIn(file)].filter((s) => !skipStrings.has(s) && translateString(hi, s) === null);
}

describe("Hindi interface coverage (U5)", () => {
  it("every interface string on the covered screens has a Hindi translation", () => {
    const gaps: string[] = [];
    for (const dir of COVERED)
      for (const f of filesUnder(path.join(ROOT, dir))) {
        const rel = path.relative(ROOT, f);
        if (!skipFiles.has(rel)) for (const s of missing(f)) gaps.push(`${rel}: ${s}`);
      }
    expect(gaps, "add these to lib/i18n/hi.json (or tests/i18n-ignore.json if they must stay as written)").toEqual([]);
  });

  it("the rest of the app only gains Hindi, never loses it", () => {
    let n = 0;
    for (const dir of ["components", "app"])
      for (const f of filesUnder(path.join(ROOT, dir))) {
        const rel = path.relative(ROOT, f);
        if (COVERED.some((c) => rel === c || rel.startsWith(`${c}/`)) || skipFiles.has(rel)) continue;
        n += missing(f).length;
      }
    expect(n, `untranslated strings outside the covered screens: lower outsideScopeMissing to ${n} when it drops`).toBeLessThanOrEqual(ignore.outsideScopeMissing);
  });
});
