# `@csbc-dev/ami-voice` — Documentation

A compiling scaffold exists (`src/`, tests, build); the AmiVoice transport is still stubbed. The documentation is layered: **ADRs** record *why* (settled decisions), **SPEC.md** records *what* (the normative contract), and **implementation-notes.md** records the open *how* (decisions an implementer must still make).

For the package overview and CSBC context, see [../CLAUDE.md](../CLAUDE.md).

## Specification, plan & open questions

| Doc | Role |
|---|---|
| [../SPEC.md](../SPEC.md) | Normative contract — component model, bindable surface, two-channel transport, AmiVoice protocol, security/error/cancellation invariants, implementation status |
| [implementation-plan.md](implementation-plan.md) | Sequenced delivery plan — phases (relay e2e → browser-direct → hardening), ordered tasks, critical path, decision gates |
| [implementation-notes.md](implementation-notes.md) | Stub boundaries + the open implementation questions (Q1–Q14) and resolved AmiVoice reference items |

## Architecture Decision Records (ADR)

Each ADR records one design decision, its context, the alternatives weighed, and the consequences. They are written before code lands so the implementation has a contract to hold to. Format follows the family convention (`docs/adr/NNNN-slug.md`, Michael Nygard style).

| # | Decision | Status |
|---|---|---|
| [0001](adr/0001-csbc-case-classification.md) | Where AmiVoice sits in CSBC — real-time = Case C, file = Case B1 | Accepted (design intent) |
| [0002](adr/0002-appkey-residency-and-remote-first.md) | APPKEY residency and remote-first default mode | Accepted (design intent) |
| [0003](adr/0003-realtime-audio-transport.md) | Real-time audio transport baseline — two-channel server relay (JSON control + binary audio), not browser-direct | Accepted (design intent) |
| [0004](adr/0004-bindable-surface.md) | Bindable surface — single authority parent, `transcript`/`interim` split, projection-only children | Accepted (design intent) |
| [0005](adr/0005-audio-capture-and-codec-ownership.md) | Audio capture & codec ownership — Shell-owned framing, Core-owned codec policy | Accepted (design intent) |
| [0006](adr/0006-transport-baseline-after-one-time-appkey.md) | Dual-mode transport — relay default + browser-direct opt-in (one-time APPKEY confirmed); server-helper shape | Accepted (design intent) — amends 0003 |

## How to add a new ADR

1. Copy the structure of an existing ADR (Status / Context / Decision / Rationale / Alternatives considered / Consequences / Follow-up rules).
2. Use the next free number; never renumber or delete an accepted ADR. To reverse one, add a new ADR with status `Supersedes 000N` and set the old one's status to `Superseded by 000M`.
3. Add a row to the table above.
4. If the decision changes the public contract described in [../CLAUDE.md](../CLAUDE.md), update that section in the same change.

## Status vocabulary

- **Accepted (design intent)** — agreed, but not yet exercised by code. The implementation must honor it.
- **Accepted** — agreed and reflected in shipped code.
- **Superseded by 000N** — replaced; kept for history.
- **Proposed** — under discussion, not yet agreed.
