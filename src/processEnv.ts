/**
 * Read an environment variable from `process.env` without tripping
 * TypeScript's `no-explicit-any` when `process` is not declared (browser
 * bundle). Returns `undefined` when `process` / `process.env` / the variable
 * is absent.
 *
 * Used for `AMIVOICE_REMOTE_CORE_URL` (control-channel WS URL) and, on the
 * server side only, `AMIVOICE_APPKEY` (read by the provider — NEVER shipped to
 * the browser; see docs/adr/0002).
 */
export function readProcessEnv(name: string): string | undefined {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  return env?.[name];
}
