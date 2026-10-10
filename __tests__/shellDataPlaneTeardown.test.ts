import { describe, it, expect, beforeAll, vi } from "vitest";
import { AmiVoice } from "../src/components/AmiVoice";

beforeAll(() => {
  if (!customElements.get("ami-voice")) customElements.define("ami-voice", AmiVoice);
});

/**
 * Finding: an upstream drop (or any session end) must stop the Shell's mic +
 * audio channel. The Core surfaces an unsolicited close as `recognizing=false`
 * (SPEC §10.1); in relay mode the Shell re-emits `ami-voice:recognizing-changed`
 * via its bind() callback, in local/direct the in-page Core fires it on the
 * element (target injection). Either way the Shell must tear its data plane down,
 * otherwise the mic LED stays on and audio is captured into the void.
 */

type ShellInternals = {
  _dataPlaneLive: boolean;
  _mic: { stop: () => void } | null;
  _audioWs: { close: () => void; readyState: number } | null;
};

function makeConnectedShell(mode: "local" | "remote"): HTMLElement & ShellInternals {
  const el = document.createElement("ami-voice");
  el.setAttribute("mode", mode);
  document.body.appendChild(el); // connectedCallback wires the recognizing listener
  return el as unknown as HTMLElement & ShellInternals;
}

describe("<ami-voice> data-plane teardown on session end", () => {
  it("stops the mic + audio channel when recognizing transitions to false while live", () => {
    const el = makeConnectedShell("local");
    const micStop = vi.fn();
    const audioClose = vi.fn();
    // Simulate a live data plane (as if start() had opened the mic + channel).
    el._dataPlaneLive = true;
    el._mic = { stop: micStop };
    el._audioWs = { close: audioClose, readyState: 1 };

    // The Core (or relay bind callback) reports the session ended.
    el.dispatchEvent(new CustomEvent("ami-voice:recognizing-changed", { detail: false }));

    expect(micStop).toHaveBeenCalledTimes(1);
    expect(audioClose).toHaveBeenCalledTimes(1);
    expect(el._dataPlaneLive).toBe(false);

    el.remove();
  });

  it("does nothing on recognizing=true (a session starting)", () => {
    const el = makeConnectedShell("local");
    const micStop = vi.fn();
    el._dataPlaneLive = true;
    el._mic = { stop: micStop };

    el.dispatchEvent(new CustomEvent("ami-voice:recognizing-changed", { detail: true }));

    expect(micStop).not.toHaveBeenCalled();
    el.remove();
  });

  it("does nothing when the data plane is not live (already torn down)", () => {
    const el = makeConnectedShell("local");
    const micStop = vi.fn();
    el._dataPlaneLive = false;
    el._mic = { stop: micStop };

    el.dispatchEvent(new CustomEvent("ami-voice:recognizing-changed", { detail: false }));

    expect(micStop).not.toHaveBeenCalled();
    el.remove();
  });

  it("removes the listener on disconnect (no teardown after the element is gone)", () => {
    const el = makeConnectedShell("local");
    const micStop = vi.fn();
    el._dataPlaneLive = true;
    el._mic = { stop: micStop };
    el.remove(); // disconnectedCallback tears down + unwires the listener

    micStop.mockClear();
    el.dispatchEvent(new CustomEvent("ami-voice:recognizing-changed", { detail: false }));
    expect(micStop).not.toHaveBeenCalled();
  });
});

/**
 * Cycle-2 Shell error-mirror (`_onError`): every `ami-voice:error` detail is
 * mirrored into `_values.error` so the single `error` getter always agrees with
 * the last dispatched event. Pin the three load-bearing invariants: a non-null
 * detail reflects, a null detail CLEARS, and the listener is removed on
 * disconnect (the `error` surface is where the APPKEY-redaction guarantee
 * terminates, so it deserves a regression pin).
 */
describe("<ami-voice> error-mirror (_onError)", () => {
  it("mirrors a non-null ami-voice:error detail into the error getter", () => {
    const el = makeConnectedShell("local") as unknown as HTMLElement & ShellInternals & { error: unknown };
    const boom = new Error("boom");
    el.dispatchEvent(new CustomEvent("ami-voice:error", { detail: boom }));
    expect(el.error).toBe(boom);
    el.remove();
  });

  it("clears the error getter to null on a null ami-voice:error detail", () => {
    const el = makeConnectedShell("local") as unknown as HTMLElement & ShellInternals & { error: unknown };
    el.dispatchEvent(new CustomEvent("ami-voice:error", { detail: new Error("x") }));
    expect(el.error).not.toBeNull();
    el.dispatchEvent(new CustomEvent("ami-voice:error", { detail: null }));
    expect(el.error).toBeNull();
    el.remove();
  });

  it("removes the error listener on disconnect (a later ami-voice:error does not update the getter)", () => {
    const el = makeConnectedShell("local") as unknown as HTMLElement & ShellInternals & { error: unknown };
    el.remove(); // disconnectedCallback unwires _onError (and nulls the in-page Core)
    el.dispatchEvent(new CustomEvent("ami-voice:error", { detail: new Error("after-gone") }));
    expect(el.error).toBeNull();
  });
});

