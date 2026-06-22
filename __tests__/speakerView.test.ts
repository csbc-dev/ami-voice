import { describe, it, expect } from "vitest";
import { speakerLabelOf, toSpeakerSegment } from "../src/speakerView";
import type { RecognitionSegment, RecognitionToken } from "../src/types";

function tok(written: string, label?: string): RecognitionToken {
  return { written, spoken: written, confidence: 0.9, starttime: 0, endtime: 1, ...(label != null ? { label } : {}) };
}

function seg(text: string, tokens: RecognitionToken[]): RecognitionSegment {
  return { text, confidence: 0.8, starttime: 0, endtime: 2, tokens };
}

describe("speakerView (ADR 0007)", () => {
  it("speakerLabelOf returns the first non-empty token label", () => {
    expect(speakerLabelOf(seg("x", [tok("a"), tok("b", "spk1"), tok("c", "spk2")]))).toBe("spk1");
  });

  it("speakerLabelOf returns '' when no token is labeled (undiarized)", () => {
    expect(speakerLabelOf(seg("x", [tok("a"), tok("b")]))).toBe("");
  });

  it("speakerLabelOf ignores empty-string labels", () => {
    expect(speakerLabelOf(seg("x", [tok("a", ""), tok("b", "spk0")]))).toBe("spk0");
  });

  it("toSpeakerSegment projects label + segment timing/confidence (no token leakage)", () => {
    const s = toSpeakerSegment(seg("こんにちは", [tok("こん", "0"), tok("にちは", "0")]));
    expect(s).toEqual({ label: "0", text: "こんにちは", starttime: 0, endtime: 2, confidence: 0.8 });
    expect(s).not.toHaveProperty("tokens");
  });
});
