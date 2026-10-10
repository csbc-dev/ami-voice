import { describe, it, expect, vi } from "vitest";
import {
  createAmiVoiceRelayServer,
  type AudioSocketLike, type AmiVoiceServerLogEvent,
} from "../src/createAmiVoiceServer";
import { AmiVoiceError } from "../src/errorCodes";
import type {
  IAmiVoiceProvider, IRealtimeSession, RealtimeSessionHandlers, RecognitionOptions,
} from "../src/types";

function fakeTransport() {
  return { send: vi.fn(), onMessage: vi.fn(), onClose: vi.fn(), dispose: vi.fn() } as never;
}
function fakeSession(): IRealtimeSession {
  return { feedAudio: vi.fn(), stop: vi.fn(async () => {}), abort: vi.fn() };
}
function fakeProvider(session: IRealtimeSession): IAmiVoiceProvider {
  return {
    openRealtimeSession: async (_o: RecognitionOptions, _h: RealtimeSessionHandlers) => session,
    recognizeFile: async () => [],
  };
}
class FakeAudioSocket implements AudioSocketLike {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  close = vi.fn();
}

describe("createAmiVoiceRelayServer — injectable structured logging (3.5)", () => {
  it("logs control open/close with the transport + peer address", async () => {
    const events: AmiVoiceServerLogEvent[] = [];
    const server = createAmiVoiceRelayServer({
      createProvider: () => fakeProvider(fakeSession()),
      logger: (e) => events.push(e),
    });

    const ctrl = server.handleControlConnection(fakeTransport(), { peerAddress: "203.0.113.7" });
    ctrl.dispose();

    expect(events).toEqual([
      { type: "control-open", transport: "relay", peerAddress: "203.0.113.7" },
      { type: "control-close", transport: "relay", peerAddress: "203.0.113.7" },
    ]);
  });

  it("logs accepted and rejected audio connections (no token in the record)", async () => {
    const events: AmiVoiceServerLogEvent[] = [];
    const server = createAmiVoiceRelayServer({
      createProvider: () => fakeProvider(fakeSession()),
      logger: (e) => events.push(e),
    });
    const ctrl = server.handleControlConnection(fakeTransport());
    const token = (await ctrl.core.start()) as string;

    server.handleAudioConnection(new FakeAudioSocket(), token);
    server.handleAudioConnection(new FakeAudioSocket(), "bogus-token");

    expect(events).toContainEqual({ type: "audio-open" });
    expect(events).toContainEqual({ type: "audio-rejected", reason: "unknown-session" });
    // The bearer token must never appear in a log record (SPEC §11.3).
    expect(JSON.stringify(events)).not.toContain(token);
  });

  it("logs emitted Core errors as normalized code + message", async () => {
    const events: AmiVoiceServerLogEvent[] = [];
    const provider: IAmiVoiceProvider = {
      openRealtimeSession: async () => { throw new Error("upstream exploded"); },
      recognizeFile: async () => [],
    };
    const server = createAmiVoiceRelayServer({ createProvider: () => provider, logger: (e) => events.push(e) });

    const ctrl = server.handleControlConnection(fakeTransport());
    await ctrl.core.start(); // provider throws → Core publishes ami-voice:error

    const err = events.find((e) => e.type === "error");
    expect(err).toMatchObject({ type: "error", message: "upstream exploded" });
  });

  it("the shell SENDS the error update to the client (remote >= 0.10 no longer drops it)", async () => {
    // Before the fix the Core emitted an AmiVoiceError instance: the logger above
    // still fired, but @wc-bindable/remote 0.10 warned `dropped update for "error"`
    // and the browser never saw the failure (SPEC §17). Pin the wire side too.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const transport = fakeTransport() as unknown as { send: ReturnType<typeof vi.fn> };
    const provider: IAmiVoiceProvider = {
      openRealtimeSession: async () => { throw new AmiVoiceError("-", "illegal service authorization"); },
      recognizeFile: async () => [],
    };
    const server = createAmiVoiceRelayServer({ createProvider: () => provider, logger: () => {} });

    const ctrl = server.handleControlConnection(transport as never);
    await ctrl.core.start();

    const errorUpdates = transport.send.mock.calls.map((c) => c[0])
      .filter((m: { type: string; name?: string }) => m.type === "update" && m.name === "error");
    expect(errorUpdates).toContainEqual({
      type: "update",
      name: "error",
      value: { name: "AmiVoiceError", message: "illegal service authorization", code: "auth", resultCode: "-", retryable: false },
    });
    expect(warn.mock.calls.map((c) => String(c[0]))).not.toContainEqual(expect.stringContaining("dropped update"));
    warn.mockRestore();
  });

  it("defaults to a no-op logger (no throw without a logger)", async () => {
    const server = createAmiVoiceRelayServer({ createProvider: () => fakeProvider(fakeSession()) });
    const ctrl = server.handleControlConnection(fakeTransport());
    await ctrl.core.start();
    expect(() => ctrl.dispose()).not.toThrow();
  });

  it("redacts an authorization=<APPKEY> substring before logging a Core error (SPEC §14)", async () => {
    const events: AmiVoiceServerLogEvent[] = [];
    // Simulate an upstream non-ok `s` ack echoing the raw command back, which
    // ends in `authorization=<permanent APPKEY>` — the exact leak redactSecrets exists for.
    const provider: IAmiVoiceProvider = {
      openRealtimeSession: async () => {
        throw new Error("s LSB16K -a-general authorization=PERMANENT-APPKEY rejected");
      },
      recognizeFile: async () => [],
    };
    const server = createAmiVoiceRelayServer({ createProvider: () => provider, logger: (e) => events.push(e) });

    const ctrl = server.handleControlConnection(fakeTransport());
    await ctrl.core.start();

    const err = events.find((e) => e.type === "error") as { message: string };
    expect(err).toBeDefined();
    expect(err.message).toContain("authorization=<redacted>");
    expect(err.message).not.toContain("PERMANENT-APPKEY");
  });
});

