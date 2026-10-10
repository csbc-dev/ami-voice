import { describe, it, expect } from "vitest";
import vm from "node:vm";
import { redactSecrets, redactErrorInPlace, registerKnownSecret } from "../src/redact";
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
 * The APPKEY in the forms the HTTP side of the provider sends it in (SPEC §14):
 * the async poll's `Authorization: Bearer <APPKEY>` header, the `u=<APPKEY>`
 * field of the enqueue / issuance forms, and both inside JSON — none of them
 * an `authorization=` the original rule knew. These keys are never registered
 * by value, so only the patterns are at work here.
 */
describe("redactSecrets — the HTTP forms of a credential (patterns)", () => {
  const TOKEN = "Pq7-Vx2.APPKEY_9~a+b/c==";

  it.each([
    ["the poll header", `Authorization: Bearer ${TOKEN}`, "Authorization: Bearer <redacted>"],
    ["lower case", `authorization: bearer ${TOKEN}`, "authorization: bearer <redacted>"],
    ["upper case", `AUTHORIZATION: BEARER ${TOKEN}`, "AUTHORIZATION: BEARER <redacted>"],
    ["the header value alone (a header map entry)", `Bearer ${TOKEN}`, "Bearer <redacted>"],
    ["a tab and a URL-encoded token", `Bearer\tab%2Bcd%2F12%3D%3D rejected`, "Bearer\t<redacted> rejected"],
    ["an inspected header map", `{ Authorization: 'Bearer ${TOKEN}', accept: '*/*' }`, "{ Authorization: 'Bearer <redacted>', accept: '*/*' }"],
    ["in a message", `poll failed (Bearer ${TOKEN}) after 3 tries`, "poll failed (Bearer <redacted>) after 3 tries"],
    ["after authorization=", `authorization=Bearer ${TOKEN}`, "authorization=<redacted> <redacted>"],
  ])("Bearer: %s", (_label, input, expected) => {
    expect(redactSecrets(input)).toBe(expected);
  });

  it.each([
    ["at the start of a form body", `u=${TOKEN}&d=-a-general`, "u=<redacted>&d=-a-general"],
    ["after &", `d=-a-general&u=${TOKEN}&c=LSB16K`, "d=-a-general&u=<redacted>&c=LSB16K"],
    ["at the end", `epi=30&u=${TOKEN}`, "epi=30&u=<redacted>"],
    ["in a query string", `https://acp-api.amivoice.com/v1/recognize?u=${TOKEN}&d=-a-general`, "https://acp-api.amivoice.com/v1/recognize?u=<redacted>&d=-a-general"],
    ["before a fragment", `/recognize?u=${TOKEN}#x`, "/recognize?u=<redacted>#x"],
    ["after whitespace", `body: u=${TOKEN} sent`, "body: u=<redacted> sent"],
    ["upper case", `U=${TOKEN}&d=x`, "U=<redacted>&d=x"],
    ["URL-encoded", "u=Pq7%2BVx2%2FAPPKEY%3D9&epi=30", "u=<redacted>&epi=30"],
    ["the service password", "sid=svc-1&spw=s3cr%26t&epi=30", "sid=svc-1&spw=<redacted>&epi=30"],
    ["every occurrence", `u=${TOKEN}&u=${TOKEN}`, "u=<redacted>&u=<redacted>"],
  ])("u= / spw=: %s", (_label, input, expected) => {
    expect(redactSecrets(input)).toBe(expected);
  });

  it.each([
    ["a member u", `{"u":"${TOKEN}","d":"-a-general"}`, `{"u":"<redacted>","d":"-a-general"}`],
    ["spaces around the colon", `{ "spw" : "pw-1", "sid": "svc-1" }`, `{ "spw" : "<redacted>", "sid": "svc-1" }`],
    ["a serialized header map", JSON.stringify({ headers: { Authorization: `Bearer ${TOKEN}` } }), `{"headers":{"Authorization":"<redacted>"}}`],
    ["an authorization member", `{"authorization":"${TOKEN}"}`, `{"authorization":"<redacted>"}`],
    ["a form body as a JSON string", JSON.stringify({ body: `u=${TOKEN}&epi=30` }), `{"body":"u=<redacted>&epi=30"}`],
    ["JSON inside a JSON string", JSON.stringify({ message: JSON.stringify({ u: TOKEN }) }), `{"message":"{\\"u\\":\\"<redacted>\\"}"}`],
  ])("JSON: %s", (_label, input, expected) => {
    expect(redactSecrets(input)).toBe(expected);
  });

  it("an async job reply quoting the request", () => {
    const reply = JSON.stringify({
      code: "-", message: `invalid parameter: u=${TOKEN}`, request: { headers: [["Authorization", `Bearer ${TOKEN}`]] },
    });
    expect(redactSecrets(reply)).not.toContain(TOKEN);
  });

  it.each([
    "menu=main&tofu=1&lieu=2",
    "x.u=1 a-u=2 a_u=3",
    `{"menu":"x","uu":"y","ux":"z"}`,
    "d=-a-general profileId=p1 loggingOptOut=True",
    "https://acp-api-async.amivoice.com/v2/recognitions/JOB-1",
    "connect ECONNREFUSED 10.0.0.5:443",
    "async enqueue failed (HTTP 401)",
    "Bearer",
    "Bearer\nnext line",
    "cupbearer of the king",
    "authorization header missing",
    `{"u":""}`,
  ])("leaves %j alone", (text) => {
    expect(redactSecrets(text)).toBe(text);
  });

  it("is idempotent on every form, and keeps the earlier output for authorization=", () => {
    const inputs = [
      `Authorization: Bearer ${TOKEN}`, `u=${TOKEN}&d=x`, `{"u":"${TOKEN}"}`,
      JSON.stringify({ message: JSON.stringify({ u: TOKEN }) }), `authorization=Bearer ${TOKEN}`,
      `s LSB16K -a-general authorization=${TOKEN}`,
    ];
    for (const input of inputs) {
      const once = redactSecrets(input);
      expect(once).not.toContain(TOKEN);
      expect(redactSecrets(once)).toBe(once);
    }
    expect(redactSecrets(`s LSB16K -a-general authorization=${TOKEN}`)).toBe(`s LSB16K -a-general ${REDACTED}`);
    expect(redactSecrets(`Authorization=${TOKEN}`)).toBe(REDACTED);
  });
});

