import { describe, expect, it } from "vitest";
import { hasMailbox } from "@/components/approvals/use-send-channels";
import { phoneProblem } from "@/components/leads/lead-forms";
import { ownerCount } from "@/components/settings/members";
import { draftFromConfig, draftKey, hasSearches } from "@/components/settings/workflows";
import { agentFits, agentFromHash, splitAgents } from "@/lib/agents";
import { bulkSkipReason, expiresSoonHours, nextPendingId, splitBulk } from "@/lib/inbox";
import { flatPages, unwrapPage } from "@/lib/paging";
import { chunk, stillListed, toggled } from "@/lib/selection";
import { isInAppNavigation } from "@/lib/unsaved";
import { AI_FAILED, TECH_FAILED, actionLabel, isTechnicalError, outcomeLabel, plainError, roleLabel, rolesLabel, sentLabel } from "@/lib/wording";

describe("plain wording for technical names (A17)", () => {
  it("names actions in words", () => {
    expect(actionLabel("gmail.send")).toBe("Email");
    expect(actionLabel("whatsapp.send")).toBe("WhatsApp");
    expect(actionLabel("whatsapp.template")).toBe("WhatsApp");
    expect(actionLabel("telegram.send")).toBe("Telegram");
    expect(actionLabel("google.review_reply")).toBe("Google review reply");
    expect(actionLabel("social.post")).toBe("Social post");
    expect(actionLabel("purchase_order.send")).toBe("Purchase order send");
    expect(actionLabel("")).toBe("");
  });

  it("names roles in words", () => {
    expect(roleLabel("venture_admin")).toBe("Owner/admin");
    expect(roleLabel("approver")).toBe("Approver");
    expect(roleLabel("kitchen_manager")).toBe("Kitchen manager");
    expect(roleLabel("some_new_role")).toBe("Some new role");
    expect(rolesLabel(["approver", "venture_admin"])).toBe("Approver or Owner/admin");
    expect(rolesLabel([])).toBe("");
  });

  it("never says a logged reply was sent", () => {
    expect(sentLabel("logged")).toBe("Not sent (no mailbox connected)");
    expect(sentLabel("sent")).toBe("Sent");
    expect(sentLabel(true)).toBe("Sent");
    expect(sentLabel(false)).toBe("Not sent");
  });

  it("says plainly when a lead was saved without a score", () => {
    expect(outcomeLabel("saved_unscored")).toBe("Saved without a score");
    expect(outcomeLabel("proposal_sent")).toBe("Proposal sent");
    expect(outcomeLabel(null)).toBe("");
  });

  it("turns exception class names into a sentence", () => {
    expect(plainError("LLMOutputError: invalid structured output after repair")).toBe(AI_FAILED);
    expect(plainError("AllProvidersFailed: every provider failed")).toBe(AI_FAILED);
    expect(plainError("TimeoutError: read timed out")).toBe(TECH_FAILED);
    expect(plainError("Lead triage & proposals: 4 run(s) failed (last: LLMOutputError: invalid structured output)")).toBe(
      "Lead triage & proposals: 4 run(s) failed (last: the AI couldn't finish it)",
    );
    expect(plainError("The customer's number is not on WhatsApp")).toBe("The customer's number is not on WhatsApp");
    expect(plainError(null)).toBe("");
    expect(isTechnicalError("LLMOutputError: x")).toBe(true);
    expect(isTechnicalError("LLMOutputError: x")).toBe(true); // a global regex must not remember the last match
    expect(isTechnicalError("Failed to reach Google")).toBe(false);
  });
});

