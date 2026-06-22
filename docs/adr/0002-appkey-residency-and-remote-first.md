# ADR 0002: APPKEY residency and remote-first default mode

## Status

Accepted (design intent)

Date: 2026-06-23

## Context

Every AmiVoice surface — real-time WebSocket and HTTP file recognition — authenticates with an **APPKEY**. In the real-time protocol the APPKEY is passed as `authorization=<APPKEY>` inside the `s` (start) command; in the HTTP forms it is the `Authorization` field. The APPKEY is a long-lived credential: anyone holding it can run recognition billed to the account.

The package's primary data plane (real-time recognition) is browser-pinned ([ADR 0001](0001-csbc-case-classification.md)). A naive implementation would let the browser open the AmiVoice WebSocket directly and put the APPKEY in the `s` command — which would ship the credential to every client.

The family already has a strong precedent for this class of problem: `@csbc-dev/s3-uploader` keeps AWS credentials server-side and never lets them reach the browser, signing requests in the Core. `@csbc-dev/auth0` keeps the access token out of application JS in remote mode. We need the equivalent rule for the APPKEY, and we need a default mode that enforces it rather than relying on the integrator to opt in.

## Decision

1. **The APPKEY lives only in the Core / provider**, read from the environment (`AMIVOICE_APPKEY`). It is never placed in `wcBindable` inputs, never crosses the wire to the browser, and never logged.
2. **The default mode is remote-first.** Out of the box, `<ami-voice>` proxies to a server-side Core via `@wc-bindable/remote`; the Core holds the APPKEY and talks to AmiVoice. A browser-local Core that embeds the APPKEY is not the default and is not offered as a supported production path.
3. A browser-direct connection to AmiVoice is permitted **only** with a short-lived / one-time credential minted server-side, never with the permanent APPKEY (this transport question is decided in [ADR 0003](0003-realtime-audio-transport.md)).

## Rationale

### 1. Credentials must not be shipped to untrusted runtimes

The browser is an untrusted runtime. A long-lived APPKEY embedded in client code is extractable by any user and cannot be rotated per-session. Keeping it in the Core is the only way to retain rotation, revocation, and per-tenant scoping.

### 2. Secure-by-default beats secure-if-configured

If the safe path were opt-in, the first thing an integrator copies from a quickstart would likely be the simplest (APPKEY-in-browser) variant, and it would reach production. Making remote-first the default means the easy path is also the safe path. This mirrors `s3-uploader`, where the only documented production shape keeps credentials server-side.

### 3. It keeps policy where the authority already is

Engine/grammar selection, profile-word registration, and per-tenant scoping are Core decisions ([ADR 0001](0001-csbc-case-classification.md)). Co-locating the APPKEY with those decisions means authorization policy and the credential live in one place, instead of splitting trust across the wire.

## Alternatives considered

### Alternative A: browser-local Core with APPKEY supplied as an attribute/input

e.g. `<ami-voice app-key="...">` running the Core in the browser.

- Pros: zero server component; trivial to demo.
- Cons: ships a long-lived credential to every client; no rotation; no per-session scoping; trivially extractable. Unacceptable for production. Rejected as a supported mode. (May exist only as a clearly-labeled local development convenience, never the default, and never in a quickstart's primary snippet.)

### Alternative B: browser-direct connection using a one-time APPKEY minted by the server

The server mints a short-lived credential; the browser connects to AmiVoice directly with it.

- Pros: keeps the permanent APPKEY server-side *and* avoids relaying audio bytes through the server.
- Cons: depends on AmiVoice actually offering a short-lived / one-time credential mechanism for the real-time endpoint; if it does not, this path is impossible. This is a transport optimization, decided separately in [ADR 0003](0003-realtime-audio-transport.md) — not the residency decision. Not rejected, but deferred and conditional.

### Alternative C: remote-first default, APPKEY server-only (chosen)

- Pros: secure by default; matches family precedent; one place for credential + policy.
- Cons: requires a server component to run at all; pure-static-site deployment is not supported for real-time mode. Accepted — the cost is inherent to keeping the credential safe.

## Consequences

### Positive

- The APPKEY is never extractable from the browser.
- The default integration path is the safe one.
- Credential and authorization policy are co-located in the Core.
- Consistent with `s3-uploader` / `auth0` credential discipline, so the family reads uniformly.

### Negative

- A server-side Core is mandatory for real-time mode; there is no zero-backend deployment.
- Remote-first means the real-time data plane's transport must be decided ([ADR 0003](0003-realtime-audio-transport.md)), and the default (relay) has a server-cost consequence.
- Quickstarts must lead with the remote setup, which is heavier than an APPKEY-in-HTML snippet would be.

## Follow-up rules

1. The APPKEY must never appear in `wcBindable` inputs, in any attribute on `<ami-voice>`, in client bundles, or in logs.
2. Any code path or example that puts the permanent APPKEY in the browser is a defect, not a convenience — flag it in review.
3. If a browser-local development mode is ever added, it must be gated, labeled non-production, and excluded from the primary quickstart snippet.
4. The release skill's local-path / secret checks must never allow an APPKEY to be committed or packed.
