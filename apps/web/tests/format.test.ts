import { describe, expect, it } from "vitest";
import {
  formatDate,
  formatDateTime,
  formatDuration,
  formatHours,
  formatINR,
  formatNumber,
  formatRelative,
  formatTimestamp,
  fromISTInput,
  istDate,
  toISTInput,
} from "@/lib/format";

describe("formatINR", () => {
  it("uses Indian digit grouping with two decimals", () => {
    expect(formatINR(295000)).toBe("₹2,95,000.00");
    expect(formatINR(12345678.5)).toBe("₹1,23,45,678.50");
    expect(formatINR(999)).toBe("₹999.00");
  });
  it("accepts API decimal strings", () => {
    expect(formatINR("295000.00")).toBe("₹2,95,000.00");
    expect(formatINR("1,50,000")).toBe("₹1,50,000.00");
  });
  it("can drop paise", () => {
    expect(formatINR(2500000, { whole: true })).toBe("₹25,00,000");
  });
  it("renders missing values as a dash", () => {
    expect(formatINR(null)).toBe("—");
    expect(formatINR(undefined)).toBe("—");
    expect(formatINR("")).toBe("—");
    expect(formatINR("abc")).toBe("—");
  });
});

describe("formatNumber", () => {
  it("groups the Indian way", () => {
    expect(formatNumber(1234567)).toBe("12,34,567");
    expect(formatNumber("12.345")).toBe("12.35");
  });
});

describe("IST dates", () => {
  it("formats instants in Asia/Kolkata regardless of the machine time zone", () => {
    // 15:35 UTC = 21:05 IST
    expect(formatDateTime("2026-09-30T15:35:00Z")).toBe("30 Sep 2026, 21:05 IST");
    // 20:00 UTC on the 30th is already 1 Oct in India
    expect(formatDate("2026-09-30T20:00:00Z")).toBe("01 Oct 2026");
  });
  it("treats plain dates as calendar dates", () => {
    expect(formatDate("2026-10-01")).toBe("01 Oct 2026");
  });
  it("round-trips datetime-local values as IST", () => {
    expect(toISTInput("2026-10-02T05:30:00Z")).toBe("2026-10-02T11:00");
    expect(toISTInput("2026-10-02T11:00:00+05:30")).toBe("2026-10-02T11:00");
    expect(fromISTInput("2026-10-02T11:30")).toBe("2026-10-02T11:30:00+05:30");
    expect(new Date(fromISTInput("2026-10-02T11:30")).toISOString()).toBe("2026-10-02T06:00:00.000Z");
    expect(fromISTInput("not a date")).toBe("not a date");
  });
  it("computes today/tomorrow in IST", () => {
    const now = new Date("2026-09-30T19:00:00Z"); // 00:30 IST on 1 Oct
    expect(istDate(0, now)).toBe("2026-10-01");
    expect(istDate(1, now)).toBe("2026-10-02");
  });
  it("formats relative times", () => {
    const now = new Date("2026-09-30T12:00:00Z");
    expect(formatRelative("2026-09-30T11:59:50Z", now)).toBe("just now");
    expect(formatRelative("2026-09-30T11:30:00Z", now)).toBe("30 min ago");
    expect(formatRelative("2026-09-30T09:00:00Z", now)).toBe("3 h ago");
    expect(formatRelative("2026-09-28T12:00:00Z", now)).toBe("2 d ago");
    expect(formatRelative("2026-10-01T12:00:00Z", now)).toBe("in 1 d");
  });
});

describe("durations", () => {
  it("formats step durations, hours and transcript timestamps", () => {
    expect(formatDuration(420)).toBe("420 ms");
    expect(formatDuration(2500)).toBe("2.5 s");
    expect(formatDuration(125_000)).toBe("2 m 5 s");
    expect(formatHours(0.5)).toBe("30 min");
    expect(formatHours(5.25)).toBe("5.3 h");
    expect(formatHours(72)).toBe("3.0 d");
    expect(formatTimestamp(75.4)).toBe("1:15");
    expect(formatTimestamp(3725)).toBe("1:02:05");
  });
});
