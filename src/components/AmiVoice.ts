import { _getInternalConfig, getRemoteCoreUrl } from "../config.js";
import { IWcBindable, RecognitionSegment } from "../types.js";
import type {
  WcsAmiVoiceAnyError, AmiVoiceTransport, DirectSessionInfo, SpeakerSegment,
} from "../types.js";
import { AmiVoiceCore } from "../core/AmiVoiceCore.js";
import { AmiVoiceProvider } from "../providers/AmiVoiceProvider.js";
import { normaliseError } from "../normaliseError.js";
import {
  createRemoteCoreProxy,
  WebSocketClientTransport,
  type RemoteCoreProxy,
} from "@wc-bindable/remote";
import { bind } from "@wc-bindable/core";
import { MicCapture } from "./micCapture.js";
import { validateRemoteCoreUrl, openAudioChannel } from "./remoteConnection.js";
import { DirectBrowserProvider } from "./realtimeSocket.js";
import { shouldSendFrame, createRateLimiter, DEFAULT_MAX_AUDIO_BUFFER } from "../audio/flowControl.js";
import { canEncodeCodec, SHELL_SUPPORTED_CODECS, DEFAULT_CODEC } from "../audio/pcmEncoder.js";
import { AmiVoiceError } from "../errorCodes.js";

/**
 * `<ami-voice>` — declarative speech-recognition element.
 *
 * Remote mode (default, docs/adr/0002): the Core lives server-side behind a
 * `@wc-bindable/remote` JSON control proxy; the APPKEY never reaches the
 * browser. The mic data plane runs here and streams PCM over a SEPARATE binary
 * audio channel (docs/adr/0003). Local mode runs the Core in-page (dev only).
 *
 * Commands are the element's high-level surface (`start` / `stop` / `abort` /
 * `reset`); the Core's `recognizeFile` and the internal `feedAudio` are NOT
 * forwarded as element commands.
 */
export class AmiVoice extends HTMLElement {
  static wcBindable: IWcBindable = {
    protocol: "wc-bindable",
    version: 1,
    properties: [
      ...AmiVoiceCore.wcBindable.properties,
      // Shell-projected UI state (docs/adr/0004): not Core recognition decisions.
      { name: "level", event: "ami-voice:level-changed" },
      { name: "mode", event: "ami-voice:mode-changed" },
    ],
    inputs: AmiVoiceCore.wcBindable.inputs,
    commands: [
      { name: "start", async: true },
      { name: "stop", async: true },
      { name: "abort" },
      { name: "reset" },
    ],
  };

  static get observedAttributes(): string[] {
    return ["mode", "transport", "remote-url", "engine", "codec", "profile-id", "no-log"];
  }

  private _core: AmiVoiceCore | null = null;
  private _proxy: RemoteCoreProxy | null = null;
  private _unbind: (() => void) | null = null;
  private _ws: WebSocket | null = null;
  private _audioWs: WebSocket | null = null;
  private _mic: MicCapture | null = null;
  private _values: Record<string, unknown> = {};
  private _inputCache: Record<string, unknown> = {};
  private _level = 0;
  private _mode: "local" | "remote" = "remote";
  /**
   * Realtime transport (docs/adr/0006). Deployment config, NEVER bindable. Only
   * meaningful when `_mode === "remote"` (direct needs a server to mint).
   */
  private _transport: AmiVoiceTransport = "relay";
  private _remoteUrl = "";
  /** Throttle `level` emission (~10/s) — it fires per worklet frame (Q5). */
  private readonly _levelGate = createRateLimiter(100);
  /** Drop audio frames when the audio WS buffer exceeds this cap (Q10). */
  private _maxAudioBuffer = DEFAULT_MAX_AUDIO_BUFFER;
  /**
   * True once the Shell has started its browser-only data plane (mic + audio
   * channel) for an active session. Lets the `recognizing→false` listener tell a
   * still-running mic (an unsolicited upstream drop) from an already-idle one.
   */
  private _dataPlaneLive = false;
  /** Bound `recognizing-changed` listener that tears the mic down on session end. */
  private readonly _onRecognizingChanged = (e: Event): void => {
    if ((e as CustomEvent).detail === false && this._dataPlaneLive) this._stopDataPlane();
  };
  /**
   * Mirror every `ami-voice:error` (Shell-set via `_setError`, the relay bind
   * callback, OR the in-page Core via target injection in local/direct) into
   * `_values.error`, so the single `error` getter has one authoritative source
   * that always agrees with the last dispatched event — no split between
   * `_core.error` and `_values.error`.
   */
  private readonly _onError = (e: Event): void => {
    this._values.error = ((e as CustomEvent).detail as WcsAmiVoiceAnyError) ?? null;
  };

