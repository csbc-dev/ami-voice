import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRemoteCoreProxy } from "@wc-bindable/remote";
import { bind } from "@wc-bindable/core";
import { createAmiVoiceRelayServer, type AmiVoiceServerLogEvent } from "../src/createAmiVoiceServer";
import { AmiVoiceCore } from "../src/core/AmiVoiceCore";
import { AmiVoiceProvider } from "../src/providers/AmiVoiceProvider";
import { DirectBrowserProvider } from "../src/components/realtimeSocket";
import type { RealtimeSocket } from "../src/protocol/realtimeSession";
import type { DirectSessionInfo, SerializedError } from "../src/types";
import {
  memoryTransportPair, captureConsole, scriptedUpstream, type MemoryTransportPair,
} from "./support/memoryTransport";
import { reachableStrings } from "./support/reachableStrings";

/**
 * A realtime socket whose `send` throws on the `s` command (SPEC §14, §17).
 * The `s` command ends in `authorization=<APPKEY>` — the permanent APPKEY in
 * relay / local mode, the one-time APPKEY in direct mode — and a socket can
 * quote what it failed to send in its exception. The loop sends `s` from the
 * socket's `onopen`, i.e. from the socket's own event dispatch, so that throw
 * used to bypass the Core (`toError` / `toSerializedError`) and reach the
 * platform's uncaught-exception reporting raw (Node: `uncaughtException`,
 * stderr and exit; a browser: the global `error` event, the console, an error
 * tracker), while start() stayed `loading` until the connect deadline and then
 * published a misleading "did not ack" timeout.
 *
 * Run through the REAL `RemoteShellProxy` / `RemoteCoreProxy`
 * (`@wc-bindable/remote` 0.10) over the JSON-serializing in-memory transport.
 * The APPKEY must appear in none of `originalError`, `error`, the logger's
 * records, the wire, the console, or an uncaught exception / unhandled
 * rejection; and the session must end exactly like an `s` the upstream rejects.
 */

/** The permanent APPKEY (registered by the provider) and a one-time APPKEY (not registered). */
const APPKEY = "PERMANENT-APPKEY-send-4b7e";
const ONE_TIME = "ONE-TIME-APPKEY-send-91c3";
const SECRETS = [APPKEY, ONE_TIME];

/** The strings reachable from `roots` that hold either APPKEY. */
function leaks(...roots: unknown[]): string[] {
  return roots.flatMap((root) => reachableStrings(root)).filter((s) => SECRETS.some((secret) => s.includes(secret)));
}

