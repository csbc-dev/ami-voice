import { parseEvent, AUDIO_FRAME_PREFIX } from "./wnnProtocol.js";
import { AmiVoiceError } from "../errorCodes.js";
import type { IRealtimeSession, RealtimeSessionHandlers } from "../types.js";

/**
 * Shared realtime ("Wnn") session state machine.
 *
 * Both transports drive the SAME loop (docs/adr/0006 follow-up rule 3 — "no
 * parallel result code paths"):
 *  - relay: the server-side `AmiVoiceProvider` builds the `s` command with the
 *    permanent APPKEY and runs it against the AmiVoice WSS.
 *  - direct: the browser opens the AmiVoice WSS itself and runs the SAME loop
 *    with a server-built, pre-approved `s` command (one-time APPKEY baked in).
 *
 * This module is transport- and DOM-free: the caller injects the `RealtimeSocket`
 * and the already-built `startCommand`. It reuses the pure `parseEvent` normalizer
 * and the `AmiVoiceError` taxonomy, so interim/final/error handling is identical
 * across modes.
 */

/** ASCII `p` — the realtime audio-frame command byte. */
const AUDIO_FRAME_BYTE = AUDIO_FRAME_PREFIX.charCodeAt(0);

/**
 * Wrap a platform `WebSocket` as a `RealtimeSocket`. Shared by the server-side
 * provider (relay) and the browser-direct path so the adapter lives in one place
 * (a `ws`-lib / Blob-frame fix is then made once). Only string `onmessage` frames
 * are forwarded — events arrive as text; audio is sent (never received) binary.
 */
