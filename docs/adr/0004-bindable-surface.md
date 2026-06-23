# ADR 0004: Bindable surface shape

## Status

Accepted (design intent)

Date: 2026-06-23

## Context

The package exposes recognition state to frameworks through wc-bindable-protocol. The shape of that surface — which tag owns authority, how many tags there are, and how recognition results are decomposed into properties — is a public contract: once shipped, changing property/command names is a breaking change ([release skill](../../.claude/skills/release/SKILL.md)).

AmiVoice real-time recognition produces two qualitatively different result streams:

- **Interim hypotheses** (`U` events) — the current best guess for the segment being spoken, revised continuously, not final.
- **Finalized results** (`A` events) — accepted text for a completed segment: the full result JSON with segment-level `confidence` / `starttime` / `endtime` / `utteranceid` and per-token `written` / `spoken` / `confidence` / `starttime` / `endtime`. Note that segment-level `confidence` is a **final-only** signal — the `U` interim payload carries only `text` + `tokens`, so the bindable `confidence` property updates on `A`, not on `U`.

UIs almost always render these differently (finalized text solid, interim text greyed/italic). There is also browser-only UI state — an input **level** for a mic meter — that originates in the Shell's capture path, not in any recognition decision.

The family has a settled pattern from `lambda`: a single authority-bearing parent tag, with optional **projection-only** child tags that render a specialized slice of the parent's state but own no inputs or commands.

## Decision

1. **One authority-bearing parent tag, `<ami-voice>`**, is the single source of truth. All inputs and commands live on it (and on the Core behind it).
2. **`transcript` and `interim` are separate properties.** `transcript` is the accumulated finalized text (from `A`); `interim` is the current in-progress hypothesis (from `U`). They are never merged into one property.
3. **`segments` carries the structured history** (text + confidence + token timings) so consumers never have to re-parse `transcript`.
4. **`level` is Shell-projected UI state**, explicitly documented as originating in the data plane rather than as a recognition decision.
5. **Any child tags are projection-only.** They may render a slice of parent state (e.g. finalized segments, or the mic level) but must not declare inputs or commands. Inputs/commands stay parent-owned.

The intended surface:

| Kind | Names |
|---|---|
| properties | `recognizing`, `connected`, `transcript`, `interim`, `segments`, `speakers`, `confidence`, `level`, `loading`, `error`, `mode` |
| inputs | `engine` / `grammarFileNames`, `codec`, `profileId`, `profileWords`, `keepFillerToken`, `resultUpdatedInterval`, `segmenterProperties`, `noLog` |
| commands | `start` (async), `stop`, `abort` / `reset` |

(`remoteUrl` is a deployment **attribute** (`remote-url`), not a wcBindable input — see SPEC §7.2 and `CORE_INPUT_NAMES`.)

(`speakers` was added later by [ADR 0007](0007-diarization-speaker-view.md) as a derived, final-only projection of `segments`; it is listed here to keep this table in sync with CLAUDE.md §3 per follow-up rule 5.)

Command notes:

- `start` is async and **returns / establishes a session id**. The separate binary audio WebSocket ([ADR 0003](0003-realtime-audio-transport.md)) authenticates and binds to that id, so the server routes its frames into the correct AmiVoice session; the JSON control channel and the binary audio channel are correlated by this id, and the server rejects audio frames that do not map to a live session.
- `stop` and `abort` are **load-bearing, not conveniences.** `start` is a long-running streaming command, and over `@wc-bindable/remote` the `AckOptions.signal` / `timeoutMs` controls are client-local — they settle the caller's Promise but send no producer-side cancellation. Only an explicit `stop` / `abort` command actually tells the Core to flush (`e`) or tear down the AmiVoice session and release the paired audio channel. This is why cancellation is modeled as commands, not as signal-based abort (see [ADR 0003](0003-realtime-audio-transport.md) Rationale §5).
- `stop` is **graceful** (stop capture, send `e`, await the final `A` result, then settle); `abort` / `reset` is **immediate** (drop the AmiVoice session, the audio channel, and the mic at once, with no final result). Keeping both lets a UI distinguish "finish the sentence" from "kill it now".

