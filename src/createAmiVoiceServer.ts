import { AmiVoiceCore } from "./core/AmiVoiceCore.js";
import { AmiVoiceProvider } from "./providers/AmiVoiceProvider.js";
import type { IAmiVoiceProvider, AmiVoiceTransport, SerializedError } from "./types.js";
import { getErrorCode, type AmiVoiceErrorCode } from "./errorCodes.js";
import { redactSecrets } from "./redact.js";
import {
  RemoteShellProxy, type ServerTransport, type ServerMessage, type RemoteSerializedError,
} from "@wc-bindable/remote";

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
 * redacted message (+ redacted server `stack`, see below), never wire payloads.
 *
 * `error` is logged for every error the Core publishes on `error`, AND for every
 * remote `throw` the shell answers a browser call with (e.g. a direct-mode mint
 * failure). For the latter, `stack` holds the server-side stack trace and
 * `cause` the (JSON-serialized, redacted) cause chain that the helper withheld
 * from the browser (SPEC §17).
 */
export type AmiVoiceServerLogEvent =
  | { type: "control-open"; transport: AmiVoiceTransport; peerAddress?: string }
  | { type: "control-close"; transport: AmiVoiceTransport; peerAddress?: string }
  | { type: "audio-open" }
  | { type: "audio-rejected"; reason: "unknown-session" }
  | { type: "error"; code?: AmiVoiceErrorCode; message: string; stack?: string; cause?: string };

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
   * frames, emitted Core errors, and the errors sent to the browser as a remote
   * `throw` (with the server stack the browser no longer gets). Default: no-op.
   * Sensitive values (APPKEY, audio token, wire payloads) are never passed to it.
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

/**
 * Copy of a serialized remote error without `stack` and without `cause`. Only
 * `name`, `message` and `code` reach the browser: a cause chain carries the
 * server's internals (`connect ECONNREFUSED 10.0.0.5:443`, downstream error
 * payloads, a custom provider's diagnostics) that `toError` never redacts.
 */
function forTheBrowser(error: unknown): unknown {
  if (typeof error !== "object" || error === null || Array.isArray(error)) return error;
  const { stack: _stack, cause: _cause, ...rest } = error as Record<string, unknown>;
  return rest;
}

/**
 * Wrap a control transport so that no SERVER stack trace or cause reaches the browser.
 *
 * `@wc-bindable/remote` 0.10's `RemoteShellProxy` answers a command that throws
 * (or rejects) with a `throw` envelope whose error carries `stack` whenever the
 * thrown `error.stack` is a string — i.e. always, for an `Error` — and the same
 * for every `Error` in its `cause` chain, which it forwards too; it has no option
 * to leave either out. In
 * direct mode every mint failure is such a throw, so the browser received the
 * server's stack (file paths, module layout, dependency versions). `toError`
 * redacts the APPKEY from it, but the stack itself does not belong on an
 * untrusted wire (SPEC §17).
 *
 * Stripping it here — the last hop before the wire — instead of on the thrown
 * error covers every `throw` this shell sends, whatever was thrown, by which
 * command (or input setter), with whatever `cause` chain, and does not depend on
 * how the shell reads `stack`. The `cause` chain is dropped as well: the spec's
 * Security note says producers SHOULD redact it by default on an untrusted
 * boundary. `name` / `message` / `code` cross unchanged
 * (`resultCode` / `retryable` never ride the envelope); the thrown error itself
 * is untouched, so an in-process caller of the Core — and the in-page Core of
 * local mode, which never passes through this helper — keeps its full stack.
 * `onThrow` sees the envelope's error BEFORE stripping, so the original stack
 * and cause can go to the server log.
 *
 * TODO: remove once `@wc-bindable/remote` no longer puts `stack` / `cause` on the wire
 * (wc-bindable-protocol#38).
 */
function withoutThrowInternals(transport: ServerTransport, onThrow: (error: unknown) => void): ServerTransport {
  return {
    send: (message: ServerMessage) => {
      if (message.type === "throw") {
        onThrow(message.error);
        transport.send({ ...message, error: forTheBrowser(message.error) });
        return;
      }
      transport.send(message);
    },
    onMessage: (handler) => transport.onMessage(handler),
    onClose: (handler) => transport.onClose?.(handler),
    dispose: () => transport.dispose?.(),
  };
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
      // The browser gets every `throw` without its server stack; the log keeps it
      // (redacted — an echoed `authorization=<APPKEY>` can sit in a stack's first
      // line). Logging must never stop the reply from being sent.
      const onThrow = (error: unknown): void => {
        try {
          const { message, stack, cause } = error as RemoteSerializedError;
          const record: Extract<AmiVoiceServerLogEvent, { type: "error" }> = {
            type: "error",
            message: redactSecrets(String(message)),
          };
          const code = getErrorCode(error);
          if (code) record.code = code;
          if (typeof stack === "string") record.stack = redactSecrets(stack);
          if (cause !== undefined) record.cause = redactSecrets(JSON.stringify(cause));
          log(record);
        } catch { /* the reply still goes out */ }
      };
      const shell = new RemoteShellProxy(core, withoutThrowInternals(transport, onThrow));
      // Log emitted Core errors (normalized code + message only — never payloads).
      // The detail is the Core's JSON-safe `SerializedError` — the same object the
      // shell forwards to the browser as the `error` update (SPEC §17).
      const onCoreError = (e: Event): void => {
        const detail = (e as CustomEvent<SerializedError | null>).detail;
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
