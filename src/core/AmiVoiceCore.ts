import {
  IWcBindable, IAmiVoiceProvider, IRealtimeSession, RealtimeSessionHandlers,
  RecognitionOptions, RecognitionSegment,
} from "../types.js";
import type {
  WcsAmiVoiceAnyError, AmiVoiceCodec, AmiVoiceEngine,
  AmiVoiceTransport, DirectSessionInfo, DirectMintOptions, SpeakerSegment,
} from "../types.js";
import { normaliseError } from "../normaliseError.js";
import { AmiVoiceError } from "../errorCodes.js";
import { toSpeakerSegment } from "../speakerView.js";
import { DEFAULT_CODEC } from "../audio/pcmEncoder.js";

/** Observable outputs Core publishes, paired with `ami-voice:<name>-changed`. */
const CORE_PROPERTY_NAMES = [
  "recognizing",
  "connected",
  "transcript",
  "interim",
  "segments",
  // `speakers` is a derived, final-only projection of `segments` (docs/adr/0007).
  "speakers",
  "confidence",
  "loading",
] as const;

/** Client-writable inputs (wcBindable `inputs`). */
const CORE_INPUT_NAMES = [
  "engine",
  "codec",
  "profileId",
  "profileWords",
  "keepFillerToken",
  "resultUpdatedInterval",
  "segmenterProperties",
  "noLog",
] as const;

/**
 * Core commands. `start` is a long-running streaming command; `stop` (graceful,
 * flush + final) and `abort` (immediate) are load-bearing because cancellation
 * over `@wc-bindable/remote` is producer-side (docs/adr/0003 §5, docs/adr/0004).
 * `recognizeFile` is the Case-B1 file path. NOTE: audio frames do NOT arrive as
 * a wcBindable command — they ride the separate binary channel into `feedAudio`.
 */
const CORE_COMMANDS = [
  { name: "start", async: true },
  { name: "stop", async: true },
  { name: "abort" },
  { name: "reset" },
  { name: "recognizeFile", async: true },
] as const satisfies ReadonlyArray<{ readonly name: string; readonly async?: boolean }>;

function buildCoreWcBindable(): IWcBindable {
  return {
    protocol: "wc-bindable",
    version: 1,
    properties: [
      ...CORE_PROPERTY_NAMES.map((name) => ({ name, event: `ami-voice:${name}-changed` })),
      // `error` uses the unsuffixed event name (it is a signal, not a state
      // transition) — matches the family convention.
      { name: "error", event: "ami-voice:error" },
    ],
    inputs: CORE_INPUT_NAMES.map((name) => ({ name })),
    commands: CORE_COMMANDS.map((c) => ({ ...c })),
  };
}

/**
 * Headless AmiVoice recognition Core.
 *
 * Lives server-side. Holds the APPKEY-bearing provider, owns the recognition
 * session and every decision (engine/codec/profile policy, connection
 * lifecycle, result normalization), and publishes observable state. In realtime
 * mode the audio bytes arrive over the separate binary channel and are pushed
 * in via `feedAudio()`; they never cross the wcBindable surface.
 */
export class AmiVoiceCore extends EventTarget {
  static wcBindable: IWcBindable = buildCoreWcBindable();

