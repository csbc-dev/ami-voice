/**
 * Strip any `authorization=<token>` substring from a string before it can be
 * logged OR cross a trust boundary to the browser.
 *
 * Package-generated messages (errorCodes.ts) never carry one, but a non-ok
 * `s`/`p`/`e` ack echoes the raw upstream string (wnnProtocol.ts), and the `s`
 * command itself ends in `authorization=<APPKEY>`. In relay mode that echoed
 * message flows through the Core's `error` property — published as the plain
 * JSON-safe `{ name, message, code?, … }` built by `toSerializedError` — and is
 * serialized over the `@wc-bindable/remote` wire to the browser; in direct mode
 * a mint rejection crosses as a remote `throw` (built by `toError`). Redacting
 * at those error choke-points (normaliseError.ts) keeps the "APPKEY never
 * reaches the browser / never appears in logs" guarantee (SPEC §14, §17) true
 * regardless of what upstream reflects back. Used by the server logger and by
 * `toSerializedError` / `normaliseError` / `toError`.
 */
export function redactSecrets(message: string): string {
  return message.replace(/authorization=\S+/gi, "authorization=<redacted>");
}
