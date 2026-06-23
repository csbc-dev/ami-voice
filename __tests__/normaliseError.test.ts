import { describe, it, expect } from "vitest";
import { normaliseError } from "../src/normaliseError";
import { AmiVoiceError } from "../src/errorCodes";

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

  it("defaults name to 'Error' and stack to undefined for a bare {message}", () => {
    expect(normaliseError({ message: "m" }))
      .toEqual({ name: "Error", message: "m", stack: undefined });
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
});
