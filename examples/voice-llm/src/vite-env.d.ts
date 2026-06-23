/// <reference types="vite/client" />

// Side-effect CSS imports (`import "./style.css"`) are handled by Vite at build
// time. The vite/client reference above already declares `*.css`; this explicit
// fallback keeps the editor happy even if vite's types are not resolved.
declare module "*.css";
