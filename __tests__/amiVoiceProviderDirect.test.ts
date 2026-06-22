import { describe, it, expect, vi } from "vitest";
import { AmiVoiceProvider } from "../src/providers/AmiVoiceProvider";

/**
 * Direct-mode mint (docs/adr/0006): `prepareDirectSession` issues a one-time
 * APPKEY and builds the approved `s` command for a browser to open the AmiVoice
 * WSS itself. The PERMANENT APPKEY must never appear in the returned command.
 */
describe("AmiVoiceProvider.prepareDirectSession", () => {
  function fakeFetch(token: string) {
    return vi.fn(async () => ({
      ok: true,
      text: async () => token,
    })) as unknown as typeof fetch;
  }

  it("mints a one-time token and bakes it (not the permanent APPKEY) into the s command", async () => {
    const fetchMock = fakeFetch("ONETIME-TOKEN");
    const provider = new AmiVoiceProvider({
      appKey: "PERMANENT-APPKEY",
      issueEndpoint: "https://issue.test/auth",
      fetch: fetchMock,
    });

    const info = await provider.prepareDirectSession(
      { engine: "-a-general", codec: "LSB16K" },
      { ipa: "203.0.113.7", epi: 30 },
    );

    expect(info.endpoint).toBe("wss://acp-api.amivoice.com/v1/");
    expect(info.sCommand).toBe("s LSB16K -a-general authorization=ONETIME-TOKEN");
    // The permanent APPKEY must NOT leak into anything handed to the browser.
    expect(info.sCommand).not.toContain("PERMANENT-APPKEY");

    // The mint request hit the issue endpoint with ipa + epi bound.
    const [url, init] = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://issue.test/auth");
    const body = (init as { body: URLSearchParams }).body;
    expect(body.get("ipa")).toBe("203.0.113.7");
    expect(body.get("epi")).toBe("30");
    expect(body.get("u")).toBe("PERMANENT-APPKEY"); // permanent key authorizes the mint, server-side only
  });

  it("uses the no-logging endpoint when noLog is set", async () => {
    const provider = new AmiVoiceProvider({ appKey: "K", fetch: fakeFetch("T") });
    const info = await provider.prepareDirectSession({ engine: "-a-general", codec: "LSB16K", noLog: true });
    expect(info.endpoint).toBe("wss://acp-api.amivoice.com/v1/nolog/");
  });

  it("propagates approved s-params into the built command", async () => {
    const provider = new AmiVoiceProvider({ appKey: "K", fetch: fakeFetch("T") });
    const info = await provider.prepareDirectSession({
      engine: "-a-general",
      codec: "LSB16K",
      profileId: "p1",
      resultUpdatedInterval: 1000,
    });
    expect(info.sCommand).toBe("s LSB16K -a-general profileId=p1 resultUpdatedInterval=1000 authorization=T");
  });

  it("degrades to no ipa when the peer address is unknown", async () => {
    const fetchMock = fakeFetch("T");
    const provider = new AmiVoiceProvider({ appKey: "K", fetch: fetchMock });
    await provider.prepareDirectSession({ engine: "-a-general", codec: "LSB16K" }, { epi: 10 });
    const [, init] = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = (init as { body: URLSearchParams }).body;
    expect(body.has("ipa")).toBe(false);
    expect(body.get("epi")).toBe("10");
  });
});
