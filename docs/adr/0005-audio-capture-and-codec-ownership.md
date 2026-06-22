# ADR 0005: Audio capture and codec ownership

## Status

Accepted (design intent)

Date: 2026-06-23

## Context

Real-time recognition needs raw audio frames in a format AmiVoice accepts. For the headerless streaming `audio_format` that means 16-bit signed PCM — `LSB16K` (little-endian) / `MSB16K` (big-endian) at 16 kHz, plus other rates (`LSB8K`…`LSB48K` / `MSB8K`…`MSB48K`) and the 8-bit companding codecs `MULAW` / `ALAW`. (AmiVoice does **not** accept ADPCM for the realtime `audio_format`; identifiers are case-insensitive.) Getting there from a live microphone involves several steps:

1. `getUserMedia` to obtain a `MediaStream` (requires a user gesture, browser-only).
2. An `AudioWorklet` to pull audio off the real-time audio thread.
3. Downsampling the browser's native sample rate (typically 48 kHz) to the target (e.g. 16 kHz).
4. Encoding/framing into the configured codec and chunk size.
5. Computing an input **level** for a UI meter.

There is a boundary question: **which of these belong to the Shell (browser data plane) and which to the Core (decisions)?** It is tempting to push framing into the Core "so the Shell stays thin," but capture is browser-pinned ([ADR 0001](0001-csbc-case-classification.md)) and, under the relay transport ([ADR 0003](0003-realtime-audio-transport.md)), the Core sees frames only after they cross the wire — and under a future direct transport it would not see them at all.

Meanwhile **which codec to use** is a recognition-affecting policy: it must match what the Core declares to AmiVoice in the `s` command, and it trades bandwidth against fidelity. That is a decision, not mechanical work.

## Decision

Split ownership along the decision/execution line:

1. **The Shell owns audio capture and framing** — `getUserMedia`, the `AudioWorklet`, downsampling, codec encoding, chunking, and the `level` computation. This is the undelegatable browser data plane.
2. **The Core owns codec *policy*** — `codec` is a Core-side input. The Core decides which format to recognize with, declares it to AmiVoice in `s`, and tells the Shell which target format to encode to. The Shell executes that choice; it does not pick the codec.
3. **The audio format the Shell streams must match the format the Core declared to AmiVoice.** A single source of truth (the Core's `codec` input) drives both sides; the Shell never independently chooses a format the Core did not declare.

## Rationale

### 1. Capture and framing physically cannot move to the Core

`getUserMedia` and `AudioWorklet` only exist in the browser. Downsampling and framing have to happen at the capture point to keep latency low and to avoid shipping oversized native-rate audio across the wire. Under a future direct transport ([ADR 0003](0003-realtime-audio-transport.md)) the Core would not see frames at all, so framing *must* live in the Shell to keep both transports working under one contract.

### 2. Codec choice is a decision, so it belongs to the Core

The codec affects recognition fidelity and bandwidth and must match the `s` command the Core sends. Letting the Shell choose it would split a recognition decision across the wire and risk a Shell/Core format mismatch. Making it a Core input keeps one source of truth.

### 3. `level` is execution output, not a decision

The mic level is derived from frames the Shell already has in hand for a UI meter. Computing it in the Shell avoids a wire round-trip for a value that is pure UI state, and keeps it available even under a future direct transport. This is why [ADR 0004](0004-bindable-surface.md) labels `level` Shell-projected.

### 4. The split keeps the relay payload honest

Because the Shell encodes to the target codec before streaming, the relay ([ADR 0003](0003-realtime-audio-transport.md)) carries already-framed audio in the format AmiVoice expects, not raw 48 kHz PCM — minimizing the bytes that traverse the server.

## Alternatives considered

### Alternative A: Shell sends raw native-rate PCM; Core downsamples and encodes

- Pros: Shell is "thinner"; all DSP in one place.
- Cons: ~3× more bytes across the wire at 48 kHz vs. 16 kHz; adds latency; impossible under a future direct transport where the Core never sees frames; conflates capture execution with a relay-only assumption. Rejected.

### Alternative B: Shell owns codec choice too

- Pros: one fewer Core input; Shell fully self-contained.
- Cons: splits a recognition decision across the wire; risks Shell encoding a format the Core did not declare to AmiVoice in `s`, causing silent recognition failures. Rejected; codec is Core policy.

### Alternative C: compute `level` in the Core

- Pros: "all derived state in the Core" symmetry.
- Cons: needs a wire round-trip for a pure UI value; breaks under a future direct transport where the Core has no frames. Rejected; `level` stays Shell-projected.

## Consequences

### Positive

- Capture/framing live where they physically must, and survive a future transport change unchanged.
- One source of truth for codec (Core input) prevents Shell/Core format mismatch.
- The relay carries minimal, already-framed bytes.
- `level` is available without a round-trip.

### Negative

- The Shell is unavoidably "fat" in real-time mode (it runs real DSP), which can read as a CSBC smell to someone expecting a thin Shell — addressed by [ADR 0001](0001-csbc-case-classification.md) making the Case C fatness explicit.
- DSP (downsampling, encoding) in an `AudioWorklet` is non-trivial browser code that must be tested in a real browser, not only in happy-dom.
- The Shell and Core share a codec contract that must be kept consistent on both sides of the wire.

## Follow-up rules

1. Audio capture, downsampling, codec encoding, framing, and `level` stay in the Shell's data plane; do not relocate them to the Core.
2. `codec` is a Core input; the Shell encodes to whatever the Core declared and never independently selects a format.
3. The streamed audio format must always match the format declared to AmiVoice in the `s` command.
4. `AudioWorklet` / DSP code requires real-browser (integration) testing before release, per the [release skill](../../.claude/skills/release/SKILL.md).
