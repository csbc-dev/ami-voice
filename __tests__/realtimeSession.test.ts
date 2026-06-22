import { describe, it, expect } from "vitest";
import { runRealtimeSession, type RealtimeSocket } from "../src/protocol/realtimeSession";
import { AmiVoiceError } from "../src/errorCodes";
import type { RealtimeSessionHandlers } from "../src/types";

/** Drivable fake — `close()` fires `onclose` synchronously (like a real socket teardown). */
class FakeSocket implements RealtimeSocket {
  sent: Array<string | Uint8Array> = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((data: string) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((err: unknown) => void) | null = null;

  send(data: string | ArrayBufferView): void {
    if (typeof data === "string") this.sent.push(data);
    else this.sent.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }
  close(): void { if (this.closed) return; this.closed = true; this.onclose?.(); }

  // test drivers
  open(): void { this.onopen?.(); }
  recv(msg: string): void { this.onmessage?.(msg); }
  /** Simulate an upstream-initiated drop (server closed the socket on us). */
  drop(): void { this.close(); }
}

function handlers(): RealtimeSessionHandlers & { calls: Record<string, unknown[][]> } {
  const calls: Record<string, unknown[][]> = {};
  const rec = (k: string) => (...a: unknown[]): void => { (calls[k] ??= []).push(a); };
  return {
    onSegmentStart: rec("segStart"),
    onSegmentEnd: rec("segEnd"),
    onRecognitionStart: rec("recStart"),
    onInterim: rec("interim"),
    onFinal: rec("final"),
    onError: rec("error"),
    onClose: rec("close"),
    calls,
  };
}

const START = "s LSB16K -a-general authorization=KEY";

/** Bring a session to the started state (s sent + s-ack). */
async function startSession(fake: FakeSocket, h: RealtimeSessionHandlers, stopTimeoutMs = 5000) {
  const p = runRealtimeSession(fake, START, h, stopTimeoutMs);
  fake.open();
  fake.recv("s");
  return p;
}

describe("runRealtimeSession — upstream reconnect policy (3.1 / Q3)", () => {
  it("surfaces an unexpected mid-session drop as onError(upstream) + onClose", async () => {
    const fake = new FakeSocket();
    const h = handlers();
    await startSession(fake, h);

    fake.drop(); // upstream closed the socket, not us

    expect(h.calls.error).toHaveLength(1);
    const err = h.calls.error[0][0] as AmiVoiceError;
    expect(err).toBeInstanceOf(AmiVoiceError);
    expect(err.code).toBe("upstream");
    expect(h.calls.close).toHaveLength(1);
  });

  it("does NOT report an error when stop() closes the socket (graceful)", async () => {
    const fake = new FakeSocket();
    const h = handlers();
    const session = await startSession(fake, h);

    const stopped = session.stop();
    expect(fake.sent).toContain("e");
    fake.recv("e"); // e-ack → graceful close
    await stopped;

    expect(h.calls.error).toBeUndefined();
    expect(h.calls.close).toHaveLength(1);
  });

  it("does NOT report an error when the stop() fallback timer closes the socket", async () => {
    const fake = new FakeSocket();
    const h = handlers();
    const session = await startSession(fake, h, /* stopTimeoutMs */ 1);

    // No e-ack arrives; the bounded fallback settles and closes (D1) without error.
    await session.stop();

    expect(h.calls.error).toBeUndefined();
    expect(h.calls.close).toHaveLength(1);
  });

  it("does NOT report an error when abort() closes the socket (immediate)", async () => {
    const fake = new FakeSocket();
    const h = handlers();
    const session = await startSession(fake, h);

    session.abort();

    expect(h.calls.error).toBeUndefined();
    expect(h.calls.close).toHaveLength(1);
  });

  it("a drop during a graceful stop is not misreported as an upstream error", async () => {
    const fake = new FakeSocket();
    const h = handlers();
    const session = await startSession(fake, h);

    void session.stop(); // marks the teardown intentional, sends `e`
    fake.drop();         // upstream drops before acking `e`

    expect(h.calls.error).toBeUndefined();
    expect(h.calls.close).toHaveLength(1);
  });
});

describe("runRealtimeSession — event routing", () => {
  it("routes S/E/C/U/A and ignores G; frames audio with the 'p' (0x70) prefix", async () => {
    const fake = new FakeSocket();
    const h = handlers();
    const session = await startSession(fake, h);

    fake.recv("S 100");
    fake.recv("E 200");
    fake.recv("C");
    fake.recv('U {"text":"こん","results":[{"tokens":[]}]}');
    fake.recv('A {"text":"こんにちは","results":[{"text":"こんにちは","confidence":0.9,"tokens":[]}]}');
    fake.recv("G opaque-server-info"); // ignored for v1 (implementation-notes D4)
    fake.recv("");                     // empty/unknown frame — ignored

    expect(h.calls.segStart?.[0][0]).toBe(100);
    expect(h.calls.segEnd?.[0][0]).toBe(200);
    expect(h.calls.recStart).toHaveLength(1);
    expect(h.calls.interim).toHaveLength(1);
    expect(h.calls.final).toHaveLength(1);
    expect(h.calls.error).toBeUndefined();

    session.feedAudio(new Uint8Array([1, 2, 3]));
    const bin = fake.sent.find((s) => s instanceof Uint8Array) as Uint8Array;
    expect(bin[0]).toBe(0x70);
    expect(Array.from(bin.slice(1))).toEqual([1, 2, 3]);
  });

  it("surfaces a non-ok p/e ack as onError after start", async () => {
    const fake = new FakeSocket();
    const h = handlers();
    await startSession(fake, h);
    fake.recv("p frame rejected");
    expect(h.calls.error).toHaveLength(1);
  });

  it("rejects before start on socket error", async () => {
    const fake = new FakeSocket();
    const p = runRealtimeSession(fake, START, handlers(), 5000);
    fake.open();
    fake.onerror?.(new Error("boom"));
    await expect(p).rejects.toThrow(/boom/);
  });
});
