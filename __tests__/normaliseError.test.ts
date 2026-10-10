import { describe, it, expect } from "vitest";
import { isJsonValue } from "@wc-bindable/remote";
import { normaliseError, toSerializedError, toError } from "../src/normaliseError";
import { AmiVoiceError } from "../src/errorCodes";
import type { SerializedError } from "../src/types";

describe("normaliseError", () => {
  it("collapses null / undefined to null", () => {
    expect(normaliseError(null)).toBeNull();
    expect(normaliseError(undefined)).toBeNull();
  });

  it("returns a real Error instance unchanged", () => {
    const e = new Error("boom");
    expect(normaliseError(e)).toBe(e);
  });

  it("coerces a serialized {name,message,stack} object (cross-realm wire shape)", () => {
    expect(normaliseError({ name: "Foo", message: "bar", stack: "trace" }))
      .toEqual({ name: "Foo", message: "bar", stack: "trace" });
  });

  it("defaults name to 'Error' and OMITS stack (never `stack: undefined`) for a bare {message}", () => {
    // An `undefined` member makes the whole value a non-JsonValue, which
    // @wc-bindable/remote >= 0.10 refuses to send — so the key must be absent.
    const out = normaliseError({ message: "m" });
    expect(out).toStrictEqual({ name: "Error", message: "m" });
    expect(isJsonValue(out)).toBe(true);
  });

  it("carries code/resultCode/retryable from a plain-object rejection", () => {
    expect(normaliseError({ name: "AmiVoiceError", message: "m", code: "auth", resultCode: "-", retryable: false }))
      .toStrictEqual({ name: "AmiVoiceError", message: "m", code: "auth", resultCode: "-", retryable: false });
  });

  it("wraps a non-error value as Error(String(v))", () => {
    expect(normaliseError("oops")).toBeInstanceOf(Error);
    expect((normaliseError("oops") as Error).message).toBe("oops");
    expect((normaliseError(42) as Error).message).toBe("42");
  });

  it("redacts an authorization=<APPKEY> echo from an Error message + stack (wire path)", () => {
    // A non-ok upstream `s` ack echoes the raw command, which ends in the
    // permanent APPKEY; this value becomes the bound `error` that crosses the
    // remote wire to the browser, so the APPKEY must be scrubbed (SPEC §14).
    const e = new Error("s LSB16K -a-general authorization=PERMANENT-APPKEY rejected");
    e.stack = "Error: authorization=PERMANENT-APPKEY\n  at x";
    const out = normaliseError(e) as Error;
    expect(out.message).toContain("authorization=<redacted>");
    expect(out.message).not.toContain("PERMANENT-APPKEY");
    expect(out.stack).not.toContain("PERMANENT-APPKEY");
  });

  it("redacts an authorization=<APPKEY> echo from a serialized wire-shape error", () => {
    const out = normaliseError({
      name: "AmiVoiceError",
      message: "authorization=PERMANENT-APPKEY",
    }) as { message: string };
    expect(out.message).toBe("authorization=<redacted>");
  });

  it("redacts an AmiVoiceError in place WITHOUT losing code/retryable/resultCode (subclass survives)", () => {
    // The load-bearing cycle-2 invariant: the in-place message/stack scrub must
    // preserve the AmiVoiceError subclass fields downstream code relies on
    // (error.code === 'auth', error.retryable, error.resultCode). A future
    // refactor that rebuilt the Error (e.g. `new Error(redacted)`) would drop
    // these and pass every OTHER test — this pins them as one unit.
    const e = new AmiVoiceError("-", "s LSB16K -a-general authorization=PERMANENT rejected");
    const out = normaliseError(e) as AmiVoiceError;
    expect(out).toBe(e); // same instance — mutated, not rebuilt
    expect(out.message).toContain("authorization=<redacted>");
    expect(out.message).not.toContain("PERMANENT");
    expect(out.code).toBe("auth");
    expect(out.retryable).toBe(false);
    expect(out.resultCode).toBe("-");
  });

  it("redacts a frozen Error without throwing, falling back to a serialized shape", () => {
    // A hardened / frozen Error (e.g. from a custom provider) cannot be mutated
    // under strict mode; normaliseError must still redact (never leak the APPKEY)
    // and never escape as an uncaught TypeError.
    const e = Object.freeze(new Error("authorization=PERMANENT-APPKEY"));
    const out = normaliseError(e) as { name: string; message: string };
    expect(out.message).toBe("authorization=<redacted>");
    expect(out.message).not.toContain("PERMANENT-APPKEY");
    expect(out.name).toBe("Error");
  });

  it("keeps an AmiVoiceError's code/resultCode/retryable in the frozen-Error fallback", () => {
    const e = Object.freeze(new AmiVoiceError("-", "authorization=PERMANENT-APPKEY"));
    const out = normaliseError(e) as SerializedError;
    expect(out).toMatchObject({
      name: "AmiVoiceError", message: "authorization=<redacted>", code: "auth", resultCode: "-", retryable: false,
    });
    expect(Object.values(out)).not.toContain(undefined);
  });
});

