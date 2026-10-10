import { test, expect, type APIRequestContext } from "@playwright/test";

/**
 * SPEC §10.2: a "start over" click — `stop()` / `abort()` / `reset()` and then
 * `start()` without awaiting — must record into a NEW AmiVoice session, in a real
 * Chromium, for both transports. It used to be refused as "already active" while
 * the previous session drained its graceful stop, and the previous upstream
 * socket's late `close` used to end the next session. The harness's fake
 * AmiVoice lists every upstream connection at `/__fake/upstream`, so the spec
 * checks the mic feeds the NEW connection and the old one really closed.
 */
type Upstream = Array<{ open: boolean; audioFrames: number }>;

async function upstream(request: APIRequestContext): Promise<Upstream> {
  return (await request.get("/__fake/upstream")).json() as Promise<Upstream>;
}

const PAGES = { relay: "/", direct: "/direct.html" } as const;

for (const [transport, path] of Object.entries(PAGES)) {
  for (const cancel of ["stop", "abort", "reset"] as const) {
    test(`${transport}: ${cancel}() then start() in one click records into a new session`, async ({ page, request }) => {
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(String(e)));
      await page.goto(path);
      const status = page.locator("#status");

      await page.locator("#start").click();
      await expect(status).toHaveAttribute("data-recognizing", "true");
      await expect(page.locator("#interim")).toHaveText("こん");
      // This test's first session is the newest upstream connection so far.
      const first = (await upstream(request)).length - 1;

      await page.locator(`#restart-${cancel}`).click();

      // The re-armed mic streams into a SECOND upstream connection, and the
      // first one is closed rather than left running.
      await expect.poll(async () => {
        const u = await upstream(request);
        return u.length > first + 1 && u[first + 1].audioFrames > 0 && !u[first].open;
      }).toBe(true);
      await page.waitForTimeout(300); // let the old socket's late close reach the Core
      await expect(status).toHaveAttribute("data-recognizing", "true");
      await expect(page.locator("#error")).toHaveText("");
      expect((await upstream(request)).slice(first).map((c) => c.open)).toEqual([false, true]);

      await page.locator("#stop").click();
      // A graceful stop first delivered the old session's trailing final result;
      // abort drops it and reset clears the transcript.
      await expect(page.locator("#transcript")).toHaveText(cancel === "stop" ? "こんにちはこんにちは" : "こんにちは");
      await expect.poll(async () => (await upstream(request))[first + 1].open).toBe(false);
      await expect(page.locator("#error")).toHaveText("");
      expect(errors).toEqual([]);
    });
  }
}
