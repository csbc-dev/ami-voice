import { describe, it, expect, beforeAll } from "vitest";
import { AmiVoice } from "../src/components/AmiVoice";
import { AmiVoiceCore } from "../src/core/AmiVoiceCore";

beforeAll(() => {
  if (!customElements.get("ami-voice")) customElements.define("ami-voice", AmiVoice);
});

/**
 * The wcBindable declaration is a CONTRACT that external tooling trusts when it
 * introspects the element to wire up bindings. Anything advertised as a command
 * MUST be callable as a method on instances. Declaration drift is the exact bug
 * class that makes a generic adapter blow up with `element.start is not a function`.
 */
describe("AmiVoice wcBindable contract", () => {
  it("declares exactly the element-level commands the Shell implements", () => {
    const cmdNames = (AmiVoice.wcBindable.commands ?? []).map((c) => c.name).sort();
    expect(cmdNames).toEqual(["abort", "reset", "start", "stop"]);
  });

  it("does NOT advertise the Core-only file command (recognizeFile)", () => {
    const shellCmds = new Set((AmiVoice.wcBindable.commands ?? []).map((c) => c.name));
    expect(shellCmds.has("recognizeFile")).toBe(false);
  });

  it("every declared command exists as a callable method on instances", () => {
    const el = document.createElement("ami-voice") as unknown as Record<string, unknown>;
    for (const cmd of AmiVoice.wcBindable.commands ?? []) {
      expect(
        typeof el[cmd.name],
        `<ami-voice> advertises command "${cmd.name}" but no method of that name is callable on the element`,
      ).toBe("function");
    }
  });

  it("forwards every Core property and adds the Shell-only level + mode", () => {
    const coreProps = new Set(AmiVoiceCore.wcBindable.properties.map((p) => p.name));
    const shellProps = new Set(AmiVoice.wcBindable.properties.map((p) => p.name));
    for (const p of coreProps) {
      expect(shellProps.has(p), `Shell must forward Core property "${p}"`).toBe(true);
    }
    expect(shellProps.has("level")).toBe(true);
    expect(shellProps.has("mode")).toBe(true);
  });

  it("forwards every Core input", () => {
    const coreInputs = new Set((AmiVoiceCore.wcBindable.inputs ?? []).map((i) => i.name));
    const shellInputs = new Set((AmiVoice.wcBindable.inputs ?? []).map((i) => i.name));
    for (const i of coreInputs) {
      expect(shellInputs.has(i), `Shell must forward Core input "${i}"`).toBe(true);
    }
  });

  it("never exposes `transport` on the bindable surface (deployment config, ADR 0006)", () => {
    // transport must stay byte-identical-invisible: relay and direct present the
    // SAME recognition surface, so a client cannot flip its server's topology.
    const surface = AmiVoice.wcBindable;
    const names = [
      ...surface.properties.map((p) => p.name),
      ...(surface.inputs ?? []).map((i) => i.name),
      ...(surface.commands ?? []).map((c) => c.name),
    ];
    expect(names).not.toContain("transport");
  });

  it("uses the ami-voice: event namespace and unsuffixed error signal", () => {
    const byName = new Map(AmiVoice.wcBindable.properties.map((p) => [p.name, p.event]));
    expect(byName.get("transcript")).toBe("ami-voice:transcript-changed");
    expect(byName.get("recognizing")).toBe("ami-voice:recognizing-changed");
    // `speakers` is a normal state transition (derived, final-only — ADR 0007).
    expect(byName.get("speakers")).toBe("ami-voice:speakers-changed");
    // `error` is a signal, not a state transition — no `-changed` suffix.
    expect(byName.get("error")).toBe("ami-voice:error");
  });
});
