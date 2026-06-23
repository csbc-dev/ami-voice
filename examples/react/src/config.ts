// Where the shared example server lives. It holds the APPKEY and hosts both the
// realtime relay WS and the file-recognition HTTP endpoint.
//   node examples/shared/server.mjs   (defaults to port 3100)
export const SERVER_HTTP = "http://localhost:3100";
export const SERVER_WS = "ws://localhost:3100/";

// Recognition engine (grammar_file_names). See AmiVoiceEngine in the package.
export const ENGINE = "-a-general";
// Realtime browser codec: the v1 data plane streams headerless 16 kHz PCM, so it
// MUST be declared as LSB16K. (File recognition sends no codec — the async file API
// auto-detects the format from the uploaded file's header.)
export const REALTIME_CODEC = "LSB16K";

// Meter gain: maps the mic level (RMS, ~0–0.7 for speech) to a 0–100% bar width.
export const LEVEL_METER_GAIN = 140;
