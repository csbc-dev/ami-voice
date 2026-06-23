// Combined example server: ONE process hosts BOTH Cores.
//
//   examples/voice-llm/  →  npm install  →  npm run server   (defaults to :3200)
//
// Two server-side Cores, two secrets, one process — and the browser sees neither:
//
//   • <ami-voice> Core (CSBC Case C, relay):  ws://localhost:3200/
//       @wc-bindable/remote control channel (JSON state + start/stop/abort)
//       + a separate binary audio channel (PCM frames), routed by subprotocol.
//       Holds AMIVOICE_APPKEY. Browser audio is relayed browser → server → AmiVoice.
//
//   • <ai-agent> Core (CSBC Case B1, remote): ws://localhost:3200/ai-agent
//       @wc-bindable/remote command channel (prompt in, streamed `content` out).
//       Holds AI_API_KEY. The browser never receives the provider credential.
//
// WS upgrades are routed by path; everything else (CORS preflight, the fake LLM
// HTTP endpoint, a landing page) is plain HTTP.
//
// THE TWO SECRETS NEVER LEAVE THIS PROCESS. With NEITHER key set the server runs
// FULLY OFFLINE against in-process fakes (see fakes.mjs), so the whole demo works
// with no credentials. Set AMIVOICE_APPKEY and/or AI_API_KEY to go real.
//
// ⚠ AUTH IS A SEAM, NOT A DEFAULT (SPEC §14). A real deployment authenticates the
//   peer BEFORE these handlers; this demo accepts everyone so it runs offline.
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
// One remote version for BOTH channels: as of @csbc-dev/ai-agent@0.2.0 both
// packages target @wc-bindable/* ^0.8, so a single @wc-bindable/remote serves the
// <ami-voice> relay control channel and the <ai-agent> remote command channel.
import { WebSocketServerTransport, RemoteShellProxy } from "@wc-bindable/remote";
import { createAmiVoiceRelayServer, AmiVoiceProvider } from "@csbc-dev/ami-voice/server";
import { wsSocketFactory, startFakeRealtime, handleFakeLlm } from "./fakes.mjs";

// @csbc-dev/ai-agent's main barrel eagerly defines <ai-agent> (extends
// HTMLElement), so a bare-Node import needs a minimal shim. We only use the
// DOM-free AiCore; dynamic import runs AFTER the shim is in place.
globalThis.HTMLElement ??= class {};
const { AiCore } = await import("@csbc-dev/ai-agent");

const PORT = Number(process.env.PORT ?? 3200);

// ── AmiVoice (speech) ──────────────────────────────────────────────────────────
const APPKEY = process.env.AMIVOICE_APPKEY ?? "";
const AMI_OFFLINE = !APPKEY;
const fakeRealtimeUrl = AMI_OFFLINE ? await startFakeRealtime() : "";

function createProvider() {
  if (AMI_OFFLINE) {
    return new AmiVoiceProvider({
      appKey: "FAKE",
      realtimeEndpoint: fakeRealtimeUrl,
      realtimeNoLogEndpoint: fakeRealtimeUrl,
      socketFactory: wsSocketFactory,
    });
  }
  return new AmiVoiceProvider({ appKey: APPKEY }); // real endpoints are the defaults
}

const relay = createAmiVoiceRelayServer({
  createProvider,
  logger: (e) => console.log("[ami-voice]", JSON.stringify(e)),
});

// ── LLM (生成AI) ────────────────────────────────────────────────────────────────
const AI_API_KEY = process.env.AI_API_KEY ?? "";
const AI_OFFLINE = !AI_API_KEY;
// Offline: pin the OpenAI provider at our in-process fake SSE endpoint so AiCore
// runs its real provider/streaming code against a fake target (no key needed).
const AI_PROVIDER = AI_OFFLINE ? "openai" : (process.env.AI_PROVIDER || "anthropic");
const AI_MODEL = AI_OFFLINE ? "fake" : (process.env.AI_MODEL || "claude-haiku-4-5");
const AI_BASE_URL = AI_OFFLINE ? `http://localhost:${PORT}/fake-llm` : (process.env.AI_BASE_URL || "");
const AI_KEY = AI_OFFLINE ? "FAKE" : AI_API_KEY;
const AI_SYSTEM = process.env.AI_SYSTEM
  || "あなたは会議の書記です。次の文字起こしを3点以内で日本語要約し、ToDoがあれば「ToDo:」として箇条書きしてください。";

// AiCore subclass that injects the provider credential server-side and ignores
// any provider/key/model/system the (untrusted) browser tries to set. This is the
// security boundary: the single server-held key is never sent to a client-chosen
// destination, and the client cannot swap to a costlier model or rewrite the
// system prompt. (Mirrors @csbc-dev/ai-agent's remote example server.)
class ServerAiCore extends AiCore {
  set provider(_clientValue) { super.provider = AI_PROVIDER; }
  get provider() { return super.provider; }

  async send(prompt, options) {
    return super.send(prompt, {
      ...options,
      apiKey: AI_KEY,
      baseUrl: AI_BASE_URL,   // locked to the key's trust boundary; never the client value
      model: AI_MODEL,
      system: AI_SYSTEM,
    });
  }
}

// ── HTTP: CORS, the fake-LLM SSE endpoint (offline), a landing page ─────────────
// Wide-open CORS for the localhost demo. PRODUCTION: pin Access-Control-Allow-Origin
// to your app origin. Note WS upgrades are NOT subject to CORS, so origin/auth for
// the sockets must be enforced in the `upgrade` handler below, not here.
function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

