import { describe, expect, it } from "vitest";
import { OUTCOME, duration } from "@/components/calls/calls";
import { ventureNav } from "@/lib/nav";

describe("phone calls", () => {
  it("says how long a call took", () => {
    expect(duration(74)).toBe("1 min 14 s");
    expect(duration(9)).toBe("9 s");
    expect(duration(null)).toBe("");
  });

  it("names every outcome", () => {
    for (const o of ["answered", "message_taken", "booking_requested", "transferred", "opted_out", "hung_up", "no_input", "too_long", "ended"]) {
      expect(OUTCOME[o]).toBeTruthy();
    }
  });

  it("is in every business's menu, after the browser agent", () => {
    const labels = ventureNav("v1", "general").common.map((i) => i.label);
    expect(labels.indexOf("Calls")).toBe(labels.indexOf("Browser") + 1);
  });
});
