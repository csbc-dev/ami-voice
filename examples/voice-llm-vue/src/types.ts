// Minimal local typings for the two custom elements so the example is
// self-contained (no cross-package type resolution needed for `vite build`).
// An intentional per-example copy — mirrors the other examples' typings.

/** <ami-voice>: imperative surface @wc-bindable/vue's element ref calls. */
export interface AmiVoiceElement extends HTMLElement {
  start(): Promise<void>;
  stop(): Promise<void>;
  reset(): void;
}

/** Reactive values @wc-bindable/vue syncs out of <ami-voice>. */
export interface AmiVoiceValues {
  recognizing: boolean;
  connected: boolean;
  transcript: string;
  interim: string;
  level: number;
  loading: boolean;
  error: Error | { message?: string } | null;
  mode: "local" | "remote";
}

/** <ai-agent>: imperative surface + the writable prompt the wiring sets. */
export interface AiAgentElement extends HTMLElement {
  send(): Promise<string | null>;
  abort(): void;
  prompt: string;
}

/** Reactive values @wc-bindable/vue syncs out of <ai-agent>. */
export interface AiAgentValues {
  content: string;
  loading: boolean;
  streaming: boolean;
  usage: AiUsage | null;
  error: Error | { status?: number; body?: string; statusText?: string } | null;
}

export interface AiUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}
