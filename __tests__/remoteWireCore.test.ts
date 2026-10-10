import { describe, it, expect, afterEach, vi } from "vitest";
import {
  createRemoteCoreProxy, RemoteShellProxy, isJsonValue,
} from "@wc-bindable/remote";
import { bind } from "@wc-bindable/core";
import { createAmiVoiceRelayServer, type AmiVoiceServerLogEvent } from "../src/createAmiVoiceServer";
import { AmiVoiceCore } from "../src/core/AmiVoiceCore";
import { AmiVoiceProvider } from "../src/providers/AmiVoiceProvider";
import { AmiVoiceError, getErrorCode } from "../src/errorCodes";
import { DirectBrowserProvider } from "../src/components/realtimeSocket";
import type {
  IAmiVoiceProvider, IRealtimeSession, RealtimeSessionHandlers, RecognitionSegment, DirectSessionInfo,
} from "../src/types";
import { memoryTransportPair, captureConsole, scriptedUpstream, type MemoryTransportPair } from "./support/memoryTransport";
import { leaksOf } from "./support/reachableStrings";

/**
 * Regression suite for `@wc-bindable/remote` 0.10's strict JsonValue gate, run
 * through the REAL `RemoteShellProxy` (producer) and `RemoteCoreProxy`
 * (consumer) over a JSON-serializing in-memory transport.
 *
 * 0.10 DROPS a non-JsonValue property `update` (with a warning) and lists it in
 * `sync.getterFailures`; it turns a non-Error throw into `NonErrorThrow`
 * ("[object Object]"). Before the fix the Core published `AmiVoiceError`
 * instances on `error`, so in relay mode the browser never saw a start failure
 * or an upstream drop (SPEC §10.1 / §17) — the happy-path e2e could not catch it.
 */

afterEach(() => { vi.restoreAllMocks(); });

function connectClient(pair: MemoryTransportPair) {
  const proxy = createRemoteCoreProxy(AmiVoiceCore.wcBindable, pair.client);
  const values: Record<string, unknown> = {};
  const unbind = bind(proxy, (name, value) => { values[name] = value; });
  return { proxy, values, unbind };
}

/** A provider whose start fails with `err` (thrown from openRealtimeSession). */
function failingProvider(err: unknown): IAmiVoiceProvider {
  return {
    openRealtimeSession: async () => { throw err; },
    recognizeFile: async () => [],
  };
}

const AUTH_ERROR = {
  name: "AmiVoiceError",
  message: "illegal service authorization",
  code: "auth",
  resultCode: "-",
  retryable: false,
};

describe("relay: the Core's `error` crosses @wc-bindable/remote 0.10 (update + sync)", () => {
  it("update path: a provider start failure reaches the client as the real cause", async () => {
    const con = captureConsole();
    const relay = createAmiVoiceRelayServer({
      createProvider: () => failingProvider(new AmiVoiceError("-", "illegal service authorization")),
    });
    const pair = memoryTransportPair();
    relay.handleControlConnection(pair.server);
    const { proxy, values } = connectClient(pair);

    // SPEC §17: start() does not reject; it publishes to `error`.
    await expect(proxy.invoke("start")).resolves.toBeNull();

    // The `error` update precedes the `return` on the ordered channel.
    expect(values.error).toStrictEqual(AUTH_ERROR);
    expect(getErrorCode(values.error)).toBe("auth");
    expect(values.loading).toBe(false);
    expect(values.recognizing).toBe(false);
    expect(con.wireDrops()).toEqual([]); // no "dropped update for \"error\""
  });

  it("update path: an upstream `s` rejection echoing the APPKEY arrives redacted (SPEC §14)", async () => {
    const con = captureConsole();
    const upstream = scriptedUpstream({ rejectStart: true });
    const relay = createAmiVoiceRelayServer({
      createProvider: () => new AmiVoiceProvider({ appKey: "PERMANENT-APPKEY", socketFactory: upstream.socketFactory }),
    });
    const pair = memoryTransportPair();
    relay.handleControlConnection(pair.server);
    const { proxy, values } = connectClient(pair);

    await expect(proxy.invoke("start")).resolves.toBeNull();

    expect(values.error).toStrictEqual({
      name: "AmiVoiceError",
      message: "rejected: s LSB16K -a-general authorization=<redacted>",
      code: "unknown",
      resultCode: "",
      retryable: true,
    });
    expect(pair.wire.join("\n")).not.toContain("PERMANENT-APPKEY");
    expect(con.wireDrops()).toEqual([]);
  });

  it("sync path: a client that attaches AFTER the failure still receives the cause", async () => {
    const con = captureConsole();
    const relay = createAmiVoiceRelayServer({
      createProvider: () => failingProvider(new AmiVoiceError("-", "illegal service authorization")),
    });
    const pair = memoryTransportPair();
    const ctrl = relay.handleControlConnection(pair.server);
    await ctrl.core.start(); // fails server-side before any client is bound

    const { values } = connectClient(pair);
    await vi.waitFor(() => expect(values.error).toStrictEqual(AUTH_ERROR));

    // `sync` carried the value itself — not a `getterFailures` entry.
    const sync = pair.wire.filter((f) => f.startsWith("S:")).map((f) => JSON.parse(f.slice(2)))
      .find((m) => m.type === "sync");
    expect(sync.values.error).toStrictEqual(AUTH_ERROR);
    expect(sync.getterFailures).toBeUndefined();
    expect(con.wireDrops()).toEqual([]);
  });

  it("upstream drop (SPEC §10.1): `error`=upstream + connected/recognizing=false reach the client; transcript kept", async () => {
    const con = captureConsole();
    const upstream = scriptedUpstream();
    const relay = createAmiVoiceRelayServer({
      createProvider: () => new AmiVoiceProvider({ appKey: "K", socketFactory: upstream.socketFactory }),
    });
    const pair = memoryTransportPair();
    const ctrl = relay.handleControlConnection(pair.server);
    const { proxy, values } = connectClient(pair);

    expect(typeof await proxy.invoke("start")).toBe("string");
    upstream.final("こんにちは");
    await vi.waitFor(() => expect(values.transcript).toBe("こんにちは"));

    upstream.drop(); // unsolicited close mid-session
    const expected = {
      name: "AmiVoiceError",
      message: "AmiVoice connection lost mid-session",
      code: "upstream",
      resultCode: "<",
      retryable: true,
    };
    await vi.waitFor(() => expect(values.error).toStrictEqual(expected));
    expect(values.connected).toBe(false);
    expect(values.recognizing).toBe(false);
    expect(values.transcript).toBe("こんにちは");

    // The same state over `sync` (e.g. the browser reconnecting its control channel).
    const pair2 = memoryTransportPair();
    new RemoteShellProxy(ctrl.core, pair2.server);
    const second = connectClient(pair2);
    await vi.waitFor(() => expect(second.values.error).toStrictEqual(expected));
    expect(second.values.transcript).toBe("こんにちは");
    expect(con.wireDrops()).toEqual([]);
  });

  it("the server logger still records the emitted error (code + message)", async () => {
    const events: AmiVoiceServerLogEvent[] = [];
    captureConsole();
    const relay = createAmiVoiceRelayServer({
      createProvider: () => failingProvider(new AmiVoiceError("-", "illegal service authorization")),
      logger: (e) => events.push(e),
    });
    const pair = memoryTransportPair();
    relay.handleControlConnection(pair.server);
    const { proxy } = connectClient(pair);
    await proxy.invoke("start");
    expect(events).toContainEqual({ type: "error", code: "auth", message: "illegal service authorization" });
  });
});