  /**
   * Resolved internal transport (NOT the public `mode`): `"local"` (in-page Core,
   * dev), `"relay"` (server Core + binary audio channel), or `"direct"` (in-page
   * Core, server mints per-session). Recognition state lives in `_core` for
   * local/direct and in `_values` for relay.
   */
  private _internalMode(): "local" | "relay" | "direct" {
    return this._mode === "local" ? "local" : this._transport;
  }

  constructor() {
    super();
  }

  // ── lifecycle ────────────────────────────────────────────────────────────────
  connectedCallback(): void {
    this._resolveMode();
    this._ensureConnected();
    // When recognition stops for ANY reason — a deliberate stop()/abort() or an
    // upstream drop the Core surfaces as `recognizing=false` (SPEC §10.1) — the
    // Shell's mic + audio channel MUST stop too (CLAUDE.md "Clean teardown").
    // This single listener covers all modes: relay fires it via the bind()
    // callback, local/direct via the in-page Core's target injection (`this`).
    this.addEventListener("ami-voice:recognizing-changed", this._onRecognizingChanged);
    this.addEventListener("ami-voice:error", this._onError);
    this._emit("mode", this._mode);
  }

  disconnectedCallback(): void {
    this._teardown();
  }

  attributeChangedCallback(name: string, _old: string | null, value: string | null): void {
    switch (name) {
      case "mode": this._mode = value === "local" ? "local" : "remote"; break;
      case "transport": this._transport = value === "direct" ? "direct" : "relay"; break;
      case "remote-url": this._remoteUrl = value ?? ""; break;
      case "engine": if (value != null) this._writeInput("engine", value); break;
      case "codec": if (value != null) this._writeInput("codec", value); break;
      case "profile-id": if (value != null) this._writeInput("profileId", value); break;
      case "no-log": this._writeInput("noLog", value != null); break;
    }
  }

  // ── observable outputs (read by bind() initial sync) ─────────────────────────
  // Recognition state lives in the in-page Core for local AND direct (docs/adr/
  // 0006), and in `_values` (bound from the remote proxy) for relay.
  get recognizing(): boolean { return this._core ? this._core.recognizing : Boolean(this._values.recognizing); }
  get connected(): boolean { return this._core ? this._core.connected : Boolean(this._values.connected); }
  get transcript(): string { return this._core ? this._core.transcript : String(this._values.transcript ?? ""); }
  get interim(): string { return this._core ? this._core.interim : String(this._values.interim ?? ""); }
  get segments(): RecognitionSegment[] {
    const v = this._core ? this._core.segments : this._values.segments;
    return Array.isArray(v) ? (v as RecognitionSegment[]) : [];
  }
  get speakers(): SpeakerSegment[] {
    const v = this._core ? this._core.speakers : this._values.speakers;
    return Array.isArray(v) ? (v as SpeakerSegment[]) : [];
  }
  get confidence(): number { return this._core ? this._core.confidence : Number(this._values.confidence ?? 0); }
  get loading(): boolean { return this._core ? this._core.loading : Boolean(this._values.loading); }
  get error(): WcsAmiVoiceAnyError {
    // `_values.error` is mirrored from every `ami-voice:error` (Shell-set AND
    // in-page Core via `_onError`), so it always agrees with the last dispatched
    // event. Fall back to the Core only for any error that predates the listener.
    const v = this._values.error ?? (this._core ? this._core.error : null);
    return (v as WcsAmiVoiceAnyError) ?? null;
  }
  get level(): number { return this._level; }
  // `mode` is the public local/remote projection; `transport` (relay/direct) is
  // deployment config and deliberately NOT exposed on the bindable surface.
  get mode(): "local" | "remote" { return this._mode; }

