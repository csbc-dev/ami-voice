// Side-effect entrypoint for `@csbc-dev/ami-voice/auto`.
//
// Hand-written JS (not compiled from TS) that imports the built ESM and
// registers `<ami-voice>` with default config. `package.json`'s
// `exports["./auto"]` resolves here; the relative `../../dist/index.js` path
// matches the published tarball layout (`src/auto/` + `dist/` are both shipped).
import { bootstrapAmiVoice } from "../../dist/index.js";

bootstrapAmiVoice();
