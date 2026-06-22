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
