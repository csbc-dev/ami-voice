import { describe, it, expect, vi } from "vitest";
import { AmiVoiceProvider } from "../src/providers/AmiVoiceProvider";
import { AmiVoiceError } from "../src/errorCodes";

/**
 * Case-B1 file recognition (`recognizeFile`) and the one-time-APPKEY mint
 * (`issueOneTimeAppKey`) drive the HTTP transport: enqueue → poll → normalize for
 * files; the issue endpoint for the direct-mode mint. The integration suite is
 * WebSocket-only, so these branches (error paths, backoff, normalization) need a
 * unit floor with an injected `fetch`.
 */

const OPTS = { engine: "-a-general", codec: "LSB16K" } as const;

/** Build a `fetch` mock that returns the given queued responses in order. */
function fetchSequence(responses: Array<{ ok?: boolean; status?: number; json?: unknown; text?: string }>) {
  let i = 0;
  return vi.fn(async () => {
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    return {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      json: async () => r.json,
      text: async () => r.text ?? "",
    };
  }) as unknown as typeof fetch;
}

describe("AmiVoiceProvider.recognizeFile (async v2)", () => {
  it("enqueues, polls until completed, and normalizes segments[].results[]", async () => {
    const fetchMock = fetchSequence([
      { json: { sessionid: "JOB-1" } },                 // enqueue
      { json: { status: "processing" } },               // poll 1
      {
        json: {
          status: "completed",
          utteranceid: "U-9",
          segments: [
            { results: [{ text: "こん", confidence: 0.8, starttime: 0, endtime: 1, tokens: [] }] },
            { results: [{ text: "にちは", confidence: 0.9, starttime: 1, endtime: 2, tokens: [] }] },
          ],
        },
      },
    ]);
    const provider = new AmiVoiceProvider({ appKey: "KEY", fetch: fetchMock, pollIntervalMs: 0 });
    const segs = await provider.recognizeFile(new Uint8Array([1, 2]), OPTS);

    expect(segs).toHaveLength(2);
    expect(segs[0].text).toBe("こん");
    expect(segs[1].text).toBe("にちは");
    // The top-level utteranceid is threaded into every flattened segment (D5).
    expect(segs[0].utteranceid).toBe("U-9");
    expect(segs[1].utteranceid).toBe("U-9");
  });

  it("sends u=<APPKEY> + d=<config> on enqueue and Authorization: Bearer <APPKEY> on poll", async () => {
    const fetchMock = fetchSequence([
      { json: { sessionid: "JOB-H" } },
      { json: { status: "completed", segments: [] } },
    ]);
    const provider = new AmiVoiceProvider({ appKey: "SECRET-KEY", fetch: fetchMock, pollIntervalMs: 0 });
    await provider.recognizeFile(new Uint8Array([1, 2]), { profileId: "p1", noLog: true, ...OPTS });

    const calls = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls;
    // enqueue (call 0): u = APPKEY, d carries engine + the conditional branches.
    const enqueueBody = (calls[0][1] as { body: FormData }).body;
    expect(enqueueBody.get("u")).toBe("SECRET-KEY");
    const d = String(enqueueBody.get("d"));
    expect(d).toContain("-a-general");
    expect(d).toContain("profileId=p1");
    expect(d).toContain("loggingOptOut=True"); // noLog must emit the opt-out
    // poll (call 1): the APPKEY rides the Bearer header (this is how it reaches AmiVoice).
    const pollInit = calls[1][1] as { headers: Record<string, string> };
    expect(pollInit.headers.Authorization).toBe("Bearer SECRET-KEY");
  });

  it("omits profileId / loggingOptOut from d when not configured", async () => {
    const fetchMock = fetchSequence([
      { json: { sessionid: "JOB-D" } },
      { json: { status: "completed", segments: [] } },
    ]);
    const provider = new AmiVoiceProvider({ appKey: "KEY", fetch: fetchMock, pollIntervalMs: 0 });
    await provider.recognizeFile(new Uint8Array([1]), OPTS);

    const calls = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const d = String((calls[0][1] as { body: FormData }).body.get("d"));
    expect(d).toBe("-a-general"); // no profileId=, no loggingOptOut
  });

  it("throws an AmiVoiceError when the enqueue HTTP call fails", async () => {
    const fetchMock = fetchSequence([{ ok: false, status: 500 }]);
    const provider = new AmiVoiceProvider({ appKey: "KEY", fetch: fetchMock });
    await expect(provider.recognizeFile(new Uint8Array([1]), OPTS)).rejects.toBeInstanceOf(AmiVoiceError);
  });

  it("throws (with the returned code/message) when the enqueue returns no sessionid", async () => {
    const fetchMock = fetchSequence([{ json: { code: "x", message: "grammar not loaded" } }]);
    const provider = new AmiVoiceProvider({ appKey: "KEY", fetch: fetchMock });
    const err = await provider.recognizeFile(new Uint8Array([1]), OPTS).catch((e) => e as AmiVoiceError);
    expect(err).toBeInstanceOf(AmiVoiceError);
    expect(err.message).toMatch(/grammar not loaded/);
    expect(err.code).toBe("no-grammar"); // mapped from the returned code "x"
  });

  it("throws with the job code when the job ends in status:error", async () => {
    const fetchMock = fetchSequence([
      { json: { sessionid: "JOB-2" } },
      { json: { status: "error", code: "?", error_message: "recognizer fatal" } },
    ]);
    const provider = new AmiVoiceProvider({ appKey: "KEY", fetch: fetchMock, pollIntervalMs: 0 });
    const err = await provider.recognizeFile(new Uint8Array([1]), OPTS).catch((e) => e as AmiVoiceError);
    expect(err).toBeInstanceOf(AmiVoiceError);
    expect(err.message).toMatch(/recognizer fatal/);
    expect(err.code).toBe("fatal");
  });

  it("maps a non-JSON enqueue body (HTTP 200) to an AmiVoiceError, not a raw SyntaxError", async () => {
    // A 200 with a truncated/HTML body must keep the normalized taxonomy
    // (`code` defined) rather than escape as a bare SyntaxError from .json().
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError("Unexpected token < in JSON"); },
      text: async () => "<html/>",
    })) as unknown as typeof fetch;
    const provider = new AmiVoiceProvider({ appKey: "KEY", fetch: fetchMock });
    const err = await provider.recognizeFile(new Uint8Array([1]), OPTS).catch((e) => e as AmiVoiceError);
    expect(err).toBeInstanceOf(AmiVoiceError);
    expect(err.message).toMatch(/non-JSON body/);
    expect(err.code).toBe("fatal"); // "?" → fatal, the normalized taxonomy
  });

  it("maps a non-JSON poll body (HTTP 200) to an AmiVoiceError", async () => {
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call++;
      if (call === 1) return { ok: true, status: 200, json: async () => ({ sessionid: "JOB-X" }), text: async () => "" };
      return { ok: true, status: 200, json: async () => { throw new SyntaxError("bad json"); }, text: async () => "" };
    }) as unknown as typeof fetch;
    const provider = new AmiVoiceProvider({ appKey: "KEY", fetch: fetchMock, pollIntervalMs: 0 });
    const err = await provider.recognizeFile(new Uint8Array([1]), OPTS).catch((e) => e as AmiVoiceError);
    expect(err).toBeInstanceOf(AmiVoiceError);
    expect(err.message).toMatch(/non-JSON body/);
  });

  it("throws when a never-completing job exceeds the poll deadline", async () => {
    const fetchMock = fetchSequence([
      { json: { sessionid: "JOB-3" } },
      { json: { status: "processing" } }, // repeats forever (sequence clamps to last)
    ]);
    const provider = new AmiVoiceProvider({
      appKey: "KEY", fetch: fetchMock, pollIntervalMs: 0, pollTimeoutMs: 0,
    });
    const err = await provider.recognizeFile(new Uint8Array([1]), OPTS).catch((e) => e as AmiVoiceError);
    expect(err).toBeInstanceOf(AmiVoiceError);
    expect(err.message).toMatch(/did not complete/);
  });
});

