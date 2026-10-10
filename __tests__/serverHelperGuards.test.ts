// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { createRemoteCoreProxy, type ServerTransport } from "@wc-bindable/remote";
import { bind } from "@wc-bindable/core";
import {
  createAmiVoiceRelayServer, type AmiVoiceServerLogEvent, type AudioSocketLike,
} from "../src/createAmiVoiceServer";
import { AmiVoiceCore } from "../src/core/AmiVoiceCore";
import { AmiVoiceProvider } from "../src/providers/AmiVoiceProvider";
import { AmiVoiceError } from "../src/errorCodes";
import type { RealtimeSocket } from "../src/protocol/realtimeSession";
import type { AmiVoiceTransport, DirectSessionInfo, IAmiVoiceProvider, IRealtimeSession } from "../src/types";
import { memoryTransportPair, type MemoryTransportPair } from "./support/memoryTransport";
import { reachableStrings } from "./support/reachableStrings";

/**
 * The server helper (`createAmiVoiceRelayServer`) under integrator code that
 * throws, run in Node's environment: the server Core extends Node's
 * `EventTarget`, which reports a listener's throw as the PROCESS's
 * `uncaughtException` once the dispatch is over (happy-dom's, which the rest
 * of the unit suite runs on, rethrows it from `dispatchEvent` instead), and
 * the sockets dispatch the way `ws` does, from an I/O callback where a throw
 * is the process's uncaught exception too (Node exits). The real
 * `@wc-bindable/remote` proxies run over the in-memory transport, the relay
 * over the real `AmiVoiceProvider` and its realtime loop.
 *
 *  1. A logger that throws (SPEC §14). Each kind of record used to throw past
 *     the helper: `control-open` out of `handleControlConnection` (the
 *     integrator lost the session it had opened), `audio-open` /
 *     `audio-rejected` out of `handleAudioConnection` (a rejected socket was
 *     left open), a published `error` out of the Core's event dispatch
 *     (`uncaughtException`), `control-close` out of `dispose()` (the control
 *     socket's `close` listener). The record is lost, nothing else. (The
 *     `error` record of a `throw` reply was guarded already; pinned too.)
 *  2. An `ami-voice:*` listener the integrator adds on `core` that throws.
 *     Node reports it on the process; the package cannot catch it. Pinned as
 *     the README ("The original exception") and SPEC §14 describe it.
 *  3. `dispose()` when the shell's dispose throws — it runs the integrator's
 *     transport `dispose()` — skipped the Core's abort, so the upstream
 *     AmiVoice session outlived the connection (SPEC §18). The same throw from
 *     the shell disposing itself on the transport's close kept the
 *     integrator's `close` listener from running at all.
 */

const APPKEY = "PERMANENT-APPKEY-helper-guards-5c0e";

/** The strings reachable from `roots` that hold the APPKEY. */
function leaks(...roots: unknown[]): string[] {
  return roots.flatMap((root) => reachableStrings(root)).filter((s) => s.includes(APPKEY));
}

/** Every uncaught exception / unhandled rejection of the worker while a test runs, by kind. */
let unhandled: Array<[string, unknown]> = [];
const onUncaught = (reason: unknown): void => { unhandled.push(["uncaughtException", reason]); };
const onRejection = (reason: unknown): void => { unhandled.push(["unhandledRejection", reason]); };

beforeEach(() => {
  unhandled = [];
  process.on("uncaughtException", onUncaught);
  process.on("unhandledRejection", onRejection);
});
afterEach(() => {
  process.off("uncaughtException", onUncaught);
  process.off("unhandledRejection", onRejection);
  vi.restoreAllMocks();
});

/** Flush the in-memory transport (microtasks), Node's `EventTarget` reports (ticks) and the sockets' macrotasks. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

async function rejectionOf(p: Promise<unknown>): Promise<Error & { code?: string }> {
  try { await p; } catch (e) { return e as Error & { code?: string }; }
  throw new Error("expected a rejection");
}

// ── a scripted AmiVoice upstream for the provider's `socketFactory` ──────────

interface UpstreamConn {
  /** The text frames it received (`s`, `e`). */
  readonly sent: string[];
  /** Binary (`p`) frames it received. */
  fed: number;
  /** `close()` calls it received. */
  closeCalls: number;
}