  // ── inputs (forwarded to the active bind target) ─────────────────────────────
  // Setters accept `null` / `undefined` (React 19 assigns `undefined` when a
  // prop is removed): both reset the input to its Core default — see
  // `_writeInput` and SPEC §7.2.
  get engine(): string { return String(this._inputCache.engine ?? ""); }
  set engine(v: string | null | undefined) { this._writeInput("engine", v); }
  get codec(): string { return String(this._inputCache.codec ?? ""); }
  set codec(v: string | null | undefined) { this._writeInput("codec", v); }
  get profileId(): string { return String(this._inputCache.profileId ?? ""); }
  set profileId(v: string | null | undefined) { this._writeInput("profileId", v); }
  get profileWords(): string { return String(this._inputCache.profileWords ?? ""); }
  set profileWords(v: string | null | undefined) { this._writeInput("profileWords", v); }
  get keepFillerToken(): boolean { return Boolean(this._inputCache.keepFillerToken); }
  set keepFillerToken(v: boolean | null | undefined) { this._writeInput("keepFillerToken", v); }
  get resultUpdatedInterval(): number { return Number(this._inputCache.resultUpdatedInterval ?? 0); }
  set resultUpdatedInterval(v: number | null | undefined) { this._writeInput("resultUpdatedInterval", v); }
  get segmenterProperties(): string { return String(this._inputCache.segmenterProperties ?? ""); }
  set segmenterProperties(v: string | null | undefined) { this._writeInput("segmenterProperties", v); }
  get noLog(): boolean { return Boolean(this._inputCache.noLog); }
  set noLog(v: boolean | null | undefined) { this._writeInput("noLog", v); }

  // ── commands (the element surface) ───────────────────────────────────────────
  // An in-page Core (`_core`) drives local AND direct (direct mints via the
  // control proxy inside its provider, then opens the AmiVoice WSS itself);
  // relay drives the server-side Core over the proxy + binary audio channel.
  async start(): Promise<void> {
    // Re-entrancy guard: a rapid/accidental second start() (double-click, a
    // framework re-render) must not open a second mic + audio channel and orphan
    // the first. The server-side Core also guards its own start, but that does
    // not protect the Shell's data plane.
    if (this._dataPlaneLive) return;
    try {
      // The Shell physically encodes the audio, so it MUST refuse a codec it
      // cannot produce rather than silently stream LSB16K under another label
      // (SPEC §13, docs/adr/0005). Guard BEFORE opening any session/mic.
      const codec = this._resolveCodec();
      if (!canEncodeCodec(codec)) {
        this._setError(normaliseError(new AmiVoiceError(
          "+",
          `codec "${codec}" is not encodable by the browser data plane; v1 supports ${SHELL_SUPPORTED_CODECS.join(", ")}`,
        )));
        return;
      }
      // Claim the data plane synchronously (before any await) so a concurrent
      // second start() hits the re-entrancy guard above. The catch's
      // `_rollbackStart()` clears it on failure.
      this._dataPlaneLive = true;
      this._ensureConnected();
      if (this._core) {
        await this._core.start();
        // A session that opened and immediately dropped during the await above
        // fires `recognizing→false`, whose listener tears the data plane down
        // and clears the flag. Bail rather than re-arm a mic for a dead session.
        if (!this._dataPlaneLive) return;
        await this._startMic((bytes) => this._core?.feedAudio(bytes));
      } else {
        const session = await this._proxy!.invoke("start");
        if (!this._dataPlaneLive) return;
        await this._startMicRemote(session);
      }
    } catch (err) {
      // A failure AFTER the upstream session opened — typically a getUserMedia
      // denial or an audio-channel open error — must not strand the session as
      // `recognizing=true` with no audio flowing. Roll the data plane and the
      // session back (best-effort) before surfacing the original error.
      this._rollbackStart();
      this._setError(normaliseError(err));
    }
  }

  /** Best-effort teardown of a partially-started session (see `start()`'s catch). */
  private _rollbackStart(): void {
    this._stopDataPlane();
    if (this._core) this._core.abort();
    else void this._proxy?.invoke("abort").catch(() => { /* rollback is best-effort */ });
  }

  /**
   * Stop the Shell-owned data plane (mic + binary audio channel) and clear the
   * live flag. Idempotent — `MicCapture.stop()` and `_closeAudio()` both no-op
   * when already torn down — so a deliberate stop()/abort() and the subsequent
   * `recognizing→false` listener cannot double-tear-down.
   */
  private _stopDataPlane(): void {
    this._dataPlaneLive = false;
    this._mic?.stop();
    this._closeAudio();
  }

  /** Active streaming codec: the cached `codec` input, defaulting to the Core default. */
  private _resolveCodec(): string {
    const c = this._inputCache.codec;
    return c ? String(c) : DEFAULT_CODEC;
  }

  async stop(): Promise<void> {
    this._stopDataPlane();
    try {
      if (this._core) await this._core.stop();
      else await this._proxy?.invoke("stop");
    } catch (err) {
      this._setError(normaliseError(err));
    }
  }

  abort(): void {
    this._stopDataPlane();
    if (this._core) this._core.abort();
    else void this._proxy?.invoke("abort").catch((e) => this._setError(normaliseError(e)));
  }

