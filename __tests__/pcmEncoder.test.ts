import { describe, it, expect } from "vitest";
import {
  floatTo16BitPCM, downsampleTo16k, encodeLSB16K, frameLevel,
} from "../src/audio/pcmEncoder";

describe("pcmEncoder", () => {
  it("clamps and scales float samples to int16", () => {
    const pcm = floatTo16BitPCM(new Float32Array([0, 1, -1, 2, -2, 0.5]));
    expect(pcm[0]).toBe(0);
    expect(pcm[1]).toBe(32767);
    expect(pcm[2]).toBe(-32768);
    expect(pcm[3]).toBe(32767); // clamped from 2
    expect(pcm[4]).toBe(-32768); // clamped from -2
    expect(pcm[5]).toBe(16383); // 0.5 * 32767, truncated toward zero
  });

  it("downsamples 48 kHz to 16 kHz at 3:1", () => {
    const out = downsampleTo16k(new Float32Array(48), 48000);
    expect(out.length).toBe(16);
  });

  it("returns the input unchanged when already at 16 kHz", () => {
    const input = new Float32Array([0.1, 0.2]);
    expect(downsampleTo16k(input, 16000)).toBe(input);
  });

  it("refuses to upsample", () => {
    expect(() => downsampleTo16k(new Float32Array([0]), 8000)).toThrow();
  });

  it("encodes little-endian 16-bit PCM bytes (LSB16K)", () => {
    // full-scale 1.0 -> int16 32767 (0x7FFF) -> little-endian bytes FF 7F
    const bytes = encodeLSB16K(new Float32Array([1]), 16000);
    expect(bytes.length).toBe(2);
    expect(bytes[0]).toBe(0xff);
    expect(bytes[1]).toBe(0x7f);
  });

  it("computes an RMS level", () => {
    expect(frameLevel(new Float32Array([]))).toBe(0);
    expect(frameLevel(new Float32Array([1, -1]))).toBeCloseTo(1);
  });
});
