import { describe, it, expect, vi } from "vitest";
import { AmiVoiceCore } from "../src/core/AmiVoiceCore";
import type {
  IAmiVoiceProvider, IRealtimeSession, RealtimeSessionHandlers,
} from "../src/types";

function fakeProvider() {
  let captured: RealtimeSessionHandlers | undefined;
  const session: IRealtimeSession = {
    feedAudio: vi.fn(),
    stop: vi.fn(async () => {}),
    abort: vi.fn(),
  };
  const provider: IAmiVoiceProvider = {
    openRealtimeSession: async (_options, handlers) => {
      captured = handlers;
      return session;
    },
    recognizeFile: async () => [],
  };
  return { provider, session, handlers: () => captured! };
}

describe("AmiVoiceCore", () => {
  it("emits ami-voice:*-changed events on the injected target", async () => {
    const { provider } = fakeProvider();
    const target = new EventTarget();
    const core = new AmiVoiceCore(provider, target);
    const seen: string[] = [];
    target.addEventListener("ami-voice:recognizing-changed", () => seen.push("recognizing"));
    target.addEventListener("ami-voice:connected-changed", () => seen.push("connected"));

    await core.start();

    expect(core.recognizing).toBe(true);
    expect(core.connected).toBe(true);
    expect(seen).toContain("recognizing");
    expect(seen).toContain("connected");
  });

  it("accumulates transcript and confidence on finalized results, clearing interim", async () => {
    const f = fakeProvider();
    const core = new AmiVoiceCore(f.provider);
    await core.start();

    f.handlers().onInterim({ text: "こん", tokens: [] });
    expect(core.interim).toBe("こん");

    f.handlers().onFinal({ text: "こんにちは", confidence: 0.9, starttime: 0, endtime: 1, tokens: [] });
    expect(core.transcript).toBe("こんにちは");
    expect(core.confidence).toBe(0.9);
    expect(core.interim).toBe(""); // final clears interim
    expect(core.segments).toHaveLength(1);
  });

  it("publishes provider failures to `error` instead of throwing", async () => {
    const provider: IAmiVoiceProvider = {
      openRealtimeSession: async () => { throw new Error("boom"); },
      recognizeFile: async () => [],
    };
    const core = new AmiVoiceCore(provider);

    await expect(core.start()).resolves.toBeNull(); // does NOT reject; null = no session
    expect(core.error).toBeInstanceOf(Error);
    expect(core.recognizing).toBe(false);
  });

  it("forwards feedAudio into the live session (binary data plane)", async () => {
    const f = fakeProvider();
    const core = new AmiVoiceCore(f.provider);
    await core.start();

    core.feedAudio(new Uint8Array([1, 2, 3]));
    expect(f.session.feedAudio).toHaveBeenCalledTimes(1);
  });

  it("reset() clears state back to idle", async () => {
    const f = fakeProvider();
    const core = new AmiVoiceCore(f.provider);
    await core.start();
    f.handlers().onFinal({ text: "x", confidence: 0.5, starttime: 0, endtime: 1, tokens: [] });

    core.reset();
    expect(core.transcript).toBe("");
    expect(core.segments).toHaveLength(0);
    expect(core.confidence).toBe(0);
    expect(core.recognizing).toBe(false);
  });
});
