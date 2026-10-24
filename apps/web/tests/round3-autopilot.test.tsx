import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hoursProblem, normalizeTime, tidyHours } from "@/components/bookings/booking-setup";
import { payWay, whatsappShare, type Invoice } from "@/components/invoices/invoice-dialog";
import { byAutopilotTitle } from "@/components/money/bank-tab";
import { ApiError } from "@/lib/api";
import { autopilotProblem, choiceProblem, jobSentence, jobShort, splitJobs, todayNumbers } from "@/lib/autopilot";
import { splitCommon, ventureNav } from "@/lib/nav";
import { byCreation, offeredAgents, rolesFor, TEMPLATES, templateFor } from "@/lib/onboarding";
import { agentAllowed, CORE_AGENTS } from "@/lib/pricing";
import { backoffMs, isUnreachable } from "@/lib/reconnect";
import { codeFromName } from "@/lib/slug";

const CATALOGUE = [
  "inbox_assistant", "assistant", "booking_reminders", "reviews", "collections", "lead_triage", "meeting_digest", "social",
  "kitchen_daily", "loan_verification", "trade_watch", "trade_update", "prospector",
].map((name) => ({
  name,
  venture_kinds:
    name === "kitchen_daily" ? ["kitchen", "general"] : name === "loan_verification" ? ["finance", "general"] : name.startsWith("trade") ? ["trade", "general"] : ["general", "software", "finance", "kitchen", "trade"],
}));

