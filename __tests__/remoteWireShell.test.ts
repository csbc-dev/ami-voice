import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { AmiVoice } from "../src/components/AmiVoice";
import {
  createAmiVoiceRelayServer, type AmiVoiceControlSession, type AmiVoiceRelayServer,
} from "../src/createAmiVoiceServer";
import { AmiVoiceProvider } from "../src/providers/AmiVoiceProvider";
import { AmiVoiceError, getErrorCode } from "../src/errorCodes";
import type {
  IAmiVoiceProvider, DirectSessionInfo, RealtimeSessionHandlers, RecognitionOptions,
} from "../src/types";
import { memoryTransportPair, captureConsole, scriptedUpstream, type MemoryTransportPair } from "./support/memoryTransport";

/**
 * Element-level (`<ami-voice>`) regression suite against the REAL
 * `@wc-bindable/remote` 0.10 `RemoteCoreProxy` the Shell builds. Only the
 * WebSocket hop is swapped: `WebSocketClientTransport` returns the in-memory
 * client end, whose server end feeds a real `createAmiVoiceRelayServer` shell.
 */
const h = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("@wc-bindable/remote", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@wc-bindable/remote")>();
  return {
    ...actual,
    WebSocketClientTransport: class {
      constructor() { return h.client as never; }
    },
  };
});

/** The Shell still constructs `new WebSocket(url)` for the control channel; keep it inert. */
class InertWebSocket {
  static readonly OPEN = 1;
  readyState = 0;
  binaryType = "blob";
  bufferedAmount = 0;
  constructor(readonly url: string, readonly protocols?: unknown) {}
  send(): void {}
  close(): void {}
}

// `Pick` the public surface: intersecting the class itself with its (private)
// internals would collapse to `never`. Inputs are listed separately because a
// mapped type keeps only the getter type, not the widened setter (`null` /
// `undefined` accepted).
type Shell = HTMLElement & Pick<AmiVoice,
  "start" | "stop" | "abort" | "reset" | "error" | "recognizing" | "connected" | "transcript" | "loading"
> & {
  engine: string | null | undefined;
  codec: string | null | undefined;
  profileId: string | null | undefined;
  profileWords: string | null | undefined;
  keepFillerToken: boolean | null | undefined;
  resultUpdatedInterval: number | null | undefined;
  segmenterProperties: string | null | undefined;
  noLog: boolean | null | undefined;
  _dataPlaneLive: boolean;
  _core: (Record<string, unknown> & { engine: string }) | null;
  _startMicRemote: (session: unknown) => Promise<void>;
  _startMic: (onFrame: (bytes: Uint8Array) => void) => Promise<void>;
  _values: Record<string, unknown>;
};

/**
 * Wait for the control channel's initial `sync` to land (the bound `_values`
 * are populated). Most tests start from a synced element; `start()` BEFORE the
 * sync is covered on its own below (SPEC §10.2).
 */
async function synced(el: Shell): Promise<void> {
  await vi.waitFor(() => expect(el._values.loading).toBe(false));
}

beforeAll(() => {
  if (!customElements.get("ami-voice")) customElements.define("ami-voice", AmiVoice);
});
beforeEach(() => { vi.stubGlobal("WebSocket", InertWebSocket); });
afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function relayServer(provider: () => IAmiVoiceProvider, transport: "relay" | "direct" = "relay") {
  const relay = createAmiVoiceRelayServer({ createProvider: provider, transport });
  const pair = memoryTransportPair();
  const ctrl = relay.handleControlConnection(pair.server);
  return { pair, ctrl, relay };
}

function mount(pair: MemoryTransportPair, attrs: Record<string, string> = {}, before?: (el: Shell) => void): Shell {
  h.client = pair.client;
  const el = document.createElement("ami-voice") as Shell;
  el.setAttribute("mode", "remote");
  el.setAttribute("remote-url", "ws://localhost:0/ctl");
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  before?.(el);
  document.body.appendChild(el);
  return el;
}

/** Every non-null `ami-voice:error` detail the element dispatches. */
function errorsOf(el: HTMLElement): unknown[] {
  const seen: unknown[] = [];
  el.addEventListener("ami-voice:error", (e) => {
    const d = (e as CustomEvent).detail;
    if (d != null) seen.push(d);
  });
  return seen;
}

const okProvider = (): IAmiVoiceProvider => ({
  openRealtimeSession: async () => ({ feedAudio() {}, async stop() {}, abort() {} }),
  recognizeFile: async () => [],
});

