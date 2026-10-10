import { describe, it, expect, vi } from "vitest";
import { AmiVoiceCore } from "../src/core/AmiVoiceCore";
import { AmiVoiceError } from "../src/errorCodes";
import { isJsonValue } from "@wc-bindable/remote";
import { buildStartCommand } from "../src/protocol/wnnProtocol";
import type {
  IAmiVoiceProvider, IRealtimeSession, RealtimeSessionHandlers, RecognitionOptions, RecognitionSegment,
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
    // A JSON-safe plain object (not an Error instance) so it crosses the remote
    // wire (SPEC §17; remote >= 0.10 drops a non-JsonValue property value).
    expect(core.error).toStrictEqual({ name: "Error", message: "boom" });
    expect(isJsonValue(core.error)).toBe(true);
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
      const detail = (e as CustomEvent).detail as { message: string } | null;
      if (detail) seen.push(detail.message);
    });

    await core.start();

    const emitted = core.error!.message;
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
    expect(core.error).toStrictEqual({ name: "Error", message: "file boom" });
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

    expect(core.error).toStrictEqual({
      name: "AmiVoiceError",
      message: "AmiVoice connection lost mid-session",
      code: "upstream",
      resultCode: "<",
      retryable: true,
    });
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
    expect(core.error).toStrictEqual({ name: "Error", message: "flush failed" });
    expect(core.recognizing).toBe(false);
    expect(core.connected).toBe(false);
  });

  it("publishes an AmiVoiceError as a plain JSON-safe object — getter and emitted detail alike (SPEC §17)", async () => {
    const provider: IAmiVoiceProvider = {
      openRealtimeSession: async () => { throw new AmiVoiceError("-", "illegal service authorization"); },
      recognizeFile: async () => [],
    };
    const core = new AmiVoiceCore(provider);
    const details: unknown[] = [];
    core.addEventListener("ami-voice:error", (e) => details.push((e as CustomEvent).detail));

    await core.start();

    const expected = {
      name: "AmiVoiceError",
      message: "illegal service authorization",
      code: "auth",
      resultCode: "-",
      retryable: false,
    };
    expect(core.error).toStrictEqual(expected);
    expect(Object.getPrototypeOf(core.error)).toBe(Object.prototype); // not an Error instance
    expect(details).toStrictEqual([null, expected]); // cleared on start, then the cause
    expect(details[1]).toBe(core.error); // ONE object: getter === emitted detail
  });
});

/**
 * A session the Core has left (stopped / aborted / reset) can still call back:
 * a platform WebSocket fires `onclose` AFTER `abort()` / a graceful stop's
 * `close()` returned, and a graceful stop may settle after an `abort()`. None of
 * that may touch the NEXT session (SPEC §10) — it used to abort the next
 * handshake, or drop the next live session while its upstream stayed open.
 */
