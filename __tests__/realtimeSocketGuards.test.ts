import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { createRemoteCoreProxy } from "@wc-bindable/remote";
import { bind } from "@wc-bindable/core";
import {
  createAmiVoiceRelayServer, type AmiVoiceServerLogEvent, type AudioSocketLike,
} from "../src/createAmiVoiceServer";
import { AmiVoiceCore } from "../src/core/AmiVoiceCore";
import { AmiVoiceProvider, type AmiVoiceProviderOptions } from "../src/providers/AmiVoiceProvider";
import { DirectBrowserProvider } from "../src/components/realtimeSocket";
import { AmiVoice } from "../src/components/AmiVoice";
import type { RealtimeSocket } from "../src/protocol/realtimeSession";
import type { DirectSessionInfo } from "../src/types";
import { memoryTransportPair, captureConsole, type MemoryTransportPair } from "./support/memoryTransport";
import { reachableStrings } from "./support/reachableStrings";

/**
 * A realtime socket that throws AFTER the handshake, or reports `open` after
 * the handshake settled, run through the REAL `@wc-bindable/remote` 0.10
 * `RemoteShellProxy` / `RemoteCoreProxy` (in-memory transport), the real
 * server helper (`createAmiVoiceRelayServer`, its binary audio channel
 * included), the real `AmiVoiceProvider` / `DirectBrowserProvider`, and the
 * real `<ami-voice>` Shell with its real `MicCapture` frame callback.
 *
 *  1. An audio frame whose `send` throws. The relay's audio-channel listener
 *     (`ws` `message`) and the mic's frame callback call `feedAudio`, so the
 *     throw used to reach the server process (`uncaughtException`, unredacted:
 *     Node exits) or — caught by `MicCapture` — the Shell's `error` once per
 *     frame, while the session stayed `recognizing` with its upstream open.
 *  2. A graceful stop whose `socket.close()` throws: the throw escaped the `e`
 *     ack / the close / the fallback timer and the stop never settled — the
 *     Core stayed `recognizing`, the Shell held every later start() behind it.
 *  3. A socket that reports `open` after the handshake failed: it was sent the
 *     `s` command — the APPKEY.
 */

/** The permanent APPKEY (registered by the provider) and a one-time APPKEY (not registered). */
const APPKEY = "PERMANENT-APPKEY-guards-7d2a";
const ONE_TIME = "ONE-TIME-APPKEY-guards-c51e";
const SECRETS = [APPKEY, ONE_TIME];

/** The `s` command, as `<redacted>` shows it. */
const S_REDACTED = "s LSB16K -a-general authorization=<redacted>";

/** What the failed audio send says: a custom socket quoting the `s` command its session opened with. */
const AUDIO_SEND_ERROR = { name: "Error", message: `audio send failed on the session opened with ${S_REDACTED}` };

/** The strings reachable from `roots` that hold either APPKEY. */
function leaks(...roots: unknown[]): string[] {
  return roots.flatMap((root) => reachableStrings(root)).filter((s) => SECRETS.some((secret) => s.includes(secret)));
}

/** Every uncaught exception / unhandled rejection of the worker, and every global `error` event, while a test runs. */
let unhandled: unknown[] = [];
const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
const onWindowError = (e: Event): void => { unhandled.push((e as ErrorEvent).error ?? e); };

const h = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("@wc-bindable/remote", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@wc-bindable/remote")>();
  return {
    ...actual,
    // The Shell's control channel (direct mode) rides the in-memory client end.
    WebSocketClientTransport: class {
      constructor() { return h.client as never; }
    },
  };
});

beforeAll(() => {
  if (!customElements.get("ami-voice")) customElements.define("ami-voice", AmiVoice);
});
beforeEach(() => {
  unhandled = [];
  process.on("uncaughtException", onUnhandled);
  process.on("unhandledRejection", onUnhandled);
  window.addEventListener("error", onWindowError);
});
afterEach(() => {
  process.off("uncaughtException", onUnhandled);
  process.off("unhandledRejection", onUnhandled);
  window.removeEventListener("error", onWindowError);
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** Flush the in-memory transport (microtasks) and the sockets' macrotasks. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

/** Settle `p` within `ms`, or reject: a stop() that never settles must fail the test, not hang it. */
function within<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`not settled within ${ms}ms`)), ms)),
  ]);
}

