# CLAUDE.md

This repository (`@csbc-dev/ami-voice`) is intended to become a re-packaged member of the `csbc-dev/arch` architecture family. The design target is a declarative **speech-recognition component for the AmiVoice cloud API** (アドバンスト・メディアの音声認識 API), built on top of `wc-bindable-protocol` and shaped by the same CSBC rules used in the neighboring `ai-agent`, `auth0`, and `s3-uploader` packages.

Both transports — the default two-channel **relay path** and the opt-in **browser-direct path** — **are implemented and green** (`npm run build` clean; 154 unit + 3 Node integration + 2 real-browser Playwright tests), and **Phase 3 hardening is done** (deployment security profile, structured logging, coverage gate, and the SPEC §10.1 upstream-drop policy all shipped). What remains is only the **real-AmiVoice smoke run** (gated on `AMIVOICE_APPKEY`) and the **user-driven release** (version bump + manual `npm publish`); auto-reconnect and telephony-codec expansion stay deferred enhancements — see *Implementation status* at the end of this document, the sequenced [docs/implementation-plan.md](docs/implementation-plan.md), and the consolidated remaining-work brief [docs/implementation-brief.md](docs/implementation-brief.md). This document serves two purposes:

1. capture the architectural intent and the contract the implementation holds to, and
2. define the boundaries that the remaining implementation work must follow.

---

## 1. Overview of wc-bindable-protocol

A framework-agnostic, minimal protocol that lets any class extending `EventTarget` declare its reactive properties. Reactivity systems — React, Vue, Angular, Svelte, Solid, Preact, Lit, Alpine, Marko, Mithril, Qwik, Riot, Stencil, VanJS, plus the non-framework reactivity libraries MobX, RxJS, and TC39 Signals — can then bind to arbitrary components without framework-specific glue code. (The upstream `@wc-bindable/*` family ships **20 lockstep packages at v0.8.0**: `core`, `remote`, the `composite` composition profile, and 17 adapters. This package targets `@wc-bindable/core` / `@wc-bindable/remote` at `^0.8.0` — see [.claude/skills/release/SKILL.md](.claude/skills/release/SKILL.md).)

### Core idea

- The component author declares **what** is bindable.
- The framework consumer decides **how** to bind it.
- Neither side needs to know about the other.

### How to declare

Just write a schema in the `static wcBindable` field.

```javascript
class MyFetchCore extends EventTarget {
  static wcBindable = {
    protocol: "wc-bindable",
    version: 1,
    properties: [
      { name: "value", event: "my-fetch:value-changed" },
      { name: "loading", event: "my-fetch:loading-changed" },
    ],
    inputs: [{ name: "url" }, { name: "method" }],
    commands: [{ name: "fetch", async: true }, { name: "abort" }],
  };
}
```

| Field | Required | Role |
|---|---|---|
| `properties` | Yes | Properties that announce state changes via `CustomEvent` (output) |
| `inputs` | No | Configurable properties (input; declaration only, no automatic sync) |
| `commands` | No | Invokable methods (for remote proxies and tooling) |

### How binding works

An adapter only needs to:

1. Read `target.constructor.wcBindable`
2. Verify `protocol === "wc-bindable" && version === 1`
3. For each `property`, read `target[name]` immediately to deliver the initial value, then subscribe to `event`

`bind()` is at most around 20 lines. Framework adapters fit in a few dozen lines.

### Out of scope (deliberately)

- Automatic two-way sync
- Form integration
- SSR / hydration
- Runtime schema validation beyond what a package performs for its own inputs

### Why `EventTarget`

Requiring `EventTarget` rather than `HTMLElement` lets the same protocol work in non-browser runtimes such as Node.js / Deno / Cloudflare Workers. `HTMLElement` is a subclass of `EventTarget`, so Web Components are automatically compatible.