/** Acks `s` (or rejects it, echoing the command — the APPKEY included — like a non-ok ack can) and `e`. */
function upstream(opts: { rejectStart?: boolean } = {}): {
  socketFactory: (url: string) => RealtimeSocket;
  conns: UpstreamConn[];
} {
  const conns: UpstreamConn[] = [];
  return {
    conns,
    socketFactory: () => {
      const conn: UpstreamConn = { sent: [], fed: 0, closeCalls: 0 };
      conns.push(conn);
      let open = true;
      const s: RealtimeSocket = {
        send: (d) => {
          if (typeof d !== "string") { conn.fed++; return; }
          conn.sent.push(d);
          if (d.startsWith("s ")) queueMicrotask(() => s.onmessage?.(opts.rejectStart ? `s rejected: ${d}` : "s"));
          else if (d === "e") queueMicrotask(() => s.onmessage?.("e"));
        },
        close: () => {
          conn.closeCalls++;
          if (!open) return;
          open = false;
          setTimeout(() => s.onclose?.(), 0);
        },
        onopen: null, onmessage: null, onclose: null, onerror: null,
      };
      queueMicrotask(() => s.onopen?.());
      return s;
    },
  };
}

/** The real provider (APPKEY registered for redaction) over a scripted upstream. */
function realProvider(socketFactory: (url: string) => RealtimeSocket): () => IAmiVoiceProvider {
  return () => new AmiVoiceProvider({ appKey: APPKEY, socketFactory });
}

/** A custom provider's session whose `abort()` throws, quoting the APPKEY. */
function abortThrowingProvider(): () => IAmiVoiceProvider {
  const session: IRealtimeSession = {
    feedAudio: () => {},
    stop: async () => {},
    abort: () => { throw new Error(`teardown failed: authorization=${APPKEY}`); },
  };
  return () => ({ openRealtimeSession: async () => session, recognizeFile: async () => [] });
}

// ── the sockets, as the `ws` library hands them over ─────────────────────────

/** The server end of the browser's binary audio channel: `message` from an I/O callback. */
class WsAudioSocket extends EventEmitter implements AudioSocketLike {
  closed = false;
  close(): void { this.closed = true; }
  receive(bytes: number[]): Promise<void> {
    return new Promise((resolve) => {
      setImmediate(() => {
        try { this.emit("message", Buffer.from(bytes), true); } finally { resolve(); }
      });
    });
  }
}

/**
 * The server end of the browser's control WebSocket. The integrator disposes
 * the session from its `close` listener (examples/relayServer.mjs), which `ws`
 * calls from an I/O callback.
 */
class WsControlSocket extends EventEmitter {
  hangUp(): Promise<void> {
    return new Promise((resolve) => {
      setImmediate(() => {
        try { this.emit("close", 1001, Buffer.alloc(0)); } finally { resolve(); }
      });
    });
  }
}

// ── the server helper behind the real remote proxies ─────────────────────────

interface ServerOptions {
  logger?: (e: AmiVoiceServerLogEvent) => void;
  transport?: AmiVoiceTransport;
  /** Wrap the in-memory server transport (an integrator's custom transport). */
  wrap?: (inner: ServerTransport) => ServerTransport;
}

/** A server over `createProvider`, one control connection to it, a client bound to that, and the log. */
function serverOver(createProvider: () => IAmiVoiceProvider, opts: ServerOptions = {}) {
  const events: AmiVoiceServerLogEvent[] = [];
  const relay = createAmiVoiceRelayServer({
    createProvider,
    transport: opts.transport,
    logger: opts.logger ?? ((e) => events.push(e)),
  });
  const pair = memoryTransportPair();
  const ctrl = relay.handleControlConnection(opts.wrap ? opts.wrap(pair.server) : pair.server);
  const proxy = createRemoteCoreProxy(AmiVoiceCore.wcBindable, pair.client);
  const values: Record<string, unknown> = {};
  bind(proxy, (name, value) => { values[name] = value; });
  return { relay, pair, ctrl, events, proxy, values };
}

/**
 * A logger whose sink is down for records of `type`: it sees every record,
 * and throws on those, quoting them. Only the one kind throws, so each case
 * proves its own call site rather than failing at the first record.
 */
function downLogger(type: AmiVoiceServerLogEvent["type"]): {
  seen: AmiVoiceServerLogEvent[];
  thrown: number;
  logger: (e: AmiVoiceServerLogEvent) => void;
} {
  const log = {
    seen: [] as AmiVoiceServerLogEvent[],
    thrown: 0,
    logger: (e: AmiVoiceServerLogEvent): void => {
      log.seen.push(e);
      if (e.type !== type) return;
      log.thrown++;
      throw new Error(`log sink down, dropped ${JSON.stringify(e)}`);
    },
  };
  return log;
}

/** `wire` frames the server sent, parsed. */
function serverFrames(pair: MemoryTransportPair): Array<Record<string, unknown>> {
  return pair.wire.filter((f) => f.startsWith("S:")).map((f) => JSON.parse(f.slice(2)));
}

