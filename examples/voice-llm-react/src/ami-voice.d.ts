// Minimal local typings for the two custom elements so the example is
// self-contained (no cross-package type resolution needed for `vite build`).
// An intentional per-example copy — mirrors the other examples' typings.
import "react";

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
  error: Error | { message?: string } | null;
}

/** Reactive values @wc-bindable/react syncs out of <ami-voice>. */
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

/** Reactive values @wc-bindable/react syncs out of <ai-agent>. */
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

// JSX intrinsic declarations so <ami-voice> / <ai-agent> type-check in editors.
declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "ami-voice": React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & {
          ref?: React.Ref<AmiVoiceElement>;
          "remote-url"?: string;
          transport?: "relay" | "direct";
          engine?: string;
          codec?: string;
        },
        HTMLElement
      >;
      "ai-agent": React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & {
          ref?: React.Ref<AiAgentElement>;
          provider?: string;
          model?: string;
        },
        HTMLElement
      >;
    }
  }
}