describe("AmiVoiceProvider.issueOneTimeAppKey", () => {
  it("uses sid/spw (not u) when a service credential is configured", async () => {
    const fetchMock = fetchSequence([{ text: "ONETIME-TOKEN" }]);
    const provider = new AmiVoiceProvider({
      appKey: "PERMANENT",
      serviceId: "svc-1",
      servicePassword: "pw-1",
      fetch: fetchMock,
    });
    const token = await provider.issueOneTimeAppKey({ epi: 30 });
    expect(token).toBe("ONETIME-TOKEN");

    const [, init] = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = (init as { body: URLSearchParams }).body;
    expect(body.get("sid")).toBe("svc-1");
    expect(body.get("spw")).toBe("pw-1");
    expect(body.has("u")).toBe(false); // permanent APPKEY NOT used when a service cred exists
  });

  it("rejects with an auth AmiVoiceError when issuance returns a non-ok HTTP status", async () => {
    const fetchMock = fetchSequence([{ ok: false, status: 403 }]);
    const provider = new AmiVoiceProvider({ appKey: "KEY", fetch: fetchMock });
    const err = await provider.issueOneTimeAppKey().catch((e) => e as AmiVoiceError);
    expect(err).toBeInstanceOf(AmiVoiceError);
    expect(err.code).toBe("auth");
  });

  it("rejects an unexpected (non-token) 200 body instead of shipping it to the browser", async () => {
    // A 200 whose body is an error/diagnostic page (contains whitespace) must not
    // be baked into `authorization=` and handed to the browser.
    const fetchMock = fetchSequence([{ text: "<html>error page</html>" }]);
    const provider = new AmiVoiceProvider({ appKey: "KEY", fetch: fetchMock });
    await expect(provider.issueOneTimeAppKey()).rejects.toBeInstanceOf(AmiVoiceError);
  });

  it("rejects an empty 200 body", async () => {
    const fetchMock = fetchSequence([{ text: "   " }]);
    const provider = new AmiVoiceProvider({ appKey: "KEY", fetch: fetchMock });
    await expect(provider.issueOneTimeAppKey()).rejects.toBeInstanceOf(AmiVoiceError);
  });
});
