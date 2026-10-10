import { describe, it, expect } from "vitest";
import vm from "node:vm";
import { redactSecrets, redactErrorInPlace } from "../src/redact";
import { toError, toSerializedError } from "../src/normaliseError";
import { AmiVoiceError } from "../src/errorCodes";
import type { SerializedError } from "../src/types";
import { leaksOf as leaksOfSecret } from "./support/reachableStrings";

const KEY = "PERMANENT-APPKEY";
const LEAK = `authorization=${KEY}`;
const REDACTED = "authorization=<redacted>";

/** Set `cause` the way `new Error(msg, { cause })` does (own, non-enumerable). */
function withCause<E extends Error>(error: E, cause: unknown): E & { cause: unknown } {
  Object.defineProperty(error, "cause", { value: cause, writable: true, enumerable: false, configurable: true });
  return error as E & { cause: unknown };
}

/** The APPKEY wherever an error tracker could read it off `root`. */
const leaksOf = (root: unknown): string[] => leaksOfSecret(root, KEY);

describe("redactSecrets", () => {
  it("replaces every authorization=<token>, case-insensitively, up to the next whitespace", () => {
    expect(redactSecrets(`s LSB16K -a-general ${LEAK}`)).toBe(`s LSB16K -a-general ${REDACTED}`);
    expect(redactSecrets(`Authorization=${KEY} and AUTHORIZATION=other next`))
      .toBe(`${REDACTED} and ${REDACTED} next`);
  });

  it("is idempotent and leaves other text alone", () => {
    expect(redactSecrets(REDACTED)).toBe(REDACTED);
    expect(redactSecrets("connect ECONNREFUSED 10.0.0.5:443")).toBe("connect ECONNREFUSED 10.0.0.5:443");
  });
});

/**
 * `toError` — and so `AmiVoiceCore.originalError` — redacts the APPKEY from the
 * WHOLE Error (SPEC §14): `message` / `stack`, every `cause` in the chain, and
 * the extra fields. In place, keeping the instance; an Error it cannot clean
 * that way is rebuilt like a frozen one. It never throws on the way.
 */
