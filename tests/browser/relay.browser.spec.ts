import { test, expect } from "@playwright/test";

/**
 * Phase 1 exit criterion (implementation-plan 1.3, browser part): a real
 * Chromium `<ami-voice>` transcribes against the fake AmiVoice WSS — proving the
 * browser-only data plane (`getUserMedia` → `AudioWorklet` → PCM framing) and
 * the single-port two-channel relay (JSON control + binary audio correlated by
 * a `Sec-WebSocket-Protocol` session token) the Node integration test can't.
 */
test("relay: real browser mic → interim → finalized transcript", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto("/");

  const status = page.locator("#status");
  const startBtn = page.locator("#start");

  // The control channel connects on element-connect; clicking start() opens the
  // AmiVoice session (a real user gesture, so getUserMedia/AudioContext run).
  await startBtn.click();

  // Control channel established + realtime session open.
  await expect(status).toHaveAttribute("data-connected", "true");
  await expect(status).toHaveAttribute("data-recognizing", "true");

  // Mic frames flow over the binary audio channel → fake replies with `U`.
  await expect(page.locator("#interim")).toHaveText("こん");

  // Graceful stop → fake emits the final `A` then the `e` ack.
  await page.locator("#stop").click();
  await expect(page.locator("#transcript")).toHaveText("こんにちは");

  // No surfaced recognition error, and no uncaught page errors.
  await expect(page.locator("#error")).toHaveText("");
  expect(errors).toEqual([]);
});