const AUTH_ERROR = {
  name: "AmiVoiceError",
  message: "illegal service authorization",
  code: "auth",
  resultCode: "-",
  retryable: false,
};

describe("<ami-voice> relay: `el.error` shows the real cause (A1)", () => {
  it("a start() failure surfaces the server's cause — NOT \"already active\" — and aborts nothing", async () => {
    const con = captureConsole();
    const { pair, ctrl } = relayServer(() => ({
      openRealtimeSession: async () => { throw new AmiVoiceError("-", "illegal service authorization"); },
      recognizeFile: async () => [],
    }));
    const abort = vi.spyOn(ctrl.core, "abort");
    const el = mount(pair);
    const errors = errorsOf(el);
    await synced(el);

    // Server: start() fails → publishes `error`, resolves null. Shell: sees the
    // empty session id and must NOT replace the cause with "already active".
    await el.start();

    expect(el.error).toStrictEqual(AUTH_ERROR);
    expect(getErrorCode(el.error)).toBe("auth");
    expect(errors).toStrictEqual([AUTH_ERROR]); // the cause, and nothing overwrote it
    expect(abort).not.toHaveBeenCalled();
    expect(el._dataPlaneLive).toBe(false);
    expect(con.wireDrops()).toEqual([]);
  });

  it("sync: an element that connects after the failure sees the cause", async () => {
    const { pair, ctrl } = relayServer(() => ({
      openRealtimeSession: async () => { throw new AmiVoiceError("-", "illegal service authorization"); },
      recognizeFile: async () => [],
    }));
    await ctrl.core.start();

    const el = mount(pair);
    await vi.waitFor(() => expect(el.error).toStrictEqual(AUTH_ERROR));
  });

  it("a genuinely active session still gets the benign \"already active\" notice, without abort", async () => {
    const { pair, ctrl } = relayServer(okProvider);
    await ctrl.core.start(); // server session already live
    const abort = vi.spyOn(ctrl.core, "abort");
    const el = mount(pair);
    await vi.waitFor(() => expect(el.recognizing).toBe(true));

    await el.start();

    expect((el.error as { message: string }).message).toMatch(/already active/);
    expect(abort).not.toHaveBeenCalled();
    expect(ctrl.core.recognizing).toBe(true);
  });

  it("an idle server that returns no session id and no cause gets a generic failure, not \"already active\"", async () => {
    const { pair, ctrl } = relayServer(okProvider);
    // A server whose failure cause could not cross the wire (e.g. a pre-fix Core
    // under remote 0.10): start resolves null with recognizing/loading false.
    vi.spyOn(ctrl.core, "start").mockResolvedValue(null);
    const el = mount(pair);
    await synced(el);

    await el.start();

    expect((el.error as { message: string }).message).toMatch(/opened no recognition session/);
    expect((el.error as { message: string }).message).not.toMatch(/already active/);
  });

  it("an upstream drop mid-session: el.error=upstream, data plane torn down, transcript kept (SPEC §10.1)", async () => {
    const con = captureConsole();
    const upstream = scriptedUpstream();
    const { pair } = relayServer(() => new AmiVoiceProvider({ appKey: "K", socketFactory: upstream.socketFactory }));
    const el = mount(pair);
    el._startMicRemote = vi.fn(async () => {}); // no mic / audio channel under happy-dom
    await synced(el);

    await el.start();
    await vi.waitFor(() => expect(el.recognizing).toBe(true));
    expect(el._dataPlaneLive).toBe(true);
    upstream.final("こんにちは");
    await vi.waitFor(() => expect(el.transcript).toBe("こんにちは"));

    upstream.drop();

    await vi.waitFor(() => expect(getErrorCode(el.error)).toBe("upstream"));
    expect(el.error).toMatchObject({ name: "AmiVoiceError", message: "AmiVoice connection lost mid-session" });
    expect(el.recognizing).toBe(false);
    expect(el.connected).toBe(false);
    expect(el._dataPlaneLive).toBe(false);
    expect(el.transcript).toBe("こんにちは");
    expect(con.wireDrops()).toEqual([]);
  });
});

/**
 * A3: `undefined` (React 19 assigns it when a prop is removed) and non-finite
 * numbers are not JsonValues — remote 0.10 `setWithAck` rejects them with
 * WC_BINDABLE_INVALID_JSON_VALUE. The Shell forwards `null`, which the Core
 * treats as reset-to-default (SPEC §7.2).
 */