  private readonly _target: EventTarget;
  private readonly _provider: IAmiVoiceProvider;
  /**
   * Optional session-id minter (relay mode, ADR 0006). When present, `start()`
   * returns the minted id so the browser can correlate its binary audio channel;
   * the server helper supplies this. Absent in local mode (no audio channel).
   */
  private readonly _mintSessionId?: () => string;
  /**
   * Transport this Core serves (docs/adr/0006). `"relay"` (default): the Core
   * opens the AmiVoice WSS and owns `s`/event handling. `"direct"`: the Core is
   * the server-side MINT AUTHORITY — `start()` returns approved-`s` + a one-time
   * APPKEY for the browser to open the WSS itself, and the Core opens no upstream.
   */
  private readonly _transport: AmiVoiceTransport;
  /** Per-session mint options (direct mode); the server helper supplies the peer `ipa`. */
  private readonly _mintOptions?: () => DirectMintOptions;
  private _session: IRealtimeSession | null = null;
  /**
   * Bumped by every teardown (`abort`/`reset`/`_teardownSession`). `start()`
   * captures it before `await openRealtimeSession` and re-checks it after: if a
   * teardown intervened during the handshake, the just-opened session is released
   * instead of being resurrected with `recognizing/connected=true`. Mirrors the
   * generation pattern `MicCapture` uses for the same disconnect-during-start race.
   */
  private _sessionGeneration = 0;

  // inputs
  private _engine: AmiVoiceEngine = "-a-general";
  private _codec: AmiVoiceCodec = DEFAULT_CODEC;
  private _profileId = "";
  private _profileWords = "";
  private _keepFillerToken = false;
  private _resultUpdatedInterval = 0;
  private _segmenterProperties = "";
  private _noLog = false;

  // outputs
  private _recognizing = false;
  private _connected = false;
  private _transcript = "";
  private _interim = "";
  private _segments: RecognitionSegment[] = [];
  private _speakers: SpeakerSegment[] = [];
  private _confidence = 0;
  private _loading = false;
  private _error: WcsAmiVoiceAnyError = null;

  /**
   * @param provider APPKEY-bearing AmiVoice access.
   * @param target   Target-injection sink. When the Shell passes `this`, Core
   *                 events fire directly from the DOM element; otherwise events
   *                 fire from the Core itself.
   */
  constructor(
    provider: IAmiVoiceProvider,
    target?: EventTarget,
    options?: {
      mintSessionId?: () => string;
      transport?: AmiVoiceTransport;
      mintOptions?: () => DirectMintOptions;
    },
  ) {
    super();
    this._provider = provider;
    this._target = target ?? this;
    this._mintSessionId = options?.mintSessionId;
    this._transport = options?.transport ?? "relay";
    this._mintOptions = options?.mintOptions;
  }

  private _emit(prop: string, value: unknown): void {
    const event = prop === "error" ? "ami-voice:error" : `ami-voice:${prop}-changed`;
    this._target.dispatchEvent(new CustomEvent(event, { detail: value }));
  }

  // ── inputs ──────────────────────────────────────────────────────────────────
  get engine(): AmiVoiceEngine { return this._engine; }
  set engine(v: AmiVoiceEngine) { this._engine = v; }
  get codec(): AmiVoiceCodec { return this._codec; }
  set codec(v: AmiVoiceCodec) { this._codec = v; }
  get profileId(): string { return this._profileId; }
  set profileId(v: string) { this._profileId = v; }
  get profileWords(): string { return this._profileWords; }
  set profileWords(v: string) { this._profileWords = v; }
  get keepFillerToken(): boolean { return this._keepFillerToken; }
  set keepFillerToken(v: boolean) { this._keepFillerToken = v; }
  get resultUpdatedInterval(): number { return this._resultUpdatedInterval; }
  set resultUpdatedInterval(v: number) { this._resultUpdatedInterval = v; }
  get segmenterProperties(): string { return this._segmenterProperties; }
  set segmenterProperties(v: string) { this._segmenterProperties = v; }
  get noLog(): boolean { return this._noLog; }
  set noLog(v: boolean) { this._noLog = v; }

  // ── outputs (read-only) ──────────────────────────────────────────────────────
  get recognizing(): boolean { return this._recognizing; }
  get connected(): boolean { return this._connected; }
  get transcript(): string { return this._transcript; }
  get interim(): string { return this._interim; }
  get segments(): RecognitionSegment[] { return this._segments; }
  get speakers(): SpeakerSegment[] { return this._speakers; }
  get confidence(): number { return this._confidence; }
  get loading(): boolean { return this._loading; }
  get error(): WcsAmiVoiceAnyError { return this._error; }

