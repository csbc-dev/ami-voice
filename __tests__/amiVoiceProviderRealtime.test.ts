import { describe, it, expect } from "vitest";
import { AmiVoiceProvider, type RealtimeSocket } from "../src/providers/AmiVoiceProvider";
import type { RealtimeSessionHandlers } from "../src/types";

class FakeSocket implements RealtimeSocket {
  sent: Array<string | Uint8Array> = [];
  onopen: (() => void) | null = null;
  onmessage: ((data: string) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((err: unknown) => void) | null = null;

  send(data: string | ArrayBufferView): void {
    if (typeof data === "string") this.sent.push(data);
    else this.sent.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }
  close(): void { this.onclose?.(); }

  // test drivers
  open(): void { this.onopen?.(); }
  recv(msg: string): void { this.onmessage?.(msg); }
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

const OPTS = { engine: "-a-general", codec: "LSB16K" } as const;

describe("AmiVoiceProvider realtime", () => {
  it("sends the s-command on open and resolves on the s-ack", async () => {
    const fake = new FakeSocket();
    const provider = new AmiVoiceProvider({ appKey: "KEY", socketFactory: () => fake });
    const p = provider.openRealtimeSession(OPTS, handlers());
    fake.open();
    expect(fake.sent[0]).toBe("s LSB16K -a-general authorization=KEY");
    fake.recv("s");
    await expect(p).resolves.toHaveProperty("feedAudio");
  });

  it("routes U / A events to handlers after start", async () => {
    const fake = new FakeSocket();
    const provider = new AmiVoiceProvider({ appKey: "K", socketFactory: () => fake });
    const h = handlers();
    const p = provider.openRealtimeSession(OPTS, h);
    fake.open(); fake.recv("s");
    await p;
    fake.recv('U {"text":"こん","results":[{"tokens":[]}]}');
    fake.recv('A {"text":"こんにちは","results":[{"text":"こんにちは","confidence":0.9,"tokens":[]}]}');
    expect(h.calls.interim).toHaveLength(1);
    expect(h.calls.final).toHaveLength(1);
    expect((h.calls.final[0][0] as { confidence: number }).confidence).toBe(0.9);
  });

  it("feedAudio sends a binary frame prefixed with 'p' (0x70)", async () => {
    const fake = new FakeSocket();
    const provider = new AmiVoiceProvider({ appKey: "K", socketFactory: () => fake });
    const p = provider.openRealtimeSession(OPTS, handlers());
    fake.open(); fake.recv("s");
    const session = await p;
    session.feedAudio(new Uint8Array([1, 2, 3]));
    const bin = fake.sent.find((s) => s instanceof Uint8Array) as Uint8Array;
    expect(bin[0]).toBe(0x70);
    expect(Array.from(bin.slice(1))).toEqual([1, 2, 3]);
  });

  it("stop() sends 'e' and resolves on the e-ack", async () => {
    const fake = new FakeSocket();
    const provider = new AmiVoiceProvider({ appKey: "K", socketFactory: () => fake });
    const p = provider.openRealtimeSession(OPTS, handlers());
    fake.open(); fake.recv("s");
    const session = await p;
    const stopped = session.stop();
    expect(fake.sent).toContain("e");
    fake.recv("e");
    await expect(stopped).resolves.toBeUndefined();
  });

  it("rejects when the s-command is rejected", async () => {
    const fake = new FakeSocket();
    const provider = new AmiVoiceProvider({ appKey: "K", socketFactory: () => fake });
    const p = provider.openRealtimeSession(OPTS, handlers());
    fake.open();
    fake.recv("s authentication failed");
    await expect(p).rejects.toThrow(/authentication failed/);
  });

  it("throws when no APPKEY is configured", async () => {
    const provider = new AmiVoiceProvider({ appKey: "", socketFactory: () => new FakeSocket() });
    await expect(provider.openRealtimeSession(OPTS, handlers())).rejects.toThrow(/APPKEY/);
  });
});
