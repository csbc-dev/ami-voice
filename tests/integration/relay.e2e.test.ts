import { describe, it, expect, afterEach, vi } from "vitest";
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
import { getErrorCode } from "../../src/errorCodes";
import { startFakeAmiVoice, type FakeAmiVoiceHandle } from "../support/fakeAmiVoice";
import { wsSocketFactory } from "../support/wsSocketFactory";
import { createShell, stubMic, waitFor, type NodeShell } from "../support/nodeShell";

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
  // The control port also accepts the audio channel, routed by subprotocol
  // presence like the example / browser harness (a single-port relay): the
  // `<ami-voice>` Shell opens its audio channel on the control URL.
  const controlWss = new WebSocketServer({
    port: 0,
    handleProtocols: (protocols) => [...protocols][0] ?? false,
  });
  controlWss.on("connection", (sock) => {
    if (sock.protocol) {
      relay.handleAudioConnection(sock, sock.protocol);
      return;
    }
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
let shell: NodeShell | undefined;

afterEach(async () => {
  shell?.disconnectedCallback();
  unbind?.();
  await server?.close();
  await fake?.close();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  unbind = undefined; server = undefined; fake = undefined; shell = undefined;
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

  // @wc-bindable/remote >= 0.10 drops a non-JsonValue property value, so an
  // `AmiVoiceError` instance on the Core's `error` never reached the client.
  // These pin the failure paths over real sockets (SPEC §10.1, §17).
  it("a rejected start publishes the (redacted) cause to the client's `error`", async () => {
    fake = await startFakeAmiVoice({ rejectStart: "authorization=TEST rejected" });
    server = await startRelayServer(fake.url);

    const controlWs = new WebSocket(server.controlUrl);
    const proxy = createRemoteCoreProxy(AmiVoiceCore.wcBindable, new WebSocketClientTransport(controlWs));
    const values: Record<string, unknown> = {};
    unbind = bind(proxy, (name, value) => { values[name] = value; });

    await expect(proxy.invoke("start")).resolves.toBeNull(); // SPEC §17: publish, don't reject
    expect(values.error).toStrictEqual({
      name: "AmiVoiceError",
      message: "authorization=<redacted> rejected",
      code: "unknown",
      resultCode: "",
      retryable: true,
    });
    expect(getErrorCode(values.error)).toBe("unknown");
    expect(values.recognizing).toBe(false);
    expect(values.loading).toBe(false);
    controlWs.close();
  });

  it("an upstream drop mid-session reaches the client as `error`=upstream + connected=false (§10.1)", async () => {
    fake = await startFakeAmiVoice();
    server = await startRelayServer(fake.url);

    const controlWs = new WebSocket(server.controlUrl);
    const proxy = createRemoteCoreProxy(AmiVoiceCore.wcBindable, new WebSocketClientTransport(controlWs));
    const values: Record<string, unknown> = {};
    unbind = bind(proxy, (name, value) => { values[name] = value; });

    expect(typeof await proxy.invoke("start")).toBe("string");
    await waitFor(() => values.connected === true);

    fake.dropAll();

    await waitFor(() => values.error != null);
    expect(getErrorCode(values.error)).toBe("upstream");
    expect(values.error).toMatchObject({ name: "AmiVoiceError", message: "AmiVoice connection lost mid-session" });
    expect(values.connected).toBe(false);
    expect(values.recognizing).toBe(false);
    controlWs.close();
  });

  // SPEC §10.2 / README quick start: `<ami-voice>`.start() right after connect,
  // before the control channel is even open (so before its initial `sync`). The
  // sync's `recognizing=false` predates the start; it used to tear the pending
  // start down, leaving a server session with no mic attached.
  it("the <ami-voice> Shell: start() before the initial sync streams the mic into the session", async () => {
    fake = await startFakeAmiVoice();
    server = await startRelayServer(fake.url);
    shell = await createShell();
    const el = shell;
    el.setAttribute("mode", "remote");
    el.setAttribute("remote-url", server.controlUrl);
    el.setAttribute("engine", "-a-general");
    el.setAttribute("codec", "LSB16K");
    let micArmed = false;
    el._startMic = async (onFrame) => {
      micArmed = true; // stands in for getUserMedia → AudioWorklet → PCM
      const audio = el._audioWs!;
      await waitFor(() => audio.readyState === WebSocket.OPEN);
      onFrame(new Uint8Array([1, 2, 3, 4]));
    };

    el.connectedCallback(); // opens the control channel (still CONNECTING)
    await el.start();

    expect(micArmed).toBe(true);
    // Mic frame → audio channel → relay → Core → fake → `U` → control channel.
    await waitFor(() => el.interim === "こん");
    await el.stop();
    await waitFor(() => el.transcript === "こんにちは");
    expect(el.error).toBeNull();
  });

  it("engine=\"\" / codec=\"\" from the client: the server's `s` command uses the defaults", async () => {
    fake = await startFakeAmiVoice();
    server = await startRelayServer(fake.url);

    const controlWs = new WebSocket(server.controlUrl);
    const proxy = createRemoteCoreProxy(AmiVoiceCore.wcBindable, new WebSocketClientTransport(controlWs));
    await proxy.setWithAck("engine", "");
    await proxy.setWithAck("codec", "");

    expect(typeof await proxy.invoke("start")).toBe("string");
    expect(fake.connections()[0].startCommand).toBe("s LSB16K -a-general authorization=TEST");
    await proxy.invoke("abort");
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

/**
 * SPEC §10.2: `el.stop(); el.start()` (a "start over" button, toggling during a
 * recording) and `abort()` / `reset()` + `start()` must record into a NEW
 * session. Over real sockets two things broke it: the Core refused a start that
 * arrived while the previous session was still draining its graceful stop
 * ("already active"), and the previous upstream socket's `close` event — which a
 * real WebSocket delivers after `abort()` / the stop's `close()` returned — was
 * applied to the next session (its handshake aborted: "the server opened no
 * recognition session"). `fake.connections()` shows every upstream socket, so a
 * session the Core forgot but never closed would stay `open`.
 */
describe("<ami-voice> Shell over real sockets: start() right behind stop() / abort() / reset()", () => {
  /** Wait until the first upstream socket closed and its (late) close event reached the Core. */
  async function firstUpstreamClosed(f: FakeAmiVoiceHandle): Promise<void> {
    await waitFor(() => f.connections()[0]?.open === false);
    await new Promise((r) => setTimeout(r, 100));
  }

  async function expectNewSession(el: NodeShell, f: FakeAmiVoiceHandle, mics: () => number): Promise<void> {
    // The mic was re-armed and its frame reached the SECOND upstream session.
    await waitFor(() => (f.connections()[1]?.audioFrames ?? 0) > 0);
    await firstUpstreamClosed(f);
    expect(mics()).toBe(2);
    expect(el.error).toBeNull();
    expect(el.recognizing).toBe(true);
    expect(f.connections().map((c) => c.open)).toEqual([false, true]);
    await el.stop();
    await waitFor(() => f.connections()[1].open === false);
    expect(el.recognizing).toBe(false);
  }

  async function relayShell(): Promise<{ el: NodeShell; mics: () => number }> {
    fake = await startFakeAmiVoice();
    server = await startRelayServer(fake.url);
    shell = await createShell();
    const el = shell;
    el.setAttribute("mode", "remote");
    el.setAttribute("remote-url", server.controlUrl);
    const mics = stubMic(el);
    el.connectedCallback();
    await el.start();
    await waitFor(() => fake!.connections()[0]?.audioFrames > 0);
    return { el, mics };
  }

  /** Local (dev) mode: the in-page provider talks to the fake over Node's native WebSocket. */
  async function localShell(): Promise<{ el: NodeShell; mics: () => number }> {
    fake = await startFakeAmiVoice();
    vi.stubEnv("AMIVOICE_APPKEY", "TEST");
    vi.spyOn(AmiVoiceProvider.prototype, "endpointFor").mockReturnValue(fake.url);
    shell = await createShell();
    const el = shell;
    el.setAttribute("mode", "local");
    const mics = stubMic(el);
    el.connectedCallback();
    await el.start();
    await waitFor(() => fake!.connections()[0]?.audioFrames > 0);
    return { el, mics };
  }

  const shells = { relay: relayShell, local: localShell } as const;
  const cases = (["relay", "local"] as const).flatMap((mode) =>
    (["stop", "abort", "reset"] as const).map((cancel) => [mode, cancel] as const));

  it.each(cases)("%s: %s() then an immediate start() records into a new session", async (mode, cancel) => {
    const { el, mics } = await shells[mode]();

    void el[cancel]();
    await el.start();

    await expectNewSession(el, fake!, mics);
    // The new session's final result — after, for a graceful stop, the old
    // session's trailing one (abort drops it; reset also clears the transcript).
    expect(el.transcript).toBe(cancel === "stop" ? "こんにちはこんにちは" : "こんにちは");
  });

  it.each(["relay", "local"] as const)("%s: rapid toggling while recording ends in one new session", async (mode) => {
    const { el, mics } = await shells[mode]();

    void el.stop();
    void el.start(); // superseded before it is ever sent
    void el.stop();
    await el.start();

    await expectNewSession(el, fake!, mics);
    expect(fake!.connectionCount()).toBe(2);
  });
});
