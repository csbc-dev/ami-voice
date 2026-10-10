import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { AmiVoice } from "../src/components/AmiVoice";
import { createAmiVoiceRelayServer, type AmiVoiceControlSession } from "../src/createAmiVoiceServer";
import { AmiVoiceProvider } from "../src/providers/AmiVoiceProvider";
import { AmiVoiceError, getErrorCode } from "../src/errorCodes";
import type { IAmiVoiceProvider, DirectSessionInfo } from "../src/types";
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
  "start" | "error" | "recognizing" | "connected" | "transcript" | "loading"
> & {
  engine: string | null | undefined;
  codec: string | null | undefined;
  profileId: string | null | undefined;
  resultUpdatedInterval: number | null | undefined;
  _dataPlaneLive: boolean;
  _core: (Record<string, unknown> & { engine: string }) | null;
  _startMicRemote: (session: unknown) => Promise<void>;
  _values: Record<string, unknown>;
};

/**
 * Wait for the control channel's initial `sync` to land (the bound `_values`
 * are populated). Calling `start()` before it is a separate, pre-existing race
 * (the sync's `recognizing=false` tears down the just-claimed data plane), so
 * these tests start from a synced element.
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
  return { pair, ctrl };
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
