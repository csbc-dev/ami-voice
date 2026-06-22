import type { RecognitionSegment, SpeakerSegment } from "./types.js";

/**
 * Derive the speaker view from finalized segments (docs/adr/0007, Phase 3.2).
 *
 * Pure — no I/O, unit-testable. With `segmenterProperties="useDiarizer=1"`
 * AmiVoice labels each utterance's tokens with a speaker id; this projects one
 * finalized `A` segment to one ordered, labeled turn. Without diarization every
 * turn carries the empty label `""`. `segments[].tokens[].label` stays the
 * source of truth — `speakers` is a convenience view consumers can group by
 * `label` for a per-speaker transcript.
 */

/** The segment's speaker id: the first token carrying a non-empty `label`, else `""`. */
export function speakerLabelOf(segment: RecognitionSegment): string {
  for (const token of segment.tokens) {
    if (token.label) return token.label;
  }
  return "";
}

/** Project one finalized segment to a speaker-labeled turn. */
export function toSpeakerSegment(segment: RecognitionSegment): SpeakerSegment {
  return {
    label: speakerLabelOf(segment),
    text: segment.text,
    starttime: segment.starttime,
    endtime: segment.endtime,
    confidence: segment.confidence,
  };
}