describe("test report round 3: setup and owner screens", () => {
  it("A3: a salon is offered booking, review and payment agents, never kitchen, loan or shipment ones", () => {
    const salon = TEMPLATES.find((t) => t.id === "clinic")!;
    const { main, more } = offeredAgents(salon, CATALOGUE);
    expect(main.map((w) => w.name)).toEqual(["inbox_assistant", "booking_reminders", "reviews", "assistant", "collections"]);
    const all = [...main, ...more].map((w) => w.name);
    for (const foreign of ["kitchen_daily", "loan_verification", "trade_watch", "trade_update"]) expect(all).not.toContain(foreign);
    expect(rolesFor("general").map((r) => r.role)).toEqual(["approver", "operator"]);
    expect(rolesFor("finance").map((r) => r.role)).toContain("loan_officer");
    expect(rolesFor("kitchen").map((r) => r.role)).toContain("kitchen_manager");
    // a kitchen still gets its own agent
    expect(offeredAgents(TEMPLATES.find((t) => t.id === "kitchen")!, CATALOGUE).main.map((w) => w.name)).toContain("kitchen_daily");
    // coaching gets the same daily agents plus course enquiries
    expect(TEMPLATES.find((t) => t.id === "coaching")!.workflows).toEqual(expect.arrayContaining(["booking_reminders", "reviews", "lead_triage"]));
    expect(templateFor("clinic", "general").id).toBe("clinic");
  });

  it("A3: the salon's agents are on every plan, as the API's plans.py says", () => {
    const py = readFileSync(join(__dirname, "../../api/kritvia_api/plans.py"), "utf8");
    const block = /CORE_AGENTS = frozenset\(\{([\s\S]*?)\}\)/.exec(py)![1]!;
    const names = [...block.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    expect([...CORE_AGENTS].sort()).toEqual([...names].sort());
    for (const wf of ["booking_reminders", "reviews", "collections", "assistant"]) expect(agentAllowed("core", wf, "general")).toBe(true);
  });

  it("A22: businesses keep the order they were created in, whatever order the API sends", () => {
    const vs = [
      { venture_id: "b", venture_name: "Alpha Salon" },
      { venture_id: "a", venture_name: "Zed Kitchen" },
      { venture_id: "c", venture_name: "Beta" },
    ];
    expect(byCreation(vs, ["a", "b"]).map((v) => v.venture_id)).toEqual(["a", "b", "c"]);
    expect(byCreation([...vs].reverse(), ["a", "b"]).map((v) => v.venture_id)).toEqual(["a", "b", "c"]);
    // nothing remembered: by name, the same every time
    expect(byCreation(vs, []).map((v) => v.venture_name)).toEqual(["Alpha Salon", "Beta", "Zed Kitchen"]);
  });

  it("A8: the invoice is shared only once the business can be paid, and the text says how", () => {
    expect(payWay({ upi_id: null, razorpay: null })).toBeNull();
    expect(payWay({ upi_id: "glow@okicici", razorpay: null })).toBe("upi");
    expect(payWay({ upi_id: null, razorpay: { key_id: "rzp", last_error: null, webhook_url: "" } })).toBe("online");
    const inv = { customer_name: "Asha", number: "INV-1", balance_paise: 118000, pay_url: "https://kritvia.in/pay/x", customer_phone: "919811122233" } as Invoice;
    expect(decodeURIComponent(whatsappShare(inv, "upi"))).toContain("pay by UPI here");
    expect(decodeURIComponent(whatsappShare(inv, "online"))).toContain("pay online here");
    expect(decodeURIComponent(whatsappShare(inv, "online"))).not.toContain("UPI");
  });

  it("A10: booking hours are typed, tidied and checked", () => {
    expect(normalizeTime("9")).toBe("09:00");
    expect(normalizeTime("930")).toBe("09:30");
    expect(normalizeTime("18.30")).toBe("18:30");
    expect(normalizeTime("7pm")).toBe("19:00");
    expect(normalizeTime("12am")).toBe("00:00");
    expect(normalizeTime("10:00")).toBe("10:00");
    expect(normalizeTime("")).toBe("");
    expect(normalizeTime("25:00")).toBeNull();
    expect(normalizeTime("noon")).toBeNull();
    expect(hoursProblem({ mon: [["10", "7pm"]] })).toBeNull();
    expect(hoursProblem({ mon: [["19:00", "10:00"]] })).toMatch(/Monday: the closing time/);
    expect(hoursProblem({ tue: [["10:00", ""]] })).toMatch(/Tuesday: write both times/);
    expect(hoursProblem({ wed: [["", ""]] })).toBeNull();
    expect(tidyHours({ mon: [["9", "1830"]] })).toEqual({ mon: [["09:00", "18:30"]] });
  });

  it("A25: a rate-card code comes from the name and stays unique", () => {
    expect(codeFromName("Hair cut & wash", [])).toBe("hair_cut_wash");
    expect(codeFromName("Hair cut", ["hair_cut"])).toBe("hair_cut_2");
    expect(codeFromName("Hair cut", ["hair_cut", "hair_cut_2"])).toBe("hair_cut_3");
    expect(codeFromName("A", [])).toBe("a_item");
    expect(codeFromName("", [])).toBe("");
    expect(codeFromName("x".repeat(60), []).length).toBeLessThanOrEqual(40);
  });

  it("A25: the sidebar shows a business's everyday screens and keeps the rest under More", () => {
    const common = ventureNav("v1", "general").common;
    const salon = splitCommon(common, "general");
    expect(salon.main.map((i) => i.label)).toEqual(expect.arrayContaining(["Bookings", "Reviews", "Invoices", "Agents", "Settings"]));
    expect(salon.main.length).toBeLessThan(12);
    const loans = splitCommon(ventureNav("v1", "finance").common, "finance");
    expect(loans.main.map((i) => i.label)).not.toContain("Bookings");
    // nothing is lost: everything is either shown or under More
    expect([...loans.main, ...loans.more].length).toBe(common.length);
  });

  it("A24: an unreachable API is a passing problem, retried with back-off", () => {
    expect(isUnreachable(new ApiError(0, "Network error"))).toBe(true);
    expect(isUnreachable(new ApiError(502, "the Kritvia API is unreachable"))).toBe(true);
    expect(isUnreachable(new ApiError(503, "x"))).toBe(true);
    expect(isUnreachable(new ApiError(500, "x"))).toBe(false);
    expect(isUnreachable(new ApiError(404, "x"))).toBe(false);
    expect([0, 1, 2, 3].map(backoffMs)).toEqual([2000, 4000, 8000, 16000]);
    expect(backoffMs(9)).toBe(30_000);
  });
});

describe("autopilot (round 3, section D)", () => {
  const data = {
    jobs: [
      { agent: "inbox", what: "answered customers", on_plan: true },
      { agent: "reviews", what: "review replies and requests", on_plan: false },
      { agent: "new_agent", what: "did something new", on_plan: true },
    ],
    today_by_itself: { inbox: 4, reviews: 0, collections: 2 },
    waiting: 3,
    held_today: 1,
  };

  it("lists what it does by itself, and what needs Starter", () => {
    const { now, later } = splitJobs(data.jobs);
    expect(now.map((j) => j.agent)).toEqual(["inbox", "new_agent"]);
    expect(later.map((j) => j.agent)).toEqual(["reviews"]);
    expect(jobSentence(data.jobs[0]!)).toMatch(/^Answers customers/);
    expect(jobSentence(data.jobs[2]!)).toBe("Did something new");
    expect(jobShort("collections")).toBe("Payment reminders");
  });

  it("counts today's numbers", () => {
    expect(todayNumbers(data)).toEqual({ done: 6, waiting: 3, sent: 1, byAgent: [["inbox", 4], ["collections", 2]] });
  });

  it("explains a refused switch in plain words, and the onboarding choice can't be skipped", () => {
    expect(autopilotProblem(new ApiError(403, "only an admin"))).toMatch(/owner or admin/);
    expect(autopilotProblem(new ApiError(409, "fill in"))).toMatch(/business profile/);
    expect(choiceProblem(null)).toMatch(/Choose/);
    expect(choiceProblem("auto")).toBeNull();
    expect(choiceProblem("approve")).toBeNull();
  });

  it("bank upload: payments autopilot recorded, with undo on each line", () => {
    expect(byAutopilotTitle(1)).toBe("1 payment recorded by autopilot (undo on each line)");
    expect(byAutopilotTitle(3)).toBe("3 payments recorded by autopilot (undo on each line)");
  });
});
