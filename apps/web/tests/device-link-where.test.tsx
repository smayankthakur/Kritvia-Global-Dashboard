import { fireEvent, render, screen } from "@testing-library/react";
import { PickNumber, ShowNumber, WhereIsIt } from "@/components/devices/where";

describe("QR sign-in: where the device is, and the matching number (S13)", () => {
  it("warns when the device asking is on another connection", () => {
    const { rerender } = render(<WhereIsIt place="Mumbai, IN" ip="49.36.1.2" sameNetwork={false} at="2026-10-23T10:00:00Z" />);
    expect(screen.getByText(/Mumbai, IN/)).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(/different internet connection/);
    rerender(<WhereIsIt place="Delhi, IN" ip="49.36.1.2" sameNetwork={true} />);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says yes only by picking a number, and no with Not me", () => {
    const picked: string[] = [];
    let refused = false;
    render(<PickNumber options={["47", "12", "83"]} busy={false} shownOn="the computer" onPick={(n) => picked.push(n)} onRefuse={() => (refused = true)} />);
    expect(screen.queryByRole("button", { name: /yes/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "12" }));
    fireEvent.click(screen.getByRole("button", { name: "Not me" }));
    expect(picked).toEqual(["12"]);
    expect(refused).toBe(true);
  });

  it("shows this device's number", () => {
    render(<ShowNumber match="47" pickOn="your phone" />);
    expect(screen.getByText("47")).toBeInTheDocument();
  });
});
