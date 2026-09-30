import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ApprovalDetail, type Approval, type Decision } from "@/components/approvals/approval-detail";
import { ApiError } from "@/lib/api";
import { emailApproval, inviteApproval } from "./fixtures/approvals";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

function decided(a: Approval, body: Decision): Approval {
  const final = body.edited_payload ?? null;
  return {
    ...a,
    status: body.decision === "reject" ? "rejected" : final ? "edited" : "approved",
    final_payload: final,
    comment: body.comment ?? null,
    decided_by_email: "mayank@sitelytc.com",
    decided_at: "2026-09-30T07:00:00Z",
    diff: final
      ? Object.keys(a.payload ?? {})
          .filter((k) => JSON.stringify(final[k]) !== JSON.stringify((a.payload ?? {})[k]))
          .map((k) => ({ field: k, before: (a.payload ?? {})[k], after: final[k], unified: null }))
      : [],
  };
}

describe("ApprovalDetail", () => {
  it("renders an email draft: recipient, subject and a readable body with the pricing table", () => {
    render(<ApprovalDetail approval={emailApproval} onDecide={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "Send proposal to Rao Foods" })).toBeInTheDocument();
    expect(screen.getByText("asha@raofoods.example")).toBeInTheDocument();
    expect(screen.getByText("Proposal: Next.js website + WhatsApp ordering")).toBeInTheDocument();
    const table = screen.getByRole("table");
    expect(within(table).getByRole("cell", { name: "₹2,00,000" })).toBeInTheDocument();
    expect(screen.getByText("approver or venture_admin")).toBeInTheDocument();
  });

  it("approves as drafted without an edited payload", async () => {
    const onDecide = vi.fn(async (b: Decision) => decided(emailApproval, b));
    render(<ApprovalDetail approval={emailApproval} onDecide={onDecide} />);
    await userEvent.click(screen.getByRole("button", { name: "Approve & send" }));
    expect(onDecide).toHaveBeenCalledWith({ decision: "approve" });
    expect(await screen.findByText("Decision recorded: approved")).toBeInTheDocument();
  });

  it("edit → diff preview → approve sends the full payload with the same keys", async () => {
    const onDecide = vi.fn(async (b: Decision) => decided(emailApproval, b));
    render(<ApprovalDetail approval={emailApproval} onDecide={onDecide} />);
    await userEvent.click(screen.getByRole("button", { name: "Edit" }));

    const subject = screen.getByLabelText("Subject");
    await userEvent.clear(subject);
    await userEvent.type(subject, "Proposal v2");
    const body = screen.getByLabelText("Body") as HTMLTextAreaElement;
    fireEvent.change(body, { target: { value: body.value.replace("Regards,", "Warm regards,") } });
    // thread_id is null (not editable), so it must not get a field
    expect(screen.queryByLabelText("Thread Id")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Review changes" }));
    const review = screen.getByRole("region", { name: "Review changes" });
    expect(within(review).getByText("Proposal v2")).toBeInTheDocument();
    expect(within(review).getByText("Warm regards,")).toBeInTheDocument();
    expect(within(review).getByText("Regards,")).toBeInTheDocument();
    expect(onDecide).not.toHaveBeenCalled();

    await userEvent.type(within(review).getByLabelText("Note for the record (optional)"), "Softer sign-off");
    await userEvent.click(screen.getByRole("button", { name: "Approve with edits" }));

    expect(onDecide).toHaveBeenCalledTimes(1);
    const sent = onDecide.mock.calls[0]![0];
    expect(sent.decision).toBe("approve");
    expect(sent.comment).toBe("Softer sign-off");
    expect(Object.keys(sent.edited_payload!)).toEqual(Object.keys(emailApproval.payload!));
    expect(sent.edited_payload).toEqual({
      ...emailApproval.payload,
      subject: "Proposal v2",
      body: (emailApproval.payload!.body as string).replace("Regards,", "Warm regards,"),
    });

    expect(await screen.findByText("Decision recorded: edited")).toBeInTheDocument();
    expect(screen.getByText("What you changed")).toBeInTheDocument();
  });

  it("reviewing without changes approves without an edited payload", async () => {
    const onDecide = vi.fn(async (b: Decision) => decided(emailApproval, b));
    render(<ApprovalDetail approval={emailApproval} onDecide={onDecide} />);
    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    await userEvent.click(screen.getByRole("button", { name: "Review changes" }));
    expect(screen.getByText(/No changes/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(onDecide).toHaveBeenCalledWith({ decision: "approve", edited_payload: null, comment: null });
  });

  it("validates the recipient before review", async () => {
    render(<ApprovalDetail approval={emailApproval} onDecide={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    const to = screen.getByLabelText("To");
    await userEvent.clear(to);
    await userEvent.type(to, "not-an-email");
    await userEvent.click(screen.getByRole("button", { name: "Review changes" }));
    expect(screen.getByText("Recipient must be an email address")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Review changes" })).not.toBeInTheDocument();
  });

  it("edits calendar times in IST and attendees as a list", async () => {
    const onDecide = vi.fn(async (b: Decision) => decided(inviteApproval, b));
    render(<ApprovalDetail approval={inviteApproval} onDecide={onDecide} />);
    expect(screen.getByText(/02 Oct 2026, 11:00 IST/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    const start = screen.getByLabelText("Starts") as HTMLInputElement;
    expect(start.type).toBe("datetime-local");
    expect(start.value).toBe("2026-10-02T11:00");
    fireEvent.change(start, { target: { value: "2026-10-02T15:00" } });
    fireEvent.change(screen.getByLabelText("Ends"), { target: { value: "2026-10-02T15:30" } });
    const attendees = screen.getByLabelText("Attendees");
    await userEvent.clear(attendees);
    await userEvent.type(attendees, "asha@raofoods.example, ravi@raofoods.example");
    await userEvent.click(screen.getByRole("button", { name: "Review changes" }));
    await userEvent.click(screen.getByRole("button", { name: "Approve with edits" }));
    const sent = onDecide.mock.calls[0]![0];
    expect(sent.edited_payload).toEqual({
      ...inviteApproval.payload,
      start: "2026-10-02T15:00:00+05:30",
      end: "2026-10-02T15:30:00+05:30",
      attendees: ["asha@raofoods.example", "ravi@raofoods.example"],
    });
  });

  it("rejects end before start", async () => {
    render(<ApprovalDetail approval={inviteApproval} onDecide={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Ends"), { target: { value: "2026-10-02T10:00" } });
    await userEvent.click(screen.getByRole("button", { name: "Review changes" }));
    expect(screen.getByText("End must be after start")).toBeInTheDocument();
  });

  it("requires feedback to reject, then sends it", async () => {
    const onDecide = vi.fn(async (b: Decision) => decided(emailApproval, b));
    render(<ApprovalDetail approval={emailApproval} onDecide={onDecide} />);
    await userEvent.click(screen.getByRole("button", { name: "Reject" }));
    await userEvent.click(screen.getByRole("button", { name: "Reject draft" }));
    expect(screen.getByText(/Add a short reason/)).toBeInTheDocument();
    expect(onDecide).not.toHaveBeenCalled();
    await userEvent.type(screen.getByLabelText("Feedback"), "Quote the fixed-price package");
    await userEvent.click(screen.getByRole("button", { name: "Reject draft" }));
    expect(onDecide).toHaveBeenCalledWith({ decision: "reject", comment: "Quote the fixed-price package" });
    await waitFor(() => expect(screen.getByText("Decision recorded: rejected")).toBeInTheDocument());
  });

  it("explains a missing role and disables actions", () => {
    render(<ApprovalDetail approval={{ ...emailApproval, can_decide: false, sensitive: true, required_roles: ["loan_officer"] }} onDecide={vi.fn()} />);
    expect(screen.getByText("You can view this draft but not decide it")).toBeInTheDocument();
    expect(screen.getByText(/Deciding needs the loan officer role/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve & send" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Edit" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reject" })).toBeDisabled();
    expect(screen.getByText("Sensitive")).toBeInTheDocument();
  });

  it("handles a 409 when someone else already decided", async () => {
    const onConflict = vi.fn();
    const onDecide = vi.fn(async () => {
      throw new ApiError(409, "approval already decided");
    });
    render(<ApprovalDetail approval={emailApproval} onDecide={onDecide} onConflict={onConflict} />);
    await userEvent.click(screen.getByRole("button", { name: "Approve & send" }));
    expect(await screen.findByText(/Already decided: approval already decided/)).toBeInTheDocument();
    expect(onConflict).toHaveBeenCalled();
  });

  it("shows the server's unified diff after an edited approval", () => {
    const done: Approval = {
      ...emailApproval,
      status: "edited",
      decided_by_email: "mayank@sitelytc.com",
      decided_at: "2026-09-30T07:00:00Z",
      final_payload: { ...emailApproval.payload, subject: "New" },
      diff: [{ field: "body", before: "a", after: "b", unified: "--- draft\n+++ approved\n@@ -1 +1 @@\n-old line\n+new line" }],
    };
    render(<ApprovalDetail approval={done} onDecide={vi.fn()} />);
    expect(screen.getByText("Decision recorded: edited")).toBeInTheDocument();
    expect(screen.getByText("old line")).toBeInTheDocument();
    expect(screen.getByText("new line")).toBeInTheDocument();
  });
});
