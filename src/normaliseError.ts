import type { WcsAmiVoiceAnyError } from "./types.js";

/**
 * Normalise any thrown value to the `WcsAmiVoiceAnyError` union kept in
 * `_error`. Single choke-point shared by the Core and the Shell so remote and
 * local consumers see identical structure for any rejection — whether the
 * provider threw an `Error`, a bare string, or a pre-serialised plain object
 * from another realm (e.g. across the wc-bindable remote wire).
 *
 *   - `null` / `undefined` collapses to `null`
 *   - a real `Error` instance is returned as-is
 *   - a plain object with a `message` field is coerced to `SerializedError`
 *   - everything else is wrapped as `new Error(String(err))`
 */
export function normaliseError(err: unknown): WcsAmiVoiceAnyError {
  if (err == null) return null;
  if (err instanceof Error) return err;
  if (typeof err === "object" && err !== null && "message" in (err as Record<string, unknown>)) {
    const e = err as Record<string, unknown>;
    return {
      name: typeof e.name === "string" ? e.name : "Error",
      message: String(e.message ?? ""),
      stack: typeof e.stack === "string" ? e.stack : undefined,
    };
  }
  return new Error(String(err));
}
