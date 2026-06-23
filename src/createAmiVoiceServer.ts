import { AmiVoiceCore } from "./core/AmiVoiceCore.js";
import { AmiVoiceProvider } from "./providers/AmiVoiceProvider.js";
import type { IAmiVoiceProvider, AmiVoiceTransport, WcsAmiVoiceAnyError } from "./types.js";
import { getErrorCode, type AmiVoiceErrorCode } from "./errorCodes.js";
import { redactSecrets } from "./redact.js";
import { RemoteShellProxy, type ServerTransport } from "@wc-bindable/remote";

/**
 * Server-side realtime helper (docs/adr/0003, docs/adr/0006). Owns the per-
 * connection `AmiVoiceCore` (+ APPKEY-bearing provider) behind a
 * `@wc-bindable/remote` `RemoteShellProxy`, plus the session table the relay
 * audio channel needs. Modeled on auth0's `createAuthenticatedWSS` — it does NOT
 * bundle a WebSocket library; the integrator hands it the authenticated sockets.
 *
 * Two transports (docs/adr/0006), selected by `transport` at construction:
 *  - **relay** (default): on `start()` the Core mints an opaque session token;
 *    the integrator routes the browser's binary audio WebSocket to
 *    `handleAudioConnection(socket, token)`, which validates the token and pipes
 *    frames into `core.feedAudio`. Audio traverses the server.
 *  - **direct** (opt-in): on `start()` the Core mints a short-lived, optionally
 *    IP-restricted one-time APPKEY + approved `s` command and returns them as the
 *    `invoke` result; the browser opens the AmiVoice WSS itself. Audio bypasses
 *    the server; there is no audio channel. The permanent APPKEY never leaves
 *    the server in either mode.
 *
 * SECURITY (SPEC §14): the integrator MUST authenticate the peer before calling
 * either handler, MUST pass the audio token from `Sec-WebSocket-Protocol` (not
 * the query string), and SHOULD pass the peer address (direct) so the mint can
 * IP-restrict the one-time APPKEY.
 */

/**
 * One structured log record from the server helper (Phase 3.5). A discriminated
 * union so an integrator can route by `type` to their own logger. NOTE: it never
 * carries the APPKEY (server-only) nor the raw audio session token (a bearer the
 * SPEC §11.3 keeps out of logs); `error` carries only the normalized `code` +
 * message, never wire payloads.
 */
export type AmiVoiceServerLogEvent =
  | { type: "control-open"; transport: AmiVoiceTransport; peerAddress?: string }
  | { type: "control-close"; transport: AmiVoiceTransport; peerAddress?: string }
  | { type: "audio-open" }
  | { type: "audio-rejected"; reason: "unknown-session" }
  | { type: "error"; code?: AmiVoiceErrorCode; message: string };

/** Injectable structured logger (Phase 3.5). Default is a no-op. */
export type AmiVoiceServerLogger = (event: AmiVoiceServerLogEvent) => void;

export interface AmiVoiceRelayServerOptions {
  /** Provider factory (one per control connection). Defaults to `new AmiVoiceProvider()`. */
  createProvider?: () => IAmiVoiceProvider;
  /** Transport (docs/adr/0006). Default `"relay"`. */
  transport?: AmiVoiceTransport;
  /** Direct mode: one-time-APPKEY expiry in seconds when the peer IP is known. Default 30. */
  epi?: number;
  /** Direct mode: shorter expiry when the peer IP is unknown (NAT/proxy — Q12). Default 10. */
  epiWithoutIpa?: number;
  /**
   * Structured logger (Phase 3.5). Receives connection open/close, rejected audio
   * frames, and emitted Core errors. Default: no-op. Sensitive values (APPKEY,
   * audio token, wire payloads) are never passed to it.
   */
  logger?: AmiVoiceServerLogger;
}

/** Per-control-connection options (direct mode uses the peer address for `ipa`). */
export interface AmiVoiceControlConnectionOptions {
  /** Peer source address; direct mode binds the one-time APPKEY's `ipa` to it. */
  peerAddress?: string;
}

export interface AmiVoiceControlSession {
  core: AmiVoiceCore;
  shell: RemoteShellProxy;
  /** Tear down: drop the session token, dispose the shell, abort the Core. */
  dispose(): void;
}

/** Minimal audio-socket shape — accepts both `ws` (`.on`) and browser (`.onmessage`). */
export interface AudioSocketLike {
  on?(event: string, listener: (data: unknown) => void): void;
  onmessage?: ((event: { data: unknown }) => void) | null;
  close(): void;
}