// ── a scripted AmiVoice upstream for the provider's `socketFactory` ──────────

/** One upstream connection of {@link guardedUpstream}. */
interface GuardedConn {
  /** The text frames it received (`s`, `e`). */
  readonly sent: string[];
  /** The `s` command it received, once it did. */
  sCommand?: string;
  /** Binary (`p`) sends attempted on it. */
  audioAttempts: number;
  /** `close()` calls it received. */
  closeCalls: number;
  /** It has reported `open`. */
  opened: boolean;
}

interface GuardedUpstreamOptions {
  /** What a binary (`p`) send throws, if anything. */
  audioThrows?: (conn: GuardedConn) => unknown;
  /**
   * `close()`: `"async"` reports `onclose` on a macrotask (like a platform
   * socket), `"silent"` never reports (a custom socket's no-op close),
   * `"throws"` throws.
   */
  close?: "async" | "silent" | "throws";
  /** How the upstream answers `e`: its ack (default), a close, or nothing (the stop's fallback timer settles). */
  onStop?: "ack" | "close" | "none";
  /** Report `open` this many ms late (after a connect deadline) instead of on a microtask. */
  openAfterMs?: number;
  /** Report a socket error on a microtask, before `open`. */
  errorBeforeOpen?: boolean;
}

function guardedUpstream(opts: GuardedUpstreamOptions = {}): {
  socketFactory: (url: string) => RealtimeSocket;
  conns: GuardedConn[];
  /** Every value a binary send threw. */
  thrown: unknown[];
} {
  const conns: GuardedConn[] = [];
  const thrown: unknown[] = [];
  return {
    socketFactory: () => {
      const conn: GuardedConn = { sent: [], audioAttempts: 0, closeCalls: 0, opened: false };
      conns.push(conn);
      let open = true;
      const s: RealtimeSocket = {
        send: (d) => {
          if (typeof d !== "string") {
            conn.audioAttempts++;
            if (opts.audioThrows) {
              const value = opts.audioThrows(conn);
              thrown.push(value);
              throw value;
            }
            return;
          }
          conn.sent.push(d);
          if (d.startsWith("s ")) {
            conn.sCommand = d;
            queueMicrotask(() => s.onmessage?.("s"));
          } else if (d === "e") {
            if (opts.onStop === "close") setTimeout(() => s.onclose?.(), 0);
            else if (opts.onStop !== "none") queueMicrotask(() => s.onmessage?.("e"));
          }
        },
        close: () => {
          conn.closeCalls++;
          if (opts.close === "throws") throw new Error("close failed");
          if (opts.close === "silent" || !open) return;
          open = false;
          setTimeout(() => s.onclose?.(), 0);
        },
        onopen: null, onmessage: null, onclose: null, onerror: null,
      };
      const reportOpen = (): void => { conn.opened = true; s.onopen?.(); };
      if (opts.errorBeforeOpen) queueMicrotask(() => s.onerror?.({ type: "error" }));
      if (opts.openAfterMs !== undefined) setTimeout(reportOpen, opts.openAfterMs);
      else queueMicrotask(reportOpen);
      return s;
    },
    conns,
    thrown,
  };
}

/** The failed audio send of a custom socket, quoting the `s` command (APPKEY included) its session opened with. */
const audioSendError = (conn: GuardedConn): Error =>
  new Error(`audio send failed on the session opened with ${conn.sCommand}`);

// ── relay: the server helper behind the real remote proxies ──────────────────

/**
 * The server end of the browser's binary audio channel, as the `ws` library
 * hands it over: an `EventEmitter` that emits `message` from its socket's I/O
 * callback. A listener that throws there is the server process's uncaught
 * exception — `ws` installs no handler, so Node exits.
 */
class WsAudioSocket extends EventEmitter implements AudioSocketLike {
  closed = false;
  close(): void { this.closed = true; }
  /** Receive one binary frame from the browser, the way `ws` dispatches it. */
  receive(bytes: number[]): Promise<void> {
    return new Promise((resolve) => {
      setImmediate(() => {
        try { this.emit("message", Buffer.from(bytes), true); } finally { resolve(); }
      });
    });
  }
}