/**
 * Custom providers: a finalized segment with `utteranceid: undefined` or a NaN
 * confidence used to sit in `_segments` as a non-JsonValue, so 0.10 dropped
 * EVERY later `segments` update until reset(). The Core now re-normalizes.
 */
describe("relay: custom-provider segments stay JsonValue-safe", () => {
  it("a sloppy segment does not block later `segments` / `speakers` updates", async () => {
    const con = captureConsole();
    let handlers: RealtimeSessionHandlers | undefined;
    const session: IRealtimeSession = { feedAudio: () => {}, stop: async () => {}, abort: () => {} };
    const relay = createAmiVoiceRelayServer({
      createProvider: () => ({
        openRealtimeSession: async (_o, h) => { handlers = h; return session; },
        recognizeFile: async () => [],
      }),
    });
    const pair = memoryTransportPair();
    relay.handleControlConnection(pair.server);
    const { proxy, values } = connectClient(pair);
    await proxy.invoke("start");

    handlers!.onFinal({
      text: "一", confidence: Number.NaN, starttime: 0, endtime: 1, tokens: [], utteranceid: undefined,
    } as RecognitionSegment);
    handlers!.onFinal({ text: "二", confidence: 0.8, starttime: 1, endtime: 2, tokens: [] });

    await vi.waitFor(() => expect((values.segments as unknown[]).length).toBe(2));
    expect(values.segments).toStrictEqual([
      { text: "一", confidence: 0, starttime: 0, endtime: 1, tokens: [] },
      { text: "二", confidence: 0.8, starttime: 1, endtime: 2, tokens: [] },
    ]);
    expect((values.speakers as unknown[]).length).toBe(2);
    expect(values.transcript).toBe("一二");
    expect(con.wireDrops()).toEqual([]);
  });
});

/**
 * Direct mode (docs/adr/0006): a mint failure REJECTS `invoke("start")`. 0.10
 * canonicalises a non-Error throw to `NonErrorThrow` / "[object Object]", so the
 * Core must always throw an `Error` keeping the original name/message/code.
 */
describe("direct: mint rejections keep their cause across the wire", () => {
  function directServer(prepare: () => Promise<DirectSessionInfo>) {
    const relay = createAmiVoiceRelayServer({
      transport: "direct",
      createProvider: () => ({
        openRealtimeSession: async () => { throw new Error("direct mode must not open an upstream"); },
        recognizeFile: async () => [],
        prepareDirectSession: prepare,
      }),
    });
    const pair = memoryTransportPair();
    relay.handleControlConnection(pair.server);
    return createRemoteCoreProxy(AmiVoiceCore.wcBindable, pair.client);
  }

  async function rejection(p: Promise<unknown>): Promise<Error & { code?: string }> {
    try { await p; } catch (e) { return e as Error & { code?: string }; }
    throw new Error("expected a rejection");
  }

  it("a frozen AmiVoiceError (normaliseError's SerializedError fallback) arrives as a named, coded Error", async () => {
    const proxy = directServer(async () => { throw Object.freeze(new AmiVoiceError("-", "mint refused")); });
    const err = await rejection(proxy.invoke("start"));
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("AmiVoiceError");
    expect(err.message).toBe("mint refused");
    expect(err.code).toBe("auth");
  });

  it("a plain-object rejection arrives with its message, not \"[object Object]\"", async () => {
    const proxy = directServer(async () => { throw { message: "mint refused", code: "auth" }; });
    const err = await rejection(proxy.invoke("start"));
    expect(err.name).not.toBe("NonErrorThrow");
    expect(err.message).toBe("mint refused");
    expect(err.code).toBe("auth");
  });

  it("the browser's in-page Core publishes the mint failure as the plain JSON-safe error", async () => {
    const proxy = directServer(async () => { throw new AmiVoiceError("-", "mint refused"); });
    const core = new AmiVoiceCore(new DirectBrowserProvider(() => proxy.invoke("start") as Promise<DirectSessionInfo>));

    await expect(core.start()).resolves.toBeNull();
    // `resultCode` / `retryable` do not ride a remote `throw` envelope; `code` does.
    expect(core.error).toStrictEqual({ name: "AmiVoiceError", message: "mint refused", code: "auth" });
    expect(getErrorCode(core.error)).toBe("auth");
    expect(isJsonValue(core.error)).toBe(true);
  });
});

