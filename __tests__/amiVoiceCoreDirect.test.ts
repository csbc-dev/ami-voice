import { describe, it, expect } from "vitest";
import { AmiVoiceCore } from "../src/core/AmiVoiceCore";
import { AmiVoiceError } from "../src/errorCodes";
import type {
  IAmiVoiceProvider, RecognitionOptions, DirectSessionInfo,
} from "../src/types";

/**
 * Direct-mode Core (docs/adr/0006): the server-side Core is the MINT AUTHORITY.
 * `start()` returns approved-`s` + a one-time APPKEY and opens NO upstream; mint
 * failures REJECT (so they surface over `invoke("start")` to the browser).
 */
function directProvider(
  prepare: (o: RecognitionOptions, m?: { ipa?: string; epi?: number }) => Promise<DirectSessionInfo>,
): IAmiVoiceProvider {
  return {
    openRealtimeSession: async () => { throw new Error("direct mode must not open an upstream session"); },
    recognizeFile: async () => [],
    prepareDirectSession: prepare,
  };
}

describe("AmiVoiceCore direct mode", () => {
  it("returns endpoint + approved s command and opens no upstream", async () => {
    let seenMint: { ipa?: string; epi?: number } | undefined;
    const provider = directProvider(async (o, m) => {
      seenMint = m;
      return { endpoint: "wss://acp-api.amivoice.com/v1/", sCommand: `s ${o.codec} ${o.engine} authorization=OT` };
    });
    const core = new AmiVoiceCore(provider, undefined, {
      transport: "direct",
      mintOptions: () => ({ ipa: "203.0.113.7", epi: 30 }),
    });
    core.engine = "-a-general";
    core.codec = "LSB16K";

    const info = await core.start();
    expect(info).toEqual({ endpoint: "wss://acp-api.amivoice.com/v1/", sCommand: "s LSB16K -a-general authorization=OT" });
    expect(seenMint).toEqual({ ipa: "203.0.113.7", epi: 30 });

    // The server-side Core owns no session/state in direct mode.
    expect(core.connected).toBe(false);
    expect(core.recognizing).toBe(false);
    expect(core.loading).toBe(false);
  });

  it("rejects (does not publish) when the mint fails", async () => {
    const core = new AmiVoiceCore(
      directProvider(async () => { throw new AmiVoiceError("-", "mint refused"); }),
      undefined,
      { transport: "direct" },
    );
    await expect(core.start()).rejects.toThrow(/mint refused/);
    expect(core.loading).toBe(false);
    expect(core.error).toBe(null); // not published to the server-side Core's error
  });

  it("rejects when the provider cannot do direct mode", async () => {
    const provider: IAmiVoiceProvider = {
      openRealtimeSession: async () => { throw new Error("nope"); },
      recognizeFile: async () => [],
      // no prepareDirectSession
    };
    const core = new AmiVoiceCore(provider, undefined, { transport: "direct" });
    await expect(core.start()).rejects.toThrow(/direct mode/);
  });

  // A custom provider's result becomes the `start` return that crosses the
  // remote wire: the Core forwards exactly `{ endpoint, sCommand }`.
  it("returns exactly { endpoint, sCommand }, dropping a custom provider's extra keys", async () => {
    const core = new AmiVoiceCore(
      directProvider(async () => ({
        endpoint: "wss://acp-api.amivoice.com/v1/",
        sCommand: "s LSB16K -a-general authorization=OT",
        expiresAt: new Date(),
        note: undefined,
        appKey: "PERMANENT-APPKEY",
      }) as unknown as DirectSessionInfo),
      undefined,
      { transport: "direct" },
    );
    await expect(core.start()).resolves.toStrictEqual({
      endpoint: "wss://acp-api.amivoice.com/v1/",
      sCommand: "s LSB16K -a-general authorization=OT",
    });
  });

  it.each([
    ["a missing sCommand", { endpoint: "wss://x/" }, /; sCommand is undefined$/],
    ["a missing endpoint", { sCommand: "s LSB16K -a-general authorization=OT-SECRET" }, /; endpoint is undefined$/],
    ["non-string fields", { endpoint: new URL("wss://x/"), sCommand: 42 }, /; endpoint is object, sCommand is number$/],
    ["an empty field", { endpoint: "", sCommand: "s LSB16K -a-general authorization=OT-SECRET" }, /; endpoint is empty$/],
    ["null fields", { endpoint: null, sCommand: ["s"] }, /; endpoint is null, sCommand is an array$/],
    ["a non-object result", "s LSB16K -a-general authorization=OT-SECRET", /; got string$/],
    ["no result", undefined, /; got undefined$/],
  ])("rejects %s with an error naming the field — never its value", async (_label, result, reason) => {
    const core = new AmiVoiceCore(
      directProvider(async () => result as unknown as DirectSessionInfo),
      undefined,
      { transport: "direct" },
    );
    const err = await core.start().then(
      () => { throw new Error("expected a rejection"); },
      (e: unknown) => e as AmiVoiceError,
    );
    expect(err).toBeInstanceOf(AmiVoiceError);
    expect(err.code).toBe("invalid-param");
    expect(err.message).toMatch(/^prepareDirectSession\(\) must resolve \{ endpoint, sCommand \} as non-empty strings/);
    expect(err.message).toMatch(reason);
    expect(err.message).not.toContain("SECRET");
    expect(core.loading).toBe(false);
  });

  it("still defaults to relay when no transport is given (regression guard)", async () => {
    let opened = false;
    const provider: IAmiVoiceProvider = {
      openRealtimeSession: async () => {
        opened = true;
        return { feedAudio: () => {}, stop: async () => {}, abort: () => {} };
      },
      recognizeFile: async () => [],
    };
    const core = new AmiVoiceCore(provider, undefined, { mintSessionId: () => "tok" });
    const token = await core.start();
    expect(opened).toBe(true);
    expect(token).toBe("tok");
    expect(core.recognizing).toBe(true);
  });
});
