import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "happy-dom",
    setupFiles: ["./__tests__/setup.ts"],
    // Browser e2e (`tests/browser/*.spec.ts`) runs under Playwright, not vitest.
    exclude: ["**/integration/**", "**/browser/**", "**/node_modules/**"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // This gate guards the PORTABLE decision/logic layer (Core, protocol, audio,
      // errors, server helper). The browser data plane (Shell, mic, browser socket
      // factories, registration glue) and the provider's AmiVoice network IO are
      // proven by the integration (`test:integration`) and Playwright (`test:e2e`)
      // suites — not the happy-dom unit suite — so they are excluded here to keep
      // this a meaningful regression signal instead of a DOM-glue average.
      exclude: [
        "src/auto/**",                // side-effect entry shims (not in the tsc build)
        "src/audio/worklet.ts",       // AudioWorklet source string — runs in the worklet thread (e2e)
        "src/types.ts",               // type-only module
        "src/**/*.d.ts",
        "src/bootstrapAmiVoice.ts",   // customElements registration glue
        "src/registerComponents.ts",  // customElements.define glue
        "src/config.ts",              // configure-once module-global glue
        "src/components/**",          // Shell + mic + browser socket factory (e2e/integration)
        "src/providers/**",           // AmiVoice WSS/HTTP network IO (integration)
      ],
      reporter: ["text-summary", "text"],
      // Floors set just under the measured unit coverage of the gated layer, so a
      // regression trips the gate. Raise them as coverage improves; never lower to
      // paper over a drop.
      thresholds: {
        statements: 90,
        branches: 82,
        functions: 80,
        lines: 92,
      },
    },
  },
});
