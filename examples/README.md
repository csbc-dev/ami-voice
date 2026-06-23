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

Build the package once (the examples import the built `dist/`):

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

Each build example links the package via `"@csbc-dev/ami-voice": "file:../.."`, so it resolves the
local `dist/` you built in the prerequisites step.

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
`@csbc-dev/ami-voice/auto/remoteEnv` side-effect entry, which opts into remote/relay mode and reads
the control URL from a global hook set inline first:

```html
<script>globalThis.AMIVOICE_REMOTE_CORE_URL = `ws://${location.host}/`;</script>
<script type="module" src="/vendor/ami-voice/src/auto/remoteEnv.js"></script>
```

`<ami-voice>` is served from this server because the package is **unpublished pre-release**, so
`esm.run`/jsDelivr can't serve it yet. **After `npm publish`** both pages collapse to a CDN-only
setup — point the entry at `https://esm.run/@csbc-dev/ami-voice/auto/remoteEnv` and drop the
`/vendor` mount and the `@wc-bindable/*` importmap entries (esm.run resolves those deps itself).
Each page's `<head>` marks the exact lines to change.

## Layout

```
examples/
├─ shared/            ← the ONE server every client uses
│  ├─ server.mjs        relay WS + POST /api/recognize + static hosting (+ offline fake)
│  ├─ fakeAmiVoice.mjs  in-process fake AmiVoice (realtime + file)
│  └─ styles.css        shared styling
├─ react/  vue/  vanilla/        Vite apps (file:../.. link to the package)
└─ wcstack-state/  wcstack-signals/   buildless HTML, served by shared/
```

> Note: `examples/relayServer.mjs` (the package's `npm run example`) is the **minimal** relay-only
> demo. `examples/shared/server.mjs` here is the fuller server these five clients share.