describe("a logger that throws loses the record, nothing else (SPEC §14)", () => {
  it("control-open: the session is still returned, and it works", async () => {
    const up = upstream();
    const log = downLogger("control-open");
    const { relay, proxy, values } = serverOver(realProvider(up.socketFactory), { logger: log.logger });

    expect(log.seen).toEqual([{ type: "control-open", transport: "relay" }]);
    expect(log.thrown).toBe(1);
    await expect(proxy.invoke("start")).resolves.toEqual(expect.any(String));
    await settle();

    expect(values).toMatchObject({ recognizing: true, connected: true, error: null });
    expect(up.conns[0].sent).toEqual([expect.stringMatching(/^s LSB16K -a-general .*authorization=/)]);
    expect(relay.sessionCount()).toBe(1);
    expect(unhandled).toEqual([]);
  });

  it("audio-open: the audio connection is accepted and its frames reach the upstream", async () => {
    const up = upstream();
    const log = downLogger("audio-open");
    const { relay, proxy } = serverOver(realProvider(up.socketFactory), { logger: log.logger });
    const token = (await proxy.invoke("start")) as string;
    const audio = new WsAudioSocket();

    expect(relay.handleAudioConnection(audio, token)).toBe(true);
    await audio.receive([1, 2, 3]);
    await audio.receive([4, 5]);

    expect(log.seen.at(-1)).toEqual({ type: "audio-open" });
    expect(log.thrown).toBe(1);
    expect(up.conns[0].fed).toBe(2);
    expect(audio.closed).toBe(false);
    expect(JSON.stringify(log.seen)).not.toContain(token); // the bearer token stays out (SPEC §11.3)
    expect(unhandled).toEqual([]);
  });

  it("audio-rejected: an unknown token is still refused, and its socket closed", async () => {
    const up = upstream();
    const log = downLogger("audio-rejected");
    const { relay } = serverOver(realProvider(up.socketFactory), { logger: log.logger });
    const audio = new WsAudioSocket();

    expect(relay.handleAudioConnection(audio, "bogus-token")).toBe(false);

    expect(log.seen.at(-1)).toEqual({ type: "audio-rejected", reason: "unknown-session" });
    expect(log.thrown).toBe(1);
    expect(audio.closed).toBe(true);
    expect(unhandled).toEqual([]);
  });

  it("error (published by the Core): the failure still reaches the client, nothing reaches the process", async () => {
    const up = upstream({ rejectStart: true });
    const log = downLogger("error");
    const { relay, pair, ctrl, proxy, values } = serverOver(realProvider(up.socketFactory), { logger: log.logger });

    await expect(proxy.invoke("start")).resolves.toBeNull();
    await settle();

    // The record is written from the Core's `ami-voice:error` dispatch, where
    // Node's `EventTarget` would report the logger's throw on the process.
    expect(log.thrown).toBe(1);
    expect(unhandled).toEqual([]);
    const published = { message: expect.stringContaining("authorization=<redacted>") };
    expect(log.seen.filter((e) => e.type === "error")).toEqual([expect.objectContaining({ type: "error", ...published })]);
    expect(values).toMatchObject({ recognizing: false, connected: false, loading: false, error: published });
    expect(ctrl.core.originalError).toBeInstanceOf(Error);
    expect(relay.sessionCount()).toBe(0);
    expect(leaks(log.seen, pair.wire, ctrl.core.originalError)).toEqual([]);
  });

  it("the throw reply (relay): the failed command still answers, redacted and stripped", async () => {
    const log = downLogger("error");
    const { pair, ctrl, proxy } = serverOver(abortThrowingProvider(), { logger: log.logger });
    await proxy.invoke("start");

    const err = await rejectionOf(proxy.invoke("abort"));

    expect(err.message).toBe("teardown failed: authorization=<redacted>");
    expect(log.thrown).toBe(1);
    expect(log.seen.filter((e) => e.type === "error")).toEqual([
      expect.objectContaining({ type: "error", message: "teardown failed: authorization=<redacted>", stack: expect.any(String) }),
    ]);
    const thrown = serverFrames(pair).filter((m) => m.type === "throw");
    expect(thrown).toHaveLength(1);
    expect(thrown[0].error).not.toHaveProperty("stack");
    expect(ctrl.core.recognizing).toBe(false);
    expect(leaks(log.seen, pair.wire)).toEqual([]);
    expect(unhandled).toEqual([]);
  });

  it("the throw reply (direct): a mint failure still rejects start(), redacted and stripped", async () => {
    const log = downLogger("error");
    const { pair, proxy } = serverOver(() => ({
      openRealtimeSession: async () => { throw new Error("direct mode must not open an upstream"); },
      recognizeFile: async () => [],
      prepareDirectSession: async (): Promise<DirectSessionInfo> => {
        throw new AmiVoiceError("-", `mint refused: u=${APPKEY}`);
      },
    }), { logger: log.logger, transport: "direct" });

    const err = await rejectionOf(proxy.invoke("start"));

    expect(err.message).toBe("mint refused: u=<redacted>");
    expect(err.code).toBe("auth");
    expect(log.thrown).toBe(1);
    expect(log.seen.filter((e) => e.type === "error")).toEqual([
      expect.objectContaining({ type: "error", code: "auth", message: "mint refused: u=<redacted>", stack: expect.any(String) }),
    ]);
    expect(leaks(log.seen, pair.wire)).toEqual([]);
    expect(unhandled).toEqual([]);
  });

  it("control-close: dispose() from the control socket's close listener tears everything down, nothing escapes", async () => {
    const up = upstream();
    const log = downLogger("control-close");
    const { relay, ctrl, proxy } = serverOver(realProvider(up.socketFactory), { logger: log.logger });
    const sock = new WsControlSocket();
    sock.on("close", () => ctrl.dispose());
    await proxy.invoke("start");

    await sock.hangUp();
    await settle();

    expect(log.seen.at(-1)).toEqual({ type: "control-close", transport: "relay" });
    expect(log.thrown).toBe(1);
    expect(unhandled).toEqual([]);
    expect(up.conns[0].closeCalls).toBe(1); // the Core's abort closed the upstream socket
    expect(ctrl.core).toMatchObject({ recognizing: false, connected: false });
    expect(relay.sessionCount()).toBe(0);
  });
});