  private _setRecognizing(v: boolean): void { if (this._recognizing !== v) { this._recognizing = v; this._emit("recognizing", v); } }
  private _setConnected(v: boolean): void { if (this._connected !== v) { this._connected = v; this._emit("connected", v); } }
  private _setTranscript(v: string): void { if (this._transcript !== v) { this._transcript = v; this._emit("transcript", v); } }
  private _setInterim(v: string): void { if (this._interim !== v) { this._interim = v; this._emit("interim", v); } }
  private _setSegments(v: RecognitionSegment[]): void { this._segments = v; this._emit("segments", v); }
  private _setSpeakers(v: SpeakerSegment[]): void { this._speakers = v; this._emit("speakers", v); }
  private _setConfidence(v: number): void { if (this._confidence !== v) { this._confidence = v; this._emit("confidence", v); } }
  private _setLoading(v: boolean): void { if (this._loading !== v) { this._loading = v; this._emit("loading", v); } }
  private _setError(v: WcsAmiVoiceAnyError): void { this._error = v; this._emit("error", v); }

  private _currentOptions(): RecognitionOptions {
    return {
      engine: this._engine,
      codec: this._codec,
      profileId: this._profileId || undefined,
      profileWords: this._profileWords || undefined,
      keepFillerToken: this._keepFillerToken || undefined,
      resultUpdatedInterval: this._resultUpdatedInterval || undefined,
      segmenterProperties: this._segmenterProperties || undefined,
      noLog: this._noLog || undefined,
    };
  }

  private _handlers(): RealtimeSessionHandlers {
    return {
      onSegmentStart: () => { /* S — reserved for VAD-driven UI hooks */ },
      onSegmentEnd: () => { /* E — reserved for VAD-driven UI hooks */ },
      onRecognitionStart: () => { /* C */ },
      onInterim: (r) => { this._setInterim(r.text); },
      onFinal: (r) => { this._appendFinal(r); },
      onError: (e) => { this._setError(normaliseError(e)); },
      onClose: () => { this._teardownSession(); },
    };
  }

  private _appendFinal(segment: RecognitionSegment): void {
    this._setSegments([...this._segments, segment]);
    // `speakers` is the derived, final-only speaker view (docs/adr/0007).
    this._setSpeakers([...this._speakers, toSpeakerSegment(segment)]);
    this._setTranscript(this._transcript + segment.text);
    this._setConfidence(segment.confidence);
    this._setInterim("");
  }

  private _teardownSession(): void {
    // Invalidate any in-flight `start()` handshake so a session resolving AFTER
    // this teardown is released rather than resurrected (abort/disconnect race).
    this._sessionGeneration++;
    this._session = null;
    this._setRecognizing(false);
    this._setConnected(false);
  }

  // ── commands ──────────────────────────────────────────────────────────────────

