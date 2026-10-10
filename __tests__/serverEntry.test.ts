import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as server from "../src/server";
import * as browser from "../src/index";
import { redactSecrets } from "../src/redact";

// A path, not a `URL`: under happy-dom the global `URL` is not one `node:fs` accepts.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (file: string): Record<string, any> => JSON.parse(readFileSync(join(root, file), "utf8"));

/**
 * `redactSecrets` is public on `@csbc-dev/ami-voice/server` only (SPEC §14),
 * for an application's own logs. The built package itself (dist/ through the
 * `exports` map, resolved by Node) is checked in
 * tests/integration/packageExports.test.ts.
 */
describe("redactSecrets on the /server entry", () => {
  it("the /server barrel re-exports the package's own redactSecrets", () => {
    expect(server.redactSecrets).toBe(redactSecrets);
    expect(server.redactSecrets("s LSB16K -a-general authorization=K")).toBe("s LSB16K -a-general authorization=<redacted>");
  });

  it("the browser barrel does not export it", () => {
    expect("redactSecrets" in browser).toBe(false);
  });

  it("package.json maps ./server to what tsc emits for src/server.ts", () => {
    const pkg = readJson("package.json");
    expect(pkg.exports["./server"]).toStrictEqual({ types: "./dist/server.d.ts", default: "./dist/server.js" });
    expect(readJson("tsconfig.json").compilerOptions).toMatchObject({ rootDir: "src", outDir: "dist", declaration: true });
    expect(pkg.files).toContain("dist");
  });
});
