import { describe, it, expect, afterEach, vi } from "vitest";
import { createRemoteCoreProxy } from "@wc-bindable/remote";
import { bind } from "@wc-bindable/core";
import { createAmiVoiceRelayServer, type AmiVoiceServerLogEvent } from "../src/createAmiVoiceServer";
import { AmiVoiceCore } from "../src/core/AmiVoiceCore";
import { AmiVoiceProvider } from "../src/providers/AmiVoiceProvider";
import type { IAmiVoiceProvider } from "../src/types";
import type { RealtimeSocket } from "../src/protocol/realtimeSession";
import { memoryTransportPair, captureConsole, type MemoryTransportPair } from "./support/memoryTransport";
import { reachableStrings } from "./support/reachableStrings";

/**
 * The APPKEY on the HTTP side of the provider (SPEC §14): the async v2 poll
 * sends it as `Authorization: Bearer <APPKEY>`, the enqueue and the one-time
 * APPKEY issuance as the form field `u=<APPKEY>` (URL-encoded for the
 * issuance). None of these is the `authorization=` form the redaction used to
 * know, so an HTTP failure that quotes the request — a job's JSON reply, a
 * fetch error holding its request — put the permanent APPKEY into
 * `originalError`, the server log and the wire.
 *
 * Run end to end through the REAL `RemoteShellProxy` / `RemoteCoreProxy`
 * (`@wc-bindable/remote` 0.10) over the JSON-serializing in-memory transport,
 * with the real `AmiVoiceProvider` and a mocked `fetch`: the APPKEY, in any of
 * its forms, must appear in none of `originalError`, the logger's records, the
 * wire frames or the proxies' console output.
 */

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/** The permanent APPKEY — with the characters a URL / a form encodes. */
const APPKEY = "Pq7+Vx2/PERMANENT=APPKEY";
const ENCODED = encodeURIComponent(APPKEY);
/** Every form the APPKEY can take in a string: raw, URL-encoded (both escape cases). */
const FORMS = [APPKEY, ENCODED, ENCODED.replace(/%[0-9A-F]{2}/g, (h) => h.toLowerCase())];

/** The strings reachable from `roots` that hold the APPKEY in any form. */
function leaks(...roots: unknown[]): string[] {
  return roots.flatMap((root) => reachableStrings(root)).filter((s) => FORMS.some((form) => s.includes(form)));
}

interface FakeResponse { ok?: boolean; status?: number; json?: unknown; text?: string }

/** A `fetch` answering each call with the next response (the last one repeats); a function is called instead. */
function fetchSequence(steps: Array<FakeResponse | ((url: string, init?: RequestInit) => never)>): typeof fetch {
  let i = 0;
  return (async (url: string, init?: RequestInit) => {
    const step = steps[Math.min(i++, steps.length - 1)];
    if (typeof step === "function") step(url, init);
    const r = step as FakeResponse;
    return {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      json: async () => {
        if (r.json === undefined) throw new SyntaxError("Unexpected end of JSON input");
        return r.json;
      },
      text: async () => r.text ?? JSON.stringify(r.json ?? ""),
    };
  }) as unknown as typeof fetch;
}

/** An HTTP error body that echoes the request back, APPKEY and all. */
const ECHO_BODY = {
  json: { code: "-", message: `invalid u=${ENCODED}`, request: { headers: { Authorization: `Bearer ${APPKEY}` } } },
  text: `u=${ENCODED}&d=-a-general rejected (Authorization: Bearer ${APPKEY})`,
};

/** A fetch error that holds the request it failed on (as fetch wrappers do). */
function fetchFailed(url: string, init?: RequestInit): never {
  const body = init?.body instanceof URLSearchParams ? init.body.toString() : `u=${ENCODED}&d=-a-general`;
  const request = { url, headers: { Authorization: `Bearer ${APPKEY}` }, body, form: { u: APPKEY } };
  throw Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error(`request to ${url} failed: ${body}`), { request }),
  });
}

function connect(pair: MemoryTransportPair) {
  const proxy = createRemoteCoreProxy(AmiVoiceCore.wcBindable, pair.client);
  const values: Record<string, unknown> = {};
  bind(proxy, (name, value) => { values[name] = value; });
  return { proxy, values };
}

/** A relay server whose provider is the real `AmiVoiceProvider` (holding APPKEY), a client bound to it, and the log. */
function relaySetup(fetch: typeof globalThis.fetch, socketFactory?: (url: string) => RealtimeSocket) {
  const events: AmiVoiceServerLogEvent[] = [];
  const relay = createAmiVoiceRelayServer({
    createProvider: () => new AmiVoiceProvider({ appKey: APPKEY, fetch, socketFactory, pollIntervalMs: 0 }),
    logger: (e) => events.push(e),
  });
  const pair = memoryTransportPair();
  const ctrl = relay.handleControlConnection(pair.server);
  return { pair, ctrl, events, ...connect(pair) };
}

