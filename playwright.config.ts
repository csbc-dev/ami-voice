import { defineConfig } from "@playwright/test";

/**
 * Real-browser e2e for the relay path (plan 1.3, browser part). Drives a real
 * Chromium `<ami-voice>` — mic capture (`getUserMedia` → `AudioWorklet` → PCM)
 * and the two-channel relay — against the in-process fake AmiVoice in
 * `tests/browser/harnessServer.mjs`.
 *
 * Uses the system Chrome (`channel: "chrome"`) so no Playwright browser download
 * is required; the fake-media flags supply audio without a real microphone.
 */
const PORT = Number(process.env.E2E_PORT ?? 3200);

export default defineConfig({
  testDir: "./tests/browser",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? "line" : "list",
  use: {
    baseURL: `http://localhost:${PORT}/`,
    channel: "chrome",
    launchOptions: {
      args: [
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
        "--autoplay-policy=no-user-gesture-required",
      ],
    },
  },
  webServer: {
    command: "node tests/browser/harnessServer.mjs",
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
