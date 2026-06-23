// Runnable relay server example (plan 1.1) — REALTIME ONLY.
//
//   npm run build && npm run example
//
// ⚠ This minimal demo serves ONLY the realtime relay channels. It does NOT serve
//   the file-recognition endpoint (POST /api/recognize) the framework examples'
//   "File" tab needs. For those five clients (React / Vue / Vanilla / @wcstack/state
//   / @wcstack/signals) run the SUPERSET server instead — it adds /api/recognize
//   and static hosting on the same port:
//       npm run examples:server      # examples/shared/server.mjs
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
// ⚠ AUTH IS A SEAM, NOT A DEFAULT. SPEC §14 "Deployment security profile": a real
//   deployment authenticates the peer in `authenticatePeer()` and enforces policy
//   in `authorize()` BEFORE the relay handlers (this demo accepts everyone so it
//   runs offline). The audio token (subprotocol) only proves session ownership
//   because the control peer was authenticated. See the SECURITY SEAM block below.
import { WebSocketServer } from "ws";
import { WebSocketServerTransport } from "@wc-bindable/remote";
import { createAmiVoiceRelayServer, AmiVoiceProvider } from "../dist/server.js";
// Reuse the SHARED in-process fake (one implementation, one behavior) rather than
// re-defining the socket factory + fake AmiVoice here.
import { wsSocketFactory, startFakeRealtime } from "./shared/fakeAmiVoice.mjs";

const APPKEY = process.env.AMIVOICE_APPKEY ?? "";
const PORT = Number(process.env.PORT ?? 3100);

const realtimeEndpoint = APPKEY ? "wss://acp-api.amivoice.com/v1/" : await startFakeRealtime();
const realtimeNoLogEndpoint = APPKEY ? "wss://acp-api.amivoice.com/v1/nolog/" : realtimeEndpoint;

const relay = createAmiVoiceRelayServer({
  createProvider: () => new AmiVoiceProvider({
    appKey: APPKEY || "FAKE",
    realtimeEndpoint,
    realtimeNoLogEndpoint,
    socketFactory: wsSocketFactory,
  }),
  // (3.5) Structured logging — connection open/close, rejected audio, emitted
  // errors. Records never carry the APPKEY, the audio token, or wire payloads.
  logger: (e) => console.log("[ami-voice]", JSON.stringify(e)),
});

// ─────────────────────────────────────────────────────────────────────────────
// SECURITY SEAM (SPEC §14 "Deployment security profile"). `@wc-bindable/remote`
// is NOT a security boundary. A real deployment authenticates the peer HERE,
// before any socket reaches the relay handlers, and authorizes what it may do.
//
//   - authenticatePeer(req): resolve the principal from the handshake (session
//     cookie / bearer header / mTLS). Return null to reject the connection.
//   - authorize(principal, ...): enforce engine/grammar/profile/quota policy
//     (the bindable inputs are client-writable, so this CANNOT live in the page).
//
// This demo accepts everyone (no credentials) so `npm run example` runs offline.
// Replace the body — the call sites are already wired.
function authenticatePeer(req) {
  // e.g. verify req.headers.cookie / a bearer token / a signed query nonce.
  return { id: "demo-anon", remoteAddress: req.socket.remoteAddress };
}
function authorize(_principal /*, engine, profileId, … */) {
  return true; // e.g. check tenant quota / allowed engines here.
}
// ─────────────────────────────────────────────────────────────────────────────

const sessions = new Map();
const wss = new WebSocketServer({
  port: PORT,
  // Echo the requested subprotocol so the audio session token survives the
  // handshake (SPEC §11.3). Control connections offer none → not called.
  handleProtocols: (protocols) => [...protocols][0] ?? false,
});
wss.on("connection", (sock, req) => {
  const principal = authenticatePeer(req);
  if (!principal) { sock.close(1008, "unauthenticated"); return; }

  if (sock.protocol) {
    // Audio connection: the subprotocol carries the session token. The relay
    // rejects any token with no live session. PRODUCTION: also verify this audio
    // peer is the SAME principal that opened the control session the token
    // belongs to (SPEC §14 — bind audio to the authenticated session); track the
    // token returned to the browser over the control channel in your own
    // registry and compare it to `principal.id` here.
    relay.handleAudioConnection(sock, sock.protocol);
    return;
  }

  // Control connection: @wc-bindable/remote JSON proxy.
  if (!authorize(principal)) { sock.close(1008, "forbidden"); return; }
  const session = relay.handleControlConnection(
    new WebSocketServerTransport(sock),
    { peerAddress: req.socket.remoteAddress },
  );
  sessions.set(sock, session);
  sock.on("close", () => { session.dispose(); sessions.delete(sock); });
});

console.log(`[ami-voice] relay up (single port).
  set <ami-voice remote-url="ws://localhost:${PORT}/">  (control + audio share this URL)
  AmiVoice: ${APPKEY ? "REAL (AMIVOICE_APPKEY set)" : "FAKE (no APPKEY) — set AMIVOICE_APPKEY for real recognition"}`);
