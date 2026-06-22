import { describe, it, expect } from "vitest";
import {
  shouldSendFrame, createRateLimiter, DEFAULT_MAX_AUDIO_BUFFER,
} from "../src/audio/flowControl";

describe("flowControl", () => {
  it("shouldSendFrame drops once the buffer exceeds the cap", () => {
    expect(shouldSendFrame(0, 1000)).toBe(true);
    expect(shouldSendFrame(1000, 1000)).toBe(true);
    expect(shouldSendFrame(1001, 1000)).toBe(false);
  });

  it("createRateLimiter yields at most once per interval", () => {
    let t = 0;
    const limit = createRateLimiter(100, () => t);
    expect(limit()).toBe(true); // first call at t=0
    expect(limit()).toBe(false); // still t=0
    t = 99; expect(limit()).toBe(false);
    t = 100; expect(limit()).toBe(true);
    t = 150; expect(limit()).toBe(false);
    t = 200; expect(limit()).toBe(true);
  });

  it("exposes a 1 MiB default audio buffer cap", () => {
    expect(DEFAULT_MAX_AUDIO_BUFFER).toBe(1048576);
  });
});