/** A direct-mode server over the in-memory wire, its client proxy, and its log. */
function directSetup(provider: () => IAmiVoiceProvider, logger?: (e: AmiVoiceServerLogEvent) => void) {
  const events: AmiVoiceServerLogEvent[] = [];
  const relay = createAmiVoiceRelayServer({
    transport: "direct",
    createProvider: provider,
    logger: logger ?? ((e) => events.push(e)),
  });
  const pair = memoryTransportPair();
  const ctrl = relay.handleControlConnection(pair.server);
  const proxy = createRemoteCoreProxy(AmiVoiceCore.wcBindable, pair.client);
  return { pair, ctrl, proxy, events };
}

/** A custom direct provider whose mint resolves / rejects as `prepare` does. */
function customDirect(prepare: () => Promise<unknown>): () => IAmiVoiceProvider {
  return () => ({
    openRealtimeSession: async () => { throw new Error("direct mode must not open an upstream"); },
    recognizeFile: async () => [],
    prepareDirectSession: prepare as () => Promise<DirectSessionInfo>,
  });
}

/** The server → client frames that crossed the wire, parsed. */
function serverFrames(pair: MemoryTransportPair): Array<Record<string, unknown>> {
  return pair.wire.filter((f) => f.startsWith("S:")).map((f) => JSON.parse(f.slice(2)));
}

async function rejectionOf(p: Promise<unknown>): Promise<Error & { code?: string; cause?: unknown }> {
  try { await p; } catch (e) { return e as Error & { code?: string; cause?: unknown }; }
  throw new Error("expected a rejection");
}

/**
 * A custom `prepareDirectSession` result used to be returned as-is: an extra
 * key holding a non-JsonValue (an `undefined` member, a `Date`) made 0.10 answer
 * `start` with an opaque `WC_BINDABLE_INVALID_RETURN_VALUE`, an extra JSON key
 * crossed to the browser, and a missing field went through unnoticed.
 */
describe("direct: a custom prepareDirectSession result is normalized before it crosses", () => {
  const ENDPOINT = "wss://acp-api.amivoice.com/v1/";
  const S = "s LSB16K -a-general authorization=ONE-TIME";

  it("extra keys and non-JSON values are dropped: the browser gets exactly { endpoint, sCommand }", async () => {
    const con = captureConsole();
    const { proxy, pair } = directSetup(customDirect(async () => ({
      endpoint: ENDPOINT, sCommand: S, expiresAt: new Date(), note: undefined, appKey: "PERMANENT-APPKEY",
    })));

    await expect(proxy.invoke("start")).resolves.toStrictEqual({ endpoint: ENDPOINT, sCommand: S });
    expect(pair.wire.join("\n")).not.toContain("PERMANENT-APPKEY");
    expect(pair.wire.join("\n")).not.toContain("WC_BINDABLE_INVALID_RETURN_VALUE");
    expect(con.messages()).toEqual([]);
  });

  it("a malformed result rejects with an invalid-param error naming the field, not WC_BINDABLE_INVALID_RETURN_VALUE", async () => {
    const { proxy } = directSetup(customDirect(async () => ({ endpoint: ENDPOINT, sCommand: new Date() })));

    const err = await rejectionOf(proxy.invoke("start"));
    expect(err.name).toBe("AmiVoiceError");
    expect(err.code).toBe("invalid-param");
    expect(err.message).toBe(
      "prepareDirectSession() must resolve { endpoint, sCommand } as non-empty strings; sCommand is object",
    );
  });

  it("the browser's in-page Core publishes that cause as its JSON-safe error", async () => {
    const { proxy } = directSetup(customDirect(async () => ({ endpoint: ENDPOINT })));
    const core = new AmiVoiceCore(new DirectBrowserProvider(() => proxy.invoke("start") as Promise<DirectSessionInfo>));

    await expect(core.start()).resolves.toBeNull();
    expect(core.error).toStrictEqual({
      name: "AmiVoiceError",
      message: "prepareDirectSession() must resolve { endpoint, sCommand } as non-empty strings; sCommand is undefined",
      code: "invalid-param",
    });
  });
});

/**
 * `@wc-bindable/remote` 0.10's shell puts `error.stack` on every `throw` it
 * sends (wc-bindable-protocol#38), so a direct-mode mint failure delivered the
 * SERVER's stack trace to the browser. The server helper now strips it from the
 * wire — the thrown error and the server log keep it.
 */