/**
 * `toSerializedError` shapes the CORE's published `error` (getter + emitted
 * detail). It must ALWAYS be a strict JsonValue — remote >= 0.10 drops a
 * non-JsonValue `update` and lists it in `sync.getterFailures` — and it is a
 * redaction choke-point because in relay mode it crosses to the browser.
 */
describe("toSerializedError", () => {
  it("collapses null / undefined to null", () => {
    expect(toSerializedError(null)).toBeNull();
    expect(toSerializedError(undefined)).toBeNull();
  });

  it("turns an AmiVoiceError into a plain {name,message,code,resultCode,retryable} — no stack, no undefined", () => {
    const out = toSerializedError(new AmiVoiceError("b", "server busy"));
    expect(out).toStrictEqual({
      name: "AmiVoiceError", message: "server busy", code: "server-busy", resultCode: "b", retryable: true,
    });
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(isJsonValue(out)).toBe(true);
  });

  it("turns a plain Error into {name,message} (no stack)", () => {
    const e = new TypeError("bad");
    expect(toSerializedError(e)).toStrictEqual({ name: "TypeError", message: "bad" });
  });

  it("keeps any string `code` (e.g. a remote WC_BINDABLE_* code) but drops non-JSON members", () => {
    const e = Object.assign(new Error("timed out"), { code: "WC_BINDABLE_TIMEOUT", resultCode: 7, cause: new Date() });
    expect(toSerializedError(e)).toStrictEqual({ name: "Error", message: "timed out", code: "WC_BINDABLE_TIMEOUT" });
  });

  it("normalizes a {name,message,stack: undefined} object without the undefined key", () => {
    const out = toSerializedError({ name: "X", message: "m", stack: undefined });
    expect(out).toStrictEqual({ name: "X", message: "m" });
    expect(isJsonValue(out)).toBe(true);
  });

  it("wraps a non-error value as {name:'Error', message:String(v)}", () => {
    expect(toSerializedError("oops")).toStrictEqual({ name: "Error", message: "oops" });
    expect(toSerializedError(42)).toStrictEqual({ name: "Error", message: "42" });
  });

  it("redacts an authorization=<APPKEY> echo (the value crosses to the browser in relay mode)", () => {
    const out = toSerializedError(new AmiVoiceError("", "s LSB16K -a-general authorization=PERMANENT-APPKEY rejected"));
    expect(out!.message).toBe("s LSB16K -a-general authorization=<redacted> rejected");
    expect(JSON.stringify(out)).not.toContain("PERMANENT-APPKEY");
  });

  it("never throws on a hostile value (the Core's publish-not-reject path must hold)", () => {
    const hostile = { get message(): string { throw new Error("trap"); } };
    expect(toSerializedError(hostile)).toStrictEqual({ name: "Error", message: "unserializable error value" });
  });
});

/**
 * `toError` shapes the direct-mode mint rejection. Remote >= 0.10 canonicalises
 * a NON-Error throw to `NonErrorThrow` with message "[object Object]", so the
 * thrown value must always be an Error carrying the original name/message/code.
 */
describe("toError", () => {
  it("returns a real Error unchanged (redacted in place)", () => {
    const e = new AmiVoiceError("-", "authorization=PERMANENT-APPKEY");
    const out = toError(e);
    expect(out).toBe(e);
    expect(out.message).toBe("authorization=<redacted>");
  });

  it("rebuilds a frozen AmiVoiceError as an Error keeping name/message/code/resultCode/retryable", () => {
    const out = toError(Object.freeze(new AmiVoiceError("-", "mint refused authorization=PERMANENT-APPKEY"))) as
      Error & SerializedError;
    expect(out).toBeInstanceOf(Error);
    expect(out.name).toBe("AmiVoiceError");
    expect(out.message).toBe("mint refused authorization=<redacted>");
    expect(out.code).toBe("auth");
    expect(out.resultCode).toBe("-");
    expect(out.retryable).toBe(false);
    expect(out.stack).not.toContain("PERMANENT-APPKEY");
  });

  it("rebuilds a plain-object rejection as an Error (no '[object Object]')", () => {
    const out = toError({ message: "mint refused", code: "auth" }) as Error & SerializedError;
    expect(out).toBeInstanceOf(Error);
    expect(out.name).toBe("Error");
    expect(out.message).toBe("mint refused");
    expect(out.code).toBe("auth");
    expect("resultCode" in out).toBe(false);
  });

  it("wraps a thrown primitive / null as an Error", () => {
    expect(toError("oops").message).toBe("oops");
    expect(toError(null)).toBeInstanceOf(Error);
  });
});