describe("<ami-voice> inputs: undefined / NaN reset to the default (A3)", () => {
  it("relay: writes reach the server Core; undefined/null/NaN reset it, with no error", async () => {
    const { pair, ctrl } = relayServer(okProvider);
    const el = mount(pair);
    const errors = errorsOf(el);
    await synced(el);

    el.engine = "-a-medical";
    el.codec = "MSB16K";
    el.resultUpdatedInterval = 500;
    await vi.waitFor(() => expect(ctrl.core.resultUpdatedInterval).toBe(500));
    expect(ctrl.core.engine).toBe("-a-medical");
    expect(ctrl.core.codec).toBe("MSB16K");

    el.engine = undefined;
    el.codec = null;
    el.resultUpdatedInterval = Number.NaN;
    await vi.waitFor(() => expect(ctrl.core.resultUpdatedInterval).toBe(0));
    expect(ctrl.core.engine).toBe("-a-general");
    expect(ctrl.core.codec).toBe("LSB16K");

    // Element getters read back "unset".
    expect(el.engine).toBe("");
    expect(el.resultUpdatedInterval).toBe(0);
    // Let any late setWithAck rejection land before asserting none happened.
    await new Promise((r) => setTimeout(r, 0));
    expect(errors).toEqual([]);
  });

  it("relay: an undefined write made BEFORE connect is not replayed as an invalid value", async () => {
    const { pair, ctrl } = relayServer(okProvider);
    const el = mount(pair, {}, (pre) => {
      pre.engine = "-a-medical";
      pre.engine = undefined;
      pre.profileId = "p1";
      pre.resultUpdatedInterval = Number.NaN;
    });
    const errors = errorsOf(el);

    await vi.waitFor(() => expect(ctrl.core.profileId).toBe("p1"));
    expect(ctrl.core.engine).toBe("-a-general");
    expect(ctrl.core.resultUpdatedInterval).toBe(0);
    await new Promise((r) => setTimeout(r, 0));
    expect(errors).toEqual([]);
  });

  it("direct: both the server (mint) Core and the in-page Core are reset", async () => {
    const { pair, ctrl } = relayServer(() => ({
      openRealtimeSession: async () => { throw new Error("not in direct"); },
      recognizeFile: async () => [],
      prepareDirectSession: async (): Promise<DirectSessionInfo> => ({ endpoint: "wss://x/", sCommand: "s" }),
    }), "direct");
    const el = mount(pair, { transport: "direct" });
    const errors = errorsOf(el);

    el.engine = "-a-medical";
    await vi.waitFor(() => expect(ctrl.core.engine).toBe("-a-medical"));
    expect(el._core!.engine).toBe("-a-medical");

    el.engine = undefined;
    await vi.waitFor(() => expect(ctrl.core.engine).toBe("-a-general"));
    expect(el._core!.engine).toBe("-a-general");
    await new Promise((r) => setTimeout(r, 0));
    expect(errors).toEqual([]);
  });

  it("local: the in-page Core is reset (never stores undefined / NaN)", () => {
    const el = document.createElement("ami-voice") as Shell;
    el.setAttribute("mode", "local");
    document.body.appendChild(el);
    const errors = errorsOf(el);

    el.engine = "-a-medical";
    el.resultUpdatedInterval = 300;
    el.engine = undefined;
    el.resultUpdatedInterval = Number.NaN;

    expect(el._core!.engine).toBe("-a-general");
    expect(el._core!.resultUpdatedInterval).toBe(0);
    expect(errors).toEqual([]);
  });
});

describe("<ami-voice> relay control session teardown", () => {
  it("disposing the server session after the element is gone does not throw", async () => {
    const { pair, ctrl } = relayServer(okProvider);
    const el = mount(pair);
    await synced(el);
    el.remove();
    expect(() => (ctrl as AmiVoiceControlSession).dispose()).not.toThrow();
  });
});

// ── start() lifecycle vs. stale control-channel state ─────────────────────────

/** Flush the in-memory transport (it delivers on microtasks) and any Core awaits. */
async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
}

/**
 * A provider whose realtime sessions are observable. `live()` counts upstream
 * sessions the server-side Core opened and has not closed (stop/abort) — i.e.
 * what would still be running (and billing) on AmiVoice.
 */