describe("server stack traces stay on the server (wc-bindable-protocol#38)", () => {
  /** Real provider whose `issue_service_authorization` call fails with HTTP `status`. */
  function failingMint(status = 500): () => IAmiVoiceProvider {
    const fetch = (async () => ({ ok: false, status, text: async () => "" })) as unknown as typeof globalThis.fetch;
    return () => new AmiVoiceProvider({ appKey: "PERMANENT-APPKEY", fetch });
  }
  const MINT_FAILED = {
    name: "AmiVoiceError",
    message: "one-time APPKEY issuance failed (HTTP 500)",
    code: "auth",
  };

  it("direct mint failure: the browser's error carries no server stack; name / message / code survive", async () => {
    const con = captureConsole();
    const { proxy, pair } = directSetup(failingMint());

    const err = await rejectionOf(proxy.invoke("start"));

    expect(err).toBeInstanceOf(Error);
    expect(err).toMatchObject(MINT_FAILED);
    // The revived Error's own stack is the browser's, not the server's…
    expect(err.stack).not.toContain("issueOneTimeAppKey");
    // …and the envelope (kept as `cause` by RemoteCoreProxy) has none either.
    expect(err.cause).toStrictEqual(MINT_FAILED);
    // Nothing of the server stack crossed the wire at all.
    expect(serverFrames(pair).find((m) => m.type === "throw")!.error).toStrictEqual(MINT_FAILED);
    expect(pair.wire.join("\n")).not.toContain("issueOneTimeAppKey");
    expect(pair.wire.join("\n")).not.toContain("PERMANENT-APPKEY");
    expect(con.messages()).toEqual([]);
  });

  it("the server log keeps the original stack (redacted) with the code and message", async () => {
    const { proxy, events } = directSetup(failingMint());
    await rejectionOf(proxy.invoke("start"));

    const logged = events.filter((e) => e.type === "error");
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ type: "error", code: "auth", message: MINT_FAILED.message });
    expect(logged[0]).toHaveProperty("stack", expect.stringContaining("issueOneTimeAppKey"));
    expect(JSON.stringify(events)).not.toContain("PERMANENT-APPKEY");
  });

  it("neither the stack nor the cause chain crosses; the log keeps both", async () => {
    // Like Node's `fetch` failing on the mint call: TypeError("fetch failed") with
    // the socket error as its `cause` — both carrying server stacks.
    const socketError = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    socketError.stack = "Error: connect ECONNREFUSED\n    at SERVER_CAUSE_FRAME (/srv/app/net.js:1:1)";
    const fetchFailed = new TypeError("fetch failed");
    fetchFailed.stack = "TypeError: fetch failed\n    at SERVER_TOP_FRAME (/srv/app/mint.js:1:1)";
    (fetchFailed as { cause?: unknown }).cause = socketError;
    const { proxy, pair, events } = directSetup(customDirect(async () => { throw fetchFailed; }));

    const err = await rejectionOf(proxy.invoke("start"));

    expect(err.name).toBe("TypeError");
    expect(err.message).toBe("fetch failed");
    expect(serverFrames(pair).find((m) => m.type === "throw")!.error).toStrictEqual({
      name: "TypeError",
      message: "fetch failed",
    });
    for (const marker of ["SERVER_TOP_FRAME", "SERVER_CAUSE_FRAME", "/srv/app", "ECONNREFUSED"]) {
      expect(pair.wire.join("\n")).not.toContain(marker);
    }
    const logged = events.find((e) => e.type === "error") as { message: string; stack: string; cause: string };
    expect(logged).toMatchObject({ type: "error", message: "fetch failed", stack: fetchFailed.stack });
    expect(JSON.parse(logged.cause)).toMatchObject({ name: "Error", message: "connect ECONNREFUSED", code: "ECONNREFUSED" });
  });

  it.each([
    ["a string", "upstream said no"],
    ["null", null],
    ["an array", ["a", { stack: "payload, not an error" }]],
  ])("a non-Error cause (%s) is dropped from the wire and logged", async (_label, cause) => {
    const thrown = new Error("mint failed");
    (thrown as { cause?: unknown }).cause = cause;
    const { proxy, pair, events } = directSetup(customDirect(async () => { throw thrown; }));

    await rejectionOf(proxy.invoke("start"));
    expect(serverFrames(pair).find((m) => m.type === "throw")!.error).toStrictEqual({
      name: "Error", message: "mint failed",
    });
    const logged = events.find((e) => e.type === "error") as { cause: string };
    expect(JSON.parse(logged.cause)).toStrictEqual(cause);
  });

  it("a secret inside the cause is redacted in the log", async () => {
    const thrown = new Error("mint failed");
    (thrown as { cause?: unknown }).cause = { detail: "authorization=PERMANENT-APPKEY rejected" };
    const { proxy, pair, events } = directSetup(customDirect(async () => { throw thrown; }));

    await rejectionOf(proxy.invoke("start"));
    expect(pair.wire.join("\n")).not.toContain("PERMANENT-APPKEY");
    expect(JSON.stringify(events)).not.toContain("PERMANENT-APPKEY");
    expect((events.find((e) => e.type === "error") as { cause: string }).cause).toContain("authorization=<redacted>");
  });

  it("an APPKEY echoed into the failure is redacted in the log record (message and stack)", async () => {
    const { proxy, pair, events } = directSetup(customDirect(async () => {
      throw new AmiVoiceError("-", "s LSB16K -a-general authorization=PERMANENT-APPKEY rejected");
    }));
    const err = await rejectionOf(proxy.invoke("start"));

    expect(err.message).toBe("s LSB16K -a-general authorization=<redacted> rejected");
    const logged = events.find((e) => e.type === "error") as { message: string; stack: string };
    expect(logged.message).toBe("s LSB16K -a-general authorization=<redacted> rejected");
    expect(logged.stack).toContain("authorization=<redacted>");
    expect(JSON.stringify(events)).not.toContain("PERMANENT-APPKEY");
    expect(pair.wire.join("\n")).not.toContain("PERMANENT-APPKEY");
  });

  it("a throw the shell synthesizes itself (no stack) is logged too, without a `stack` field", async () => {
    const { pair, events } = directSetup(failingMint());
    // A raw frame a misbehaving / probing client could send (the proxy refuses it locally).
    pair.client.send({ type: "cmd", name: "notACommand", id: "probe-1", args: [] });

    await vi.waitFor(() => expect(events.some((e) => e.type === "error")).toBe(true));
    expect(events.find((e) => e.type === "error")).toStrictEqual({
      type: "error", message: "Command \"notACommand\" is not declared in wcBindable.commands",
    });
  });

  it("a throwing logger does not keep the reply from reaching the browser", async () => {
    const { proxy } = directSetup(failingMint(), (e) => { if (e.type === "error") throw new Error("log sink down"); });
    const err = await rejectionOf(proxy.invoke("start"));
    expect(err).toMatchObject(MINT_FAILED);
  });

  it("relay: any command's throw is stripped too (a custom session whose abort() throws)", async () => {
    const thrown = new Error("session teardown failed");
    thrown.stack = "Error: session teardown failed\n    at SERVER_ABORT_FRAME (/srv/app/session.js:1:1)";
    const relay = createAmiVoiceRelayServer({
      createProvider: () => ({
        openRealtimeSession: async () => ({ feedAudio() {}, async stop() {}, abort() { throw thrown; } }),
        recognizeFile: async () => [],
      }),
    });
    const pair = memoryTransportPair();
    relay.handleControlConnection(pair.server);
    const { proxy } = connectClient(pair);
    await proxy.invoke("start");

    const err = await rejectionOf(proxy.invoke("abort"));
    expect(err.message).toBe("session teardown failed");
    expect(err.cause).toStrictEqual({ name: "Error", message: "session teardown failed" });
    expect(pair.wire.join("\n")).not.toContain("SERVER_ABORT_FRAME");
  });

  it("in-process callers keep the full stack — the Core's own rejection is untouched", async () => {
    const { ctrl } = directSetup(failingMint());
    const err = await rejectionOf(ctrl.core.start()) as unknown as AmiVoiceError;
    expect(err).toBeInstanceOf(AmiVoiceError);
    expect(err.stack).toContain("issueOneTimeAppKey");
    expect(err.resultCode).toBe("-");
    expect(err.retryable).toBe(false);
  });

  it("local mode (a Core with no server helper in front) keeps its stack", async () => {
    const core = new AmiVoiceCore(failingMint()(), undefined, { transport: "direct" });
    const err = await rejectionOf(core.start());
    expect(err).toMatchObject(MINT_FAILED);
    expect(err.stack).toContain("issueOneTimeAppKey");
  });

  it("the rejection's cause chain and extra fields are APPKEY-redacted like originalError — same instance, stack kept", async () => {
    const thrown = Object.assign(new Error("mint failed"), {
      cause: new Error("POST /issue_service_authorization authorization=PERMANENT-APPKEY"),
      body: "sid=x&authorization=PERMANENT-APPKEY",
    });
    const core = new AmiVoiceCore(customDirect(async () => { throw thrown; })(), undefined, { transport: "direct" });
    const err = await rejectionOf(core.start());
    expect(err).toBe(thrown);
    expect(err.stack).toContain("mint failed");
    expect((err.cause as Error).message).toBe("POST /issue_service_authorization authorization=<redacted>");
    expect(leaksOf(err, "PERMANENT-APPKEY")).toEqual([]);
  });
});

