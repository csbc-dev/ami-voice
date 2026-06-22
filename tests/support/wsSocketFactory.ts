import WebSocket from "ws";
import type { RealtimeSocket } from "../../src/providers/AmiVoiceProvider";

/**
 * Adapt a Node `ws` client into the provider's `RealtimeSocket`. Lets the
 * server-side provider connect to AmiVoice (or the fake) under Node, where the
 * default `globalThis.WebSocket` factory is not always desirable.
 */
export function wsSocketFactory(url: string): RealtimeSocket {
  const ws = new WebSocket(url);
  const sock: RealtimeSocket = {
    send: (data) => ws.send(data),
    close: () => ws.close(),
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  ws.on("open", () => sock.onopen?.());
  ws.on("message", (data: Buffer, isBinary: boolean) => {
    if (!isBinary) sock.onmessage?.(data.toString());
  });
  ws.on("close", () => sock.onclose?.());
  ws.on("error", (err) => sock.onerror?.(err));
  return sock;
}
