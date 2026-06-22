import { defineConfig } from "vitest/config";

// Node-environment integration tests (real `ws` sockets). Kept separate from the
// happy-dom unit suite so `globalThis.WebSocket` is Node's spec-compliant one.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/integration/**/*.test.ts"],
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
