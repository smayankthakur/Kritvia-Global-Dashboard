import { describe, expect, it } from "vitest";
import { cannotSend, chatName, formatPhone, senderLabel } from "@/components/whatsapp/chat";
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
});
