# Implementation notes & open questions

Status as of the initial scaffold. This tracks **what is deliberately unfinished** and **the decisions an implementer must still make** before the stubs become a working AmiVoice client. Settled decisions live in the [ADRs](.); the normative contract lives in [SPEC.md](../SPEC.md). This file is the open "how".

Each open question is stated as: **Context → Options → Lean (current recommendation) → Blocker (what would resolve it)**. A "Lean" is not yet an ADR — promote it to one (or to SPEC text) when decided.

---

## A. Stub boundaries (what is intentionally not implemented)

**Implemented since the initial scaffold** (relay path, end to end): the realtime WSS loop (`AmiVoiceProvider.openRealtimeSession`, injectable socket), file recognition (`recognizeFile`, async v2 enqueue + poll + normalize), the one-time-APPKEY mint (`issueOneTimeAppKey`), error-code normalization (`src/errorCodes.ts`), and the relay server helper (`createAmiVoiceRelayServer`: control via `RemoteShellProxy` + audio routed to `core.feedAudio`, session table). All unit-tested (40 tests).

**Still unfinished:**

| Boundary | Location | Why | What "done" looks like |
|---|---|---|---|
| ~~Browser-direct mode~~ | `src/components/realtimeSocket.ts`, `createAmiVoiceServer.ts` (`transport:"direct"`), Core `transport` option | ✅ **Done** (Phase 2, ADR 0006) — folded into `start()`; server mints (`prepareDirectSession`, `ipa` bound to peer), browser opens the AmiVoice WSS directly and parses events client-side via the shared `runRealtimeSession`. Node + Playwright e2e green. | done |
| ~~Mic capture runtime~~ | `MicCapture` | ✅ **Covered** — exercised by the Playwright e2e (`tests/browser/relay.browser.spec.ts`) with a Chromium fake audio device. | done |
| ~~Integration harness~~ | `tests/integration` + `tests/browser` | ✅ **Done** — Node full-stack (`test:integration`) + real-browser Playwright (`test:e2e`) against the fake AmiVoice WSS. | done |
| Real-AmiVoice run | provider | Needs a paid APPKEY; gated behind `AMIVOICE_APPKEY` | A smoke run against `wss://acp-api.amivoice.com/v1/` |
| Tuning | various | upstream reconnect (Q3) remains open; `level` throttle (Q5), audio backpressure (Q10), graceful-stop (Q4/D1) are wired | Q3 decided + wired against the real transport |

---

## B. Open questions

### Q1 — Binary audio channel: same server, framing, and auth

**Context.** [ADR 0003](0003-realtime-audio-transport.md) fixes that audio rides a separate binary WebSocket, not the JSON proxy. It does not fix the channel's concrete shape. `openAudioChannel()` currently just appends `?session=<id>` to the control URL and opens a `WebSocket` with `binaryType=arraybuffer`.

**Options.**
- (a) Same WS server/port as the control channel, distinguished by path/query; (b) a dedicated audio server/port.
- Framing: (a) one WS binary message per captured frame (simple, many small frames); (b) length-prefixed batching to reduce message overhead.
- Auth: (a) query-string session token; (b) `Sec-WebSocket-Protocol` token; (c) a first in-band auth frame before audio.

**Lean.** Same server, per-frame binary messages to start (simplest), session bound via a **short-lived token returned by `start()`** carried in `Sec-WebSocket-Protocol` (query strings land in logs). Batching is a later optimization.

**Resolved (Phase 1).** Implemented as the lean: the Core mints an opaque token on `start()` (returned as the `invoke` result); `openAudioChannel` carries it in `Sec-WebSocket-Protocol`, **not** the query string (SPEC §11.3); per-frame binary messages. The Shell opens control and audio at the **same URL** (the page origin), so a single-port server routes by subprotocol presence (control offers none; audio offers the token) — see `examples/relayServer.mjs` and `tests/browser/harnessServer.mjs`. This was caught by the real-browser e2e: the original `openAudioChannel` used a `?session=` query string, which both leaked the bearer token and broke single-port routing. Batching is still a later optimization.

### Q2 — Session id: minting, format, lifetime, correlation security

**Context.** SPEC §10/§11.3 says `start()` establishes a session id that the audio channel binds to, and the server MUST reject frames not mapping to a live session owned by the same peer.

