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

  it("stop() resolves the moment the socket closes, not on the fallback timer", async () => {
    const fake = new FakeSocket();
    const h = handlers();
    // A long fallback timeout: if stop() only settled via the timer, this would
    // not resolve for ~1 min. The onclose-settle wiring resolves it immediately.
    const session = await startSession(fake, h, /* stopTimeoutMs */ 60_000);

    const stopped = session.stop();
    expect(fake.sent).toContain("e");
    fake.drop(); // server closes after `e` without an explicit `e` ack
    await stopped; // resolves now, not after 60s

    expect(h.calls.error).toBeUndefined();
    expect(h.calls.close).toHaveLength(1);
  });

  it("a second concurrent stop() joins the first and both settle on the e-ack (no fallback delay)", async () => {
    const fake = new FakeSocket();
    const h = handlers();
    // Long fallback: if the first stop()'s settle hook were orphaned by the
    // second, p1 would hang until ~60s rather than resolving on the e-ack.
    const session = await startSession(fake, h, /* stopTimeoutMs */ 60_000);

    const p1 = session.stop();
    const p2 = session.stop(); // second stop while the first is in flight
    expect(p2).toBe(p1);       // idempotent: same in-flight promise, no re-arm

    fake.recv("e"); // single e-ack settles the (single) graceful stop
    await Promise.all([p1, p2]);

    expect(h.calls.error).toBeUndefined();
    expect(h.calls.close).toHaveLength(1); // socket closed exactly once
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

  it("routes an after-start socket error to onError WITHOUT rejecting", async () => {
    const fake = new FakeSocket();
    const h = handlers();
    const session = await startSession(fake, h);

    fake.onerror?.(new Error("mid-stream"));

    expect(h.calls.error).toHaveLength(1);
    expect((h.calls.error[0][0] as Error).message).toMatch(/mid-stream/);
    // The session promise already resolved at start; the error did not reject it.
    expect(session).toHaveProperty("feedAudio");
  });

  it("settles stop() even if socket.send('e') throws", async () => {
    const fake = new FakeSocket();
    const h = handlers();
    const session = await startSession(fake, h);
    fake.send = () => { throw new Error("send failed"); };

    // The send-throw fallback must settle the stop, not hang or reject.
    await expect(session.stop()).resolves.toBeUndefined();
    expect(h.calls.close).toHaveLength(1);
  });
});

/**
 * The `s` command carries the APPKEY (`authorization=`). `onopen` runs from the
 * socket's own event dispatch, so a `send` that throws there used to escape
 * the loop raw — to the platform's uncaught-exception reporting, past the
 * Core's redaction — while start() waited out the connect deadline.
 */
describe("runRealtimeSession — a send of the `s` command that throws", () => {
  it("rejects the handshake with the thrown value, closes the socket, and never reaches the deadline", async () => {
    const fake = new FakeSocket();
    const h = handlers();
    const thrown = new Error(`cannot send ${START}`);
    fake.send = () => { throw thrown; };
    const p = runRealtimeSession(fake, START, h, 5000, /* connectTimeoutMs */ 5);

    expect(() => fake.open()).not.toThrow(); // nothing escapes the socket's event handler

    // The thrown value itself: the Core shapes (and redacts) it with toError.
    await expect(p).rejects.toBe(thrown);
    expect(fake.closed).toBe(true); // no close follows a failed send — the loop closes it, like an `s` rejection
    await new Promise((r) => setTimeout(r, 20)); // past the 5 ms deadline: it was cleared
    expect(h.calls.error).toBeUndefined();
    expect(h.calls.close).toBeUndefined();
  });

  it("passes a non-Error value on as it is", async () => {
    const fake = new FakeSocket();
    const thrown = `cannot send ${START}`;
    fake.send = () => { throw thrown; };
    const p = runRealtimeSession(fake, START, handlers(), 5000);

    fake.open();
    await expect(p).rejects.toBe(thrown);
    expect(fake.closed).toBe(true);
  });

  it("a send that settles the handshake itself (onerror) before throwing keeps that outcome", async () => {
    const fake = new FakeSocket();
    const socketError = new Error("socket error");
    fake.send = () => {
      fake.onerror?.(socketError);
      throw new Error(`cannot send ${START}`);
    };
    const p = runRealtimeSession(fake, START, handlers(), 5000);

    expect(() => fake.open()).not.toThrow();
    await expect(p).rejects.toBe(socketError);
  });
});