export interface AmiVoiceRelayServer {
  /** Wire an authenticated control transport to a fresh Core + shell. */
  handleControlConnection(
    transport: ServerTransport,
    options?: AmiVoiceControlConnectionOptions,
  ): AmiVoiceControlSession;
  /**
   * Wire an authenticated binary audio socket to its session (relay only).
   * Returns false if the token is unknown — and always false in direct mode,
   * where audio bypasses the server.
   */
  handleAudioConnection(socket: AudioSocketLike, token: string): boolean;
  /** Live session count (diagnostics / tests). Always 0 in direct mode. */
  sessionCount(): number;
}

function toUint8(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null; // ignore text frames on the audio channel
}

export function createAmiVoiceRelayServer(
  options: AmiVoiceRelayServerOptions = {},
): AmiVoiceRelayServer {
  const sessions = new Map<string, AmiVoiceCore>();
  const createProvider = options.createProvider ?? (() => new AmiVoiceProvider());
  const transportMode: AmiVoiceTransport = options.transport ?? "relay";
  const epi = options.epi ?? 30;
  const epiWithoutIpa = options.epiWithoutIpa ?? 10;
  const log: AmiVoiceServerLogger = options.logger ?? (() => { /* no-op */ });

  return {
    handleControlConnection(
      transport: ServerTransport,
      connOptions: AmiVoiceControlConnectionOptions = {},
    ): AmiVoiceControlSession {
      let token: string | null = null;
      let core: AmiVoiceCore;
      if (transportMode === "direct") {
        // Direct (docs/adr/0006): no audio channel / session token. The Core mints
        // a one-time APPKEY bound to the peer IP where known; degrade to a shorter
        // expiry with no `ipa` behind NAT/proxy (Q12).
        const peer = connOptions.peerAddress;
        core = new AmiVoiceCore(createProvider(), undefined, {
          transport: "direct",
          mintOptions: () => (peer ? { ipa: peer, epi } : { epi: epiWithoutIpa }),
        });
      } else {
        core = new AmiVoiceCore(createProvider(), undefined, {
          mintSessionId: () => {
            if (token) sessions.delete(token); // a re-`start()` re-mints
            token = crypto.randomUUID();
            sessions.set(token, core);
            return token;
          },
        });
      }
      const shell = new RemoteShellProxy(core, transport);
      // Log emitted Core errors (normalized code + message only — never payloads).
      const onCoreError = (e: Event): void => {
        const detail = (e as CustomEvent<WcsAmiVoiceAnyError>).detail;
        if (detail) log({ type: "error", code: getErrorCode(detail), message: redactSecrets(detail.message) });
      };
      core.addEventListener("ami-voice:error", onCoreError);
      // Reap the relay session token when the session ends (graceful stop OR an
      // upstream drop the Core surfaces as `recognizing=false`), so `sessions`
      // does not keep a stale `token → core` entry routable to a no-op Core until
      // the control connection closes. A re-`start()` re-mints a fresh token.
      const onRecognizingChanged = (e: Event): void => {
        if ((e as CustomEvent).detail === false && token) { sessions.delete(token); token = null; }
      };
      if (transportMode !== "direct") core.addEventListener("ami-voice:recognizing-changed", onRecognizingChanged);
      log({ type: "control-open", transport: transportMode, peerAddress: connOptions.peerAddress });
      return {
        core,
        shell,
        dispose: () => {
          if (token) sessions.delete(token);
          core.removeEventListener("ami-voice:error", onCoreError);
          core.removeEventListener("ami-voice:recognizing-changed", onRecognizingChanged);
          shell.dispose();
          core.abort();
          log({ type: "control-close", transport: transportMode, peerAddress: connOptions.peerAddress });
        },
      };
    },

    handleAudioConnection(socket: AudioSocketLike, token: string): boolean {
      const core = sessions.get(token);
      if (!core) {
        log({ type: "audio-rejected", reason: "unknown-session" });
        socket.close();
        return false;
      }
      const onData = (data: unknown): void => {
        const bytes = toUint8(data);
        if (bytes) core.feedAudio(bytes);
      };
      if (typeof socket.on === "function") socket.on("message", onData);
      else socket.onmessage = (event) => onData(event.data);
      log({ type: "audio-open" });
      return true;
    },

    sessionCount: () => sessions.size,
  };
}