/** A relay server over the real `AmiVoiceProvider` (`socketFactory` upstream), a client bound to it, and the log. */
function relaySetup(socketFactory: (url: string) => RealtimeSocket, provider: AmiVoiceProviderOptions = {}) {
  const events: AmiVoiceServerLogEvent[] = [];
  const relay = createAmiVoiceRelayServer({
    createProvider: () => new AmiVoiceProvider({ appKey: APPKEY, socketFactory, ...provider }),
    logger: (e) => events.push(e),
  });
  const pair = memoryTransportPair();
  const ctrl = relay.handleControlConnection(pair.server);
  const proxy = createRemoteCoreProxy(AmiVoiceCore.wcBindable, pair.client);
  const values: Record<string, unknown> = {};
  bind(proxy, (name, value) => { values[name] = value; });
  return { relay, pair, ctrl, events, proxy, values };
}

/** The non-null `error` updates that crossed the wire to the client. */
function errorUpdates(pair: MemoryTransportPair): unknown[] {
  return pair.wire
    .filter((f) => f.startsWith("S:"))
    .map((f) => JSON.parse(f.slice(2)) as { type: string; name?: string; value?: unknown })
    .filter((m) => m.type === "update" && m.name === "error" && m.value !== null)
    .map((m) => m.value);
}

describe("relay: the upstream socket throws while sending an audio frame (SPEC §17)", () => {
  it.each([
    ["a close that never reports (a custom socket)", "silent"],
    ["a close reported later (like a platform socket)", "async"],
    ["a close that throws", "throws"],
  ] as const)("%s: one `error` on the client, the session ends, nothing reaches the server process", async (_label, close) => {
    const con = captureConsole();
    const upstream = guardedUpstream({ audioThrows: audioSendError, close });
    const { relay, pair, ctrl, events, proxy, values } = relaySetup(upstream.socketFactory);
    const token = await proxy.invoke("start");
    expect(values.recognizing).toBe(true);
    const audio = new WsAudioSocket();
    expect(relay.handleAudioConnection(audio, token as string)).toBe(true);

    for (let i = 0; i < 3; i++) await audio.receive([1, 2, 3]);
    await settle();

    expect(unhandled).toEqual([]); // the server process never saw it
    expect(upstream.conns[0].audioAttempts).toBe(1); // nothing more is sent on the failed socket
    expect(values.error).toStrictEqual(AUDIO_SEND_ERROR);
    expect(errorUpdates(pair)).toStrictEqual([AUDIO_SEND_ERROR]); // exactly once — no "connection lost" behind it
    expect(values).toMatchObject({ recognizing: false, connected: false, loading: false });
    expect(ctrl.core.originalError).toBe(upstream.thrown[0]); // the thrown instance, redacted in place
    expect(upstream.conns[0].closeCalls).toBeGreaterThanOrEqual(1);
    expect(relay.sessionCount()).toBe(0); // the audio token is reaped with the session
    expect(events.filter((e) => e.type === "error")).toStrictEqual([
      expect.objectContaining({ type: "error", message: AUDIO_SEND_ERROR.message }),
    ]);

    // stop() / abort() afterwards are safe, and a new start() is accepted.
    await within(proxy.invoke("stop"), 1000);
    proxy.invoke("abort");
    await settle();
    expect(errorUpdates(pair)).toHaveLength(1);
    expect(values.error).toStrictEqual(AUDIO_SEND_ERROR);
    await expect(proxy.invoke("start")).resolves.toEqual(expect.any(String));
    expect(upstream.conns).toHaveLength(2);

    expect(leaks(ctrl.core.originalError, events, pair.wire, con.messages(), unhandled)).toEqual([]);
    expect(unhandled).toEqual([]);
    expect(con.wireDrops()).toEqual([]);
  });
});