function recordingProvider() {
  const log = {
    opened: 0,
    closed: 0,
    fed: [] as number[][],
    handlers: [] as RealtimeSessionHandlers[],
    options: [] as RecognitionOptions[],
  };
  const provider = (): IAmiVoiceProvider => ({
    openRealtimeSession: async (options, handlers) => {
      log.opened++;
      log.options.push(options);
      log.handlers.push(handlers);
      let open = true;
      const close = (): void => { if (open) { open = false; log.closed++; } };
      return {
        feedAudio: (bytes) => { if (open) log.fed.push([...bytes]); },
        stop: async () => close(),
        abort: close,
      };
    },
    recognizeFile: async () => [],
  });
  return { log, provider, live: () => log.opened - log.closed };
}

/**
 * Route the Shell's binary audio channel into the relay's REAL
 * `handleAudioConnection`: `new WebSocket(url, [token])` (the token rides the
 * subprotocol — SPEC §11.3) is accepted only for a live session token, and every
 * `send()` lands in that session's `core.feedAudio`. The control channel (no
 * subprotocol) stays inert — its traffic rides the in-memory transport.
 */
function routeAudioTo(relay: AmiVoiceRelayServer): void {
  type ServerEnd = { onmessage: ((e: { data: unknown }) => void) | null; close(): void };
  class AudioRoutingWebSocket extends InertWebSocket {
    private _server: ServerEnd | null = null;
    constructor(url: string, protocols?: unknown) {
      super(url, protocols);
      if (!Array.isArray(protocols)) return; // the control channel
      const server: ServerEnd = { onmessage: null, close: () => { this.readyState = 3; } };
      this.readyState = 1; // OPEN
      this._server = server;
      relay.handleAudioConnection(server, String(protocols[0]));
    }
    override send(data?: unknown): void { this._server?.onmessage?.({ data }); }
    override close(): void { this.readyState = 3; this._server = null; }
  }
  vi.stubGlobal("WebSocket", AudioRoutingWebSocket);
}

/** Stub the browser-only mic (no getUserMedia under happy-dom); expose its frame sink. */
function stubMic(el: Shell, impl?: () => Promise<void>): { frame(bytes: number[]): void } {
  let sink: ((bytes: Uint8Array) => void) | null = null;
  el._startMic = vi.fn(async (onFrame: (bytes: Uint8Array) => void) => {
    sink = onFrame;
    await impl?.();
  });
  return { frame: (bytes) => sink?.(new Uint8Array(bytes)) };
}

/**
 * Bug: a relay `start()` issued before the control channel's initial `sync` (the
 * README quick start does exactly that) was torn down by the sync snapshot's
 * `recognizing=false` — state from BEFORE the server processed the start — and
 * then bailed when the session id came back, leaving a server session with no
 * mic attached. The same stale-state race hit `abort(); start()` / `reset();
 * start()` (the previous session's `recognizing=false` arriving after the new
 * start was issued). The control channel is ordered, so only the state at
 * `invoke("start")`'s reply decides whether the data plane arms (SPEC §10.2).
 */
