import { defineConfig } from "vite";

// `@csbc-dev/ami-voice` is the published package (installed from npm). No framework
// plugin — just plain ES modules.
export default defineConfig({
  build: { outDir: "dist" },
});
