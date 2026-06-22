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

/**
 * Run one realtime session over `socket`, sending `startCommand` on open and
 * resolving with an `IRealtimeSession` once AmiVoice acks `s`. Failures before
 * the ack reject; failures after it go to `handlers.onError`.
 *
 * @param socket        already-constructed transport (server WSS or browser WSS).
 * @param startCommand  the fully built `s` command (APPKEY / one-time token baked in).
 * @param handlers      result/lifecycle callbacks (Core or in-page Core).
 * @param stopTimeoutMs graceful-stop fallback timeout (docs/adr/0003, Q4/D1).
 */
export function runRealtimeSession(
  socket: RealtimeSocket,
  startCommand: string,
  handlers: RealtimeSessionHandlers,
  stopTimeoutMs: number,
): Promise<IRealtimeSession> {
  let started = false;
  // Set by stop()/abort() so a teardown WE initiated is not misreported as an
  // upstream drop (Phase 3.1 / implementation-notes Q3).
  let intentionalClose = false;
  let onEAck: (() => void) | null = null;

  const ready = new Promise<void>((resolve, reject) => {
    socket.onopen = () => socket.send(startCommand);
    socket.onclose = () => {
      if (!started) { reject(new AmiVoiceError("!", "AmiVoice connection closed before start")); return; }
      // After the session is up, a close we did NOT initiate is an upstream drop
      // mid-stream. AmiVoice has no resume (implementation-notes Q3), so v1 policy
      // is: surface it as an `error` + `connected=false` and require an explicit
      // `start()` to resume — never auto-reconnect, never silently drop already-
      // finalized `transcript` (the Core's teardown preserves it). SPEC §10.
      if (!intentionalClose) {
        handlers.onError(new AmiVoiceError("<", "AmiVoice connection lost mid-session"));
      }
      handlers.onClose();
    };
    socket.onerror = (err) => {
      const e = err instanceof Error ? err : new AmiVoiceError("!", "AmiVoice socket error");
      if (!started) reject(e);
      else handlers.onError(e);
    };
    socket.onmessage = (raw) => {
      const ev = parseEvent(raw);
      if (!started) {
        // Only the `s` ack matters before the session is up.
        if (ev.type === "ack" && ev.command === "s") {
          if (ev.ok) { started = true; resolve(); }
          else reject(new AmiVoiceError("-", ev.message ?? "AmiVoice rejected the start command"));
        }
        return;
      }
      switch (ev.type) {
        case "S": handlers.onSegmentStart(ev.ms); break;
        case "E": handlers.onSegmentEnd(ev.ms); break;
        case "C": handlers.onRecognitionStart(); break;
        case "U": handlers.onInterim(ev.result); break;
        case "A": handlers.onFinal(ev.result); break;
        case "ack":
          if (ev.command === "e") onEAck?.();
          else if (!ev.ok) handlers.onError(new AmiVoiceError("?", ev.message));
          break;
        case "G": // opaque server info (implementation-notes D4) — ignored for v1
        case "unknown":
          break;
      }
    };
  });

  return ready.then((): IRealtimeSession => ({
    feedAudio: (bytes: Uint8Array): void => {
      // 'p' command byte + raw audio, sent as one binary frame.
      const frame = new Uint8Array(bytes.length + 1);
      frame[0] = AUDIO_FRAME_BYTE;
      frame.set(bytes, 1);
      socket.send(frame);
    },
    stop: (): Promise<void> => new Promise<void>((resolve) => {
      let done = false;
      // A graceful stop is consumer-initiated teardown: mark it before the `e`
      // flush so a close during/after the flush is not reported as an upstream
      // drop (3.1). On a lost `e` ack the fallback timer still settles us.
      intentionalClose = true;
      const finish = (): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        socket.close();
        resolve();
      };
      onEAck = finish; // settle when AmiVoice acks `e` (end-of-results, D1)
      const timer = setTimeout(finish, stopTimeoutMs);
      socket.send("e");
    }),
    abort: (): void => { intentionalClose = true; socket.close(); },
  }));
}
