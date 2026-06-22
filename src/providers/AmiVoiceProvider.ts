import { raiseError } from "../raiseError.js";
import { readProcessEnv } from "../processEnv.js";
import { AmiVoiceError } from "../errorCodes.js";
import { buildStartCommand, toSegment } from "../protocol/wnnProtocol.js";
import { runRealtimeSession, type RealtimeSocket } from "../protocol/realtimeSession.js";
import type {
  IAmiVoiceProvider, IRealtimeSession, RealtimeSessionHandlers,
  RecognitionOptions, RecognitionSegment, DirectSessionInfo,
} from "../types.js";

// Re-exported for back-compat: the realtime socket shape now lives in the
// shared session module, but consumers/tests import it from the provider.
export type { RealtimeSocket } from "../protocol/realtimeSession.js";

/** Default AmiVoice endpoints (overridable for testing / private deployments). */
const DEFAULT_REALTIME_ENDPOINT = "wss://acp-api.amivoice.com/v1/";
const DEFAULT_REALTIME_NOLOG_ENDPOINT = "wss://acp-api.amivoice.com/v1/nolog/";
const DEFAULT_ASYNC_ENDPOINT = "https://acp-api-async.amivoice.com/v2/recognitions";
const DEFAULT_ISSUE_ENDPOINT = "https://acp-api.amivoice.com/issue_service_authorization";

export interface AmiVoiceProviderOptions {
  /** APPKEY. Falls back to `AMIVOICE_APPKEY`. Server-side only (docs/adr/0002). */
  appKey?: string;
  /** Service id / password for one-time APPKEY issuance (direct mode, ADR 0006). */
  serviceId?: string;
  servicePassword?: string;
  realtimeEndpoint?: string;
  realtimeNoLogEndpoint?: string;
  asyncEndpoint?: string;
  issueEndpoint?: string;
  /** Graceful-stop fallback timeout in ms (implementation-notes Q4). Default 5000. */
  stopTimeoutMs?: number;
  /** Async-poll interval bounds in ms. Default 1000 → 5000 (exponential). */
  pollIntervalMs?: number;
  pollMaxIntervalMs?: number;
  /** Injectable socket factory (default wraps platform `WebSocket`). */
  socketFactory?: (url: string) => RealtimeSocket;
  /** Injectable fetch (default platform `fetch`). */
  fetch?: typeof fetch;
}

function defaultSocketFactory(url: string): RealtimeSocket {
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  const sock: RealtimeSocket = { send: (d) => ws.send(d), close: () => ws.close(), onopen: null, onmessage: null, onclose: null, onerror: null };
  ws.onopen = () => sock.onopen?.();
  ws.onmessage = (e: MessageEvent) => { if (typeof e.data === "string") sock.onmessage?.(e.data); };
  ws.onclose = () => sock.onclose?.();
  ws.onerror = (e) => sock.onerror?.(e);
  return sock;
}

/**
 * Default `IAmiVoiceProvider`. Holds the APPKEY and owns the AmiVoice transport.
 * MUST run server-side — the APPKEY never reaches the browser (docs/adr/0002).
 */
export class AmiVoiceProvider implements IAmiVoiceProvider {
  private readonly _appKey: string;
  private readonly _serviceId?: string;
  private readonly _servicePassword?: string;
  private readonly _realtimeEndpoint: string;
  private readonly _realtimeNoLogEndpoint: string;
  private readonly _asyncEndpoint: string;
  private readonly _issueEndpoint: string;
  private readonly _stopTimeoutMs: number;
  private readonly _pollIntervalMs: number;
  private readonly _pollMaxIntervalMs: number;
  private readonly _socketFactory: (url: string) => RealtimeSocket;
  private readonly _fetch: typeof fetch;

  constructor(options: AmiVoiceProviderOptions = {}) {
    this._appKey = options.appKey ?? readProcessEnv("AMIVOICE_APPKEY") ?? "";
    this._serviceId = options.serviceId ?? readProcessEnv("AMIVOICE_SERVICE_ID");
    this._servicePassword = options.servicePassword ?? readProcessEnv("AMIVOICE_SERVICE_PASSWORD");
    this._realtimeEndpoint = options.realtimeEndpoint ?? DEFAULT_REALTIME_ENDPOINT;
    this._realtimeNoLogEndpoint = options.realtimeNoLogEndpoint ?? DEFAULT_REALTIME_NOLOG_ENDPOINT;
    this._asyncEndpoint = options.asyncEndpoint ?? DEFAULT_ASYNC_ENDPOINT;
    this._issueEndpoint = options.issueEndpoint ?? DEFAULT_ISSUE_ENDPOINT;
    this._stopTimeoutMs = options.stopTimeoutMs ?? 5000;
    this._pollIntervalMs = options.pollIntervalMs ?? 1000;
    this._pollMaxIntervalMs = options.pollMaxIntervalMs ?? 5000;
    this._socketFactory = options.socketFactory ?? defaultSocketFactory;
    this._fetch = options.fetch ?? ((globalThis as { fetch?: typeof fetch }).fetch as typeof fetch);
  }

