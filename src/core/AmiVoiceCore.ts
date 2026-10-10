import {
  IWcBindable, IAmiVoiceProvider, IRealtimeSession, RealtimeSessionHandlers,
  RecognitionOptions, RecognitionSegment,
} from "../types.js";
import type {
  SerializedError, AmiVoiceCodec, AmiVoiceEngine,
  AmiVoiceTransport, DirectSessionInfo, DirectMintOptions, SpeakerSegment,
} from "../types.js";
import { toSerializedError, toError } from "../normaliseError.js";
import { AmiVoiceError } from "../errorCodes.js";
import { toSpeakerSegment } from "../speakerView.js";
import { normalizeSegment } from "../protocol/wnnProtocol.js";
import { DEFAULT_CODEC } from "../audio/pcmEncoder.js";

/** Default `engine` (`grammar_file_names`) — what a `null` / `undefined` / `""` write restores (SPEC §7.2). */
const DEFAULT_ENGINE: AmiVoiceEngine = "-a-general";

/**
 * Resolve an `engine` / `codec` write: `null` / `undefined` / `""` → `fallback`
 * (SPEC §7.2). The two are the positional `<audio_format> <grammar_file_names>`
 * tokens of the `s` command, where an empty string is never a valid value — a
 * stored `""` built `s  -a-general …` / `s LSB16K  authorization=…`. (`""` is
 * what `<ami-voice engine="">` forwards.) Inputs whose default already is `""`
 * need no such mapping.
 */
function orDefault<T extends string>(v: T | null | undefined, fallback: T): T {
  return v == null || v === "" ? fallback : v;
}

/**
 * Shape a provider's `prepareDirectSession` result (direct mode) into exactly
 * the `DirectSessionInfo` that `start()` returns — the `return` the remote shell
 * sends to the browser, validated by `@wc-bindable/remote` ≥ 0.10 as a strict
 * `JsonValue`. A custom provider's extra keys (an `undefined` member, a `Date`,
 * …) used to fail that check as an opaque `WC_BINDABLE_INVALID_RETURN_VALUE`;
 * they are dropped here instead, so no stray field reaches the browser either.
 * A missing / non-string / empty `endpoint` or `sCommand` cannot be repaired: it
 * is rejected with an error naming the field and its type — never its value,
 * since `sCommand` carries the one-time APPKEY.
 */