describe("runRealtimeSession — start-rejection classification (Q7/Q8)", () => {
  it("classifies an s-command rejection as retryable/unknown, not auth", async () => {
    const fake = new FakeSocket();
    const p = runRealtimeSession(fake, START, handlers(), 5000);
    fake.open();
    fake.recv("s recognizer server is busy"); // non-auth rejection (free-text)
    // AmiVoice rejects `s` for many non-auth reasons; the loop must not assert
    // `auth`/non-retryable. Neutral `unknown` code, retryable, message preserved.
    const err = await p.catch((e) => e as AmiVoiceError);
    expect(err).toBeInstanceOf(AmiVoiceError);
    expect(err.code).toBe("unknown");
    expect(err.retryable).toBe(true);
    expect(err.message).toMatch(/recognizer server is busy/);
    // A protocol-level `s` rejection has no follow-up close, so the loop must
    // close the socket itself — otherwise each rejected start orphans a live WSS.
    expect(fake.closed).toBe(true);
  });
});

/** Like FakeSocket but `close()` defers `onclose` (real sockets fire it async). */
class AsyncCloseSocket extends FakeSocket {
  close(): void { if (this.closed) return; this.closed = true; /* onclose fires later via fireClose() */ }
  fireClose(): void { this.onclose?.(); }
}

describe("runRealtimeSession — late s-ack after settle (async close window)", () => {
  it("a late ok s-ack arriving after a connect-timeout reject does not flip started or fire a spurious drop", async () => {
    const fake = new AsyncCloseSocket();
    const h = handlers();
    // Connect-timeout rejects and calls close() (which here does NOT fire onclose yet).
    const p = runRealtimeSession(fake, START, h, 5000, /* connectTimeoutMs */ 5);
    fake.open();
    const err = await p.catch((e) => e as AmiVoiceError);
    expect(err).toBeInstanceOf(AmiVoiceError);
    expect(err.message).toMatch(/within 5ms/);

    // In the async close window a late ok `s`-ack still arrives at onmessage.
    fake.recv("s");
    // Then the deferred onclose finally runs.
    fake.fireClose();

    // The late ack must NOT have flipped `started`, so no "connection lost
    // mid-session" error and no onClose for a session that never started.
    expect(h.calls.error).toBeUndefined();
    expect(h.calls.close).toBeUndefined();
  });
});

describe("runRealtimeSession — connect/ack deadline", () => {
  it("rejects when the s-ack never arrives within connectTimeoutMs", async () => {
    const fake = new FakeSocket();
    // Open the socket but never deliver the `s` ack and never close.
    const p = runRealtimeSession(fake, START, handlers(), 5000, /* connectTimeoutMs */ 5);
    fake.open();
    const err = await p.catch((e) => e as AmiVoiceError);
    expect(err).toBeInstanceOf(AmiVoiceError);
    expect(err.code).toBe("upstream");
    expect(err.message).toMatch(/within 5ms/);
    expect(fake.closed).toBe(true); // the stalled socket is closed
  });

  it("does NOT fire the connect deadline once the session has started", async () => {
    const fake = new FakeSocket();
    const h = handlers();
    await startSession(fake, h, 5000); // s-ack arrives → timer cleared
    // Wait past a short deadline window; nothing should error/close.
    await new Promise((r) => setTimeout(r, 10));
    expect(h.calls.error).toBeUndefined();
    expect(fake.closed).toBe(false);
  });
});

describe("runRealtimeSession — e-ack error handling", () => {
  it("surfaces a non-ok e ack as onError but still settles the graceful stop", async () => {
    const fake = new FakeSocket();
    const h = handlers();
    const session = await startSession(fake, h);

    const stopped = session.stop();
    expect(fake.sent).toContain("e");
    fake.recv("e failed to finalize"); // error e-ack
    await expect(stopped).resolves.toBeUndefined(); // stop still settles

    expect(h.calls.error).toHaveLength(1);
    expect((h.calls.error[0][0] as AmiVoiceError).message).toMatch(/failed to finalize/);
  });
});
