# Implementation plan

Sequenced delivery plan for `@csbc-dev/ami-voice`. Roles of the docs: [ADRs](.) = *why*, [SPEC.md](../SPEC.md) = *what*, [implementation-notes.md](implementation-notes.md) = open *how* (Q1–Q14), **this file = when / in what order**. Each task cites the decision/question it rests on. Sizes are rough: **S** ≤ half-day, **M** ≈ 1–2 days, **L** ≈ 3+ days.

## Current status — Phases 1 & 2 complete; Phase 3 hardening done

Scaffold, relay implementation, the full relay e2e, browser-direct mode, AND the Phase 3 hardening are done and green (build clean; 199 unit + 5 Node integration + 2 real-browser Playwright; coverage gate over the portable logic layer). Only the user-driven release (version bump + `npm publish`) and a real-AmiVoice smoke run remain.

- Bindable surface, Core state machine, target injection, `s`/`p`/`e` builder + `S/E/C/U/A/G` parser, PCM/`LSB16K` encoder, Shell (local/relay/direct, two-channel wiring), mic capture (browser-runtime).
- Provider realtime WSS loop (injectable socket; shared `runRealtimeSession`), `recognizeFile` (async v2), one-time-APPKEY mint + `prepareDirectSession`, error-code normalization.
- Relay server helper (`createAmiVoiceRelayServer`: control via `RemoteShellProxy` + audio → `feedAudio`, session table) with an opt-in `transport: "direct"` mint route (`ipa` bound to the peer, graceful degradation).
- Browser-direct path (`src/components/realtimeSocket.ts`: `DirectBrowserProvider` + `openDirectRealtimeSession`) — the browser opens the AmiVoice WSS itself with a server-minted one-time key; audio bypasses the server.
- Runnable single-port example (`examples/relayServer.mjs`) + a real-browser Playwright harness proving mic capture → interim → finalized transcript against a fake AmiVoice WSS, in BOTH transports.

What does **not** exist yet: a real AmiVoice WSS run (needs a paid APPKEY; gated behind `AMIVOICE_APPKEY`) and the user-driven release (version bump + `npm publish`).

## Guiding principles

1. **Ship relay first.** Relay is the default and keeps Core authority strongest ([ADR 0006](adr/0006-transport-baseline-after-one-time-appkey.md)). Browser-direct is phase 2.
2. **Decisions before code.** A task gated by an open question (Q*) does not start until that question is locked (see Decision gates).
3. **Shared surface.** The bindable contract (SPEC §7) does not change across phases or transports; new work goes behind config/helpers.
4. **Each phase ends runnable and tested**, not half-wired.

## Phases at a glance

| Phase | Goal | Exit criteria | Status |
|---|---|---|---|
| 0 | Scaffold + relay unit impl | build clean, unit tests green | ✅ done |
| 1 | Relay works end-to-end in a real browser | `<ami-voice>` transcribes against a fake AmiVoice WSS in Playwright; runnable server example; user README | ✅ done — Node e2e + example + README + **real-browser Playwright run** all green |
| 2 | Browser-direct mode (opt-in) | `transport="direct"` recognizes via one-time APPKEY; relay unchanged | ✅ done — Node + real-browser Playwright green; relay path unchanged |
| 3 | Hardening + release | reconnect/diarization/codec/security decided; coverage; publishable | ✅ hardening done (reconnect, `speakers`/ADR 0007, codec rejection, security profile, logging, coverage); release = user-driven version bump + publish |

---

## Phase 1 — Relay end-to-end

Make the relay path actually recognize speech, observable in a real browser, with a runnable server.