const LANDING = `<!doctype html><meta charset="utf-8"><title>voice-llm example server</title>
<style>body{font-family:system-ui,sans-serif;max-width:640px;margin:3rem auto;padding:0 1rem;color:#1a1a2e}
code{background:#f0f0f0;padding:1px 5px;border-radius:4px}</style>
<h1>&lt;ami-voice&gt; × &lt;ai-agent&gt; — example server</h1>
<ul>
<li>speech relay : <code>ws://localhost:${PORT}/</code> (control + audio)</li>
<li>llm remote   : <code>ws://localhost:${PORT}/ai-agent</code></li>
</ul>
<p>AmiVoice: <strong>${AMI_OFFLINE ? "FAKE (offline)" : "REAL (APPKEY set)"}</strong> ·
   LLM: <strong>${AI_OFFLINE ? "FAKE (offline)" : `REAL (${AI_PROVIDER} ${AI_MODEL})`}</strong></p>
<p>Run the client with <code>npm run dev</code> (Vite, its own port).</p>`;

const server = createServer(async (req, res) => {
  cors(res);
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const { pathname } = new URL(req.url, "http://localhost");

  // Offline fake LLM (OpenAI-compatible): POST /fake-llm/v1/chat/completions
  if (pathname === "/fake-llm/v1/chat/completions" && req.method === "POST") {
    try { await handleFakeLlm(req, res); }
    catch (err) { res.writeHead(500); res.end(String(err?.message ?? err)); }
    return;
  }

  if (pathname === "/") { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(LANDING); return; }
  res.writeHead(404); res.end("not found");
});

// ── WebSocket: two noServer instances, routed by upgrade path ───────────────────
//
// SECURITY SEAM (SPEC §14). @wc-bindable/remote is NOT a security boundary. A real
// deployment authenticates the peer HERE before any socket reaches a handler, and
// authorizes what it may do. This demo accepts everyone so it runs offline.
//
//   - authenticatePeer(req): resolve the principal (cookie / bearer / mTLS).
//   - authorize(principal, …): enforce engine / model / quota policy. The bindable
//     inputs (engine, codec, provider) are client-writable, so this CANNOT live in
//     the page — it must run server-side here.
function authenticatePeer(req) {
  return { id: "demo-anon", remoteAddress: req.socket.remoteAddress };
}
function authorize(_principal /*, engine, codec, provider, … */) {
  return true; // e.g. check tenant quota / allowed engines+models here.
}

const amiWss = new WebSocketServer({
  noServer: true,
  // Two kinds of client hit this WSS. CONTROL sends no subprotocol → `protocols`
  // is empty → `?? false` accepts it with no negotiated protocol (sock.protocol
  // == ""). AUDIO sends the session token as its one subprotocol → we echo it
  // back so the upgrade succeeds and sock.protocol carries the token downstream.
  handleProtocols: (protocols) => [...protocols][0] ?? false,
});
const aiWss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const { pathname } = new URL(req.url, "http://localhost");
  const wss = pathname === "/ai-agent" ? aiWss : amiWss;
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

// <ami-voice> relay: control (no subprotocol) + audio (subprotocol = session token).
amiWss.on("connection", (sock, req) => {
  const principal = authenticatePeer(req);
  if (!principal) { sock.close(1008, "unauthenticated"); return; }
  if (sock.protocol) {
    // Audio connection. `sock.protocol` is the WS subprotocol the browser sent =
    // the session token the control channel minted; the relay matches it to the
    // open control session internally (that's how audio bytes find their Core).
    // PRODUCTION: also verify this is the SAME authenticated principal that opened
    // that control session before relaying its bytes.
    relay.handleAudioConnection(sock, sock.protocol);
    return;
  }
  // Control connection: @wc-bindable/remote JSON proxy.
  if (!authorize(principal)) { sock.close(1008, "forbidden"); return; }
  const session = relay.handleControlConnection(
    new WebSocketServerTransport(sock),
    { peerAddress: req.socket.remoteAddress },
  );
  // dispose() tears down the upstream AmiVoice WSS, the control channel, and the
  // relay's session-token table — so the close handler captures `session` in its
  // closure and needs no extra bookkeeping map.
  sock.on("close", () => session.dispose());
});

// <ai-agent> remote Core: one AiCore per connection (owns history + abort state).
aiWss.on("connection", (sock, req) => {
  const principal = authenticatePeer(req);
  if (!principal) { sock.close(1008, "unauthenticated"); return; }
  if (!authorize(principal)) { sock.close(1008, "forbidden"); return; }
  const core = new ServerAiCore();
  core.provider = AI_PROVIDER; // pinned by the setter above
  const shell = new RemoteShellProxy(core, new WebSocketServerTransport(sock));
  sock.on("close", () => { core.abort(); shell.dispose(); });
});

server.listen(PORT, () => {
  console.log(`[voice-llm] server on http://localhost:${PORT}`);
  console.log(`  speech relay : ws://localhost:${PORT}/        (AmiVoice: ${AMI_OFFLINE ? "FAKE offline" : "REAL"})`);
  console.log(`  llm remote   : ws://localhost:${PORT}/ai-agent (LLM: ${AI_OFFLINE ? "FAKE offline" : `REAL ${AI_PROVIDER} ${AI_MODEL}`})`);
});
