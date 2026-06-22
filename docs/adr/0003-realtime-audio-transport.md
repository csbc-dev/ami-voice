# ADR 0003: Real-time audio transport baseline

## Status

Accepted (design intent)

Date: 2026-06-23

Revised: 2026-06-23 — corrected the relay from a single channel to a **two-channel** design (JSON control + binary audio) after confirming that the `@wc-bindable/remote` wire format is JSON-only (`JsonValue`) and therefore cannot carry raw audio frames. The *decision* (server-relayed baseline) is unchanged; the *mechanism* is refined.

Amended by [ADR 0006](0006-transport-baseline-after-one-time-appkey.md) (2026-06-23): AmiVoice's one-time APPKEY is confirmed to exist, so the Alternative A "con" (unconfirmed short-lived credential) below is now resolved. This relay stays the **default and v1 implementation baseline**; browser-direct becomes an **opt-in second mode**. The Alternative A analysis below is retained for history but is no longer the reason browser-direct is deferred — see ADR 0006.

## Context

In real-time mode the browser captures microphone audio (browser-pinned data plane, [ADR 0001](0001-csbc-case-classification.md)) and the APPKEY lives only in the server-side Core ([ADR 0002](0002-appkey-residency-and-remote-first.md)). That leaves one open question: **how do the captured audio frames get to AmiVoice?**

AmiVoice's real-time endpoint authenticates with the APPKEY embedded in the `s` (start) command on the WebSocket itself. There is no separate header handshake the server could perform on the browser's behalf while the browser keeps the socket. So the audio path has to resolve to one of two shapes:

1. **Server-relayed stream.** The browser streams captured frames to the server; the Core holds the AmiVoice WebSocket, injects the APPKEY in `s`, forwards `p`-framed audio, sends `e`, and pushes parsed `U` / `A` results back to the browser surface.
2. **Browser-direct stream.** The browser opens the AmiVoice WebSocket itself and streams frames directly, with the server only minting a credential for the `s` command.

This is the same shape as the `lambda` package's ADR 0001 (server-proxied vs. presigned-direct stream), and the same tension `s3-uploader` resolved by sending bytes browser→S3 directly. The difference here is the credential model: `s3-uploader` can sign a URL the browser uses directly, but AmiVoice's real-time auth is the raw APPKEY inside the live socket.

**The load-bearing transport constraint — the wc-bindable remote wire is JSON-only.** `@wc-bindable/remote` (the package this family uses to push a Core onto a server, [ADR 0002](0002-appkey-residency-and-remote-first.md)) defines a wire format where **every value MUST be a `JsonValue`** (SPEC-extensions.md Extension 2). Binary audio frames (`Uint8Array` PCM/ADPCM) are not `JsonValue`; the proxy's `set` / `invoke` validation rejects them. Pushing audio through `proxy.invoke()` / `proxy.set()` would force base64 encoding (~33% size inflation) plus a deep `JsonValue` validation pass per frame — unacceptable for a continuous 16 kHz stream. So the server-relayed option above **cannot be a single channel over `@wc-bindable/remote`**: the control plane and the audio data plane must be separated.

Design constraints that matter:

- security of the credential boundary is the top priority ([ADR 0002](0002-appkey-residency-and-remote-first.md))
- the public bindable contract must stay stable across transport changes
- the Core must remain the sole authority for session policy and result normalization
- the first implementation should be shippable without solving credential-minting edge cases
- the audio data plane must not ride the JSON `@wc-bindable/remote` channel

## Decision

The package adopts the **two-channel server relay** as the **baseline** real-time transport.

The relay is split into two parallel channels between the browser Shell and the server:

1. **Control channel — `@wc-bindable/remote` (JSON wire).** Carries everything that is `JsonValue`-shaped: the bindable state observation (`transcript`, `interim`, `segments`, `recognizing`, `connected`, `error`, …), the `start` / `stop` / `abort` commands via `invoke()`, and the `engine` / `codec` / `profileId` / … inputs via `setWithAck()`. The Core is the sole authority here.
2. **Audio data channel — a separate binary WebSocket (browser → server).** Carries only the already-framed PCM bytes (`LSB16K` / `MSB16K`) the Shell captured ([ADR 0005](0005-audio-capture-and-codec-ownership.md)). The server forwards these to AmiVoice as `p`-framed audio. No recognition decision is made on this channel; it is a dumb byte pipe into the Core's AmiVoice session.

The two channels are **correlated by a session identifier**: `invoke("start")` on the control channel establishes (or returns) a session id / token, and the binary audio WebSocket authenticates and tags itself to that same logical session so the server can route its frames into the correct AmiVoice connection. The Core owns the AmiVoice WebSocket and the APPKEY on the server side; results flow back over the control channel as bindable state.

**Browser-direct stream is kept as a future, conditional optimization**, allowed only if AmiVoice exposes a short-lived / one-time credential usable in the `s` command (per [ADR 0002](0002-appkey-residency-and-remote-first.md) Alternative B). It is **not** the baseline and must **not** shape the initial public contract.

## Rationale

### 1. It is the only transport that is unconditionally safe today

The relay keeps the permanent APPKEY entirely server-side without depending on any AmiVoice credential-minting feature that may or may not exist. Browser-direct cannot be the baseline because it is *conditional* on a feature we have not confirmed.

### 2. Two channels are forced by the JSON-only wire, and are the honest shape anyway

