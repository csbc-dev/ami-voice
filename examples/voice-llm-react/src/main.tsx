import { bootstrapAmiVoice } from "@csbc-dev/ami-voice";
import { bootstrapAi } from "@csbc-dev/ai-agent";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { LLM_WS } from "./config";
import "./style.css";

// Register both tags BEFORE rendering so the elements upgrade straight into their
// remote modes when App's refs attach.
//
//   • <ami-voice>: relay mode is selected per-element via the `transport="relay"`
//     + `remote-url` attributes in App.tsx, so a bare bootstrap is enough here.
//   • <ai-agent>:  remote mode is a global bootstrap setting — point its control
//     channel at the server's /ai-agent endpoint. The LLM key stays on the server.
bootstrapAmiVoice();
bootstrapAi({
  remote: { enableRemote: true, remoteSettingType: "config", remoteCoreUrl: LLM_WS },
});

createRoot(document.getElementById("root")!).render(<App />);
