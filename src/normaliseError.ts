import type { WcsAmiVoiceAnyError, SerializedError } from "./types.js";
import { redactSecrets, redactErrorInPlace } from "./redact.js";

/**
 * Copy the JSON-safe error metadata an `AmiVoiceError` (or a remote-revived
 * `Error` / a plain object) carries — `code`, `resultCode`, `retryable` — onto
 * `out`, OMITTING absent keys. Never assigns `undefined`: an `undefined` member
 * makes the whole value a non-JsonValue, which `@wc-bindable/remote` ≥ 0.10
 * refuses to send. The strings are redacted like `message`: a custom provider
 * owns these fields, and they cross the wire.
 */
function copyErrorMeta(src: object, out: SerializedError): SerializedError {
  const e = src as Record<string, unknown>;
  if (typeof e.code === "string") out.code = redactSecrets(e.code);
  if (typeof e.resultCode === "string") out.resultCode = redactSecrets(e.resultCode);
  if (typeof e.retryable === "boolean") out.retryable = e.retryable;
  return out;
}

/** A redacted `name`, or `"Error"` when it is not a string. */
function nameOf(e: Record<string, unknown>): string {
  return typeof e.name === "string" ? redactSecrets(e.name) : "Error";
}

/**
 * The redacted `{ name, message, stack?, code?, resultCode?, retryable? }` of
 * an `Error` that cannot be handed on as it is — frozen, or holding a secret
 * where `redactErrorInPlace` cannot overwrite it. An absent `stack` is omitted
 * (not `undefined`) so the shape stays JSON-safe. `cause` and other fields are
 * not carried.
 */
function snapshotOf(err: Error): SerializedError {
  const out: SerializedError = {
    name: nameOf(err as unknown as Record<string, unknown>),
    message: redactSecrets(String(err.message)),
  };
  if (typeof err.stack === "string") out.stack = redactSecrets(err.stack);
  return copyErrorMeta(err, out);
}

/**
 * Normalise any thrown value to the `WcsAmiVoiceAnyError` union the SHELL keeps
 * in its own `error` (Shell-raised failures: codec rejection, mic denial, a
 * rejected control-channel call). The Core does NOT use this for its published
 * `error` — it uses `toSerializedError` (always a plain JSON-safe object, so the
 * value crosses the remote wire) — and its direct-mode throw path uses `toError`.
 *
 *   - `null` / `undefined` collapses to `null`
 *   - a real `Error` instance is returned as-is (with any `authorization=…`
 *     scrubbed from its `message` / `stack`; `toError` also scrubs its `cause`
 *     chain and extra fields)
 *   - a plain object with a `message` field is coerced to `SerializedError`
 *   - everything else is wrapped as `new Error(String(err))`
 *
 * Redaction is mandatory here too: an upstream non-ok `s`/`p`/`e` ack can echo
 * back `authorization=<APPKEY>`, and every error shape that can reach the
 * browser or a log must have it scrubbed (SPEC §14, §17).
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
      // uncaught TypeError. `code`/`resultCode`/`retryable` are carried over.
      return snapshotOf(err);
    }
  }
  if (typeof err === "object" && err !== null && "message" in (err as Record<string, unknown>)) {
    const e = err as Record<string, unknown>;
    const out: SerializedError = {
      name: nameOf(e),
      message: redactSecrets(String(e.message ?? "")),
    };
    if (typeof e.stack === "string") out.stack = redactSecrets(e.stack);
    return copyErrorMeta(e, out);
  }
  return new Error(redactSecrets(String(err)));
}

/**
 * Shape any thrown value into the JSON-safe `SerializedError` the CORE publishes
 * on its `error` property and as the `ami-voice:error` detail (SPEC §17).
 *
 * The result is always a plain object of `{ name, message, code?, resultCode?,
 * retryable? }` — never an `Error` instance, never a `stack`, never an
 * `undefined` member — so it is a strict `JsonValue`. That is load-bearing in
 * relay mode: `@wc-bindable/remote` ≥ 0.10 validates every property value and
 * silently DROPS a non-JsonValue (`update`) or omits it from `sync`
 * (`getterFailures`), so an `AmiVoiceError` instance here would mean the
 * browser never sees the failure at all. The same shape is used locally, so
 * remote and local consumers see identical structure.
 *
 * Like `normaliseError`, this is a redaction choke-point: the `message` crosses
 * the trust boundary to the browser in relay mode, so any echoed
 * `authorization=<APPKEY>` is scrubbed (SPEC §14). The stack is dropped
 * entirely — server stack traces do not belong on an untrusted wire (SPEC §17).
 */