describe("AmiVoiceCore: callbacks of a session it already left", () => {
  function multiSessionProvider() {
    const sessions: Array<{
      handlers: RealtimeSessionHandlers; session: IRealtimeSession; finishStop: () => void; failStop: (e: unknown) => void;
    }> = [];
    let holdOpen: ((resolve: () => void) => void) | null = null;
    const provider: IAmiVoiceProvider = {
      openRealtimeSession: async (_options, handlers) => {
        let finishStop!: () => void;
        let failStop!: (e: unknown) => void;
        const stopped = new Promise<void>((resolve, reject) => { finishStop = resolve; failStop = reject; });
        const session: IRealtimeSession = { feedAudio: vi.fn(), stop: vi.fn(() => stopped), abort: vi.fn() };
        sessions.push({ handlers, session, finishStop, failStop });
        if (holdOpen) await new Promise<void>((r) => holdOpen!(r));
        return session;
      },
      recognizeFile: async () => [],
    };
    return { provider, sessions, hold: (h: typeof holdOpen) => { holdOpen = h; } };
  }

  it("a late onClose of an aborted session leaves the next live session alone", async () => {
    const f = multiSessionProvider();
    const core = new AmiVoiceCore(f.provider, undefined, { mintSessionId: () => "id" });
    await core.start();
    core.abort();
    expect(await core.start()).toBe("id");

    f.sessions[0].handlers.onClose(); // the first socket's close lands now

    expect(core.recognizing).toBe(true);
    expect(core.connected).toBe(true);
    core.feedAudio(new Uint8Array([1]));
    expect(f.sessions[1].session.feedAudio).toHaveBeenCalledTimes(1); // still routed to the live session
    core.abort();
    expect(f.sessions[1].session.abort).toHaveBeenCalledTimes(1); // and the Core can still release it
  });

  it("a late onClose of an aborted session during the next handshake does not abort it", async () => {
    const f = multiSessionProvider();
    const core = new AmiVoiceCore(f.provider, undefined, { mintSessionId: () => "id" });
    await core.start();
    core.abort();
    let open!: () => void;
    f.hold((r) => { open = r; });
    const starting = core.start();
    await Promise.resolve();

    f.sessions[0].handlers.onClose(); // lands mid-handshake
    open();

    expect(await starting).toBe("id");
    expect(f.sessions[1].session.abort).not.toHaveBeenCalled();
    expect(core.recognizing).toBe(true);
  });

  it("results / errors of an aborted session are dropped (no trailing result — SPEC §18)", async () => {
    const f = multiSessionProvider();
    const core = new AmiVoiceCore(f.provider);
    await core.start();
    core.abort();

    f.sessions[0].handlers.onInterim({ text: "late", tokens: [] });
    f.sessions[0].handlers.onFinal({ text: "late", confidence: 0.9, starttime: 0, endtime: 1, tokens: [] });
    f.sessions[0].handlers.onError(new AmiVoiceError("<", "AmiVoice connection lost mid-session"));

    expect(core.interim).toBe("");
    expect(core.transcript).toBe("");
    expect(core.segments).toHaveLength(0);
    expect(core.error).toBeNull();
  });

  it("a graceful stop that settles after abort() + a new start() leaves the new session alone", async () => {
    const f = multiSessionProvider();
    const core = new AmiVoiceCore(f.provider);
    await core.start();
    const stopping = core.stop(); // draining…
    core.abort();                 // …cut short
    await core.start();           // a new session meanwhile
    expect(core.recognizing).toBe(true);

    f.sessions[0].finishStop();   // the old drain settles late
    await stopping;

    expect(core.recognizing).toBe(true);
    expect(core.connected).toBe(true);
    core.feedAudio(new Uint8Array([1]));
    expect(f.sessions[1].session.feedAudio).toHaveBeenCalledTimes(1);
  });

  it("a graceful stop that FAILS after abort() + a new start() publishes nothing against the new session", async () => {
    const f = multiSessionProvider();
    const core = new AmiVoiceCore(f.provider);
    await core.start();
    const stopping = core.stop();
    core.abort();
    await core.start();

    f.sessions[0].failStop(new Error("flush failed")); // the old drain fails late
    await stopping;

    expect(core.error).toBeNull();
    expect(core.recognizing).toBe(true);
  });

  it("start() during a graceful stop is refused (the caller waits for its stop — SPEC §10.2)", async () => {
    const f = multiSessionProvider();
    const core = new AmiVoiceCore(f.provider);
    await core.start();
    const stopping = core.stop();

    expect(await core.start()).toBeNull(); // still `recognizing` while draining
    expect(f.sessions).toHaveLength(1);

    f.sessions[0].finishStop();
    await stopping;
    expect(core.recognizing).toBe(false);
    await core.start();
    expect(core.recognizing).toBe(true);
    expect(f.sessions).toHaveLength(2);
  });
});

/**
 * Inputs: `null` / `undefined` reset to the default (SPEC §7.2; wc-bindable
 * SPEC-extensions Producer guidance P1/P2). Remote clients cannot send
 * `undefined` (not a JsonValue), so `null` is the wire reset — and without it a
 * stored `null`/`undefined` engine/codec would be stringified into the `s` command.
 */
