import { defineConfig } from "vite";

// `@csbc-dev/ami-voice` is linked from the repo root (file:../..). No framework
// plugin — just plain ES modules. fs.allow lets the dev server read the link.
export default defineConfig({
  server: { fs: { allow: ["../.."] } },
  build: { outDir: "dist" },
});
