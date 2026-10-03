import { describe, expect, it } from "vitest";
import { forceLayout } from "@/lib/force-layout";

describe("forceLayout", () => {
  it("is deterministic, finite, keeps the pinned node at the centre and linked nodes closer", () => {
    const nodes = ["a", "b", "c", "d", "e"].map((id) => ({ id }));
    const links = [{ source: "a", target: "b" }, { source: "a", target: "c" }];
    const p1 = forceLayout(nodes, links, 200, "a");
    const p2 = forceLayout(nodes, links, 200, "a");
    expect(p1).toEqual(p2);
    expect(p1.a).toEqual({ x: 0, y: 0 });
    for (const v of Object.values(p1)) expect(Number.isFinite(v.x) && Number.isFinite(v.y)).toBe(true);
    const dist = (u: string, w: string) => Math.hypot(p1[u]!.x - p1[w]!.x, p1[u]!.y - p1[w]!.y);
    expect(dist("a", "b")).toBeLessThan(dist("a", "d"));
  });

  it("handles empty and single-node graphs", () => {
    expect(forceLayout([], [])).toEqual({});
    const one = forceLayout([{ id: "x" }], []);
    expect(Number.isFinite(one.x!.x)).toBe(true);
  });
});
