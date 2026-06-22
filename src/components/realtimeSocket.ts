import { runRealtimeSession, type RealtimeSocket } from "../protocol/realtimeSession.js";
import type {
  IAmiVoiceProvider, IRealtimeSession, RealtimeSessionHandlers,
  RecognitionSegment, DirectSessionInfo,
} from "../types.js";

/**
 * Browser-side direct-transport plumbing (docs/adr/0006, opt-in). In direct mode
 * the browser opens the AmiVoice WSS ITSELF with a server-minted one-time APPKEY,
 * streams audio directly (audio bypasses the server, `O(connections)`), and
 * parses events client-side. This module owns ONLY the browser WSS wrapper and
 * the in-page provider; the actual session loop is the SHARED `runRealtimeSession`
 * the relay path uses (docs/adr/0006 rule 3 — no parallel result code paths).
 *
 * The permanent APPKEY never reaches here — the provider hands back a pre-built,
 * pre-approved `s` command with the short-lived token already baked in.
 */

/** Default graceful-stop fallback (mirrors the provider; Q4/D1). */
const DEFAULT_STOP_TIMEOUT_MS = 5000;

/** Wrap the platform `WebSocket` as a `RealtimeSocket` (browser realtime WSS). */
export function browserRealtimeSocketFactory(url: string): RealtimeSocket {
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  const sock: RealtimeSocket = {
    send: (d) => ws.send(d),
    close: () => ws.close(),
    onopen: null, onmessage: null, onclose: null, onerror: null,
  };
  ws.onopen = () => sock.onopen?.();
  ws.onmessage = (e: MessageEvent) => { if (typeof e.data === "string") sock.onmessage?.(e.data); };
  ws.onclose = () => sock.onclose?.();
  ws.onerror = (e) => sock.onerror?.(e);
  return sock;
}

export interface OpenDirectSessionOptions extends DirectSessionInfo {
  /** Injectable socket factory (default wraps the platform `WebSocket`). */
  socketFactory?: (url: string) => RealtimeSocket;
  /** Graceful-stop fallback timeout in ms. Default 5000. */
  stopTimeoutMs?: number;
}

/**
 * Open a direct AmiVoice realtime session from the browser. Connects to
 * `endpoint`, sends the server-approved `sCommand`, and runs the SHARED session
 * loop. Returns an `IRealtimeSession` whose `feedAudio`/`stop`/`abort` behave
 * exactly as the relay session's.
 */
export function openDirectRealtimeSession(
  opts: OpenDirectSessionOptions,
  handlers: RealtimeSessionHandlers,
): Promise<IRealtimeSession> {
  const factory = opts.socketFactory ?? browserRealtimeSocketFactory;
  const socket = factory(opts.endpoint);
  return runRealtimeSession(socket, opts.sCommand, handlers, opts.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS);
}

/**
 * In-page `IAmiVoiceProvider` for direct mode. It holds NO APPKEY: on
 * `openRealtimeSession` it asks the server (via the injected `requestSession`,
 * wired to the control proxy's `invoke("start")`) for the approved `s` command +
 * one-time token, then opens the AmiVoice WSS directly. The in-page `AmiVoiceCore`
 * uses it exactly like the relay provider, so all recognition state, result
 * normalization, and lifecycle logic are reused unchanged.
 */
export class DirectBrowserProvider implements IAmiVoiceProvider {
  private readonly _requestSession: () => Promise<DirectSessionInfo>;
  private readonly _socketFactory?: (url: string) => RealtimeSocket;
  private readonly _stopTimeoutMs?: number;

  constructor(
    requestSession: () => Promise<DirectSessionInfo>,
    options: { socketFactory?: (url: string) => RealtimeSocket; stopTimeoutMs?: number } = {},
  ) {
    this._requestSession = requestSession;
    this._socketFactory = options.socketFactory;
    this._stopTimeoutMs = options.stopTimeoutMs;
  }

  async openRealtimeSession(
    _options: unknown,
    handlers: RealtimeSessionHandlers,
  ): Promise<IRealtimeSession> {
    // `_options` is ignored: the server already baked the approved params into
    // `sCommand` (Core authority is advisory in direct mode — docs/adr/0006).
    const info = await this._requestSession();
    return openDirectRealtimeSession(
      { ...info, socketFactory: this._socketFactory, stopTimeoutMs: this._stopTimeoutMs },
      handlers,
    );
  }

  async recognizeFile(): Promise<RecognitionSegment[]> {
    throw new Error(
      "file recognition is not available in browser-direct mode; use a relay/server deployment",
    );
  }
}
