/** What a redacted secret becomes. */
const REDACTED = "<redacted>";

/**
 * Shortest value `registerKnownSecret` accepts. Replacing every occurrence of a
 * short value would also hit ordinary text (a 4-character password inside a
 * word); a real APPKEY is far longer. A shorter secret is left to the patterns.
 */
const MIN_KNOWN_SECRET_LENGTH = 8;

/**
 * Every form of every registered secret (the value itself, URL-encoded, JSON-
 * escaped), longest first, so a secret that contains another is replaced whole.
 */
let knownSecretForms: string[] = [];

/**
 * Whether replacing `form` with `<redacted>` could leave a new `form` behind
 * (a form inside the placeholder, or one that overlaps its ends), which would
 * break idempotence. Such a value is not registered.
 */
function overlapsPlaceholder(form: string): boolean {
  if (REDACTED.includes(form)) return true;
  for (let n = 1; n < REDACTED.length; n++) {
    if (form.startsWith(REDACTED.slice(-n)) || form.endsWith(REDACTED.slice(0, n))) return true;
  }
  return false;
}

/** `%2f` for `%2F`: an echo may spell the escapes in lower case. */
function lowerHex(encoded: string): string {
  return encoded.replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase());
}

/**
 * The forms a secret takes in the strings an error can carry: as it is (an
 * `s` command, a header, a multipart field), URL-encoded (`encodeURIComponent`,
 * and an `application/x-www-form-urlencoded` body / query string, both with
 * upper- and lower-case escapes) and JSON-escaped (a serialized body or cause).
 */
function formsOf(secret: string): string[] {
  const forms = new Set<string>([secret, JSON.stringify(secret).slice(1, -1)]);
  const encoded = [new URLSearchParams([["", secret]]).toString().slice(1)];
  try {
    encoded.push(encodeURIComponent(secret));
  } catch {
    // A lone surrogate: `encodeURIComponent` has no form for it.
  }
  for (const form of encoded) forms.add(form).add(lowerHex(form));
  return [...forms];
}

/**
 * Register a secret this process holds — the permanent APPKEY, the service
 * password — so that `redactSecrets`, and so every redaction choke-point
 * (`toError` / `originalError`, `toSerializedError`, the server logger, the
 * remote `throw` reply), replaces its VALUE wherever it appears, in whatever
 * syntax: a raw echo, `Authorization: Bearer …`, a form field, a URL-encoded
 * body, a JSON body. The patterns of `redactSecrets` only recognize a secret
 * by the label in front of it; this does not depend on the label.
 *
 * Called by `AmiVoiceProvider` (its APPKEY and service password) and by
 * `createAmiVoiceRelayServer` (`AMIVOICE_APPKEY` / `AMIVOICE_SERVICE_PASSWORD`,
 * for a custom provider that reads them). Internal: not exported from either
 * entry point. Process-wide and permanent — a value stays registered (a rotated
 * key is still a secret); the registry holds each distinct value once.
 *
 * Ignored: a non-string, a value shorter than `MIN_KNOWN_SECRET_LENGTH`
 * characters (left to the patterns), and a value that overlaps the
 * `<redacted>` placeholder (it would make redaction non-idempotent). Never
 * register a short-lived token per session: the registry would grow without
 * bound.
 */
export function registerKnownSecret(secret: string | null | undefined): void {
  if (typeof secret !== "string" || secret.length < MIN_KNOWN_SECRET_LENGTH) return;
  const fresh = formsOf(secret).filter((form) => !knownSecretForms.includes(form));
  if (fresh.length === 0 || fresh.some(overlapsPlaceholder)) return;
  knownSecretForms = [...knownSecretForms, ...fresh].sort((a, b) => b.length - a.length);
}

/**
 * A JSON member `"u": "…"`, `"spw": "…"` or `"authorization": "…"` (a request
 * body, a serialized header map), also inside a JSON string (`\"u\":\"…\"`).
 * The value runs to the next quote or backslash.
 */
const JSON_MEMBER = /(\\*"(?:u|spw|authorization)\\*"\s*:\s*\\*")[^"\\]+/gi;

/**
 * `Bearer <token>`: the `Authorization` header of the async poll, or its value
 * alone (a header map's entry). Any case. The token is an RFC 6750 b64token
 * (plus `%`, for a URL-encoded one). The word after `bearer` is redacted even
 * when it is not a credential (`bearer token` → `bearer <redacted>`).
 */
const BEARER = /\b(bearer[ \t]+)[\w\-.~+/%]+=*/gi;

/** `authorization=<token>`: the realtime `s` command's credential. The token runs to the next whitespace. */
const AUTHORIZATION_PARAM = /authorization=\S+/gi;

