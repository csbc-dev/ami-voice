import { bootstrapAmiVoice } from "@csbc-dev/ami-voice";
import { createApp } from "vue";
import App from "./App.vue";
import "./style.css";

// Register <ami-voice>. The APPKEY stays on the shared server (relay mode).
bootstrapAmiVoice();

createApp(App).mount("#app");