describe("approval inbox: next draft and bulk approve (A6)", () => {
  const item = (id: string, over: Partial<Parameters<typeof bulkSkipReason>[0]> = {}) => ({
    id,
    action: "whatsapp.send",
    venture_id: "v1",
    sensitive: false,
    summary: "Answering a question about timings.",
    can_decide: true,
    ...over,
  });

  it("opens the next draft down, else the one above, else none", () => {
    const list = [item("a"), item("b"), item("c")];
    expect(nextPendingId(list, "a")).toBe("b");
    expect(nextPendingId(list, "c")).toBe("b");
    expect(nextPendingId(list, "b", new Set(["c"]))).toBe("a");
    expect(nextPendingId([item("a")], "a")).toBeNull();
    expect(nextPendingId(list, "gone")).toBe("a");
  });

  it("leaves sensitive drafts and unknown amounts for one-by-one review", () => {
    expect(bulkSkipReason(item("a"))).toBeNull();
    expect(bulkSkipReason(item("a", { sensitive: true }))).toMatch(/Sensitive/);
    expect(bulkSkipReason(item("a", { summary: "Quote. Amounts not in your records: ₹450" }))).toMatch(/amount/);
    expect(bulkSkipReason(item("a", { can_decide: false }))).toMatch(/can't decide/);
    expect(bulkSkipReason(item("a", { action: "gmail.send" }), new Set(["v1"]))).toBe("Gmail isn't connected");
    expect(bulkSkipReason(item("a", { action: "gmail.send" }), new Set(["v2"]))).toBeNull();
  });

  it("splits a selection into approved and skipped", () => {
    const list = [item("a"), item("b", { sensitive: true }), item("c")];
    const out = splitBulk(list, new Set(["a", "b", "gone"]));
    expect(out.approve.map((x) => x.id)).toEqual(["a"]);
    expect(out.skipped.map((x) => x.item.id)).toEqual(["b"]);
  });

  it("counts hours to expiry only under 12 hours", () => {
    const now = Date.parse("2026-10-24T00:00:00Z");
    expect(expiresSoonHours("2026-10-24T05:30:00Z", now)).toBe(5);
    expect(expiresSoonHours("2026-10-24T00:20:00Z", now)).toBe(0);
    expect(expiresSoonHours("2026-10-24T13:00:00Z", now)).toBeNull();
    expect(expiresSoonHours("2026-10-23T23:00:00Z", now)).toBeNull();
    expect(expiresSoonHours(null, now)).toBeNull();
  });
});

describe("Agents page (A2, A4, A20)", () => {
  const wf = (name: string, venture_kinds: string[]) => ({ name, venture_kinds });

  it("keeps kitchen, loan and shipment agents for those businesses", () => {
    expect(agentFits(wf("kitchen_daily", ["kitchen", "general"]), "general")).toBe(false);
    expect(agentFits(wf("kitchen_daily", ["kitchen", "general"]), "kitchen")).toBe(true);
    expect(agentFits(wf("loan_verification", ["finance", "general"]), "general")).toBe(false);
    expect(agentFits(wf("trade_watch", ["trade", "general"]), "trade")).toBe(true);
    expect(agentFits(wf("lead_triage", ["software", "general", "trade"]), "general")).toBe(true);
    expect(agentFits(wf("inbox_assistant", ["general", "software", "finance", "kitchen", "trade"]), "kitchen")).toBe(true);
    expect(agentFits(wf("lead_triage", ["software", "general", "trade"]), "kitchen")).toBe(false);
  });

  it("puts agents that don't fit under More agents unless they are on", () => {
    const list = [wf("inbox_assistant", ["general", "software", "kitchen"]), wf("kitchen_daily", ["kitchen", "general"]), wf("trade_watch", ["trade", "general"])];
    const { main, more } = splitAgents(list, "general", new Set(["trade_watch"]));
    expect(main.map((w) => w.name)).toEqual(["inbox_assistant", "trade_watch"]);
    expect(more.map((w) => w.name)).toEqual(["kitchen_daily"]);
  });

  it("reads the agent a link names", () => {
    expect(agentFromHash("#agent-prospector")).toBe("prospector");
    expect(agentFromHash("#top")).toBeNull();
    expect(agentFromHash("")).toBeNull();
  });

  const prospector = {
    name: "prospector",
    options: [
      { key: "searches", label: "Searches", type: "text", default: "" },
      { key: "new_per_day", label: "New a day", type: "number", default: 10, min: 1, max: 25 },
    ],
  } as unknown as Parameters<typeof draftFromConfig>[0];

  it("sees no unsaved change until something that would be saved differs", () => {
    const config = { schedule: "10:30", instructions: "Be brief", settings: { searches: "cafes in Rohini", gmail_query: "label:leads" } };
    const base = draftFromConfig(prospector, config);
    expect(draftKey(prospector, base)).toBe(draftKey(prospector, { ...base }));
    // Typing the default back in, or reformatting the extra JSON, saves the same thing.
    expect(draftKey(prospector, { ...base, form: { ...base.form, new_per_day: "10" } })).toBe(draftKey(prospector, base));
    expect(draftKey(prospector, { ...base, text: '{"gmail_query":"label:leads"}' })).toBe(draftKey(prospector, base));
    expect(draftKey(prospector, { ...base, instructions: "Be brief!" })).not.toBe(draftKey(prospector, base));
    expect(draftKey(prospector, { ...base, form: { ...base.form, searches: "" } })).not.toBe(draftKey(prospector, base));
    expect(draftKey(prospector, { ...base, text: "{oops" })).not.toBe(draftKey(prospector, base));
  });

  it("needs a saved search before Find leads now", () => {
    expect(hasSearches({ settings: { searches: "cafes in Rohini" } })).toBe(true);
    expect(hasSearches({ settings: { searches: " ; " } })).toBe(false);
    expect(hasSearches({ settings: {} })).toBe(false);
    expect(hasSearches(undefined)).toBe(false);
  });
});

describe("leaving with unsaved changes (A2)", () => {
  const click = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, defaultPrevented: false };
  const link = (href: string, attrs: Record<string, string> = {}) => {
    const a = document.createElement("a");
    a.href = href;
    for (const [k, v] of Object.entries(attrs)) a.setAttribute(k, v);
    return a;
  };
  const here = "https://app.sitelytc.com/v/1/rate-card";

  it("asks only for a link to another page of the app in this tab", () => {
    expect(isInAppNavigation(click, link("https://app.sitelytc.com/v/1/leads"), here)).toBe(true);
    expect(isInAppNavigation(click, link("https://app.sitelytc.com/v/1/rate-card#top"), here)).toBe(false);
    expect(isInAppNavigation(click, link("https://example.com/"), here)).toBe(false);
    expect(isInAppNavigation(click, link("https://app.sitelytc.com/v/1/leads", { target: "_blank" }), here)).toBe(false);
    expect(isInAppNavigation({ ...click, metaKey: true }, link("https://app.sitelytc.com/v/1/leads"), here)).toBe(false);
    expect(isInAppNavigation(click, link("https://app.sitelytc.com/files/x.pdf", { download: "" }), here)).toBe(false);
  });
});

