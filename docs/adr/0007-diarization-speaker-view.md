# ADR 0007: Surface speaker diarization as a derived `speakers` property

## Status

Accepted (design intent)

Date: 2026-06-23

Extends [ADR 0004](0004-bindable-surface.md) (does not supersede): ADR 0004's single-authority parent and `transcript`/`interim` split are unchanged; this ADR adds **one** derived, final-only property to the surface. Resolves implementation-notes **Q6** by choosing option (b) over the previously-recorded lean (a).

## Context

AmiVoice can label recognized tokens by speaker. With `segmenterProperties="useDiarizer=1"`, each token in an `A` (finalized) result carries a `label` (speaker id); multilingual engines additionally carry a token `language`. The result model already keeps both as optional fields on `RecognitionToken` ([SPEC §8](../../SPEC.md)), but the **bindable surface** exposed no speaker-level view — a consumer wanting "who said what" had to walk `segments[].tokens[].label` itself.

implementation-notes Q6 weighed three options and leaned (a) "leave `label`/`language` on tokens only, no new top-level property" pending product input. Product input has now arrived: a **speaker view is in scope** for v1. So Q6 is resolved toward surfacing it.

The constraint is ADR 0004: the surface is a public contract, `<ami-voice>` stays the sole authority, and any addition must be transport-independent (byte-identical across relay/direct — [ADR 0006](0006-transport-baseline-after-one-time-appkey.md)) and JSON-safe (it crosses the `@wc-bindable/remote` wire).

## Decision

1. **Add one derived property, `speakers: SpeakerSegment[]`**, to the Core (and forwarded by the Shell like every other Core property). It is **final-only** — it updates on `A`, never on `U` — exactly like `confidence` and `segments`.
2. **`speakers` is a projection of `segments`, one entry per finalized segment**, in the same order. Each `SpeakerSegment` is `{ label, text, starttime, endtime, confidence }`, where `label` is the segment's speaker id (the first token carrying a non-empty `label`, or `""` when not diarized). It is a derived convenience view; `segments[].tokens[].label` remains the source of truth.
3. **No new inputs or commands, no new authority.** Diarization is still requested through the existing `segmenterProperties` input; `speakers` is pure output. No child projection tag is added (a consumer renders `speakers` directly; grouping by `label` yields per-speaker transcripts).
4. **`language` stays on tokens only.** Multilingual surfacing is not part of this decision; only the speaker view is added. If a top-level language view is later needed, that is a separate addition.

The surface after this ADR:

| Kind | Names |
|---|---|
| properties | `recognizing`, `connected`, `transcript`, `interim`, `segments`, `speakers`, `confidence`, `loading`, `error`, `level`, `mode` |
| inputs | unchanged (`engine`, `codec`, `profileId`, `profileWords`, `keepFillerToken`, `resultUpdatedInterval`, `segmenterProperties`, `noLog`) |
| commands | unchanged (`start`, `stop`, `abort`, `reset`) |

`speakers` dispatches `ami-voice:speakers-changed` (the family `-changed` convention).

## Rationale

1. **A derived property beats a child tag for binding ergonomics.** Any framework adapter binds `speakers` with zero extra machinery; a child projection tag would still need the same aggregation computed somewhere, and would only render — not expose — it. Keeping the aggregation in the Core means one implementation, shared by every consumer and both transports.
2. **Final-only matches the data.** `U` interim payloads carry no segment-level `confidence` and the diarizer label stabilizes on the finalized result, so deriving `speakers` from `A` (like `segments`/`confidence`) avoids thrashing a speaker view on every interim revision.
3. **One ordered turn-list is the right primitive.** Emitting ordered, labeled turns (rather than a pre-grouped per-speaker map) preserves conversational order and lets a consumer group by `label` trivially if it wants a per-speaker layout — without the Core guessing which shape the UI needs.
4. **Additive, not breaking.** Adding a property is a minor (backwards-compatible) change; existing consumers ignore it. It is added before 1.0 so it is part of the initial stable surface.

## Alternatives considered

### Alternative A: leave diarization on tokens only (the Q6 lean)

- Pros: zero surface growth; nothing new to keep stable.
- Cons: every consumer re-implements the same token-label walk; "speaker view in scope" is unserved. Rejected now that product input arrived.

### Alternative B: a `<ami-voice-speakers>` child projection tag

- Pros: keeps the parent surface smaller; matches ADR 0004's projection-children pattern.
- Cons: the aggregation still has to live somewhere bindable; a tag renders but does not expose reusable state, so non-DOM/framework consumers can't bind it. A derived Core property is strictly more reusable. Rejected for v1 (a projection tag may still be added later **on top of** `speakers`, projection-only).

### Alternative C: a pre-grouped `Record<label, SpeakerSegment[]>` map

- Pros: per-speaker layout is one lookup.
- Cons: loses global conversational order; forces a shape on consumers who want a timeline; grouping an ordered list is trivial client-side anyway. Rejected — expose the ordered primitive.

## Consequences

### Positive

- "Who said what" is one bound property, identical across relay and direct.
- The aggregation is implemented and tested once, in the Core.
- `segments[].tokens[].label` remains authoritative; `speakers` never hides token detail.

### Negative

- One more property on the breaking-change surface (mitigated: it is additive and lands pre-1.0).
- Without diarization every turn carries `label: ""` — consumers must treat empty label as "single/unknown speaker" (documented in SPEC §8).
- Multilingual (`language`) is deliberately left unsurfaced; a later need is a separate change.

## Follow-up rules

1. `speakers` is **final-only** (updates on `A`, never `U`) and is a pure projection of `segments`; it MUST stay byte-identical across `transport` modes ([ADR 0006](0006-transport-baseline-after-one-time-appkey.md)).
2. `segments[].tokens[].label` remains the source of truth; `speakers` MUST NOT be the only place a label appears.
3. Any future per-speaker child tag MUST be projection-only ([ADR 0004](0004-bindable-surface.md)) and built on `speakers`, declaring no inputs/commands.
4. This ADR, [SPEC §7.1/§8](../../SPEC.md), and the "Intended bindable surface" table in [../../CLAUDE.md](../../CLAUDE.md) §3 must stay in sync.