describe("relay: the upstream socket's close() throws when a graceful stop settles (SPEC §18)", () => {
  it.each([
    ["its ack", "ack"],
    ["a close (it hangs up after `e`)", "close"],
    ["nothing (the stop's fallback timer settles)", "none"],
  ] as const)("the upstream answers `e` with %s: stop() settles, the session ends, nothing escapes", async (_label, onStop) => {
    const con = captureConsole();
    const upstream = guardedUpstream({ close: "throws", onStop });
    const { relay, pair, proxy, values } = relaySetup(upstream.socketFactory, { stopTimeoutMs: 20 });
    await proxy.invoke("start");
    expect(values.recognizing).toBe(true);

    await within(proxy.invoke("stop"), 1000);

    expect(values).toMatchObject({ recognizing: false, connected: false, loading: false, error: null });
    expect(upstream.conns[0].sent).toEqual([sCommandOf(upstream.conns[0]), "e"]);
    expect(upstream.conns[0].closeCalls).toBe(1);
    expect(relay.sessionCount()).toBe(0);
    expect(errorUpdates(pair)).toEqual([]);
    expect(unhandled).toEqual([]);

    // The Core is not stuck `recognizing`: the next start opens a new session.
    await expect(proxy.invoke("start")).resolves.toEqual(expect.any(String));
    expect(values.recognizing).toBe(true);
    expect(upstream.conns).toHaveLength(2);
    expect(con.wireDrops()).toEqual([]);
  });
});

/** The `s` command `conn` received. */
function sCommandOf(conn: GuardedConn): string {
  expect(conn.sCommand).toBeDefined();
  return conn.sCommand as string;
}

describe("relay: a socket that reports `open` after the handshake failed (SPEC §14)", () => {
  it.each([
    ["the connect deadline fired", { openAfterMs: 60, close: "silent" }, "AmiVoice did not ack the start command within 10ms"],
    ["a socket error", { openAfterMs: 20, errorBeforeOpen: true, close: "silent" }, "AmiVoice socket error"],
    ["the connect deadline fired (a close that throws)", { openAfterMs: 60, close: "throws" }, "AmiVoice did not ack the start command within 10ms"],
  ] as const)("after %s: the late `open` is sent no `s` command (no APPKEY), and the socket is closed again", async (_label, opts, message) => {
    const con = captureConsole();
    const upstream = guardedUpstream(opts);
    const { pair, ctrl, events, proxy, values } = relaySetup(upstream.socketFactory, { connectTimeoutMs: 10 });

    await expect(proxy.invoke("start")).resolves.toBeNull(); // publishes, never rejects (SPEC §17)
    expect(values.error).toMatchObject({ message, code: "upstream" });
    expect(values).toMatchObject({ loading: false, recognizing: false, connected: false });
    const conn = upstream.conns[0];
    const closesBefore = conn.closeCalls;

    await vi.waitFor(() => expect(conn.opened).toBe(true)); // the late open arrived
    await settle();

    expect(conn.sent).toEqual([]); // the credential never went out on the abandoned socket
    expect(conn.closeCalls).toBe(closesBefore + 1);
    expect(errorUpdates(pair)).toHaveLength(1);
    expect(values).toMatchObject({ loading: false, recognizing: false, connected: false });
    expect(leaks(ctrl.core.originalError, events, pair.wire, con.messages(), unhandled)).toEqual([]);
    expect(unhandled).toEqual([]);
  });

  it("direct: the in-page Core's late `open` is sent no `s` command (no one-time APPKEY)", async () => {
    captureConsole();
    const fetch = (async () => ({ ok: true, status: 200, text: async () => ONE_TIME })) as unknown as typeof globalThis.fetch;
    const relay = createAmiVoiceRelayServer({
      transport: "direct",
      createProvider: () => new AmiVoiceProvider({ appKey: APPKEY, fetch }),
    });
    const pair = memoryTransportPair();
    relay.handleControlConnection(pair.server);
    const proxy = createRemoteCoreProxy(AmiVoiceCore.wcBindable, pair.client);
    const mint = (): Promise<DirectSessionInfo> => proxy.invoke("start") as Promise<DirectSessionInfo>;
    const upstream = guardedUpstream({ openAfterMs: 20, errorBeforeOpen: true, close: "silent" });
    const core = new AmiVoiceCore(new DirectBrowserProvider(mint, { socketFactory: upstream.socketFactory }));

    await expect(core.start()).resolves.toBeNull();
    expect(core.error).toMatchObject({ message: "AmiVoice socket error", code: "upstream" });

    await vi.waitFor(() => expect(upstream.conns[0].opened).toBe(true));
    await settle();

    expect(upstream.conns[0].sent).toEqual([]);
    expect(upstream.conns[0].closeCalls).toBe(1);
    expect(core).toMatchObject({ loading: false, recognizing: false, connected: false });
    expect(unhandled).toEqual([]);
  });
});