- [x] **1.1 Runnable server example** — `examples/relayServer.mjs` hosts the control WS (`WebSocketServerTransport` → `handleControlConnection`) and the binary audio WS (→ `handleAudioConnection`), placeholder auth, fake-or-real AmiVoice. `ws` added as a devDependency. `npm run example` boots and listens. Refs: Q11, ADR 0002/0003 §14.
- [x] **1.2 Fake AmiVoice WSS** — `tests/support/fakeAmiVoice.ts`: acks `s`/`e`, replays a canned `U` after the first audio frame and an `A` on `e`. Drives the example + the integration test. Refs: D1.
- [x] **1.3 Integration harness** — **both layers done + green.** (a) Node full-stack (`tests/integration/relay.e2e.test.ts`, `test:integration`): real `ws` sockets, client proxy ↔ relay ↔ fake AmiVoice, asserts `interim` then `transcript` propagate + unknown-token rejection. (b) **Real-browser Playwright** (`tests/browser/relay.browser.spec.ts`, `test:e2e`): system Chrome with `--use-fake-device-for-media-stream`, a single-port harness (`tests/browser/harnessServer.mjs`: HTTP static + control/audio WS routed by `Sec-WebSocket-Protocol` + fake AmiVoice) serving `tests/browser/index.html`; drives the real mic data plane (`getUserMedia` → `AudioWorklet` → PCM) and asserts `connected`/`recognizing`/`interim`/`transcript` in the DOM. Surfaced + fixed a SPEC §11.3 violation (`openAudioChannel` carried the session token in the query string instead of `Sec-WebSocket-Protocol`) and aligned the example to single-port routing. Refs: Q14, Q1.
- [x] **1.4 `level` throttle** — `createRateLimiter(100)` in the Shell gates `ami-voice:level-changed`; pure helper unit-tested. Refs: Q5.
- [x] **1.5 Audio back-pressure** — `shouldSendFrame(bufferedAmount, cap)` (1 MiB default) drops frames under pressure in `_sendAudioRemote`; pure helper unit-tested. Refs: Q10.
- [x] **1.6 Shell `stop()` graceful wait** — the Shell stops capture + closes the audio channel immediately, then awaits the Core/provider graceful stop (which settles on the `e` ack). Refs: Q4/D1.
- [x] **1.7 User-facing `README.md`** — quickstart (remote relay), server snippet, `O(audio volume)` cost note, security checklist. Refs: SPEC §20/§14.
- [x] **1.8 Error surfacing** — `getErrorCode(error)` returns the normalized `code`. Originally local-only (`undefined` for a remote-decoded error); since the `@wc-bindable/remote` 0.10 upgrade the Core publishes `error` as a JSON-safe `{ name, message, code?, resultCode?, retryable? }` object — identical locally and over the wire, because 0.10 drops a non-`JsonValue` (`Error` instance) property value — so `getErrorCode` works in every mode. Tested (incl. through the real 0.10 proxies). Refs: Q7, SPEC §17.

**Phase 1 — done.** A developer can `npm run example`, open a page, click start, speak (or feed the fake), and see live transcript — with a README that explains the deployment. The relay loop is proven end-to-end in both Node (`test:integration`) and a real browser (`test:e2e`). Next: **Phase 2 — browser-direct mode** (the `issueOneTimeAppKey` seam already exists).

---

## Phase 2 — Browser-direct mode (ADR 0006, opt-in)

Add the single-channel, `O(connections)` path enabled by the one-time APPKEY. Relay stays the default and untouched. **Phase 2 complete.**

- [x] **2.1 Token-request control op** (decision, LOCKED) — folded into `start()` when `transport="direct"` (no new command, so the recognition surface stays byte-identical — ADR 0006 rule 1). The direct `start()` `invoke` result is `DirectSessionInfo = { endpoint, sCommand }` instead of relay's session-token string; the direct branch lives in three layers: `AmiVoiceProvider.prepareDirectSession` (mint + build `s` + endpoint), `AmiVoiceCore` `transport: "direct"` (mints, opens no upstream, rejects on failure), Shell `DirectBrowserProvider`. Refs: ADR 0006.
- [x] **2.2 Server mint endpoint** (`createAmiVoiceServer.ts`) — `createAmiVoiceRelayServer({ transport: "direct" })`; `handleControlConnection(transport, { peerAddress })` binds the one-time key's `ipa` to the peer. Refs: ADR 0006, Q12.
- [x] **2.3 Shell direct path** — `src/components/realtimeSocket.ts`: `openDirectRealtimeSession` + `DirectBrowserProvider` open the AmiVoice WSS directly, reusing the **shared** `runRealtimeSession` (extracted from the provider so relay + direct share one event/result path — ADR 0006 rule 3). The in-page Core owns recognition state in direct mode (like local). No server audio channel. Refs: ADR 0006, SPEC §11.4.
- [x] **2.4 `transport` selector wiring** — `transport` config (`remote.transport`) + `transport="relay" | "direct"` attribute + internal mode resolution; **not** a wcBindable input/property (contract test guards it). Refs: ADR 0006 follow-up rule 1.
- [x] **2.5 ipa graceful degradation** — no peer address → no `ipa` + a shorter `epi` (`epiWithoutIpa`, default 10 s). Refs: ADR 0006 negative, Q12.
- [x] **2.6 Direct-mode tests + integration** — unit (`prepareDirectSession`, direct socket, Core direct, server direct, contract guard), Node full-stack (`tests/integration/direct.e2e.test.ts`: mint over control → browser opens fake WSS direct → interim/transcript, server opens 0 upstreams), and a Playwright direct run (`tests/browser/direct.browser.spec.ts` + `/direct` harness route). Refs: Q14.

**Phase 2 done:** `transport="direct"` recognizes end-to-end with audio bypassing the server, the permanent APPKEY never leaving it, the recognition surface byte-identical, and the relay path unchanged (all prior tests green).

---

## Phase 3 — Hardening & release