**Options.** Who mints it: the Core on `start()` (returned as the `invoke` result) vs the server transport layer. Format: opaque random token vs signed (HMAC/JWT) so the audio server can validate without shared state.

**Lean.** Core mints an **opaque high-entropy token** on `start()`, stored server-side against the authenticated peer; the audio server validates by lookup (not by trusting the token's contents). A signed token is the scale-out option if audio and control live in different processes.

**Blocker.** Whether control and audio share a process (Q11). Same process → in-memory map; split → signed token.

### Q3 — AmiVoice realtime reconnection / mid-utterance loss

**Context.** If the upstream AmiVoice WSS drops mid-stream, the in-flight utterance is lost (AmiVoice has no resume). The Core must decide recovery.

**Options.** (a) Surface the drop as `error` + `connected=false` and require the consumer to `start()` again; (b) auto-reconnect and silently continue (loses the current utterance either way); (c) auto-reconnect only the upstream while keeping the browser session, re-sending the `s` command.

**Lean.** (a) for v1 — explicit, debuggable, no hidden state. Auto-reconnect is a later enhancement and MUST NOT silently drop finalized text already in `transcript`.

**Blocker.** None; just needs to be decided and written into SPEC §10.

### Q4 — Graceful `stop()`: how long to wait for the trailing final result

**Context.** SPEC §18: `stop()` sends `e` and awaits the trailing `A`. A final result may be slow or never arrive.

**Options.** Fixed timeout (e.g. 5 s) then settle with whatever is accumulated; or wait for the AmiVoice `e` ack rather than a final `A`.

**Lean.** Wait for the `e` ack (AmiVoice signals end-of-processing) with a bounded fallback timeout (default ~5 s, configurable). On timeout, settle and keep accumulated state; do not error.

**Resolved (D1).** Per the AmiVoice docs, after sending `e` the client should **keep processing incoming events until the `e` response arrives** — the `e` ack is the end-of-results signal (a final `A` typically arrives just before it; the ordering is not otherwise guaranteed). So `stop()` keeps consuming `A`/`U`, then settles on the `e` ack, with a bounded fallback timeout (~5 s, configurable) if the ack is lost. On timeout, settle and keep accumulated state; never error.

### Q5 — `level` emission cadence

**Context.** `MicCapture` computes RMS per worklet frame (hundreds/sec). Emitting `ami-voice:level-changed` every frame floods consumers and, in remote mode, would be pointless cross-wire chatter (level is Shell-local anyway).

**Options.** Emit per frame; throttle to rAF (~60/s); throttle to a fixed interval (e.g. 100 ms).

**Lean.** Throttle to rAF (or ~50–100 ms) in the Shell. `level` never crosses the wire (Shell-projected), so this is purely a local emission concern.

**Blocker.** None.

### Q6 — Speaker diarization & multilingual surfacing

**Context.** With `segmenterProperties="useDiarizer=1"`, tokens carry `label` (speaker); multilingual engines add token `language`. The result model keeps both optional fields, but the bindable surface does not expose speaker-level aggregation.

**Options.** (a) Leave `label`/`language` on tokens only; (b) add a derived `speakers` / per-speaker segment view; (c) add a child projection tag for a speaker-labeled transcript.

**Lean.** (a) for v1 — keep the data on tokens, no new top-level property. Revisit a child projection tag (per [ADR 0004](0004-bindable-surface.md)) if a diarized-transcript UI is needed.

**Blocker.** Product requirement — is diarization a v1 use case?

### Q7 — Error taxonomy: AmiVoice errors → normalized codes

**Context.** AmiVoice signals failures as `s <error>` / `p <error>` / `e <error>` strings and HTTP error bodies. The Core currently normalizes any throw into `{ name, message }` but assigns no stable `code`.

**Options.** (a) Pass messages through as-is; (b) define a small `AmiVoiceErrorCode` union (auth-failed, format-rejected, quota, upstream-closed, timeout) mapped from known AmiVoice error strings.

**Lean.** (b) a closed code union for the handful of actionable cases, with the raw message preserved. Mirrors the family's "owned errors as a closed union" pattern (s3's `S3OwnedError`).

