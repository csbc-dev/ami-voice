/** Registered name of the PCM-capture AudioWorkletProcessor. */
export const PCM_WORKLET_NAME = "ami-voice-pcm-capture";

/**
 * AudioWorklet processor source. Loaded into an `AudioContext` via a Blob URL
 * at runtime (see micCapture). It forwards each input frame's first channel to
 * the main thread, where it is downsampled and PCM-encoded (pcmEncoder). The
 * worklet itself does no encoding — keeping the audio-thread callback minimal.
 */
export const pcmWorkletSource = `
class AmiVoicePcmCapture extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length > 0) {
      // Copy out of the reused worklet buffer before posting.
      this.port.postMessage(channel.slice(0));
    }
    return true;
  }
}
registerProcessor(${JSON.stringify(PCM_WORKLET_NAME)}, AmiVoicePcmCapture);
`;
