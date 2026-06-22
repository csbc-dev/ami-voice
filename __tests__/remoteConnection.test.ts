import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openAudioChannel, validateRemoteCoreUrl } from "../src/components/remoteConnection";

/**
 * The audio channel is correlated to the control session by a token that, per
 * SPEC §11.3, MUST ride `Sec-WebSocket-Protocol` (the `WebSocket` constructor's
 * second argument), not the query string. These tests pin that wire so a
 * regression to `?session=` (which leaks the bearer token into access logs and
 * breaks single-port subprotocol routing) is caught without a browser.
 */

interface CapturedSocket {
  url: string;
  protocols: string | string[] | undefined;
  binaryType: string;
}

let captured: CapturedSocket[];
const RealWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket;

class TrackingWebSocket {
  url: string;
  protocols: string | string[] | undefined;
  private _binaryType = "blob";
  constructor(url: string, protocols?: string | string[]) {
    this.url = url;
    this.protocols = protocols;
    captured.push({ url, protocols, binaryType: this._binaryType });
  }
  get binaryType(): string {
    return this._binaryType;
  }
  set binaryType(v: string) {
    this._binaryType = v;
    captured[captured.length - 1].binaryType = v;
  }
}

beforeEach(() => {
  captured = [];
  (globalThis as { WebSocket?: unknown }).WebSocket = TrackingWebSocket as unknown;
});

afterEach(() => {
  (globalThis as { WebSocket?: unknown }).WebSocket = RealWebSocket;
});

describe("openAudioChannel", () => {
  it("carries the session token in Sec-WebSocket-Protocol, not the query string", () => {
    openAudioChannel("ws://localhost:3200/", "sess-token-123");
    expect(captured).toHaveLength(1);
    const sock = captured[0];
    // Token rides the subprotocol (second constructor arg).
    expect(sock.protocols).toEqual(["sess-token-123"]);
    // URL is left untouched — no `?session=` leak.
    expect(sock.url).toBe("ws://localhost:3200/");
    expect(sock.url).not.toContain("session");
  });

  it("sets binaryType to arraybuffer so PCM frames are byte buffers, not Blobs", () => {
    openAudioChannel("wss://relay.example.com/", "tok");
    expect(captured[0].binaryType).toBe("arraybuffer");
  });

  it("rejects a non-ws(s) audio URL before opening a socket", () => {
    expect(() => openAudioChannel("http://localhost/", "tok")).toThrow();
    expect(captured).toHaveLength(0);
  });
});

describe("validateRemoteCoreUrl", () => {
  it("accepts ws:// and wss:// and returns the URL unchanged", () => {
    expect(validateRemoteCoreUrl("ws://a/")).toBe("ws://a/");
    expect(validateRemoteCoreUrl("wss://a/")).toBe("wss://a/");
  });

  it("rejects an empty URL", () => {
    expect(() => validateRemoteCoreUrl("")).toThrow(/not configured/);
  });

  it("rejects a malformed URL", () => {
    expect(() => validateRemoteCoreUrl("not a url")).toThrow(/not a valid URL/);
  });

  it("rejects a non-ws scheme", () => {
    expect(() => validateRemoteCoreUrl("https://a/")).toThrow(/ws:\/\/ or wss:\/\//);
  });
});