// ── local / direct: the real Shell and its real MicCapture frame callback ────

type Shell = HTMLElement & Pick<AmiVoice, "start" | "stop" | "error" | "recognizing" | "connected" | "loading"> & {
  _core: AmiVoiceCore | null;
};

/** Every non-null `ami-voice:error` detail the element dispatches. */
function errorsOf(el: HTMLElement): unknown[] {
  const seen: unknown[] = [];
  el.addEventListener("ami-voice:error", (e) => {
    const d = (e as CustomEvent).detail;
    if (d != null) seen.push(d);
  });
  return seen;
}

/**
 * The browser-only mic (`getUserMedia` → `AudioContext` → `AudioWorklet`),
 * faked under the REAL `MicCapture`: `frame()` posts one worklet frame, which
 * `MicCapture` encodes and hands to the Shell's frame callback (→ the in-page
 * Core's `feedAudio`).
 */
function stubMicrophone(): { frame(): void; live(): boolean; tracksStopped(): boolean } {
  const track = { stopped: false, stop(): void { this.stopped = true; } };
  const nodes: FakeWorkletNode[] = [];
  class FakeWorkletNode {
    port = { onmessage: null as ((e: { data: unknown }) => void) | null };
    constructor() { nodes.push(this); }
    disconnect(): void { /* nothing to disconnect */ }
  }
  class FakeAudioContext {
    sampleRate = 16000;
    audioWorklet = { addModule: async (): Promise<void> => {} };
    createMediaStreamSource(): { connect(): void; disconnect(): void } { return { connect() {}, disconnect() {} }; }
    close = async (): Promise<void> => {};
  }
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [track] }) } });
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("AudioWorkletNode", FakeWorkletNode);
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:worklet");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  return {
    frame: () => nodes.at(-1)?.port.onmessage?.({ data: new Float32Array(160) }),
    live: () => nodes.at(-1)?.port.onmessage != null,
    tracksStopped: () => track.stopped,
  };
}

/**
 * The platform `WebSocket` the in-page provider opens through `wrapWebSocket`.
 * An AmiVoice endpoint acks `s` and `e`; per the options its binary `send`
 * throws (quoting the `s` command its session opened with) or its `close()`
 * throws. Any other URL — the Shell's control channel, whose traffic rides
 * the in-memory transport — stays inert.
 */
