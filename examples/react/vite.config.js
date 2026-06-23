import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `@csbc-dev/ami-voice` is linked from the repo root (file:../.. in package.json),
// so its built `dist/` and bundled deps resolve normally. fs.allow lets the dev
// server read the linked package outside this folder.
export default defineConfig({
  plugins: [react()],
  server: { fs: { allow: ["../.."] } },
  build: { outDir: "dist" },
});
