import { raiseError } from "../raiseError.js";

/**
 * Pure audio-framing helpers for the browser data plane (docs/adr/0005).
 * No DOM dependency — safe to unit-test directly.
 */

/** Clamp Float32 samples [-1, 1] to signed 16-bit PCM. */
export function floatTo16BitPCM(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

/**
 * Downsample by simple block averaging. AmiVoice realtime engines run at 16 kHz;
 * browsers typically capture at 44.1/48 kHz, so this is the common path.
 * Upsampling is not supported (we never want to fabricate samples).
 */
export function downsampleTo16k(
  input: Float32Array,
  inputSampleRate: number,
  targetRate = 16000,
): Float32Array {
  if (inputSampleRate === targetRate) return input;
  if (inputSampleRate < targetRate) {
    raiseError(`cannot upsample ${inputSampleRate}Hz to ${targetRate}Hz; capture at >= ${targetRate}Hz`);
  }
  const ratio = inputSampleRate / targetRate;
  const newLength = Math.round(input.length / ratio);
  const out = new Float32Array(newLength);
  for (let i = 0; i < newLength; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    let count = 0;
    for (let j = start; j < end; j++) {
      sum += input[j];
      count++;
    }
    out[i] = count > 0 ? sum / count : 0;
  }
  return out;
}

/**
 * Encode mic samples to little-endian 16-bit PCM bytes (AmiVoice `LSB16K`).
 * Writes explicitly little-endian via `DataView` so the result is byte-order
 * stable regardless of host endianness.
 */
export function encodeLSB16K(input: Float32Array, inputSampleRate: number): Uint8Array {
  const pcm = floatTo16BitPCM(downsampleTo16k(input, inputSampleRate));
  const buffer = new ArrayBuffer(pcm.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < pcm.length; i++) {
    view.setInt16(i * 2, pcm[i], /* littleEndian */ true);
  }
  return new Uint8Array(buffer);
}

/** Root-mean-square level of a frame, for a mic meter (0..1-ish). */
export function frameLevel(frame: Float32Array): number {
  if (frame.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  return Math.sqrt(sum / frame.length);
}
