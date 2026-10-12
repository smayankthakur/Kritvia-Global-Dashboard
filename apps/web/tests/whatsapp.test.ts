import { describe, expect, it } from "vitest";
import { cannotSend, chatName, formatPhone, senderLabel } from "@/components/whatsapp/chat";
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
  });

  it("explains why a reply can't be sent", () => {
    const open = { opted_out: false, window_open: true };
    expect(cannotSend(open, true)).toBeNull();
    expect(cannotSend(open, false)).toMatch(/read chats but not answer/);
    expect(cannotSend({ ...open, opted_out: true }, true)).toMatch(/STOP/);
    expect(cannotSend({ ...open, window_open: false }, true)).toMatch(/24 hours/);
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
