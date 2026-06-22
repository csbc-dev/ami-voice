# ADR 0006: Dual-mode realtime transport (relay default + browser-direct opt-in)

## Status

Accepted (design intent)

Date: 2026-06-23

Amends [ADR 0003](0003-realtime-audio-transport.md) (does not supersede): ADR 0003's two-channel relay remains the **default and the v1 implementation baseline**; this ADR adds browser-direct as a second, opt-in mode now that its blocking dependency is confirmed, and pins the server-helper shape both modes need.

## Context

[ADR 0003](0003-realtime-audio-transport.md) chose the two-channel relay as the baseline and rejected browser-direct (Alternative A) for **one** reason: it depended on an AmiVoice short-lived-credential mechanism that was unconfirmed.

That dependency is now **confirmed** (implementation-notes Q12 / D3). AmiVoice issues **one-time APPKEYs**: `POST https://acp-api.amivoice.com/issue_service_authorization` returns a short-lived service-authorization string with an expiry (`epi`, default 30 s — the window to *open* the connection, not the session length) and an optional source-IP restriction (`ipa`). The server mints it from a service id/password (or an "APPKEY発行可能" APPKEY) and never ships the permanent APPKEY.

So browser-direct is now genuinely viable. The two modes trade off differently:

| | Relay (ADR 0003) | Browser-direct (now unblocked) |
|---|---|---|
| Channels | 2 (JSON control + binary audio) | 1 (browser ↔ AmiVoice) + a mint step |
| Audio path | browser → server → AmiVoice | browser → AmiVoice |
| Server cost | `O(audio volume)` | `O(connections)` |
| Credential in browser | none | 30 s, IP-restricted one-time APPKEY |
| Core *decision* authority | strongest (Core sends `s`, parses events) | advisory (browser sends `s`, parses events) |
| Symmetry | unlike s3-uploader | like s3-uploader (data plane bypasses server) |

This is not a "one is strictly better" choice — it is a deployment trade between server cost and Core authority. The package should not force it.

## Decision

The package supports **both modes behind one identical bindable surface**, selected by deployment config, with **relay as the default**:

