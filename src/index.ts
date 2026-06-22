// Browser-facing barrel (default export `@csbc-dev/ami-voice`).
//
// Importing this from Node fails at module evaluation because the Shell
// extends `HTMLElement`. Server-side consumers MUST use `@csbc-dev/ami-voice/server`.
export { bootstrapAmiVoice } from "./bootstrapAmiVoice.js";
export { getConfig, setConfig, getRemoteCoreUrl } from "./config.js";
export { AmiVoiceCore } from "./core/AmiVoiceCore.js";
export { AmiVoice as WcsAmiVoice } from "./components/AmiVoice.js";
export { AmiVoiceProvider } from "./providers/AmiVoiceProvider.js";
export type { AmiVoiceProviderOptions } from "./providers/AmiVoiceProvider.js";
export {
  buildStartCommand,
  parseEvent,
  AUDIO_FRAME_PREFIX,
} from "./protocol/wnnProtocol.js";
export type { WnnEvent } from "./protocol/wnnProtocol.js";
export { runRealtimeSession } from "./protocol/realtimeSession.js";
export type { RealtimeSocket } from "./protocol/realtimeSession.js";
// Browser-direct transport (docs/adr/0006, opt-in).
export {
  DirectBrowserProvider,
  openDirectRealtimeSession,
  browserRealtimeSocketFactory,
} from "./components/realtimeSocket.js";
export type { OpenDirectSessionOptions } from "./components/realtimeSocket.js";
export { floatTo16BitPCM, downsampleTo16k } from "./audio/pcmEncoder.js";
export { AmiVoiceError, mapResultCode, isClientError, getErrorCode } from "./errorCodes.js";
export type { AmiVoiceErrorCode } from "./errorCodes.js";
export { shouldSendFrame, createRateLimiter, DEFAULT_MAX_AUDIO_BUFFER } from "./audio/flowControl.js";

export type {
  IWritableConfig, IWritableTagNames, IWritableRemoteConfig,
  IAmiVoiceProvider, IRealtimeSession, RealtimeSessionHandlers,
  RecognitionOptions, RecognitionSegment, RecognitionToken, InterimResult,
  AmiVoiceCodec, AmiVoiceEngine, AmiVoiceTransport, DirectSessionInfo,
  SerializedError, WcsAmiVoiceAnyError,
  AmiVoiceCoreValues, AmiVoiceValues,
} from "./types.js";
