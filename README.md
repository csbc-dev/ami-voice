# @csbc-dev/ami-voice

Declarative speech-recognition Web Component for the **AmiVoice** cloud API (Advanced Media). Drop an `<ami-voice>` element into any framework, bind to its reactive state (`transcript`, `interim`, …), and call `start()` / `stop()`. Built on [wc-bindable-protocol](https://github.com/wc-bindable-protocol/wc-bindable-protocol); part of the `csbc-dev/arch` family.

> **Status: pre-1.0.** Both transports are implemented and tested end to end in a real browser: the **relay** default (browser ↔ server ↔ AmiVoice) and the opt-in **browser-direct** mode (browser ↔ AmiVoice, server mints only). See [docs/implementation-plan.md](docs/implementation-plan.md). The authoritative contract is [SPEC.md](SPEC.md); the rationale is in [docs/adr/](docs/adr/).

## Why

Real-time recognition couples two things that pull apart: the **microphone**, which can only run in the browser, and the **APPKEY**, which must never reach the browser. `@csbc-dev/ami-voice` keeps recognition authority and the APPKEY on a server (the Core), while the browser owns only mic capture (the Shell) and streams audio to the server. Your `<ami-voice>` markup never sees a credential.

## Install

```bash
npm install @csbc-dev/ami-voice
```

## Quick start (remote relay — the default)

**1. Server** — hold the APPKEY, host the two relay channels. A runnable demo lives in [examples/relayServer.mjs](examples/relayServer.mjs) (uses a fake AmiVoice when `AMIVOICE_APPKEY` is unset):

```bash
npm run build && AMIVOICE_APPKEY=your-key npm run example
# single port: control + audio both on ws://localhost:3100/ (routed by Sec-WebSocket-Protocol)
```

The server wires `@csbc-dev/ami-voice/server`'s `createAmiVoiceRelayServer` to your WebSocket server. **You MUST authenticate the peer before handing sockets to the relay** (see [SPEC.md §14](SPEC.md)).

**2. Browser** — register the element and bind:

```html
<script type="module">
  import { bootstrapAmiVoice } from "@csbc-dev/ami-voice";
  bootstrapAmiVoice({ remote: { enableRemote: true, remoteSettingType: "config", remoteCoreUrl: "ws://localhost:3100/" } });
</script>

<ami-voice remote-url="ws://localhost:3100/" engine="-a-general" codec="LSB16K"></ami-voice>

<script type="module">
  const el = document.querySelector("ami-voice");
  el.addEventListener("ami-voice:transcript-changed", (e) => console.log("final:", e.detail));
  el.addEventListener("ami-voice:interim-changed", (e) => console.log("interim:", e.detail));
  await el.start();   // begins mic capture + streaming
  // ... el.stop();   // graceful: flush + final result
</script>
```

Any framework adapter from the `@wc-bindable/*` family (React, Vue, Svelte, …) binds the same reactive state — see the [wc-bindable adapters](https://github.com/wc-bindable-protocol/wc-bindable-protocol#packages).

## Reactive surface

| Property | Meaning |
|---|---|
| `recognizing` / `connected` | session active / upstream connected |
| `transcript` | accumulated **finalized** text |
| `interim` | current in-progress hypothesis |
| `segments` | structured finalized history (text + confidence + token timings) |
| `speakers` | speaker-labeled finalized turns (derived from `segments`; group by `label` for a per-speaker transcript — needs `segmenterProperties="useDiarizer=1"`) |
| `confidence` | latest finalized-segment confidence (final-only) |
| `level` | mic input level (for a meter) |
| `loading` / `error` | request in flight / last error |

**Inputs**: `engine`, `codec`, `profileId`, `profileWords`, `keepFillerToken`, `resultUpdatedInterval`, `segmenterProperties`, `noLog`.
**Commands**: `start()`, `stop()` (graceful), `abort()` (immediate), `reset()`.

> **Codec scope (v1):** the browser streams **`LSB16K`** (16 kHz PCM) only. Setting `codec` to a format the data plane can't encode (`8K` / `MULAW` / `ALAW`, telephony — not yet supported) is **rejected on `start()`** (an `unsupported-format` error) rather than silently downgraded. **Diarization:** set `segmenterProperties="useDiarizer=1"` to populate `speakers`.

Full contract: [SPEC.md §7](SPEC.md).

## How it works (and what it costs)

Because the `@wc-bindable/remote` control wire is JSON-only, audio cannot ride it. The relay is **two channels**: a JSON control channel (state + commands) and a **separate binary WebSocket** for PCM frames, correlated by a session token. Audio therefore traverses your server, so **server cost scales with audio volume**, not just connection count.

## Browser-direct mode (opt-in)

Set `transport="direct"` to bypass the server for audio ([ADR 0006](docs/adr/0006-transport-baseline-after-one-time-appkey.md)). On `start()`, the server mints a **one-time APPKEY** (short-lived, optionally IP-restricted — `POST issue_service_authorization`) plus the approved `s` command and returns them over the control channel; the browser then opens the AmiVoice WSS **itself** and streams audio directly. The permanent APPKEY never leaves the server — only the short-lived token does.

```html
<!-- identical reactive surface; only the deployment attribute changes -->
<ami-voice transport="direct" remote-url="ws://localhost:3100/" engine="-a-general" codec="LSB16K"></ami-voice>
```

```js
// server: opt the helper into direct mode; pass the peer address so the mint
// can IP-restrict the one-time key (falls back to a shorter expiry, no ipa,
// when the address is unknown — e.g. behind a proxy).
const direct = createAmiVoiceRelayServer({ transport: "direct" });
wss.on("connection", (sock, req) =>
  direct.handleControlConnection(new WebSocketServerTransport(sock), { peerAddress: req.socket.remoteAddress }));
```

| | Relay (default) | Direct (opt-in) |
|---|---|---|
| Audio path | browser → server → AmiVoice | browser → AmiVoice |
| Server cost | `O(audio volume)` | `O(connections)` + mint |
| Credential in browser | none | 30 s, IP-restricted one-time key |
| Core authority | strongest (server sends `s`, parses events) | advisory (browser sends the server-approved `s`) |

The recognition surface (`transcript` / `interim` / `start` / …) is **byte-identical** across modes — `transport` is deployment config, never a bindable property. Core authority is *advisory* in direct mode: the browser sends the server-approved `s`, so a deployment that must enforce engine/grammar/profile server-side should validate the mint request (a future server-side `s`-param enforcement would be a new ADR).

## Security

- The **APPKEY stays on the server** (`AMIVOICE_APPKEY`); it is never an attribute, never in the bundle, never on the wire to the browser.
- `createAmiVoiceRelayServer` is plumbing, **not** a security boundary. Put a deployment security profile in front of it ([SPEC.md §14](SPEC.md), [ADR 0002](docs/adr/0002-appkey-residency-and-remote-first.md)):

  1. **Authenticate the peer before the shell** — auth the control WebSocket (cookie / bearer / mTLS) *before* `handleControlConnection`. `@wc-bindable/remote` carries no auth.
  2. **Authorize per command/tenant** — engine/grammar/profile/quota policy lives server-side; the bindable `inputs` are client-writable.
  3. **Bind audio to the authenticated session** — the audio token rides `Sec-WebSocket-Protocol` (never a query string); ensure the audio peer is the same principal as the control peer.
  4. **Rate-limit & bound resources** — cap message rate, `JsonValue` payload sizes, and concurrent sessions per principal.
  5. **Direct mode** — pass `peerAddress` so the one-time key is `ipa`-restricted, and validate the mint request (Core authority is advisory in direct mode).
  6. **Observe** — wire the injectable `logger` (below) to your log pipeline.

The runnable [examples/relayServer.mjs](examples/relayServer.mjs) marks each as an `authenticatePeer` / `authorize` seam.

### Structured logging

`createAmiVoiceRelayServer({ logger })` takes an optional structured logger — connection open/close, rejected audio frames, and emitted Core errors. Records never contain the APPKEY, the audio token, or wire payloads.

```js
createAmiVoiceRelayServer({
  logger: (e) => console.log(JSON.stringify({ at: "ami-voice", ...e })),
  // e.g. { type: "control-open", transport: "relay", peerAddress }
  //      { type: "audio-rejected", reason: "unknown-session" }
  //      { type: "error", code: "upstream", message }
});
```

## Package entry points

| Import | Environment | Exports |
|---|---|---|
| `@csbc-dev/ami-voice` | browser | `bootstrapAmiVoice`, `WcsAmiVoice`, `AmiVoiceCore`, helpers, types |
| `@csbc-dev/ami-voice/server` | Node | `createAmiVoiceRelayServer`, `AmiVoiceCore`, `AmiVoiceProvider`, error helpers — no `HTMLElement` code |
| `@csbc-dev/ami-voice/auto` | browser (side-effect) | registers `<ami-voice>` with defaults |
| `@csbc-dev/ami-voice/auto/remoteEnv` | browser (side-effect) | remote-first; reads `AMIVOICE_REMOTE_CORE_URL` |

## Develop

```bash
npm run build            # tsc → dist/
npm test                 # unit suite (happy-dom)
npm run test:coverage    # unit suite + coverage gate over the portable logic layer
npm run test:integration # full relay loop over real sockets (Node)
npm run test:e2e         # real-browser relay e2e (Playwright + system Chrome, fake mic)
npm run example          # runnable relay server (fake AmiVoice without a key)
```

`test:e2e` runs the relay and direct browser specs (`tests/browser/*.browser.spec.ts`)
in a real Chromium (`channel: "chrome"`, launched with `--use-fake-device-for-media-stream`),
against the single-port harness `tests/browser/harnessServer.mjs` (HTTP pages + relay
control/audio WS at `/` + direct mint WS at `/direct` + an in-process fake AmiVoice).
It exercises the browser-only mic data plane (`getUserMedia` → `AudioWorklet` → PCM)
that the Node suites can't, in both transports.

## License

MIT
