import { test, expect } from "@playwright/test";

/**
 * Phase 2 exit criterion (implementation-plan 2.6 / ADR 0006): a real Chromium
 * `<ami-voice transport="direct">` recognizes against the fake AmiVoice WSS with
 * audio BYPASSING the server. The browser opens the AmiVoice WSS itself using a
 * server-minted one-time APPKEY (the permanent APPKEY never reaches the page);
 * the recognition surface is byte-identical to relay mode.
 */
test("direct: real browser opens AmiVoice WSS itself → interim → finalized transcript", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto("/direct.html");

  const status = page.locator("#status");
  const startBtn = page.locator("#start");

  // The control channel (mint only) connects on element-connect; start() mints
  // the one-time token then opens the AmiVoice WSS directly (real user gesture →
  // getUserMedia/AudioContext run; Chromium fake device supplies audio).
  await startBtn.click();

  await expect(status).toHaveAttribute("data-connected", "true");
  await expect(status).toHaveAttribute("data-recognizing", "true");

  // Mic frames flow STRAIGHT to the fake AmiVoice (no server audio channel).
  await expect(page.locator("#interim")).toHaveText("こん");

  await page.locator("#stop").click();
  await expect(page.locator("#transcript")).toHaveText("こんにちは");

  await expect(page.locator("#error")).toHaveText("");
  expect(errors).toEqual([]);
});
