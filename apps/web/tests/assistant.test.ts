import { describe, expect, it } from "vitest";
import { inProgress, toolLabel } from "@/components/assistant/labels";

describe("assistant labels", () => {
  it("names built-in and connected-app tools in plain words", () => {
    expect(toolLabel("gmail.send")).toBe("Email");
    expect(toolLabel("leads.search")).toBe("Looked up leads");
    expect(toolLabel("app.hubspot.create_contact")).toBe("hubspot: create contact");
    expect(toolLabel("something.else")).toBe("something.else");
  });

  it("knows when a request is still being worked on", () => {
    expect(inProgress("queued")).toBe(true);
    expect(inProgress("running")).toBe(true);
    expect(inProgress("waiting")).toBe(false);
    expect(inProgress("completed")).toBe(false);
  });
});