**Resolved (D2).** AmiVoice's result `code` is a single character (empty string = success): `-` illegal service authorization (auth fail), `+` unsupported audio format, `%` audio too large, `$` client-audio timeout, `o` rejected — confidence below threshold, `b` rejected — server busy, `x` rejected — grammar not loaded, `c` rejected — cancelled, `?` rejected — fatal server error, `!`/`>`/`<`/`#` recognizer connect/send/receive/parse failures, `^` invalid parameter. Client errors (resolve, don't retry): `>`, `o`, `+`, `-`, `%`. Define `AmiVoiceErrorCode` mapping these (auth / format / too-large / busy / no-grammar / cancelled / below-threshold / upstream / invalid-param), preserve the raw `message`, and flag the client-error subset as non-retryable.

### Q8 — File mode: sync vs async selection and polling policy

**Context.** SPEC §19 says the Core picks sync vs async by policy. AmiVoice recommends async v2 for long files; sync `recognize` for short audio.

**Options.** Threshold by byte size / duration; always-async; expose the choice as an input.

**Lean.** Size threshold (sync under a few seconds / ~1 MB, async above), async = v2 with exponential-backoff polling (start ~1 s, cap ~5 s). Keep the threshold a provider option.

**Blocker.** None; needs the HTTP transport (Q stub) first.

### Q9 — Codec policy & default; exposing MULAW/ALAW

**Context.** [ADR 0005](0005-audio-capture-and-codec-ownership.md) makes `codec` a Core input; default `LSB16K`. The encoder currently implements only `LSB16K`.

**Options.** Ship only `LSB16K` (16 kHz PCM) and reject others until needed; or implement `MSB16K` / `MULAW` / `ALAW` / 8 kHz now.

**Lean.** `LSB16K` only for v1 (covers the 16 kHz engines). Add `8K` + `MULAW`/`ALAW` when a telephony use case appears. The Shell MUST reject a `codec` it cannot encode rather than silently send `LSB16K`.

**Blocker.** Telephony (8 kHz) requirement.

### Q10 — Audio backpressure / flow control

**Context.** Capture produces frames at a fixed real-time rate. If the audio WS or the server→AmiVoice path stalls, frames accumulate.

**Options.** Drop frames on `bufferedAmount` pressure; pause capture; unbounded (rely on real-time pacing).

**Lean.** Monitor `audioWs.bufferedAmount`; if it exceeds a cap, drop oldest frames and surface a `level`-style warning rather than unbounded buffering. Real-time audio is loss-tolerant (a dropped 20 ms frame ≪ a stalled session).

**Blocker.** None; tune against the real transport.

### Q11 — Server helper bundle shape (control + audio)

**Context.** The package ships a browser default barrel and a Node `/server` barrel, but no server *runtime* helper yet (s3 ships `createAuthenticatedWSS`-style helpers; auth0 ships `createAuthenticatedWSS`). ami-voice needs a server helper that stands up BOTH the `@wc-bindable/remote` control endpoint AND the binary audio endpoint, sharing session/auth state.

**Options.** One `createAmiVoiceServer({ server })` that mounts both on one HTTP server; or two independent helpers the integrator wires together.

**Lean.** One helper that owns both endpoints and the session table, so Q1/Q2 auth/correlation is solved in one place. Model after auth0's `createAuthenticatedWSS` (`{ server }` attach + auth handshake).

**Blocker.** This is the largest remaining design piece; it determines Q1, Q2, and Q3's recovery story.

### Q12 — Browser-direct mode feasibility (one-time APPKEY)

**Context.** [ADR 0003](0003-realtime-audio-transport.md) Alternative A (browser streams directly to AmiVoice, server only mints a credential) was viable only if AmiVoice offers a short-lived / one-time credential for the realtime `s` command.

**Resolved (D3) — CONFIRMED; baseline decision moved to [ADR 0006](0006-transport-baseline-after-one-time-appkey.md).** AmiVoice DOES issue one-time APPKEYs: `POST https://acp-api.amivoice.com/issue_service_authorization` returns a short-lived service-authorization string with an expiry (`epi`, default 30 s — the window to *open* the connection, not the session length) and an optional source-IP restriction (`ipa`). The server mints it from a service id/password (or an "APPKEY発行可能" APPKEY) and never ships the permanent APPKEY.