export function toSerializedError(err: unknown): SerializedError | null {
  if (err == null) return null;
  try {
    if (err instanceof Error || (typeof err === "object" && "message" in err)) {
      const e = err as Record<string, unknown>;
      return copyErrorMeta(e, {
        name: nameOf(e),
        message: redactSecrets(String(e.message ?? "")),
      });
    }
    return { name: "Error", message: redactSecrets(String(err)) };
  } catch {
    // A hostile value (throwing getter / `toString`) must not turn the Core's
    // "publish to `error`, never reject" path (SPEC §17) into a throw.
    return { name: "Error", message: "unserializable error value" };
  }
}

/**
 * Shape any thrown value into an `Error` INSTANCE for a path that must reject —
 * the direct-mode mint in `AmiVoiceCore.start()` (docs/adr/0006), whose rejection
 * travels to the browser as a `@wc-bindable/remote` `throw` envelope.
 *
 * `normaliseError` can return a plain `SerializedError` (frozen-Error fallback,
 * plain-object rejection). Thrown as-is, remote ≥ 0.10 canonicalises a non-Error
 * throw to `NonErrorThrow` with the message `"[object Object]"`, losing the real
 * cause. Rebuild it as an `Error` that keeps the original `name` / redacted
 * `message` / `code` (the remote shell forwards `code` to the consumer) plus
 * `resultCode` / `retryable` for in-process callers.
 *
 * The Core also runs every failure it publishes through this before projecting
 * it with `toSerializedError`, and keeps the result as the server-side
 * `AmiVoiceCore.originalError`, which an integrator hands whole to an error
 * tracker or a log. So the APPKEY is redacted from all of an `Error`, not only
 * its `message` / `stack`: `redactErrorInPlace` covers the `cause` chain and the
 * extra fields, in place, so the same instance is returned (SPEC §14). If a
 * secret sits where it cannot be overwritten (a frozen `cause`, a read-only
 * field), the instance is not returned: it is rebuilt from its redacted
 * `name` / `message` / `stack` / `code` / `resultCode` / `retryable`, like a
 * frozen `Error`, without `cause` or other fields.
 *
 * It can throw on a hostile value (a throwing `message` getter); the Core
 * guards that call.
 */
export function toError(err: unknown): Error {
  const normalised = normaliseError(err);
  if (normalised instanceof Error) {
    return redactErrorInPlace(normalised) ? normalised : fromSerialized(snapshotOf(normalised));
  }
  if (normalised === null) return new Error(String(err));
  return fromSerialized(normalised);
}

/** An `Error` carrying a `SerializedError`'s fields (`toError`'s rebuild). */
function fromSerialized(normalised: SerializedError): Error {
  const out = new Error(normalised.message) as Error & Omit<SerializedError, "name" | "message" | "stack">;
  out.name = normalised.name;
  if (normalised.stack !== undefined) out.stack = normalised.stack;
  if (normalised.code !== undefined) out.code = normalised.code;
  if (normalised.resultCode !== undefined) out.resultCode = normalised.resultCode;
  if (normalised.retryable !== undefined) out.retryable = normalised.retryable;
  return out;
}
