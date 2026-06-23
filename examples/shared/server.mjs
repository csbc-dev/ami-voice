// Shared example server for @csbc-dev/ami-voice.
//
//   npm run build            # (in the package root) — produces dist/
//   node examples/shared/server.mjs
//
// ONE server, used by ALL five client examples (React / Vue / Vanilla /
// @wcstack/state / @wcstack/signals). It hosts every surface the examples need:
//
//   • Realtime (Case C, relay default — docs/adr/0003):
//       WS at  ws://localhost:3100/   → @wc-bindable/remote control channel
//                                        (JSON state + start/stop/abort)
//                                      + a separate binary audio channel
//                                        (PCM frames), routed by subprotocol.
//     The browser <ami-voice transport="relay"> opens both at this one URL.
//
//   • File recognition (Case B1 — docs/adr/0001):
//       POST http://localhost:3100/api/recognize   (raw audio bytes in the body)
//       → server runs AmiVoiceProvider.recognizeFile and returns normalized JSON.
//     The <ami-voice> element exposes only start/stop/abort/reset and the remote
//     wire is JSON-only, so file bytes go server-side over HTTP — never the element.
//
//   • Static hosting for the two buildless examples (@wcstack/state, signals)
//     and the built package (served at /vendor/ami-voice/ for those pages).
//
// THE APPKEY NEVER LEAVES THIS PROCESS. Without AMIVOICE_APPKEY it talks to an
// in-process FAKE AmiVoice so everything runs offline. Set AMIVOICE_APPKEY to
// point realtime + file at the real endpoints.
//
// ⚠ AUTH IS A SEAM, NOT A DEFAULT (SPEC §14). A real deployment authenticates the
//   peer in authenticatePeer() BEFORE the relay handlers; this demo accepts
//   everyone so it runs with no credentials. See the SECURITY SEAM block.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize, extname } from "node:path";
import { WebSocketServer } from "ws";
import { WebSocketServerTransport } from "@wc-bindable/remote";
import { createAmiVoiceRelayServer, AmiVoiceProvider, toSpeakerSegment } from "../../dist/server.js";
import { wsSocketFactory, startFakeRealtime, fakeRecognizeFile } from "./fakeAmiVoice.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXAMPLES_DIR = join(__dirname, "..");        // examples/
const PACKAGE_DIR = join(EXAMPLES_DIR, "..");      // repo root
const DIST_DIR = join(PACKAGE_DIR, "dist");
// @wcstack/signals splits a shared reactive core between its `.` and `/dom`
// entries; serving the built dist locally (not via a CDN) keeps that core a
// SINGLE instance so reactivity holds across the seam (see wcstack-signals/).
const SIGNALS_DIR = join(__dirname, "node_modules", "@wcstack", "signals", "dist");

const APPKEY = process.env.AMIVOICE_APPKEY ?? "";
const PORT = Number(process.env.PORT ?? 3100);
const OFFLINE = !APPKEY;

// One fake realtime upstream, reused by every relay provider (offline only).
const fakeRealtimeUrl = OFFLINE ? await startFakeRealtime() : "";

/** Build the provider each relay control connection gets its own Core wired to. */
function createProvider() {
  if (OFFLINE) {
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
  // Structured logging (SPEC §14.5) — never carries the APPKEY, the audio token,
  // or wire payloads.
  logger: (e) => console.log("[ami-voice]", JSON.stringify(e)),
});

// One reusable provider for the file (Case B1) path when a real key is present.
const fileProvider = OFFLINE ? null : new AmiVoiceProvider({ appKey: APPKEY });

// ─────────────────────────────────────────────────────────────────────────────
// HTTP: file-recognition endpoint + static hosting (+ permissive dev CORS so the
// Vite examples on their own origin can POST here).
// ─────────────────────────────────────────────────────────────────────────────
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".wav": "audio/wav",
  ".svg": "image/svg+xml",
};

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** Map a URL path to a file on disk under one of the allowed roots, or null. */
function resolveStatic(urlPath) {
  // /vendor/ami-voice/** → the built package, mounted at the package ROOT so the
  // `/auto/remoteEnv` side-effect entry (src/auto/remoteEnv.js → ../../dist/index.js)
  // resolves buildless. Only dist/ and src/auto/ are exposed.
  if (urlPath.startsWith("/vendor/ami-voice/")) {
    const rel = urlPath.slice("/vendor/ami-voice/".length);
    const file = normalize(join(PACKAGE_DIR, rel));
    const autoRoot = join(PACKAGE_DIR, "src", "auto");
    return (file.startsWith(DIST_DIR) || file.startsWith(autoRoot)) ? file : null;
  }
  // /vendor/signals/** → @wcstack/signals built dist (single shared core chunk).
  if (urlPath.startsWith("/vendor/signals/")) {
    const rel = urlPath.slice("/vendor/signals/".length);
    const file = normalize(join(SIGNALS_DIR, rel));
    return file.startsWith(SIGNALS_DIR) ? file : null;
  }
  // Everything else is served from examples/ (the buildless pages + shared css).
  const rel = urlPath === "/" ? "/index.html" : urlPath;
  const withIndex = rel.endsWith("/") ? rel + "index.html" : rel;
  const file = normalize(join(EXAMPLES_DIR, withIndex));
  return file.startsWith(EXAMPLES_DIR) ? file : null;
}

