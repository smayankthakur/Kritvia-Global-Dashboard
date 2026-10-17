import { describe, expect, it } from "vitest";
import { amountInWords, fileKind, minorToInput, money, numberToWords, toMinor } from "@/lib/trade";

describe("trade money", () => {
  it("reads typed amounts in the currency's minor units", () => {
    expect(toMinor("12,500.5", "USD")).toBe(1250050);
    expect(toMinor("USD 1150", "USD")).toBe(115000);
    expect(toMinor("5000", "JPY")).toBe(5000);
    expect(toMinor("5000.5", "JPY")).toBeNull();
    expect(toMinor("1.234", "KWD")).toBe(1234);
    expect(toMinor("abc", "USD")).toBeNull();
    expect(minorToInput(1250050, "USD")).toBe("12500.5");
    expect(minorToInput(115000, "USD")).toBe("1150");
  });

  it("formats and spells amounts for export invoices", () => {
    expect(money(5625083, "USD")).toBe("USD 56,250.83");
    expect(numberToWords(1234567)).toBe("One Million Two Hundred Thirty-Four Thousand Five Hundred Sixty-Seven");
    expect(amountInWords(5625083, "USD")).toBe("US Dollars Fifty-Six Thousand Two Hundred Fifty and Cents Eighty-Three Only");
    expect(amountInWords(100000, "AED")).toBe("UAE Dirhams One Thousand Only");
    expect(amountInWords(7000, "JPY")).toBe("Japanese Yen Seven Thousand Only");
  });

  it("names the kind of file", () => {
    expect(fileKind("export", false)).toBe("export");
    expect(fileKind("import", true)).toBe("job_import");
  });
});
