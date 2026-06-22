import { describe, it, expect, vi } from "vitest";
import { createAmiVoiceRelayServer, type AudioSocketLike } from "../src/createAmiVoiceServer";
import type {
  IAmiVoiceProvider, RecognitionOptions, DirectSessionInfo,
} from "../src/types";

// RemoteShellProxy only needs send / onMessage / onClose / dispose to construct.
function fakeTransport() {
  return { send: vi.fn(), onMessage: vi.fn(), onClose: vi.fn(), dispose: vi.fn() } as never;
}

interface Captured {
  opts?: RecognitionOptions;
  mintOpts?: { ipa?: string; epi?: number };
}

function directProvider(captured: Captured): IAmiVoiceProvider {
  return {
    openRealtimeSession: async () => { throw new Error("direct mode must not open an upstream session"); },
    recognizeFile: async () => [],
    prepareDirectSession: async (opts, mintOpts): Promise<DirectSessionInfo> => {
      captured.opts = opts;
      captured.mintOpts = mintOpts;
      return { endpoint: "wss://acp-api.amivoice.com/v1/", sCommand: `s ${opts.codec} ${opts.engine} authorization=OT` };
    },
  };
}

class FakeAudioSocket implements AudioSocketLike {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  close = vi.fn();
}

describe("createAmiVoiceRelayServer (direct transport, ADR 0006)", () => {
  it("start() mints approved-s + one-time key bound to the peer IP, opens no audio session", async () => {
    const captured: Captured = {};
    const server = createAmiVoiceRelayServer({ transport: "direct", createProvider: () => directProvider(captured) });

    const ctrl = server.handleControlConnection(fakeTransport(), { peerAddress: "203.0.113.7" });
    ctrl.core.engine = "-a-general";
    ctrl.core.codec = "LSB16K";

    const info = await ctrl.core.start();
    expect(info).toEqual({ endpoint: "wss://acp-api.amivoice.com/v1/", sCommand: "s LSB16K -a-general authorization=OT" });
    expect(captured.mintOpts).toEqual({ ipa: "203.0.113.7", epi: 30 });

    // Direct mode has no audio channel / session table.
    expect(server.sessionCount()).toBe(0);
    expect(server.handleAudioConnection(new FakeAudioSocket(), "whatever")).toBe(false);
  });

  it("degrades to a shorter expiry with no ipa when the peer address is unknown (Q12)", async () => {
    const captured: Captured = {};
    const server = createAmiVoiceRelayServer({ transport: "direct", createProvider: () => directProvider(captured) });
    const ctrl = server.handleControlConnection(fakeTransport()); // no peerAddress
    ctrl.core.engine = "-a-general";
    ctrl.core.codec = "LSB16K";
    await ctrl.core.start();
    expect(captured.mintOpts).toEqual({ epi: 10 });
  });

  it("honors custom epi / epiWithoutIpa options", async () => {
    const withIp: Captured = {};
    const noIp: Captured = {};
    const s1 = createAmiVoiceRelayServer({ transport: "direct", epi: 20, epiWithoutIpa: 5, createProvider: () => directProvider(withIp) });
    const c1 = s1.handleControlConnection(fakeTransport(), { peerAddress: "198.51.100.4" });
    c1.core.engine = "-a-general"; c1.core.codec = "LSB16K";
    await c1.core.start();
    expect(withIp.mintOpts).toEqual({ ipa: "198.51.100.4", epi: 20 });

    const s2 = createAmiVoiceRelayServer({ transport: "direct", epi: 20, epiWithoutIpa: 5, createProvider: () => directProvider(noIp) });
    const c2 = s2.handleControlConnection(fakeTransport());
    c2.core.engine = "-a-general"; c2.core.codec = "LSB16K";
    await c2.core.start();
    expect(noIp.mintOpts).toEqual({ epi: 5 });
  });

  it("relay transport is unchanged: start() still mints a session token", async () => {
    const relayProvider: IAmiVoiceProvider = {
      openRealtimeSession: async () => ({ feedAudio: () => {}, stop: async () => {}, abort: () => {} }),
      recognizeFile: async () => [],
    };
    const server = createAmiVoiceRelayServer({ createProvider: () => relayProvider }); // default relay
    const ctrl = server.handleControlConnection(fakeTransport());
    const token = await ctrl.core.start();
    expect(typeof token).toBe("string");
    expect(server.sessionCount()).toBe(1);
  });
});
