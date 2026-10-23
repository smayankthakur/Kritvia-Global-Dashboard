import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
const post = vi.fn();
vi.mock("@/lib/api", async (orig) => {
  const real = await orig<typeof import("@/lib/api")>();
  return { ...real, api: { ...real.api, GET: (...a: unknown[]) => get(...a), POST: (...a: unknown[]) => post(...a) } };
});

import { ChatApprovals } from "@/components/account/chat-approvals";
import { ToastProvider } from "@/components/ui/toast";

const ok = (data: unknown) => Promise.resolve({ data, response: new Response(JSON.stringify(data), { status: 200 }) });
const links = { links: [], telegram_bot: null, whatsapp_number: null, slack_app: false, slack_available: false, can_add_slack: false };
const ADDRESS = "ask-abcdefghijklmnopqrstuvwxyz@in.example.com";

function renderCard() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider>
        <ChatApprovals ventureId="v1" ventureName="Desk Salon" />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("Ask Kritvia from anywhere: email", () => {
  beforeEach(() => {
    get.mockReset();
    post.mockReset();
  });

  it("makes a private address, shows it once, and replaces it only after a confirmation", async () => {
    let exists = false;
    get.mockImplementation((path: string) =>
      path.endsWith("/ask-address")
        ? ok(
            exists
              ? { available: true, exists: true, address: null, hint: "uvwxyz", created_at: "2026-10-23T10:00:00Z", last_used_at: null, your_email: "me@example.com" }
              : { available: true, exists: false, address: null, hint: null, created_at: null, last_used_at: null, your_email: "me@example.com" },
          )
        : ok(links),
    );
    post.mockImplementation(() => {
      exists = true;
      return ok({ available: true, exists: true, address: ADDRESS, hint: "uvwxyz", created_at: "2026-10-23T10:00:00Z", last_used_at: null, your_email: "me@example.com" });
    });
    renderCard();
    const user = userEvent.setup();
    expect(await screen.findByRole("heading", { name: /ask kritvia from anywhere/i })).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: /make my address/i }));
    expect(await screen.findByText(ADDRESS)).toBeInTheDocument();
    expect(screen.getByText(/only now/i)).toBeInTheDocument();
    expect(await screen.findByText(/ends in …uvwxyz/)).toBeInTheDocument();

    // a new address needs a yes first: the old one stops working
    await user.click(screen.getByRole("button", { name: /new address/i }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/stops working at once/i)).toBeInTheDocument();
    expect(post).toHaveBeenCalledTimes(1);
    await user.click(within(dialog).getByRole("button", { name: /make a new one/i }));
    expect(post).toHaveBeenCalledTimes(2);
  });

  it("says so when the server doesn't receive email", async () => {
    get.mockImplementation((path: string) =>
      path.endsWith("/ask-address")
        ? ok({ available: false, exists: false, address: null, hint: null, created_at: null, last_used_at: null, your_email: null })
        : ok(links),
    );
    renderCard();
    const email = (await screen.findByText("Email", { selector: "p *, p" })).closest("li")!;
    expect(await within(email).findByText(/^Not available on this server yet\.$/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /make my address/i })).toBeNull();
  });
});
