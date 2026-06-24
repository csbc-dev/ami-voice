/// <reference types="vite/client" />

// Editor-friendliness shims (the build is esbuild via @vitejs/plugin-vue, no tsc):
// `*.vue` single-file components and side-effect `*.css` imports.
declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>;
  export default component;
}
declare module "*.css";