1. **`transport` selector.** A `transport` option (config + `transport="relay" | "direct"` attribute), default `"relay"`. It is deployment configuration, **not** a new bindable property/input/command — the recognition surface (`transcript` / `interim` / `segments` / `start` / `stop` / …) is byte-for-byte identical across modes ([ADR 0004](0004-bindable-surface.md) surface is unchanged).
2. **Relay mode (default, v1).** Exactly ADR 0003: JSON control channel + separate binary audio channel; the server-side Core holds the permanent APPKEY and owns `s`/event handling.
3. **Direct mode (opt-in, phase 2).** On `start()`, the server mints a one-time APPKEY (with `ipa` = the client's address where determinable, short `epi`) plus the **approved `s`-command parameters**, and returns both over the control channel. The browser opens the AmiVoice WSS directly, sends the approved `s`, streams audio directly, and parses events locally. The permanent APPKEY never leaves the server.
4. **Ship order.** Relay is implemented first (it matches the current scaffold and keeps authority strongest). Direct is a fast-follow; the provider exposes the mint primitive (`issueOneTimeAppKey`) from day one so the seam exists.

### Server helper shape (resolves Q11 / Q1 / Q2 / Q3)

One server helper owns the session/auth state both modes need, modeled on auth0's `createAuthenticatedWSS` (attach to an existing `http.Server`, no bundled WS library):

- **Control endpoint.** One `AmiVoiceCore` + APPKEY-bearing `AmiVoiceProvider` per authenticated control connection, exposed via `@wc-bindable/remote`'s `RemoteShellProxy`. Auth is enforced **before** the shell handler sees any message ([ADR 0002](0002-appkey-residency-and-remote-first.md), SPEC §14).
- **Session id (Q2).** On `invoke("start")` the server mints an **opaque high-entropy token**, stored against the authenticated control connection. Relay: the audio channel presents it; direct: it is unused (the one-time APPKEY is the credential instead).
- **Audio channel (Q1).** Relay only. The helper exposes a `handleAudioConnection(socket, token)` the integrator calls from their WS server (so the package does not bundle `ws`). The token is carried in `Sec-WebSocket-Protocol` (not the query string — query strings land in logs). The server validates the token by lookup against the live, same-peer control session and routes each binary frame to `core.feedAudio(bytes)`. Frames with no live session are rejected.
- **Mint (direct).** `issueOneTimeAppKey({ ipa?, epi? })` wraps `issue_service_authorization`; the control handler returns the token + approved `s`-params as the `start()` result in direct mode.
- **Upstream drop (Q3).** If the AmiVoice WSS drops mid-session, the Core surfaces `error` + `connected=false` and requires an explicit `start()` to resume (v1); finalized text already in `transcript` is never dropped. Auto-reconnect is a later enhancement.

## Rationale

1. **The confirmed dependency makes "never" the wrong answer.** ADR 0003 deferred direct only because the credential was unconfirmed. Keeping it deferred after confirmation would leave real server-cost savings on the table for cost-sensitive deployments.
2. **One surface, two transports keeps the contract stable.** Making `transport` deployment config (not bindable surface) means a consumer's `<ami-voice>` code is identical whether the operator runs relay or direct — exactly the transport-independence ADR 0003 §rationale-3 and ADR 0004 were protecting.
3. **Relay-default preserves the strongest-authority, lowest-risk path as the one you get by accident.** Secure/authoritative by default ([ADR 0002](0002-appkey-residency-and-remote-first.md) philosophy); direct is a deliberate opt-in for operators who accept advisory Core authority in exchange for cost.
4. **One helper, one session table** avoids splitting auth/correlation logic across two components — the failure mode Q1/Q2 warned about.

## Alternatives considered

### Alternative A: keep relay only; document direct but don't build the seam

- Pros: least code; maximal authority.
- Cons: re-litigates the choice later from scratch; leaves cost-sensitive operators unserved; the mint primitive is trivial to expose now. Rejected — the user chose dual-mode.

### Alternative B: flip to browser-direct as the sole baseline (supersede ADR 0003)

- Pros: simplest topology; `O(connections)`; s3 symmetry.
- Cons: erodes Core *decision* authority for everyone (browser sends `s`); discards the working relay scaffold; makes the secure-authoritative path opt-in rather than default. Rejected as the *sole* baseline; kept as the opt-in mode.

### Alternative C: expose `transport` as a bindable input

- Pros: per-element switchable at runtime.
- Cons: transport is a deployment/trust decision, not application state; putting it on the wire invites a client to flip its own server's topology. Rejected — `transport` is config/attribute, never a wcBindable input.

## Consequences

### Positive

- Operators choose cost vs authority without any change to consumer `<ami-voice>` code.
- The permanent APPKEY stays server-side in both modes.
- Relay (authoritative, lower-risk) is the default; the scaffold already targets it.
- The mint primitive seeds direct mode without committing to its full implementation now.

### Negative

- Two transport paths to implement, test, and document (~2× transport surface) — mitigated by shipping relay first and sharing the bindable surface, normalization, and error mapping.
- Direct mode's Core authority is advisory; the SPEC must state plainly that in direct mode the browser can deviate from the Core's approved `s`-params unless the deployment validates server-side.
- `ipa` restriction needs the client's address, which is awkward behind NAT/proxies; direct mode must degrade gracefully (shorter `epi`, no `ipa`) when the address is unknown.

## Follow-up rules

1. The recognition bindable surface MUST stay identical across `transport` modes; `transport` MUST NOT become a wcBindable input/property/command.
2. The permanent APPKEY MUST NOT leave the server in either mode; direct mode uses only a short-lived `issue_service_authorization` token.
3. Relay ships first; direct mode MUST reuse the same Core normalization and error mapping (no parallel result code paths).
4. A future auto-reconnect (Q3) MUST NOT drop finalized `transcript` text already delivered.
5. If direct mode is later found to need server-side `s`-param enforcement, that is a new ADR, not a silent change.
