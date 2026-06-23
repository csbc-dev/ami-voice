// The combined example server (holds BOTH secrets; hosts both Cores).
//   npm run server   (defaults to port 3200)
export const SPEECH_WS = "ws://localhost:3200/";          // <ami-voice> relay (control + audio)
export const LLM_WS = "ws://localhost:3200/ai-agent";     // <ai-agent> remote Core

export const ENGINE = "-a-general";
// Realtime browser codec: the v1 data plane streams headerless 16 kHz PCM, so it
// MUST be declared as LSB16K.
export const REALTIME_CODEC = "LSB16K";

// Provider/model are display-only here — the server pins the real ones (and the
// system prompt) so the browser cannot pick a costlier model. Offline they are
// ignored entirely.
export const LLM_PROVIDER = "anthropic";
export const LLM_MODEL = "claude-haiku-4-5";

// Meter gain: maps the mic level (RMS, ~0–0.7 for speech) to a 0–100% bar width.
export const LEVEL_METER_GAIN = 140;
