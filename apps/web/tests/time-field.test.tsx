import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { Field } from "@/components/ui/field";
import { minuteOptions, parseTime, TimeField, twelveHour } from "@/components/ui/time-field";

function Harness({ start = "10:00", clearable = false }: { start?: string; clearable?: boolean }) {
  const [v, setV] = useState(start);
  return (
    <>
      <Field label="Check daily at (IST)">
        <TimeField value={v} onChange={setV} clearable={clearable} />
      </Field>
      <output data-testid="value">{v}</output>
    </>
  );
}

describe("time helpers", () => {
  it("parses and reads times", () => {
    expect(parseTime("09:05")).toEqual([9, 5]);
    expect(parseTime("24:00")).toBeNull();
    expect(parseTime("")).toBeNull();
    expect(twelveHour(0, 0)).toBe("12:00 am");
    expect(twelveHour(13, 5)).toBe("1:05 pm");
    expect(twelveHour(12, 30)).toBe("12:30 pm");
  });

  it("offers minutes every step, keeping an odd current minute", () => {
    expect(minuteOptions(15)).toEqual([0, 15, 30, 45]);
    expect(minuteOptions(15, 7)).toEqual([0, 7, 15, 30, 45]);
    expect(minuteOptions(5).length).toBe(12);
  });
});

describe("TimeField", () => {
  it("is labelled by its field and shows the 12-hour reading", () => {
    render(<Harness />);
    const btn = screen.getByRole("button", { name: "Check daily at (IST)" });
    expect(btn).toHaveTextContent("10:00");
    expect(btn).toHaveTextContent("10:00 am");
  });

  it("picks an hour and a minute with the mouse", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Check daily at (IST)" }));
    const [hours, minutes] = screen.getAllByRole("listbox");
    fireEvent.click(hours!.querySelector('[data-v="14"]')!);
    expect(screen.getByTestId("value")).toHaveTextContent("14:00");
    fireEvent.click(minutes!.querySelector('[data-v="45"]')!);
    expect(screen.getByTestId("value")).toHaveTextContent("14:45");
    // picking the minute closes it
    expect(screen.getByRole("button", { name: "Check daily at (IST)" })).toHaveAttribute("aria-expanded", "false");
  });

  it("works from the keyboard", () => {
    render(<Harness />);
    const btn = screen.getByRole("button", { name: "Check daily at (IST)" });
    fireEvent.keyDown(btn, { key: "ArrowDown" });
    const dialog = screen.getByRole("dialog");
    fireEvent.keyDown(dialog, { key: "ArrowDown" });
    fireEvent.keyDown(dialog, { key: "ArrowRight" });
    fireEvent.keyDown(dialog, { key: "ArrowDown" });
    fireEvent.keyDown(dialog, { key: "ArrowDown" });
    expect(screen.getByTestId("value")).toHaveTextContent("11:10");
    fireEvent.keyDown(dialog, { key: "ArrowUp" });
    fireEvent.keyDown(dialog, { key: "ArrowLeft" });
    fireEvent.keyDown(dialog, { key: "End" });
    expect(screen.getByTestId("value")).toHaveTextContent("23:05");
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(btn).toHaveAttribute("aria-expanded", "false");
  });

  it("quick picks and clear", () => {
    render(<Harness clearable />);
    fireEvent.click(screen.getByRole("button", { name: "Check daily at (IST)" }));
    fireEvent.click(screen.getByRole("button", { name: "6 pm" }));
    expect(screen.getByTestId("value")).toHaveTextContent("18:00");
    fireEvent.click(screen.getByRole("button", { name: "Check daily at (IST)" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.getByTestId("value")).toBeEmptyDOMElement();
  });
});
