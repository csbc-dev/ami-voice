import { bootstrapAmiVoice } from "@csbc-dev/ami-voice";
import { bootstrapAi } from "@csbc-dev/ai-agent";
import { createApp } from "vue";
import App from "./App.vue";
import { LLM_WS } from "./config";
import "./style.css";

// Register both tags BEFORE the app mounts so the elements upgrade straight into
// their remote modes when App.vue's template refs attach.
//
//   • <ami-voice>: relay mode is selected per-element via the `transport="relay"`
//     + `remote-url` attributes in App.vue, so a bare bootstrap is enough here.
//   • <ai-agent>:  remote mode is a global bootstrap setting — point its control
//     channel at the server's /ai-agent endpoint. The LLM key stays on the server.
bootstrapAmiVoice();
bootstrapAi({
  remote: { enableRemote: true, remoteSettingType: "config", remoteCoreUrl: LLM_WS },
});

createApp(App).mount("#app");