/** Every uncaught exception / unhandled rejection of the worker while a test runs. */
let unhandled: unknown[] = [];
const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
beforeEach(() => {
  unhandled = [];
  process.on("uncaughtException", onUnhandled);
  process.on("unhandledRejection", onUnhandled);
});
afterEach(() => {
  process.off("uncaughtException", onUnhandled);
  process.off("unhandledRejection", onUnhandled);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** What a socket throws when asked to send `data`. */
type Thrower = (data: string) => unknown;

/**
 * An upstream whose sockets open (from a microtask, like a platform socket's
 * open event) and throw `make(data)` from `send` for every text frame — the
 * `s` command is the first one.
 */
function throwingUpstream(make: Thrower): {
  socketFactory: (url: string) => RealtimeSocket;
  thrown: unknown[];
  /** Every socket the loop opened was closed again. */
  closed(): boolean;
} {
  const thrown: unknown[] = [];
  const sockets: Array<{ closed: boolean }> = [];
  return {
    socketFactory: () => {
      const state = { closed: false };
      sockets.push(state);
      const s: RealtimeSocket = {
        send: (d) => {
          if (typeof d !== "string") return;
          const value = make(d);
          thrown.push(value);
          throw value;
        },
        close: () => { state.closed = true; },
        onopen: null, onmessage: null, onclose: null, onerror: null,
      };
      queueMicrotask(() => s.onopen?.());
      return s;
    },
    thrown,
    closed: () => sockets.length > 0 && sockets.every((s) => s.closed),
  };
}

/** A platform-like `WebSocket` (for `wrapWebSocket`) whose `send` throws, quoting the frame. */
class ThrowingWebSocket {
  static sockets: ThrowingWebSocket[] = [];
  binaryType = "blob";
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  constructor(readonly url: string) {
    ThrowingWebSocket.sockets.push(this);
    queueMicrotask(() => this.onopen?.());
  }
  send(d: unknown): void { throw new Error(`Failed to execute 'send' on 'WebSocket': ${String(d)}`); }
  close(): void { this.closed = true; }
}

/** The `s` command, as `<redacted>` shows it. */
const S_REDACTED = "s LSB16K -a-general authorization=<redacted>";

const CASES: Array<[string, Thrower, SerializedError]> = [
  [
    "an Error whose message (and stack) quotes the `s` command",
    (d) => new Error(`WebSocket send failed: ${d}`),
    { name: "Error", message: `WebSocket send failed: ${S_REDACTED}` },
  ],
  [
    "an Error whose cause chain quotes it",
    (d) => Object.assign(new Error("WebSocket send failed"), {
      cause: Object.assign(new Error(`could not write ${d}`), { frame: { data: d }, cause: d }),
    }),
    { name: "Error", message: "WebSocket send failed" },
  ],
  [
    "a string (a non-Error throw)",
    (d) => `WebSocket send failed: ${d}`,
    { name: "Error", message: `WebSocket send failed: ${S_REDACTED}` },
  ],
  [
    "a plain object (a non-Error throw)",
    (d) => ({ name: "SendError", message: `WebSocket send failed: ${d}`, frame: d }),
    { name: "SendError", message: `WebSocket send failed: ${S_REDACTED}` },
  ],
];

function connect(pair: MemoryTransportPair) {
  const proxy = createRemoteCoreProxy(AmiVoiceCore.wcBindable, pair.client);
  const values: Record<string, unknown> = {};
  bind(proxy, (name, value) => { values[name] = value; });
  return { proxy, values };
}

/** The server → client frames that crossed the wire, parsed. */
function serverFrames(pair: MemoryTransportPair): Array<Record<string, unknown>> {
  return pair.wire.filter((f) => f.startsWith("S:")).map((f) => JSON.parse(f.slice(2)));
}

/** A relay server whose provider is the real `AmiVoiceProvider` over `socketFactory`, a client bound to it, and the log. */
function relaySetup(socketFactory: (url: string) => RealtimeSocket) {
  const events: AmiVoiceServerLogEvent[] = [];
  const relay = createAmiVoiceRelayServer({
    // A short deadline: should the throw escape again, start() fails on the
    // timeout (a wrong `error`) instead of hanging the test.
    createProvider: () => new AmiVoiceProvider({ appKey: APPKEY, socketFactory, connectTimeoutMs: 200 }),
    logger: (e) => events.push(e),
  });
  const pair = memoryTransportPair();
  const ctrl = relay.handleControlConnection(pair.server);
  const tracked: Error[] = [];
  ctrl.core.addEventListener("ami-voice:error", () => {
    if (ctrl.core.originalError) tracked.push(ctrl.core.originalError);
  });
  return { pair, ctrl, events, tracked, ...connect(pair) };
}

describe("relay: the provider's socket throws while sending the `s` command", () => {
  it.each(CASES)("%s: published like a start failure, redacted everywhere", async (_label, make, expected) => {
    const con = captureConsole();
    const upstream = throwingUpstream(make);
    const { ctrl, pair, events, tracked, proxy, values } = relaySetup(upstream.socketFactory);

    await expect(proxy.invoke("start")).resolves.toBeNull(); // publishes, never rejects (SPEC §17)

    expect(upstream.thrown).toHaveLength(1);
    expect(values.error).toStrictEqual(expected);
    expect(ctrl.core.error).toStrictEqual(expected);
    expect(values).toMatchObject({ loading: false, recognizing: false, connected: false });
    expect(upstream.closed()).toBe(true);
    expect(tracked).toHaveLength(1);
    expect(events).toContainEqual(expect.objectContaining({ type: "error", message: expected.message }));
    expect(leaks(tracked, ctrl.core.originalError, events, pair.wire, con.messages(), unhandled)).toEqual([]);
    expect(unhandled).toEqual([]);
    expect(con.wireDrops()).toEqual([]);
  });

  it("an Error is the instance `originalError` holds, redacted in place — message, stack and cause chain", async () => {
    captureConsole();
    const upstream = throwingUpstream(CASES[1][1]);
    const { ctrl, proxy } = relaySetup(upstream.socketFactory);

    await proxy.invoke("start");

    const thrown = upstream.thrown[0] as Error & { cause: Error & { frame: { data: string }; cause: string } };
    expect(ctrl.core.originalError).toBe(thrown);
    expect(thrown.cause).toBeInstanceOf(Error);
    expect(thrown.cause.message).toBe(`could not write ${S_REDACTED}`);
    expect(thrown.cause.frame).toStrictEqual({ data: S_REDACTED });
    expect(thrown.cause.cause).toBe(S_REDACTED);
    expect(leaks(thrown)).toEqual([]);
  });

  it("ends the session exactly like an `s` the upstream rejects: same updates, same state", async () => {
    captureConsole();
    const run = async (socketFactory: (url: string) => RealtimeSocket) => {
      const { pair, proxy, values } = relaySetup(socketFactory);
      await expect(proxy.invoke("start")).resolves.toBeNull();
      const updates = serverFrames(pair).filter((m) => m.type === "update")
        .map((m) => (m.name === "error" ? `error=${m.value === null ? "null" : "set"}` : `${m.name}=${JSON.stringify(m.value)}`));
      const { error: _error, ...state } = values;
      return { updates, state };
    };

    const rejected = await run(scriptedUpstream({ rejectStart: true }).socketFactory);
    const thrown = await run(throwingUpstream(CASES[0][1]).socketFactory);

    expect(rejected.updates).toEqual(["error=null", "loading=true", "error=set", "loading=false"]);
    expect(thrown.updates).toEqual(rejected.updates);
    expect(thrown.state).toStrictEqual(rejected.state);
    expect(unhandled).toEqual([]);
  });
});

/** A direct-mode server minting `ONE_TIME` with the real provider, and the client proxy the browser mints through. */
function directSetup() {
  const events: AmiVoiceServerLogEvent[] = [];
  const fetch = (async () => ({ ok: true, status: 200, text: async () => ONE_TIME })) as unknown as typeof globalThis.fetch;
  const relay = createAmiVoiceRelayServer({
    transport: "direct",
    createProvider: () => new AmiVoiceProvider({ appKey: APPKEY, fetch }),
    logger: (e) => events.push(e),
  });
  const pair = memoryTransportPair();
  relay.handleControlConnection(pair.server);
  const proxy = createRemoteCoreProxy(AmiVoiceCore.wcBindable, pair.client);
  const mint = (): Promise<DirectSessionInfo> => proxy.invoke("start") as Promise<DirectSessionInfo>;
  return { pair, events, mint };
}

/** The one-time APPKEY crosses the wire once, by design: in the mint's reply. The other frames, without it. */
function framesWithoutTheMintReply(pair: MemoryTransportPair): string[] {
  const carrying = pair.wire.filter((f) => f.includes(ONE_TIME));
  expect(carrying).toHaveLength(1);
  expect(JSON.parse(carrying[0].slice(2))).toMatchObject({ type: "return" });
  return pair.wire.filter((f) => !carrying.includes(f));
}

describe("direct: the browser's socket throws while sending the approved `s` command (one-time APPKEY)", () => {
  it.each(CASES)("%s: the in-page Core publishes it redacted", async (_label, make, expected) => {
    const con = captureConsole();
    const { pair, events, mint } = directSetup();
    const upstream = throwingUpstream(make);
    const core = new AmiVoiceCore(new DirectBrowserProvider(mint, { socketFactory: upstream.socketFactory }));

    await expect(core.start()).resolves.toBeNull();

    expect(upstream.thrown).toHaveLength(1);
    expect(core.error).toStrictEqual(expected);
    expect(core).toMatchObject({ loading: false, recognizing: false, connected: false });
    expect(upstream.closed()).toBe(true);
    if (upstream.thrown[0] instanceof Error) expect(core.originalError).toBe(upstream.thrown[0]);
    expect(leaks(core.originalError, core.error, events, framesWithoutTheMintReply(pair), con.messages(), unhandled)).toEqual([]);
    expect(pair.wire.join("\n")).not.toContain(APPKEY);
    expect(unhandled).toEqual([]);
  });
});

describe("local: an in-page Core whose provider's socket throws while sending the `s` command", () => {
  it.each(CASES)("%s: published redacted, no server helper in front", async (_label, make, expected) => {
    const con = captureConsole();
    const upstream = throwingUpstream(make);
    const core = new AmiVoiceCore(new AmiVoiceProvider({ appKey: APPKEY, socketFactory: upstream.socketFactory, connectTimeoutMs: 200 }));

    await expect(core.start()).resolves.toBeNull();

    expect(core.error).toStrictEqual(expected);
    expect(core).toMatchObject({ loading: false, recognizing: false, connected: false });
    expect(upstream.closed()).toBe(true);
    expect(leaks(core.originalError, core.error, con.messages(), unhandled)).toEqual([]);
    expect(unhandled).toEqual([]);
  });
});

describe("the platform WebSocket adapter (`wrapWebSocket`, the default factory) whose send throws", () => {
  it.each([
    [
      "local (AmiVoiceProvider, permanent APPKEY)",
      async () => new AmiVoiceCore(new AmiVoiceProvider({ appKey: APPKEY, connectTimeoutMs: 200 })),
    ],
    [
      "direct (DirectBrowserProvider, one-time APPKEY)",
      async () => new AmiVoiceCore(new DirectBrowserProvider(directSetup().mint)),
    ],
  ])("%s", async (_label, makeCore) => {
    const con = captureConsole();
    ThrowingWebSocket.sockets = [];
    vi.stubGlobal("WebSocket", ThrowingWebSocket);
    const core = await makeCore();

    await expect(core.start()).resolves.toBeNull();

    expect(core.error).toStrictEqual({
      name: "Error",
      message: `Failed to execute 'send' on 'WebSocket': ${S_REDACTED}`,
    });
    expect(core).toMatchObject({ loading: false, recognizing: false, connected: false });
    expect(ThrowingWebSocket.sockets).toHaveLength(1);
    expect(ThrowingWebSocket.sockets[0].closed).toBe(true);
    expect(leaks(core.originalError, core.error, con.messages(), unhandled)).toEqual([]);
    expect(unhandled).toEqual([]);
  });
});