async function handleRecognize(req, res) {
  const url = new URL(req.url, "http://localhost");
  const engine = url.searchParams.get("engine") || "-a-general";
  const codec = url.searchParams.get("codec") || "16K";
  const noLog = url.searchParams.get("noLog") === "1";
  const options = { engine, codec, noLog };
  try {
    const body = await readBody(req);
    if (body.length === 0) {
      res.writeHead(400, { "Content-Type": MIME[".json"] });
      res.end(JSON.stringify({ error: "empty body: POST the audio file bytes" }));
      return;
    }
    const audio = new Uint8Array(body);
    const segments = OFFLINE
      ? fakeRecognizeFile(audio, options)
      : await fileProvider.recognizeFile(audio, options);
    const transcript = segments.map((s) => s.text).join("");
    const speakers = segments.map((s) => toSpeakerSegment(s));
    res.writeHead(200, { "Content-Type": MIME[".json"] });
    res.end(JSON.stringify({ transcript, segments, speakers, offline: OFFLINE }));
  } catch (err) {
    console.log("[ami-voice]", JSON.stringify({ type: "file-error", message: String(err?.message ?? err) }));
    res.writeHead(502, { "Content-Type": MIME[".json"] });
    res.end(JSON.stringify({ error: String(err?.message ?? err) }));
  }
}

const LANDING = `<!doctype html><meta charset="utf-8"><title>@csbc-dev/ami-voice examples</title>
<style>body{font-family:system-ui,sans-serif;max-width:640px;margin:3rem auto;padding:0 1rem;color:#1a1a2e}
a{color:#0d9488}li{margin:.4rem 0}code{background:#f0f0f0;padding:1px 5px;border-radius:4px}</style>
<h1>@csbc-dev/ami-voice — examples server</h1>
<p>Realtime relay WS + file <code>POST /api/recognize</code> are live on this port.</p>
<h2>Buildless examples (served here)</h2>
<ul>
<li><a href="/wcstack-state/">@wcstack/state</a></li>
<li><a href="/wcstack-signals/">@wcstack/signals</a></li>
</ul>
<h2>Build examples (run their own dev server)</h2>
<ul>
<li>React / Vue / Vanilla — see <code>examples/&lt;name&gt;/</code> (<code>npm run dev</code>)</li>
</ul>
<p>Mode: <strong>${OFFLINE ? "OFFLINE (fake AmiVoice, no key)" : "REAL (AMIVOICE_APPKEY set)"}</strong></p>`;

const server = createServer(async (req, res) => {
  cors(res);
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, "http://localhost");

  if (url.pathname === "/api/recognize" && req.method === "POST") {
    await handleRecognize(req, res);
    return;
  }

  if (url.pathname === "/" ) {
    res.writeHead(200, { "Content-Type": MIME[".html"] });
    res.end(LANDING);
    return;
  }

  // Static.
  const file = resolveStatic(url.pathname);
  if (!file) { res.writeHead(403); res.end("forbidden"); return; }
  try {
    const data = await readFile(file);
    res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": MIME[".html"] });
    res.end("not found");
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// WebSocket: relay control + audio on the SAME port. Routed by subprotocol —
// control offers none, audio carries the session token (SPEC §11.3).
// ─────────────────────────────────────────────────────────────────────────────
//
// SECURITY SEAM (SPEC §14). @wc-bindable/remote is NOT a security boundary. A real
// deployment authenticates the peer HERE before any socket reaches the relay
// handlers, and authorizes what it may do. This demo accepts everyone so it runs
// offline. Replace the bodies — the call sites are already wired.
function authenticatePeer(req) {
  return { id: "demo-anon", remoteAddress: req.socket.remoteAddress };
}
function authorize(_principal /*, engine, profileId, … */) {
  return true;
}

const wss = new WebSocketServer({
  server,
  handleProtocols: (protocols) => [...protocols][0] ?? false,
});
const sessions = new Map();
wss.on("connection", (sock, req) => {
  const principal = authenticatePeer(req);
  if (!principal) { sock.close(1008, "unauthenticated"); return; }

  if (sock.protocol) {
    // Audio connection: the subprotocol is the session token. PRODUCTION: also
    // verify this audio peer is the SAME principal that opened the control session.
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

server.listen(PORT, () => {
  console.log(`[ami-voice] shared example server on http://localhost:${PORT}`);
  console.log(`  realtime relay : ws://localhost:${PORT}/   (control + audio, one URL)`);
  console.log(`  file recognize : POST http://localhost:${PORT}/api/recognize`);
  console.log(`  buildless demos: http://localhost:${PORT}/wcstack-state/  ·  /wcstack-signals/`);
  console.log(`  AmiVoice       : ${OFFLINE ? "FAKE (offline, no APPKEY)" : "REAL (AMIVOICE_APPKEY set)"}`);
});
