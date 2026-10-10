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
