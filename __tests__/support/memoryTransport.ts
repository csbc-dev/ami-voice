import { vi } from "vitest";
import type {
  ClientTransport, ServerTransport, ClientMessage, ServerMessage,
} from "@wc-bindable/remote";
import type { RealtimeSocket } from "../../src/protocol/realtimeSession";

/**
 * In-memory `@wc-bindable/remote` transport pair for the unit suite, so the
 * REAL `RemoteShellProxy` / `RemoteCoreProxy` (and their 0.10+ JsonValue gate)
 * run without sockets. Every hop is JSON-serialized and re-parsed — exactly what
 * the WebSocket transports do — and delivered asynchronously in FIFO order (the
 * ordered-channel guarantee the control channel relies on). `wire` records every
 * serialized frame so a test can assert on what actually crossed (e.g. that no
 * APPKEY did).
 */
export interface MemoryTransportPair {
  server: ServerTransport;
  client: ClientTransport;
  /** Serialized frames in send order: `S:` server→client, `C:` client→server. */
  wire: string[];
}

export function memoryTransportPair(): MemoryTransportPair {
  let toServer: ((m: ClientMessage) => void) | null = null;
  let toClient: ((m: ServerMessage) => void) | null = null;
  const wire: string[] = [];
  const server: ServerTransport = {
    send: (m) => {
      const frame = JSON.stringify(m);
      wire.push(`S:${frame}`);
      queueMicrotask(() => toClient?.(JSON.parse(frame) as ServerMessage));
    },
    onMessage: (h) => { toServer = h; },
  };
  const client: ClientTransport = {
    send: (m) => {
      const frame = JSON.stringify(m);
      wire.push(`C:${frame}`);
      queueMicrotask(() => toServer?.(JSON.parse(frame) as ClientMessage));
    },
    onMessage: (h) => { toClient = h; },
  };
  return { server, client, wire };
}

/**
 * Silence + record `console.warn` / `console.error` — the default logger of both
 * remote proxies. A dropped non-JsonValue `update` ("dropped update for …"), a
 * `sync` `getterFailures` entry ("could not read or transmit …") and a dropped
 * `sync` value all surface here.
 */
export function captureConsole(): { messages(): string[]; wireDrops(): string[] } {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const messages = (): string[] =>
    [...warn.mock.calls, ...error.mock.calls].map((args) => args.map(String).join(" "));
  return {
    messages,
    wireDrops: () => messages().filter((m) => /dropped (update|sync value)|could not read or transmit/.test(m)),
  };
}

/**
 * A scripted AmiVoice upstream for the REAL `runRealtimeSession` loop: acks `s`
 * (or rejects it echoing the full command, APPKEY included, like a non-ok ack
 * can), and lets the test push a final `A` or drop the socket unsolicited.
 */
export function scriptedUpstream(opts: { rejectStart?: boolean } = {}): {
  socketFactory: (url: string) => RealtimeSocket;
  final(text: string): void;
  drop(): void;
} {
  let sock: RealtimeSocket | null = null;
  return {
    socketFactory: () => {
      const s: RealtimeSocket = {
        send: (d) => {
          if (typeof d !== "string" || !d.startsWith("s ")) return;
          queueMicrotask(() => s.onmessage?.(opts.rejectStart ? `s rejected: ${d}` : "s"));
        },
        close: () => { /* the loop's own close; no upstream to tear down */ },
        onopen: null, onmessage: null, onclose: null, onerror: null,
      };
      sock = s;
      queueMicrotask(() => s.onopen?.());
      return s;
    },
    final: (text) => {
      sock?.onmessage?.(`A ${JSON.stringify({ text, results: [{ text, confidence: 0.9, starttime: 0, endtime: 1, tokens: [] }] })}`);
    },
    drop: () => { sock?.onclose?.(); },
  };
}