/**
 * Not the package's to catch: a listener the integrator adds on `core` runs
 * inside the Core's event dispatch, and Node's `EventTarget` reports its throw
 * — or its rejection, for an async listener — as the process's
 * `uncaughtException` once the dispatch is over. `dispatchEvent` itself
 * returns normally, so neither the Core nor the helper ever sees the throw.
 * Pinned as the README and SPEC §14 describe it: if this changes, so must
 * they.
 */
describe("an `ami-voice:*` listener of the integrator's that throws: Node reports it on the process (SPEC §14)", () => {
  it("the throw is the process's uncaughtException, as it is; the Core, the log and the client carry on", async () => {
    const up = upstream({ rejectStart: true });
    const { ctrl, events, proxy, values } = serverOver(realProvider(up.socketFactory));
    const trackerDown = new Error("tracker down");
    const later = vi.fn();
    ctrl.core.addEventListener("ami-voice:error", () => {
      if (ctrl.core.originalError) throw trackerDown;
    });
    ctrl.core.addEventListener("ami-voice:error", later);

    await expect(proxy.invoke("start")).resolves.toBeNull();
    await settle();

    expect(unhandled).toEqual([["uncaughtException", trackerDown]]);
    // The dispatch went on: the listener after it, the helper's log record, the client's update.
    expect((later.mock.lastCall?.[0] as CustomEvent).detail).toBe(ctrl.core.error);
    expect(events.filter((e) => e.type === "error")).toHaveLength(1);
    expect(values).toMatchObject({
      recognizing: false, loading: false,
      error: { message: expect.stringContaining("authorization=<redacted>") },
    });
  });

  it("an async listener's rejection is reported the same way: uncaughtException, not unhandledRejection", async () => {
    const up = upstream({ rejectStart: true });
    const { ctrl, proxy } = serverOver(realProvider(up.socketFactory));
    const trackerDown = new Error("tracker down");
    ctrl.core.addEventListener("ami-voice:error", async () => {
      if (ctrl.core.originalError) throw trackerDown;
    });

    await expect(proxy.invoke("start")).resolves.toBeNull();
    await settle();

    expect(unhandled).toEqual([["uncaughtException", trackerDown]]);
  });

  it("the README's pattern, try/catch inside the listener, keeps it off the process", async () => {
    const up = upstream({ rejectStart: true });
    const { ctrl, proxy } = serverOver(realProvider(up.socketFactory));
    const captureException = vi.fn(() => { throw new Error("tracker down"); });
    ctrl.core.addEventListener("ami-voice:error", () => {
      try {
        if (ctrl.core.originalError) captureException(ctrl.core.originalError);
      } catch { /* the tracker is down; the server stays up */ }
    });

    await expect(proxy.invoke("start")).resolves.toBeNull();
    await settle();

    expect(captureException).toHaveBeenCalledWith(ctrl.core.originalError);
    expect(unhandled).toEqual([]);
  });
});

