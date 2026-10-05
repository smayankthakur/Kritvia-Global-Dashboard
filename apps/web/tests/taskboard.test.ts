import { describe, expect, it } from "vitest";
import { checklistProgress, dueState, initials, moveInColumns, positionBetween, positionInColumn } from "@/lib/taskboard";

describe("task board helpers", () => {
  it("places a dropped card between its neighbours", () => {
    expect(positionBetween(undefined, undefined)).toBe(1024);
    expect(positionBetween(undefined, 1024)).toBe(512);
    expect(positionBetween(2048, undefined)).toBe(3072);
    expect(positionBetween(1024, 2048)).toBe(1536);
  });

  it("moves a card across lists without touching the input", () => {
    const cols = { a: ["1", "2", "3"], b: ["4"] };
    const next = moveInColumns(cols, "2", "b", 0);
    expect(next).toEqual({ a: ["1", "3"], b: ["2", "4"] });
    expect(cols.a).toEqual(["1", "2", "3"]);
    expect(moveInColumns(cols, "9", "b", 0)).toBe(cols);
    expect(moveInColumns(cols, "1", "b", 99).b).toEqual(["4", "1"]);
  });

  it("works out a server position from the new order", () => {
    const pos: Record<string, number> = { x: 1024, y: 2048, z: 3072 };
    expect(positionInColumn(["x", "new", "y"], "new", (id) => pos[id])).toBe(1536);
    expect(positionInColumn(["new", "x"], "new", (id) => pos[id])).toBe(512);
    expect(positionInColumn(["z", "new"], "new", (id) => pos[id])).toBe(4096);
  });

  it("reads due dates like Trello", () => {
    expect(dueState(null, false, "2026-10-05")).toBeNull();
    expect(dueState("2026-10-01", false, "2026-10-05")).toBe("overdue");
    expect(dueState("2026-10-01", true, "2026-10-05")).toBe("done");
    expect(dueState("2026-10-06", false, "2026-10-05")).toBe("soon");
    expect(dueState("2026-10-20", false, "2026-10-05")).toBe("later");
  });

  it("shows initials and checklist progress", () => {
    expect(initials("Mayank Thakur")).toBe("MT");
    expect(initials("", "priya@example.com")).toBe("PE");
    expect(checklistProgress([{ id: "a", text: "x", done: true }, { id: "b", text: "y", done: false }])).toEqual({ done: 1, total: 2, pct: 50 });
    expect(checklistProgress([]).pct).toBe(0);
  });
});
