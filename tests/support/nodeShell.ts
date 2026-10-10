import { vi } from "vitest";

/**
 * Just enough `HTMLElement` to run the `<ami-voice>` Shell under Node: attributes
 * plus the (native) EventTarget it dispatches `ami-voice:*` on. The test drives
 * the custom-element lifecycle hooks by hand; everything else — the control and
 * audio WebSockets (Node's native `WebSocket`), the 0.10 proxies, the relay
 * helper, the provider loop, the fake AmiVoice — is real. Only the browser mic
 * (`getUserMedia` / `AudioWorklet`) is stubbed; Playwright covers it.
 */
class ShimHTMLElement extends EventTarget {
  private readonly _attrs = new Map<string, string>();
  getAttribute(name: string): string | null { return this._attrs.get(name) ?? null; }
  setAttribute(name: string, value: string): void {
    const old = this.getAttribute(name);
    this._attrs.set(name, value);
    (this as { attributeChangedCallback?(n: string, o: string | null, v: string): void })
      .attributeChangedCallback?.(name, old, value);
  }
}

export type NodeShell = ShimHTMLElement & {
  start(): Promise<void>;
  stop(): Promise<void>;
  abort(): void;
  reset(): void;
  connectedCallback(): void;
  disconnectedCallback(): void;
  readonly recognizing: boolean;
  readonly interim: string;
  readonly transcript: string;
  readonly error: unknown;
  _audioWs: WebSocket | null;
  _startMic(onFrame: (bytes: Uint8Array) => void): Promise<void>;
};

/** Import the Shell with the shim as its `HTMLElement` base (module eval needs it). */
export async function createShell(): Promise<NodeShell> {
  vi.stubGlobal("HTMLElement", ShimHTMLElement);
  const { AmiVoice } = await import("../../src/components/AmiVoice");
  return new (AmiVoice as unknown as new () => NodeShell)();
}

export async function waitFor(pred: () => boolean, timeoutMs = 10000, stepMs = 20): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

/**
 * Stand-in for `getUserMedia` → `AudioWorklet` → PCM: once armed, send one audio
 * frame — on the relay audio channel when it is open, or straight into the
 * in-page Core (local / direct). Returns how many times the mic was armed.
 */
export function stubMic(el: NodeShell): () => number {
  let arms = 0;
  el._startMic = async (onFrame) => {
    arms++;
    const audio = el._audioWs;
    if (audio) await waitFor(() => audio.readyState === WebSocket.OPEN);
    onFrame(new Uint8Array([1, 2, 3, 4]));
  };
  return () => arms;
}