describe("dispose(): the shell's dispose and the Core's abort both run, whichever throws (SPEC §18)", () => {
  /** The in-memory transport, as an integrator's custom one whose `dispose()` throws, quoting the APPKEY. */
  function disposeThrows(counter: { calls: number }, onClose?: (handler: () => void) => void) {
    return (inner: ServerTransport): ServerTransport => ({
      send: (m) => inner.send(m),
      onMessage: (h) => inner.onMessage(h),
      ...(onClose ? { onClose } : {}),
      dispose: () => {
        counter.calls++;
        throw new Error(`transport dispose failed, last frame s LSB16K -a-general authorization=${APPKEY}`);
      },
    });
  }
  const transportRecord = {
    type: "error",
    message: "transport dispose failed, last frame s LSB16K -a-general authorization=<redacted>",
    stack: expect.stringContaining("authorization=<redacted>"),
  };

  it("the transport's dispose() throws: the Core is still aborted, the throw is logged, dispose() does not throw", async () => {
    const up = upstream();
    const disposals = { calls: 0 };
    const { relay, pair, ctrl, events, proxy } = serverOver(realProvider(up.socketFactory), { wrap: disposeThrows(disposals) });
    const sock = new WsControlSocket();
    sock.on("close", () => ctrl.dispose());
    const token = (await proxy.invoke("start")) as string;
    expect(relay.handleAudioConnection(new WsAudioSocket(), token)).toBe(true);

    await sock.hangUp();
    await settle();

    expect(unhandled).toEqual([]);
    expect(disposals.calls).toBe(1);
    expect(up.conns[0].closeCalls).toBe(1); // the Core's abort closed the upstream socket
    expect(ctrl.core).toMatchObject({ recognizing: false, connected: false });
    expect(relay.sessionCount()).toBe(0); // the relay token is reaped
    expect(events.filter((e) => e.type === "error")).toStrictEqual([transportRecord]);
    expect(events.at(-1)).toEqual({ type: "control-close", transport: "relay" });
    expect(relay.handleAudioConnection(new WsAudioSocket(), token)).toBe(false); // it routes nowhere now
    expect(leaks(events, pair.wire, unhandled)).toEqual([]);
  });

  it("both throw: both are logged, in order, then control-close; nothing escapes", async () => {
    const disposals = { calls: 0 };
    const { relay, pair, ctrl, events, proxy } = serverOver(abortThrowingProvider(), { wrap: disposeThrows(disposals) });
    const sock = new WsControlSocket();
    sock.on("close", () => ctrl.dispose());
    await proxy.invoke("start");
    expect(relay.sessionCount()).toBe(1);

    await sock.hangUp();
    await settle();

    expect(unhandled).toEqual([]);
    expect(events.filter((e) => e.type === "error")).toStrictEqual([
      transportRecord,
      { type: "error", message: "teardown failed: authorization=<redacted>", stack: expect.stringContaining("teardown failed") },
    ]);
    expect(events.at(-1)).toEqual({ type: "control-close", transport: "relay" });
    expect(ctrl.core).toMatchObject({ recognizing: false, connected: false });
    expect(relay.sessionCount()).toBe(0);
    expect(leaks(events, pair.wire, unhandled)).toEqual([]);
  });

  it("the shell disposes itself on the transport's close: its throw is logged and the integrator's close listener still aborts the Core", async () => {
    const up = upstream();
    const sock = new WsControlSocket();
    const disposals = { calls: 0 };
    // Like `WebSocketServerTransport`: the transport listens for the socket's
    // close itself, before the integrator does.
    const { relay, pair, ctrl, events, proxy } = serverOver(realProvider(up.socketFactory), {
      wrap: disposeThrows(disposals, (handler) => { sock.on("close", handler); }),
    });
    sock.on("close", () => ctrl.dispose());
    await proxy.invoke("start");

    await sock.hangUp();
    await settle();

    expect(unhandled).toEqual([]);
    expect(disposals.calls).toBe(1); // once, from the close: dispose()'s own shell dispose is a no-op
    expect(up.conns[0].closeCalls).toBe(1); // the integrator's listener ran: the Core was aborted
    expect(ctrl.core).toMatchObject({ recognizing: false, connected: false });
    expect(relay.sessionCount()).toBe(0);
    expect(events.filter((e) => e.type === "error")).toStrictEqual([transportRecord]);
    expect(events.at(-1)).toEqual({ type: "control-close", transport: "relay" });
    expect(leaks(events, pair.wire, unhandled)).toEqual([]);
  });
});