describe("toError — the APPKEY is redacted from the cause chain and the extra fields", () => {
  it("redacts a multi-level chain (Error → Error → plain object → string) and the extra fields, in place", () => {
    const tail = { reason: `upstream said ${LEAK}`, cause: `raw frame ${LEAK}` }; // a non-Error cause
    const level2 = withCause(new Error(`retry failed ${LEAK}`), tail);
    const level1 = withCause(new TypeError(`socket error ${LEAK}`), level2);
    const err = withCause(Object.assign(new AmiVoiceError("-", `rejected ${LEAK}`), {
      command: `s LSB16K -a-general ${LEAK}`,
      diag: { request: { line: LEAK, attempt: 2 }, frames: [LEAK, 1, null] },
      elapsed: NaN,
    }), level1);

    const out = toError(err) as typeof err;

    // Same instances all the way down: class, code, chain.
    expect(out).toBe(err);
    expect(out).toBeInstanceOf(AmiVoiceError);
    expect(out).toMatchObject({ name: "AmiVoiceError", code: "auth", resultCode: "-", retryable: false });
    expect(out.cause).toBe(level1);
    expect(level1.cause).toBe(level2);
    // Every level's message and stack.
    expect(out.message).toBe(`rejected ${REDACTED}`);
    expect(level1.message).toBe(`socket error ${REDACTED}`);
    expect(level2.message).toBe(`retry failed ${REDACTED}`);
    for (const e of [out, level1, level2]) expect(e.stack).not.toContain(KEY);
    // The non-Error tail and the extra fields.
    expect(level2.cause).toStrictEqual({ reason: `upstream said ${REDACTED}`, cause: `raw frame ${REDACTED}` });
    expect(out.command).toBe(`s LSB16K -a-general ${REDACTED}`);
    expect(out.diag).toStrictEqual({ request: { line: REDACTED, attempt: 2 }, frames: [REDACTED, 1, null] });
    expect(out.elapsed).toBeNaN();
    expect(leaksOf(out)).toEqual([]);
    // The wire projection of it is clean too.
    expect(JSON.stringify(toSerializedError(out))).not.toContain(KEY);
  });

  it("replaces plain data holding a secret with a redacted copy — the provider's own object is not edited", () => {
    const providerState = { endpoint: "wss://acp-api.amivoice.com/v1/", lastCommand: `s LSB16K ${LEAK}` };
    const clean = { attempt: 1 };
    const err = Object.assign(new Error("start failed"), { state: providerState, meta: clean });

    expect(toError(err)).toBe(err);

    expect(err.state).not.toBe(providerState);
    expect(err.state).toStrictEqual({ endpoint: providerState.endpoint, lastCommand: `s LSB16K ${REDACTED}` });
    expect(providerState.lastCommand).toBe(`s LSB16K ${LEAK}`); // still usable by the provider
    expect(err.meta).toBe(clean); // nothing to redact: not copied
  });

  it("copies null-prototype data like any plain object; leaves class instances alone", () => {
    const bare = Object.assign(Object.create(null) as Record<string, unknown>, { line: LEAK });
    class Connection { constructor(readonly url: string) {} }
    const conn = new Connection(`wss://example/?${LEAK}`);
    const when = new Date(0);
    const err = Object.assign(new Error("start failed"), { bare, conn, when, list: [conn, bare] });

    expect(toError(err)).toBe(err);

    expect(err.bare).not.toBe(bare);
    expect(Object.getPrototypeOf(err.bare)).toBeNull();
    expect({ ...err.bare }).toStrictEqual({ line: REDACTED });
    expect(err.conn).toBe(conn); // not walked (SPEC §14 limits)
    expect(err.when).toBe(when);
    expect(err.list[0]).toBe(conn);
    expect(err.list[1]).toBe(err.bare); // one copy per original, wherever it is reached from
  });

  it("terminates on cycles: a cause chain that loops, plain data pointing at itself and back at the Error", () => {
    const a = new Error(`a ${LEAK}`);
    const b = withCause(new Error(`b ${LEAK}`), a);
    withCause(a, b);
    const data: Record<string, unknown> = { note: LEAK };
    data.self = data;
    data.owner = a;
    Object.assign(a, { data });

    expect(toError(a)).toBe(a);

    expect((a as Error & { cause: unknown }).cause).toBe(b);
    expect(b.cause).toBe(a);
    const copy = (a as Error & { data: Record<string, unknown> }).data;
    expect(copy).not.toBe(data);
    expect(copy.self).toBe(copy); // the copy keeps the shape, without a way back to the original
    expect(copy.owner).toBe(a);
    expect(copy.note).toBe(REDACTED);
    expect(leaksOf(a)).toEqual([]);
  });

  it("reaches Errors held in fields (AggregateError.errors) and Errors from another realm", () => {
    const foreign = vm.runInNewContext(`new Error("foreign ${LEAK}")`) as Error;
    expect(foreign instanceof Error).toBe(false);
    const inner = new Error(`inner ${LEAK}`);
    const agg = new AggregateError([inner, foreign], `all failed ${LEAK}`);
    const errors = agg.errors;

    expect(toError(agg)).toBe(agg);

    expect(agg.errors).toBe(errors); // the array itself holds no string: not copied
    expect(agg.errors[0]).toBe(inner);
    expect(agg.errors[1]).toBe(foreign);
    expect(inner.message).toBe(`inner ${REDACTED}`);
    expect(foreign.message).toBe(`foreign ${REDACTED}`);
    expect(leaksOf(agg)).toEqual([]);
  });

  it("redacts a cause from another realm too", () => {
    const err = withCause(new Error("start failed"), vm.runInNewContext(`new RangeError("bad ${LEAK}")`));
    expect(toError(err)).toBe(err);
    expect(leaksOf(err)).toEqual([]);
  });

  it("keeps the instance when what it cannot overwrite holds no secret (a frozen cause without one)", () => {
    const cause = Object.freeze(new Error("connect ECONNREFUSED 10.0.0.5:443"));
    const err = withCause(new Error(`start failed ${LEAK}`), cause);

    expect(toError(err)).toBe(err);
    expect(err.cause).toBe(cause);
    expect(err.message).toBe(`start failed ${REDACTED}`);
  });

  it.each([
    ["a frozen cause", (e: Error) => withCause(e, Object.freeze(new Error(`frozen ${LEAK}`)))],
    ["a read-only field", (e: Error) => Object.defineProperty(e, "diag", { value: LEAK, enumerable: true })],
    ["a getter-only field", (e: Error) => Object.defineProperty(e, "diag", { get: () => LEAK, enumerable: true })],
    ["a frozen Error inside a field", (e: Error) => Object.assign(e, { history: [Object.freeze(new Error(LEAK))] })],
  ])("rebuilds the Error when a secret sits where it cannot be overwritten: %s", (_label, attach) => {
    const err = attach(new AmiVoiceError("b", `busy ${LEAK}`));

    const out = toError(err) as Error & SerializedError;

    expect(out).not.toBe(err);
    expect(out).toBeInstanceOf(Error);
    expect(out).toMatchObject({
      name: "AmiVoiceError", message: `busy ${REDACTED}`, code: "server-busy", resultCode: "b", retryable: true,
    });
    expect(out.stack).toContain(REDACTED);
    expect(Object.getOwnPropertyNames(out)).not.toContain("cause");
    expect(Object.getOwnPropertyNames(out)).not.toContain("diag");
    expect(leaksOf(out)).toEqual([]);
  });

  it("a rebuilt Error whose original had no string stack gets a fresh one, still clean", () => {
    const err = withCause(new Error(`no stack ${LEAK}`), Object.freeze(new Error(LEAK)));
    (err as { stack?: string }).stack = undefined;

    const out = toError(err);

    expect(out).not.toBe(err);
    expect(out.message).toBe(`no stack ${REDACTED}`);
    expect(typeof out.stack).toBe("string");
    expect(leaksOf(out)).toEqual([]);
  });

  it("a frozen plain-object cause is fine when its owner can take a redacted copy", () => {
    const cause = Object.freeze({ detail: LEAK, nested: Object.freeze({ more: LEAK }) });
    const err = withCause(new Error("start failed"), cause);

    expect(toError(err)).toBe(err);
    expect(err.cause).toStrictEqual({ detail: REDACTED, nested: { more: REDACTED } });
  });

  it("never throws on hostile members: a throwing getter, a throwing proxy", () => {
    const trap = (): never => { throw new Error("trap"); };
    const getter = Object.defineProperty(new Error(`getter ${LEAK}`), "diag", { get: trap, enumerable: true });
    expect(toError(getter)).toBe(getter); // a getter that throws shows nothing to anyone
    expect(getter.message).toBe(`getter ${REDACTED}`);

    const proxied = withCause(new Error(`proxy ${LEAK}`), new Proxy({}, { ownKeys: trap }));
    let out: Error | undefined;
    expect(() => { out = toError(proxied); }).not.toThrow();
    expect(out).not.toBe(proxied); // could not be inspected: fail closed, rebuilt
    expect(out!.message).toBe(`proxy ${REDACTED}`);
    expect(leaksOf(out)).toEqual([]);
  });

  it("walks a chain of any depth without overflowing — the secret at the bottom is redacted too", () => {
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = 0; // keep 50 000 Errors cheap
    let deep: Error;
    try {
      deep = new Error(`bottom ${LEAK}`);
      for (let i = 0; i < 50_000; i++) deep = withCause(new Error("level"), deep);
    } finally {
      Error.stackTraceLimit = limit;
    }

    let out: Error | undefined;
    expect(() => { out = toError(deep); }).not.toThrow();
    expect(out).toBe(deep); // walked to the end, not given up on
    expect(leaksOf(out)).toEqual([]);
  });

  it("reports what it could not clean (redactErrorInPlace)", () => {
    expect(redactErrorInPlace(withCause(new Error("x"), `c ${LEAK}`))).toBe(true);
    expect(redactErrorInPlace(withCause(new Error("x"), Object.freeze(new Error(LEAK))))).toBe(false);
  });

  it("name / code / resultCode are redacted in the rebuilt Error and in the wire projection", () => {
    const frozen = Object.freeze(Object.assign(new Error("m"), { name: `N ${LEAK}`, code: `C ${LEAK}`, resultCode: LEAK }));
    expect(leaksOf(toError(frozen))).toEqual([]);
    expect(toSerializedError(frozen)).toStrictEqual({
      name: `N ${REDACTED}`, message: "m", code: `C ${REDACTED}`, resultCode: REDACTED,
    });
    const plain = toError({ name: `N ${LEAK}`, message: "m", code: `C ${LEAK}` });
    expect(leaksOf(plain)).toEqual([]);
    expect(plain.name).toBe(`N ${REDACTED}`);
  });
});