describe("file mode (relay): an HTTP failure of the async v2 job never shows the APPKEY", () => {
  it.each([
    ["enqueue: HTTP 401, the body echoing the request", [{ ok: false, status: 401, ...ECHO_BODY }], "async enqueue failed (HTTP 401)"],
    ["enqueue: HTTP 503, the body echoing the request", [{ ok: false, status: 503, ...ECHO_BODY }], "async enqueue failed (HTTP 503)"],
    [
      "enqueue: HTTP 200 without a sessionid, quoting the form",
      [{ json: { code: "-", message: `illegal service authorization: u=${ENCODED}&d=-a-general` } }],
      "illegal service authorization: u=<redacted>&d=-a-general",
    ],
    [
      "enqueue: HTTP 200 without a sessionid, echoing the bare APPKEY",
      [{ json: { code: "-", message: `APPKEY ${APPKEY} is not valid` } }],
      "APPKEY <redacted> is not valid",
    ],
    [
      "poll: status error, quoting the Authorization header",
      [{ json: { sessionid: "JOB-1" } }, { json: { status: "error", code: "-", error_message: `Authorization: Bearer ${APPKEY} rejected` } }],
      "Authorization: Bearer <redacted> rejected",
    ],
    [
      "poll: status error, the APPKEY in a JSON excerpt",
      [{ json: { sessionid: "JOB-1" } }, { json: { status: "error", code: "-", error_message: `bad request ${JSON.stringify({ u: APPKEY })}` } }],
      `bad request {"u":"<redacted>"}`,
    ],
    ["poll: HTTP 500, the body echoing the request", [{ json: { sessionid: "JOB-1" } }, { ok: false, status: 500, ...ECHO_BODY }], "async poll failed (HTTP 500)"],
    ["poll: HTTP 403, the body echoing the request", [{ json: { sessionid: "JOB-1" } }, { ok: false, status: 403, ...ECHO_BODY }], "async poll failed (HTTP 403)"],
    ["enqueue: fetch rejects, holding its request", [fetchFailed], "fetch failed"],
    ["poll: fetch rejects, holding its request", [{ json: { sessionid: "JOB-1" } }, fetchFailed], "fetch failed"],
  ] as const)("%s", async (_label, steps, message) => {
    const con = captureConsole();
    const { ctrl, pair, values, events } = relaySetup(fetchSequence([...steps]));

    await expect(ctrl.core.recognizeFile(new Uint8Array([1, 2]))).resolves.toEqual([]); // publishes, never rejects

    await vi.waitFor(() => expect(values.error).toMatchObject({ message }));
    expect(ctrl.core.error).toMatchObject({ message });
    expect(ctrl.core.originalError).toBeInstanceOf(Error);
    expect(events).toContainEqual(expect.objectContaining({ type: "error", message }));
    expect(leaks(ctrl.core.originalError)).toEqual([]);
    expect(leaks(events)).toEqual([]);
    expect(leaks(pair.wire)).toEqual([]);
    expect(leaks(con.messages())).toEqual([]);
  });

  it("the fetch error keeps its chain: same instance, the request copied without the APPKEY", async () => {
    captureConsole();
    const { ctrl } = relaySetup(fetchSequence([{ json: { sessionid: "JOB-1" } }, fetchFailed]));
    await ctrl.core.recognizeFile(new Uint8Array([1]));

    const err = ctrl.core.originalError as TypeError & { cause: Error & { request: Record<string, unknown> } };
    expect(err).toBeInstanceOf(TypeError);
    expect(err.cause.message).toBe(`request to https://acp-api-async.amivoice.com/v2/recognitions/JOB-1 failed: u=<redacted>&d=-a-general`);
    expect(err.cause.request).toStrictEqual({
      url: "https://acp-api-async.amivoice.com/v2/recognitions/JOB-1",
      headers: { Authorization: "Bearer <redacted>" },
      body: "u=<redacted>&d=-a-general",
      form: { u: "<redacted>" },
    });
  });
});