/**
 * `AmiVoiceCore.originalError` — the exception behind `error` (same name and
 * meaning as s3-uploader's `S3Core.originalError`). It is for server-side
 * logging / monitoring only: never declared in `wcBindable`, so the REAL 0.10
 * shell never puts it in a `sync`, an `update` or a `throw`, and refuses it as
 * a command or an input. Its `message` / `stack` are APPKEY-redacted by `toError`.
 */
describe("AmiVoiceCore.originalError — the original exception stays on the server", () => {
  const DECLARED = AmiVoiceCore.wcBindable.properties.map((p) => p.name);
  /** What only the instance carries (stack frame, cause, extra field) + the APPKEY. */
  const INSTANCE_ONLY = ["SERVER_STACK_FRAME", "/srv/app", "ECONNREFUSED", "REQ-7f3a", "PERMANENT-APPKEY"];

  type RichError = AmiVoiceError & { cause: Error; diag: { requestId: string } };
  /** An auth rejection echoing the APPKEY, with a server stack, a cause and an extra field. */
  function richError(): RichError {
    const err = new AmiVoiceError("-", "s LSB16K -a-general authorization=PERMANENT-APPKEY rejected");
    err.stack = "AmiVoiceError: s LSB16K -a-general authorization=PERMANENT-APPKEY rejected\n"
      + "    at SERVER_STACK_FRAME (/srv/app/session.js:1:1)";
    return Object.assign(err, {
      cause: new Error("connect ECONNREFUSED 10.0.0.5:443"),
      diag: { requestId: "REQ-7f3a" },
    });
  }
  const PUBLISHED = {
    name: "AmiVoiceError",
    message: "s LSB16K -a-general authorization=<redacted> rejected",
    code: "auth",
    resultCode: "-",
    retryable: false,
  };

  /** Every `sync` / `update` names declared properties only. */
  function expectDeclaredOnly(frames: Array<Record<string, unknown>>): void {
    for (const m of frames) {
      if (m.type === "sync") for (const name of Object.keys(m.values as object)) expect(DECLARED).toContain(name);
      if (m.type === "update") expect(DECLARED).toContain(m.name);
    }
  }

  it("is undeclared: not a wcBindable property, input or command", () => {
    const { properties, inputs = [], commands = [] } = AmiVoiceCore.wcBindable;
    expect([...properties, ...inputs, ...commands].map((d) => d.name)).not.toContain("originalError");
  });

  it("server code reads the instance from the Core's error event; sync / update never carry it", async () => {
    const con = captureConsole();
    const original = richError();
    const relay = createAmiVoiceRelayServer({ createProvider: () => failingProvider(original) });
    const pair = memoryTransportPair();
    const ctrl = relay.handleControlConnection(pair.server);
    // The README recipe: listen on the Core, read the instance there.
    const seen: Array<{ error: unknown; originalError: Error | null }> = [];
    ctrl.core.addEventListener("ami-voice:error", () => {
      seen.push({ error: ctrl.core.error, originalError: ctrl.core.originalError });
    });
    const { proxy, values } = connectClient(pair);

    await expect(proxy.invoke("start")).resolves.toBeNull();

    // start() first clears (both null), then publishes — each pair in place at its dispatch.
    expect(seen).toHaveLength(2);
    expect(seen[0]).toStrictEqual({ error: null, originalError: null });
    expect(seen[1].error).toStrictEqual(PUBLISHED);
    expect(seen[1].originalError).toBe(original);

    // Server side: the provider's own instance — class, stack, cause, extra field.
    const err = ctrl.core.originalError as RichError;
    expect(err).toBe(original);
    expect(err).toBeInstanceOf(AmiVoiceError);
    expect(err).toMatchObject({ name: "AmiVoiceError", code: "auth", resultCode: "-", retryable: false });
    expect(err.stack).toContain("SERVER_STACK_FRAME");
    expect(err.cause.message).toBe("connect ECONNREFUSED 10.0.0.5:443");
    expect(err.diag).toStrictEqual({ requestId: "REQ-7f3a" });
    // …with the APPKEY redacted from message and stack (toError's rule).
    expect(err.message).toBe(PUBLISHED.message);
    expect(err.stack).toContain("authorization=<redacted>");
    expect(err.stack).not.toContain("PERMANENT-APPKEY");

    // Browser side: only the plain projection.
    expect(values.error).toStrictEqual(PUBLISHED);
    expect(ctrl.core.error).toStrictEqual(PUBLISHED);

    // The wire: declared names only, `error` exactly the projection, nothing instance-only.
    const frames = serverFrames(pair);
    expectDeclaredOnly(frames);
    expect(frames.filter((m) => m.type === "update" && m.name === "error" && m.value !== null).map((m) => m.value))
      .toStrictEqual([PUBLISHED]);
    const text = pair.wire.join("\n");
    for (const marker of [...INSTANCE_ONLY, "originalError", "\"stack\"", "\"cause\""]) expect(text).not.toContain(marker);
    expect(con.wireDrops()).toEqual([]);
  });

  it("a client attaching after the failure gets the plain error in sync, never the instance", async () => {
    const con = captureConsole();
    const original = richError();
    const relay = createAmiVoiceRelayServer({ createProvider: () => failingProvider(original) });
    const pair = memoryTransportPair();
    const ctrl = relay.handleControlConnection(pair.server);
    await ctrl.core.start(); // fails server-side before any client is bound
    expect(ctrl.core.originalError).toBe(original);

    const { values } = connectClient(pair);
    await vi.waitFor(() => expect(values.error).toStrictEqual(PUBLISHED));

    const sync = serverFrames(pair).find((m) => m.type === "sync")!;
    expect((sync.values as Record<string, unknown>).error).toStrictEqual(PUBLISHED);
    expect(sync.getterFailures).toBeUndefined();
    expectDeclaredOnly([sync]);
    const text = JSON.stringify(sync);
    for (const marker of [...INSTANCE_ONLY, "originalError", "\"stack\"", "\"cause\""]) expect(text).not.toContain(marker);
    expect(con.wireDrops()).toEqual([]);
  });

  it("a command's throw reply never carries it (a session whose abort() throws)", async () => {
    const con = captureConsole();
    let handlers: RealtimeSessionHandlers | undefined;
    const relay = createAmiVoiceRelayServer({
      createProvider: () => ({
        openRealtimeSession: async (_o, h) => {
          handlers = h;
          return { feedAudio() {}, async stop() {}, abort() { throw new Error("session teardown failed"); } };
        },
        recognizeFile: async () => [],
      }),
    });
    const pair = memoryTransportPair();
    const ctrl = relay.handleControlConnection(pair.server);
    const { proxy, values } = connectClient(pair);
    await proxy.invoke("start");

    const original = richError();
    handlers!.onError(original); // a mid-session failure the Core publishes
    expect(ctrl.core.originalError).toBe(original);
    await vi.waitFor(() => expect(values.error).toStrictEqual(PUBLISHED));

    const err = await rejectionOf(proxy.invoke("abort"));
    expect(err.message).toBe("session teardown failed");
    const thrown = serverFrames(pair).filter((m) => m.type === "throw");
    expect(thrown.map((m) => m.error)).toStrictEqual([{ name: "Error", message: "session teardown failed" }]);
    // The throw is not a published failure: `originalError` still names the published one.
    expect(ctrl.core.originalError).toBe(original);
    const text = pair.wire.join("\n");
    for (const marker of [...INSTANCE_ONLY, "originalError"]) expect(text).not.toContain(marker);
    expect(con.wireDrops()).toEqual([]);
  });

  it("a hand-written cmd / set naming it is refused as undeclared", async () => {
    captureConsole();
    const original = richError();
    const relay = createAmiVoiceRelayServer({ createProvider: () => failingProvider(original) });
    const pair = memoryTransportPair();
    const ctrl = relay.handleControlConnection(pair.server);
    await ctrl.core.start();
    connectClient(pair);

    // Raw frames, as a hostile client would send them (the proxy itself refuses locally).
    pair.client.send({ type: "cmd", name: "originalError", id: "probe-cmd", args: [] });
    pair.client.send({ type: "set", name: "originalError", value: null, id: "probe-set" });

    const answer = (id: string) => serverFrames(pair).find((m) => m.type === "throw" && m.id === id);
    await vi.waitFor(() => expect(answer("probe-set")).toBeDefined());
    expect(answer("probe-cmd")!.error).toMatchObject({ code: "WC_BINDABLE_UNDECLARED_COMMAND" });
    expect(answer("probe-set")!.error).toMatchObject({ code: "WC_BINDABLE_UNDECLARED_INPUT" });
    const text = pair.wire.filter((f) => f.startsWith("S:")).join("\n");
    for (const marker of INSTANCE_ONLY) expect(text).not.toContain(marker);
    // Nothing was invoked or overwritten.
    expect(ctrl.core.originalError).toBe(original);
    expect(ctrl.core.error).toStrictEqual(PUBLISHED);
  });

  it("follows `error`: replaced by the next failure, null again on recovery (start / reset)", async () => {
    captureConsole();
    const upstream = scriptedUpstream();
    const real = new AmiVoiceProvider({ appKey: "K", socketFactory: upstream.socketFactory });
    let failNext = true;
    const relay = createAmiVoiceRelayServer({
      createProvider: () => ({
        openRealtimeSession: (o, h) => {
          if (failNext) { failNext = false; return Promise.reject(new AmiVoiceError("b", "server busy")); }
          return real.openRealtimeSession(o, h);
        },
        recognizeFile: async () => [],
      }),
    });
    const pair = memoryTransportPair();
    const ctrl = relay.handleControlConnection(pair.server);
    const pairs: Array<[unknown, Error | null]> = [];
    ctrl.core.addEventListener("ami-voice:error", () => pairs.push([ctrl.core.error, ctrl.core.originalError]));
    const { proxy, values } = connectClient(pair);

    await proxy.invoke("start");
    expect(ctrl.core.originalError).toMatchObject({ name: "AmiVoiceError", code: "server-busy", message: "server busy" });

    // Recovery: a successful start clears both.
    expect(typeof await proxy.invoke("start")).toBe("string");
    expect(ctrl.core.error).toBeNull();
    expect(ctrl.core.originalError).toBeNull();

    // An upstream drop mid-session publishes the next failure.
    upstream.drop();
    await vi.waitFor(() => expect(values.error).toMatchObject({ code: "upstream" }));
    expect(ctrl.core.originalError).toBeInstanceOf(AmiVoiceError);
    expect(ctrl.core.originalError).toMatchObject({ code: "upstream", message: "AmiVoice connection lost mid-session" });

    // reset() clears both.
    await proxy.invoke("reset");
    expect(ctrl.core.error).toBeNull();
    expect(ctrl.core.originalError).toBeNull();

    // Every dispatch saw a consistent pair: null with null, a failure with its source.
    expect(pairs.length).toBeGreaterThanOrEqual(4);
    for (const [error, source] of pairs) {
      if (error === null) expect(source).toBeNull();
      else expect(error).toStrictEqual(expect.objectContaining({ name: source!.name, message: source!.message }));
    }
  });

  it("an APPKEY echoed by a real upstream rejection is redacted in message and stack", async () => {
    captureConsole();
    const events: AmiVoiceServerLogEvent[] = [];
    const upstream = scriptedUpstream({ rejectStart: true });
    const relay = createAmiVoiceRelayServer({
      createProvider: () => new AmiVoiceProvider({ appKey: "PERMANENT-APPKEY", socketFactory: upstream.socketFactory }),
      logger: (e) => events.push(e),
    });
    const pair = memoryTransportPair();
    const ctrl = relay.handleControlConnection(pair.server);
    const { proxy } = connectClient(pair);

    await proxy.invoke("start");

    const err = ctrl.core.originalError!;
    expect(err).toBeInstanceOf(AmiVoiceError);
    expect(err.message).toBe("rejected: s LSB16K -a-general authorization=<redacted>");
    expect(err.stack).toContain("authorization=<redacted>");
    expect(err.stack).not.toContain("PERMANENT-APPKEY");
    expect(JSON.stringify(err)).not.toContain("PERMANENT-APPKEY");
    // The logger record for it stays the minimal projection; nothing leaked anywhere.
    expect(events).toContainEqual({ type: "error", code: "unknown", message: err.message });
    expect(JSON.stringify(events)).not.toContain("PERMANENT-APPKEY");
    expect(pair.wire.join("\n")).not.toContain("PERMANENT-APPKEY");
  });

  /**
   * A custom provider may put the APPKEY in the cause chain or an extra field
   * (an `s` command it kept, an upstream frame it quotes). `originalError` goes
   * to a tracker whole, so it is redacted there too — in place (SPEC §14).
   */
  const UPSTREAM = {
    name: "AmiVoiceError", message: "recognizer send failed", code: "upstream", resultCode: "<", retryable: true,
  };
  it.each([
    [
      "a multi-level cause chain ending in a non-Error cause, and extra fields",
      () => {
        const tail = { detail: "upstream said authorization=PERMANENT-APPKEY", cause: "raw authorization=PERMANENT-APPKEY" };
        const mid = Object.assign(new Error("connect failed authorization=PERMANENT-APPKEY"), { cause: tail });
        return Object.assign(new AmiVoiceError("<", "recognizer send failed"), {
          cause: mid,
          command: "s LSB16K -a-general authorization=PERMANENT-APPKEY",
          diag: { requestId: "REQ-7f3a", sent: ["authorization=PERMANENT-APPKEY"] },
        });
      },
    ],
    [
      "a cause chain that loops back to the error",
      () => {
        const err = new AmiVoiceError("<", "recognizer send failed");
        const mid = Object.assign(new Error("retry authorization=PERMANENT-APPKEY"), { cause: err });
        return Object.assign(err, { cause: mid, diag: { owner: err, line: "authorization=PERMANENT-APPKEY" } });
      },
    ],
  ])("the APPKEY in %s is redacted as well — same instance, still off the wire and the log", async (_label, make) => {
    const con = captureConsole();
    const events: AmiVoiceServerLogEvent[] = [];
    const original = make();
    const relay = createAmiVoiceRelayServer({ createProvider: () => failingProvider(original), logger: (e) => events.push(e) });
    const pair = memoryTransportPair();
    const ctrl = relay.handleControlConnection(pair.server);
    const tracked: Error[] = [];
    ctrl.core.addEventListener("ami-voice:error", () => {
      if (ctrl.core.originalError) tracked.push(ctrl.core.originalError);
    });
    const { proxy, values } = connectClient(pair);

    await expect(proxy.invoke("start")).resolves.toBeNull();

    // What the tracker gets: the provider's own instance, its chain kept, nothing on it holding the APPKEY.
    expect(tracked).toStrictEqual([original]);
    expect(tracked[0]).toBe(original);
    expect(original).toBeInstanceOf(AmiVoiceError);
    expect((original as AmiVoiceError & { cause: unknown }).cause).toBeInstanceOf(Error);
    expect(leaksOf(original, "PERMANENT-APPKEY")).toEqual([]);
    // The browser: the same plain projection as before.
    expect(values.error).toStrictEqual(UPSTREAM);
    expect(ctrl.core.error).toStrictEqual(UPSTREAM);
    const text = pair.wire.join("\n");
    for (const marker of ["PERMANENT-APPKEY", "REQ-7f3a", "originalError", "\"stack\"", "\"cause\""]) expect(text).not.toContain(marker);
    expect(JSON.stringify(events)).not.toContain("PERMANENT-APPKEY");
    expect(con.wireDrops()).toEqual([]);
  });

  it("a secret it cannot overwrite in place (a frozen cause) makes it a rebuilt Error, still clean", async () => {
    const con = captureConsole();
    const original = Object.assign(new AmiVoiceError("<", "recognizer send failed"), {
      cause: Object.freeze(new Error("connect failed authorization=PERMANENT-APPKEY")),
    });
    const relay = createAmiVoiceRelayServer({ createProvider: () => failingProvider(original) });
    const pair = memoryTransportPair();
    const ctrl = relay.handleControlConnection(pair.server);
    const { proxy, values } = connectClient(pair);

    await expect(proxy.invoke("start")).resolves.toBeNull();

    const err = ctrl.core.originalError!;
    expect(err).not.toBe(original);
    expect(err).toBeInstanceOf(Error);
    expect(err).toMatchObject(UPSTREAM);
    expect(Object.getOwnPropertyNames(err)).not.toContain("cause");
    expect(leaksOf(err, "PERMANENT-APPKEY")).toEqual([]);
    expect(values.error).toStrictEqual(UPSTREAM);
    expect(pair.wire.join("\n")).not.toContain("PERMANENT-APPKEY");
    expect(con.wireDrops()).toEqual([]);
  });

  it.each([
    [
      "a frozen AmiVoiceError",
      () => Object.freeze(new AmiVoiceError("-", "denied authorization=PERMANENT-APPKEY")),
      { name: "AmiVoiceError", message: "denied authorization=<redacted>", code: "auth", resultCode: "-", retryable: false },
    ],
    [
      "a plain object",
      () => ({ name: "QuotaError", message: "quota for authorization=PERMANENT-APPKEY", code: "busy", retryable: true }),
      { name: "QuotaError", message: "quota for authorization=<redacted>", code: "busy", retryable: true },
    ],
    [
      "a bare string",
      () => "socket closed authorization=PERMANENT-APPKEY",
      { name: "Error", message: "socket closed authorization=<redacted>" },
    ],
    [
      "a hostile value (throwing getter)",
      () => ({ get message(): string { throw new Error("trap"); } }),
      { name: "Error", message: "unserializable error value" },
    ],
  ])("%s becomes an Error keeping name / message / code / resultCode / retryable", async (_label, make, expected) => {
    const con = captureConsole();
    const thrown = make();
    const relay = createAmiVoiceRelayServer({ createProvider: () => failingProvider(thrown) });
    const pair = memoryTransportPair();
    const ctrl = relay.handleControlConnection(pair.server);
    const { proxy, values } = connectClient(pair);

    await expect(proxy.invoke("start")).resolves.toBeNull(); // still publish, never reject

    const err = ctrl.core.originalError!;
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBe(thrown);
    expect(err).toMatchObject(expected);
    for (const key of ["code", "resultCode", "retryable"] as const) {
      if (!(key in expected)) expect(err).not.toHaveProperty(key);
    }
    expect(err.message).not.toContain("PERMANENT-APPKEY");
    expect(err.stack ?? "").not.toContain("PERMANENT-APPKEY");
    // The wire projection is unchanged: exactly the same fields.
    expect(ctrl.core.error).toStrictEqual(expected);
    expect(values.error).toStrictEqual(expected);
    expect(pair.wire.join("\n")).not.toContain("PERMANENT-APPKEY");
    expect(con.wireDrops()).toEqual([]);
  });

  it("direct mode: a mint failure rejects instead of publishing — originalError stays null, the logger has it", async () => {
    const thrown = new Error("mint failed");
    thrown.stack = "Error: mint failed\n    at SERVER_STACK_FRAME (/srv/app/mint.js:1:1)";
    const { proxy, ctrl, events } = directSetup(customDirect(async () => { throw thrown; }));

    await rejectionOf(proxy.invoke("start"));

    expect(ctrl.core.error).toBeNull();
    expect(ctrl.core.originalError).toBeNull();
    expect(events.find((e) => e.type === "error")).toMatchObject({ message: "mint failed", stack: thrown.stack });
  });
});
