import { describe, it, expect } from "vitest";
import { mapResultCode, isClientError, AmiVoiceError, getErrorCode } from "../src/errorCodes";

describe("errorCodes", () => {
  it("maps known single-character result codes", () => {
    expect(mapResultCode("-")).toBe("auth");
    expect(mapResultCode("+")).toBe("unsupported-format");
    expect(mapResultCode("%")).toBe("audio-too-large");
    expect(mapResultCode("o")).toBe("below-threshold");
    expect(mapResultCode("b")).toBe("server-busy");
    expect(mapResultCode("x")).toBe("no-grammar");
    expect(mapResultCode("!")).toBe("upstream");
    expect(mapResultCode("^")).toBe("invalid-param");
  });

  it("maps unknown codes to 'unknown'", () => {
    expect(mapResultCode("Z")).toBe("unknown");
    expect(mapResultCode("")).toBe("unknown");
  });

  it("flags the documented client-error subset", () => {
    for (const c of [">", "o", "+", "-", "%"]) expect(isClientError(c)).toBe(true);
    expect(isClientError("b")).toBe(false); // server busy is retryable
  });

  it("AmiVoiceError carries code, resultCode, and retryable", () => {
    const auth = new AmiVoiceError("-");
    expect(auth).toBeInstanceOf(Error);
    expect(auth.name).toBe("AmiVoiceError");
    expect(auth.code).toBe("auth");
    expect(auth.resultCode).toBe("-");
    expect(auth.retryable).toBe(false); // client error

    const busy = new AmiVoiceError("b", "server busy");
    expect(busy.code).toBe("server-busy");
    expect(busy.retryable).toBe(true); // not a client error
    expect(busy.message).toBe("server busy");
  });

  it("getErrorCode reads the code off an AmiVoiceError, else undefined", () => {
    expect(getErrorCode(new AmiVoiceError("-"))).toBe("auth");
    expect(getErrorCode(new Error("plain"))).toBeUndefined(); // a code-less error
    expect(getErrorCode(null)).toBeUndefined();
    expect(getErrorCode("auth")).toBeUndefined();
  });

  it("getErrorCode reads the Core's published plain SerializedError (local AND over the remote wire)", () => {
    // The shape the Core publishes on `error` in every mode (SPEC §17) — after a
    // JSON round-trip it is still the same plain object, so `code` survives relay mode.
    const wire = JSON.parse(JSON.stringify({
      name: "AmiVoiceError", message: "lost", code: "upstream", resultCode: "<", retryable: true,
    }));
    expect(getErrorCode(wire)).toBe("upstream");
    expect(getErrorCode({ name: "AmiVoiceError", message: "x", code: "unknown" })).toBe("unknown");
  });

  it("getErrorCode reads a remote-revived Error carrying the producer's code (direct-mode mint rejection)", () => {
    const revived = Object.assign(new Error("mint refused"), { name: "AmiVoiceError", code: "auth" });
    expect(getErrorCode(revived)).toBe("auth");
  });

  it("getErrorCode ignores codes outside the AmiVoice taxonomy", () => {
    expect(getErrorCode({ name: "Error", message: "t", code: "WC_BINDABLE_TIMEOUT" })).toBeUndefined();
    expect(getErrorCode(Object.assign(new Error("x"), { code: "ECONNRESET" }))).toBeUndefined();
    expect(getErrorCode({ message: "x", code: 1 })).toBeUndefined();
  });
});
