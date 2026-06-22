# ADR 0001: Where `@csbc-dev/ami-voice` sits in CSBC

## Status

Accepted (design intent)

Date: 2026-06-23

## Context

`@csbc-dev/ami-voice` is a re-packaged member of the `csbc-dev/arch` family. Every package in the family must declare which of the four canonical CSBC cases it occupies, because that classification drives where the Core lives, what the Shell is allowed to do, and how the wire boundary is shaped (see [../../CLAUDE.md](../../CLAUDE.md) §2).

AmiVoice is Advanced Media's Japanese cloud speech-recognition service. It exposes two surfaces this package targets:

- **Real-time recognition** over WebSocket: live audio frames in, interim (`U`) and finalized (`A`) results out, as the speaker talks.
- **File recognition** over HTTP: a synchronous endpoint and an asynchronous job endpoint that recognize a complete audio file.

These two surfaces have different data-plane shapes:

- Real-time recognition needs a **microphone capture path** — `getUserMedia` requires a user gesture, and capture / downsampling / framing run in an `AudioWorklet`. None of that can run anywhere except the browser.
- File recognition needs only a `File` / `Blob` handed to a recognizer that calls AmiVoice over HTTP. There is no browser-pinned data plane; the work is control-plane.

Every surface authenticates with an **APPKEY**, which is a credential that must not reach the browser (the credential decision itself is [ADR 0002](0002-appkey-residency-and-remote-first.md)).

A package may legitimately occupy more than one case across its modes — `@csbc-dev/auth0` straddles A and B1. The question is which case each mode of `ami-voice` belongs to.

## Decision

`@csbc-dev/ami-voice` **straddles Case C and Case B1**, by mode:

1. **Real-time recognition is Case C.** The microphone data plane is browser-pinned, so the Shell runs a browser-only data plane while all decisions and the APPKEY live in the server-side Core.
2. **File recognition is Case B1.** It is control-plane work; the Core performs the HTTP recognition and the Shell is a thin command surface.

This straddle is recorded as the package's canonical classification. It is **not** modeled as pure Case C for both modes, and it is **not** modeled as a single case forced onto both modes.

## Rationale

### 1. The data-plane test decides the case, per mode

CSBC's Case C is defined by the existence of a data plane that *can only* run in the browser. Microphone capture meets that test exactly; file recognition does not. Classifying each mode by the data-plane test — rather than picking one case for the whole package — keeps the classification honest.

### 2. It matches an existing family precedent

`@csbc-dev/auth0` already establishes that a package can straddle two cases across its modes without being incoherent. Re-using that precedent keeps the family's mental model uniform.

### 3. It keeps the Core authoritative in both modes

In both classifications the Core owns every recognition decision (engine/grammar selection, profile words, codec policy, connection lifecycle, result normalization) and holds the APPKEY. The Shell never gains decision authority, only — in real-time mode — the undelegatable capture work. This preserves the family invariant: *the Core owns every decision; the Shell only does what cannot be delegated.*

## Alternatives considered

### Alternative A: classify the whole package as Case C

Treat file recognition as "just another browser data plane."

- Pros: one label for the whole package; conceptually simpler index entry.
- Cons: dishonest — file recognition has no browser-pinned data plane, so calling it Case C invites a fat browser Shell that does HTTP recognition with the APPKEY in-browser, which violates [ADR 0002](0002-appkey-residency-and-remote-first.md). Rejected.

### Alternative B: classify the whole package as Case B1 and relay microphone audio as opaque control-plane messages

Pretend there is no browser data plane and treat mic frames as ordinary command payloads.

- Pros: one label; matches the relay transport chosen in [ADR 0003](0003-realtime-audio-transport.md).
- Cons: hides the fact that capture is genuinely browser-pinned and that the Shell is necessarily "fat" in real-time mode. Mislabeling it B1 would make future maintainers treat the capture path as optional or relocatable, which it is not. Rejected.

### Alternative C: split into two packages (`ami-voice-realtime` and `ami-voice-file`)

- Pros: each package gets one clean case.
- Cons: duplicates configuration, provider wiring, and the bindable surface across two packages for one logical capability; diverges from the family's one-package-per-capability shape. Rejected; a single package with two modes is the family norm.

## Consequences

### Positive

- The classification is accurate per mode, so downstream ADRs can reason about each mode without contradiction.
- The Core stays the single authority in both modes.
- The package fits the family's existing straddle precedent, so the index and CLAUDE.md read consistently.

### Negative

- Contributors must hold two cases in mind for one package; documentation has to keep reminding which mode is which.
- The real-time Shell is unavoidably "fat" (it runs capture), which can look like a CSBC smell to someone who has only seen thin-Shell cases. ADR 0003 and ADR 0005 exist partly to make that fatness legible and bounded.

## Follow-up rules

1. Any new mode added later must declare its CSBC case by the data-plane test, not by analogy.
2. No mode may move recognition decisions or the APPKEY into a Shell, regardless of case.
3. CLAUDE.md §3 ("Where AmiVoice fits in CSBC") and this ADR must stay in sync; changing one requires changing the other.