describe("direct mode: a failed one-time APPKEY issuance never shows the permanent APPKEY", () => {
  function directSetup(fetch: typeof globalThis.fetch) {
    const events: AmiVoiceServerLogEvent[] = [];
    const relay = createAmiVoiceRelayServer({
      transport: "direct",
      createProvider: () => new AmiVoiceProvider({ appKey: APPKEY, fetch }),
      logger: (e) => events.push(e),
    });
    const pair = memoryTransportPair();
    relay.handleControlConnection(pair.server);
    return { pair, events, ...connect(pair) };
  }

  it.each([
    ["HTTP 403, the body echoing the form", [{ ok: false, status: 403, ...ECHO_BODY }], "one-time APPKEY issuance failed (HTTP 403)"],
    ["HTTP 500, the body echoing the form", [{ ok: false, status: 500, ...ECHO_BODY }], "one-time APPKEY issuance failed (HTTP 500)"],
    ["fetch rejects, holding the URL-encoded form", [fetchFailed], "fetch failed"],
  ] as const)("%s", async (_label, steps, message) => {
    const con = captureConsole();
    const { proxy, pair, events } = directSetup(fetchSequence([...steps]));

    const err = await proxy.invoke("start").then(() => null, (e: unknown) => e as Error);

    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toBe(message);
    expect(events).toContainEqual(expect.objectContaining({ type: "error", message }));
    expect(leaks(err)).toEqual([]);
    expect(leaks(events)).toEqual([]);
    expect(leaks(pair.wire)).toEqual([]);
    expect(leaks(con.messages())).toEqual([]);
  });

  it("the log keeps the cause (the request), redacted", async () => {
    captureConsole();
    const { proxy, events } = directSetup(fetchSequence([fetchFailed]));
    await proxy.invoke("start").catch(() => {});

    const logged = events.find((e) => e.type === "error") as { cause: string };
    expect(JSON.parse(logged.cause)).toMatchObject({
      message: "request to https://acp-api.amivoice.com/issue_service_authorization failed: u=<redacted>&epi=10",
    });
  });
});

describe("realtime (relay) and the remote throw reply", () => {
  it("an `s` rejection echoing the bare APPKEY (no `authorization=` in front) is redacted", async () => {
    const con = captureConsole();
    const socketFactory = (): RealtimeSocket => {
      const s: RealtimeSocket = {
        send: (d) => { if (typeof d === "string" && d.startsWith("s ")) queueMicrotask(() => s.onmessage?.(`s invalid appkey ${APPKEY}`)); },
        close: () => {},
        onopen: null, onmessage: null, onclose: null, onerror: null,
      };
      queueMicrotask(() => s.onopen?.());
      return s;
    };
    const { ctrl, proxy, pair, values, events } = relaySetup(fetchSequence([{}]), socketFactory);

    await expect(proxy.invoke("start")).resolves.toBeNull();

    expect(values.error).toMatchObject({ message: "invalid appkey <redacted>" });
    expect(leaks(ctrl.core.originalError)).toEqual([]);
    expect(leaks(events)).toEqual([]);
    expect(leaks(pair.wire)).toEqual([]);
    expect(leaks(con.messages())).toEqual([]);
  });

  it("a command that throws past toError (a custom session's abort()) has its message redacted on the wire too", async () => {
    const con = captureConsole();
    const token = "CUSTOM-PROVIDER-TOKEN-9f3a";
    const relay = createAmiVoiceRelayServer({
      createProvider: () => ({
        openRealtimeSession: async () => ({
          feedAudio() {}, async stop() {},
          abort() { throw new Error(`teardown failed: Authorization: Bearer ${token} / u=${token}`); },
        }),
        recognizeFile: async () => [],
      }),
    });
    const pair = memoryTransportPair();
    relay.handleControlConnection(pair.server);
    const { proxy } = connect(pair);
    await proxy.invoke("start");

    const err = await proxy.invoke("abort").then(() => null, (e: unknown) => e as Error);

    expect(err!.message).toBe("teardown failed: Authorization: Bearer <redacted> / u=<redacted>");
    expect(pair.wire.join("\n")).not.toContain(token);
    expect(con.messages().join("\n")).not.toContain(token);
  });

  it("the server helper registers AMIVOICE_APPKEY too: a custom provider echoing it bare is redacted", async () => {
    const con = captureConsole();
    const envKey = "ENV-APPKEY-7f3a9c2e";
    vi.stubEnv("AMIVOICE_APPKEY", envKey);
    const events: AmiVoiceServerLogEvent[] = [];
    const provider: IAmiVoiceProvider = {
      openRealtimeSession: async () => { throw new Error(`upstream refused key ${envKey}`); },
      recognizeFile: async () => [],
    };
    const relay = createAmiVoiceRelayServer({ createProvider: () => provider, logger: (e) => events.push(e) });
    const pair = memoryTransportPair();
    const ctrl = relay.handleControlConnection(pair.server);
    const { proxy, values } = connect(pair);

    await proxy.invoke("start");

    expect(values.error).toMatchObject({ message: "upstream refused key <redacted>" });
    const all = [ctrl.core.originalError, events, pair.wire, con.messages()].flatMap((r) => reachableStrings(r));
    expect(all.filter((s) => s.includes(envKey))).toEqual([]);
  });
});