  /** Realtime endpoint for a session (logging vs no-logging). */
  endpointFor(options: RecognitionOptions): string {
    return options.noLog ? this._realtimeNoLogEndpoint : this._realtimeEndpoint;
  }

  private _requireAppKey(): void {
    if (!this._appKey) {
      raiseError("AMIVOICE_APPKEY is not set; the AmiVoice provider needs the server-side APPKEY");
    }
  }

  async openRealtimeSession(
    options: RecognitionOptions,
    handlers: RealtimeSessionHandlers,
  ): Promise<IRealtimeSession> {
    this._requireAppKey();
    const socket = this._socketFactory(this.endpointFor(options));
    const startCommand = buildStartCommand(options, this._appKey);
    return runRealtimeSession(socket, startCommand, handlers, this._stopTimeoutMs);
  }

  /**
   * Direct mode (docs/adr/0006): mint a one-time APPKEY (optionally IP-restricted)
   * and build the approved `s` command so a browser can open the AmiVoice WSS
   * itself. The permanent APPKEY stays here — only the short-lived token (baked
   * into `sCommand` as `authorization=`) is returned. Reuses the SAME
   * `buildStartCommand` / `endpointFor` the relay path uses (no parallel paths).
   */
  async prepareDirectSession(
    options: RecognitionOptions,
    mintOptions: { ipa?: string; epi?: number } = {},
  ): Promise<DirectSessionInfo> {
    const oneTimeKey = await this.issueOneTimeAppKey(mintOptions);
    return {
      endpoint: this.endpointFor(options),
      sCommand: buildStartCommand(options, oneTimeKey),
    };
  }

  /** Build the HTTP `d` config string for file recognition. */
  private _buildDParam(options: RecognitionOptions): string {
    const parts = [options.engine];
    if (options.profileId) parts.push(`profileId=${options.profileId}`);
    if (options.noLog) parts.push("loggingOptOut=True");
    return parts.join(" ");
  }

  async recognizeFile(
    audio: Blob | Uint8Array,
    options: RecognitionOptions,
  ): Promise<RecognitionSegment[]> {
    this._requireAppKey();
    const body = new FormData();
    body.append("u", this._appKey);
    body.append("d", this._buildDParam(options));
    const blob = audio instanceof Uint8Array ? new Blob([audio as BlobPart]) : audio;
    body.append("a", blob);

    const enqueue = await this._fetch(this._asyncEndpoint, { method: "POST", body });
    if (!enqueue.ok) throw new AmiVoiceError("?", `async enqueue failed (HTTP ${enqueue.status})`);
    const job = (await enqueue.json()) as { sessionid?: string; code?: string; message?: string };
    if (!job.sessionid) throw new AmiVoiceError(job.code ?? "?", job.message ?? "async enqueue returned no sessionid");

    return this._pollAsyncJob(job.sessionid);
  }

  private async _pollAsyncJob(sessionid: string): Promise<RecognitionSegment[]> {
    const url = `${this._asyncEndpoint}/${encodeURIComponent(sessionid)}`;
    let interval = this._pollIntervalMs;
    for (;;) {
      const res = await this._fetch(url, { headers: { Authorization: `Bearer ${this._appKey}` } });
      if (!res.ok) throw new AmiVoiceError("?", `async poll failed (HTTP ${res.status})`);
      const job = (await res.json()) as {
        status?: string;
        code?: string;
        error_message?: string;
        segments?: Array<{ results?: unknown }>;
      };
      if (job.status === "completed") return normalizeAsyncSegments(job.segments);
      if (job.status === "error") throw new AmiVoiceError(job.code ?? "?", job.error_message ?? "async recognition failed");
      await delay(interval);
      interval = Math.min(interval * 2, this._pollMaxIntervalMs);
    }
  }

  /**
   * Issue a one-time APPKEY (ADR 0006 / direct mode). Returns a short-lived,
   * optionally IP-restricted service-authorization string. The permanent APPKEY
   * never leaves the server; only this token is handed to a client.
   */
  async issueOneTimeAppKey(opts: { ipa?: string; epi?: number } = {}): Promise<string> {
    const form = new URLSearchParams();
    if (this._serviceId && this._servicePassword) {
      form.set("sid", this._serviceId);
      form.set("spw", this._servicePassword);
    } else {
      this._requireAppKey();
      form.set("u", this._appKey);
    }
    if (opts.ipa) form.set("ipa", opts.ipa);
    form.set("epi", String(opts.epi ?? 30));

    const res = await this._fetch(this._issueEndpoint, { method: "POST", body: form });
    if (!res.ok) throw new AmiVoiceError("-", `one-time APPKEY issuance failed (HTTP ${res.status})`);
    return (await res.text()).trim();
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Flatten async v2 `segments[].results[]` into normalized segments (D5). */
function normalizeAsyncSegments(segments: Array<{ results?: unknown }> | undefined): RecognitionSegment[] {
  if (!Array.isArray(segments)) return [];
  const out: RecognitionSegment[] = [];
  for (const seg of segments) {
    const results = (seg as { results?: unknown }).results;
    if (Array.isArray(results)) {
      for (const r of results) out.push(toSegment(r as Record<string, unknown>));
    }
  }
  return out;
}
