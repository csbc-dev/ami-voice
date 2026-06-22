import { describe, it, expect } from "vitest";
import { openDirectRealtimeSession, DirectBrowserProvider } from "../src/components/realtimeSocket";
import type { RealtimeSocket } from "../src/protocol/realtimeSession";
import type { RealtimeSessionHandlers, DirectSessionInfo } from "../src/types";

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

const SESSION: DirectSessionInfo = {
  endpoint: "wss://acp-api.amivoice.com/v1/",
  sCommand: "s LSB16K -a-general authorization=ONETIME",
};

/**
 * Browser-direct session loop (docs/adr/0006). The browser sends the SERVER-
 * approved `s` command verbatim and parses events client-side, reusing the same
 * `runRealtimeSession` / `parseEvent` the relay path uses (no parallel paths).
 */
describe("openDirectRealtimeSession", () => {
  it("sends the server-approved s command on open and resolves on the s-ack", async () => {
    const fake = new FakeSocket();
    const p = openDirectRealtimeSession({ ...SESSION, socketFactory: () => fake }, handlers());
    fake.open();
    expect(fake.sent[0]).toBe("s LSB16K -a-general authorization=ONETIME");
    fake.recv("s");
    await expect(p).resolves.toHaveProperty("feedAudio");
  });

  it("parses U / A events client-side after start", async () => {
    const fake = new FakeSocket();
    const h = handlers();
    const p = openDirectRealtimeSession({ ...SESSION, socketFactory: () => fake }, h);
    fake.open(); fake.recv("s");
    await p;
    fake.recv('U {"text":"こん","results":[{"tokens":[]}]}');
    fake.recv('A {"text":"こんにちは","results":[{"text":"こんにちは","confidence":0.9,"tokens":[]}]}');
    expect(h.calls.interim).toHaveLength(1);
    expect((h.calls.interim[0][0] as { text: string }).text).toBe("こん");
    expect(h.calls.final).toHaveLength(1);
    expect((h.calls.final[0][0] as { confidence: number }).confidence).toBe(0.9);
  });

  it("frames audio with the 'p' (0x70) prefix, streamed directly", async () => {
    const fake = new FakeSocket();
    const p = openDirectRealtimeSession({ ...SESSION, socketFactory: () => fake }, handlers());
    fake.open(); fake.recv("s");
    const session = await p;
    session.feedAudio(new Uint8Array([1, 2, 3]));
    const bin = fake.sent.find((s) => s instanceof Uint8Array) as Uint8Array;
    expect(bin[0]).toBe(0x70);
    expect(Array.from(bin.slice(1))).toEqual([1, 2, 3]);
  });

  it("stop() sends 'e' and resolves on the e-ack", async () => {
    const fake = new FakeSocket();
    const p = openDirectRealtimeSession({ ...SESSION, socketFactory: () => fake }, handlers());
    fake.open(); fake.recv("s");
    const session = await p;
    const stopped = session.stop();
    expect(fake.sent).toContain("e");
    fake.recv("e");
    await expect(stopped).resolves.toBeUndefined();
  });

  it("rejects when the approved s command is refused upstream", async () => {
    const fake = new FakeSocket();
    const p = openDirectRealtimeSession({ ...SESSION, socketFactory: () => fake }, handlers());
    fake.open();
    fake.recv("s expired one-time key");
    await expect(p).rejects.toThrow(/expired one-time key/);
  });
});

describe("DirectBrowserProvider", () => {
  it("requests a session from the server then opens the WSS directly", async () => {
    const fake = new FakeSocket();
    let requested = 0;
    const provider = new DirectBrowserProvider(
      async () => { requested++; return SESSION; },
      { socketFactory: () => fake },
    );
    const p = provider.openRealtimeSession({ engine: "-a-general", codec: "LSB16K" }, handlers());
    // `openRealtimeSession` awaits the server mint before wiring the socket;
    // yield until the session loop has attached its `onopen` handler.
    while (!fake.onopen) await new Promise((r) => setTimeout(r, 0));
    fake.open(); fake.recv("s");
    const session = await p;
    expect(requested).toBe(1);
    expect(fake.sent[0]).toBe(SESSION.sCommand);
    expect(session).toHaveProperty("feedAudio");
  });

  it("refuses file recognition (browser-direct has no file data plane)", async () => {
    const provider = new DirectBrowserProvider(async () => SESSION);
    await expect(provider.recognizeFile()).rejects.toThrow(/not available in browser-direct/);
  });
});