/** One upstream connection of {@link fakeUpstream}. */
export interface FakeUpstreamConn {
  readonly url: string;
  /** False once either side closed it. A Core that lost track of an open one orphaned it. */
  open: boolean;
  /** Audio payloads received (the `p` command byte stripped). */
  readonly fed: number[][];
}

/**
 * A fake AmiVoice realtime upstream for the REAL `runRealtimeSession` loop that
 * behaves like a platform WebSocket where the session lifecycle cares:
 *  - `close()` fires `onclose` LATER (a macrotask — the close handshake), so a
 *    session the Core already left can report its close after the next session
 *    started;
 *  - `e` is answered with the trailing final `A` + the `e` ack — at once, or held
 *    until `releaseStops()` to model a graceful stop that is still draining.
 * Usable through the provider seam (`socketFactory`) and as the global
 * `WebSocket` (`WebSocketClass`, for the browser-direct `wrapWebSocket`).
 */
export function fakeUpstream(opts: { holdStop?: boolean } = {}): {
  socketFactory: (url: string) => RealtimeSocket;
  WebSocketClass: new (url: string) => unknown;
  conns: FakeUpstreamConn[];
  opened(): number;
  live(): number;
  releaseStops(): void;
} {
  const conns: FakeUpstreamConn[] = [];
  const heldStops: Array<() => void> = [];
  const finalText = "こんにちは";
  const finalFrame = `A ${JSON.stringify({ text: finalText, results: [{ text: finalText, confidence: 0.9, starttime: 0, endtime: 1, tokens: [] }] })}`;

  interface Peer { open(): void; message(text: string): void; closed(): void }
  function connect(url: string, peer: Peer): { send(d: unknown): void; close(): void } {
    const conn: FakeUpstreamConn = { url, open: true, fed: [] };
    conns.push(conn);
    const deliver = (text: string): void => { if (conn.open) peer.message(text); };
    const shutdown = (): void => {
      if (!conn.open) return;
      conn.open = false;
      setTimeout(() => peer.closed(), 0); // the close handshake completes later
    };
    queueMicrotask(() => { if (conn.open) peer.open(); });
    return {
      send: (d) => {
        if (!conn.open) return;
        if (typeof d !== "string") {
          const bytes = d instanceof Uint8Array ? d : new Uint8Array(d as ArrayBuffer);
          conn.fed.push([...bytes.subarray(1)]); // strip the `p` command byte
          return;
        }
        if (d.startsWith("s ")) queueMicrotask(() => deliver("s"));
        else if (d === "e") {
          const answer = (): void => { deliver(finalFrame); deliver("e"); };
          if (opts.holdStop) heldStops.push(answer);
          else queueMicrotask(answer);
        }
      },
      close: shutdown,
    };
  }

  class FakeAmiVoiceWebSocket {
    static readonly OPEN = 1;
    readyState = 0;
    binaryType = "blob";
    bufferedAmount = 0;
    onopen: (() => void) | null = null;
    onmessage: ((e: { data: unknown }) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    private readonly _link: { send(d: unknown): void; close(): void };
    constructor(readonly url: string) {
      this._link = connect(url, {
        open: () => { this.readyState = 1; this.onopen?.(); },
        message: (text) => this.onmessage?.({ data: text }),
        closed: () => { this.readyState = 3; this.onclose?.(); },
      });
    }
    send(d: unknown): void { this._link.send(d); }
    close(): void { this._link.close(); }
  }

  return {
    socketFactory: (url) => {
      const sock: RealtimeSocket = {
        send: (d) => link.send(d),
        close: () => link.close(),
        onopen: null, onmessage: null, onclose: null, onerror: null,
      };
      const link = connect(url, {
        open: () => sock.onopen?.(),
        message: (text) => sock.onmessage?.(text),
        closed: () => sock.onclose?.(),
      });
      return sock;
    },
    WebSocketClass: FakeAmiVoiceWebSocket,
    conns,
    opened: () => conns.length,
    live: () => conns.filter((c) => c.open).length,
    releaseStops: () => { for (const answer of heldStops.splice(0)) answer(); },
  };
}
