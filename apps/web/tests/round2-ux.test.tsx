import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { numberProblem } from "@/components/bookings/booking-setup";
import { discountPaise } from "@/components/invoices/gst-invoice-dialog";
import { fromInvoice, type Invoice } from "@/components/invoices/invoice-dialog";
import { ConfirmDialog } from "@/components/ui/dialog";
import { ToastProvider, useToast } from "@/components/ui/toast";
import { reviewKey } from "@/lib/reviews";

describe("test report round 2: owner-side fixes", () => {
  it("U1: a review's reply box follows the review, not its place in the list", () => {
    const a = { author: "Asha", when: "a week ago", text: "Lovely", reply: { id: "r-1", draft: "Thanks!", status: "drafted", can_post: true } };
    const b = { author: "Ravi", when: "2 days ago", text: "Good", reply: null };
    expect(reviewKey(a)).toBe("r-1");
    expect(reviewKey(b)).toBe("Ravi|2 days ago|Good");
    // the same review keeps its key wherever it moves in the list
    expect([b, a].map(reviewKey)).toEqual(["Ravi|2 days ago|Good", "r-1"]);
  });

  it("U8: a draft past its due date opens dated today and due a week later; an open invoice keeps its dates", () => {
    const base = { customer_name: "Asha", amount_paise: 100000, number: "", notes: null, customer_email: null, customer_phone: null } as unknown as Invoice;
    const draft = fromInvoice({ ...base, status: "draft", issued_on: "2026-10-01", due_on: "2026-10-08" } as Invoice, "2026-10-23", "2026-10-30");
    expect(draft.issued_on).toBe("2026-10-23");
    expect(draft.due_on).toBe("2026-10-30");
    const fresh = fromInvoice({ ...base, status: "draft", issued_on: "2026-10-20", due_on: "2026-10-27" } as Invoice, "2026-10-23", "2026-10-30");
    expect(fresh.due_on).toBe("2026-10-27");
    const open = fromInvoice({ ...base, status: "open", issued_on: "2026-10-01", due_on: "2026-10-08" } as Invoice, "2026-10-23", "2026-10-30");
    expect([open.issued_on, open.due_on]).toEqual(["2026-10-01", "2026-10-08"]);
  });

  it("U2: a GST invoice discount can be rupees or a percentage, and nothing else is silently dropped", () => {
    expect(discountPaise({ qty: "2", rate: "500", discount: "10%" })).toBe(10000);
    expect(discountPaise({ qty: "1", rate: "1,000", discount: "₹150/-" })).toBe(15000);
    expect(discountPaise({ qty: "1", rate: "1000", discount: "" })).toBe(0);
    expect(discountPaise({ qty: "1", rate: "1000", discount: "abc" })).toBeNull();
    expect(discountPaise({ qty: "1", rate: "1000", discount: "120%" })).toBeNull();
  });

  it("U14: booking numbers are checked on save, not forced while typing", () => {
    expect(numberProblem("capacity", "")).toMatch(/1 to 50/);
    expect(numberProblem("capacity", "3")).toBe(3);
    expect(numberProblem("days_ahead", "147")).toMatch(/1 to 90/);
    expect(numberProblem("notice_hours", "0")).toBe(0);
  });

  it("U19: the type-to-confirm word works whatever the phone capitalises", () => {
    const onConfirm = vi.fn();
    render(<ConfirmDialog open onClose={() => undefined} onConfirm={onConfirm} title="Delete everything?" typeToConfirm="DELETE" confirmLabel="Delete" />);
    const box = screen.getByLabelText(/to confirm/);
    expect(box.getAttribute("autocapitalize")).toBe("characters");
    fireEvent.change(box, { target: { value: "Delete" } });
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(onConfirm).toHaveBeenCalled();
  });

  it("U3/U10: a one-tap action offers Undo on its toast", () => {
    const undo = vi.fn();
    function Fire() {
      const t = useToast();
      return <button onClick={() => t.success("Marked paid", "Sharma Traders: ₹12,400", { label: "Undo", onClick: undo })}>go</button>;
    }
    render(
      <ToastProvider>
        <Fire />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText("go"));
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(undo).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Marked paid")).toBeNull();
  });
});