describe("AmiVoiceCore input reset (null / undefined)", () => {
  it("resets every input to its default on null and on undefined", () => {
    const core = new AmiVoiceCore(fakeProvider().provider) as AmiVoiceCore & Record<string, unknown>;
    const defaults = {
      engine: "-a-general", codec: "LSB16K", profileId: "", profileWords: "",
      keepFillerToken: false, resultUpdatedInterval: 0, segmenterProperties: "", noLog: false,
    };
    const set = {
      engine: "-a-medical", codec: "MSB16K", profileId: "p1", profileWords: "w",
      keepFillerToken: true, resultUpdatedInterval: 500, segmenterProperties: "useDiarizer=1", noLog: true,
    };
    for (const reset of [null, undefined]) {
      for (const [name, value] of Object.entries(set)) core[name] = value;
      for (const name of Object.keys(set)) core[name] = reset;
      for (const [name, value] of Object.entries(defaults)) expect(core[name], `${name} <- ${reset}`).toBe(value);
    }
  });

  it("a reset engine/codec builds a valid `s` command (no literal null/undefined)", async () => {
    let seen: RecognitionOptions | undefined;
    const provider: IAmiVoiceProvider = {
      openRealtimeSession: async (options) => {
        seen = options;
        return { feedAudio() {}, async stop() {}, abort() {} };
      },
      recognizeFile: async () => [],
    };
    const core = new AmiVoiceCore(provider);
    core.engine = null;
    core.codec = undefined;
    core.resultUpdatedInterval = null;
    await core.start();

    expect(seen).toMatchObject({ engine: "-a-general", codec: "LSB16K", resultUpdatedInterval: undefined });
    const s = buildStartCommand(seen!, "KEY");
    expect(s).toBe("s LSB16K -a-general authorization=KEY");
  });
});

/**
 * Segments from a CUSTOM provider are re-normalized by the Core: `segments` /
 * `speakers` cross the remote wire as strict JsonValues, and one
 * `utteranceid: undefined` / NaN confidence would make remote >= 0.10 drop every
 * later `segments` update until reset().
 */
describe("AmiVoiceCore segment normalization (custom providers)", () => {
  const sloppy = {
    text: "こんにちは",
    confidence: Number.NaN,
    starttime: 0,
    endtime: Number.POSITIVE_INFINITY,
    utteranceid: undefined,
    tokens: [{ written: "こんにちは", spoken: "こんにちは", confidence: 0.9, starttime: 0, endtime: 1, label: undefined }],
    extra: new Date(0), // not part of the public model
  } as unknown as RecognitionSegment;

  it("realtime onFinal: undefined keys omitted, non-finite numbers -> 0, unknown keys dropped", async () => {
    const f = fakeProvider();
    const core = new AmiVoiceCore(f.provider);
    await core.start();
    f.handlers().onFinal(sloppy);

    expect(core.segments).toStrictEqual([{
      text: "こんにちは", confidence: 0, starttime: 0, endtime: 0,
      tokens: [{ written: "こんにちは", spoken: "こんにちは", confidence: 0.9, starttime: 0, endtime: 1 }],
    }]);
    expect(core.confidence).toBe(0);
    expect(isJsonValue(core.segments)).toBe(true);
    expect(isJsonValue(core.speakers)).toBe(true);
  });

  it("keeps a string utteranceid and token label/language", async () => {
    const f = fakeProvider();
    const core = new AmiVoiceCore(f.provider);
    await core.start();
    f.handlers().onFinal({
      text: "x", confidence: 0.5, starttime: 1, endtime: 2, utteranceid: "u-1",
      tokens: [{ written: "x", spoken: "x", confidence: 0.5, starttime: 1, endtime: 2, label: "0", language: "ja" }],
    });
    expect(core.segments[0]).toStrictEqual({
      text: "x", confidence: 0.5, starttime: 1, endtime: 2, utteranceid: "u-1",
      tokens: [{ written: "x", spoken: "x", confidence: 0.5, starttime: 1, endtime: 2, label: "0", language: "ja" }],
    });
    expect(core.speakers[0].label).toBe("0");
  });

  it("recognizeFile normalizes the provider's segments and returns the normalized ones", async () => {
    const provider: IAmiVoiceProvider = {
      openRealtimeSession: async () => ({ feedAudio() {}, async stop() {}, abort() {} }),
      recognizeFile: async () => [sloppy],
    };
    const core = new AmiVoiceCore(provider);
    const segs = await core.recognizeFile(new Uint8Array([1]));
    expect(segs).toStrictEqual(core.segments);
    expect(isJsonValue(segs)).toBe(true);
    expect("utteranceid" in segs[0]).toBe(false);
  });

  it("keeps interim a string when a custom provider omits its text", async () => {
    const f = fakeProvider();
    const core = new AmiVoiceCore(f.provider);
    await core.start();
    f.handlers().onInterim({ text: "こん", tokens: [] });
    f.handlers().onInterim({ tokens: [] } as unknown as { text: string; tokens: [] });
    expect(core.interim).toBe("");
  });
});
