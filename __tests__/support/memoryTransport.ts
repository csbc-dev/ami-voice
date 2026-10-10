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