/**
 * The helper's own socket callbacks — `dispose()` from the control socket's
 * `close` listener, the audio channel's `message` listener — run where a throw
 * is the server process's uncaught exception. What they catch is logged as an
 * `error` record (redacted, like the Core's), never thrown.
 */
describe("createAmiVoiceRelayServer — a throw caught in its own socket callbacks is logged, not thrown", () => {
  function abortThrowing(value: () => unknown): IRealtimeSession {
    return { ...fakeSession(), abort: vi.fn(() => { throw value(); }) };
  }

  it.each([
    [
      "a plain object with a code",
      () => ({ message: "teardown failed: authorization=PERMANENT-APPKEY", code: "auth" }),
      { type: "error", message: "teardown failed: authorization=<redacted>", code: "auth" },
    ],
    ["undefined", () => undefined, { type: "error", message: "undefined" }],
    [
      "a hostile value",
      () => ({ get message(): string { throw new Error("no"); } }),
      { type: "error", message: "unserializable error value" },
    ],
  ])("dispose(): a session abort() that throws %s", async (_label, value, record) => {
    const events: AmiVoiceServerLogEvent[] = [];
    const server = createAmiVoiceRelayServer({
      createProvider: () => fakeProvider(abortThrowing(value)),
      logger: (e) => events.push(e),
    });
    const ctrl = server.handleControlConnection(fakeTransport());
    await ctrl.core.start();

    expect(() => ctrl.dispose()).not.toThrow();

    expect(ctrl.core.recognizing).toBe(false);
    expect(server.sessionCount()).toBe(0);
    expect(events.filter((e) => e.type === "error")).toStrictEqual([record]);
    expect(events.at(-1)).toMatchObject({ type: "control-close" });
  });

  it("dispose(): a logger that throws on the record does not make dispose() throw", async () => {
    const events: AmiVoiceServerLogEvent[] = [];
    const server = createAmiVoiceRelayServer({
      createProvider: () => fakeProvider(abortThrowing(() => new Error("teardown failed"))),
      logger: (e) => { if (e.type === "error") throw new Error("log sink down"); events.push(e); },
    });
    const ctrl = server.handleControlConnection(fakeTransport());
    await ctrl.core.start();

    expect(() => ctrl.dispose()).not.toThrow();
    expect(events.at(-1)).toMatchObject({ type: "control-close" });
  });

  it("the audio listener: an unexpected throw is logged once per connection and the frame dropped", async () => {
    const events: AmiVoiceServerLogEvent[] = [];
    const server = createAmiVoiceRelayServer({
      createProvider: () => fakeProvider(fakeSession()),
      logger: (e) => events.push(e),
    });
    const ctrl = server.handleControlConnection(fakeTransport());
    const token = (await ctrl.core.start()) as string;
    const socket = new FakeAudioSocket();
    server.handleAudioConnection(socket, token);
    vi.spyOn(ctrl.core, "feedAudio").mockImplementation(() => { throw new Error("unexpected"); });

    expect(() => socket.onmessage!({ data: new Uint8Array([1]) })).not.toThrow();
    expect(() => socket.onmessage!({ data: new Uint8Array([2]) })).not.toThrow();

    expect(events.filter((e) => e.type === "error")).toStrictEqual([
      { type: "error", message: "unexpected", stack: expect.stringContaining("unexpected") },
    ]);
    expect(ctrl.core.error).toBeNull(); // logged only: nothing is published
    expect(ctrl.core.recognizing).toBe(true);
  });
});