  reset(): void {
    // Tear down the Shell-owned data plane (mic + audio channel) directly, then
    // delegate the recognition reset ONCE. The Core's reset() already aborts any
    // live session internally, so we deliberately do not also round-trip a
    // separate abort (the relay path would otherwise send abort + reset for a
    // single user action).
    this._stopDataPlane();
    if (this._core) this._core.reset();
    else void this._proxy?.invoke("reset").catch((e) => this._setError(normaliseError(e)));
  }

  // ── internals ────────────────────────────────────────────────────────────────
  private _emit(prop: string, value: unknown): void {
    const event = prop === "error" ? "ami-voice:error" : `ami-voice:${prop}-changed`;
    this.dispatchEvent(new CustomEvent(event, { detail: value }));
  }

  private _setError(err: WcsAmiVoiceAnyError): void {
    this._values.error = err;
    this._emit("error", err);
  }

  private _writeInput(name: string, value: unknown): void {
    // "No value" — `undefined` (React 19 assigns it when a prop is removed),
    // `null`, or a non-finite number such as `NaN` — is forwarded as `null`,
    // which the Core treats as reset-to-default (SPEC §7.2; wc-bindable
    // SPEC-extensions § Producer guidance P1/P2). `undefined` / `NaN` are not
    // JsonValues: remote ≥ 0.10 `setWithAck` would reject them before sending
    // (`WC_BINDABLE_INVALID_JSON_VALUE`), and the in-page Core would build an
    // `s` command containing `undefined`. The reset is dropped from the cache so
    // a later (re)connect does not replay it — a fresh Core already holds the
    // default.
    const unset = value == null || (typeof value === "number" && !Number.isFinite(value));
    const wire = unset ? null : value;
    if (unset) delete this._inputCache[name];
    else this._inputCache[name] = wire;
    // Forward to the server (relay + direct: the server builds the approved `s`)
    // and to the in-page Core (local + direct: keeps it consistent). Direct does
    // both; relay only the proxy; local only the Core.
    if (this._proxy) {
      void this._proxy.setWithAck(name, wire).catch((e) => this._setError(normaliseError(e)));
    }
    if (this._core) {
      (this._core as unknown as Record<string, unknown>)[name] = wire;
    }
  }

  private _resolveMode(): void {
    const cfg = _getInternalConfig();
    const attrMode = this.getAttribute("mode");
    const remoteUrlAttr = this.getAttribute("remote-url");
    if (remoteUrlAttr) this._remoteUrl = remoteUrlAttr;
    if (attrMode === "local") this._mode = "local";
    else if (attrMode === "remote") this._mode = "remote";
    else this._mode = (cfg.remote.enableRemote || this._remoteUrl || getRemoteCoreUrl()) ? "remote" : "local";
    // transport (docs/adr/0006): deployment config, attribute overrides config.
    const attrTransport = this.getAttribute("transport");
    this._transport = attrTransport === "direct" ? "direct"
      : attrTransport === "relay" ? "relay"
      : cfg.remote.transport;
  }

  private _ensureConnected(): void {
    switch (this._internalMode()) {
      case "local": this._connectLocal(); break;
      case "relay": this._connectRelay(); break;
      case "direct": this._connectDirect(); break;
    }
  }

  /**
   * Create the `@wc-bindable/remote` control proxy (shared by relay + direct).
   * Relay binds its recognition properties as the bound state; direct does NOT
   * bind (recognition state comes from the in-page Core), it only uses the proxy
   * to forward inputs and `invoke("start")` for the mint.
   */
  private _connectControlProxy(doBind: boolean): void {
    if (this._proxy) return;
    const url = validateRemoteCoreUrl(this._remoteUrl || getRemoteCoreUrl());
    const ws = new WebSocket(url);
    this._ws = ws;
    const transport = new WebSocketClientTransport(ws);
    const proxy = createRemoteCoreProxy(AmiVoiceCore.wcBindable, transport);
    this._proxy = proxy;
    if (doBind) {
      this._unbind = bind(proxy, (name, value) => {
        this._values[name] = value;
        this._emit(name, value);
      });
    }
    for (const [name, value] of Object.entries(this._inputCache)) {
      void proxy.setWithAck(name, value).catch((e) => this._setError(normaliseError(e)));
    }
  }

  private _connectRelay(): void {
    this._connectControlProxy(/* doBind */ true);
  }

  /**
   * Direct mode (docs/adr/0006, opt-in): the control proxy is used only to mint
   * (the server returns approved-`s` + a one-time APPKEY); the in-page Core then
   * opens the AmiVoice WSS itself via `DirectBrowserProvider` and owns the
   * recognition state. The permanent APPKEY never reaches the browser.
   */
  private _connectDirect(): void {
    this._connectControlProxy(/* doBind */ false);
    if (this._core) return;
    const provider = new DirectBrowserProvider(
      () => this._proxy!.invoke("start") as Promise<DirectSessionInfo>,
    );
    // Target injection (`this`): the in-page Core fires `ami-voice:*` from the element.
    this._core = new AmiVoiceCore(provider, this);
  }

