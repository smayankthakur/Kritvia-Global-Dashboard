import hi from "@/lib/i18n/hi.json";
import { translateString, translateTree } from "@/lib/i18n/translate";

const dict = hi as Record<string, string>;

describe("Hindi interface", () => {
  it("translates whole interface strings", () => {
    expect(translateString(dict, "Approvals")).toBe("मंज़ूरियाँ");
    expect(translateString(dict, "  Save \n")).toBe("सेव करें");
  });

  it("translates strings built with numbers and days", () => {
    expect(translateString(dict, "3 unpaid")).toBe("3 बकाया");
    expect(translateString(dict, "Every Monday at 9:00")).toBe("हर सोमवार को 9:00 बजे");
    expect(translateString(dict, "Step 2 of 5")).toBe("क़दम 2 / 5");
  });

  it("leaves text it does not know alone", () => {
    expect(translateString(dict, "Ramesh asked about the Diwali order")).toBeNull();
    expect(translateString(dict, "")).toBeNull();
  });

  it("translates the page but never user content or legal text", () => {
    document.body.innerHTML = `
      <nav><a>Approvals</a><input placeholder="Search" /></nav>
      <div translate="no"><p>Approvals</p></div>
      <div data-no-i18n><p>Save</p></div>
      <pre>Save</pre>`;
    translateTree(dict, document.body);
    expect(document.querySelector("nav a")?.textContent).toBe("मंज़ूरियाँ");
    expect(document.querySelector("nav input")?.getAttribute("placeholder")).toBe("खोजें");
    expect(document.querySelector("[translate=no] p")?.textContent).toBe("Approvals");
    expect(document.querySelector("[data-no-i18n] p")?.textContent).toBe("Save");
    expect(document.querySelector("pre")?.textContent).toBe("Save");
  });

  it("has no empty or untranslated entries", () => {
    for (const [en, h] of Object.entries(dict)) {
      expect(h.trim(), en).not.toBe("");
    }
    const latinOnly = Object.entries(dict).filter(([en, h]) => en === h && /[a-z]{4}/i.test(en));
    expect(latinOnly.length).toBeLessThan(40);
  });
});