## Rationale

### 1. Separating `transcript` from `interim` matches how results are consumed

Merging them would force every consumer to re-derive "which part is final" on every update — and interim text is volatile, so a merged property would thrash the finalized text consumers actually want to keep. Two properties let a binder render each with the right treatment and let finalized text accumulate stably.

### 2. A single authority parent keeps policy and security undivided

If multiple top-level tags each carried inputs/commands, authorization policy and session lifecycle would drift across them — the exact failure `lambda` ADR 0001 rejected. One parent means one place that owns engine/grammar, profile words, and the start/stop lifecycle.

### 3. Projection-only children keep transport and authority out of the leaf tags

A child that only renders state cannot accidentally become a second authority or leak transport detail. This preserves the [ADR 0003](0003-realtime-audio-transport.md) guarantee that transport stays invisible to the public contract.

### 4. Labeling `level` as Shell-projected prevents a category error

`level` is the one property that does not come from a recognition decision; it is computed in the browser capture path. Calling that out stops a maintainer from "moving level into the Core for consistency" — which would be impossible, since the Core (in relay mode) sees frames but is not the natural owner of a UI meter value, and in a future direct mode would not see frames at all ([ADR 0005](0005-audio-capture-and-codec-ownership.md)).

### 5. `error` is a signal, not a state transition

Consistent with the family convention, `error` dispatches as `ami-voice:error` (no `-changed` suffix) while every other property dispatches `ami-voice:<name>-changed`.

## Alternatives considered

### Alternative A: a single `transcript` property that includes interim text inline

- Pros: one property to bind; "just show transcript."
- Cons: forces consumers to re-segment final vs. interim; interim volatility thrashes the value; loses the most common UI distinction. Rejected.

### Alternative B: separate authority-bearing tags per concern (`<ami-voice-mic>`, `<ami-voice-result>`)

- Pros: each tag looks operationally explicit.
- Cons: duplicates authority and session policy across tags; leaks recognition taxonomy into the component model; the same anti-pattern `lambda` ADR 0001 rejected. Rejected; standardize on parent authority + projection children.

### Alternative C: emit raw AmiVoice event objects as a single `event` property

- Pros: maximally faithful to the wire.
- Cons: pushes parsing and normalization to the consumer, violating the Core-authority invariant ([ADR 0001](0001-csbc-case-classification.md)); ties the public surface to AmiVoice's wire format. Rejected; the Core normalizes into `transcript` / `interim` / `segments`.

## Consequences

### Positive

- Binders can render finalized vs. interim text correctly with no client-side re-segmentation.
- One authority tag keeps policy and security in one place.
- The surface is transport-independent, so [ADR 0003](0003-realtime-audio-transport.md)'s future direct-stream path needs no contract change.
- `segments` gives structured access without re-parsing.

### Negative

- More properties to document and keep stable; each is now part of the breaking-change surface.
- The `transcript` / `interim` split asks consumers who only want "the text" to know which one to read (mitigated by docs leading with `transcript`).
- `level` being Shell-only is a small special case that has to be explained.

## Follow-up rules

1. `<ami-voice>` remains the sole authority-bearing tag; any child tag is projection-only (no inputs, no commands).
2. `transcript` and `interim` stay separate; do not merge them in a "simplification" pass.
3. Renaming any property/input/command, or changing the `error`-as-signal convention, is a breaking change and goes through the release skill.
4. The Core normalizes AmiVoice events into the bindable surface; raw wire objects are not exposed as public state.
5. This ADR and the "Intended bindable surface" table in [../../CLAUDE.md](../../CLAUDE.md) §3 must stay in sync.
