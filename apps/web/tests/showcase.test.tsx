import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AgentsShowcase } from "@/components/public/agents-showcase";
import { Layers } from "@/components/public/layers";
import { PlatformShowcase } from "@/components/public/platform-showcase";

// jsdom has no IntersectionObserver: report everything as on screen.
beforeAll(() => {
  class IO {
    cb: IntersectionObserverCallback;
    constructor(cb: IntersectionObserverCallback) {
      this.cb = cb;
    }
    observe(el: Element) {
      this.cb([{ isIntersecting: true, target: el } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
    }
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  }
  vi.stubGlobal("IntersectionObserver", IO);
});

afterEach(() => vi.useRealTimers());

const selected = () => screen.getAllByRole("tab").find((t) => t.getAttribute("aria-selected") === "true");

describe("landing showcases", () => {
  it("agents: four tabs, the panel tells the picked agent's story in words", () => {
    render(<AgentsShowcase />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual([
      expect.stringContaining("Inbox assistant"),
      expect.stringContaining("Lead triage & proposals"),
      expect.stringContaining("Loan document checks"),
      expect.stringContaining("Nightly kitchen plan"),
    ]);
    fireEvent.click(tabs[2]!);
    expect(selected()).toBe(tabs[2]);
    expect(screen.getByRole("tabpanel")).toHaveTextContent("Reads KYC, bank statements and salary slips");
  });

  it("every agent and platform description is in the page, for search engines and no-JS readers", () => {
    const { container } = render(
      <>
        <AgentsShowcase />
        <PlatformShowcase />
      </>,
    );
    for (const t of [
      "drafts vendor purchase orders",
      "never a made-up number",
      "every answer says which page it came from",
      "Kritvia learns your names and terms",
      "you can take it back",
    ])
      expect(container.textContent).toContain(t);
  });

  it("arrow keys, Home and End move between tabs and keep focus on the picked one", () => {
    render(<PlatformShowcase />);
    const tabs = screen.getAllByRole("tab");
    tabs[0]!.focus();
    fireEvent.keyDown(tabs[0]!, { key: "ArrowDown" });
    expect(selected()).toBe(tabs[1]);
    expect(document.activeElement).toBe(tabs[1]);
    fireEvent.keyDown(tabs[1]!, { key: "End" });
    expect(selected()).toBe(tabs[3]);
    fireEvent.keyDown(tabs[3]!, { key: "ArrowRight" });
    expect(selected()).toBe(tabs[0]);
    fireEvent.keyDown(tabs[0]!, { key: "ArrowUp" });
    expect(selected()).toBe(tabs[3]);
    fireEvent.keyDown(tabs[3]!, { key: "Home" });
    expect(selected()).toBe(tabs[0]);
  });

  it("advances by itself while on screen, and stops while the pointer is over it", () => {
    vi.useFakeTimers();
    const { container } = render(<Layers />);
    const tabs = screen.getAllByRole("tab");
    expect(selected()).toBe(tabs[0]);
    act(() => void vi.advanceTimersByTime(7100));
    expect(selected()).toBe(tabs[1]);
    fireEvent.pointerEnter(container.querySelector('[role="group"]')!);
    act(() => void vi.advanceTimersByTime(20000));
    expect(selected()).toBe(tabs[1]);
  });

  it("the example window is hidden from screen readers", () => {
    render(<AgentsShowcase />);
    const panel = screen.getByRole("tabpanel");
    expect(panel.querySelector('[aria-hidden="true"]')).toHaveTextContent("Example");
  });
});
