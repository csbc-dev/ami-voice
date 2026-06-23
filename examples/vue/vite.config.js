import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

// `@csbc-dev/ami-voice` is the published package (installed from npm). `isCustomElement`
// tells the Vue compiler <ami-voice> is a custom element, not a Vue component.
export default defineConfig({
  plugins: [
    vue({
      template: { compilerOptions: { isCustomElement: (tag) => tag === "ami-voice" } },
    }),
  ],
  build: { outDir: "dist" },
});
