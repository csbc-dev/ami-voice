# `@csbc-dev/ami-voice` examples

Five front-end integrations of the **same** `<ami-voice>` element, all talking to **one shared
server**, each demonstrating **both** recognition scenarios:

| Client | Binding | File recognition | Realtime (relay) | Build |
|---|---|---|---|---|
| [`react/`](react/) | `@wc-bindable/react` (`useWcBindable`) | ✅ | ✅ | Vite (`npm run build`) |
| [`vue/`](vue/) | `@wc-bindable/vue` (`useWcBindable`) | ✅ | ✅ | Vite (`npm run build`) |
| [`vanilla/`](vanilla/) | `@wc-bindable/core` (`bind`) | ✅ | ✅ | Vite (`npm run build`) |
| [`wcstack-state/`](wcstack-state/) | `@wcstack/state` (`data-wcs`) | ✅ | ✅ | buildless |
| [`wcstack-signals/`](wcstack-signals/) | `@wcstack/signals` (`bindNode`) | ✅ | ✅ | buildless |

The recognition surface is identical everywhere — `transcript`, `interim`, `segments`,
`recognizing`, `level`, `error`, and `start()` / `stop()` / `reset()`. Only the binding glue differs.

## The two scenarios (and why they differ)

- **Realtime → relay (CSBC Case C).** The browser runs the mic data plane and binds the
  `<ami-voice transport="relay">` element; audio streams **browser → server → AmiVoice** over a
  separate binary channel while state + commands ride the `@wc-bindable/remote` JSON control
  channel. The APPKEY never reaches the browser.
- **File → HTTP (CSBC Case B1).** The `<ami-voice>` element exposes only `start/stop/abort/reset`,
  and the remote control wire is JSON-only, so file **bytes can't ride the element**. Each client
  `POST`s the audio file to the shared server's `/api/recognize`, which runs
  `AmiVoiceProvider.recognizeFile` server-side and returns normalized JSON. The APPKEY stays on the
  server here too.

## Prerequisites

The clients pull `@csbc-dev/ami-voice` from the public registry/CDN now (buildless pages from
esm.run, the Vite apps from npm), so they need no local build. The **shared server** still imports
the built `dist/server.js`, so build the package once before starting it:

```bash
# from the repository root
npm install
npm run build
```

## 1. Start the shared server

```bash
# from the repository root
node examples/shared/server.mjs            # http://localhost:3100
# or, with a real key (real recognition for BOTH scenarios):
AMIVOICE_APPKEY=your-key node examples/shared/server.mjs
```

Without `AMIVOICE_APPKEY` it runs **fully offline** against an in-process fake AmiVoice (canned
interim/final results), so you can click through every example with no credentials. The one port
hosts the realtime relay WS (`ws://localhost:3100/`), the file endpoint
(`POST /api/recognize`), and the two buildless pages.

> ⚠ **Auth is a seam, not a default.** `examples/shared/server.mjs` accepts every peer so it runs
> offline. A real deployment must authenticate the peer before the relay handlers — see the
> SECURITY SEAM block in that file and [SPEC.md §14](../SPEC.md).

## 2. Run a client

**Buildless** (`wcstack-state`, `wcstack-signals`) — served by the shared server, just open:

- <http://localhost:3100/wcstack-state/>
- <http://localhost:3100/wcstack-signals/>

**Build** (`react`, `vue`, `vanilla`) — each is a standalone Vite app. The shared server enables
CORS, so the dev server (its own port) talks to `localhost:3100` directly:

```bash
cd examples/react      # or examples/vue, examples/vanilla
npm install
npm run dev            # open the printed URL (e.g. http://localhost:5173)
# npm run build        # production build into dist/  (this is the "build OK" check)
```

Each build example installs the published `@csbc-dev/ami-voice` from npm (`"latest"` in its
`package.json`), so `npm install` pulls it like any other dependency — no link to the repo root.

## How the wiring works per client

- **React / Vue** — `useWcBindable()` reads `<ami-voice>.constructor.wcBindable`, syncs every
  property into framework state, and an element ref calls the commands.
- **Vanilla** — `bind(el, (name, value) => …)` from `@wc-bindable/core`: one callback drives the
  DOM; buttons call `el.start()` / `el.stop()`.
- **`@wcstack/state`** — `data-wcs="...: rec"` spreads the element's properties into a state slot;
  `command.start: $command.…` tokens drive the commands. Pure HTML, no JS glue.
- **`@wcstack/signals`** — `bindNode(el)` turns the properties into read-only signals and
  `bound.command("start")` invokes commands; `h()`/`render()` draw the DOM. (Its core + `/dom`
  entries are served locally so they share one reactive core.)

### Buildless registration (no hand-written bootstrap)

The two buildless pages register `<ami-voice>` with **no `bootstrapAmiVoice()` call** — just the
`@csbc-dev/ami-voice/auto/remoteEnv` side-effect entry loaded from esm.run, which opts into
remote/relay mode and reads the control URL from a global hook set inline first:

```html
<script>globalThis.AMIVOICE_REMOTE_CORE_URL = `ws://${location.host}/`;</script>
<script type="module" src="https://esm.run/@csbc-dev/ami-voice/auto/remoteEnv"></script>
```

esm.run resolves the package's own `@wc-bindable/*` deps, so the pages need no importmap for them —
`wcstack-state` has none, and `wcstack-signals` keeps a tiny importmap only for its locally-served
`@wcstack/signals` core (that one core must stay a single instance, so it can't come from a CDN).
The shared server therefore no longer serves `<ami-voice>` itself; only `/vendor/signals/` remains.

## Layout

```
examples/
├─ shared/            ← the ONE server every client uses
│  ├─ server.mjs        relay WS + POST /api/recognize + static hosting (+ offline fake)
│  ├─ fakeAmiVoice.mjs  in-process fake AmiVoice (realtime + file)
│  └─ styles.css        shared styling
├─ react/  vue/  vanilla/        Vite apps (install @csbc-dev/ami-voice from npm)
└─ wcstack-state/  wcstack-signals/   buildless HTML, served by shared/
```

> Note: `examples/relayServer.mjs` (the package's `npm run example`) is the **minimal** relay-only
> demo. `examples/shared/server.mjs` here is the fuller server these five clients share.

## Bonus: wire speech into an LLM — [`voice-llm/`](voice-llm/)

[`voice-llm/`](voice-llm/) is a standalone demo that pairs `<ami-voice>` with the sibling
package `@csbc-dev/ai-agent` (`<ai-agent>`): mic → transcript → LLM summary, with **binding
only**. Both Cores run server-side (one process holds both the AmiVoice APPKEY and the LLM key);
the browser sees only state. It has its own combined server and runs fully offline with no
credentials. See [`voice-llm/README.md`](voice-llm/README.md).
