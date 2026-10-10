import { describe, it, expect, afterEach, vi } from "vitest";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import { WebSocketServerTransport, WebSocketClientTransport, createRemoteCoreProxy } from "@wc-bindable/remote";
import { bind } from "@wc-bindable/core";
import { createAmiVoiceRelayServer, type AmiVoiceControlSession } from "../../src/createAmiVoiceServer";
import { AmiVoiceProvider } from "../../src/providers/AmiVoiceProvider";
import { AmiVoiceCore } from "../../src/core/AmiVoiceCore";
import { DirectBrowserProvider } from "../../src/components/realtimeSocket";
import type { DirectSessionInfo } from "../../src/types";
import { startFakeAmiVoice, type FakeAmiVoiceHandle } from "../support/fakeAmiVoice";
import { wsSocketFactory } from "../support/wsSocketFactory";
import { createShell, stubMic, waitFor, type NodeShell } from "../support/nodeShell";

/** Fake `issue_service_authorization` — hands back a canned one-time token. */
function fakeIssueFetch(token: string): typeof fetch {
  return (async () => ({ ok: true, text: async () => token })) as unknown as typeof fetch;
}

interface DirectServer {
  controlUrl: string;
  close(): Promise<void>;
}

/**
 * A DIRECT-mode server: it only mints (control channel) — it never opens an
 * upstream WSS and runs no binary audio channel. `amivoiceUrl` is what the mint
 * tells the browser to connect to directly.
 */
async function startDirectServer(amivoiceUrl: string): Promise<DirectServer> {
  const relay = createAmiVoiceRelayServer({
    transport: "direct",
    createProvider: () => new AmiVoiceProvider({
      appKey: "PERMANENT-APPKEY",
      realtimeEndpoint: amivoiceUrl,
      realtimeNoLogEndpoint: amivoiceUrl,
      issueEndpoint: "https://issue.local/auth",
      fetch: fakeIssueFetch("ONE-TIME-TOKEN"),
    }),
  });

  const controlSessions = new Map<unknown, AmiVoiceControlSession>();
  const controlWss = new WebSocketServer({ port: 0 });
  controlWss.on("connection", (sock, req) => {
    const session = relay.handleControlConnection(
      new WebSocketServerTransport(sock),
      { peerAddress: req.socket.remoteAddress ?? undefined },
    );
    controlSessions.set(sock, session);
    sock.on("close", () => { session.dispose(); controlSessions.delete(sock); });
  });

  await once(controlWss, "listening");
  return {
    controlUrl: `ws://127.0.0.1:${(controlWss.address() as AddressInfo).port}/`,
    close: async () => {
      for (const s of controlSessions.values()) s.dispose();
      await new Promise<void>((r) => controlWss.close(() => r()));
    },
  };
}

let fake: FakeAmiVoiceHandle | undefined;
let server: DirectServer | undefined;
let unbind: (() => void) | undefined;
let shell: NodeShell | undefined;

afterEach(async () => {
  unbind?.();
  await server?.close();
  await fake?.close();
  unbind = undefined; server = undefined; fake = undefined;
});

describe("browser-direct end-to-end (ADR 0006)", () => {
  it("mints over the control channel, then recognizes with audio bypassing the server", async () => {
    fake = await startFakeAmiVoice();
    server = await startDirectServer(fake.url);

    // Control channel — used ONLY to forward inputs + mint on start().
    const controlWs = new WebSocket(server.controlUrl);
    const controlProxy = createRemoteCoreProxy(AmiVoiceCore.wcBindable, new WebSocketClientTransport(controlWs));
    await controlProxy.setWithAck("engine", "-a-general");
    await controlProxy.setWithAck("codec", "LSB16K");

    // The "browser": an in-page Core whose direct provider mints via the control
    // proxy, then opens the (fake) AmiVoice WSS itself and streams audio direct.
    const provider = new DirectBrowserProvider(
      () => controlProxy.invoke("start") as Promise<DirectSessionInfo>,
      { socketFactory: wsSocketFactory },
    );
    const core = new AmiVoiceCore(provider);
    const values: Record<string, unknown> = {};
    unbind = bind(core, (name, value) => { values[name] = value; });

    await core.start();
    await waitFor(() => values.recognizing === true);
    expect(values.connected).toBe(true);

    // Audio goes straight to AmiVoice (the fake), never through the server.
    core.feedAudio(new Uint8Array([1, 2, 3, 4]));
    await waitFor(() => values.interim === "こん");

    await core.stop();
    await waitFor(() => values.transcript === "こんにちは");
    expect((values.segments as unknown[]).length).toBe(1);

    // Exactly one upstream connection — the browser's. The server opened none.
    expect(fake.connectionCount()).toBe(1);

    controlWs.close();
  });
});

/**
 * SPEC §10.2 in direct mode: the `<ami-voice transport="direct">` Shell's
 * in-page Core opens the AmiVoice WSS itself (Node's native WebSocket here), so
 * the previous upstream socket's late `close` and a still-draining graceful stop
 * hit the in-page Core exactly as they hit the server Core in relay mode.
 */
describe("<ami-voice transport=\"direct\"> Shell over real sockets: start() right behind stop() / abort() / reset()", () => {
  afterEach(() => {
    shell?.disconnectedCallback();
    shell = undefined;
    vi.unstubAllGlobals();
  });

  it.each(["stop", "abort", "reset"] as const)("%s() then an immediate start() mints and records into a new session", async (cancel) => {
    fake = await startFakeAmiVoice();
    server = await startDirectServer(fake.url);
    shell = await createShell();
    const el = shell;
    el.setAttribute("transport", "direct");
    el.setAttribute("remote-url", server.controlUrl);
    const mics = stubMic(el);
    el.connectedCallback();
    await el.start();
    await waitFor(() => fake!.connections()[0]?.audioFrames > 0);

    void el[cancel]();
    await el.start();

    // The re-armed mic feeds the SECOND upstream session; the first one closed
    // and its late close event did not end the new one.
    await waitFor(() => (fake!.connections()[1]?.audioFrames ?? 0) > 0);
    await waitFor(() => fake!.connections()[0].open === false);
    await new Promise((r) => setTimeout(r, 100));
    expect(mics()).toBe(2);
    expect(el.error).toBeNull();
    expect(el.recognizing).toBe(true);
    expect(fake.connections().map((c) => c.open)).toEqual([false, true]);

    await el.stop();
    await waitFor(() => fake!.connections()[1].open === false);
    expect(el.transcript).toBe(cancel === "stop" ? "こんにちはこんにちは" : "こんにちは");
  });
});
