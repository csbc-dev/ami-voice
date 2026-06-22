import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "happy-dom",
    setupFiles: ["./__tests__/setup.ts"],
    // Browser e2e (`tests/browser/*.spec.ts`) runs under Playwright, not vitest.
    exclude: ["**/integration/**", "**/browser/**", "**/node_modules/**"],
  },
});
