import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

// `@csbc-dev/ami-voice` and `@csbc-dev/ai-agent` are published packages (installed
// from npm). `isCustomElement` tells the Vue compiler <ami-voice> / <ai-agent> are
// custom elements, not Vue components, so it leaves them alone.
export default defineConfig({
  plugins: [
    vue({
      template: {
        compilerOptions: {
          isCustomElement: (tag) => tag === "ami-voice" || tag === "ai-agent",
        },
      },
    }),
  ],
  build: { outDir: "dist" },
});