/**
 * `u=<APPKEY>` / `spw=<service password>`: a field of an HTTP form (the async
 * enqueue, the one-time APPKEY issuance) or a query string. Only as a field of
 * its own — at the start of the text or after a character that cannot be part
 * of a longer name (`&`, `?`, whitespace, a quote, …), so `menu=` or `x.u=`
 * are not touched. The value runs to the next `&`, `#`, whitespace, quote or
 * bracket.
 */
const FORM_FIELD = /(^|[^\w.-])((?:u|spw)=)[^\s&#"'<>\\,;()[\]{}]+/gi;

/**
 * Strip the APPKEY (and the other AmiVoice credentials) from a string before
 * it can be logged OR cross a trust boundary to the browser.
 *
 * Package-generated messages (errorCodes.ts) never carry one, but a non-ok
 * `s`/`p`/`e` ack echoes the raw upstream string (wnnProtocol.ts), and the `s`
 * command itself ends in `authorization=<APPKEY>`; an HTTP failure of the file
 * mode / the one-time APPKEY issuance can carry the request it failed on —
 * its `Authorization: Bearer <APPKEY>` header, its `u=<APPKEY>` form — in its
 * message, stack or cause, and an async job's JSON reply is quoted into the
 * error message. In relay mode that message flows through the Core's `error`
 * property — published as the plain JSON-safe `{ name, message, code?, … }`
 * built by `toSerializedError` — and is serialized over the
 * `@wc-bindable/remote` wire to the browser; in direct mode a mint rejection
 * crosses as a remote `throw` (built by `toError`). Redacting at those error
 * choke-points (normaliseError.ts, the server helper) keeps the "APPKEY never
 * reaches the browser / never appears in logs" guarantee (SPEC §14, §17) true
 * regardless of what upstream reflects back. Used by the server logger and by
 * `toSerializedError` / `normaliseError` / `toError`.
 *
 * Two mechanisms, applied in this order:
 *
 *   1. Known values (`registerKnownSecret`): every form of a registered secret
 *      becomes `<redacted>`, whatever surrounds it.
 *   2. Patterns, for secrets the process does not know by value (a custom
 *      provider's key, a one-time APPKEY): a JSON member `"u"` / `"spw"` /
 *      `"authorization"` → `"u":"<redacted>"`; `Bearer <token>` →
 *      `Bearer <redacted>`; `authorization=<token>` →
 *      `authorization=<redacted>` (the output of earlier releases, kept); a form / query field
 *      `u=` / `spw=` → `u=<redacted>`. All case-insensitive.
 *
 * Public on the `/server` entry only (SPEC §14), for an application's own logs
 * of strings that may hold an `s` command, a request or their echo. Idempotent:
 * an already redacted string stays as it is.
 */
export function redactSecrets(message: string): string {
  let out = message;
  for (const form of knownSecretForms) {
    if (out.includes(form)) out = out.split(form).join(REDACTED);
  }
  return out
    .replace(JSON_MEMBER, `$1${REDACTED}`)
    .replace(BEARER, `$1${REDACTED}`)
    .replace(AUTHORIZATION_PARAM, `authorization=${REDACTED}`)
    .replace(FORM_FIELD, `$1$2${REDACTED}`);
}

/** `instanceof Error`, plus an `Error` from another realm (vm context, iframe). */
function isError(value: object): value is Error {
  return value instanceof Error || Object.prototype.toString.call(value) === "[object Error]";
}

/** A plain object (`{}` / `Object.create(null)`) or an array: data, not a class instance. */
function isPlainData(value: object): boolean {
  if (Array.isArray(value)) return true;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** `holder[key]`, or `undefined` when a getter throws: what nobody can read cannot leak. */
function read(holder: object, key: string): unknown {
  try {
    return (holder as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/**
 * Redact every secret `redactSecrets` recognizes (a registered value in any
 * form, `authorization=<token>`, `Bearer <token>`, `u=` / `spw=`, …) that an
 * `Error` carries — not only in its
 * `message` / `stack` but in the `cause` chain and the extra fields — IN PLACE,
 * so the instance can go to an error tracker or a log whole (SPEC §14).
 * `toError` runs it on every `Error` it hands out, `AmiVoiceCore.originalError`
 * included. In place, like the `message` / `stack` scrub of `normaliseError`:
 * the caller keeps the same instance, its class and its `stack`.
 *
 * It visits each own string-keyed property of the `Error` (`message`, `stack`,
 * `cause`, `AggregateError.errors`, `code`, a custom `diag`, …, enumerable or
 * not), and from there every `Error`, plain object and array reachable through
 * them, each once (cycles, shared causes):
 *
 *   - a string is replaced by its `redactSecrets` form;
 *   - an `Error` (each `cause` in the chain, one inside a field) is redacted
 *     in place the same way — same instance;
 *   - a plain object / array holding such a string (at any depth) is replaced
 *     on its owner by a redacted copy, never edited: it may be the provider's
 *     own state (a shared options object), which the error only points at;
 *   - anything else (class instances, `Map`s, buffers, symbol-keyed properties)
 *     is left as it is.
 *
 * It never throws: a getter that throws reads as nothing to redact (nobody can
 * read it), and any other failure of the walk (a proxy whose traps throw) is
 * reported as `false`. The walk is iterative, so the depth of a chain is no
 * failure.
 *
 * @returns `true` when nothing it visited still holds an unredacted secret;
 *   `false` when one sits where it cannot be overwritten (a frozen `cause`, a
 *   read-only or getter-only field) or the walk failed. On `false` the caller
 *   MUST NOT hand the instance on — `toError` rebuilds it like a frozen
 *   `Error` instead.
 */
export function redactErrorInPlace(root: Error): boolean {
  // Iterative throughout (work lists, no recursion): a cause chain of any
  // depth cannot overflow the stack — an overflow swallowed by `read`'s catch
  // would silently end the walk early, i.e. fail OPEN.
  const queued = new Set<object>([root]);
  const pending: Error[] = [root];
  const enqueue = (error: Error): void => {
    if (!queued.has(error)) {
      queued.add(error);
      pending.push(error);
    }
  };

  /** Plain data: a plain object / array (copied, never edited), not an `Error`. */
  const isData = (x: unknown): boolean =>
    typeof x === "object" && x !== null && !isError(x) && isPlainData(x);

  /**
   * Whether plain data holds an unredacted token, here or in the plain data
   * below it. The `Error`s it holds are queued (redacted in place), so they
   * never make it need a copy.
   */
  const holdsSecret = (data: object): boolean => {
    const seen = new Set<object>([data]);
    const todo: object[] = [data];
    let found = false;
    while (todo.length > 0) {
      const node = todo.pop() as object;
      for (const key of Object.keys(node)) {
        const value = read(node, key);
        if (typeof value === "string") {
          if (redactSecrets(value) !== value) found = true;
        } else if (typeof value === "object" && value !== null) {
          if (isError(value)) {
            enqueue(value);
          } else if (isPlainData(value) && !seen.has(value)) {
            seen.add(value);
            todo.push(value);
          }
        }
      }
    }
    return found;
  };

  /**
   * A redacted copy of plain data and of all the plain data below it — none
   * of it shared with the original, so no cycle leads back to an unredacted
   * string. `Error`s (queued) and other objects in it are kept by reference.
   * One copy per original for the whole walk (`copies`), so data reached from
   * two fields stays one object.
   */
  const copies = new Map<object, object>();
  const copyRedacted = (data: object): object => {
    const todo: object[] = [];
    const copyOf = (source: object): object => {
      let copy = copies.get(source);
      if (copy === undefined) {
        copy = Array.isArray(source) ? [] : Object.create(Object.getPrototypeOf(source)) as object;
        copies.set(source, copy);
        todo.push(source);
      }
      return copy;
    };
    const top = copyOf(data);
    while (todo.length > 0) {
      const source = todo.pop() as object;
      const copy = copies.get(source) as object;
      for (const key of Object.keys(source)) {
        const value = read(source, key);
        const next = isData(value) ? copyOf(value as object) : replacementFor(value);
        // defineProperty, not `copy[key] =`: an own `__proto__` key stays a key.
        Object.defineProperty(copy, key, { value: next, writable: true, enumerable: true, configurable: true });
      }
    }
    return top;
  };

  /** What to store in place of a field's `value`: `value` itself when nothing in it changes. */
  const replacementFor = (value: unknown): unknown => {
    if (typeof value === "string") return redactSecrets(value);
    if (typeof value !== "object" || value === null) return value;
    if (isError(value)) {
      enqueue(value);
      return value;
    }
    if (!isPlainData(value)) return value;
    return holdsSecret(value) ? copyRedacted(value) : value;
  };

  let clean = true;
  try {
    while (pending.length > 0) {
      const error = pending.pop() as Error;
      // `message` / `stack` by name too: an engine may keep `stack` on the
      // prototype (an accessor) rather than on the instance.
      const keys = new Set([...Object.getOwnPropertyNames(error), "message", "stack"]);
      for (const key of keys) {
        const current = read(error, key);
        const next = replacementFor(current);
        if (Object.is(next, current)) continue; // Object.is: a NaN field is unchanged, not unwritable
        try {
          (error as unknown as Record<string, unknown>)[key] = next;
        } catch {
          // frozen / read-only / getter-only: checked below
        }
        if (!Object.is(read(error, key), next)) clean = false;
      }
    }
  } catch {
    return false;
  }
  return clean;
}
