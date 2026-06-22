import { describe, it, expect } from "vitest";
import { buildStartCommand, parseEvent } from "../src/protocol/wnnProtocol";

describe("buildStartCommand", () => {
  it("builds `s <audio_format> <grammar> <params> authorization=<key>`", () => {
    const cmd = buildStartCommand(
      { engine: "-a-general", codec: "LSB16K", resultUpdatedInterval: 1000 },
      "KEY",
    );
    expect(cmd).toBe("s LSB16K -a-general resultUpdatedInterval=1000 authorization=KEY");
  });

  it("quotes values containing whitespace or `=`", () => {
    const cmd = buildStartCommand(
      { engine: "-a-general", codec: "16K", segmenterProperties: "useDiarizer=1" },
      "K",
    );
    expect(cmd).toContain('segmenterProperties="useDiarizer=1"');
  });

  it("always appends authorization last", () => {
    const cmd = buildStartCommand(
      { engine: "-a-general", codec: "16K", profileId: "p1", keepFillerToken: true },
      "SECRET",
    );
    expect(cmd.endsWith("authorization=SECRET")).toBe(true);
  });
});

describe("parseEvent", () => {
  it("parses S / E speech-segment timestamps", () => {
    expect(parseEvent("S 6200")).toEqual({ type: "S", ms: 6200 });
    expect(parseEvent("E 7450")).toEqual({ type: "E", ms: 7450 });
  });

  it("parses C (recognition started)", () => {
    expect(parseEvent("C")).toEqual({ type: "C" });
  });

  it("parses U interim payloads (text + tokens, no segment confidence)", () => {
    const ev = parseEvent(
      'U {"text":"こんにち","results":[{"tokens":[{"written":"こんにち","spoken":"こんにち","confidence":0.8,"starttime":0,"endtime":500}]}]}',
    );
    expect(ev.type).toBe("U");
    if (ev.type === "U") {
      expect(ev.result.text).toBe("こんにち");
      expect(ev.result.tokens[0].written).toBe("こんにち");
    }
  });

  it("parses A final payloads (with segment confidence + utteranceid)", () => {
    const ev = parseEvent(
      'A {"text":"こんにちは","utteranceid":"u1","results":[{"text":"こんにちは","confidence":0.95,"starttime":0,"endtime":800,"tokens":[]}]}',
    );
    expect(ev.type).toBe("A");
    if (ev.type === "A") {
      expect(ev.result.text).toBe("こんにちは");
      expect(ev.result.confidence).toBe(0.95);
      expect(ev.result.utteranceid).toBe("u1");
    }
  });

  it("parses command acks (ok and error)", () => {
    expect(parseEvent("s")).toEqual({ type: "ack", command: "s", ok: true });
    expect(parseEvent("s connection refused")).toEqual({
      type: "ack",
      command: "s",
      ok: false,
      message: "connection refused",
    });
  });

  it("tolerates malformed JSON without throwing", () => {
    const ev = parseEvent("U not-json");
    expect(ev.type).toBe("U");
    if (ev.type === "U") expect(ev.result.text).toBe("");
  });
});
