import { describe, it, expect, vi } from "vitest";
import {
  createAmiVoiceRelayServer,
  type AudioSocketLike, type AmiVoiceServerLogEvent,
} from "../src/createAmiVoiceServer";
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

  it("defaults to a no-op logger (no throw without a logger)", async () => {
    const server = createAmiVoiceRelayServer({ createProvider: () => fakeProvider(fakeSession()) });
    const ctrl = server.handleControlConnection(fakeTransport());
    await ctrl.core.start();
    expect(() => ctrl.dispose()).not.toThrow();
  });
});
