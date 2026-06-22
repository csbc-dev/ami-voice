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
 * Read the normalized `code` off a bound `error` value if it is an
 * `AmiVoiceError`, else `undefined` (plan 1.8). Locally the `error` property
 * holds the real `AmiVoiceError` (so `code` is available); over the
 * `@wc-bindable/remote` wire only `{ name, message }` survive, so a remote
 * consumer gets `undefined` here and falls back to `error.message`.
 */
export function getErrorCode(err: unknown): AmiVoiceErrorCode | undefined {
  return err instanceof AmiVoiceError ? err.code : undefined;
}