function toDirectSessionInfo(raw: unknown): DirectSessionInfo {
  const typeOf = (v: unknown): string => (v === null ? "null" : Array.isArray(v) ? "an array" : typeof v);
  const contract = "prepareDirectSession() must resolve { endpoint, sCommand } as non-empty strings";
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new AmiVoiceError("^", `${contract}; got ${typeOf(raw)}`);
  }
  const info = raw as Record<string, unknown>;
  const problems: string[] = [];
  for (const key of ["endpoint", "sCommand"] as const) {
    const v = info[key];
    if (typeof v !== "string") problems.push(`${key} is ${typeOf(v)}`);
    else if (v === "") problems.push(`${key} is empty`);
  }
  if (problems.length > 0) throw new AmiVoiceError("^", `${contract}; ${problems.join(", ")}`);
  return { endpoint: info.endpoint as string, sCommand: info.sCommand as string };
}

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
   * The same value also identifies the live session: its callbacks (`_handlers`)
   * and a pending graceful `stop()` act only while it is unchanged.
   */
  private _sessionGeneration = 0;

  // inputs
  private _engine: AmiVoiceEngine = DEFAULT_ENGINE;
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
  /**
   * Always a JSON-safe plain object (or `null`), never an `Error` instance: it
   * is read by the remote `sync` and carried by the `update`, both of which
   * remote ≥ 0.10 validates as a strict `JsonValue` (SPEC §17). See
   * `toSerializedError`.
   */
  private _error: SerializedError | null = null;

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
  // `null` / `undefined` RESETS an input to its default (SPEC §7.2; wc-bindable
  // SPEC-extensions § Producer guidance P1/P2). `undefined` cannot cross the
  // remote wire (it is not a JsonValue), so a remote client — e.g. the Shell
  // forwarding React 19's `undefined` on a removed prop — sends `null`. Without
  // the reset, `engine`/`codec` would be stored as-is and `buildStartCommand`
  // would emit `s null null …` / `s LSB16K undefined …`. `engine` / `codec`
  // also reset on `""` (see `orDefault`); the other inputs store it as given.
  get engine(): AmiVoiceEngine { return this._engine; }
  set engine(v: AmiVoiceEngine | null | undefined) { this._engine = orDefault(v, DEFAULT_ENGINE); }
  get codec(): AmiVoiceCodec { return this._codec; }
  set codec(v: AmiVoiceCodec | null | undefined) { this._codec = orDefault(v, DEFAULT_CODEC); }
  get profileId(): string { return this._profileId; }
  set profileId(v: string | null | undefined) { this._profileId = v ?? ""; }
  get profileWords(): string { return this._profileWords; }
  set profileWords(v: string | null | undefined) { this._profileWords = v ?? ""; }
  get keepFillerToken(): boolean { return this._keepFillerToken; }
  set keepFillerToken(v: boolean | null | undefined) { this._keepFillerToken = v ?? false; }
  get resultUpdatedInterval(): number { return this._resultUpdatedInterval; }
  set resultUpdatedInterval(v: number | null | undefined) { this._resultUpdatedInterval = v ?? 0; }
  get segmenterProperties(): string { return this._segmenterProperties; }
  set segmenterProperties(v: string | null | undefined) { this._segmenterProperties = v ?? ""; }
  get noLog(): boolean { return this._noLog; }
  set noLog(v: boolean | null | undefined) { this._noLog = v ?? false; }

  // ── outputs (read-only) ──────────────────────────────────────────────────────
  get recognizing(): boolean { return this._recognizing; }
  get connected(): boolean { return this._connected; }
  get transcript(): string { return this._transcript; }
  get interim(): string { return this._interim; }
  get segments(): RecognitionSegment[] { return this._segments; }
  get speakers(): SpeakerSegment[] { return this._speakers; }
  get confidence(): number { return this._confidence; }
  get loading(): boolean { return this._loading; }
  get error(): SerializedError | null { return this._error; }

  private _setRecognizing(v: boolean): void { if (this._recognizing !== v) { this._recognizing = v; this._emit("recognizing", v); } }
  private _setConnected(v: boolean): void { if (this._connected !== v) { this._connected = v; this._emit("connected", v); } }
  private _setTranscript(v: string): void { if (this._transcript !== v) { this._transcript = v; this._emit("transcript", v); } }
  private _setInterim(v: string): void { if (this._interim !== v) { this._interim = v; this._emit("interim", v); } }
  private _setSegments(v: RecognitionSegment[]): void { this._segments = v; this._emit("segments", v); }
  private _setSpeakers(v: SpeakerSegment[]): void { this._speakers = v; this._emit("speakers", v); }
  private _setConfidence(v: number): void { if (this._confidence !== v) { this._confidence = v; this._emit("confidence", v); } }
  private _setLoading(v: boolean): void { if (this._loading !== v) { this._loading = v; this._emit("loading", v); } }
  /**
   * Publish a failure (or `null` to clear). Every thrown value is shaped by
   * `toSerializedError` HERE, so the getter and the emitted detail are the same
   * JSON-safe, redacted object — the one choke-point for what crosses the wire.
   */
  private _setError(err: unknown): void {
    const v = toSerializedError(err);
    this._error = v;
    this._emit("error", v);
  }

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

  /**
   * Callbacks for ONE session, opened while `_sessionGeneration === generation`.
   * Once that session is torn down (stop / abort / reset / its own close) the
   * generation moves on and these callbacks go inert: a session the Core has
   * already left MUST NOT touch the state of the next one (SPEC §10). The
   * platform WebSocket fires `onclose` asynchronously after `abort()` or a
   * graceful stop's `close()`, so without this gate that late close ran
   * `_teardownSession()` against a NEWER session — aborting its handshake
   * (`abort(); start()` resolved `null`) or, once it was live, nulling `_session`
   * and flipping `recognizing=false` while its upstream socket stayed open
   * (orphaned). Results/errors arriving after `abort()` are likewise dropped
   * (SPEC §18: no trailing result).
   */
  private _handlers(generation: number): RealtimeSessionHandlers {
    const current = (): boolean => generation === this._sessionGeneration;
    return {
      onSegmentStart: () => { /* S — reserved for VAD-driven UI hooks */ },
      onSegmentEnd: () => { /* E — reserved for VAD-driven UI hooks */ },
      onRecognitionStart: () => { /* C */ },
      // A custom provider's interim may lack `text`; keep `interim` a string.
      onInterim: (r) => { if (current()) this._setInterim(typeof r?.text === "string" ? r.text : ""); },
      onFinal: (r) => { if (current()) this._appendFinal(r); },
      onError: (e) => { if (current()) this._setError(e); },
      onClose: () => { if (current()) this._teardownSession(); },
    };
  }

  /**
   * Append one finalized segment. It is re-normalized first (`normalizeSegment`)
   * because a custom provider may hand over `utteranceid: undefined` or a NaN
   * `confidence`; one such non-JsonValue entry in `segments` would make remote
   * ≥ 0.10 drop every later `segments` / `speakers` update until `reset()`.
   * Returns the normalized segment.
   */
  private _appendFinal(raw: RecognitionSegment): RecognitionSegment {
    const segment = normalizeSegment(raw);
    this._setSegments([...this._segments, segment]);
    // `speakers` is the derived, final-only speaker view (docs/adr/0007).
    this._setSpeakers([...this._speakers, toSpeakerSegment(segment)]);
    this._setTranscript(this._transcript + segment.text);
    this._setConfidence(segment.confidence);
    this._setInterim("");
    return segment;
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
   * audio channel to, or `null` (local / on failure / already active). On a
   * failure the `error` update is emitted BEFORE this resolves, so on the
   * ordered control channel the browser already holds the real cause (and
   * `recognizing=false`, `loading=false`) when it sees the `null`.
   *
   * "Already active" includes a session that is still draining a graceful
   * `stop()` (`recognizing` stays true until it settles) and a cancelled
   * handshake (`loading` stays true until it settles): the Core does not queue a
   * start behind them. A caller that issued that stop / cancel waits for it
   * first — the Shell does (SPEC §10.2).
   *
   * Direct (docs/adr/0006): the Core opens NO upstream — it mints a one-time
   * APPKEY + approved `s` command and returns them as `DirectSessionInfo` for the
   * browser to open the WSS itself (exactly `{ endpoint, sCommand }` — a
   * provider's result is re-shaped by `toDirectSessionInfo`, and a malformed one
   * is a mint failure). Mint failures REJECT here (rather than
   * publishing to this server-side Core's `error`, which the browser does not
   * bind) so the failure surfaces over `invoke("start")` to the browser's
   * in-page Core, which then publishes it to the bound `error`. The rejection is
   * always an `Error` instance (`toError`): remote ≥ 0.10 turns a non-Error
   * throw into `NonErrorThrow` / `"[object Object]"`, losing the cause.
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
        return toDirectSessionInfo(
          await this._provider.prepareDirectSession(this._currentOptions(), this._mintOptions?.()),
        );
      }
      const session = await this._provider.openRealtimeSession(this._currentOptions(), this._handlers(generation));
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
      if (this._transport === "direct") throw toError(err);
      this._setError(err);
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
    // The graceful drain can take until the `e` ack (or the ~5 s fallback, SPEC
    // §18). If this session is torn down meanwhile — an `abort()` / `reset()`, its
    // own close — and a newer `start()` begins, this stop's settle must not tear
    // the NEWER session down nor publish an error against it.
    const generation = this._sessionGeneration;
    try {
      await session.stop();
    } catch (err) {
      if (generation === this._sessionGeneration) this._setError(err);
    } finally {
      if (generation === this._sessionGeneration) this._teardownSession();
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
      // Return the normalized segments (what `segments` now holds), not the
      // provider's raw objects.
      return segments.map((seg) => this._appendFinal(seg));
    } catch (err) {
      this._setError(err);
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
