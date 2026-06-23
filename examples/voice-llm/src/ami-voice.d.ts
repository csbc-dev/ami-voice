// Minimal local typings for the two custom elements so the example is
// self-contained (no cross-package type resolution needed for `vite build`).
// An intentional per-example copy — mirrors the other examples' typings.

/** <ami-voice>: imperative surface + the bindable properties we read. */
export interface AmiVoiceElement extends HTMLElement {
  start(): Promise<void>;
  stop(): Promise<void>;
  reset(): void;
  recognizing: boolean;
  connected: boolean;
  loading: boolean;
  transcript: string;
  interim: string;
  level: number;
  mode: string;
  error: Error | { message?: string } | null;
}

/** <ai-agent>: imperative surface + the bindable properties we read. */
export interface AiAgentElement extends HTMLElement {
  send(): Promise<string | null>;
  abort(): void;
  prompt: string;
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