  private _connectLocal(): void {
    if (this._core) return;
    // DEV-ONLY: local mode runs the Core (and the APPKEY-bearing provider) in
    // the page. Production is remote-first (docs/adr/0002). Target injection
    // (`this`) makes Core events fire directly from the element.
    this._core = new AmiVoiceCore(new AmiVoiceProvider(), this);
  }

  private async _startMicRemote(session: unknown): Promise<void> {
    const sessionId = typeof session === "string" ? session : String(session ?? "");
    // An empty id means the server-side Core opened no session. Two causes:
    //  - the start FAILED (auth, upstream, …). The Core published the real
    //    cause to `error` and settled `recognizing=false` / `loading=false`
    //    BEFORE resolving (SPEC §17), and the control channel is ordered, so
    //    the bound `_values` already hold them. Do NOT overwrite that cause.
    //  - a re-entrant start() while a session is live / still handshaking
    //    (the Core's guard returns null, `recognizing` or `loading` is true).
    //    The server deliberately no-op'd to PROTECT the live session.
    // Either way we must NOT throw: a throw would propagate to start()'s catch
    // → `_rollbackStart()` → `invoke("abort")` and tear down the very session
    // the server kept alive (latent edge b). We also do not open an audio
    // channel with an empty token (it would route nowhere).
    if (!sessionId) {
      this._dataPlaneLive = false;
      if (this._values.recognizing === true || this._values.loading === true) {
        // Genuinely already active: a benign, non-destructive notice.
        this._setError(normaliseError(
          new AmiVoiceError("c", "start() ignored: a recognition session is already active"),
        ));
      } else if (this._values.error == null) {
        // Idle server but no cause arrived (e.g. a server whose `error` could
        // not cross the wire): say the start failed rather than stay silent
        // or misreport it as "already active".
        this._setError(normaliseError(
          new AmiVoiceError("", "start() failed: the server opened no recognition session"),
        ));
      }
      // else: the server-published `error` already names the real cause.
      return;
    }
    // Close any prior audio channel before opening a new one so a re-`start()`
    // does not orphan the previous socket.
    this._closeAudio();
    // Audio rides the SEPARATE binary channel, never the JSON proxy
    // (docs/adr/0003). Default the audio URL to the control URL; deployments may
    // point it elsewhere. A failure here propagates to `start()`'s catch, which
    // rolls the just-opened upstream session back rather than leaving it stranded.
    this._audioWs = openAudioChannel(this._remoteUrl || getRemoteCoreUrl(), sessionId);
    await this._startMic((bytes) => this._sendAudioRemote(bytes));
  }

  private _sendAudioRemote(bytes: Uint8Array): void {
    const ws = this._audioWs;
    // Drop frames under back-pressure rather than buffer unbounded (Q10).
    if (ws && ws.readyState === WebSocket.OPEN && shouldSendFrame(ws.bufferedAmount, this._maxAudioBuffer)) {
      ws.send(bytes);
    }
  }

  private async _startMic(onFrame: (bytes: Uint8Array) => void): Promise<void> {
    if (!this._mic) this._mic = new MicCapture();
    // `_dataPlaneLive` is already claimed synchronously in `start()` (before any
    // await), so we deliberately do NOT re-assert it here: a `recognizing→false`
    // that raced the start await cleared the flag (and `MicCapture` is now
    // cancellation-aware), so re-arming a torn-down data plane would leak a live
    // mic with no session (latent edge a).
    await this._mic.start({
      onFrame,
      onLevel: (level) => { this._level = level; if (this._levelGate()) this._emit("level", level); },
      onError: (err) => this._setError(normaliseError(err)),
    });
  }

  private _closeAudio(): void {
    if (this._audioWs) {
      try { this._audioWs.close(); } catch { /* ignore */ }
      this._audioWs = null;
    }
  }

  private _teardown(): void {
    this.removeEventListener("ami-voice:recognizing-changed", this._onRecognizingChanged);
    this.removeEventListener("ami-voice:error", this._onError);
    this._stopDataPlane();
    this._mic = null;
    this._unbind?.();
    this._unbind = null;
    this._proxy?.dispose();
    this._proxy = null;
    if (this._ws) {
      try { this._ws.close(); } catch { /* ignore */ }
      this._ws = null;
    }
    this._core?.abort();
    this._core = null;
  }
}
