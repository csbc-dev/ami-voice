import { bootstrapAmiVoice } from "@csbc-dev/ami-voice";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./style.css";

// Register <ami-voice>. Remote (relay) mode is selected per element via the
// `remote-url` + `transport="relay"` attributes — the APPKEY stays on the server.
bootstrapAmiVoice();

createRoot(document.getElementById("root")!).render(<App />);
