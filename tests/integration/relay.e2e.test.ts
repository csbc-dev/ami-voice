import { describe, it, expect, afterEach } from "vitest";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import {
  WebSocketServerTransport, WebSocketClientTransport, createRemoteCoreProxy,
} from "@wc-bindable/remote";
import { bind } from "@wc-bindable/core";
import { createAmiVoiceRelayServer, type AmiVoiceControlSession } from "../../src/createAmiVoiceServer";
import { AmiVoiceProvider } from "../../src/providers/AmiVoiceProvider";
import { AmiVoiceCore } from "../../src/core/AmiVoiceCore";
import { startFakeAmiVoice, type FakeAmiVoiceHandle } from "../support/fakeAmiVoice";
import { wsSocketFactory } from "../support/wsSocketFactory";

async function waitFor(pred: () => boolean, timeoutMs = 10000, stepMs = 20): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

interface RelayServer {
  controlUrl: string;
  audioUrl: string;
  close(): Promise<void>;
}

async function startRelayServer(amivoiceUrl: string): Promise<RelayServer> {
  const relay = createAmiVoiceRelayServer({
    createProvider: () => new AmiVoiceProvider({
      appKey: "TEST",
      realtimeEndpoint: amivoiceUrl,
      realtimeNoLogEndpoint: amivoiceUrl,
      socketFactory: wsSocketFactory,
    }),
  });

  const sessions = new Map<unknown, AmiVoiceControlSession>();
  const controlWss = new WebSocketServer({ port: 0 });
  controlWss.on("connection", (sock) => {
    const session = relay.handleControlConnection(new WebSocketServerTransport(sock));
    sessions.set(sock, session);
    sock.on("close", () => { session.dispose(); sessions.delete(sock); });
  });

  // Echo the requested subprotocol so the audio session token survives the
  // handshake (SPEC §11.3 — token in Sec-WebSocket-Protocol).
  const audioWss = new WebSocketServer({
    port: 0,
    handleProtocols: (protocols) => [...protocols][0] ?? false,
  });
  audioWss.on("connection", (sock) => relay.handleAudioConnection(sock, sock.protocol));

  await Promise.all([once(controlWss, "listening"), once(audioWss, "listening")]);
  return {
    controlUrl: `ws://127.0.0.1:${(controlWss.address() as AddressInfo).port}/`,
    audioUrl: `ws://127.0.0.1:${(audioWss.address() as AddressInfo).port}/`,
    close: async () => {
      for (const s of sessions.values()) s.dispose();
      await new Promise<void>((r) => controlWss.close(() => r()));
      await new Promise<void>((r) => audioWss.close(() => r()));
    },
  };
}

let fake: FakeAmiVoiceHandle | undefined;
let server: RelayServer | undefined;
let unbind: (() => void) | undefined;

afterEach(async () => {
  unbind?.();
  await server?.close();
  await fake?.close();
  unbind = undefined; server = undefined; fake = undefined;
});

describe("relay end-to-end (control + binary audio)", () => {
  it("transcribes through client proxy ↔ relay ↔ fake AmiVoice", async () => {
    fake = await startFakeAmiVoice();
    server = await startRelayServer(fake.url);

    // Client control channel — the same surface a browser binds to.
    const controlWs = new WebSocket(server.controlUrl);
    const proxy = createRemoteCoreProxy(AmiVoiceCore.wcBindable, new WebSocketClientTransport(controlWs));
    const values: Record<string, unknown> = {};
    unbind = bind(proxy, (name, value) => { values[name] = value; });

    await proxy.setWithAck("engine", "-a-general");
    await proxy.setWithAck("codec", "LSB16K");

    // start() returns the audio-channel session token.
    const token = await proxy.invoke("start");
    expect(typeof token).toBe("string");
    await waitFor(() => values.recognizing === true);
    expect(values.connected).toBe(true);

    // Binary audio channel, bound to the session token.
    const audioWs = new WebSocket(server.audioUrl, [token as string]);
    await waitFor(() => audioWs.readyState === WebSocket.OPEN);
    audioWs.send(new Uint8Array([1, 2, 3, 4]));

    // Audio → server → Core → provider → fake → `U` → back to the client.
    await waitFor(() => values.interim === "こん");

    // Graceful stop → fake emits final `A` then `e` ack.
    await proxy.invoke("stop");
    await waitFor(() => values.transcript === "こんにちは");
    expect((values.segments as unknown[]).length).toBe(1);

    audioWs.close();
    controlWs.close();
  });

  it("rejects an audio connection bearing an unknown session token", async () => {
    fake = await startFakeAmiVoice();
    server = await startRelayServer(fake.url);

    const audioWs = new WebSocket(server.audioUrl, ["bogus-token"]);
    // The server validates the token and closes immediately.
    await once(audioWs, "close");
    expect(audioWs.readyState).toBe(WebSocket.CLOSED);
  });
});
