// Server-side entry point (`@csbc-dev/ami-voice/server`).
//
// The default barrel re-exports the `<ami-voice>` custom element, which extends
// `HTMLElement`; loading it from Node throws `HTMLElement is not defined`. This
// barrel exports only the headless pieces safe to instantiate in Node:
//   - `AmiVoiceCore`     (the wcBindable Core that holds the APPKEY-bearing provider)
//   - `AmiVoiceProvider` (default provider; reads AMIVOICE_APPKEY)
//   - the WSS command/event protocol helpers, and types
//   - `redactSecrets`    (APPKEY / credential redaction for the application's own logs)
//
// The Shell, mic capture, and the binary audio channel stay in the default barrel.
export { AmiVoiceCore } from "./core/AmiVoiceCore.js";
export { AmiVoiceProvider } from "./providers/AmiVoiceProvider.js";
export type { AmiVoiceProviderOptions } from "./providers/AmiVoiceProvider.js";
export {
  createAmiVoiceRelayServer,
} from "./createAmiVoiceServer.js";
export type {
  AmiVoiceRelayServer, AmiVoiceRelayServerOptions, AmiVoiceControlSession,
  AmiVoiceControlConnectionOptions, AudioSocketLike,
  AmiVoiceServerLogEvent, AmiVoiceServerLogger,
} from "./createAmiVoiceServer.js";
export { AmiVoiceError, mapResultCode, isClientError, getErrorCode } from "./errorCodes.js";
export type { AmiVoiceErrorCode } from "./errorCodes.js";
// Redacts the APPKEY — by value once a provider holds it, and in the
// `authorization=` / `Bearer` / `u=` forms an `s` command, a request or their
// echo carries — for strings the application logs itself (SPEC §14). The value
// registry behind it (`registerKnownSecret`) stays internal. Server-only on purpose,
// NOT mirrored in the default barrel: the permanent APPKEY and the logs that
// must not show it live on the server.
export { redactSecrets } from "./redact.js";
export {
  buildStartCommand,
  parseEvent,
  AUDIO_FRAME_PREFIX,
} from "./protocol/wnnProtocol.js";
export type { WnnEvent } from "./protocol/wnnProtocol.js";
// Shared realtime session loop (transport-agnostic; relay + direct).
export { runRealtimeSession } from "./protocol/realtimeSession.js";
export type { RealtimeSocket } from "./protocol/realtimeSession.js";
// Speaker view (derived, final-only — docs/adr/0007).
export { toSpeakerSegment, speakerLabelOf } from "./speakerView.js";

// `AmiVoiceValues` is intentionally NOT re-exported here: it extends
// `AmiVoiceCoreValues` with `level` / `mode`, Shell-only properties with no
// meaning server-side. Server consumers bind against the Core
// (`AmiVoiceCoreValues`).
export type {
  IAmiVoiceProvider, IRealtimeSession, RealtimeSessionHandlers,
  RecognitionOptions, RecognitionSegment, RecognitionToken, InterimResult, SpeakerSegment,
  AmiVoiceCodec, AmiVoiceEngine, AmiVoiceTransport,
  // Direct-mode (docs/adr/0006) provider API types: `AmiVoiceProvider`
  // (a /server export) exposes `prepareDirectSession`/`issueOneTimeAppKey`,
  // whose argument/result types a Node consumer must be able to name.
  DirectSessionInfo, DirectMintOptions,
  SerializedError, WcsAmiVoiceAnyError,
  AmiVoiceCoreValues,
} from "./types.js";
