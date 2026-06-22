// ── wcBindable declaration shapes (typed locally; core does not export these
//    as a hard dependency of the declaration site) ──────────────────────────

export interface IWcBindableProperty {
  readonly name: string;
  readonly event: string;
}

export interface IWcBindableInput {
  readonly name: string;
  readonly attribute?: string;
}

export interface IWcBindableCommand {
  readonly name: string;
  readonly async?: boolean;
}

export interface IWcBindable {
  readonly protocol: "wc-bindable";
  readonly version: 1;
  readonly properties: IWcBindableProperty[];
  readonly inputs?: IWcBindableInput[];
  readonly commands?: IWcBindableCommand[];
}

// ── Package configuration ────────────────────────────────────────────────────

export interface ITagNames {
  readonly amiVoice: string;
}

export interface IWritableTagNames {
  amiVoice?: string;
}

/**
 * Realtime transport mode (docs/adr/0006). Deployment configuration — NOT a
 * wcBindable surface member. `"relay"` (default) routes audio through the server;
 * `"direct"` opts into browser-direct streaming with a one-time APPKEY.
 */
export type AmiVoiceTransport = "relay" | "direct";

export interface IRemoteConfig {
  readonly enableRemote: boolean;
  readonly remoteSettingType: "env" | "config";
  readonly remoteCoreUrl: string;
  /** Realtime transport (docs/adr/0006). Default `"relay"`. */
  readonly transport: AmiVoiceTransport;
}

export interface IWritableRemoteConfig {
  enableRemote?: boolean;
  remoteSettingType?: "env" | "config";
  remoteCoreUrl?: string;
  transport?: AmiVoiceTransport;
}

export interface IConfig {
  readonly tagNames: ITagNames;
  readonly remote: IRemoteConfig;
}

export interface IWritableConfig {
  tagNames?: IWritableTagNames;
  remote?: IWritableRemoteConfig;
}

// ── AmiVoice domain types ────────────────────────────────────────────────────

/**
 * Headerless streaming `audio_format` (a.k.a. the realtime `s`-command codec /
 * the HTTP `c` parameter). 16-bit signed PCM little/big-endian plus the 8-bit
 * companding codecs. AmiVoice identifiers are case-insensitive. `(string & {})`
 * keeps autocomplete on the known set while still accepting any string.
 *
 * NOTE: AmiVoice does NOT accept ADPCM for the realtime `audio_format`
 * (see docs/adr/0005). The 16K/8K header-detected forms apply to file upload.
 */
export type AmiVoiceCodec =
  | "LSB8K" | "LSB11K" | "LSB16K" | "LSB22K" | "LSB32K" | "LSB44K" | "LSB48K"
  | "MSB8K" | "MSB11K" | "MSB16K" | "MSB22K" | "MSB32K" | "MSB44K" | "MSB48K"
  | "MULAW" | "ALAW"
  | "16K" | "8K"
  | (string & {});

/**
 * Engine / `grammar_file_names` connection name. Hybrid (`-a-*`) and the newer
 * end-to-end (`-a2-*`) families. `(string & {})` keeps the union open.
 */
export type AmiVoiceEngine =
  | "-a-general" | "-a-medical" | "-a-general-input" | "-a-medical-input"
  | "-a-bizfinance" | "-a-bizinsurance" | "-a-general-en" | "-a-general-zh" | "-a-general-ko"
  | "-a2-ja-general" | "-a2-zh-general" | "-a2-multi-general"
  | (string & {});

/** One recognized word, per AmiVoice result JSON (`tokens[]`). */
export interface RecognitionToken {
  written: string;
  spoken: string;
  confidence: number;
  starttime: number;
  endtime: number;
  /** Speaker id — only present with speaker diarization. */
  label?: string;
  /** Language code (`ja` / `en` / `zh` …) — only on multilingual engines. */
  language?: string;
}

/**
 * A finalized recognition segment, normalized from an `A` event / async
 * `results[]` entry. Segment-level `confidence` is a final-only signal.
 */
export interface RecognitionSegment {
  text: string;
  confidence: number;
  starttime: number;
  endtime: number;
  tokens: RecognitionToken[];
  utteranceid?: string;
}

/**
 * An interim hypothesis, normalized from a `U` event. Lighter than a finalized
 * segment: AmiVoice's `U` payload carries only `text` + `tokens`, no
 * segment-level `confidence`.
 */
export interface InterimResult {
  text: string;
  tokens: RecognitionToken[];
}

/**
 * A speaker-labeled finalized turn (docs/adr/0007). A derived, final-only
 * projection of one `RecognitionSegment`: `label` is the segment's speaker id
 * (from token `label` with `segmenterProperties="useDiarizer=1"`), or `""` when
 * not diarized. `segments[].tokens[].label` remains the source of truth; this is
 * a convenience view so consumers don't re-walk tokens for "who said what".
 */
