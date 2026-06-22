import { describe, it, expect } from "vitest";
import { normaliseError } from "../src/normaliseError";

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
});