/**
 * Known values: the provider (and the server helper) register the APPKEY /
 * service password they hold, and every form of that value is redacted,
 * whatever label (or none) surrounds it. Each test uses its own value — the
 * registry is process-wide and permanent.
 */
describe("redactSecrets — registered secrets (by value)", () => {
  it("redacts a registered value in any context, labelled or not", () => {
    const key = "VAL1-Pq7Vx2-APPKEY";
    expect(redactSecrets(`invalid appkey ${key}`)).toBe(`invalid appkey ${key}`); // not yet known
    registerKnownSecret(key);
    expect(redactSecrets(`invalid appkey ${key}`)).toBe("invalid appkey <redacted>");
    expect(redactSecrets(`x${key}y`)).toBe("x<redacted>y");
    expect(redactSecrets(`Content-Disposition: form-data; name="u"\r\n\r\n${key}\r\n--b`))
      .toBe(`Content-Disposition: form-data; name="u"\r\n\r\n<redacted>\r\n--b`);
    expect(redactSecrets(`{ u: '${key}' }`)).toBe("{ u: '<redacted>' }");
    expect(redactSecrets(`authorization=${key} rejected`)).toBe("authorization=<redacted> rejected");
  });

  it("redacts its URL-encoded (both escape cases, both encoders) and JSON-escaped forms", () => {
    const key = "VAL2+Pq7/Vx2=AP KEY\"x";
    registerKnownSecret(key);
    const uri = encodeURIComponent(key);
    const form = new URLSearchParams([["", key]]).toString().slice(1);
    expect(uri).not.toBe(form); // the space: %20 vs +
    const lowerHex = (s: string): string => s.replace(/%[0-9A-F]{2}/g, (h) => h.toLowerCase());
    for (const encoded of [uri, form, lowerHex(uri), lowerHex(form)]) {
      expect(redactSecrets(`issuance failed: sid=x&ipa=1&k=${encoded}&epi=30`)).toBe("issuance failed: sid=x&ipa=1&k=<redacted>&epi=30");
    }
    expect(redactSecrets(JSON.stringify({ key }))).toBe(`{"key":"<redacted>"}`);
    expect(redactSecrets(JSON.stringify({ text: `echo ${key}` }))).toBe(`{"text":"echo <redacted>"}`);
  });

  it("replaces the longer of two overlapping secrets whole", () => {
    registerKnownSecret("VAL3-ABCDEFGH");
    registerKnownSecret("VAL3-ABCDEFGH-1234");
    expect(redactSecrets("VAL3-ABCDEFGH-1234 / VAL3-ABCDEFGH")).toBe("<redacted> / <redacted>");
  });

  it("ignores what it must not register: short values, non-strings, values overlapping the placeholder", () => {
    registerKnownSecret("short7!");
    registerKnownSecret(undefined);
    registerKnownSecret(null);
    registerKnownSecret(12345678 as unknown as string);
    registerKnownSecret("redacted");
    registerKnownSecret("ted>abcd");
    registerKnownSecret("wxyz<red");
    expect(redactSecrets("short7! 12345678 redacted ted>abcd wxyz<red")).toBe("short7! 12345678 redacted ted>abcd wxyz<red");
    expect(redactSecrets("<redacted>abcd wxyz<redacted>")).toBe("<redacted>abcd wxyz<redacted>");
  });

  it("a value with no URL encoding (a lone surrogate) is still registered as it is", () => {
    const key = "VAL4-\uD800-ABCDEFGH";
    expect(() => registerKnownSecret(key)).not.toThrow();
    expect(redactSecrets(`echo ${key}`)).toBe("echo <redacted>");
  });

  it("registering a value twice changes nothing; the output stays idempotent", () => {
    const key = "VAL5-Pq7Vx2-APPKEY";
    registerKnownSecret(key);
    registerKnownSecret(key);
    const once = redactSecrets(`Authorization: Bearer ${key} / u=${encodeURIComponent(key)} / ${key}`);
    expect(once).toBe("Authorization: Bearer <redacted> / u=<redacted> / <redacted>");
    expect(redactSecrets(once)).toBe(once);
  });

  it("toError redacts it from the cause chain and plain data, where no label is left (a header map's value, a form field)", () => {
    const key = "VAL6-Pq7+Vx2/APPKEY=";
    registerKnownSecret(key);
    const request = { headers: { Authorization: `Bearer ${key}` }, form: { u: key }, body: `u=${encodeURIComponent(key)}` };
    const err = withCause(new TypeError("fetch failed"), Object.assign(new Error("POST /v2/recognitions failed"), { request }));

    expect(toError(err)).toBe(err);
    expect(leaksOfSecret(err, key)).toEqual([]);
    expect(leaksOfSecret(err, encodeURIComponent(key))).toEqual([]);
    expect(request.form.u).toBe(key); // the caller's own object is not edited
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
