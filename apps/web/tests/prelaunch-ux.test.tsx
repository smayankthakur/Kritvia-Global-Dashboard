import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const postAuth = vi.fn(async () => ({}));
vi.mock("@/lib/auth-client", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth-client")>()),
  postAuth: (...a: unknown[]) => postAuth(...(a as [])),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { ForgotForm } from "@/app/(auth)/forgot/forgot-form";
import { EmailCodeForm } from "@/components/auth/sign-in";
import { ChoiceCards } from "@/components/ui/choice-cards";
import { FileDrop } from "@/components/ui/file-drop";
import { digitsOnly } from "@/lib/cooldown";

const flush = () => act(async () => undefined);

describe("codes typed or pasted", () => {
  it("keeps only the digits, up to six", () => {
    expect(digitsOnly("123 456")).toBe("123456");
    expect(digitsOnly("123-456")).toBe("123456");
    expect(digitsOnly(" 12 34 56 78")).toBe("123456");
    expect(digitsOnly("ab")).toBe("");
  });

  it("the password-reset code field accepts a code pasted with a space (N10)", async () => {
    render(<ForgotForm />);
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: "a@b.co" } });
    fireEvent.submit(screen.getByLabelText(/email/i).closest("form")!);
    await flush();
    const code = screen.getByLabelText(/code/i) as HTMLInputElement;
    fireEvent.change(code, { target: { value: "123 456" } });
    expect(code.value).toBe("123456");
  });
});

describe("sending the email code again (N1)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    postAuth.mockClear();
  });
  afterEach(() => vi.useRealTimers());

  const tick = async (seconds: number) => {
    for (let i = 0; i < seconds; i++) await act(async () => void vi.advanceTimersByTime(1000));
  };

  it("waits 30 seconds, then can be used again and again", async () => {
    render(<EmailCodeForm onSignedIn={() => undefined} />);
    fireEvent.change(screen.getByLabelText(/work email/i), { target: { value: "owner@shop.in" } });
    fireEvent.submit(screen.getByLabelText(/work email/i).closest("form")!);
    await flush();
    expect(postAuth).toHaveBeenCalledTimes(1);

    const again = () => screen.getByRole("button", { name: /send (again|a new code)/i });
    expect(again()).toBeDisabled();
    expect(again()).toHaveTextContent(/30s/);

    await tick(30);
    expect(again()).toBeEnabled();
    fireEvent.click(again());
    await flush();
    expect(postAuth).toHaveBeenCalledTimes(2);
    expect(again()).toBeDisabled();
    expect(screen.getByText(/new code is on its way/i)).toBeInTheDocument();

    await tick(30);
    expect(again()).toBeEnabled();
    fireEvent.click(again());
    await flush();
    expect(postAuth).toHaveBeenCalledTimes(3);
  });
});

describe("file picker limit (N9)", () => {
  function Harness({ max }: { max: number }) {
    const [files, setFiles] = useState<File[]>([]);
    return <FileDrop files={files} onChange={setFiles} multiple maxFiles={max} label="Choose files" />;
  }

  it("says how many files were left out", () => {
    const { container } = render(<Harness max={2} />);
    const input = container.querySelector("input[type=file]") as HTMLInputElement;
    const f = (n: string) => new File(["x"], n, { type: "application/pdf" });
    fireEvent.change(input, { target: { files: [f("a.pdf"), f("b.pdf"), f("c.pdf")] } });
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByRole("status")).toHaveTextContent("Only 2 files fit at a time, so 1 file was left out");
    fireEvent.click(screen.getByRole("button", { name: "Remove a.pdf" }));
    expect(screen.getByRole("status")).toHaveTextContent("");
  });
});

describe("choice cards behave like radio buttons (N11)", () => {
  const OPTIONS = [
    { id: "agency", title: "Agency" },
    { id: "loans", title: "Loans" },
    { id: "kitchen", title: "Kitchen" },
  ];
  function Harness() {
    const [v, setV] = useState<string | null>(null);
    return (
      <ChoiceCards label="Kind of business" options={OPTIONS} value={v} onChange={(o) => setV(o.id)} render={(o) => o.title} />
    );
  }

  it("has one tab stop and moves with the arrow keys", () => {
    render(<Harness />);
    const radios = screen.getAllByRole("radio");
    expect(radios.map((r) => r.tabIndex)).toEqual([0, -1, -1]);

    fireEvent.keyDown(radios[0]!, { key: "ArrowRight" });
    expect(radios[1]).toHaveAttribute("aria-checked", "true");
    expect(document.activeElement).toBe(radios[1]);
    expect(radios.map((r) => r.tabIndex)).toEqual([-1, 0, -1]);

    fireEvent.keyDown(radios[1]!, { key: "ArrowLeft" });
    fireEvent.keyDown(radios[0]!, { key: "ArrowLeft" });
    expect(radios[2]).toHaveAttribute("aria-checked", "true");

    fireEvent.keyDown(radios[2]!, { key: "Home" });
    expect(radios[0]).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radiogroup", { name: "Kind of business" })).toBeInTheDocument();
  });
});
