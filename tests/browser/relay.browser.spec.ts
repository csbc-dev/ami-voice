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

/**
 * SPEC §10.2 / README quick start: connect the element and call start() in the
 * same task, so start() runs before the control channel's initial `sync`. The
 * sync's `recognizing=false` predates the start and must not tear it down —
 * otherwise the server opens a session with no microphone attached (no audio,
 * so no interim ever arrives).
 */
test("relay: start() right after connect (before the initial sync) streams the mic", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto("/?presync");
  // The element is not in the document yet: no control channel is open.
  expect(await page.evaluate(() => (window as unknown as { __av: Element }).__av.isConnected)).toBe(false);

  await page.locator("#start").click(); // appendChild + start() in one task

  await expect(page.locator("#status")).toHaveAttribute("data-recognizing", "true");
  await expect(page.locator("#interim")).toHaveText("こん");
  await page.locator("#stop").click();
  await expect(page.locator("#transcript")).toHaveText("こんにちは");
  await expect(page.locator("#error")).toHaveText("");
  expect(errors).toEqual([]);
});
