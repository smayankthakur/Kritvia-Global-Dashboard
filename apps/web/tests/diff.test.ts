import { describe, expect, it } from "vitest";
import { buildEditedPayload, deepEqual, diffLines, diffPayload, parseUnified } from "@/lib/diff";

describe("diffLines", () => {
  it("marks removed and added lines around common ones", () => {
    const d = diffLines("Hi Asha,\nPrice: 2 lakh\nThanks", "Hi Asha,\nPrice: 1.8 lakh\nThanks");
    expect(d).toEqual([
      { type: "same", text: "Hi Asha," },
      { type: "del", text: "Price: 2 lakh" },
      { type: "add", text: "Price: 1.8 lakh" },
      { type: "same", text: "Thanks" },
    ]);
  });
  it("handles pure additions and deletions", () => {
    expect(diffLines("a", "a\nb")).toEqual([
      { type: "same", text: "a" },
      { type: "add", text: "b" },
    ]);
    expect(diffLines("a\nb", "b")).toEqual([
      { type: "del", text: "a" },
      { type: "same", text: "b" },
    ]);
  });
});

describe("diffPayload", () => {
  const draft = { to: "asha@example.com", subject: "Proposal", body: "Line 1\nLine 2", attendees: ["a@x.in"], thread_id: null };

  it("returns nothing when nothing changed", () => {
    expect(diffPayload(draft, { ...draft })).toEqual([]);
    expect(diffPayload(draft, null)).toEqual([]);
  });

  it("reports changed fields with line diffs for strings", () => {
    const out = diffPayload(draft, { ...draft, subject: "Proposal v2", body: "Line 1\nLine 2b" });
    expect(out.map((d) => d.field)).toEqual(["subject", "body"]);
    expect(out[1]!.lines).toContainEqual({ type: "add", text: "Line 2b" });
    expect(out[1]!.lines).toContainEqual({ type: "del", text: "Line 2" });
  });

  it("compares arrays by value and ignores keys the draft doesn't have", () => {
    const out = diffPayload(draft, { ...draft, attendees: ["a@x.in", "b@x.in"], extra: "ignored" } as never);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ field: "attendees", lines: null, after: ["a@x.in", "b@x.in"] });
  });
});

describe("buildEditedPayload", () => {
  it("keeps the same keys and original types", () => {
    const original = { to: "a@x.in", attendees: ["a@x.in"], minutes: 30, thread_id: null };
    const out = buildEditedPayload(original, { attendees: "a@x.in, b@x.in\nc@x.in", minutes: "45", unknown: "x" });
    expect(out).toEqual({ to: "a@x.in", attendees: ["a@x.in", "b@x.in", "c@x.in"], minutes: 45, thread_id: null });
    expect(Object.keys(out)).toEqual(Object.keys(original));
  });
  it("keeps the original number when the edit is not numeric", () => {
    expect(buildEditedPayload({ n: 3 }, { n: "abc" })).toEqual({ n: 3 });
  });
});

describe("parseUnified", () => {
  it("parses the API's unified diff, dropping headers", () => {
    const u = "--- draft\n+++ approved\n@@ -1,2 +1,2 @@\n Hi\n-old\n+new";
    expect(parseUnified(u)).toEqual([
      { type: "same", text: "Hi" },
      { type: "del", text: "old" },
      { type: "add", text: "new" },
    ]);
  });
});

describe("deepEqual", () => {
  it("compares nested structures", () => {
    expect(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
    expect(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 3 }] })).toBe(false);
    expect(deepEqual([1], { 0: 1 })).toBe(false);
  });
});
