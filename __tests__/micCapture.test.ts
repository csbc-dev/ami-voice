import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MicCapture } from "../src/components/micCapture";

// MicCapture is a browser-only data plane (getUserMedia → AudioContext →
// AudioWorklet). These tests inject fakes for those globals so the cycle-2
// cancellation race (a stop() that interleaves an in-flight start() — the path
// that, if wrong, leaks a live mic / orphans an AudioContext after teardown) is
// exercised. Both branches are covered: cancel-after-getUserMedia and
// cancel-during/after-addModule, plus the normal source→node wiring.

interface FakeTrack { stop: ReturnType<typeof vi.fn>; }
interface FakeStream { getTracks: () => FakeTrack[]; _tracks: FakeTrack[]; }

function makeStream(): FakeStream {
  const tracks: FakeTrack[] = [{ stop: vi.fn() }, { stop: vi.fn() }];
  return { _tracks: tracks, getTracks: () => tracks };
}

/** A manually-settleable deferred so the test can interleave stop() mid-await. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  sampleRate = 16000;
  closed = false;
  close = vi.fn(async () => {
    if (this.closed) throw new Error("InvalidStateError"); // mirror real double-close reject
    this.closed = true;
  });
  addModuleDeferred = deferred<void>();
  audioWorklet = { addModule: vi.fn(() => this.addModuleDeferred.promise) };
  createMediaStreamSource = vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() }));
  constructor() { FakeAudioContext.instances.push(this); }
}

class FakeAudioWorkletNode {
  port = { onmessage: null as unknown, postMessage: vi.fn() };
  disconnect = vi.fn();
  constructor(public ctx: unknown, public name: string) {}
}

let getUserMediaDeferred: ReturnType<typeof deferred<FakeStream>>;
let getUserMedia: ReturnType<typeof vi.fn>;

beforeEach(() => {
  FakeAudioContext.instances = [];
  getUserMediaDeferred = deferred<FakeStream>();
  getUserMedia = vi.fn(() => getUserMediaDeferred.promise);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  vi.stubGlobal("AudioContext", FakeAudioContext as unknown);
  vi.stubGlobal("AudioWorkletNode", FakeAudioWorkletNode as unknown);
  vi.stubGlobal("URL", {
    createObjectURL: vi.fn(() => "blob:fake"),
    revokeObjectURL: vi.fn(),
  });
  vi.stubGlobal("Blob", class { constructor(public parts: unknown, public opts: unknown) {} } as unknown);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const handlers = { onFrame: vi.fn(), onLevel: vi.fn(), onError: vi.fn() };

describe("MicCapture cancellation race (cycle-2 _generation)", () => {
  it("cancel after getUserMedia resolves: releases tracks, builds NO AudioContext", async () => {
    const mic = new MicCapture();
    const started = mic.start(handlers);
    // stop() arrives while getUserMedia is still pending.
    mic.stop();
    const stream = makeStream();
    getUserMediaDeferred.resolve(stream);
    await started;

    // The just-granted device is released and no capture graph is built.
    for (const t of stream._tracks) expect(t.stop).toHaveBeenCalledTimes(1);
    expect(FakeAudioContext.instances).toHaveLength(0);
  });

  it("cancel during addModule: closes the ctx, stops tracks, nulls fields", async () => {
    const mic = new MicCapture();
    const started = mic.start(handlers);
    const stream = makeStream();
    getUserMediaDeferred.resolve(stream);
    // Let getUserMedia's continuation run so we are now awaiting addModule.
    await Promise.resolve();
    await Promise.resolve();
    const ctx = FakeAudioContext.instances[0];
    expect(ctx).toBeDefined();

    // stop() arrives while addModule is still pending: it closes THIS ctx.
    mic.stop();
    expect(ctx.close).toHaveBeenCalledTimes(1);
    // addModule now resolves; the post-addModule cancellation branch runs.
    ctx.addModuleDeferred.resolve();
    await started;

    for (const t of stream._tracks) expect(t.stop).toHaveBeenCalled();
    // No worklet node was wired (we bailed before constructing it).
    expect(ctx.createMediaStreamSource).not.toHaveBeenCalled();
    // The double close() (stop() + cleanup branch) does not throw out of start().
  });

  it("normal path: wires source→node and never connects to destination", async () => {
    const mic = new MicCapture();
    const started = mic.start(handlers);
    const stream = makeStream();
    getUserMediaDeferred.resolve(stream);
    await Promise.resolve();
    await Promise.resolve();
    const ctx = FakeAudioContext.instances[0];
    ctx.addModuleDeferred.resolve();
    await started;

    expect(ctx.createMediaStreamSource).toHaveBeenCalledTimes(1);
    const source = ctx.createMediaStreamSource.mock.results[0].value as { connect: ReturnType<typeof vi.fn> };
    // Connected to the worklet node only (one connect call, no destination).
    expect(source.connect).toHaveBeenCalledTimes(1);
    const arg = source.connect.mock.calls[0][0];
    expect(arg).toBeInstanceOf(FakeAudioWorkletNode);

    // A subsequent stop() tears everything down without throwing on close().
    mic.stop();
    for (const t of stream._tracks) expect(t.stop).toHaveBeenCalled();
  });
});
