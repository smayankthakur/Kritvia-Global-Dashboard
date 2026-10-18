import { describe, expect, it } from "vitest";
import { STT_LABELS, TTS_LABELS, keyNeeded } from "@/components/calls/speech";

describe("call voice settings", () => {
  it("asks only for the keys the chosen providers need", () => {
    expect(keyNeeded("platform", "platform")).toEqual([]);
    expect(keyNeeded("sarvam", "sarvam")).toEqual(["sarvam"]);
    expect(keyNeeded("deepgram", "elevenlabs")).toEqual(["deepgram", "elevenlabs"]);
    expect(keyNeeded("local", "openai")).toEqual(["openai"]);
  });

  it("offers every provider the API accepts", () => {
    expect(Object.keys(STT_LABELS).sort()).toEqual(["deepgram", "local", "openai", "platform", "sarvam"]);
    expect(Object.keys(TTS_LABELS).sort()).toEqual(["elevenlabs", "local", "openai", "platform", "sarvam"]);
  });
});
