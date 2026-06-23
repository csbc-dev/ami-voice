# AmiVoice Component SPEC

This document defines the design contract for the `@csbc-dev/ami-voice` package. The AmiVoice transport is implemented and tested — the realtime WSS loop (relay + browser-direct) and the async-v2 HTTP file path both run in `AmiVoiceProvider` (see the status table in §23); what remains is the real-AmiVoice smoke run and the user-driven release. This SPEC is the normative "what"; the **why** lives in [docs/adr/](docs/adr/); the open **how** decisions live in [docs/implementation-notes.md](docs/implementation-notes.md).

The package target is a declarative speech-recognition component built with CSBC and `wc-bindable-protocol`, wrapping Advanced Media's **AmiVoice** cloud recognition API. It is **remote-first**: recognition authority and the APPKEY stay in a privileged server runtime, while the browser custom element exposes bindable state and runs the microphone data plane.

Requirements language (MUST / SHOULD / MAY) follows [BCP 14](https://www.rfc-editor.org/info/bcp14).

## 1. Scope

This SPEC covers:

- the public component model (`<ami-voice>`)
- the bindable state / input / command contract
- the recognition result model (interim vs finalized)
- the realtime and file recognition modes
- the two-channel transport contract (JSON control + binary audio)
- the upstream AmiVoice protocol the Core speaks
- security, error, and cancellation invariants

This SPEC does not cover:

- exact file layout or build tooling (see [CLAUDE.md](CLAUDE.md))
- the packaging / release workflow (see [.claude/skills/release/SKILL.md](.claude/skills/release/SKILL.md))
- AmiVoice account provisioning or billing
- unresolved implementation decisions (see [docs/implementation-notes.md](docs/implementation-notes.md))

## 2. Problem statement

Real-time speech recognition couples two things that pull in opposite directions: the **microphone data plane**, which can only run in the browser (`getUserMedia` needs a user gesture; capture runs on the audio thread), and the **APPKEY credential**, which must never reach the browser. AmiVoice's realtime endpoint authenticates with the raw APPKEY embedded in its start command, so a naïve browser-direct integration leaks the credential to every client.

The package resolves this by keeping recognition authority and the APPKEY server-side (the Core) while the browser owns only mic capture (the Shell), relaying audio to the server.

## 3. Quality priorities

In priority order:

1. **Credential safety** — the APPKEY never reaches the browser, by construction.
2. **Stable public contract** — the bindable surface is transport-independent and survives a future browser-direct optimization.
3. **Correct interim/final semantics** — consumers can render in-progress vs accepted text correctly.
4. **Low first-implementation risk** — one realtime transport path that works end to end.
5. **Bandwidth efficiency** — a non-goal for v1 (the relay sends audio through the server); revisited only if cost demands it.

## 4. Architectural model

The package is CSBC, straddling two canonical cases ([ADR 0001](docs/adr/0001-csbc-case-classification.md)):

- **Realtime recognition → Case C.** Browser-pinned mic data plane; server-side Core owns decisions and the APPKEY.
- **File recognition → Case B1.** Control-plane HTTP work owned entirely by the Core.

> **Invariant.** The Core owns every recognition decision and holds the APPKEY. The Shell owns only the microphone data plane and DOM wiring.

## 5. Component model

The package exposes **one authority-bearing custom element, `<ami-voice>`** (default tag; class `WcsAmiVoice`). All inputs and commands live on it. Optional child tags MAY be added later but MUST be projection-only (render a slice of parent state; declare no inputs or commands) ([ADR 0004](docs/adr/0004-bindable-surface.md)).

## 6. Source of truth

The `AmiVoiceCore` (an `EventTarget`) is the single source of truth for recognition state. In remote mode it runs on the server behind a `@wc-bindable/remote` proxy; in local (dev-only) mode it runs in the page via target injection. The Shell never holds recognition authority — it forwards Core state and adds only Shell-projected UI state.

## 7. Public contract — bindable surface

The element declares a `static wcBindable` (protocol `"wc-bindable"`, version `1`). Event naming is `ami-voice:<name>-changed`, except `error`, which is the unsuffixed signal `ami-voice:error`.

### 7.1 Properties (observable outputs)

| Property | Type | Origin | Meaning |
|---|---|---|---|
| `recognizing` | `boolean` | Core | A realtime session is active. |
| `connected` | `boolean` | Core | Core ↔ AmiVoice upstream connection is open. |
| `transcript` | `string` | Core | Accumulated **finalized** text (from `A` events). |
| `interim` | `string` | Core | Current in-progress hypothesis (from `U` events). |
| `segments` | `RecognitionSegment[]` | Core | Structured finalized history. |
| `speakers` | `SpeakerSegment[]` | Core | Speaker-labeled finalized turns, derived from `segments`. **Final-only** (updates on `A`, never `U`) ([ADR 0007](docs/adr/0007-diarization-speaker-view.md)). |
| `confidence` | `number` | Core | Latest finalized-segment confidence. **Final-only** (updates on `A`, never `U`). |
| `loading` | `boolean` | Core | A start / file request is in flight. |
| `error` | `Error \| SerializedError \| null` | Core/Shell | Last error (signal). |
| `level` | `number` | **Shell** | Mic input level for a meter (data-plane projection, not a Core decision). |
| `mode` | `"local" \| "remote"` | Shell | Active mode. |

`transcript` and `interim` MUST remain separate properties; they MUST NOT be merged. `confidence` MUST NOT be updated from a `U` payload.

### 7.2 Inputs

Inputs are Core policy, forwarded by the Shell. Security-relevant inputs MUST be applied with `await setWithAck()` before a dependent `start()` over the remote channel.

| Input | Type | AmiVoice mapping |
|---|---|---|
| `engine` | `string` | `grammar_file_names` (e.g. `-a-general`) |
| `codec` | `string` | `audio_format` (e.g. `LSB16K`) |
| `profileId` | `string` | `profileId` |
| `profileWords` | `string` | `profileWords` |
| `keepFillerToken` | `boolean` | `keepFillerToken` |
| `resultUpdatedInterval` | `number` | `resultUpdatedInterval` (ms) |
| `segmenterProperties` | `string` | `segmenterProperties` |
| `noLog` | `boolean` | selects the `/nolog/` endpoint |

### 7.3 Commands (element surface)

| Command | Async | Meaning |
|---|---|---|
| `start` | yes | Begin a realtime session; establishes a session id and starts mic capture. |
| `stop` | yes | **Graceful**: stop capture, flush (`e`), await the trailing final result, settle. |
| `abort` | no | **Immediate**: drop the AmiVoice session, audio channel, and mic; no final result. |
| `reset` | no | `abort()` then clear `transcript` / `interim` / `segments` / `confidence` / `error`. |

`recognizeFile` (Case B1) is a **Core** command, not an element command. The element command surface is realtime-focused; file recognition is reached through the Core / a server entry. `stop` and `abort` are load-bearing because cancellation over `@wc-bindable/remote` is producer-side — `AckOptions.signal` / `timeoutMs` settle only the caller's Promise and send no upstream cancellation ([ADR 0003 §5](docs/adr/0003-realtime-audio-transport.md), [ADR 0004](docs/adr/0004-bindable-surface.md)).

## 8. Recognition result model

The Core normalizes AmiVoice payloads; raw wire JSON is never exposed as public state.

- **`RecognitionToken`**: `{ written, spoken, confidence, starttime, endtime, label?, language? }`. `label` only with speaker diarization; `language` only on multilingual engines.
- **`RecognitionSegment`** (finalized, from `A`): `{ text, confidence, starttime, endtime, tokens, utteranceid? }`.
- **`InterimResult`** (from `U`): `{ text, tokens }` — **no** segment-level `confidence` (AmiVoice does not send one on `U`).
- **`SpeakerSegment`** (derived, final-only — [ADR 0007](docs/adr/0007-diarization-speaker-view.md)): `{ label, text, starttime, endtime, confidence }`. One per finalized segment, in order, exposed as the `speakers` property. `label` is the segment's speaker id (the first token carrying a non-empty `label`, with `segmenterProperties="useDiarizer=1"`), or `""` when not diarized — consumers treat `""` as a single/unknown speaker and MAY group `speakers` by `label` for a per-speaker transcript. `segments[].tokens[].label` remains the source of truth; `speakers` is a convenience projection.

On a finalized result the Core MUST: append the segment to `segments`, append its derived turn to `speakers`, append its text to `transcript`, set `confidence` to the segment's confidence, and clear `interim`.

## 9. Recognition modes

- **Realtime (Case C).** Microphone → two-channel relay → AmiVoice WSS → interim/final results. The element's primary mode.
- **File (Case B1).** A `File` / `Blob` recognized over HTTP. The Core POSTs to the async endpoint (v2 recommended) and polls; results append to `segments` / `transcript`. No browser data plane beyond handing the Core the blob.

## 10. Realtime session lifecycle

1. The consumer (optionally) sets inputs (`engine`, `codec`, …) via `setWithAck`.
2. `start()` opens the control session. The Core opens the AmiVoice WSS, sends the `s` command (APPKEY injected), and on success sets `connected` then `recognizing`. `start()` **establishes/returns a session id**.
3. The Shell opens the **binary audio channel**, authenticates it to the session id, and begins streaming captured PCM frames.
4. The server routes audio frames into the AmiVoice session as `p` frames. Interim (`U`) and finalized (`A`) results flow back over the **control channel** as bindable state.
5. `stop()` flushes (`e`), awaits the trailing final result, and tears down both channels. `abort()` tears down immediately.

The Core MUST publish failures to `error` rather than rejecting `start()` (consumers bind state, not wrap calls in try/catch). On disconnect of either channel the Core MUST tear down the AmiVoice session and the paired channel.

### 10.1 Upstream drop / reconnection (v1)

AmiVoice's realtime endpoint has **no resume**: if the upstream WSS drops mid-stream, the in-flight utterance is lost. The v1 recovery policy is **explicit restart** (implementation-notes Q3):

- On an upstream close the Core did **not** initiate (i.e. not a `stop()`/`abort()`/disconnect teardown), the Core MUST publish an `error` (normalized `code: "upstream"`) and set `connected = false` (and `recognizing = false`). It MUST require the consumer to call `start()` again to resume — it MUST NOT auto-reconnect in v1.
- Already-**finalized** state MUST be preserved across the drop: `transcript`, `segments`, and `confidence` MUST NOT be cleared by the teardown (only `interim` is in-flight and may be dropped). A subsequent `start()` continues appending to the existing `transcript`.
- A teardown the Core initiated (`stop()` graceful close, `abort()`, or a lost-`e`-ack fallback settle — §18) MUST NOT be surfaced as an `error`.

Auto-reconnect (re-opening the upstream and re-sending `s` while keeping the browser session) is a deferred enhancement; if added it MUST still never silently drop finalized `transcript`.

## 11. Transport contract

The relay is **two channels** because the `@wc-bindable/remote` wire is JSON-only and cannot carry binary audio ([ADR 0003](docs/adr/0003-realtime-audio-transport.md)).

### 11.1 Control channel (JSON)

`@wc-bindable/remote` over WebSocket. Carries `JsonValue`-shaped traffic only: state observation, the `start`/`stop`/`abort`/`reset` commands (`invoke`), and the inputs (`set`/`setWithAck`). It is the bindable surface's transport and MUST NOT carry audio bytes.

### 11.2 Binary audio channel

A separate WebSocket (`binaryType = "arraybuffer"`) carrying already-framed `audio_format` bytes (default `LSB16K`), browser → server only. It carries no protocol semantics — it is a byte pipe the server feeds into the AmiVoice session. Audio MUST NOT be base64-encoded onto the control channel.

### 11.3 Session correlation

The two channels MUST be correlated by the session id established on `invoke("start")`. The audio channel MUST authenticate to the same logical session (the token is carried in `Sec-WebSocket-Protocol`, not the query string), and the server MUST reject audio frames that do not map to a live session owned by the same authenticated peer.

### 11.4 Transport modes (relay default + direct opt-in)

The realtime transport has two modes, selected by deployment config (`transport` option / `transport="relay" | "direct"` attribute), default `"relay"` ([ADR 0006](docs/adr/0006-transport-baseline-after-one-time-appkey.md)). `transport` is deployment configuration; it MUST NOT be a wcBindable property/input/command, and the recognition surface (§7) is identical across modes.

- **Relay (default, v1).** §11.1–§11.3 above. Audio traverses the server; server cost `O(audio volume)`; Core holds the permanent APPKEY and owns `s`/event handling (strongest authority).
- **Direct (opt-in).** On `start()` the server mints a **one-time APPKEY** (`POST https://acp-api.amivoice.com/issue_service_authorization`; short `epi`, optional `ipa`) plus the approved `s`-params, and returns both over the control channel. The browser opens the AmiVoice WSS directly, sends the approved `s`, and streams audio directly. Audio bypasses the server (`O(connections)`); the permanent APPKEY never leaves the server; only a short-lived, IP-restricted token does. Core *decision* authority is **advisory** in this mode — the browser sends `s` and parses events, so a deployment that must enforce engine/grammar/profile server-side MUST validate the mint request rather than trust the client. Implemented via the server helper's `transport: "direct"` mode (mint route, `ipa` bound to the peer where known, degrading to a shorter `epi` with no `ipa` behind NAT/proxy) and the browser's `DirectBrowserProvider`, both sharing the relay path's `runRealtimeSession` loop and result normalization (no parallel paths).

## 12. Upstream AmiVoice protocol (server side)

The Core (or its provider) speaks AmiVoice's realtime ("Wnn") protocol. This is server-side only; it is never exposed to the browser.

- **Endpoints**: `wss://acp-api.amivoice.com/v1/` (logging) / `wss://acp-api.amivoice.com/v1/nolog/` (no logging). The trailing slash is significant.
- **Client → server**: `s <audio_format> <grammar_file_names> <key>=<value> … authorization=<APPKEY>` (start) · `p` + raw audio bytes · `e` (end). Server acks each as `s` / `p` / `e` (or `<cmd> <error>`).
- **Server → client events**: `S` (speech-segment start, +ms) · `E` (speech-segment end, +ms) · `C` (recognition started) · `U` (interim JSON) · `A` (final JSON) · `G` (server info).
- **File mode**: sync `POST https://acp-api.amivoice.com/v1/recognize`; async **v2 (recommended)** `POST https://acp-api-async.amivoice.com/v2/recognitions` (returns `sessionid`), poll `GET …/v2/recognitions/{sessionid}` with `Authorization: Bearer <APPKEY>` (`queued`→`started`→`processing`→`completed`/`error`); legacy v1 at `/v1/recognitions`.

The command builder (`buildStartCommand`) and event parser (`parseEvent`) are implemented and tested in `src/protocol/wnnProtocol.ts`.

## 13. Audio format / codec contract

The streaming `audio_format` (the `codec` input) is a **Core decision** ([ADR 0005](docs/adr/0005-audio-capture-and-codec-ownership.md)). The Shell encodes to whatever the Core declared and MUST NOT independently choose a format. The default is `LSB16K` (16 kHz, 16-bit signed PCM, little-endian). AmiVoice itself accepts the headerless identifiers `LSB8K…LSB48K` / `MSB8K…MSB48K`, `MULAW`, `ALAW` (case-insensitive); **ADPCM is not supported** for the realtime `audio_format`. The streamed bytes MUST match the format declared to AmiVoice in `s`. Capture, downsampling, PCM framing, and `level` computation are Shell-owned; upsampling is refused.

**v1 Shell encoder scope.** The browser data plane physically produces only **`LSB16K`** in v1 (implementation-notes Q9); `8K` / `MULAW` / `ALAW` await a telephony requirement. Because the Shell is what emits the bytes, it MUST **reject** a `codec` it cannot encode — `start()` publishes an `error` (normalized `unsupported-format`) and does not open a session — rather than silently stream `LSB16K` under a different `audio_format` label (which would desync the bytes from the `s` declaration). When telephony codecs are added, the Shell's encodable set (`canEncodeCodec`) widens accordingly; the rejection rule stays.

## 14. Security invariants

1. **APPKEY residency.** The APPKEY lives only in the Core / provider (read from `AMIVOICE_APPKEY`). It MUST NOT appear in `wcBindable` inputs, in any attribute, in client bundles, or in logs ([ADR 0002](docs/adr/0002-appkey-residency-and-remote-first.md)).
2. **Remote-first default.** The supported production deployment runs the Core server-side. Local (in-page Core) mode is dev-only and MUST NOT carry a production APPKEY.
3. **Auth before the shell.** `@wc-bindable/remote` is a protocol layer, not a security boundary. Peer authentication and per-command authorization MUST be enforced before any control message reaches the shell handler, and before any audio frame is accepted.
4. **Channel correlation is a trust boundary.** The audio channel MUST be bound to an authenticated session; a peer MUST NOT attach audio to another peer's session id.
5. **Browser-direct is conditional.** A future browser-direct mode is permitted only with a short-lived / one-time credential, never the permanent APPKEY.

### Deployment security profile (operator checklist)

`createAmiVoiceRelayServer` provides the relay/mint plumbing but is **not** a security boundary by itself (invariant 3). A production deployment MUST add, in front of it:

1. **Authenticate the peer before the shell.** Authenticate the control WebSocket (session cookie, bearer token in the handshake, mTLS, …) **before** calling `handleControlConnection`. `@wc-bindable/remote` carries no auth; an unauthenticated control peer is an unauthenticated Core.
2. **Authorize per command/tenant.** If different peers may use different engines/grammars/profiles or have quotas, enforce that policy before/around the shell — the bindable `inputs` are client-writable, so authorization cannot live in the browser.
3. **Bind the audio channel to the authenticated session.** Pass the audio session token via `Sec-WebSocket-Protocol` (never a query string — §11.3); `handleAudioConnection` rejects tokens with no live session, but the operator MUST ensure the audio peer is the same authenticated principal as the control peer (a token is a bearer — treat it as one).
4. **Rate-limit and bound resources.** Cap control-message rate and the `JsonValue` payload sizes a peer can send (oversized `profileWords` / `segmenterProperties`, message floods), and cap concurrent sessions per principal. Audio back-pressure is handled Shell-side (§11.2 / Q10) but the server SHOULD bound per-connection audio throughput too.
5. **Direct mode mint.** In `transport: "direct"`, pass the peer address so the one-time APPKEY is `ipa`-restricted; validate the mint request against the authorized policy (Core authority is advisory in direct mode — §11.4).
6. **Observe.** Wire the injectable `logger` (Phase 3.5) to your log pipeline for connection open/close, rejected audio frames, and emitted errors. The log records never contain the APPKEY, the audio token, or wire payloads — keep it that way if you wrap them.

The runnable [examples/relayServer.mjs](examples/relayServer.mjs) marks each of these as an `authenticatePeer` / `authorize` seam.

## 15. Core responsibilities

- Hold the APPKEY; never expose it on the wire.
- Validate and own recognition inputs (engine/codec/profile policy).
- Open and own the AmiVoice connection and its lifecycle; drive `s`/`p`/`e`; parse `S`/`E`/`C`/`U`/`A`/`G`.
- Normalize results into the public model; never expose raw wire JSON.
- Normalize errors into the stable `error` shape.
- Emit every bindable state transition.
- Accept relayed audio via `feedAudio()` (not a wcBindable command).

## 16. Shell responsibilities

- Own DOM lifecycle, attribute/property mapping, and command wiring.
- Run the mic data plane (`getUserMedia` → `AudioWorklet` → downsample → PCM frame) and stream frames on the binary channel (remote) or into `feedAudio()` (local).
- Project `level` and `mode`.
- Forward inputs/commands to the active bind target; never hold recognition authority, the APPKEY, or transport choice.
- On `disconnectedCallback`: stop capture, release `MediaStream` tracks, close both channels, dispose the proxy, abort the Core.

## 17. Error contract

- Recognition / provider failures (start, session I/O, file recognition) **publish to `error` and clear `loading`** — they MUST NOT reject the command Promise. Consumers bind `error`.
- AmiVoice rejections carry a single-character result `code` (`-` auth, `+` unsupported format, `%` audio too large, `$` client-audio timeout, `o` below-threshold, `b` server busy, `x` grammar not loaded, `c` cancelled, `?` fatal server error, `!`/`>`/`<`/`#` recognizer connect/send/receive/parse (upstream) failures, `^` invalid parameter). The Core SHOULD normalize these into a closed `AmiVoiceErrorCode` union while preserving the raw `message`; the client-error subset (`>`, `o`, `+`, `-`, `%`) is non-retryable.
- Over the network, only a serializable `{ name, message, stack? }` shape crosses (per `@wc-bindable/remote`); a producer SHOULD redact `stack` on untrusted boundaries.
- Precondition violations that are programmer errors (e.g. a missing APPKEY server-side) MAY throw synchronously in the provider.

## 18. Cancellation contract

- `stop()` is graceful: stop capture, send `e`, then **keep consuming `A` / `U` events until the `e` ack arrives** (the `e` response is AmiVoice's end-of-results signal), then settle. The wait MUST be bounded by a fallback timeout (~5 s, configurable) in case the ack is lost; on timeout, settle and keep accumulated state — never error (see [implementation-notes.md Q4](docs/implementation-notes.md)).
- `abort()` is immediate: drop the AmiVoice session, the audio channel, and the mic with no trailing result.
- DOM disconnection triggers teardown equivalent to `abort()`.
- Client-side `AckOptions` cancellation does not propagate upstream; only `stop` / `abort` do.

## 19. File mode (Case B1) contract

- `recognizeFile(blob)` is a Core command. v1 always uses the **async v2** path: POST to enqueue with the APPKEY, poll the job (exponential backoff, bounded by a deadline), normalize `segments`, and append them to `transcript` / `segments`. A sync `recognize` path and size-threshold selection remain an open item ([Q8](docs/implementation-notes.md)), not current behavior.
- No browser data plane is involved beyond handing the Core a `File` / `Blob`.

## 20. Performance expectations

- Server cost scales with **audio volume**, not just connection count — explicitly unlike `s3-uploader`, because audio traverses the server ([ADR 0003](docs/adr/0003-realtime-audio-transport.md)). This MUST be stated in the README so integrators size servers accordingly.
- `level` emission SHOULD be throttled to avoid flooding the consumer with per-frame updates (see [implementation-notes.md Q5](docs/implementation-notes.md)).

## 21. Compatibility and evolution

- The bindable surface (property/input/command names, the `error`-as-signal convention, the codec contract) is the public contract; changes are breaking and go through the release skill.
- A future browser-direct transport, or child projection tags, MUST preserve the existing bindable surface.

## 22. Non-goals

- Audio bytes bypassing the server (browser-direct) in v1.
- ADPCM streaming.
- Speaker-identity UI beyond surfacing token `label` (diarization output).
- Offline / on-device recognition.
- Two-way audio or TTS.

## 23. Implementation status

| Area | Status |
|---|---|
| Bindable surface, Core state/events, target injection | Implemented (`src/core/AmiVoiceCore.ts`) |
| `s`/`p`/`e` builder + `S`/`E`/`C`/`U`/`A`/`G` parser | Implemented + tested (`src/protocol/wnnProtocol.ts`) |
| PCM downsample / `LSB16K` framing / level | Implemented + tested (`src/audio/pcmEncoder.ts`) |
| Shell modes, state forwarding, two-channel wiring | Implemented (`src/components/AmiVoice.ts`) |
| Mic capture (`getUserMedia` + `AudioWorklet`) | Implemented + e2e-tested (Playwright real browser) |
| AmiVoice realtime WSS loop | Implemented + tested (`AmiVoiceProvider.openRealtimeSession`, injectable socket) |
| File recognition HTTP (async v2 enqueue + poll + normalize) | Implemented (`AmiVoiceProvider.recognizeFile`) |
| One-time APPKEY mint (direct-mode seam) | Implemented (`AmiVoiceProvider.issueOneTimeAppKey` / `prepareDirectSession`) |
| Relay server helper (control + audio + session table) | Implemented + tested (`createAmiVoiceRelayServer`) |
| Error-code normalization | Implemented + tested (`src/errorCodes.ts`) |
| **Browser-direct mode** (ADR 0006) | **Implemented + tested** — `transport="direct"`; shared `runRealtimeSession`, browser `DirectBrowserProvider`, server mint route with `ipa` binding; Node + real-browser Playwright |
| Integration harness | Implemented + green — Node full-stack (`test:integration`, relay + direct) + real-browser Playwright (`test:e2e`, relay + direct) against a fake AmiVoice WSS |
| Upstream-drop policy (§10.1) | Implemented + tested — unsolicited close → `error` (`upstream`) + `connected=false`, finalized `transcript` preserved, explicit restart (`runRealtimeSession`, Q3) |
| Speaker view (§7.1/§8, ADR 0007) | Implemented + tested — derived final-only `speakers` property (`src/speakerView.ts`) |
| Codec rejection (§13) | Implemented + tested — Shell refuses a `codec` it cannot encode (v1: `LSB16K` only); `8K`/`MULAW`/`ALAW` out of scope (Q9) |
| Structured logging (§14) | Implemented + tested — injectable `logger` on `createAmiVoiceRelayServer` (open/close, rejected audio, emitted errors; no secrets) |
| Coverage gate | Implemented — `npm run test:coverage` over the portable logic layer |

Both transports are implemented and verified end to end in Node and a real browser, and the Phase 3 hardening is in place. **Relay**: browser mic data plane → control proxy → Core → provider WSS loop; binary audio over a `Sec-WebSocket-Protocol`-correlated channel → server helper → `feedAudio`. **Direct** (docs/adr/0006): the control proxy mints (one-time APPKEY + approved `s`); the browser opens the AmiVoice WSS itself and streams audio direct, reusing the shared `runRealtimeSession` loop — the permanent APPKEY never leaves the server and the bindable surface is byte-identical. What remains is a real-AmiVoice smoke run (gated behind `AMIVOICE_APPKEY`) and the user-driven release (version bump + `npm publish`). Resolved/remaining tuning decisions are tracked in [docs/implementation-notes.md](docs/implementation-notes.md).