describe("<ami-voice> relay: start() vs. stale control-channel state (SPEC §10.2)", () => {
  it("start() before the initial sync opens the session AND streams the mic into it", async () => {
    const con = captureConsole();
    const rec = recordingProvider();
    const { pair, ctrl, relay } = relayServer(rec.provider);
    routeAudioTo(relay);
    const el = mount(pair);
    const mic = stubMic(el);
    expect(el._values.recognizing).toBeUndefined(); // the initial sync has not landed

    await el.start();

    expect(el._startMic).toHaveBeenCalledTimes(1);
    expect(el._dataPlaneLive).toBe(true);
    expect(ctrl.core.recognizing).toBe(true);
    expect(el.recognizing).toBe(true);
    expect(rec.live()).toBe(1);
    expect(relay.sessionCount()).toBe(1);
    // The audio channel is bound to the live session: a mic frame reaches it.
    mic.frame([1, 2, 3]);
    expect(rec.log.fed).toEqual([[1, 2, 3]]);
    expect(el.error).toBeNull();
    expect(con.wireDrops()).toEqual([]);
  });

  it("start() before the initial sync, mic denied: the session is rolled back (none left running)", async () => {
    const rec = recordingProvider();
    const { pair, ctrl, relay } = relayServer(rec.provider);
    routeAudioTo(relay);
    const el = mount(pair);
    stubMic(el, async () => { throw new Error("Permission denied"); });

    await el.start();
    await settle();

    expect(el._startMic).toHaveBeenCalledTimes(1);
    expect((el.error as Error).message).toBe("Permission denied");
    expect(ctrl.core.recognizing).toBe(false);
    expect(rec.live()).toBe(0);
    expect(relay.sessionCount()).toBe(0);
    expect(el._dataPlaneLive).toBe(false);
  });

  it("start() before the initial sync, then abort(): no session is left running and the mic never arms", async () => {
    const rec = recordingProvider();
    const { pair, ctrl, relay } = relayServer(rec.provider);
    const el = mount(pair);
    stubMic(el);

    const started = el.start();
    el.abort();
    await started;
    await settle();

    expect(el._startMic).not.toHaveBeenCalled();
    expect(el._dataPlaneLive).toBe(false);
    expect(ctrl.core.recognizing).toBe(false);
    expect(rec.live()).toBe(0);
    expect(relay.sessionCount()).toBe(0);
  });

  it("element removed during a pre-sync start(): the closed control channel leaves no session, and no error is raised", async () => {
    const rec = recordingProvider();
    const { pair, ctrl, relay } = relayServer(rec.provider);
    const el = mount(pair);
    stubMic(el);
    const errors = errorsOf(el);

    const started = el.start();
    el.remove();    // disconnectedCallback: dispose the proxy, close the control socket
    ctrl.dispose(); // …which the integrator's `close` handler turns into a dispose (SPEC §10)
    await started;
    await settle();

    expect(el._startMic).not.toHaveBeenCalled();
    expect(ctrl.core.recognizing).toBe(false);
    expect(rec.live()).toBe(0);
    expect(relay.sessionCount()).toBe(0);
    expect(errors).toEqual([]); // a cancelled start's DISPOSED rejection is not surfaced
  });

  it.each(["abort", "reset"] as const)(
    "%s() then an immediate start(): the NEW session gets the mic (the old session's end is stale)",
    async (cancel) => {
      const rec = recordingProvider();
      const { pair, ctrl, relay } = relayServer(rec.provider);
      routeAudioTo(relay);
      const el = mount(pair);
      const mic = stubMic(el);
      await synced(el);
      await el.start();
      expect(rec.live()).toBe(1);

      el[cancel]();
      await el.start();

      expect(el._startMic).toHaveBeenCalledTimes(2);
      expect(el._dataPlaneLive).toBe(true);
      expect(ctrl.core.recognizing).toBe(true);
      expect(el.recognizing).toBe(true);
      expect(rec.log.opened).toBe(2);
      expect(rec.live()).toBe(1); // the first session closed, the second is live…
      mic.frame([9]);
      expect(rec.log.fed).toEqual([[9]]); // …and it is the one the mic feeds
    },
  );

  it("a session that ends before start()'s reply arrives does not arm the mic", async () => {
    const rec = recordingProvider();
    const { pair, ctrl } = relayServer(rec.provider);
    const el = mount(pair);
    stubMic(el);
    await synced(el);
    // The upstream drops after the Core opened the session but BEFORE the
    // `return` is sent: the client sees recognizing true→false, then the id.
    const realStart = ctrl.core.start.bind(ctrl.core);
    vi.spyOn(ctrl.core, "start").mockImplementation(async () => {
      const id = await realStart();
      rec.log.handlers.at(-1)!.onClose();
      return id;
    });
    const abort = vi.spyOn(ctrl.core, "abort");

    await el.start();
    await settle();

    expect(el._startMic).not.toHaveBeenCalled();
    expect(el._dataPlaneLive).toBe(false);
    expect(ctrl.core.recognizing).toBe(false);
    expect(abort).toHaveBeenCalledTimes(1); // best-effort: an unused session id is released
  });
});

/**
 * Same decision point, in-page Core (local + direct): the Core publishes a
 * failed start to `error` and resolves without `recognizing=true` (SPEC §17) —
 * no `recognizing-changed` fires because it never went true — so the Shell must
 * read the Core's state rather than arm a microphone for a session that never
 * opened (and must keep the Core's cause in `error`).
 */