export interface SpeakerSegment {
  /** Speaker id from diarization, or `""` when undiarized / unknown. */
  label: string;
  text: string;
  starttime: number;
  endtime: number;
  confidence: number;
}

/** Options shared by realtime and file recognition (Core-owned policy). */
export interface RecognitionOptions {
  engine: AmiVoiceEngine;
  codec: AmiVoiceCodec;
  profileId?: string;
  profileWords?: string;
  keepFillerToken?: boolean;
  resultUpdatedInterval?: number;
  segmenterProperties?: string;
  /** `true` selects the no-logging endpoint / `loggingOptOut`. */
  noLog?: boolean;
}

/** Callbacks the Core wires into a realtime provider session. */
export interface RealtimeSessionHandlers {
  onSegmentStart(ms: number): void;
  onSegmentEnd(ms: number): void;
  onRecognitionStart(): void;
  onInterim(result: InterimResult): void;
  onFinal(result: RecognitionSegment): void;
  onError(err: unknown): void;
  onClose(): void;
}

/**
 * What the server hands a browser to open the AmiVoice WSS itself in direct mode
 * (docs/adr/0006). `sCommand` is the fully built, APPROVED `s` command with the
 * short-lived one-time APPKEY baked into `authorization=` — the permanent APPKEY
 * never appears here. Both fields are `JsonValue`-safe so they cross the
 * JSON-only control channel.
 */
export interface DirectSessionInfo {
  /** AmiVoice realtime WSS endpoint to connect to directly (logging vs no-log). */
  endpoint: string;
  /** Pre-approved `s` command (params + `authorization=<one-time token>`). */
  sCommand: string;
}

/** A live realtime session the Core feeds audio into. */
export interface IRealtimeSession {
  /** Push one already-framed audio chunk (PCM/companded bytes) to AmiVoice. */
  feedAudio(bytes: Uint8Array): void;
  /** Graceful stop: flush (`e`), await the trailing final result, then resolve. */
  stop(): Promise<void>;
  /** Immediate teardown: drop the AmiVoice session with no trailing result. */
  abort(): void;
}

/**
 * Transport-agnostic AmiVoice access. The default `AmiVoiceProvider` holds the
 * APPKEY and talks to AmiVoice (WSS for realtime, HTTP for files). Wrapping it
 * is how per-tenant policy / credential scoping is added — see docs/adr/0005.
 */
export interface IAmiVoiceProvider {
  /** Open a realtime WSS session (builds the `s` command, injects the APPKEY). */
  openRealtimeSession(
    options: RecognitionOptions,
    handlers: RealtimeSessionHandlers,
  ): Promise<IRealtimeSession>;
  /** One-shot / async file recognition over HTTP (Case B1). */
  recognizeFile(
    audio: Blob | Uint8Array,
    options: RecognitionOptions,
  ): Promise<RecognitionSegment[]>;
  /**
   * Direct mode (docs/adr/0006, opt-in): mint a one-time APPKEY and build the
   * approved `s` command for a browser to open the AmiVoice WSS itself. Returns
   * the WSS endpoint + the pre-built `s` command. The permanent APPKEY never
   * leaves the provider. Optional — relay/local providers need not implement it.
   */
  prepareDirectSession?(
    options: RecognitionOptions,
    mintOptions?: { ipa?: string; epi?: number },
  ): Promise<DirectSessionInfo>;
}

// ── Error shapes ─────────────────────────────────────────────────────────────

/** Cross-realm-safe serialized error, used when a real `Error` cannot cross. */
export interface SerializedError {
  name: string;
  message: string;
  stack?: string;
}

/** The shape kept in the `error` observable. */
export type WcsAmiVoiceAnyError = Error | SerializedError | null;

// ── Observable value shapes (the `bind()` surface) ───────────────────────────

/** Observable outputs owned by the Core. */
export interface AmiVoiceCoreValues {
  recognizing: boolean;
  /** Core ↔ AmiVoice upstream connection (realtime). */
  connected: boolean;
  /** Accumulated finalized text (from `A` events). */
  transcript: string;
  /** Current in-progress hypothesis (from `U` events). */
  interim: string;
  /** Structured finalized history. */
  segments: RecognitionSegment[];
  /** Speaker-labeled finalized turns (derived from `segments`; final-only — docs/adr/0007). */
  speakers: SpeakerSegment[];
  /** Latest finalized-segment confidence (final-only; updates on `A`). */
  confidence: number;
  loading: boolean;
  error: WcsAmiVoiceAnyError;
}

/** Shell value shape: Core outputs plus the Shell-projected UI state. */
export interface AmiVoiceValues extends AmiVoiceCoreValues {
  /** Mic input level for a meter — Shell-projected, not a Core decision. */
  level: number;
  /** Active mode, surfaced for UIs. */
  mode: "local" | "remote";
}
