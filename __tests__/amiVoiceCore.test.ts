import { describe, it, expect, vi } from "vitest";
import { AmiVoiceCore } from "../src/core/AmiVoiceCore";
import { AmiVoiceError } from "../src/errorCodes";
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

  it("derives `speakers` from finalized segments only (final-only; ADR 0007)", async () => {
    const f = fakeProvider();
    const core = new AmiVoiceCore(f.provider);
    const seen: string[] = [];
    core.addEventListener("ami-voice:speakers-changed", () => seen.push("speakers"));
    await core.start();

    // interim must NOT touch speakers
    f.handlers().onInterim({ text: "こん", tokens: [{ written: "こん", spoken: "こん", confidence: 0.5, starttime: 0, endtime: 1, label: "0" }] });
    expect(core.speakers).toHaveLength(0);
    expect(seen).toHaveLength(0);

    f.handlers().onFinal({
      text: "おはよう", confidence: 0.9, starttime: 0, endtime: 1,
      tokens: [{ written: "おはよう", spoken: "おはよう", confidence: 0.9, starttime: 0, endtime: 1, label: "0" }],
    });
    f.handlers().onFinal({
      text: "こんにちは", confidence: 0.8, starttime: 1, endtime: 2,
      tokens: [{ written: "こんにちは", spoken: "こんにちは", confidence: 0.8, starttime: 1, endtime: 2, label: "1" }],
    });

    expect(core.speakers).toEqual([
      { label: "0", text: "おはよう", starttime: 0, endtime: 1, confidence: 0.9 },
      { label: "1", text: "こんにちは", starttime: 1, endtime: 2, confidence: 0.8 },
    ]);
    expect(seen).toHaveLength(2); // one emit per finalized segment

    core.reset();
    expect(core.speakers).toHaveLength(0);
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

  it("redacts an authorization=<APPKEY> echo before it reaches the bound `error` (wire path)", async () => {
    // A non-ok upstream `s` ack echoes the raw command, which ends in the
    // permanent APPKEY. In relay mode the Core's `error` is serialized over the
    // remote wire to the browser, so the APPKEY MUST be scrubbed (SPEC §14).
    const provider: IAmiVoiceProvider = {
      openRealtimeSession: async () => {
        throw new AmiVoiceError("", "s LSB16K -a-general authorization=PERMANENT-APPKEY rejected");
      },
      recognizeFile: async () => [],
    };
    const core = new AmiVoiceCore(provider);
    const seen: string[] = [];
    core.addEventListener("ami-voice:error", (e) => {
      const detail = (e as CustomEvent).detail as Error | null;
      if (detail) seen.push(detail.message);
    });

    await core.start();

    const emitted = (core.error as Error).message;
    expect(emitted).toContain("authorization=<redacted>");
    expect(emitted).not.toContain("PERMANENT-APPKEY");
    // The same redacted value is what the emitted event (and thus the wire) carries.
    expect(seen.some((m) => m.includes("PERMANENT-APPKEY"))).toBe(false);
  });

  it("stop() awaits the provider graceful stop and tears down", async () => {
    const f = fakeProvider();
    const core = new AmiVoiceCore(f.provider);
    await core.start();
    await core.stop();
    expect(f.session.stop).toHaveBeenCalledTimes(1);
    expect(core.recognizing).toBe(false);
    expect(core.connected).toBe(false);
  });

  it("abort() drops the live session immediately", async () => {
    const f = fakeProvider();
    const core = new AmiVoiceCore(f.provider);
    await core.start();
    core.abort();
    expect(f.session.abort).toHaveBeenCalledTimes(1);
    expect(core.recognizing).toBe(false);
  });

  it("recognizeFile appends normalized segments to transcript/segments and clears loading", async () => {
    const provider: IAmiVoiceProvider = {
      openRealtimeSession: async () => ({ feedAudio() {}, async stop() {}, abort() {} }),
      recognizeFile: async () => [{ text: "ファイル", confidence: 0.7, starttime: 0, endtime: 1, tokens: [] }],
    };
    const core = new AmiVoiceCore(provider);
    const segs = await core.recognizeFile(new Uint8Array([1, 2]));
    expect(segs).toHaveLength(1);
    expect(core.transcript).toBe("ファイル");
    expect(core.segments).toHaveLength(1);
    expect(core.loading).toBe(false);
  });

  it("recognizeFile publishes failures to `error` and returns []", async () => {
    const provider: IAmiVoiceProvider = {
      openRealtimeSession: async () => ({ feedAudio() {}, async stop() {}, abort() {} }),
      recognizeFile: async () => { throw new Error("file boom"); },
    };
    const core = new AmiVoiceCore(provider);
    const segs = await core.recognizeFile(new Uint8Array([1]));
    expect(segs).toEqual([]);
    expect(core.error).toBeInstanceOf(Error);
    expect(core.loading).toBe(false);
  });

  it("recognizeFile that resolves AFTER a reset() does not repopulate the cleared state", async () => {
    // reset()/abort() during an in-flight recognizeFile() must win: the consumer
    // asked for a clean slate, so file results that arrive afterwards must not be
    // re-appended onto the cleared transcript/segments/speakers/confidence.
    // (Mirrors the start()/stop() handshake-generation guard for the file path.)
    let resolveFile!: (segs: Array<{ text: string; confidence: number; starttime: number; endtime: number; tokens: [] }>) => void;
    const provider: IAmiVoiceProvider = {
      openRealtimeSession: async () => ({ feedAudio() {}, async stop() {}, abort() {} }),
      recognizeFile: () => new Promise((r) => { resolveFile = r; }),
    };
    const core = new AmiVoiceCore(provider);

    const pending = core.recognizeFile(new Uint8Array([1, 2])); // suspends on the poll
    core.reset();                                               // consumer clears mid-flight
    resolveFile([{ text: "ファイル", confidence: 0.7, starttime: 0, endtime: 1, tokens: [] }]);
    const segs = await pending;

    expect(segs).toEqual([]);                  // stale results dropped
    expect(core.transcript).toBe("");          // cleared state preserved
    expect(core.segments).toHaveLength(0);
    expect(core.speakers).toHaveLength(0);
    expect(core.confidence).toBe(0);
    expect(core.loading).toBe(false);
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

  // SPEC §10.1: an unsolicited upstream close must surface as `error` +
  // `connected=false` + `recognizing=false` WITHOUT discarding finalized
  // `transcript`. The session loop calls onError(upstream) then onClose; this
  // pins the Core's translation of those callbacks at the layer that owns it.
  it("on an upstream drop, sets error + connected=false but preserves finalized transcript (§10.1)", async () => {
    const f = fakeProvider();
    const core = new AmiVoiceCore(f.provider);
    await core.start();
    f.handlers().onFinal({ text: "こんにちは", confidence: 0.9, starttime: 0, endtime: 1, tokens: [] });
    expect(core.transcript).toBe("こんにちは");

    // The realtime loop reports an unsolicited mid-session drop this way.
    f.handlers().onError(new AmiVoiceError("<", "AmiVoice connection lost mid-session"));
    f.handlers().onClose();

    expect(core.error).toBeInstanceOf(Error);
    expect((core.error as AmiVoiceError).code).toBe("upstream");
    expect(core.connected).toBe(false);
    expect(core.recognizing).toBe(false);
    // The already-finalized text is NOT discarded.
    expect(core.transcript).toBe("こんにちは");
    expect(core.segments).toHaveLength(1);
  });

  it("start() is re-entrant-guarded: a second call no-ops and opens no second session", async () => {
    let opens = 0;
    const provider: IAmiVoiceProvider = {
      openRealtimeSession: async () => {
        opens++;
        return { feedAudio() {}, async stop() {}, abort() {} };
      },
      recognizeFile: async () => [],
    };
    const core = new AmiVoiceCore(provider);
    await core.start();
    const second = await core.start(); // already recognizing → null, no re-open
    expect(second).toBeNull();
    expect(opens).toBe(1);
  });

  it("abort() during the connect handshake releases the resolving session, does not resurrect it", async () => {
    // A disconnect / abort that races start()'s `openRealtimeSession` await must
    // NOT have the resolving start() store the session and flip recognizing back
    // on — the requested teardown would be lost and the upstream socket orphaned.
    const session: IRealtimeSession = { feedAudio: vi.fn(), stop: vi.fn(async () => {}), abort: vi.fn() };
    let resolveOpen!: (s: IRealtimeSession) => void;
    const provider: IAmiVoiceProvider = {
      openRealtimeSession: () => new Promise<IRealtimeSession>((r) => { resolveOpen = r; }),
      recognizeFile: async () => [],
    };
    const core = new AmiVoiceCore(provider);
    const starting = core.start();          // suspends on the open handshake
    core.abort();                           // caller aborts mid-handshake
    resolveOpen(session);                   // the open now resolves
    const id = await starting;

    expect(id).toBeNull();                  // start() bailed instead of committing
    expect(session.abort).toHaveBeenCalledTimes(1); // the orphaned session is released
    expect(core.recognizing).toBe(false);   // abort was honored, not reverted
    expect(core.connected).toBe(false);
    // A later abort() on the Core must not touch the (already-released) session.
    expect((session.feedAudio as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it("stop() during the connect handshake releases the resolving session, does not resurrect it", async () => {
    // Symmetric to the abort() mid-handshake case: a graceful stop() while
    // start()'s `openRealtimeSession` is still pending must invalidate the
    // handshake so the resolving start() drops the orphaned session rather than
    // committing it as `recognizing=true` with a leaked upstream socket.
    const session: IRealtimeSession = { feedAudio: vi.fn(), stop: vi.fn(async () => {}), abort: vi.fn() };
    let resolveOpen!: (s: IRealtimeSession) => void;
    const provider: IAmiVoiceProvider = {
      openRealtimeSession: () => new Promise<IRealtimeSession>((r) => { resolveOpen = r; }),
      recognizeFile: async () => [],
    };
    const core = new AmiVoiceCore(provider);
    const starting = core.start();          // suspends on the open handshake
    await core.stop();                      // caller stops mid-handshake
    resolveOpen(session);                   // the open now resolves
    const id = await starting;

    expect(id).toBeNull();                  // start() bailed instead of committing
    expect(session.abort).toHaveBeenCalledTimes(1); // the orphaned session is released
    expect(session.stop).not.toHaveBeenCalled();    // no graceful flush on an unconnected session
    expect(core.recognizing).toBe(false);   // stop was honored, not reverted
    expect(core.connected).toBe(false);
  });

  it("stop() publishes a graceful-stop failure to `error` and still tears down", async () => {
    const provider: IAmiVoiceProvider = {
      openRealtimeSession: async () => ({
        feedAudio() {},
        stop: async () => { throw new Error("flush failed"); },
        abort() {},
      }),
      recognizeFile: async () => [],
    };
    const core = new AmiVoiceCore(provider);
    await core.start();
    await expect(core.stop()).resolves.toBeUndefined(); // does NOT reject
    expect(core.error).toBeInstanceOf(Error);
    expect(core.recognizing).toBe(false);
    expect(core.connected).toBe(false);
  });
});
