import { describe, expect, it } from "vitest";
import { lineTax, qtyMilli } from "@/components/invoices/gst-math";

// The same cases as the server's test_gst.py, so the live totals match the issued invoice.
describe("GST line arithmetic", () => {
  it("rounds each half of the tax half-up within a state", () => {
    expect(lineTax("3", 33333, 1000, "18", true)).toEqual({ taxable: 98999, cgst: 8910, sgst: 8910, igst: 0 });
  });
  it("uses IGST across states and rounds fractional quantities", () => {
    expect(lineTax("1.5", 100001, 0, "5", false)).toEqual({ taxable: 150002, cgst: 0, sgst: 0, igst: 7500 });
    expect(lineTax("2", 150050, 0, "5", true)).toEqual({ taxable: 300100, cgst: 7503, sgst: 7503, igst: 0 });
  });
  it("never goes below zero and refuses bad quantities", () => {
    expect(lineTax("1", 100, 500, "18", true)?.taxable).toBe(0);
    expect(qtyMilli("abc")).toBeNull();
    expect(qtyMilli("0")).toBeNull();
    expect(qtyMilli("1.2345")).toBeNull();
  });
});
