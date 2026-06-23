import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `@csbc-dev/ami-voice` is the published package, installed from npm into
// node_modules, so its built `dist/` and bundled deps resolve normally.
export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist" },
});
