import { setConfig } from "./config.js";
import { registerComponents } from "./registerComponents.js";
import { IWritableConfig } from "./types.js";

/**
 * One-shot setup: apply optional config, then register `<ami-voice>`.
 * Call once before any element is connected (see CLAUDE.md "Configure once").
 */
export function bootstrapAmiVoice(userConfig?: IWritableConfig): void {
  if (userConfig) {
    setConfig(userConfig);
  }
  registerComponents();
}
