import { encodeLSB16K, frameLevel } from "../audio/pcmEncoder.js";
import { PCM_WORKLET_NAME, pcmWorkletSource } from "../audio/worklet.js";
import { raiseError } from "../raiseError.js";

export interface MicCaptureHandlers {
  /** One already-framed `LSB16K` PCM chunk ready to stream. */
  onFrame(bytes: Uint8Array): void;
  /** RMS input level for a mic meter. */
  onLevel(level: number): void;
  /** Capture-path failure (getUserMedia denial, AudioWorklet load error, …). */
  onError(err: unknown): void;
}

/**
 * Browser-only microphone data plane (docs/adr/0001 Case C, docs/adr/0005).
 * `getUserMedia` → `AudioContext` → `AudioWorklet` → downsample/PCM-encode.
 * The encoded frames go to `onFrame`; the Shell relays them on the binary
 * audio channel (remote) or into `AmiVoiceCore.feedAudio` (local).
 */
export class MicCapture {
  private _stream: MediaStream | null = null;
  private _ctx: AudioContext | null = null;
  private _node: AudioWorkletNode | null = null;
  private _source: MediaStreamAudioSourceNode | null = null;
  /**
   * Bumped by every `stop()`. `start()` captures the current value and re-checks
   * it after each `await`, so a `stop()` that races an in-flight `start()` WINS:
   * `getUserMedia` (or `addModule`) is past its guard once it resolves, but the
   * generation mismatch lets `start()` release the freshly obtained device
   * instead of arming a live mic the Shell already tore down (latent edge a).
   */
  private _generation = 0;

  async start(handlers: MicCaptureHandlers): Promise<void> {
    if (this._ctx) return;
    const mediaDevices = globalThis.navigator?.mediaDevices;
    if (!mediaDevices?.getUserMedia) {
      raiseError("getUserMedia is unavailable; mic capture requires a secure browser context");
    }
    const generation = this._generation;

    const stream = await mediaDevices.getUserMedia({ audio: true });
    // A `stop()` interleaved with the pending `getUserMedia` already ran (it
    // bumped `_generation` and nulled the fields). Release this just-granted
    // device and bail rather than build a live capture graph with no session.
    if (generation !== this._generation) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    this._stream = stream;

    const ctx = new AudioContext();
    this._ctx = ctx;

    const blobUrl = URL.createObjectURL(
      new Blob([pcmWorkletSource], { type: "application/javascript" }),
    );
    try {
      await ctx.audioWorklet.addModule(blobUrl);
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
    // A `stop()` during `addModule` likewise wins: tear down what we built here.
    if (generation !== this._generation) {
      this._stream?.getTracks().forEach((track) => track.stop());
      // A racing stop() may already have closed THIS ctx (it targets the same
      // field), so close() can reject with InvalidStateError on an already-closed
      // context — swallow it rather than leak an unhandled rejection.
      void ctx.close().catch(() => { /* already closing */ });
      this._stream = null;
      this._ctx = null;
      return;
    }

    const node = new AudioWorkletNode(ctx, PCM_WORKLET_NAME);
    this._node = node;
    node.port.onmessage = (event: MessageEvent): void => {
      try {
        const frame = event.data as Float32Array;
        handlers.onLevel(frameLevel(frame));
        handlers.onFrame(encodeLSB16K(frame, ctx.sampleRate));
      } catch (err) {
        handlers.onError(err);
      }
    };

    const source = ctx.createMediaStreamSource(stream);
    this._source = source;
    // Source → worklet only. We deliberately do NOT connect to destination,
    // so the mic is not played back through the speakers.
    source.connect(node);
  }

  stop(): void {
    // Win any in-flight start(): a start() awaiting getUserMedia/addModule will
    // see this bumped generation after its await and release the device.
    this._generation++;
    if (this._node) {
      this._node.port.onmessage = null;
      this._node.disconnect();
    }
    this._source?.disconnect();
    this._stream?.getTracks().forEach((track) => track.stop());
    void this._ctx?.close().catch(() => { /* already closing */ });
    this._node = null;
    this._source = null;
    this._stream = null;
    this._ctx = null;
  }
}