describe("<ami-voice> local / direct: a start() the in-page Core could not open never arms the mic", () => {
  it("local: provider failure → no mic, the Core's cause stays in `error`", async () => {
    vi.spyOn(AmiVoiceProvider.prototype, "openRealtimeSession")
      .mockRejectedValue(new AmiVoiceError("-", "illegal service authorization"));
    const el = document.createElement("ami-voice") as Shell;
    el.setAttribute("mode", "local");
    document.body.appendChild(el);
    stubMic(el);

    await el.start();

    expect(el._startMic).not.toHaveBeenCalled();
    expect(el._dataPlaneLive).toBe(false);
    expect(el.error).toStrictEqual(AUTH_ERROR);
  });

  it("direct: mint refused by the server → no mic, the mint cause stays in `error`", async () => {
    const { pair } = relayServer(() => ({
      openRealtimeSession: async () => { throw new Error("not in direct"); },
      recognizeFile: async () => [],
      prepareDirectSession: async () => { throw new AmiVoiceError("-", "mint refused"); },
    }), "direct");
    const el = mount(pair, { transport: "direct" });
    stubMic(el);

    await el.start();

    expect(el._startMic).not.toHaveBeenCalled();
    expect(el._dataPlaneLive).toBe(false);
    expect(el.error).toMatchObject({ name: "AmiVoiceError", message: "mint refused", code: "auth" });
  });
});

/**
 * Bug: inputs set before the element connects (initial attributes, or property
 * writes on a not-yet-attached element) were cached but never applied to the
 * in-page Core, which local mode builds on connect — relay/direct replay the
 * cache over the control channel, local did not. A reset (`null` / `undefined`
 * / `NaN`) before connect leaves the default (SPEC §7.2).
 */
describe("<ami-voice> inputs set before connect reach the in-page Core (SPEC §7.2)", () => {
  function preConnect(el: Shell): void {
    el.setAttribute("engine", "-a-medical");
    el.setAttribute("profile-id", "p1");
    el.setAttribute("no-log", "");
    el.profileWords = "AmiVoice あみぼいす";
    el.keepFillerToken = true;
    el.resultUpdatedInterval = 500;
    el.segmenterProperties = "useDiarizer=1";
    el.codec = "MSB16K";
    el.codec = undefined; // reset before connect → stays the default
  }

  it("local: attributes + properties set before connect are applied, and the s-command options carry them", async () => {
    const rec = recordingProvider();
    const open = vi.spyOn(AmiVoiceProvider.prototype, "openRealtimeSession")
      .mockImplementation(rec.provider().openRealtimeSession);
    const el = document.createElement("ami-voice") as Shell;
    el.setAttribute("mode", "local");
    preConnect(el);
    document.body.appendChild(el);

    const core = el._core!;
    expect(core.engine).toBe("-a-medical");
    expect(core.codec).toBe("LSB16K");
    expect(core.profileId).toBe("p1");
    expect(core.profileWords).toBe("AmiVoice あみぼいす");
    expect(core.keepFillerToken).toBe(true);
    expect(core.resultUpdatedInterval).toBe(500);
    expect(core.segmenterProperties).toBe("useDiarizer=1");
    expect(core.noLog).toBe(true);

    stubMic(el);
    await el.start();
    expect(open).toHaveBeenCalledTimes(1);
    expect(rec.log.options[0]).toStrictEqual({
      engine: "-a-medical",
      codec: "LSB16K",
      profileId: "p1",
      profileWords: "AmiVoice あみぼいす",
      keepFillerToken: true,
      resultUpdatedInterval: 500,
      segmenterProperties: "useDiarizer=1",
      noLog: true,
    });
  });

  it("local: a re-connected element's fresh Core gets the cached inputs again", () => {
    const el = document.createElement("ami-voice") as Shell;
    el.setAttribute("mode", "local");
    el.engine = "-a-medical";
    document.body.appendChild(el);
    el.remove();
    expect(el._core).toBeNull();

    document.body.appendChild(el);
    expect(el._core!.engine).toBe("-a-medical");
  });

  it("direct: the in-page Core gets the pre-connect inputs too (the server Core via the replay)", async () => {
    const { pair, ctrl } = relayServer(() => ({
      openRealtimeSession: async () => { throw new Error("not in direct"); },
      recognizeFile: async () => [],
      prepareDirectSession: async (): Promise<DirectSessionInfo> => ({ endpoint: "wss://x/", sCommand: "s" }),
    }), "direct");
    const el = mount(pair, { transport: "direct" }, preConnect);

    expect(el._core!.engine).toBe("-a-medical");
    expect(el._core!.codec).toBe("LSB16K");
    expect(el._core!.noLog).toBe(true);
    await vi.waitFor(() => expect(ctrl.core.segmenterProperties).toBe("useDiarizer=1"));
    expect(ctrl.core.engine).toBe("-a-medical");
    expect(ctrl.core.codec).toBe("LSB16K");
  });
});