describe("leads and proposals (A7, B8, B13)", () => {
  it("checks a typed phone number", () => {
    expect(phoneProblem("")).toBeNull();
    expect(phoneProblem("+91 98100 12345")).toBeNull();
    expect(phoneProblem("(011) 2525-1234")).toBeNull();
    expect(phoneProblem("call me")).toMatch(/phone number/);
    expect(phoneProblem("12")).toMatch(/phone number/);
  });

  it("selects, keeps only listed rows and chunks bulk deletes at 500", () => {
    expect([...toggled(new Set(["a"]), "b", true)]).toEqual(["a", "b"]);
    expect([...toggled(new Set(["a"]), "a", false)]).toEqual([]);
    expect(stillListed(new Set(["a", "gone"]), [{ id: "a" }, { id: "b" }])).toEqual(["a"]);
    const ids = Array.from({ length: 1201 }, (_, i) => String(i));
    expect(chunk(ids).map((c) => c.length)).toEqual([500, 500, 201]);
    expect(chunk([])).toEqual([]);
  });

  it("reads the next-page cursor from the response header", async () => {
    const page = await unwrapPage(Promise.resolve({ data: [{ id: "a" }], response: new Response("[]", { headers: { "X-Next-Cursor": "abc" } }) }));
    expect(page).toEqual({ items: [{ id: "a" }], next: "abc" });
    const last = await unwrapPage(Promise.resolve({ data: [], response: new Response("[]") }));
    expect(last.next).toBeNull();
    expect(flatPages([{ items: [1, 2], next: "x" }, { items: [3], next: null }])).toEqual([1, 2, 3]);
    expect(flatPages(undefined)).toEqual([]);
  });
});

describe("members and mailboxes (A19, A1)", () => {
  it("counts people who own the organisation, not agent accounts", () => {
    const owner = { role: "org_owner", is_service: false, user_id: "u1" };
    expect(ownerCount([owner, { ...owner, role: "venture_admin" }])).toBe(1);
    expect(ownerCount([owner, { role: "org_owner", is_service: true, user_id: "svc" }])).toBe(1);
    expect(ownerCount([owner, { ...owner, user_id: "u2" }])).toBe(2);
  });

  it("sends email only through a working Google account", () => {
    expect(hasMailbox([{ provider: "google", status: "active" }])).toBe(true);
    expect(hasMailbox([{ provider: "google", status: "error" }])).toBe(false);
    expect(hasMailbox([{ provider: "email_forwarding", status: "active" }])).toBe(false);
    expect(hasMailbox([])).toBe(false);
  });
});
