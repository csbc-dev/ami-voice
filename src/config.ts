import { IConfig, IWritableConfig, AmiVoiceTransport } from "./types.js";
import { readProcessEnv } from "./processEnv.js";

interface IInternalConfig extends IConfig {
  tagNames: {
    amiVoice: string;
  };
  remote: {
    enableRemote: boolean;
    remoteSettingType: "env" | "config";
    remoteCoreUrl: string;
    transport: AmiVoiceTransport;
  };
}

/**
 * Resolve the control-channel (`@wc-bindable/remote`) WebSocket URL. In `env`
 * mode it reads `AMIVOICE_REMOTE_CORE_URL` from `process.env` first, then a
 * `globalThis.AMIVOICE_REMOTE_CORE_URL` inject-before-script hook for browser
 * bundles. This is the JSON CONTROL channel only — the separate binary audio
 * channel URL is negotiated per session on `start()` (see docs/adr/0003).
 */
function resolveRemoteCoreUrl(cfg: IInternalConfig): string {
  if (cfg.remote.remoteSettingType === "env") {
    const fromEnv = readProcessEnv("AMIVOICE_REMOTE_CORE_URL");
    if (fromEnv !== undefined) return fromEnv;
    const fromGlobal = (globalThis as { AMIVOICE_REMOTE_CORE_URL?: unknown }).AMIVOICE_REMOTE_CORE_URL;
    return typeof fromGlobal === "string" ? fromGlobal : "";
  }
  return cfg.remote.remoteCoreUrl;
}

const _config: IInternalConfig = {
  tagNames: {
    amiVoice: "ami-voice",
  },
  remote: {
    // Remote-first by default (docs/adr/0002): the APPKEY stays server-side.
    // Defaulted to `false` here only so the module imports cleanly; bootstrap
    // / setConfig is where a deployment opts remote on.
    enableRemote: false,
    remoteSettingType: "config",
    remoteCoreUrl: "",
    // Relay is the default transport (docs/adr/0006); direct is opt-in.
    transport: "relay",
  },
};

function deepFreeze<T>(obj: T): T {
  if (obj === null || typeof obj !== "object") return obj;
  Object.freeze(obj);
  for (const key of Object.keys(obj)) {
    deepFreeze((obj as Record<string, unknown>)[key]);
  }
  return obj;
}

function deepClone<T>(obj: T): T {
  if (obj === null || typeof obj !== "object") return obj;
  const clone: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    clone[key] = deepClone((obj as Record<string, unknown>)[key]);
  }
  return clone as T;
}

let frozenConfig: IConfig | null = null;

/** Internal-only accessor for the live mutable config (Shell / register read). */
export function _getInternalConfig(): IInternalConfig {
  return _config;
}

export function getConfig(): IConfig {
  if (!frozenConfig) {
    frozenConfig = deepFreeze(deepClone(_config));
  }
  return frozenConfig;
}

export function setConfig(partialConfig: IWritableConfig): void {
  if (partialConfig.tagNames) {
    Object.assign(_config.tagNames, partialConfig.tagNames);
  }
  if (partialConfig.remote) {
    Object.assign(_config.remote, partialConfig.remote);
  }
  frozenConfig = null;
}

export function getRemoteCoreUrl(): string {
  return resolveRemoteCoreUrl(_config);
}
