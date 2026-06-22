import { AmiVoice } from "./components/AmiVoice.js";
import { _getInternalConfig } from "./config.js";

export function registerComponents(): void {
  const cfg = _getInternalConfig();
  if (!customElements.get(cfg.tagNames.amiVoice)) {
    customElements.define(cfg.tagNames.amiVoice, AmiVoice);
  }
}
