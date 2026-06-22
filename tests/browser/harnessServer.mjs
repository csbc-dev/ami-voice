// Browser e2e harness server (plan 1.3 + Phase 2 direct mode).
//
// Stands up everything a real Chromium `<ami-voice>` needs, on ONE port:
//   - HTTP static: the test pages (`index.html` relay, `direct.html` direct) +
//     the built browser bundle (`/dist/...`) + the wc-bindable ESM (`/vendor/...`).
//   - WebSocket upgrades routed by path:
//       `/`        → RELAY control (@wc-bindable/remote JSON) AND binary audio,
//                    distinguished by `Sec-WebSocket-Protocol` presence (SPEC §11.3).
//       `/direct`  → DIRECT control (mint only; audio bypasses the server — ADR 0006).
//   - An in-process FAKE AmiVoice WSS (no APPKEY needed). In direct mode the
//     BROWSER connects to it directly with a server-minted one-time token.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, normalize, sep } from "node:path";
import { WebSocketServer } from "ws";
import WebSocket from "ws";
import { WebSocketServerTransport } from "@wc-bindable/remote";
import { createAmiVoiceRelayServer, AmiVoiceProvider } from "../../dist/server.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO = normalize(join(HERE, "..", ".."));
const PORT = Number(process.env.E2E_PORT ?? 3200);

// ── static file roots: URL prefix → filesystem dir ───────────────────────────
const STATIC_ROUTES = [
  { prefix: "/dist/", dir: join(REPO, "dist") },
  { prefix: "/vendor/core/", dir: join(REPO, "node_modules", "@wc-bindable", "core", "dist") },
  { prefix: "/vendor/remote/", dir: join(REPO, "node_modules", "@wc-bindable", "remote", "dist") },
];

const PAGES = { "/": "index.html", "/index.html": "index.html", "/direct.html": "direct.html" };

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

function contentType(path) {
  const dot = path.lastIndexOf(".");
  return MIME[path.slice(dot)] ?? "application/octet-stream";
}

/** Resolve a request path to a file inside an allowed root (no traversal). */
function resolveStatic(urlPath) {
  if (PAGES[urlPath]) return join(HERE, PAGES[urlPath]);
  for (const route of STATIC_ROUTES) {
    if (urlPath.startsWith(route.prefix)) {
      const rel = decodeURIComponent(urlPath.slice(route.prefix.length));
      const full = normalize(join(route.dir, rel));
      // Containment check — reject `..` escapes.
      if (full === route.dir || full.startsWith(route.dir + sep)) return full;
      return null;
    }
  }
  return null;
}

// ── fake AmiVoice (acks s/e; canned interim/final) ───────────────────────────
function startFakeAmiVoice() {
  const wss = new WebSocketServer({ port: 0 });
  wss.on("connection", (sock) => {
    let sawAudio = false;
    sock.on("message", (data, isBinary) => {
      if (isBinary) {
        if (!sawAudio) {
          sawAudio = true;
          sock.send('U {"text":"こん","results":[{"tokens":[]}]}');
        }
        return;
      }
      const c = data.toString()[0];
      if (c === "s") sock.send("s");
      else if (c === "e") {
        sock.send('A {"text":"こんにちは","results":[{"text":"こんにちは","confidence":0.95,"tokens":[]}]}');
        sock.send("e");
      }
    });
  });
  return new Promise((resolve) => wss.on("listening", () => resolve(`ws://127.0.0.1:${wss.address().port}/`)));
}

/** Adapt a Node `ws` client into the provider's RealtimeSocket (relay upstream). */
function wsSocketFactory(url) {
  const ws = new WebSocket(url);
  const sock = { send: (d) => ws.send(d), close: () => ws.close(), onopen: null, onmessage: null, onclose: null, onerror: null };
  ws.on("open", () => sock.onopen?.());
  ws.on("message", (data, isBinary) => { if (!isBinary) sock.onmessage?.(data.toString()); });
  ws.on("close", () => sock.onclose?.());
  ws.on("error", (e) => sock.onerror?.(e));
  return sock;
}

/** Fake `issue_service_authorization` — hands back a canned one-time token. */
const fakeIssueFetch = async () => ({ ok: true, text: async () => "ONE-TIME-TOKEN" });

async function main() {
  // Guard: the page loads the built bundle, so dist must exist.
  try {
    await stat(join(REPO, "dist", "index.js"));
  } catch {
    console.error("[e2e] dist/index.js missing — run `npm run build` first.");
    process.exit(1);
  }

  const realtimeEndpoint = await startFakeAmiVoice();

  // RELAY server: audio traverses the server (server opens the upstream WSS).
  const relay = createAmiVoiceRelayServer({
    createProvider: () => new AmiVoiceProvider({
      appKey: "FAKE",
      realtimeEndpoint,
      realtimeNoLogEndpoint: realtimeEndpoint,
      socketFactory: wsSocketFactory,
    }),
  });

  // DIRECT server: mints only. `endpoint` is the fake AmiVoice URL the BROWSER
  // connects to directly; the permanent APPKEY never leaves the server.
  const direct = createAmiVoiceRelayServer({
    transport: "direct",
    createProvider: () => new AmiVoiceProvider({
      appKey: "PERMANENT-APPKEY",
      realtimeEndpoint,
      realtimeNoLogEndpoint: realtimeEndpoint,
      issueEndpoint: "https://issue.local/auth",
      fetch: fakeIssueFetch,
    }),
  });

  const httpServer = createServer(async (req, res) => {
    const urlPath = (req.url ?? "/").split("?")[0];
    const file = resolveStatic(urlPath);
    if (!file) {
      res.writeHead(404).end("not found");
      return;
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, { "content-type": contentType(file) }).end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  });

  // Route WS upgrades by path: `/direct` → direct control; everything else →
  // relay control/audio. `noServer` lets us branch before accepting the socket.
  const relayWss = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) => [...protocols][0] ?? false,
  });
  const directWss = new WebSocketServer({ noServer: true });
  httpServer.on("upgrade", (req, socket, head) => {
    const path = (req.url ?? "/").split("?")[0];
    const target = path === "/direct" ? directWss : relayWss;
    target.handleUpgrade(req, socket, head, (ws) => target.emit("connection", ws, req));
  });

  const relaySessions = new Map();
  relayWss.on("connection", (sock) => {
    if (sock.protocol) {
      relay.handleAudioConnection(sock, sock.protocol);
      return;
    }
    const session = relay.handleControlConnection(new WebSocketServerTransport(sock));
    relaySessions.set(sock, session);
    sock.on("close", () => { session.dispose(); relaySessions.delete(sock); });
  });

  const directSessions = new Map();
  directWss.on("connection", (sock, req) => {
    const session = direct.handleControlConnection(
      new WebSocketServerTransport(sock),
      { peerAddress: req.socket.remoteAddress ?? undefined },
    );
    directSessions.set(sock, session);
    sock.on("close", () => { session.dispose(); directSessions.delete(sock); });
  });

  httpServer.listen(PORT, () => {
    console.log(`[e2e] harness up on http://localhost:${PORT}/ (relay '/' + direct '/direct' + static, fake AmiVoice)`);
  });
}

main();
