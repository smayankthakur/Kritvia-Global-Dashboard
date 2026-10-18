import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const post = vi.fn();
vi.mock("@/lib/api", async (orig) => {
  const real = await orig<typeof import("@/lib/api")>();
  return { ...real, api: { ...real.api, POST: (...a: unknown[]) => post(...a) } };
});

import { TestCall } from "@/components/calls/calls";
import { ToastProvider } from "@/components/ui/toast";

const ok = (data: unknown) => Promise.resolve({ data, response: new Response(JSON.stringify(data), { status: 200 }) });

describe("Try a call", () => {
  const original = Element.prototype.scrollIntoView;
  beforeEach(() => {
    // Newer Chrome returns a Promise from scrollIntoView(); the live Calls page crashed on the second reply
    // ("u is not a function") because an effect returned that Promise as its cleanup.
    Element.prototype.scrollIntoView = function () {
      return Promise.resolve() as unknown as void;
    };
    post.mockReset();
  });
  afterEach(() => {
    Element.prototype.scrollIntoView = original;
  });

  it("keeps working reply after reply", async () => {
    post
      .mockImplementationOnce(() => ok({ call_id: "c1", say: "Hello! I'm the AI assistant.", ended: false, outcome: null, transfer_to: null, language: "en-IN" }))
      .mockImplementationOnce(() => ok({ call_id: "c1", say: "We're open 10 to 7.", ended: false, outcome: null, transfer_to: null, language: "en-IN" }))
      .mockImplementationOnce(() => ok({ call_id: "c1", say: "Goodbye!", ended: true, outcome: "answered", transfer_to: null, language: "en-IN" }));
    const qc = new QueryClient();
    render(
      <QueryClientProvider client={qc}>
        <ToastProvider>
          <TestCall ventureId="v1" />
        </ToastProvider>
      </QueryClientProvider>,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("switch", { name: /read replies aloud/i }));
    await user.click(screen.getByRole("button", { name: /start a test call/i }));
    expect(await screen.findByText("Hello! I'm the AI assistant.")).toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: /what the caller says/i }), "When are you open?");
    await user.click(screen.getByRole("button", { name: /^say$/i }));
    expect(await screen.findByText("We're open 10 to 7.")).toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: /what the caller says/i }), "ok bye");
    await user.click(screen.getByRole("button", { name: /^say$/i }));
    await waitFor(() => expect(screen.getByText(/call ended/i)).toBeInTheDocument());
    expect(screen.getByText("When are you open?")).toBeInTheDocument();
  });
});
