// Where the shared example server lives. It holds the APPKEY and hosts both the
// realtime relay WS and the file-recognition HTTP endpoint.
//   node examples/shared/server.mjs   (defaults to port 3100)
export const SERVER_HTTP = "http://localhost:3100";
export const SERVER_WS = "ws://localhost:3100/";

// Recognition engine (grammar_file_names). See AmiVoiceEngine in the package.
export const ENGINE = "-a-general";
// Realtime browser codec: the v1 data plane streams 16 kHz PCM only.
export const REALTIME_CODEC = "LSB16K";
