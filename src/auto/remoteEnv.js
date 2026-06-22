// Side-effect entrypoint for `@csbc-dev/ami-voice/auto/remoteEnv`.
//
// Same as `./auto`, but opts into remote-first mode and reads the JSON control
// channel URL from `AMIVOICE_REMOTE_CORE_URL` (process.env, or a
// `globalThis.AMIVOICE_REMOTE_CORE_URL` inject-before-script hook). The binary
// audio channel is negotiated per session on start() (docs/adr/0003).
import { bootstrapAmiVoice } from "../../dist/index.js";

bootstrapAmiVoice({
  remote: { enableRemote: true, remoteSettingType: "env" },
});
