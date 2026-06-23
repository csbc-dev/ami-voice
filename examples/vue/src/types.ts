// Minimal local typings for the <ami-voice> element (self-contained example).
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
}

/** Reactive values @wc-bindable/vue syncs out of the element. */
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
