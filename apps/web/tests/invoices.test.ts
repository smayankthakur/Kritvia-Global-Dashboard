import { describe, expect, it } from "vitest";
import { formProblem } from "@/components/invoices/invoice-dialog";
import { dueLabel, paiseToInput, reminderLabel, rupees, toPaise } from "@/components/invoices/money";
import { ventureNav } from "@/lib/nav";

const base = { status: "open" as const, due_on: "2026-10-20", overdue_days: 0, reminders_paused: false, reminders_sent: 0 };
const at = (iso: string) => new Date(`${iso}T06:00:00Z`);

describe("invoice money", () => {
  it("reads rupees the way people type them, into whole paise", () => {
    expect(toPaise("11800")).toBe(1180000);
    expect(toPaise("11,800.5")).toBe(1180050);
    expect(toPaise("₹ 1,18,000.75")).toBe(11800075);
    expect(toPaise("Rs. 500")).toBe(50000);
    expect(toPaise("0")).toBeNull();
    expect(toPaise("12.345")).toBeNull();
    expect(toPaise("abc")).toBeNull();
    expect(paiseToInput(1180050)).toBe("11800.50");
    expect(paiseToInput(1180000)).toBe("11800");
    expect(rupees(1180000)).toBe("₹11,800");
    expect(rupees(11800075)).toBe("₹1,18,000.75");
  });

  it("says when an invoice is due and what reminders are doing", () => {
    expect(dueLabel(base, at("2026-10-17"))).toEqual({ text: "Due in 3 days", tone: "warning" });
    expect(dueLabel(base, at("2026-10-01")).tone).toBe("neutral");
    expect(dueLabel(base, at("2026-10-20")).text).toBe("Due today");
    expect(dueLabel({ ...base, overdue_days: 1 })).toEqual({ text: "1 day overdue", tone: "danger" });
    expect(dueLabel({ ...base, status: "paid" }).text).toBe("Paid");
    expect(reminderLabel(base)).toBeNull();
    expect(reminderLabel({ ...base, reminders_sent: 2 })).toBe("2 reminders sent");
    expect(reminderLabel({ ...base, reminders_sent: 2, reminders_paused: true })).toBe("Reminders paused");
    expect(reminderLabel({ ...base, status: "paid", reminders_sent: 2 })).toBeNull();
    expect(reminderLabel({ ...base, customer_email: null, customer_phone: null })).toBe("No email or phone for reminders");
  });

  it("checks the form before saving", () => {
    const f = { number: "", customer_name: "Neha", customer_email: "", customer_phone: "", amount: "11800", issued_on: "2026-10-01", due_on: "2026-10-15", notes: "" };
    expect(formProblem(f)).toBeNull();
    expect(formProblem({ ...f, customer_name: " " })).toMatch(/Who/);
    expect(formProblem({ ...f, amount: "eleven" })).toMatch(/amount/);
    expect(formProblem({ ...f, due_on: "2026-09-01" })).toMatch(/before/);
    expect(formProblem({ ...f, customer_email: "neha@" })).toMatch(/email/);
  });

  it("is in every business's menu, after WhatsApp", () => {
    for (const kind of ["general", "software", "finance", "kitchen"] as const) {
      const labels = ventureNav("v1", kind).common.map((i) => i.label);
      expect(labels.indexOf("Invoices")).toBe(labels.indexOf("Chats") + 1);
    }
  });
});
