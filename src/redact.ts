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
 *
 * Public on the `/server` entry only (SPEC §14), for an application's own logs
 * of strings that may hold an `s` command or its echo. It knows only the
 * `authorization=<token>` form (case-insensitive; the token runs to the next
 * whitespace) — not the APPKEY value itself, so a key in any other form passes
 * through unchanged. Idempotent: `authorization=<redacted>` stays as it is.
 */
export function redactSecrets(message: string): string {
  return message.replace(/authorization=\S+/gi, "authorization=<redacted>");
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
 * Redact every `authorization=<token>` an `Error` carries — not only in its
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
 * @returns `true` when nothing it visited still holds an unredacted token;
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
