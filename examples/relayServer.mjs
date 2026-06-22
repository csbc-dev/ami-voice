// Runnable relay server example (plan 1.1).
//
//   npm run build && npm run example
//
// Hosts the two relay channels a browser `<ami-voice transport="relay">` needs,
// on ONE port (SPEC §11.3 / implementation-notes Q1 "same server"):
//   - control: @wc-bindable/remote over WebSocket (JSON; state + start/stop/...)
//   - audio:   a separate binary WebSocket (PCM frames → core.feedAudio)
//
// The browser opens both at the SAME `remote-url`. The control connection
// carries no subprotocol; the audio connection carries the session token in
// `Sec-WebSocket-Protocol`. We route by subprotocol presence.
//
// Without AMIVOICE_APPKEY it talks to an in-process FAKE AmiVoice (so it runs
// with no credentials). Set AMIVOICE_APPKEY to point at the real endpoint.
//
// ⚠ AUTH IS A PLACEHOLDER. SPEC §14 / ADR 0002: a real deployment MUST
//   authenticate the peer BEFORE handing the socket to the relay handlers, and
//   the audio token (subprotocol) only proves session ownership because the
//   control peer was authenticated.
import { WebSocketServer } from "ws";
import WebSocket from "ws";
import { WebSocketServerTransport } from "@wc-bindable/remote";
import { createAmiVoiceRelayServer, AmiVoiceProvider } from "../dist/server.js";

const APPKEY = process.env.AMIVOICE_APPKEY ?? "";
const PORT = Number(process.env.PORT ?? 3100);

/** Adapt a Node `ws` client into the provider's RealtimeSocket. */
function wsSocketFactory(url) {
  const ws = new WebSocket(url);
  const sock = { send: (d) => ws.send(d), close: () => ws.close(), onopen: null, onmessage: null, onclose: null, onerror: null };
  ws.on("open", () => sock.onopen?.());
  ws.on("message", (data, isBinary) => { if (!isBinary) sock.onmessage?.(data.toString()); });
  ws.on("close", () => sock.onclose?.());
  ws.on("error", (e) => sock.onerror?.(e));
  return sock;
}

/** Minimal in-process fake AmiVoice (acks s/e, canned interim/final). */
function startFakeAmiVoice() {
  const wss = new WebSocketServer({ port: 0 });
  wss.on("connection", (sock) => {
    let sawAudio = false;
    sock.on("message", (data, isBinary) => {
      if (isBinary) {
        if (!sawAudio) { sawAudio = true; sock.send('U {"text":"こん","results":[{"tokens":[]}]}'); }
        return;
      }
      const c = data.toString()[0];
      if (c === "s") sock.send("s");
      else if (c === "e") { sock.send('A {"text":"こんにちは","results":[{"text":"こんにちは","confidence":0.95,"tokens":[]}]}'); sock.send("e"); }
    });
  });
  return new Promise((resolve) => wss.on("listening", () => resolve(`ws://127.0.0.1:${wss.address().port}/`)));
}

const realtimeEndpoint = APPKEY ? "wss://acp-api.amivoice.com/v1/" : await startFakeAmiVoice();
const realtimeNoLogEndpoint = APPKEY ? "wss://acp-api.amivoice.com/v1/nolog/" : realtimeEndpoint;

const relay = createAmiVoiceRelayServer({
  createProvider: () => new AmiVoiceProvider({
    appKey: APPKEY || "FAKE",
    realtimeEndpoint,
    realtimeNoLogEndpoint,
    socketFactory: wsSocketFactory,
  }),
});

const sessions = new Map();
const wss = new WebSocketServer({
  port: PORT,
  // Echo the requested subprotocol so the audio session token survives the
  // handshake (SPEC §11.3). Control connections offer none → not called.
  handleProtocols: (protocols) => [...protocols][0] ?? false,
});
wss.on("connection", (sock) => {
  if (sock.protocol) {
    // Audio connection: subprotocol carries the session token.
    // TODO(auth): the token proves session ownership only because the control
    // peer was authenticated — verify the peer too.
    relay.handleAudioConnection(sock, sock.protocol);
    return;
  }
  // Control connection: @wc-bindable/remote JSON proxy.
  // TODO(auth): authenticate `sock` here before handing it to the relay.
  const session = relay.handleControlConnection(new WebSocketServerTransport(sock));
  sessions.set(sock, session);
  sock.on("close", () => { session.dispose(); sessions.delete(sock); });
});

console.log(`[ami-voice] relay up (single port).
  set <ami-voice remote-url="ws://localhost:${PORT}/">  (control + audio share this URL)
  AmiVoice: ${APPKEY ? "REAL (AMIVOICE_APPKEY set)" : "FAKE (no APPKEY) — set AMIVOICE_APPKEY for real recognition"}`);
