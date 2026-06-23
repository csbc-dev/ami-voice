// Offline fake AmiVoice — lets every example run with NO credentials.
//
// Two surfaces, mirroring the real API (CLAUDE.md §"What AmiVoice is"):
//   - realtime: a tiny in-process WSS that acks `s`/`e` and pushes canned
//     `U` (interim) / `A` (final) events as audio arrives.
//   - file:     a canned normalized result, returned without touching AmiVoice.
//
// When AMIVOICE_APPKEY is set the shared server bypasses ALL of this and talks to
// the real provider instead (browser → server → AmiVoice).
import { WebSocketServer } from "ws";
import WebSocket from "ws";

/** Adapt a Node `ws` client into the provider's RealtimeSocket shape. */
export function wsSocketFactory(url) {
  const ws = new WebSocket(url);
  const sock = {
    send: (d) => ws.send(d),
    close: () => ws.close(),
    onopen: null, onmessage: null, onclose: null, onerror: null,
  };
  ws.on("open", () => sock.onopen?.());
  ws.on("message", (data, isBinary) => { if (!isBinary) sock.onmessage?.(data.toString()); });
  ws.on("close", () => sock.onclose?.());
  ws.on("error", (e) => sock.onerror?.(e));
  return sock;
}

/**
 * Minimal in-process fake AmiVoice realtime endpoint. Acks `s`/`e` and, as audio
 * frames stream in, emits a couple of interim `U` events then a fixed `A` final.
 * Returns the `ws://…` URL to hand the provider as its realtime endpoint.
 */
export function startFakeRealtime() {
  const PHRASES = ["こんにちは", "これは", "デモ音声です"];
  const wss = new WebSocketServer({ port: 0 });
  wss.on("connection", (sock) => {
    let frames = 0;
    let idx = 0;
    sock.on("message", (data, isBinary) => {
      if (isBinary) {
        frames++;
        // Every ~8 audio frames, advance the canned transcript: one interim then
        // a fixed final, so the UI shows the interim→final transition for real.
        if (frames % 8 === 0 && idx < PHRASES.length) {
          const phrase = PHRASES[idx++];
          sock.send(`U {"text":"${phrase}","results":[{"tokens":[{"written":"${phrase}"}]}]}`);
          sock.send(`A {"text":"${phrase}","results":[{"text":"${phrase}","confidence":0.95,"starttime":${frames * 20},"endtime":${frames * 20 + 200},"tokens":[{"written":"${phrase}","spoken":"${phrase}","confidence":0.95,"starttime":0,"endtime":200}]}]}`);
        }
        return;
      }
      const cmd = data.toString()[0];
      if (cmd === "s") sock.send("s");
      else if (cmd === "p") sock.send("p");
      else if (cmd === "e") {
        // Flush a trailing final for whatever audio remained, then ack `e`.
        if (idx < PHRASES.length) {
          const phrase = PHRASES[idx++];
          sock.send(`A {"text":"${phrase}","results":[{"text":"${phrase}","confidence":0.9,"starttime":0,"endtime":200,"tokens":[]}]}`);
        }
        sock.send("e");
      }
    });
  });
  return new Promise((resolve) => wss.on("listening", () => resolve(`ws://127.0.0.1:${wss.address().port}/`)));
}

/**
 * Canned file-recognition result (offline). Shape matches `RecognitionSegment[]`
 * so the server can normalize/derive speakers exactly as the real path does.
 */
export function fakeRecognizeFile(_bytes, _options) {
  return [
    {
      text: "これはファイル認識のデモ結果です。",
      confidence: 0.93,
      starttime: 0,
      endtime: 1800,
      utteranceid: "fake-0",
      tokens: [
        { written: "これは", spoken: "これは", confidence: 0.95, starttime: 0, endtime: 400 },
        { written: "ファイル認識の", spoken: "ファイルにんしきの", confidence: 0.92, starttime: 400, endtime: 1100 },
        { written: "デモ結果です。", spoken: "でもけっかです", confidence: 0.91, starttime: 1100, endtime: 1800 },
      ],
    },
    {
      text: "AMIVOICE_APPKEY を設定すると本物の認識結果になります。",
      confidence: 0.9,
      starttime: 1800,
      endtime: 4200,
      utteranceid: "fake-1",
      tokens: [],
    },
  ];
}