  /**
   * Open a realtime session.
   *
   * Relay/local: opens the AmiVoice WSS; failures publish to `error` rather than
   * reject. Returns the minted session id (relay) for the browser to bind its
   * audio channel to, or `null` (local / on failure).
   *
   * Direct (docs/adr/0006): the Core opens NO upstream — it mints a one-time
   * APPKEY + approved `s` command and returns them as `DirectSessionInfo` for the
   * browser to open the WSS itself. Mint failures REJECT here (rather than
   * publishing to this server-side Core's `error`, which the browser does not
   * bind) so the failure surfaces over `invoke("start")` to the browser's
   * in-page Core, which then publishes it to the bound `error`.
   */
  async start(): Promise<string | DirectSessionInfo | null> {
    if (this._recognizing || this._loading) return null;
    this._setError(null);
    this._setLoading(true);
    // Capture the teardown generation BEFORE the handshake await. `abort()` /
    // `reset()` (e.g. a disconnectedCallback racing start()) bump it via
    // `_teardownSession()`; if it changed by the time the session resolves, the
    // caller asked to stop — release the freshly-opened session rather than
    // resurrect it as `recognizing=true` with an orphaned upstream socket.
    const generation = this._sessionGeneration;
    try {
      if (this._transport === "direct") {
        if (!this._provider.prepareDirectSession) {
          throw new AmiVoiceError("^", "provider does not support direct mode (no prepareDirectSession)");
        }
        return await this._provider.prepareDirectSession(this._currentOptions(), this._mintOptions?.());
      }
      const session = await this._provider.openRealtimeSession(this._currentOptions(), this._handlers());
      if (generation !== this._sessionGeneration) {
        // A teardown intervened during the handshake; drop the orphaned session.
        session.abort();
        return null;
      }
      this._session = session;
      this._setConnected(true);
      this._setRecognizing(true);
      return this._mintSessionId ? this._mintSessionId() : null;
    } catch (err) {
      if (this._transport === "direct") throw normaliseError(err);
      this._setError(normaliseError(err));
      this._teardownSession();
      return null;
    } finally {
      this._setLoading(false);
    }
  }

  /** Graceful stop: flush remaining audio, await the trailing final result. */
  async stop(): Promise<void> {
    const session = this._session;
    if (!session) {
      // A stop() during the connect handshake (before `_session` is set) is NOT a
      // no-op: a graceful flush is meaningless for a session that has not yet
      // connected/streamed, but the request to stop must still INVALIDATE the
      // in-flight handshake. Bump the generation (via `_teardownSession`) so the
      // resolving start() takes its generation-mismatch branch and aborts the
      // just-opened session instead of resurrecting it as `recognizing=true` with
      // an orphaned upstream socket (mirrors abort()/reset() mid-handshake).
      if (this._loading) this._teardownSession();
      return;
    }
    try {
      await session.stop();
    } catch (err) {
      this._setError(normaliseError(err));
    } finally {
      this._teardownSession();
    }
  }

  /** Immediate teardown — drop the session with no trailing result. */
  abort(): void {
    this._session?.abort();
    this._teardownSession();
  }

  /** Clear accumulated results back to idle (also aborts any live session). */
  reset(): void {
    this.abort();
    this._setTranscript("");
    this._setInterim("");
    this._setSegments([]);
    this._setSpeakers([]);
    this._setConfidence(0);
    this._setError(null);
  }

  /** Case-B1 file recognition. Appends results to `segments` / `transcript`. */
  async recognizeFile(audio: Blob | Uint8Array): Promise<RecognitionSegment[]> {
    this._setError(null);
    this._setLoading(true);
    // Capture the teardown generation BEFORE the (possibly long: async-job poll)
    // await, mirroring start()'s handshake guard. If `reset()` / `abort()` runs
    // while the provider call is in flight it bumps the generation and clears the
    // accumulated state; without this check the resolving recognizeFile() would
    // re-append the just-fetched segments onto the state the consumer reset away.
    const generation = this._sessionGeneration;
    try {
      const segments = await this._provider.recognizeFile(audio, this._currentOptions());
      // A teardown intervened during the await; the consumer asked for a clean
      // slate — drop the stale file results rather than repopulate the cleared
      // transcript/segments/speakers/confidence.
      if (generation !== this._sessionGeneration) return [];
      for (const seg of segments) this._appendFinal(seg);
      return segments;
    } catch (err) {
      this._setError(normaliseError(err));
      return [];
    } finally {
      this._setLoading(false);
    }
  }

  /**
   * Push one already-framed audio chunk into the live session. Called by the
   * binary audio channel (docs/adr/0003) — NOT a wcBindable command, so audio
   * never crosses the JSON control wire.
   */
  feedAudio(bytes: Uint8Array): void {
    this._session?.feedAudio(bytes);
  }
}
