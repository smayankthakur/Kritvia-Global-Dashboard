import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
const patch = vi.fn();
const put = vi.fn();
vi.mock("@/lib/api", async (orig) => {
  const real = await orig<typeof import("@/lib/api")>();
  return {
    ...real,
    api: { ...real.api, GET: (...a: unknown[]) => get(...a), PATCH: (...a: unknown[]) => patch(...a), PUT: (...a: unknown[]) => put(...a) },
  };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }) }));

import { WorkflowSettings } from "@/components/settings/workflows";
import { AnswerFactsSwitch } from "@/components/whatsapp/answer-facts";
import { AutoReplySwitch } from "@/components/whatsapp/auto-reply";
import { ToastProvider } from "@/components/ui/toast";

const ok = (data: unknown) => Promise.resolve({ data, response: new Response(JSON.stringify(data), { status: 200 }) });

const workflow = (name: string, title: string, venture_kinds: string[], options: unknown[] = []) => ({
  name,
  title,
  description: `${title} does its job.`,
  trigger: "When something arrives",
  starts: "event",
  steps: [{ name: "work" }],
  options,
  venture_kinds,
});
const CATALOGUE = [
  workflow("inbox_assistant", "Inbox assistant", ["general", "software", "finance", "kitchen", "trade"], [
    { key: "auto_reply", label: "Reply by itself", type: "boolean", default: false },
    { key: "answer_facts", label: "Answer facts", type: "boolean", default: false },
  ]),
  workflow("prospector", "Prospector", ["software", "general", "trade"], [{ key: "searches", label: "Google Maps searches", type: "text", default: "" }]),
  workflow("kitchen_daily", "Kitchen daily plan", ["kitchen", "general"]),
];

let configs: Record<string, unknown>[] = [];

function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>{ui}</ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  configs = [
    { workflow: "inbox_assistant", enabled: true, instructions: "Reply in Hinglish", settings: {}, schedule: null, updated_at: "2026-10-20T10:00:00Z" },
    { workflow: "prospector", enabled: true, instructions: "", settings: {}, schedule: "10:30", updated_at: "2026-10-20T10:00:00Z" },
  ];
  get.mockReset().mockImplementation((path: string) => (path === "/workflows" ? ok(CATALOGUE) : ok(configs)));
  patch.mockReset();
  put.mockReset();
  window.location.hash = "";
});

describe("Agents page (round 3, A2, A4, A20)", () => {
  it("is a compact list, with agents for other businesses folded under More agents", async () => {
    wrap(<WorkflowSettings ventureId="v1" kind="general" canAdmin />);
    const main = await screen.findByRole("list", { name: "Agents for this business" });
    expect(within(main).getByText("Inbox assistant")).toBeInTheDocument();
    expect(within(main).queryByText("Kitchen daily plan")).not.toBeInTheDocument();
    // Forms start folded.
    expect(screen.queryByLabelText("Instructions for this agent")).not.toBeInTheDocument();
    const more = screen.getByRole("button", { name: /More agents/ });
    expect(more).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(more);
    expect(within(screen.getByRole("list", { name: "More agents" })).getByText("Kitchen daily plan")).toBeVisible();
  });

  it("the switch saves at once, sending only on or off", async () => {
    patch.mockImplementation(() => ok({ ...configs[0], enabled: false }));
    wrap(<WorkflowSettings ventureId="v1" kind="general" canAdmin />);
    await userEvent.click(await screen.findByRole("switch", { name: "Inbox assistant on or off" }));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(patch.mock.calls[0]![1]).toEqual({ params: { path: { venture_id: "v1", workflow: "inbox_assistant" } }, body: { enabled: false } });
    expect(put).not.toHaveBeenCalled();
  });

  it("shows Unsaved changes with Save and Discard while a form has edits", async () => {
    put.mockImplementation((_p: string, init: { body: Record<string, unknown> }) => ok({ ...configs[0], ...init.body }));
    wrap(<WorkflowSettings ventureId="v1" kind="general" canAdmin />);
    const row = (await screen.findByText("Inbox assistant")).closest("li")!;
    await userEvent.click(within(row).getByRole("button", { name: "Configure" }));
    const box = within(row).getByLabelText("Instructions for this agent");
    expect(within(row).queryByText("Unsaved changes")).not.toBeInTheDocument();
    await userEvent.type(box, " please");
    expect(within(row).getByText("Unsaved changes")).toBeInTheDocument();
    await userEvent.click(within(row).getByRole("button", { name: "Discard" }));
    expect(box).toHaveValue("Reply in Hinglish");
    expect(within(row).queryByText("Unsaved changes")).not.toBeInTheDocument();

    await userEvent.type(box, "!");
    await userEvent.click(within(row).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    // Save keeps the switch as it is.
    expect(put.mock.calls[0]![1].body).toMatchObject({ enabled: true, instructions: "Reply in Hinglish!" });
  });

  it("opens the agent a link names", async () => {
    window.location.hash = "#agent-prospector";
    wrap(<WorkflowSettings ventureId="v1" kind="general" canAdmin />);
    const row = (await screen.findByText("Prospector")).closest("li")!;
    expect(await within(row).findByLabelText("Instructions for this agent")).toBeInTheDocument();
  });

  it("Find leads now waits for a saved search", async () => {
    window.location.hash = "#agent-prospector";
    wrap(<WorkflowSettings ventureId="v1" kind="general" canAdmin />);
    const row = (await screen.findByText("Prospector")).closest("li")!;
    expect(await within(row).findByRole("button", { name: "Find leads now" })).toBeDisabled();
    expect(within(row).getByText("Add a search first")).toBeInTheDocument();
  });
});

describe("Chats page switches (round 3, B11)", () => {
  it("each switch sends only its own setting, and both wait while either saves", async () => {
    let finish: (v: unknown) => void = () => undefined;
    patch.mockImplementation(() => new Promise((r) => (finish = r)));
    wrap(
      <>
        <AutoReplySwitch ventureId="v1" canAdmin />
        <AnswerFactsSwitch ventureId="v1" canAdmin />
      </>,
    );
    const auto = await screen.findByRole("switch", { name: "Reply to every customer message by itself" });
    const facts = screen.getByRole("switch", { name: "Answer customers' questions about their own records by themselves" });
    await userEvent.click(auto);
    expect(patch.mock.calls[0]![1].body).toEqual({ settings: { auto_reply: true } });
    await waitFor(() => expect(facts).toBeDisabled());
    expect(auto).toBeDisabled();
    finish({ data: { ...configs[0], settings: { auto_reply: true } }, response: new Response("{}", { status: 200 }) });
    await waitFor(() => expect(facts).toBeEnabled());
  });
});
