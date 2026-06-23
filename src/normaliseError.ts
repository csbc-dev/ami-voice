import type { WcsAmiVoiceAnyError } from "./types.js";
import { redactSecrets } from "./redact.js";

/**
 * Normalise any thrown value to the `WcsAmiVoiceAnyError` union kept in
 * `_error`. Single choke-point shared by the Core and the Shell so remote and
 * local consumers see identical structure for any rejection — whether the
 * provider threw an `Error`, a bare string, or a pre-serialised plain object
 * from another realm (e.g. across the wc-bindable remote wire).
 *
 *   - `null` / `undefined` collapses to `null`
 *   - a real `Error` instance is returned as-is (with any `authorization=…`
 *     scrubbed from its `message` / `stack`)
 *   - a plain object with a `message` field is coerced to `SerializedError`
 *   - everything else is wrapped as `new Error(String(err))`
 *
 * Because this is the choke-point feeding the Core's `error` property — which
 * is serialized over the `@wc-bindable/remote` wire to the browser in relay
 * mode — it MUST redact the APPKEY a non-ok upstream `s`/`p`/`e` ack can echo
 * back (`authorization=<APPKEY>`). Without this, an `s` rejection would leak the
 * permanent APPKEY across the trust boundary (SPEC §14, §17).
 */
export function normaliseError(err: unknown): WcsAmiVoiceAnyError {
  if (err == null) return null;
  if (err instanceof Error) {
    // Scrub in place: these errors are freshly constructed at the throw site
    // (e.g. `new AmiVoiceError("", ev.message)`), so mutating preserves the
    // subclass (`code`/`retryable`) without leaking the secret onward.
    const message = redactSecrets(err.message);
    const stack = typeof err.stack === "string" ? redactSecrets(err.stack) : err.stack;
    try {
      err.message = message;
      err.stack = stack;
      return err;
    } catch {
      // A frozen / read-only Error (e.g. a hardened or cross-realm Error from a
      // custom provider) cannot be mutated under strict mode. Fall back to a
      // plain SerializedError so redaction still happens and never escapes as an
      // uncaught TypeError. (`code`/`retryable` are lost here, matching the
      // existing cross-realm wire behavior where those already don't survive.)
      return { name: err.name, message, stack: typeof stack === "string" ? stack : undefined };
    }
  }
  if (typeof err === "object" && err !== null && "message" in (err as Record<string, unknown>)) {
    const e = err as Record<string, unknown>;
    return {
      name: typeof e.name === "string" ? e.name : "Error",
      message: redactSecrets(String(e.message ?? "")),
      stack: typeof e.stack === "string" ? redactSecrets(e.stack) : undefined,
    };
  }
  return new Error(redactSecrets(String(err)));
}
