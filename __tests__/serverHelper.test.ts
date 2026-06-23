import { describe, it, expect, vi } from "vitest";
import { createAmiVoiceRelayServer, type AudioSocketLike } from "../src/createAmiVoiceServer";
import type {
  IAmiVoiceProvider, IRealtimeSession, RealtimeSessionHandlers, RecognitionOptions,
} from "../src/types";

// RemoteShellProxy only needs send / onMessage / onClose to construct.
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
  fire(data: unknown): void { this.onmessage?.({ data }); }
}

describe("createAmiVoiceRelayServer", () => {
  it("mints a session token on start() and routes audio frames into the Core", async () => {
    const session = fakeSession();
    const server = createAmiVoiceRelayServer({ createProvider: () => fakeProvider(session) });

    const ctrl = server.handleControlConnection(fakeTransport());
    const token = await ctrl.core.start();
    expect(typeof token).toBe("string");
    expect(server.sessionCount()).toBe(1);

    const audio = new FakeAudioSocket();
    expect(server.handleAudioConnection(audio, token as string)).toBe(true);

    audio.fire(new Uint8Array([1, 2, 3]));
    expect(session.feedAudio).toHaveBeenCalledTimes(1);
    expect((session.feedAudio as ReturnType<typeof vi.fn>).mock.calls[0][0]).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("rejects an audio connection with an unknown token", () => {
    const server = createAmiVoiceRelayServer({ createProvider: () => fakeProvider(fakeSession()) });
    const audio = new FakeAudioSocket();
    expect(server.handleAudioConnection(audio, "no-such-token")).toBe(false);
    expect(audio.close).toHaveBeenCalled();
  });

  it("dispose() removes the session", async () => {
    const server = createAmiVoiceRelayServer({ createProvider: () => fakeProvider(fakeSession()) });
    const ctrl = server.handleControlConnection(fakeTransport());
    await ctrl.core.start();
    expect(server.sessionCount()).toBe(1);
    ctrl.dispose();
    expect(server.sessionCount()).toBe(0);
  });

  it("reaps the session token when recognition ends (no dangling entry until control close)", async () => {
    const server = createAmiVoiceRelayServer({ createProvider: () => fakeProvider(fakeSession()) });
    const ctrl = server.handleControlConnection(fakeTransport());
    await ctrl.core.start();
    expect(server.sessionCount()).toBe(1);

    // A graceful stop (or an upstream drop) ends the session: `recognizing→false`
    // must reap the token so sessionCount() does not over-report a live session.
    await ctrl.core.stop();
    expect(server.sessionCount()).toBe(0);

    // A fresh start() re-mints a new token (the previous one was reaped).
    const token2 = await ctrl.core.start();
    expect(typeof token2).toBe("string");
    expect(server.sessionCount()).toBe(1);
  });

  it("converts ArrayBuffer audio payloads too", async () => {
    const session = fakeSession();
    const server = createAmiVoiceRelayServer({ createProvider: () => fakeProvider(session) });
    const ctrl = server.handleControlConnection(fakeTransport());
    const token = await ctrl.core.start();
    const audio = new FakeAudioSocket();
    server.handleAudioConnection(audio, token as string);
    audio.fire(new Uint8Array([9, 9]).buffer);
    expect(session.feedAudio).toHaveBeenCalledTimes(1);
  });

  it("converts a typed-array VIEW with a non-zero byteOffset to the exact bytes", async () => {
    const session = fakeSession();
    const server = createAmiVoiceRelayServer({ createProvider: () => fakeProvider(session) });
    const ctrl = server.handleControlConnection(fakeTransport());
    const token = await ctrl.core.start();
    const audio = new FakeAudioSocket();
    server.handleAudioConnection(audio, token as string);

    // A view onto a larger buffer with a non-zero offset (a `ws` Buffer-slice case).
    const backing = new Uint8Array([0, 0, 1, 2, 3]);
    const view = new Uint8Array(backing.buffer, 2, 3); // [1,2,3]
    // Hand it as a DataView to exercise the ArrayBuffer.isView (non-Uint8Array) branch.
    const dv = new DataView(backing.buffer, 2, 3);
    audio.fire(dv);

    expect(session.feedAudio).toHaveBeenCalledTimes(1);
    const got = (session.feedAudio as ReturnType<typeof vi.fn>).mock.calls[0][0] as Uint8Array;
    expect(Array.from(got)).toEqual(Array.from(view));
  });

  it("ignores a text frame on the audio channel (no feedAudio)", async () => {
    const session = fakeSession();
    const server = createAmiVoiceRelayServer({ createProvider: () => fakeProvider(session) });
    const ctrl = server.handleControlConnection(fakeTransport());
    const token = await ctrl.core.start();
    const audio = new FakeAudioSocket();
    server.handleAudioConnection(audio, token as string);

    audio.fire("not audio");
    expect(session.feedAudio).not.toHaveBeenCalled();
  });
});
