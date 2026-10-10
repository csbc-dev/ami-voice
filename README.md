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

> `npm run example` is a **realtime-only** minimal relay (no file endpoint). For the framework examples (React / Vue / Vanilla / `@wcstack/state` / `@wcstack/signals`) and **file recognition**, run the superset server — `npm run examples:server` — and see [examples/README.md](examples/README.md).
>
> Want to wire speech **into an LLM**? The `voice-llm` composition demos pair `<ami-voice>` with the sibling package `@csbc-dev/ai-agent` (mic → transcript → LLM summary, binding only; both Cores server-side, no secret in the browser) in three flavours — [Vanilla](examples/voice-llm/), [Vue](examples/voice-llm-vue/), [React](examples/voice-llm-react/).

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

`start()` can be called as soon as the element is in the DOM — there is no need to wait for the control channel to connect: the element arms the microphone for the session the server reports live in `start()`'s own reply ([SPEC.md §10.2](SPEC.md)). Inputs set before that — attributes like `engine` / `codec` above, or properties — are applied to the Core when the element connects, in every mode. In a real page, call `start()` from a user gesture (e.g. a click handler): browsers gate the microphone and audio processing behind one. Calling `start()` right after `stop()` / `abort()` / `reset()` without awaiting them (a "start over" button) is fine too: the element waits until the previous session has settled — for `stop()`, until its trailing final result has arrived — and then opens a new one.

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
| `loading` / `error` | request in flight / last error — a plain `{ name, message, code?, resultCode?, retryable? }` object; read the normalized code with `getErrorCode(error)` |

**Inputs**: `engine`, `codec`, `profileId`, `profileWords`, `keepFillerToken`, `resultUpdatedInterval`, `segmenterProperties`, `noLog`.
**Commands**: `start()`, `stop()` (graceful), `abort()` (immediate), `reset()`.

> **Codec scope (v1):** the browser streams **`LSB16K`** (16 kHz PCM) only. Setting `codec` to a format the data plane can't encode (`8K` / `MULAW` / `ALAW`, telephony — not yet supported) is **rejected on `start()`** (an `unsupported-format` error) rather than silently downgraded. **Diarization:** set `segmenterProperties="useDiarizer=1"` to populate `speakers`.

Full contract: [SPEC.md §7](SPEC.md).

## How it works (and what it costs)

Because the `@wc-bindable/remote` control wire is JSON-only, audio cannot ride it. The relay is **two channels**: a JSON control channel (state + commands) and a **separate binary WebSocket** for PCM frames, correlated by a session token. Audio therefore traverses your server, so **server cost scales with audio volume**, not just connection count.

### Control-channel values are strict JSON (`@wc-bindable/remote` ≥ 0.10)

This package targets `@wc-bindable/core` / `@wc-bindable/remote` `^0.10.0`. Since 0.10 the control channel validates every value as a `JsonValue` in **both** directions: `undefined`, `NaN` / `±Infinity`, `Date`, `Map`, class instances (`Error` included) and objects with an `undefined` member are **rejected, not coerced**. What that means here:

