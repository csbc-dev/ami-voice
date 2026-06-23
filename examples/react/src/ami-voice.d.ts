// Minimal local typings for the <ami-voice> custom element so the example is
// self-contained (no cross-package type resolution needed for `vite build`).
// An intentional per-example copy — mirrors the Vue `types.ts` and the Vanilla
// inline interfaces (like the duplicated style.css; see shared/styles.css).
import "react";

export interface RecognitionSegment {
  text: string;
  confidence: number;
  starttime: number;
  endtime: number;
  tokens: unknown[];
  utteranceid?: string;
}

/** The element's imperative surface + the bindable properties we read. */
export interface AmiVoiceElement extends HTMLElement {
  start(): Promise<void>;
  stop(): Promise<void>;
  abort(): void;
  reset(): void;
  recognizing: boolean;
  connected: boolean;
  transcript: string;
  interim: string;
  segments: RecognitionSegment[];
  confidence: number;
  level: number;
  error: Error | { message?: string } | null;
}

/** The reactive values @wc-bindable/react syncs out of the element. */
export interface AmiVoiceValues {
  recognizing: boolean;
  connected: boolean;
  transcript: string;
  interim: string;
  segments: RecognitionSegment[];
  confidence: number;
  level: number;
  loading: boolean;
  error: Error | { message?: string } | null;
  mode: "local" | "remote";
}

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "ami-voice": React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & {
          ref?: React.Ref<AmiVoiceElement>;
          "remote-url"?: string;
          transport?: "relay" | "direct";
          mode?: "local" | "remote";
          engine?: string;
          codec?: string;
          "profile-id"?: string;
          "no-log"?: string;
        },
        HTMLElement
      >;
    }
  }
}
