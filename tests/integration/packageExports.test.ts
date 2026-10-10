import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));

/**
 * Run an ES-module snippet in a fresh Node process at the package root, so the
 * import goes through Node's own resolution of this package's `exports` map
 * (a package may import itself by name) to the built `dist/` — exactly what a
 * consumer of `@csbc-dev/ami-voice/server` gets.
 */
function runModule(source: string): string {
  return execFileSync(process.execPath, ["--input-type=module", "-e", source], { cwd: root, encoding: "utf8" });
}

describe("built package: redactSecrets on @csbc-dev/ami-voice/server", () => {
  beforeAll(() => {
    // This checks dist/, so build it first — the same `tsc` as `npm run build`
    // (and `prepack`) — rather than read whatever an earlier build left there.
    const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
    execFileSync(process.execPath, [tsc, "-p", root], { cwd: root, stdio: "pipe" });
  }, 120_000);

  it("imports from the /server subpath and redacts", () => {
    const out = runModule(`
      import { redactSecrets } from "@csbc-dev/ami-voice/server";
      process.stdout.write(JSON.stringify([typeof redactSecrets, redactSecrets("s LSB16K -a-general authorization=K")]));
    `);
    expect(JSON.parse(out)).toStrictEqual(["function", "s LSB16K -a-general authorization=<redacted>"]);
  });

  it("is typed in dist/server.d.ts and absent from the browser entry", () => {
    expect(readFileSync(join(root, "dist/server.d.ts"), "utf8")).toMatch(/\bredactSecrets\b/);
    for (const file of ["dist/index.js", "dist/index.d.ts"]) {
      expect(readFileSync(join(root, file), "utf8")).not.toMatch(/\bredactSecrets\b/);
    }
  });
});
