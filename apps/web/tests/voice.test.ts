import { describe, expect, it } from "vitest";
import { initialPtt, isAllowedHotkey, pttKeyDown, pttKeyUp, type PttState } from "@/lib/voice/hotkey";
import { detectCorrection, editedInsertion, isLearnable, singleDiffRegion } from "@/lib/voice/learn";
import { initialVad, VAD, vadStep } from "@/lib/voice/vad";

describe("auto-learn diff", () => {
  it("finds the one changed span", () => {
    expect(singleDiffRegion("send it to wisper team.", "send it to VSPR team.")).toEqual({ heard: "wisper", correct: "VSPR" });
    expect(singleDiffRegion("call kreet via today", "call Kritvia today")).toEqual({ heard: "kreet via", correct: "Kritvia" });
  });
  it("accepts a casing fix and rejects insertions", () => {
    expect(singleDiffRegion("kritvia is great", "Kritvia is great")).toEqual({ heard: "kritvia", correct: "Kritvia" });
    expect(singleDiffRegion("hello world", "hello big world")).toBeNull();
    expect(singleDiffRegion("same", "same")).toBeNull();
  });
  it("only learns short terms", () => {
    expect(isLearnable({ heard: "a b c d e", correct: "x" })).toBe(false);
    expect(isLearnable({ heard: "x", correct: "!!" })).toBe(false);
    expect(isLearnable({ heard: "sharma g", correct: "शर्मा जी" })).toBe(true);
  });
  it("locates the dictated text inside the edited field", () => {
    expect(editedInsertion("Dear team, send it to VSPR team. Thanks", "Dear team, ", " Thanks")).toBe("send it to VSPR team.");
    expect(editedInsertion("changed prefix send it", "Dear team, ", "")).toBeNull();
    expect(detectCorrection("send it to wisper team.", "Hi send it to VSPR team.", "Hi ", "")).toEqual({
      heard: "wisper",
      correct: "VSPR",
    });
    expect(detectCorrection("send it", "Hi send it", "Hi ", "")).toBeNull();
  });
});

describe("push-to-talk", () => {
  const H = "ControlRight";
  const run = (events: [("down" | "up"), Parameters<typeof pttKeyDown>[1]][]) => {
    let s: PttState = initialPtt;
    const out: (string | null)[] = [];
    for (const [kind, e] of events) {
      const [next, ev] = kind === "down" ? pttKeyDown(s, e, H) : pttKeyUp(s, e, H);
      s = next;
      out.push(ev);
    }
    return out.filter(Boolean);
  };
  it("hold and release dictates; key repeat is ignored", () => {
    expect(run([["down", { code: H, ctrlKey: true }], ["down", { code: H, repeat: true, ctrlKey: true }], ["up", { code: H }]])).toEqual([
      "start",
      "stop",
    ]);
  });
  it("a shortcut typed while holding cancels instead of transcribing", () => {
    expect(run([["down", { code: H, ctrlKey: true }], ["down", { code: "KeyC", ctrlKey: true }], ["up", { code: H }]])).toEqual([
      "start",
      "cancel",
    ]);
  });
  it("other modifiers already held make it a chord, not dictation", () => {
    expect(run([["down", { code: H, ctrlKey: true, shiftKey: true }], ["up", { code: H }]])).toEqual([]);
  });
  it("refuses hotkeys that would break typing", () => {
    expect(isAllowedHotkey("ControlRight")).toBe(true);
    expect(isAllowedHotkey("F8")).toBe(true);
    expect(isAllowedHotkey("KeyA")).toBe(false);
    expect(isAllowedHotkey("Space")).toBe(false);
  });
});

describe("vocabulary import and widget text", async () => {
  const { parseImport } = await import("@/components/voice/vocabulary");
  const { tail } = await import("@/components/voice/voice-bubble");
  it("parses one term per line with sounds-like forms", () => {
    expect(parseImport("Sitelytc, site lytic; sight lit sea\n# comment\n\nVAPT\nTruhome\ttrue home")).toEqual([
      { term: "Sitelytc", sounds_like: ["site lytic", "sight lit sea"] },
      { term: "VAPT", sounds_like: [] },
      { term: "Truhome", sounds_like: ["true home"] },
    ]);
  });
  it("shows the end of long text", () => {
    expect(tail("short")).toBe("short");
    const t = tail("the quick brown fox jumps over the lazy dog ".repeat(4), 30);
    expect(t.startsWith("…")).toBe(true);
    expect(t.endsWith("lazy dog")).toBe(true);
    expect(t.length).toBeLessThanOrEqual(30);
  });
});

describe("hands-free pause detector", () => {
  const feed = (levels: number[], dt = 100) => {
    let s = initialVad;
    for (let i = 0; i < levels.length; i++) {
      const [next, ev] = vadStep(s, levels[i]!, dt);
      s = next;
      if (ev) return { ev, at: (i + 1) * dt };
    }
    return { ev: null, at: levels.length * dt };
  };
  const speech = (ms: number) => Array(ms / 100).fill(0.4);
  const quiet = (ms: number) => Array(ms / 100).fill(0.02);

  it("finishes after speech followed by a pause", () => {
    const r = feed([...quiet(500), ...speech(1500), ...quiet(2000)]);
    expect(r.ev).toBe("finish");
    expect(r.at).toBe(500 + 1500 + VAD.pauseMs);
  });
  it("short gaps between words don't finish it", () => {
    expect(feed([...speech(800), ...quiet(900), ...speech(800), ...quiet(900)]).ev).toBeNull();
  });
  it("a click or cough is not speech", () => {
    expect(feed([0.6, ...quiet(3000)]).ev).toBeNull();
  });
  it("gives up when nothing is heard", () => {
    const r = feed(quiet(VAD.nothingMs + 500));
    expect(r.ev).toBe("nothing-heard");
    expect(r.at).toBe(VAD.nothingMs);
  });
  it("in-between levels keep the pause timer where it is (hysteresis)", () => {
    expect(feed([...speech(500), ...Array(30).fill(0.1)]).ev).toBeNull();
  });
});
