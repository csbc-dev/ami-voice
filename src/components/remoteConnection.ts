import { raiseError } from "../raiseError.js";

/** Validate a `ws://` / `wss://` control- or audio-channel URL. */
export function validateRemoteCoreUrl(url: string): string {
  if (!url || typeof url !== "string") {
    raiseError(
      "remote core URL is not configured; set it via bootstrapAmiVoice({ remote: { ... } }) " +
      "or AMIVOICE_REMOTE_CORE_URL",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    raiseError(`remote core URL is not a valid URL: "${url}"`);
  }
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    raiseError(`remote core URL must be ws:// or wss://, got "${parsed.protocol}"`);
  }
  return url;
}

/**
 * Open the binary audio data channel (docs/adr/0003). This is SEPARATE from the
 * JSON `@wc-bindable/remote` control proxy because the wc-bindable wire is
 * JSON-only and cannot carry raw PCM. The channel is correlated to the control
 * session by `sessionId`, which the server uses to route frames into the right
 * AmiVoice connection.
 *
 * SPEC §11.3: the session token authenticates the audio channel via the
 * `Sec-WebSocket-Protocol` handshake header, NOT the query string — query
 * strings leak into access logs, and the token is a bearer credential for the
 * session. The control connection carries no subprotocol, so a single-port
 * relay can route by subprotocol presence (control vs audio).
 */
export function openAudioChannel(audioUrl: string, sessionId: string): WebSocket {
  validateRemoteCoreUrl(audioUrl);
  const ws = new WebSocket(audioUrl, [sessionId]);
  ws.binaryType = "arraybuffer";
  return ws;
}
