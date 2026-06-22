import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import type { AddressInfo } from "node:net";

/**
 * Fake AmiVoice realtime WSS for tests / the runnable example (plan 1.2).
 * Speaks the realtime protocol: acks `s` / `e`, and replays a canned interim
 * (`U`) after the first audio frame, plus a final (`A`) on `e`. No APPKEY check
 * (it just acks), so it stands in for AmiVoice without credentials.
 */

export interface FakeAmiVoiceOptions {
  /** Interim text emitted (as `U`) after the first audio frame. */
  interimText?: string;
  /** Final text emitted (as `A`) on `e`, before the `e` ack. */
  finalText?: string;
  /** When set, the start command is rejected: `s <reason>`. */
  rejectStart?: string;
}

export interface FakeAmiVoiceHandle {
  url: string;
  connectionCount(): number;
  close(): Promise<void>;
}

export function startFakeAmiVoice(opts: FakeAmiVoiceOptions = {}): Promise<FakeAmiVoiceHandle> {
  const interimText = opts.interimText ?? "こん";
  const finalText = opts.finalText ?? "こんにちは";
  let connections = 0;

  const wss = new WebSocketServer({ port: 0 });

  wss.on("connection", (sock: WsSocket) => {
    connections++;
    let sawAudio = false;
    sock.on("message", (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        // 'p' audio frame (first byte 0x70). Emit one interim on the first frame.
        if (!sawAudio) {
          sawAudio = true;
          sock.send(`U ${JSON.stringify({ text: interimText, results: [{ tokens: [] }] })}`);
        }
        return;
      }
      const text = data.toString();
      switch (text[0]) {
        case "s":
          sock.send(opts.rejectStart ? `s ${opts.rejectStart}` : "s");
          break;
        case "e":
          sock.send(`A ${JSON.stringify({ text: finalText, results: [{ text: finalText, confidence: 0.95, tokens: [] }] })}`);
          sock.send("e");
          break;
        // 'p' as text is never sent by the provider; ignore anything else.
      }
    });
  });

  return new Promise<FakeAmiVoiceHandle>((resolve) => {
    wss.on("listening", () => {
      const { port } = wss.address() as AddressInfo;
      resolve({
        url: `ws://127.0.0.1:${port}/`,
        connectionCount: () => connections,
        close: () => new Promise<void>((r) => wss.close(() => r())),
      });
    });
  });
}