function upstreamWebSocket(opts: { audioThrows?: boolean; closeThrows?: boolean }): {
  sockets: Array<{ sent: string[]; audioAttempts: number; closeCalls: number }>;
  thrown: unknown[];
} {
  const sockets: Array<{ sent: string[]; audioAttempts: number; closeCalls: number }> = [];
  const thrown: unknown[] = [];
  class UpstreamWebSocket {
    static readonly OPEN = 1;
    readyState = 0;
    binaryType = "blob";
    bufferedAmount = 0;
    onopen: (() => void) | null = null;
    onmessage: ((e: { data: unknown }) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    private readonly _log: { sent: string[]; audioAttempts: number; closeCalls: number } | null = null;
    constructor(readonly url: string) {
      if (!url.startsWith("wss://acp-api.amivoice.com/")) return; // the control channel
      this._log = { sent: [], audioAttempts: 0, closeCalls: 0 };
      sockets.push(this._log);
      queueMicrotask(() => { this.readyState = 1; this.onopen?.(); });
    }
    send(d: unknown): void {
      const log = this._log;
      if (!log) return;
      if (typeof d !== "string") {
        log.audioAttempts++;
        if (opts.audioThrows) {
          const err = new Error(`audio send failed on the session opened with ${log.sent[0]}`);
          thrown.push(err);
          throw err;
        }
        return;
      }
      log.sent.push(d);
      if (d.startsWith("s ") || d === "e") queueMicrotask(() => this.onmessage?.({ data: d[0] }));
    }
    close(): void {
      const log = this._log;
      if (!log) return;
      log.closeCalls++;
      if (opts.closeThrows) throw new Error("close failed");
      if (this.readyState === 3) return;
      this.readyState = 3;
      setTimeout(() => this.onclose?.(), 0);
    }
  }
  vi.stubGlobal("WebSocket", UpstreamWebSocket);
  return { sockets, thrown };
}

function mountLocal(): Shell {
  vi.stubEnv("AMIVOICE_APPKEY", APPKEY);
  const el = document.createElement("ami-voice") as Shell;
  el.setAttribute("mode", "local");
  document.body.appendChild(el);
  return el;
}

function mountDirect(): Shell {
  const fetch = (async () => ({ ok: true, status: 200, text: async () => ONE_TIME })) as unknown as typeof globalThis.fetch;
  const relay = createAmiVoiceRelayServer({
    transport: "direct",
    createProvider: () => new AmiVoiceProvider({ appKey: APPKEY, fetch }),
  });
  const pair = memoryTransportPair();
  relay.handleControlConnection(pair.server);
  h.client = pair.client;
  const el = document.createElement("ami-voice") as Shell;
  el.setAttribute("mode", "remote");
  el.setAttribute("transport", "direct");
  el.setAttribute("remote-url", "ws://localhost:0/ctl");
  document.body.appendChild(el);
  return el;
}

describe.each([
  ["local (in-page Core, permanent APPKEY)", mountLocal],
  ["direct (in-page Core, one-time APPKEY)", mountDirect],
])("%s: the upstream socket throws while sending an audio frame (SPEC §17)", (_label, mount) => {
  it("the Core publishes it once, the session ends and the mic stops; nothing reaches the global error", async () => {
    const con = captureConsole();
    const ws = upstreamWebSocket({ audioThrows: true });
    const mic = stubMicrophone();
    const el = mount();
    const errors = errorsOf(el);

    await el.start();
    expect(el.recognizing).toBe(true);
    expect(mic.live()).toBe(true);

    for (let i = 0; i < 3 && mic.live(); i++) mic.frame();
    await settle();

    expect(ws.sockets).toHaveLength(1);
    expect(ws.sockets[0].audioAttempts).toBe(1);
    expect(errors).toStrictEqual([AUDIO_SEND_ERROR]); // the Core's, once — not one per frame
    expect(el.error).toStrictEqual(AUDIO_SEND_ERROR);
    expect(el._core!.originalError).toBe(ws.thrown[0]);
    expect(el).toMatchObject({ recognizing: false, connected: false, loading: false });
    expect(mic.live()).toBe(false); // the Shell tore the data plane down with the session
    expect(mic.tracksStopped()).toBe(true);
    expect(ws.sockets[0].closeCalls).toBeGreaterThanOrEqual(1);
    expect(leaks(el._core!.originalError, errors, con.messages(), unhandled)).toEqual([]);
    expect(unhandled).toEqual([]);
  });
});

describe("local: the upstream socket's close() throws when a graceful stop settles (SPEC §18)", () => {
  it("el.stop() settles, and an el.start() right behind it opens a new session", async () => {
    captureConsole();
    const ws = upstreamWebSocket({ closeThrows: true });
    stubMicrophone();
    const el = mountLocal();
    const errors = errorsOf(el);

    await el.start();
    expect(el.recognizing).toBe(true);

    await within(el.stop(), 1000);
    expect(el).toMatchObject({ recognizing: false, connected: false });

    await within(el.start(), 1000); // not held behind a stop that never settles (SPEC §10.2)
    expect(el.recognizing).toBe(true);
    expect(ws.sockets).toHaveLength(2);

    // End the second session the same way. (The element's teardown would
    // abort a live one, and `abort()`'s own close is not guarded.)
    await within(el.stop(), 1000);
    expect(el.recognizing).toBe(false);
    expect(ws.sockets.map((s) => s.closeCalls)).toEqual([1, 1]);
    expect(errors).toEqual([]);
    expect(unhandled).toEqual([]);
  });
});
