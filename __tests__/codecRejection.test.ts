import { describe, it, expect, beforeAll } from "vitest";
import { canEncodeCodec, SHELL_SUPPORTED_CODECS } from "../src/audio/pcmEncoder";
import { getErrorCode } from "../src/errorCodes";
import { AmiVoice } from "../src/components/AmiVoice";

beforeAll(() => {
  if (!customElements.get("ami-voice")) customElements.define("ami-voice", AmiVoice);
});

describe("codec support (3.3 / SPEC §13)", () => {
  it("v1 supports only LSB16K, case-insensitively", () => {
    expect(SHELL_SUPPORTED_CODECS).toEqual(["LSB16K"]);
    expect(canEncodeCodec("LSB16K")).toBe(true);
    expect(canEncodeCodec("lsb16k")).toBe(true);
  });

  it("rejects telephony / unimplemented codecs", () => {
    for (const c of ["MULAW", "ALAW", "LSB8K", "8K", "MSB16K", "ADPCM"]) {
      expect(canEncodeCodec(c), c).toBe(false);
    }
  });
});

describe("<ami-voice> start() codec rejection", () => {
  it("publishes an unsupported-format error and does NOT start for an unencodable codec", async () => {
    const el = document.createElement("ami-voice") as unknown as {
      setAttribute(n: string, v: string): void;
      codec: string;
      start(): Promise<void>;
      error: unknown;
      recognizing: boolean;
    };
    el.setAttribute("mode", "local"); // avoid any remote wiring
    el.codec = "MULAW";

    await el.start();

    expect(el.error).toBeInstanceOf(Error);
    expect(getErrorCode(el.error)).toBe("unsupported-format");
    expect((el.error as Error).message).toMatch(/MULAW/);
    expect(el.recognizing).toBe(false); // guarded before any session/mic opened
  });

  it("does NOT reject the default LSB16K codec at the guard", async () => {
    // With no `codec` set the guard resolves to LSB16K and passes; we only assert
    // the guard did not publish an unsupported-format error (a later mic/socket
    // failure in happy-dom is fine — that is past the codec gate).
    const el = document.createElement("ami-voice") as unknown as {
      setAttribute(n: string, v: string): void;
      start(): Promise<void>;
      error: unknown;
    };
    el.setAttribute("mode", "local");

    await el.start().catch(() => { /* downstream mic/socket errors are out of scope here */ });

    expect(getErrorCode(el.error)).not.toBe("unsupported-format");
  });
});
