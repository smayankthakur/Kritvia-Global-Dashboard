import { describe, expect, it } from "vitest";
import { cannotSend, chatName, formatPhone, needsTemplate, normalisePhone, senderLabel } from "@/components/whatsapp/chat";
import { blanks, fillTemplate, paramProblem, sendableTemplates, templateProblem, templateStatus, templateTitle } from "@/components/whatsapp/templates";
import { parseSignupMessage } from "@/lib/meta-signup";
import { ventureNav } from "@/lib/nav";

describe("WhatsApp chats", () => {
  it("shows Indian numbers the way people write them", () => {
    expect(formatPhone("919811122233")).toBe("+91 98111 22233");
    expect(formatPhone("14155550100")).toBe("+14155550100");
  });

  it("names a chat by the customer's WhatsApp name, else their number", () => {
    expect(chatName({ name: "Neha", phone: "919811122233" })).toBe("Neha");
    expect(chatName({ name: "  ", phone: "919811122233" })).toBe("+91 98111 22233");
    expect(chatName({ name: null, phone: "919811122233" })).toBe("+91 98111 22233");
  });

  it("says who wrote each message", () => {
    expect(senderLabel("customer", "Neha")).toBe("Neha");
    expect(senderLabel("kritvia", "Neha")).toBe("Kritvia (approved)");
    expect(senderLabel("person", "Neha")).toBe("Your team");
    expect(senderLabel("phone", "Neha")).toBe("You, from the phone");
  });

  it("explains why a reply can't be sent", () => {
    const open = { opted_out: false, window_open: true };
    expect(cannotSend(open, true)).toBeNull();
    expect(cannotSend(open, false)).toMatch(/read chats but not answer/);
    expect(cannotSend({ ...open, opted_out: true }, true)).toMatch(/STOP/);
    expect(cannotSend({ ...open, window_open: false }, true)).toMatch(/24 hours.*template/);
    // after 24 hours the team can still write, with an approved template
    expect(needsTemplate({ ...open, window_open: false }, true)).toBe(true);
    expect(needsTemplate({ ...open, window_open: false }, false)).toBe(false);
    expect(needsTemplate({ opted_out: true, window_open: false }, true)).toBe(false);
    expect(needsTemplate(open, true)).toBe(false);
  });

  it("reads phone numbers the way people type them", () => {
    expect(normalisePhone("+91 98111 22233")).toBe("919811122233");
    expect(normalisePhone("98111 22233")).toBe("919811122233");
    expect(normalisePhone("+1 415 555 0100")).toBe("14155550100");
    expect(normalisePhone("098111 22233")).toBeNull();
    expect(normalisePhone("+91 ")).toBeNull();
    expect(normalisePhone("12345")).toBeNull();
  });

  it("is in every business's menu, next to the assistant", () => {
    for (const kind of ["general", "software", "finance", "kitchen"] as const) {
      const labels = ventureNav("v1", kind).common.map((i) => i.label);
      expect(labels.indexOf("WhatsApp")).toBe(labels.indexOf("Assistant") + 1);
    }
  });

  it("reads Meta's signup window messages and ignores everything else", () => {
    const finish = JSON.stringify({ type: "WA_EMBEDDED_SIGNUP", event: "FINISH", data: { phone_number_id: "111", waba_id: "222", business_id: "333" } });
    expect(parseSignupMessage("https://www.facebook.com", finish)).toEqual({ kind: "finish", wabaId: "222", phoneNumberId: "111", businessApp: false });
    const app = { type: "WA_EMBEDDED_SIGNUP", event: "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING", data: { waba_id: "222" } };
    expect(parseSignupMessage("https://web.facebook.com", app)).toEqual({ kind: "finish", wabaId: "222", phoneNumberId: null, businessApp: true });
    expect(parseSignupMessage("https://www.facebook.com", JSON.stringify({ type: "WA_EMBEDDED_SIGNUP", event: "CANCEL", data: { current_step: "PHONE_NUMBER_SETUP" } })))
      .toEqual({ kind: "cancel", step: "PHONE_NUMBER_SETUP", error: null });
    // other origins, look-alike hosts, other messages and junk are ignored
    expect(parseSignupMessage("https://evil.example", finish)).toBeNull();
    expect(parseSignupMessage("https://facebook.com.evil.example", finish)).toBeNull();
    expect(parseSignupMessage("https://notfacebook.com", finish)).toBeNull();
    expect(parseSignupMessage("https://www.facebook.com", JSON.stringify({ type: "OTHER" }))).toBeNull();
    expect(parseSignupMessage("https://www.facebook.com", "not json")).toBeNull();
    expect(parseSignupMessage("https://www.facebook.com", JSON.stringify({ type: "WA_EMBEDDED_SIGNUP", event: "FINISH", data: {} }))).toBeNull();
  });
});

describe("WhatsApp templates", () => {
  it("finds the blanks and shows what the customer gets", () => {
    const body = "Hi {{1}}, your order {{2}} is ready.";
    expect(blanks(body)).toBe(2);
    expect(blanks("No blanks here")).toBe(0);
    expect(fillTemplate(body, ["Neha", "#1042"])).toBe("Hi Neha, your order #1042 is ready.");
    expect(fillTemplate(body, ["Neha"])).toBe("Hi Neha, your order [2] is ready.");
  });

  it("checks Meta's wording rules before review", () => {
    expect(templateProblem("Hi {{1}}, your order is ready for pickup.")).toBeNull();
    expect(templateProblem("")).toMatch(/Write/);
    expect(templateProblem("{{1}}, your order is ready")).toMatch(/start or end/);
    expect(templateProblem("Your order is ready, {{1}}")).toMatch(/start or end/);
    expect(templateProblem("Hi {{2}}, your order is ready today")).toMatch(/in order/);
    expect(templateProblem("Hi {{name}}, your order is ready today")).toMatch(/numbers only/);
    expect(templateProblem("Hi {{1}} {{2}} {{3}} ok")).toMatch(/more words/);
    expect(paramProblem("Neha")).toBeNull();
    expect(paramProblem("  ")).toMatch(/every blank/);
    expect(paramProblem("two\nlines")).toMatch(/new lines/);
  });

  it("says Meta's review status in plain words and offers only approved, sendable templates", () => {
    expect(templateStatus("APPROVED")).toEqual({ label: "Approved", tone: "success" });
    expect(templateStatus("PENDING").label).toBe("In review");
    expect(templateStatus("REJECTED").tone).toBe("danger");
    expect(templateStatus("LIMIT_EXCEEDED").label).toBe("Limit exceeded");
    expect(templateTitle("order_ready")).toBe("Order ready");
    const all = [
      { id: "a", status: "APPROVED", sendable: true },
      { id: "b", status: "PENDING", sendable: true },
      { id: "c", status: "APPROVED", sendable: false },
    ];
    expect(sendableTemplates(all).map((t) => t.id)).toEqual(["a"]);
  });
});
