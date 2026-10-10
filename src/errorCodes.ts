/**
 * AmiVoice result-code normalization (implementation-notes Q7 / D2).
 *
 * AmiVoice signals failures via a single-character result `code` (empty = OK).
 * This maps them to a closed union and flags the non-retryable client-error
 * subset. Pure — unit-testable.
 */

export type AmiVoiceErrorCode =
  | "auth"               // -  illegal service authorization
  | "unsupported-format" // +  received unsupported audio format
  | "audio-too-large"    // %  received too large audio data from client
  | "client-timeout"     // $  timeout receiving audio data from client
  | "below-threshold"    // o  rejected — confidence below threshold
  | "server-busy"        // b  rejected — recognizer server busy
  | "no-grammar"         // x  rejected — grammar files not loaded
  | "cancelled"          // c  rejected — recognition cancelled
  | "fatal"              // ?  rejected — fatal error in recognizer server
  | "upstream"           // ! > < #  recognizer connect/send/receive/parse failure
  | "invalid-param"      // ^  invalid parameter
  | "unknown";

const CODE_MAP: Record<string, AmiVoiceErrorCode> = {
  "-": "auth",
  "+": "unsupported-format",
  "%": "audio-too-large",
  "$": "client-timeout",
  "o": "below-threshold",
  "b": "server-busy",
  "x": "no-grammar",
  "c": "cancelled",
  "?": "fatal",
  "!": "upstream",
  ">": "upstream",
  "<": "upstream",
  "#": "upstream",
  "^": "invalid-param",
};

/** Result codes AmiVoice classifies as client errors (resolve, do not retry). */
const CLIENT_ERROR_CHARS = new Set([">", "o", "+", "-", "%"]);

/** Every member of the closed `AmiVoiceErrorCode` union (for `getErrorCode`'s narrowing). */
const KNOWN_ERROR_CODES: ReadonlySet<string> = new Set<AmiVoiceErrorCode>([
  ...Object.values(CODE_MAP),
  "unknown",
]);

/** Map a single-character AmiVoice result code to the normalized union. */
export function mapResultCode(code: string): AmiVoiceErrorCode {
  return CODE_MAP[code] ?? "unknown";
}

/** Whether a result code is a (non-retryable) client error. */
export function isClientError(code: string): boolean {
  return CLIENT_ERROR_CHARS.has(code);
}

/**
 * Error carrying the normalized `code`, the raw AmiVoice `resultCode`, and a
 * `retryable` flag. Thrown by the provider and surfaced via the Core's `error`.
 */
export class AmiVoiceError extends Error {
  readonly code: AmiVoiceErrorCode;
  readonly resultCode: string;
  readonly retryable: boolean;

  constructor(resultCode: string, message?: string) {
    const code = mapResultCode(resultCode);
    super(message ?? `AmiVoice error [${resultCode || "?"}]: ${code}`);
    this.name = "AmiVoiceError";
    this.code = code;
    this.resultCode = resultCode;
    // Unknown / non-client codes default to retryable; the documented client
    // errors are not.
    this.retryable = !isClientError(resultCode);
  }
}

/**
 * Read the normalized `code` off a bound `error` value, else `undefined`
 * (plan 1.8). Works for every shape `error` takes, in every mode:
 *
 *   - the Core's published JSON-safe `SerializedError` (`{ name, message,
 *     code?, resultCode?, retryable? }` — identical locally and over the
 *     `@wc-bindable/remote` wire, so `code` survives relay mode),
 *   - an in-process `AmiVoiceError`,
 *   - a remote-revived `Error` carrying the producer's `code` (e.g. a
 *     direct-mode mint rejection; remote ≥ 0.10 forwards `code`).
 *
 * Only members of the closed `AmiVoiceErrorCode` union are returned; any other
 * `code` (a `WC_BINDABLE_*` transport code, a Node `ECONNRESET`, …) and a
 * code-less error yield `undefined` — fall back to `error.message` then.
 */
export function getErrorCode(err: unknown): AmiVoiceErrorCode | undefined {
  if (err instanceof AmiVoiceError) return err.code;
  if (typeof err !== "object" || err === null) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" && KNOWN_ERROR_CODES.has(code) ? (code as AmiVoiceErrorCode) : undefined;
}