Reference: [wc-bindable-protocol/SPEC.md](https://github.com/wc-bindable-protocol/wc-bindable-protocol/blob/main/SPEC.md)

---

## 2. Overview of the Core/Shell Bindable Component (CSBC) architecture

Built on top of wc-bindable-protocol, CSBC structurally eliminates framework lock-in by moving business logic, especially async work, out of the framework layer and into the Web Component side.

### The problem it solves

The real migration cost in frontend systems is not templates but async logic coupled to framework lifecycle APIs such as `useEffect`, `onMounted`, and `onMount`. Templates can usually be rewritten mechanically. Async orchestration cannot.

### Three-layer structure

1. **Headless Web Component layer** - encapsulates async work (HTTP, WebSocket, media capture, timers, retries, state transitions) and state (`value`, `loading`, `error`, etc.).
2. **Protocol layer (wc-bindable-protocol)** - exposes the state through `static wcBindable` and `CustomEvent`.
3. **Framework layer** - binds to the protocol and renders state. No domain async logic belongs here.

### Core / Shell separation

The headless layer is split into two parts. The invariant is not that the Shell must always be thin. The invariant is where decisions live.

- **Core (`EventTarget`) - owns decisions**
  Business logic, policy, request shaping, timeout and retry rules, authorization-sensitive behavior, state transitions, event emission. If kept DOM-free, it is portable to Node.js / Deno / Workers.
- **Shell (`HTMLElement`) - owns only undelegatable execution**
  DOM lifecycle, framework-facing attributes and properties, local trigger wiring, browser-only work, transport setup.

The enabling pattern is **target injection**: the Core constructor accepts an arbitrary `EventTarget` and dispatches all events to it. When the Shell passes `this`, Core events fire directly from the DOM element with no re-dispatch layer.

### Four canonical cases

| Case | Core location | Shell role | Examples |
|---|---|---|---|
| A | Browser | Thin wrapper around a browser-bound Core | `auth0-gate` (local) |
| B1 | Server | Command-mediating thin Shell | `ai-agent` (remote), `lambda` |
| B2 | Server | Observation-only thin Shell | `feature-flags` |
| C | Server | Shell that runs a browser-only data plane | `s3-uploader`, `passkey-auth`, `stripe-checkout` |

Case C is **not** a deviation from CSBC principles. It is a **first-class case**. It arises whenever there is a data plane that can only run in the browser (direct upload, WebRTC, WebUSB, the `File System Access API`, **microphone capture via `getUserMedia` / `AudioWorklet`**, anything dependent on a user gesture, etc.). A "fat" Shell is fine **as long as decisions still live in the Core**.

> Invariant:
> **The Core owns every decision. The Shell only does what cannot be delegated.**

### Three boundaries it crosses

| Boundary | Crossing actor | Mechanism |
|---|---|---|
| Runtime boundary | Core (`EventTarget`) | DOM-free code running in Node.js / Deno / Workers |
| Framework boundary | Shell (`HTMLElement`) | Attribute mapping + `ref` binding |
| Network boundary | `@wc-bindable/remote` | Proxy `EventTarget` + JSON wire protocol |

`@wc-bindable/remote` is a pair of `RemoteShellProxy` (server side) and `RemoteCoreProxy` (client side). It pushes the Core fully onto the server while keeping the client-side `bind()` unchanged. WebSocket is the default transport; anything that satisfies the minimal `ClientTransport` / `ServerTransport` interfaces (MessagePort / BroadcastChannel / WebTransport / …) can be swapped in.

Reference: [csbc-dev/arch](https://github.com/csbc-dev/arch/blob/main/README.md)

---

## 3. Target package shape for `@csbc-dev/ami-voice`

This section describes the intended implementation target for the repository.

> **Design decision log.** The architectural choices summarized below are recorded one-by-one as ADRs under [docs/adr/](docs/adr/) (index: [docs/README.md](docs/README.md)). When this section and an ADR disagree, the ADR is authoritative for the *decision* and this section must be brought back in sync. Key records: CSBC classification ([ADR 0001](docs/adr/0001-csbc-case-classification.md)), APPKEY residency & remote-first default ([ADR 0002](docs/adr/0002-appkey-residency-and-remote-first.md)), real-time audio transport ([ADR 0003](docs/adr/0003-realtime-audio-transport.md)), bindable surface ([ADR 0004](docs/adr/0004-bindable-surface.md)), audio capture & codec ownership ([ADR 0005](docs/adr/0005-audio-capture-and-codec-ownership.md)), dual-mode transport — relay default + browser-direct opt-in ([ADR 0006](docs/adr/0006-transport-baseline-after-one-time-appkey.md)), and the derived `speakers` speaker view ([ADR 0007](docs/adr/0007-diarization-speaker-view.md)).
>
> **Spec, plan & open questions.** The normative contract (bindable surface, two-channel transport, AmiVoice protocol, security/error/cancellation invariants) lives in [SPEC.md](SPEC.md). The sequenced delivery plan (phases, ordered tasks, critical path, decision gates) lives in [docs/implementation-plan.md](docs/implementation-plan.md). The unresolved decisions and stub boundaries live in [docs/implementation-notes.md](docs/implementation-notes.md) (Q1–Q14). The remaining work consolidated into one actionable brief lives in [docs/implementation-brief.md](docs/implementation-brief.md). Roles: ADR = *why*, SPEC = *what*, implementation-plan = *when/in what order*, implementation-notes = open *how*, implementation-brief = the remaining-work build sheet.

### What AmiVoice is

[AmiVoice API](https://acp.amivoice.com/) is Advanced Media's Japanese cloud speech-recognition service. It exposes two surfaces this package cares about:

- **Real-time recognition (WebSocket).** A streaming interface (`wss://acp-api.amivoice.com/v1/`, plus a no-logging variant `wss://acp-api.amivoice.com/v1/nolog/` — the trailing slash is load-bearing; dropping it silently re-enables logging) that accepts live audio frames and pushes back interim and finalized recognition results as the speaker talks. The wire protocol is a small command/event grammar:
  - client → server: `s <audio_format> <grammar_file_names> <key>=<value> … authorization=<APPKEY>` (start; e.g. `s 16K -a-general resultUpdatedInterval=1000 authorization=…`), `p` + raw audio bytes (binary frames), `e` (end of audio). The server acks each as `s` / `p` / `e` (or `<cmd> <error>` on failure).
  - server → client events: `S` (speech-segment start, + ms timestamp), `E` (speech-segment end, + ms timestamp), `C` (recognition started), `U` (interim/updating result), `A` (fixed/accepted result), `G` (server info). The `A` payload is the full result JSON (`text`, `confidence`, `starttime`, `endtime`, `tags`, `utteranceid`, and `tokens[]` of `written` / `spoken` / `confidence` / `starttime` / `endtime`); the `U` payload is a lighter hypothesis (`text` + `tokens`, **no** segment-level `confidence`).
- **File recognition (HTTP).** A synchronous endpoint (`POST https://acp-api.amivoice.com/v1/recognize`) for short audio, and an asynchronous job endpoint for long files: **v2 (recommended)** `POST https://acp-api-async.amivoice.com/v2/recognitions` to enqueue (returns a `sessionid`), then `GET .../v2/recognitions/{sessionid}` with `Authorization: Bearer <APPKEY>` to poll (`queued` → `started` → `processing` → `completed` / `error`); a legacy **v1** lives at `/v1/recognitions`. HTTP-form params: `u` = APPKEY, `d` = engine config string (`grammarFileNames`, `loggingOptOut`, `contentId`, …), `a` = audio file, `c` = codec.

Authentication for every surface is an **APPKEY** (passed as `authorization=<APPKEY>` in the real-time `s` command, and as the `Authorization` field in the HTTP forms). **The APPKEY is a credential and must never reach the browser.**

### Where AmiVoice fits in CSBC

`@csbc-dev/ami-voice` **straddles Case C and Case B1**, depending on mode — analogous to how `@csbc-dev/auth0` straddles A and B1.

- **Real-time mode → Case C.** The microphone **data plane is browser-pinned**: `getUserMedia` requires a user gesture, and capture/downsampling/PCM framing run in an `AudioWorklet`. That part can only live in the browser. The **decisions** — engine/grammar selection, profile-word registration, codec policy, connection lifecycle, and result normalization — and the **APPKEY** live in `AmiVoiceCore` (the Core, an `EventTarget`) on the server. `<ami-voice>` (the Shell, an `HTMLElement`) captures and frames mic audio and surfaces recognition state locally through wc-bindable-protocol.

  > **Honest tradeoff vs. `s3-uploader`.** In `s3-uploader`, bytes go browser → S3 directly and never traverse the control channel, so server cost is `O(connections × signing_rate)`. AmiVoice real-time is different: because the APPKEY must stay server-side and AmiVoice's real-time endpoint authenticates with the raw APPKEY in the `s` command, **the default safe design relays audio frames through the server** (browser → server → AmiVoice WSS). Crucially, the `@wc-bindable/remote` wire is **JSON-only (`JsonValue`)**, so binary audio cannot ride it — the relay is **two channels**: a JSON control channel (`@wc-bindable/remote`: state + `start`/`stop`/`abort` commands + `engine`/`codec` inputs) and a **separate binary WebSocket** for the audio bytes, correlated by a session id. Server cost therefore scales with audio volume, not just connection count. A direct-from-browser variant (mic in browser, server only mints a credential) is only viable if a short-lived / one-time APPKEY mechanism is available; do not connect the browser straight to AmiVoice with the permanent APPKEY. (That one-time-APPKEY mechanism is now **confirmed**, so browser-direct is a planned **opt-in** mode while the relay stays the default — [ADR 0006](docs/adr/0006-transport-baseline-after-one-time-appkey.md).) Full rationale: [ADR 0003](docs/adr/0003-realtime-audio-transport.md).

- **File mode → Case B1.** File recognition is control-plane work. The Core performs the HTTP recognition (v1 always uses the async v2 `recognitions` enqueue + poll path; a sync `recognize` / size-threshold selection remains open — Q8) with the APPKEY and normalizes the result; the Shell only issues `recognize(file)` commands and binds the result state. There is no browser-only data plane here beyond handing the Core a `File` / `Blob`.

> Invariant for this package:
> **The Core owns every recognition decision and holds the APPKEY. The Shell owns only the microphone data plane and DOM wiring.**

### Package intent

`@csbc-dev/ami-voice` should be a declarative speech-recognition component. It is not a visual widget. It is an I/O node that connects framework code to live recognition state.

The intended default mode is **remote-first** for credential safety:

- Browser code talks to an authoritative parent tag, `<ami-voice>`.
- The Shell proxies through `@wc-bindable/remote`.
- The server-side Core holds the APPKEY, talks to AmiVoice (WSS for real-time, HTTP for file mode), and emits bindable state transitions.

### Intended bindable surface

Single source of truth lives in the parent tag and the Core.

Parent tag, `<ami-voice>`:

| Kind | Names |
|---|---|
| properties | `recognizing`, `connected`, `transcript`, `interim`, `segments`, `speakers`, `confidence`, `level`, `loading`, `error`, `mode` |
| inputs | `engine` / `grammarFileNames`, `codec`, `profileId`, `profileWords`, `keepFillerToken`, `resultUpdatedInterval`, `segmenterProperties`, `noLog` |
| commands | `start` (async), `stop`, `abort` / `reset` |

> `remoteUrl` is a **deployment attribute** (`remote-url`), not a wcBindable input — like `mode` / `transport`, it configures the element rather than binding recognition state, and is intentionally absent from `CORE_INPUT_NAMES` / the `static wcBindable` inputs.

Property notes:

- `transcript` is the accumulated **finalized** text (from `A` events); `interim` is the current in-progress hypothesis (from `U` events). Keep these two separate — UIs typically render finalized text solid and interim text greyed.
- `segments` is the structured history (text + confidence + token timings) so consumers do not have to re-parse `transcript`.
- `speakers` is the derived, **final-only** speaker view (one labeled turn per finalized segment; from token `label` with diarization, `""` otherwise) so consumers don't re-walk tokens for "who said what" ([ADR 0007](docs/adr/0007-diarization-speaker-view.md)). `segments[].tokens[].label` stays the source of truth.
- `level` is a browser-computed input-level value for a mic meter. It is the one property that originates in the Shell's data plane rather than the Core; treat it as Shell-projected UI state, not a recognition decision.

Optional child projection tags (e.g. an `<ami-voice-segments>` that renders only finalized segments, or an `<ami-voice-meter>` for the input level) may be added later, but they must be **projection-only**: inputs and commands stay parent-owned.

### Responsibility split

- **Core responsibilities**
  - Hold the APPKEY; never expose it on the wire to the browser.
  - Validate recognition inputs (engine/grammar, codec, profile words).
  - Open and own the AmiVoice connection (WSS for real-time, HTTP for file mode) and its lifecycle.
  - Drive the real-time command protocol (`s` / `p` / `e`) and parse `S` / `E` / `C` / `U` / `A` events.
  - Normalize AmiVoice errors into a stable package-level error shape.
  - Emit all bindable state transitions (`recognizing`, `transcript`, `interim`, `segments`, `speakers`, `confidence`, `connected`, `error`).

- **Shell responsibilities**
  - Own DOM lifecycle, attribute/property mapping, and trigger wiring.
  - Run the browser-only mic data plane: `getUserMedia`, `AudioWorklet` capture, downsample to the configured codec, frame audio, and stream it to the Core.
  - Project `level` for UI meters.
  - Keep recognition authority, APPKEY, and transport choice out of the Shell.

### Source layout (as implemented)

```text
src/
|- index.ts                 ← browser barrel (default export)
|- server.ts                ← Node-safe barrel (no HTMLElement-backed code)
|- bootstrapAmiVoice.ts     ← one-shot setup that registers <ami-voice>
|- registerComponents.ts    ← customElements.define wiring
|- config.ts                ← config store read at element-connect time
|- processEnv.ts            ← reads AMIVOICE_REMOTE_CORE_URL / AMIVOICE_APPKEY from env
|- types.ts                 ← IAmiVoiceProvider, recognition options, normalized result types
|- raiseError.ts            ← consistent error-dispatch helper for the Shell
|- normaliseError.ts        ← shapes thrown values into Error instances on the wire (applies redact.ts; frozen-Error SerializedError fallback)
|- redact.ts                ← redactSecrets: strips authorization=<APPKEY> before logging / crossing to the browser; choke-point used by normaliseError + server logger
|- errorCodes.ts            ← AmiVoice result-code → normalized AmiVoiceErrorCode union (+ retryable)
|- speakerView.ts           ← derived final-only speaker view (toSpeakerSegment; ADR 0007)
|- createAmiVoiceServer.ts  ← relay + direct server helper (control, binary audio, session table; transport:"direct" mint route; injectable Logger)
|- core/
|  \- AmiVoiceCore.ts       ← Core (EventTarget). Owns recognition decisions + state; relay opens upstream, direct mints (transport option)
|- components/
|  |- AmiVoice.ts           ← <ami-voice> Shell (HTMLElement). local / relay / direct mode resolution
|  |- remoteConnection.ts   ← browser-side control-URL validation + binary audio channel open
|  |- realtimeSocket.ts     ← browser-direct: DirectBrowserProvider + openDirectRealtimeSession (ADR 0006)
|  \- micCapture.ts         ← getUserMedia + AudioWorklet data plane
|- audio/
|  |- pcmEncoder.ts         ← downsample + PCM (LSB16K) framing
|  |- flowControl.ts        ← level-throttle rate limiter + audio back-pressure guard
|  \- worklet.ts            ← AudioWorklet processor source
|- protocol/
|  |- wnnProtocol.ts        ← s/p/e command builder + S/E/C/U/A/G event parser
|  \- realtimeSession.ts    ← shared RealtimeSocket + runRealtimeSession loop (relay + direct)
|- providers/
|  \- AmiVoiceProvider.ts   ← default IAmiVoiceProvider; holds the APPKEY, owns the AmiVoice WSS/HTTP I/O + one-time-APPKEY mint + prepareDirectSession; reads AMIVOICE_APPKEY
\- auto/
   |- auto.js               ← side-effect entry: bootstrapAmiVoice() with defaults
   \- remoteEnv.js          ← side-effect entry: enables remote mode, reads URL from env
```

### Intended public entry points

Mirror the family convention (see `s3-uploader`): a browser-targeted default barrel plus a Node-safe `/server` barrel and side-effect `/auto` entries.

| subpath | environment | exports (intended) |
|---|---|---|
| `@csbc-dev/ami-voice` | browser | `bootstrapAmiVoice`, `WcsAmiVoice`, `AmiVoiceCore`, `AmiVoiceProvider`, types |
| `@csbc-dev/ami-voice/server` | Node | `AmiVoiceCore`, `AmiVoiceProvider`, recognition helpers, types — **no `HTMLElement`-based code** |
| `@csbc-dev/ami-voice/auto` | browser (side-effect) | calls `bootstrapAmiVoice()` so `<ami-voice>` registers on import |
| `@csbc-dev/ami-voice/auto/remoteEnv` | browser (side-effect) | enables remote mode and reads the WS URL from `AMIVOICE_REMOTE_CORE_URL` |

When adding server-safe helpers, mirror the export in both `src/index.ts` and `src/server.ts`. Browser-only helpers (anything touching `getUserMedia`, `AudioWorklet`, `HTMLElement`) are exported **only** from `src/index.ts`.

### Conventions to follow (shared with the family)

- **Class name vs. tag name.** Default tag is `<ami-voice>`; the exported class is `WcsAmiVoice`. The `Wcs` prefix is the package-wide class namespace shared across `@wc-bindable/*`. Grep tag names in templates, class names in JS/TS.
- **Event-name suffix.** Every observable property dispatches `ami-voice:<name>-changed` (including booleans like `recognizing-changed`). The one exception is `error`, which dispatches as `ami-voice:error` (no suffix) because it is a signal, not a state transition. Do not "improve" this locally — every binder in the ecosystem depends on it.
- **APPKEY discipline.** The APPKEY lives only in the Core / provider and is read from the environment (`AMIVOICE_APPKEY`). It must never appear in `wcBindable` inputs, never cross the wire to the browser, and never be logged.
- **Configure once, before connect.** `bootstrapAmiVoice()` / `setConfig()` runs once before any element is connected. Re-configuring after connect leaves already-connected elements on cached settings — undefined behavior.
- **Clean teardown on disconnect.** On `disconnectedCallback`, stop the `AudioWorklet`, release the `MediaStream` tracks, close both channels, and abort the Core session (an abort-equivalent teardown — no graceful `e` flush; SPEC §18). Leaking a live mic or an open WSS after the element is gone is a bug.

### Implementation constraints

- Keep the Core transport-agnostic behind an abstraction such as `IAmiVoiceProvider` rather than hard-coding one AmiVoice client path everywhere.
- Keep browser code free of the APPKEY and any AmiVoice secret.
- Treat real-time protocol framing (`s`/`p`/`e`), event parsing (`S`/`E`/`C`/`U`/`A`), result normalization, and error taxonomy as Core concerns.
- If `abort()` cannot stop an in-flight provider call at the transport layer, define it as cancellation of local result delivery plus mic teardown, and make that limitation explicit in the README.
- Prefer one Core instance per addressable recognition surface, not a global dispatcher.

### Implementation status

**Phases 1, 2, and the Phase 3 hardening are implemented end to end and green** — `npm run build` is clean and tests pass (**154 unit + 3 Node integration + 2 real-browser Playwright**), with a coverage gate (`npm run test:coverage`) over the portable logic layer. Implemented and tested: the bindable surface and Core state machine ([src/core/AmiVoiceCore.ts](src/core/AmiVoiceCore.ts)), the `s`/`p`/`e` builder + `S`/`E`/`C`/`U`/`A`/`G` parser ([src/protocol/wnnProtocol.ts](src/protocol/wnnProtocol.ts)), the shared realtime session loop ([src/protocol/realtimeSession.ts](src/protocol/realtimeSession.ts)), the PCM/`LSB16K` encoder ([src/audio/pcmEncoder.ts](src/audio/pcmEncoder.ts)), the Shell with local/relay/direct modes ([src/components/AmiVoice.ts](src/components/AmiVoice.ts)), the browser-direct path ([src/components/realtimeSocket.ts](src/components/realtimeSocket.ts)), the provider realtime WSS loop + `recognizeFile` (async v2) + one-time-APPKEY mint + `prepareDirectSession` ([src/providers/AmiVoiceProvider.ts](src/providers/AmiVoiceProvider.ts)), error-code normalization ([src/errorCodes.ts](src/errorCodes.ts)), the derived speaker view ([src/speakerView.ts](src/speakerView.ts)), and the relay + direct server helper with injectable structured logging ([src/createAmiVoiceServer.ts](src/createAmiVoiceServer.ts)). A runnable example ([examples/relayServer.mjs](examples/relayServer.mjs)) and a user-facing README are in place; both transports are proven end to end in Node ([tests/integration/](tests/integration/)) and a real browser ([tests/browser/](tests/browser/)).

**Browser-direct (`transport="direct"`, [ADR 0006](docs/adr/0006-transport-baseline-after-one-time-appkey.md))** is done: the server mints a one-time, IP-restricted APPKEY + approved `s` over the control channel; the browser opens the AmiVoice WSS itself and streams audio direct, reusing the relay path's `runRealtimeSession` loop and result normalization (no parallel paths). The permanent APPKEY never leaves the server and the bindable surface is byte-identical (a contract test guards that `transport` never reaches it).

**Phase 3 hardening is done:** upstream-drop policy (unsolicited close → `error` + `connected=false`, finalized `transcript` preserved, explicit restart — SPEC §10.1), the derived final-only `speakers` view ([ADR 0007](docs/adr/0007-diarization-speaker-view.md), resolving Q6), Shell codec rejection (a `codec` the v1 data plane cannot encode is refused on `start()`, not silently downgraded — SPEC §13; telephony codecs 8K/MULAW/ALAW remain out of scope per Q9), the deployment security profile (SPEC §14 + the example's `authenticatePeer`/`authorize` seam), injectable structured logging on the server helper, and the coverage gate.

What is **not** done yet: a **real-AmiVoice smoke run** (paid APPKEY, gated behind `AMIVOICE_APPKEY`) and the **user-driven release** (version bump + `npm publish`, performed manually). The sequenced view is in [docs/implementation-plan.md](docs/implementation-plan.md), the remaining work consolidated into one brief is in [docs/implementation-brief.md](docs/implementation-brief.md), and the resolved/remaining tuning decisions are in [docs/implementation-notes.md](docs/implementation-notes.md); the normative status table is [SPEC.md § 23](SPEC.md). The release skill in `.claude/skills/release/SKILL.md` gates on a publishable, non-`file:`-dependency manifest.
