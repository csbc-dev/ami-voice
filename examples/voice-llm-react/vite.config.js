import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `@csbc-dev/ami-voice` and `@csbc-dev/ai-agent` are published packages installed
// from npm. React 19 renders custom elements (<ami-voice>, <ai-agent>) natively —
// no compiler hint needed — so the plugin list is just react().
export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist" },
});
