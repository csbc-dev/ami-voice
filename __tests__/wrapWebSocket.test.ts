import { describe, it, expect, vi, afterEach } from "vitest";
import { wrapWebSocket } from "../src/protocol/realtimeSession";

/**
 * `wrapWebSocket` is the single WebSocket→RealtimeSocket adapter shared by the
 * relay provider and the browser-direct path (docs/adr/0006 rule 3 — one impl).
 * It is normally driven by a live socket the unit suite bypasses with injected
 * fakes, so it is pinned here against a stubbed global `WebSocket`.
 */

class FakeWS {
  static last: FakeWS | null = null;
  url: string;
  binaryType = "";
  sent: unknown[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  constructor(url: string) { this.url = url; FakeWS.last = this; }
  send(d: unknown): void { this.sent.push(d); }
  close(): void { this.closed = true; }
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("wrapWebSocket", () => {
  it("sets arraybuffer binaryType and delegates send/close to the socket", () => {
    vi.stubGlobal("WebSocket", FakeWS);
    const sock = wrapWebSocket("wss://example.test/v1/");
    const ws = FakeWS.last!;

    expect(ws.binaryType).toBe("arraybuffer");
    sock.send("hello");
    expect(ws.sent).toEqual(["hello"]);
    sock.close();
    expect(ws.closed).toBe(true);
  });

  it("forwards open/close/error and string-only messages", () => {
    vi.stubGlobal("WebSocket", FakeWS);
    const sock = wrapWebSocket("wss://example.test/v1/");
    const ws = FakeWS.last!;

    const seen: string[] = [];
    sock.onopen = () => seen.push("open");
    sock.onclose = () => seen.push("close");
    sock.onerror = () => seen.push("error");
    sock.onmessage = (m) => seen.push(`msg:${m}`);

    ws.onopen?.();
    ws.onmessage?.({ data: "S 100" });          // string → forwarded
    ws.onmessage?.({ data: new ArrayBuffer(2) }); // binary → dropped (events are text)
    ws.onerror?.(new Error("x"));
    ws.onclose?.();

    expect(seen).toEqual(["open", "msg:S 100", "error", "close"]);
  });
});