export function wrapWebSocket(url: string): RealtimeSocket {
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

/**
 * Minimal socket surface the realtime loop drives. The platform factories wrap
 * `WebSocket`; tests inject a fake. Events (`S`/`E`/`C`/`U`/`A`/`G`, acks) arrive
 * as text frames via `onmessage`; `p` audio is sent as binary.
 */
export interface RealtimeSocket {
  send(data: string | ArrayBufferView): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((data: string) => void) | null;
  onclose: (() => void) | null;
  onerror: ((err: unknown) => void) | null;
}

/** Default connect/`s`-ack deadline (ms). A stalled upstream must not hang start(). */
export const DEFAULT_CONNECT_TIMEOUT_MS = 10000;

/**
 * Run one realtime session over `socket`, sending `startCommand` on open and
 * resolving with an `IRealtimeSession` once AmiVoice acks `s`. Failures before
 * the ack reject; failures after it go to `handlers.onError`. A socket that
 * throws never throws out of the loop: a failed `s` send rejects the start, a
 * failed audio send ends the session (`onError`, then `onClose`, once), and a
 * close() that throws is swallowed everywhere but in `abort()`.
 *
 * @param socket           already-constructed transport (server WSS or browser WSS).
 * @param startCommand     the fully built `s` command (APPKEY / one-time token baked in).
 * @param handlers         result/lifecycle callbacks (Core or in-page Core).
 * @param stopTimeoutMs    graceful-stop fallback timeout (docs/adr/0003, Q4/D1).
 * @param connectTimeoutMs deadline from open → `s` ack; guards a stalled/half-open
 *                         upstream that never acks and never closes (default 10 s).
 */
export function runRealtimeSession(
  socket: RealtimeSocket,
  startCommand: string,
  handlers: RealtimeSessionHandlers,
  stopTimeoutMs: number,
  connectTimeoutMs: number = DEFAULT_CONNECT_TIMEOUT_MS,
): Promise<IRealtimeSession> {
  let started = false;
  // True once the `ready` promise has settled (resolve OR reject). Guards the
  // pre-start branches against a LATE event arriving in the async close window:
  // after a connect-timeout/onerror reject calls socket.close(), a real platform
  // WebSocket fires onclose asynchronously, so a late ok `s`-ack could still
  // arrive and (without this) flip `started`, making the deferred onclose
  // misreport a spurious "connection lost mid-session" drop.
  let settled = false;
  // Set by stop()/abort() so a teardown WE initiated is not misreported as an
  // upstream drop (Phase 3.1 / implementation-notes Q3).
  let intentionalClose = false;
  // Set once the session's end has been reported (`handlers.onClose`): by the
  // socket's close, or by a failed audio send, which ends the session itself
  // (see `failSession`). The end is reported once; nothing the socket delivers
  // after it (a late close, error or event) is reported.
  let closeReported = false;
  // Set once the loop has let go of the socket: `abort()`, a settled graceful
  // stop, or a failed audio send. A frame fed after that is dropped rather than
  // sent: the socket is closed or closing, and a send that throws there must
  // not fail a session the consumer already left (SPEC §10.1, §18).
  let released = false;
  let onEAck: (() => void) | null = null;
  // Set while a graceful stop() is in flight so an `onclose` that arrives before
  // the `e` ack (the common server-initiated-close-after-`e` shutdown) settles
  // the stop() immediately, rather than waiting out the full stopTimeoutMs
  // fallback (which would delay Core teardown and the relay token reap).
  let onSocketClosed: (() => void) | null = null;
  // Single in-flight graceful stop. A second concurrent stop() (e.g. a double-
  // clicked stop button over `@wc-bindable/remote` — `AmiVoiceCore.stop()` reads
  // `_session` and awaits before nulling it) returns this same promise instead of
  // re-arming onEAck/onSocketClosed/the fallback timer. Re-arming would orphan the
  // first stop's settle hooks so its promise only resolves on its own fallback
  // timer (the up-to-stopTimeoutMs delay the onSocketClosed hook exists to avoid).
  let stopping: Promise<void> | null = null;

  // `RealtimeSocket` is an injectable seam (tests/custom transports), and the
  // loop closes the socket from places a throw must not escape: a socket event
  // handler (`onopen`, the `e` ack, `onclose`), a timer (the connect deadline,
  // the graceful stop's fallback) and `feedAudio` (the audio channel's message
  // listener, the mic's frame callback). Every such close is quiet; only
  // `abort()`, a direct call by the consumer, still closes the socket as is.
  const closeQuietly = (): void => { try { socket.close(); } catch { /* already settling */ } };

  // A `p` frame whose send threw: the session cannot go on. `feedAudio` runs
  // from the relay audio channel's message listener (the server's `ws`
  // dispatch) and from the mic's frame callback (local / direct), so a throw
  // left there reached the platform's uncaught-exception reporting — in relay
  // the server PROCESS (`uncaughtException`: Node exits), unredacted — while
  // the session stayed `recognizing` with its upstream socket open. End it
  // instead, once: report the thrown value AS IS through `onError` (like the
  // `s` command's send in `onopen`: the Core's `toError` is the choke-point
  // that redacts it, SPEC §14 / §17) and the session's end through `onClose`,
  // without waiting for the socket's close, which a custom socket may never
  // report (the Core then tears down: `recognizing` / `connected` = false).
  // Both flags are set BEFORE the close, so the close it triggers (now or
  // later) is not reported a second time, nor as an upstream drop. An
  // in-flight graceful stop settles with it (`onSocketClosed`).
  const failSession = (err: unknown): void => {
    released = true;
    closeReported = true;
    closeQuietly();
    handlers.onError(err);
    handlers.onClose();
    onSocketClosed?.();
  };

  const ready = new Promise<void>((resolve, reject) => {
    // Bound the handshake: if the `s` ack never arrives (and the socket neither
    // closes nor errors — a half-open/black-holed upstream), reject so start()
    // does not hang with `loading` stuck true forever.
    const connectTimer = setTimeout(() => {
      if (started || settled) return;
      settled = true;
      reject(new AmiVoiceError("!", `AmiVoice did not ack the start command within ${connectTimeoutMs}ms`));
      closeQuietly();
    }, connectTimeoutMs);
    const clearConnectTimer = (): void => { clearTimeout(connectTimer); };
    socket.onopen = () => {
      // An `open` reported after the handshake already settled — the connect
      // deadline fired while the socket was still connecting, or it errored or
      // closed first — comes from a socket the loop has abandoned, whose close()
      // did not take (a custom socket's no-op close). Sending it `startCommand`
      // would hand the APPKEY (the one-time APPKEY in direct mode) to a session
      // nobody drives (SPEC §14). Send nothing and close it again. A second
      // `open` on a live session is ignored as well: `s` is not re-sent and the
      // session is not closed.
      if (settled) {
        if (!started) closeQuietly();
        return;
      }
      // `startCommand` carries the APPKEY (`authorization=`; the one-time APPKEY
      // in direct mode), and a socket can quote what it failed to send in its
      // exception (message, stack, cause). This handler runs from the socket's
      // own event dispatch, so a throw left here would bypass the Core's
      // redaction (`toError` / `toSerializedError`) and reach the platform's
      // uncaught-exception reporting raw — Node's `uncaughtException` (stderr,
      // and exit with no handler), a browser's global `error` event / console /
      // error tracker — while start() stayed `loading` until the connect
      // deadline. Fail the handshake instead, like an `s` rejection: reject with
      // the thrown value AS IS (the Core redacts and publishes it, SPEC §14 /
      // §17) and close the socket, since no close follows a failed send. If the
      // send already settled the handshake (a synchronous onerror / onclose),
      // that outcome stands and the throw is dropped.
      try {
        socket.send(startCommand);
      } catch (err) {
        if (settled) return;
        settled = true;
        clearConnectTimer();
        reject(err);
        closeQuietly();
      }
    };
    socket.onclose = () => {
      clearConnectTimer();
      if (!started) { if (!settled) { settled = true; reject(new AmiVoiceError("!", "AmiVoice connection closed before start")); } return; }
      // A failed audio send already ended the session and reported it.
      if (closeReported) return;
      closeReported = true;
      // After the session is up, a close we did NOT initiate is an upstream drop
      // mid-stream. AmiVoice has no resume (implementation-notes Q3), so v1 policy
      // is: surface it as an `error` + `connected=false` and require an explicit
      // `start()` to resume — never auto-reconnect, never silently drop already-
      // finalized `transcript` (the Core's teardown preserves it). SPEC §10.
      if (!intentionalClose) {
        handlers.onError(new AmiVoiceError("<", "AmiVoice connection lost mid-session"));
      }
      handlers.onClose();
      // Settle any in-flight graceful stop() the moment the socket actually
      // closes (idempotent via stop()'s `done` guard), so we don't wait out the
      // fallback timer when the server closes before acking `e`.
      onSocketClosed?.();
    };
    socket.onerror = (err) => {
      const e = err instanceof Error ? err : new AmiVoiceError("!", "AmiVoice socket error");
      if (!started) { if (!settled) { settled = true; clearConnectTimer(); reject(e); } }
      else if (!closeReported) handlers.onError(e);
    };
    socket.onmessage = (raw) => {
      const ev = parseEvent(raw);
      if (!started) {
        // A late event arriving after the handshake already settled (the close
        // window after a connect-timeout/onerror reject) must NOT flip `started`,
        // or the deferred onclose would misreport an upstream drop.
        if (settled) return;
        // Only the `s` ack matters before the session is up.
        if (ev.type === "ack" && ev.command === "s") {
          clearConnectTimer();
          // AmiVoice rejects `s` for many reasons (server busy, no grammar,
          // bad format, …), not just auth; its ack message is free text with no
          // reliable code prefix. Use a neutral/unknown code (retryable) rather
          // than asserting `"-"`/auth (which would falsely mark a transient
          // failure non-retryable). The raw message is preserved.
          if (ev.ok) { settled = true; started = true; resolve(); }
          else {
            // A protocol-level `s` rejection is not followed by a socket close
            // (unlike onerror), so close it here — mirroring the connect-timeout
            // branch — rather than orphan a live upstream WSS per rejected start.
            settled = true;
            reject(new AmiVoiceError("", ev.message ?? "AmiVoice rejected the start command"));
            closeQuietly();
          }
        }
        return;
      }
      // The session has ended (a socket that still delivers after a failed audio send).
      if (closeReported) return;
      switch (ev.type) {
        case "S": handlers.onSegmentStart(ev.ms); break;
        case "E": handlers.onSegmentEnd(ev.ms); break;
        case "C": handlers.onRecognitionStart(); break;
        case "U": handlers.onInterim(ev.result); break;
        case "A": handlers.onFinal(ev.result); break;
        case "ack":
          if (ev.command === "e") {
            // A non-ok `e` ack means AmiVoice failed to finalize the stream at
            // flush time — surface the error, but still settle the graceful stop
            // (the flush is over). SPEC §18's "never error" rule is scoped to the
            // lost-ack TIMEOUT fallback, not an explicit error ack.
            if (!ev.ok) handlers.onError(new AmiVoiceError("?", ev.message));
            onEAck?.();
          } else if (!ev.ok) {
            handlers.onError(new AmiVoiceError("?", ev.message));
          }
          break;
        case "G": // opaque server info (implementation-notes D4) — ignored for v1
        case "unknown":
          break;
      }
    };
  });

  return ready.then((): IRealtimeSession => ({
    feedAudio: (bytes: Uint8Array): void => {
      // The session is over (a failed send, a close, `abort()`, a settled stop):
      // nothing more is sent on its socket.
      if (released || closeReported) return;
      // 'p' command byte + raw audio, sent as one binary frame.
      const frame = new Uint8Array(bytes.length + 1);
      frame[0] = AUDIO_FRAME_BYTE;
      frame.set(bytes, 1);
      try {
        socket.send(frame);
      } catch (err) {
        failSession(err); // never escapes to the audio channel / the mic callback (SPEC §17)
      }
    },
    stop: (): Promise<void> => {
      // Idempotent: a second in-flight stop() joins the first rather than
      // re-arming the single-slot hooks/timer (which would orphan the first).
      if (stopping) return stopping;
      // Let go of already (a failed audio send, `abort()`): nothing to flush and
      // no `e` ack will come — settle at once instead of sending `e` to a
      // closed socket and waiting out the fallback timer.
      if (released) return Promise.resolve();
      stopping = new Promise<void>((resolve) => {
        let done = false;
        // A graceful stop is consumer-initiated teardown: mark it before the `e`
        // flush so a close during/after the flush is not reported as an upstream
        // drop (3.1). On a lost `e` ack the fallback timer still settles us.
        intentionalClose = true;
        const finish = (): void => {
          if (done) return;
          done = true;
          released = true;
          clearTimeout(timer);
          onSocketClosed = null;
          // Quiet: `finish` runs from the `e` ack (`onmessage`), the socket's
          // close (`onclose`) or the fallback timer. A close() that threw there
          // escaped from that event / timer as an uncaught exception and, with
          // `done` set and the timer cleared, left this stop() unresolved for
          // good: the Core stayed `recognizing` and refused every later start
          // (SPEC §18). The stop always settles.
          closeQuietly();
          resolve();
        };
        onEAck = finish; // settle when AmiVoice acks `e` (end-of-results, D1)
        // Also settle if the socket simply closes (server shutdown after `e`) —
        // onclose calls this, avoiding the up-to-stopTimeoutMs fallback delay.
        onSocketClosed = finish;
        const timer = setTimeout(finish, stopTimeoutMs);
        // The platform WebSocket only throws from send() while CONNECTING, which is
        // unreachable here (this stop() exists only after the `s` ack). But
        // `RealtimeSocket` is an injectable seam, so guard defensively: if a `send`
        // throws, treat the stop goal as already met and settle — rather than
        // rejecting and orphaning the fallback timer.
        try {
          socket.send("e");
        } catch {
          finish();
        }
      });
      return stopping;
    },
    abort: (): void => {
      // Already let go of (a failed audio send, a settled stop, a previous
      // abort): the socket was closed — do not close it again.
      if (released) return;
      intentionalClose = true;
      released = true;
      socket.close();
    },
  }));
}
