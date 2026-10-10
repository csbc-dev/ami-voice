import type {
  RecognitionOptions, RecognitionSegment, RecognitionToken, InterimResult,
} from "../types.js";

/**
 * AmiVoice realtime ("Wnn") command/event protocol helpers.
 *
 * Client → server commands: `s` (start) / `p` (audio) / `e` (end).
 * Server → client events:   `S` `E` `C` `U` `A` `G`, plus `s` / `p` / `e` acks.
 *
 * This module is pure (no I/O); the provider drives the actual socket.
 */

/** Binary audio frames are prefixed with the ASCII `p` command byte. */
export const AUDIO_FRAME_PREFIX = "p";

/** Wrap a value in double quotes when it contains whitespace or `=`. */
function quoteIfNeeded(value: string): string {
  return /[\s=]/.test(value) ? `"${value}"` : value;
}

/**
 * Build the realtime `s` (start) command:
 *
 *   `s <audio_format> <grammar_file_names> <key>=<value> … authorization=<APPKEY>`
 *
 * `codec` is the `audio_format`, `engine` is the `grammar_file_names`. The
 * APPKEY is appended last as `authorization=…` and MUST come from the
 * server-side provider (never the browser — docs/adr/0002).
 */
export function buildStartCommand(options: RecognitionOptions, appKey: string): string {
  const parts: string[] = ["s", options.codec, options.engine];

  const push = (key: string, value: string): void => {
    parts.push(`${key}=${quoteIfNeeded(value)}`);
  };

  if (options.profileId) push("profileId", options.profileId);
  if (options.profileWords) push("profileWords", options.profileWords);
  if (options.keepFillerToken) push("keepFillerToken", "1");
  if (options.resultUpdatedInterval != null) {
    push("resultUpdatedInterval", String(options.resultUpdatedInterval));
  }
  if (options.segmenterProperties) push("segmenterProperties", options.segmenterProperties);

  // authorization is always last so it is easy to redact in logs.
  parts.push(`authorization=${appKey}`);
  return parts.join(" ");
}

/** A parsed server → client message. */
export type WnnEvent =
  | { type: "S"; ms: number }
  | { type: "E"; ms: number }
  | { type: "C" }
  | { type: "U"; result: InterimResult }
  | { type: "A"; result: RecognitionSegment }
  | { type: "G"; payload: string }
  | { type: "ack"; command: "s" | "p" | "e"; ok: boolean; message?: string }
  | { type: "unknown"; raw: string };

interface RawToken {
  written?: unknown;
  spoken?: unknown;
  confidence?: unknown;
  starttime?: unknown;
  endtime?: unknown;
  label?: unknown;
  language?: unknown;
}

interface RawResult {
  text?: unknown;
  confidence?: unknown;
  starttime?: unknown;
  endtime?: unknown;
  tokens?: unknown;
}

interface RawPayload {
  text?: unknown;
  utteranceid?: unknown;
  results?: unknown;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function normalizeTokens(raw: unknown): RecognitionToken[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((t): RecognitionToken => {
    const tok = (t ?? {}) as RawToken;
    const token: RecognitionToken = {
      written: str(tok.written),
      spoken: str(tok.spoken),
      confidence: num(tok.confidence),
      starttime: num(tok.starttime),
      endtime: num(tok.endtime),
    };
    if (typeof tok.label === "string") token.label = tok.label;
    if (typeof tok.language === "string") token.language = tok.language;
    return token;
  });
}

/** First `results[]` entry, or the payload itself if `results` is absent. */
function firstResult(payload: RawPayload): RawResult {
  const results = payload.results;
  if (Array.isArray(results) && results.length > 0) return (results[0] ?? {}) as RawResult;
  return payload as RawResult;
}

/** Normalize a `U` payload into an interim hypothesis (text + tokens only). */
export function toInterim(payload: RawPayload): InterimResult {
  const r = firstResult(payload);
  return {
    text: str(payload.text) || str(r.text),
    tokens: normalizeTokens(r.tokens),
  };
}

/** Normalize an `A` payload into a finalized segment (with confidence/timings). */
export function toSegment(payload: RawPayload): RecognitionSegment {
  const r = firstResult(payload);
  const segment: RecognitionSegment = {
    text: str(payload.text) || str(r.text),
    confidence: num(r.confidence),
    starttime: num(r.starttime),
    endtime: num(r.endtime),
    tokens: normalizeTokens(r.tokens),
  };
  if (typeof payload.utteranceid === "string") segment.utteranceid = payload.utteranceid;
  return segment;
}

/**
 * Re-normalize an already-shaped finalized segment — e.g. one a CUSTOM
 * `IAmiVoiceProvider` hands the Core via `onFinal` / `recognizeFile` — to exactly
 * the public `RecognitionSegment` model, with the same `num()` / `str()` / token
 * rules `toSegment` applies to raw `A` payloads (non-finite → 0, non-string → "",
 * optional `utteranceid` / `label` / `language` OMITTED unless a string, unknown
 * keys dropped).
 *
 * The Core runs every finalized segment through this (SPEC §8) because
 * `segments` / `speakers` cross the `@wc-bindable/remote` wire as strict
 * `JsonValue`s: a single `utteranceid: undefined` or `confidence: NaN` would make
 * remote ≥ 0.10 drop EVERY later `segments` update until `reset()`. Idempotent on
 * segments `toSegment` already produced.
 */
export function normalizeSegment(raw: unknown): RecognitionSegment {
  const r = (raw ?? {}) as RawResult & { utteranceid?: unknown };
  const segment: RecognitionSegment = {
    text: str(r.text),
    confidence: num(r.confidence),
    starttime: num(r.starttime),
    endtime: num(r.endtime),
    tokens: normalizeTokens(r.tokens),
  };
  if (typeof r.utteranceid === "string") segment.utteranceid = r.utteranceid;
  return segment;
}

function safeJson(raw: string): RawPayload {
  try {
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === "object") ? (parsed as RawPayload) : {};
  } catch {
    return {};
  }
}

/**
 * Parse one server → client frame. The first character is the type; the
 * remainder (after a separating space) is the payload. Uppercase letters are
 * events; lowercase `s` / `p` / `e` are command acks (an ack with a trailing
 * message is an error, e.g. `s some error`).
 */
export function parseEvent(raw: string): WnnEvent {
  if (raw.length === 0) return { type: "unknown", raw };
  const type = raw[0];
  const rest = raw.slice(1).trim();

  switch (type) {
    case "S": return { type: "S", ms: num(Number(rest)) };
    case "E": return { type: "E", ms: num(Number(rest)) };
    case "C": return { type: "C" };
    case "U": return { type: "U", result: toInterim(safeJson(rest)) };
    case "A": return { type: "A", result: toSegment(safeJson(rest)) };
    case "G": return { type: "G", payload: rest };
    case "s":
    case "p":
    case "e":
      return rest.length === 0
        ? { type: "ack", command: type, ok: true }
        : { type: "ack", command: type, ok: false, message: rest };
    default:
      return { type: "unknown", raw };
  }
}