The wc-bindable remote wire is JSON-only, so audio physically cannot share it without base64 + per-frame validation overhead. Separating the binary audio channel from the JSON control channel is therefore not a stylistic choice — it is the only conformant way to relay. It also keeps each channel single-purpose: control is observable, replayable, and `JsonValue`-validated; audio is a raw byte pipe with no protocol semantics of its own.

### 3. It keeps session policy and normalization in the Core

With the Core in the data path, engine/grammar selection, profile words, `keepFillerToken` / `segmenterProperties` policy, `S`/`E`/`C`/`U`/`A` event parsing, and error normalization all stay in one privileged place — the same place buffered/file recognition already runs. The audio channel adds bytes, not authority.

### 4. It keeps the public contract independent of transport

If the first design were built around browser-direct sockets, transport details (credential minting, direct socket lifecycle, AmiVoice endpoint specifics) would leak into the public component contract. Starting with the relay keeps the bindable surface centered on recognition *state*, not network topology — so a later direct-stream optimization can slot in under the same contract.

### 5. The control commands are load-bearing because cancellation is producer-side

`start` is a long-running streaming command. Per the wc-bindable remote contract, `AckOptions.signal` / `timeoutMs` are **client-local** cancellations — they settle the consumer Promise but send **no** wire-level cancellation to the producer. A long-running command therefore needs an explicit `abort` / `stop` command so the consumer can actually tell the Core to tear down the AmiVoice session and the audio channel. This is why [ADR 0004](0004-bindable-surface.md) declares `stop` / `abort` as first-class commands rather than relying on signal-based cancellation.

### 6. It lowers first-implementation risk

The shortest path to a working package is: capture in the Shell, one JSON control channel + one binary audio channel that work end-to-end, results on the parent. The relay avoids simultaneously solving credential minting, direct-socket reconnection, and direct-path observability.

## Alternatives considered

### Alternative A: make browser-direct stream the baseline

- Pros: closest symmetry with `s3-uploader` (heavy data path avoids the server); audio bytes never traverse the server, so server cost scales with connections, not audio volume; strong long-term story for high-throughput recognition; collapses back to a single channel.
- Cons: depends on an AmiVoice short-lived-credential mechanism that is unconfirmed; if absent, it forces the permanent APPKEY into the browser, violating [ADR 0002](0002-appkey-residency-and-remote-first.md); pushes transport detail into the public contract; more reconnection / observability edge cases in the first release. **Rejected as baseline, kept as a conditional future optimization.**

### Alternative B: single-channel relay — push audio through `@wc-bindable/remote` as base64

Relay both control and audio over the one JSON wire, base64-encoding each audio frame into a `JsonValue` string argument to a `feedAudio` command.

- Pros: one channel; no separate WebSocket to authenticate and correlate; reuses the existing remote proxy lifecycle.
- Cons: base64 inflates every frame ~33%; each frame runs the proxy's full deep `JsonValue` validation; a continuous command/`set` stream abuses a control channel built for discrete RPC (pre-sync queue bounds, ack bookkeeping, FIFO call-order machinery all apply per-frame). The JSON-only wire makes this the *worst* place to put a high-rate binary stream. **Rejected** — this is exactly why the Decision splits the channels.

### Alternative C: relay, but as opaque blobs with parsing in the browser

Relay frames through the Core but parse `U`/`A` events client-side.

- Pros: marginally less Core CPU.
- Cons: splits result normalization across the wire, so the Shell gains recognition-decision responsibility — violates the Core-authority invariant ([ADR 0001](0001-csbc-case-classification.md)). Rejected.

## Consequences

### Positive

- The permanent APPKEY never leaves the server, unconditionally.
- Session policy, event parsing, and normalization stay Core-owned; the audio channel carries bytes, not authority.
- The control plane stays a clean `JsonValue` wc-bindable surface; the audio plane stays a raw byte pipe. Neither pollutes the other.
- The public bindable contract is transport-independent, so a future direct-stream path is addable without a breaking change.

### Negative

- **Two channels to stand up, authenticate, and correlate.** The binary audio WebSocket needs its own auth and a session-id handshake tying it to the control channel's `start`. A mismatch (audio channel opens against the wrong session, or outlives the control session) is a new failure mode to design against.
- **Audio frames traverse the server** (browser → server → AmiVoice), so server cost scales with audio volume, not just connection count — explicitly unlike `s3-uploader`. State this plainly in the README so integrators size their servers accordingly.
- The server is in the hot path for every audio frame, adding latency versus a hypothetical direct connection.
- A future bandwidth-efficiency pass (Alternative A) is still needed if audio volume becomes a leading cost concern.

## Follow-up rules

1. The audio data plane MUST NOT ride the `@wc-bindable/remote` JSON channel. Audio stays on its own binary WebSocket; the control channel stays `JsonValue`-only.
2. The two channels MUST be correlated by a session identifier established on `invoke("start")`; the audio channel MUST authenticate to the same logical session and the server MUST reject audio frames that do not map to a live session.
3. On disconnect of either channel, the Core MUST tear down the AmiVoice session and the paired channel (a dangling audio socket or an orphaned control session is a leak — compare `s3-uploader`'s `ws.on("close", () => core.abort())` rule).
4. Any later introduction of a browser-direct stream must still keep the permanent APPKEY off the browser (only a short-lived / one-time credential may cross, per [ADR 0002](0002-appkey-residency-and-remote-first.md)), keep the Core the sole authority for session policy and result normalization, and keep the bindable surface of `<ami-voice>` compatible — no transport detail leaking into attributes, properties, or events.
5. The README documents the server-cost difference between relay and direct modes.