- [x] **3.1 Upstream reconnect policy** (M) — v1 choice implemented: an unsolicited upstream close → `error` (`upstream`) + `connected=false`; finalized `transcript`/`segments`/`confidence` preserved; explicit `start()` to resume (no auto-reconnect). `runRealtimeSession` distinguishes intentional teardown (stop/abort/lost-`e`-ack fallback) from a drop. SPEC §10.1; tested (`__tests__/realtimeSession.test.ts`). Refs: Q3.
- [x] **3.2 Diarization surfacing** (S–M) — product input arrived: surface a **derived, final-only `speakers` property** (one labeled turn per finalized segment), resolving Q6 toward option (b). New [ADR 0007](adr/0007-diarization-speaker-view.md); `src/speakerView.ts`; SPEC §7.1/§8; contract test updated; tested. (`language` stays on tokens.)
- [x] **3.3 Codec scope** (gated → documented non-support) — telephony not in scope (Q9), so `8K`/`MULAW`/`ALAW` are **not** added. The non-gated correctness part **is** done: the Shell now **rejects** a `codec` it cannot encode (`canEncodeCodec`; v1 = `LSB16K`) on `start()` rather than silently streaming `LSB16K`. SPEC §13; tested.
- [x] **3.4 Deployment security profile** (M) — auth-before-shell, per-command authz, audio token via `Sec-WebSocket-Protocol`, rate/resource limits, direct-mode mint validation, observability documented in SPEC §14 + README; the example's `TODO(auth)` is promoted to an `authenticatePeer`/`authorize` seam. Refs: SPEC §14, ADR 0002.
- [x] **3.5 Structured logging** (S) — injectable `logger` on `createAmiVoiceRelayServer` (control open/close, rejected audio frames, emitted Core errors as normalized `code` + message; never the APPKEY/token/payloads). Tested. Refs: implementation-notes B/Q11.
- [~] **3.6 Coverage + release prep** (M) — coverage gate done (`npm run test:coverage`, thresholds over the portable logic layer); README/SPEC/CLAUDE status synced. **Remaining (user-driven):** confirm + bump version, then publish via the [release skill](../.claude/skills/release/SKILL.md) (`@wc-bindable/*` are `^0.10.0`, no `file:`). `npm publish` is manual.

**Phase 3 done when:** the package is production-deployable and `0.x` publishable. Code/docs/coverage are in place; the version bump + publish are the user's manual release step.

---

## Critical path & dependencies

```
1.1 server example ─┐
1.2 fake AmiVoice WSS ─┴─> 1.3 integration harness ──> (Phase 1 exit)
1.4 level / 1.5 backpressure / 1.6 stop / 1.7 README / 1.8 errors  (parallel within P1)

Phase 1 exit ──> 2.1 token-op decision ──> 2.2 mint ──> 2.3 direct Shell ──> 2.6 direct tests ──> (Phase 2 exit)
                                                         2.4 selector / 2.5 ipa (parallel)

Phase 2 (or 1) ──> Phase 3 (3.x mostly independent; 3.6 last)
```

The integration harness (1.3) is the spine of Phase 1 and a prerequisite for trusting Phases 2–3; build 1.1 + 1.2 first.

## Decision gates (lock before the task starts)

| Gate | Question/ADR | Lean already recorded |
|---|---|---|
| before 1.4 | Q5 `level` cadence | rAF / ~100 ms |
| before 1.5 | Q10 back-pressure | drop-oldest on `bufferedAmount` |
| before 1.8 | Q7 error exposure | normalized `code` internal; `{name,message}` on wire |
| before 2.1 | ADR 0006 token-op shape | **LOCKED** — fold into `start()`; direct returns `DirectSessionInfo` |
| before 2.5 | Q12 `ipa` strategy | degrade gracefully when address unknown (implemented) |
| before 3.1 | Q3 upstream reconnect | **RESOLVED** — explicit restart; finalized `transcript` preserved (SPEC §10.1, implemented) |
| before 3.2 | Q6 diarization | **RESOLVED** — surface a derived final-only `speakers` view ([ADR 0007](adr/0007-diarization-speaker-view.md), implemented) |
| before 3.3 | Q9 codecs | **RESOLVED (deferred)** — telephony out of scope; v1 `LSB16K` only, Shell rejects others (implemented) |

## Risks

- **Real AmiVoice testing needs a paid APPKEY** — gate real-endpoint tests behind an env var; the fake WSS (1.2) is the default CI path.
- **`ws` is the integrator's dependency** — keep it out of the package runtime deps (server helper takes injected sockets); it is only a devDep for the example/harness.
- **Browser-direct erodes Core decision authority** (ADR 0006 negative) — document plainly; offer server-side `s`-param validation as a future ADR if needed.
- **AudioWorklet cross-browser quirks** — the integration harness must run on at least Chromium; note Safari/Firefox differences as found.

## Out of scope for v1

Browser audio bypass in *relay* mode, ADPCM, on-device recognition, TTS/two-way audio, speaker-identity UI beyond token `label` (SPEC §22).
