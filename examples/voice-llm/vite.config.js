import { defineConfig } from "vite";

// Both `@csbc-dev/ami-voice` and `@csbc-dev/ai-agent` are published packages
// (installed from npm). No framework plugin — plain ES modules + a tiny bind().
export default defineConfig({
  build: { outDir: "dist" },
});