- **Inputs.** Assigning `undefined` or `null` to an input — `el.engine = undefined` is what React 19 does when you remove a prop — **resets it to its default** (`engine` → `-a-general`, `codec` → `LSB16K`, strings → `""`, booleans → `false`, `resultUpdatedInterval` → `0`); the element forwards it as `null`, and treats `NaN` the same way. An empty string resets `engine` and `codec` too (`engine=""`, `el.codec = ""`) — neither has a valid empty value. Any other non-JSON value (a `Date`, a reactive proxy, …) fails the write with an `ami-voice:error` whose `code` is `WC_BINDABLE_INVALID_JSON_VALUE` — convert it first (Vue `toRaw()`, MobX `toJS()`, `structuredClone`).
- **`error`.** The Core publishes errors as a plain object `{ name, message, code?, resultCode?, retryable? }` — the same shape locally and in relay/direct mode — so a relay client now sees start failures and upstream drops (e.g. `code: "auth"`, `"upstream"`), and `getErrorCode(el.error)` works everywhere. The exception behind it stays on the server as [`core.originalError`](#the-original-exception-coreoriginalerror). Errors the element raises itself (codec rejection, microphone denied, a failed control call) are `Error` instances: read `name` / `message` / `code`, don't rely on `instanceof`.
- **Custom providers.** Finalized segments from a custom `IAmiVoiceProvider` are re-normalized by the Core to the public `RecognitionSegment` shape (unknown keys dropped, `NaN` → `0`, `undefined` members omitted). A custom `prepareDirectSession` must resolve `{ endpoint, sCommand }` as non-empty strings. The Core forwards exactly those two fields to the browser (any other key is dropped — a `Date` or an `undefined` member no longer fails the reply as `WC_BINDABLE_INVALID_RETURN_VALUE`); if either is missing, not a string, or empty, `start` fails with an `invalid-param` error naming the field and its type.
- **Upgrade server and browser together.** The producer side decides what crosses the wire; run the same `@csbc-dev/ami-voice` release on the server and in the bundle.

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
  6. **Observe** — wire the injectable `logger` (below) to your log pipeline; read `core.originalError` for the exception behind a published error.

The runnable [examples/relayServer.mjs](examples/relayServer.mjs) marks each as an `authenticatePeer` / `authorize` seam.

### Structured logging

`createAmiVoiceRelayServer({ logger })` takes an optional structured logger — connection open/close, rejected audio frames, and errors: those the Core publishes, those sent to the browser as a failed call (e.g. a direct-mode mint failure), and those the helper catches in its own socket callbacks instead of letting them crash the process (e.g. a custom provider's session whose `abort()` throws when `dispose()` runs). Records never contain the APPKEY, the audio token, or wire payloads.

Server internals stay on the server: the browser gets a failed call's `name` / `message` / `code` without the `stack` or the `cause` chain, and the `error` record carries both (redacted) instead.

```js
createAmiVoiceRelayServer({
  logger: (e) => console.log(JSON.stringify({ at: "ami-voice", ...e })),
  // e.g. { type: "control-open", transport: "relay", peerAddress }
  //      { type: "audio-rejected", reason: "unknown-session" }
  //      { type: "error", code: "upstream", message }
  //      { type: "error", code: "auth", message, stack, cause }   // a failed call (stack / cause withheld from the browser)
});
```

### The original exception: `core.originalError`

The log record for an error the Core publishes is just its `code` + `message`. For the exception itself — class, `stack`, `cause`, e.g. to hand to an error tracker — read **`core.originalError`** on the server. The browser never receives it: it gets the plain `error` object only.

```js
const relay = createAmiVoiceRelayServer({ logger });   // routine records → your log pipeline
wss.on("connection", (sock) => {
  const { core } = relay.handleControlConnection(new WebSocketServerTransport(sock));
  core.addEventListener("ami-voice:error", () => {
    if (core.originalError) tracker.captureException(core.originalError);   // the exception → your tracker
  });
});
```

- It changes together with `error`: it is set before the Core dispatches `ami-voice:error`, and it is `null` whenever `error` is.
- It is what the Core caught from the provider / session, passed through the same normalization as a direct-mode rejection: an `Error` stays the same instance; a frozen `Error`, a plain object or a string becomes an `Error` with the same `name` / `message` / `code` / `resultCode` / `retryable`.
- An APPKEY echoed into the failure (e.g. a rejected `s` command) is redacted from the whole instance — `message`, `stack`, every `cause` in the chain and the extra fields (and the objects / arrays under them) — so you can hand it to a tracker as it is. The `Error`s are redacted in place (same instance, class, `stack` and chain); a plain object holding the APPKEY is swapped for a redacted copy rather than edited, since it may be your provider's own state. If the APPKEY sits where it cannot be overwritten (a frozen `cause`, a read-only field), you get a new `Error` like the frozen case above, without `cause`. Redaction follows `redactSecrets` (below) and does not look inside class instances other than `Error` (`Headers`, `FormData`, responses, …) — a custom provider should not put the APPKEY there.
- It covers only failures published on `error`. A call that fails instead — a direct-mode mint failure, any other failed call — does not set it; that one is in the `logger`'s `error` record, with `stack` and `cause`.
- It is **not** declared in `AmiVoiceCore.wcBindable`. `@wc-bindable/remote` sends and accepts only declared names, so it never crosses the control channel and a client cannot invoke or set it.

### Redacting your own logs: `redactSecrets`

The rule the package applies to every error and log record is exported from the server entry, for the strings you log yourself — your custom provider's diagnostics, a wrapper around the `logger`, anything that may quote an `s` command, a request, or their echo:

```js
import { redactSecrets } from "@csbc-dev/ami-voice/server";

redactSecrets("s LSB16K -a-general authorization=XXXXXXXX");
// → "s LSB16K -a-general authorization=<redacted>"
redactSecrets("GET /v2/recognitions/1 (Authorization: Bearer XXXXXXXX)");
// → "GET /v2/recognitions/1 (Authorization: Bearer <redacted>)"
redactSecrets("POST /issue_service_authorization u=XXXXXXXX&epi=30");
// → "POST /issue_service_authorization u=<redacted>&epi=30"
```

What it redacts, in this order:

- **The APPKEY by value.** Every `AmiVoiceProvider` registers its APPKEY (and service password) when it is constructed, and `createAmiVoiceRelayServer` registers `AMIVOICE_APPKEY` / `AMIVOICE_SERVICE_PASSWORD`. That value becomes `<redacted>` wherever it appears — bare, URL-encoded or JSON-escaped, with any label or none. Values shorter than 8 characters are not registered. The registry is internal; there is no API to add your own values.
- **Labelled forms**, for credentials the process does not hold (a custom provider's key, a one-time APPKEY), case-insensitive: `authorization=<token>` (the realtime `s` command; output unchanged from earlier releases), `Bearer <token>` (the async poll's `Authorization` header), the form / query fields `u=` and `spw=` (the async enqueue and the one-time APPKEY issuance), and the JSON members `"u"` / `"spw"` / `"authorization"`.

An already redacted string is returned unchanged. The labelled forms err on the side of redacting: the word after `bearer` and an unrelated `u=` field are redacted too. Without a label, only a registered value is caught — so a custom provider that does not use `AmiVoiceProvider` should keep its key out of its errors. It is server-only: the browser entry (`@csbc-dev/ami-voice`) does not export it.

## Package entry points

| Import | Environment | Exports |
|---|---|---|
| `@csbc-dev/ami-voice` | browser | `bootstrapAmiVoice`, `WcsAmiVoice`, `AmiVoiceCore`, helpers, types |
| `@csbc-dev/ami-voice/server` | Node | `createAmiVoiceRelayServer`, `AmiVoiceCore`, `AmiVoiceProvider`, error helpers, `redactSecrets` — no `HTMLElement` code |
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
