// Shared example server (holds the APPKEY; hosts the relay WS + file endpoint).
//   node examples/shared/server.mjs   (defaults to port 3100)
export const SERVER_HTTP = "http://localhost:3100";
export const SERVER_WS = "ws://localhost:3100/";

export const ENGINE = "-a-general";
// Realtime browser codec: the v1 data plane streams 16 kHz PCM only.
export const REALTIME_CODEC = "LSB16K";