describe("<ami-voice> start() re-entrancy guard", () => {
  it("a second start() while the data plane is live does NOT re-run start work", async () => {
    const el = makeConnectedShell("local") as unknown as
      HTMLElement & ShellInternals & {
        start(): Promise<void>;
        _core: { start: () => Promise<void>; abort: () => void } | null;
        _startMic: (onFrame: (b: Uint8Array) => void) => Promise<void>;
      };
    // Inject a fake Core + spy on _startMic so we can OBSERVE the guard's effect:
    // if the guard at start() were removed, these would be called.
    const coreStart = vi.fn(async () => {});
    el._core = { start: coreStart, abort: vi.fn() } as never;
    const startMic = vi.fn(async () => {});
    el._startMic = startMic as never;
    el._dataPlaneLive = true; // pretend a session is already active

    await expect(el.start()).resolves.toBeUndefined();

    expect(coreStart).not.toHaveBeenCalled();
    expect(startMic).not.toHaveBeenCalled();
    el.remove();
  });

  it("does NOT re-arm the mic when the session ends during the start await (latent edge a)", async () => {
    const el = makeConnectedShell("local") as unknown as
      HTMLElement & ShellInternals & {
        start(): Promise<void>;
        _core: { start: () => Promise<void>; abort: () => void } | null;
        _startMic: (onFrame: (b: Uint8Array) => void) => Promise<void>;
      };
    const startMic = vi.fn(async () => {});
    el._startMic = startMic as never;
    // The Core opens then immediately drops WHILE start() awaits: the in-page Core
    // dispatches recognizing:false on the element (target injection), which the
    // Shell's listener turns into `_stopDataPlane()` (clearing `_dataPlaneLive`).
    el._core = {
      start: vi.fn(async () => {
        el.dispatchEvent(new CustomEvent("ami-voice:recognizing-changed", { detail: false }));
      }),
      abort: vi.fn(),
    } as never;

    await el.start();

    // The post-await bail must keep the mic from arming for the dead session.
    expect(startMic).not.toHaveBeenCalled();
    expect(el._dataPlaneLive).toBe(false);
    el.remove();
  });
});

/**
 * Relay-mode start() error edges (latent edge b): a re-entrant start() the
 * server ignores (empty session id) must NOT be converted into a destructive
 * `invoke("abort")` that tears down the live session it collided with; a genuine
 * failure AFTER a fresh session opened (audio-channel open throws) SHOULD roll
 * back via `invoke("abort")`. Neither path is exercised by the relay integration
 * test (it drives the proxy directly, never the Shell), so pin both here.
 */
describe("<ami-voice> relay-mode start() error edges", () => {
  type FakeProxy = { invoke: (name: string) => Promise<unknown>; dispose: () => void };
  type RelayShell = HTMLElement & ShellInternals & {
    start(): Promise<void>;
    _core: unknown;
    _proxy: FakeProxy | null;
    _startMicRemote: (session: unknown) => Promise<void>;
    error: unknown;
  };

  function makeRelayShell(invoke: (name: string) => Promise<unknown>): RelayShell {
    const el = document.createElement("ami-voice") as unknown as RelayShell;
    el.setAttribute("mode", "remote");
    // A valid ws:// URL lets connectedCallback's relay connect pass validation;
    // we immediately replace the real proxy/core with stubs so start() takes the
    // remote `else` path without driving a live socket.
    el.setAttribute("remote-url", "ws://localhost:0/ctl");
    document.body.appendChild(el);
    el._core = null;
    el._proxy = { invoke: vi.fn(invoke), dispose: vi.fn() };
    return el;
  }

  it("an empty server session id is a benign no-op: surfaces an error, does NOT invoke abort", async () => {
    const invoke = vi.fn(async (name: string) => (name === "start" ? "" : undefined));
    const el = makeRelayShell(invoke) as RelayShell & { _values: Record<string, unknown> };
    // The bound server state says a session is live: the server ignored the start.
    el._values.recognizing = true;

    await el.start();

    // The server ignored the start (already active). We must NOT abort it.
    const names = (el._proxy!.invoke as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(names).toContain("start");
    expect(names).not.toContain("abort");
    expect((el.error as { message: string }).message).toMatch(/already active/); // benign notice surfaced
    el.remove();
  });

  it("an empty session id from an IDLE server keeps the server-published cause (no \"already active\" overwrite)", async () => {
    // relay start() failure: the server published the real cause to `error` and
    // settled recognizing/loading=false BEFORE resolving null (SPEC §17).
    const cause = { name: "AmiVoiceError", message: "illegal service authorization", code: "auth" };
    const invoke = vi.fn(async (name: string) => (name === "start" ? null : undefined));
    const el = makeRelayShell(invoke) as RelayShell & { _values: Record<string, unknown> };
    el._values.recognizing = false;
    el._values.loading = false;
    el._values.error = cause;

    await el.start();

    const names = (el._proxy!.invoke as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(names).not.toContain("abort");
    expect(el.error).toBe(cause);
    expect(el._dataPlaneLive).toBe(false);
    el.remove();
  });

  it("rolls back via invoke('abort') when the audio channel fails after a fresh session opened", async () => {
    const invoke = vi.fn(async (name: string) => (name === "start" ? "SESSION-1" : undefined));
    const el = makeRelayShell(invoke);
    // A real token came back, but opening the audio channel / mic throws.
    el._startMicRemote = vi.fn(async () => { throw new Error("audio channel failed"); }) as never;

    await el.start();

    const names = (el._proxy!.invoke as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(names).toContain("start");
    expect(names).toContain("abort"); // a genuine partial start IS rolled back
    el.remove();
  });
});