This removes ADR 0003 Alternative A's only blocking con. **Browser-direct is now genuinely viable**: the browser opens the AmiVoice WSS itself with a 30 s, IP-restricted token; audio never traverses the server; server cost drops to `O(connections)`; and the design collapses to one channel (s3-uploader symmetry). The remaining tradeoff is CSBC *decision* authority — in browser-direct the browser sends the `s` command and parses events, so the Core's engine/grammar/profile authority becomes advisory unless the mint step echoes and the client honors it. Whether to keep the two-channel relay baseline or flip to browser-direct is the subject of [ADR 0006](0006-transport-baseline-after-one-time-appkey.md).

### Q13 — Bootstrap re-config and multiple elements

**Context.** `bootstrapAmiVoice()` / `setConfig()` is "configure once before connect". Multiple `<ami-voice>` elements share the module config and registry.

**Options.** Per-element overrides via attributes (`remote-url`, `mode`) already exist; decide whether codec/engine defaults are global or per-element only.

**Lean.** Global defaults via config; per-element overrides via attributes/inputs (already the case). Document "configure once" as a hard rule (re-config after connect is undefined behavior, per the family pattern).

**Blocker.** None.

### Q14 — Testing strategy

**Context.** Unit tests cover the pure parts (protocol, encoder, Core state, contract). The mic data plane and real WSS are untestable in happy-dom.

**Options.** Add a Playwright integration suite (real mic via fake-device flags, a stub AmiVoice WSS server) under `tests/`, run via `test:integration` like s3.

**Lean.** Add `test:integration` (Playwright) that drives `<ami-voice>` against a **local fake AmiVoice WSS** (replays canned `S`/`E`/`U`/`A` frames) and a Chromium fake audio device. This catches the data-plane and channel-correlation paths unit tests can't.

**Resolved (Phase 1).** Two suites, kept separate from the happy-dom unit suite: (1) `test:integration` — Node full-stack over real `ws` sockets (`tests/integration/relay.e2e.test.ts`); (2) `test:e2e` — Playwright real-browser (`tests/browser/relay.browser.spec.ts`) using system Chrome (`channel: "chrome"`, `--use-fake-device-for-media-stream`) against the single-port harness `tests/browser/harnessServer.mjs` + fake AmiVoice. The e2e asserts `connected`/`recognizing`/`interim`/`transcript` in the DOM, exercising the real `getUserMedia` → `AudioWorklet` → PCM data plane. Real-AmiVoice runs remain gated behind `AMIVOICE_APPKEY` (the fake WSS is the default CI path).

---

## C. Locked decisions (do not relitigate without a new ADR)

- CSBC: realtime = Case C, file = Case B1 — [ADR 0001](0001-csbc-case-classification.md).
- APPKEY server-only, remote-first default — [ADR 0002](0002-appkey-residency-and-remote-first.md).
- Two-channel relay (JSON control + binary audio), not single-channel or browser-direct (for v1) — [ADR 0003](0003-realtime-audio-transport.md).
- Single authority tag; `transcript`/`interim` separate; `confidence` final-only; children projection-only — [ADR 0004](0004-bindable-surface.md).
- Capture/framing Shell-owned, `codec` Core policy; no ADPCM — [ADR 0005](0005-audio-capture-and-codec-ownership.md).

---

## D. AmiVoice reference questions — resolved (2026-06-23)

Confirmed against [docs.amivoice.com](https://docs.amivoice.com/en/amivoice-api/manual/):

1. **`e` ack semantics** — keep processing events until the `e` response; the `e` ack is the end-of-results signal. (→ Q4)
2. **Result error codes** — single-char `code` table catalogued (`-`/`+`/`%`/`o`/`b`/`x`/`c`/`?`/`!`/`>`/`<`/`#`/`$`/`^`). (→ Q7)
3. **One-time APPKEY** — YES: `POST https://acp-api.amivoice.com/issue_service_authorization`, `epi` (expiry, default 30 s), `ipa` (source-IP restriction). Unblocks browser-direct. (→ Q12, [ADR 0006](0006-transport-baseline-after-one-time-appkey.md))
4. **`G` event** — undocumented beyond "information generated by the server; does not occur unless the related feature is used." Treat `G` as opaque and ignore for v1; revisit if a feature that emits it is enabled.
5. **Async v2 response** — v2 nests `segments[].results[].{ text, confidence, starttime, endtime, tokens[], label? }` plus top-level `text` / `utteranceid` / `code` / `message`; the file normalizer iterates segments → results. v1 differs (no `segments[]` wrapper, supports sentiment which v2 drops); target v2, and `compatibleWithSync` exists if a flatter shape is wanted. (→ Q8)
