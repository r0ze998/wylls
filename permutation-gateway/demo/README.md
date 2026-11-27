# Walletless demo (static)

One URL, no wallet, no sign-up, no server, no chain: the real Wylls page plays a
sample world that runs inside the browser.

```sh
cd permutation-gateway/demo
npm ci --ignore-scripts
node build.mjs            # → dist/ (≈ 43 MiB on disk, ≈ 3,700 files; a cold load fetches ≈ 5.2 MiB, ≈ 2.0 MiB gzipped)
node check.mjs            # key-free checks of dist/ (CI runs these)
node serve.mjs --port 41751 --prefix /play/ --gzip   # try it: http://127.0.0.1:41751/play/ (--gzip: as static hosts send text)
node smoke.mjs --loop     # Playwright play-through (signs with the page's test Dev Wallet: manual key-tests job only)
```

`npm run build:demo` in `permutation-gateway/` does the install, build and check in one go.

## What is in `dist/`

- A copy of `permutation-server/web/` — the same HTML, JS modules, CSS, art, Japanese/English text and
  `frontier.wasm` rules kernel the live page uses.
- `index.html` — the URL to share; it opens `frontier/index.html` by a relative link.
- `frontier/app.bundle.mjs` + `frontier/chunk-*.mjs` — the page's ≈ 350 ES modules bundled by esbuild (minified,
  split at the page's own dynamic imports; entry `src/page-app.mjs`, which runs the real `app.mjs` unchanged). Every
  game page loads `app.bundle.mjs` instead of `app.mjs`: a cold load is ≈ 257 requests / 5.2 MiB (≈ 2.0 MiB gzipped)
  instead of ≈ 560 / 10 MiB. Each module's `import.meta.url` is rebased at build time to where the module lives, so
  its art, style sheets, wasm and seal workers resolve as before. The module files themselves stay in `dist/` (the
  seal workers and the council page load them). A test must not import `fstate.mjs` etc. by URL (that is a second,
  idle copy): the bundle's own instances are on `__wyllsDemo.modules` (`fstate.mjs`, `map/fmap.mjs`, `fgeo.mjs`,
  `../map.mjs`). Style sheets are minified in place.
- `frontier/demo-world.js` — `src/boot.mjs` bundled by esbuild (the page's modules it borrows — keys, codecs, clash
  arguments, clock — are marked side-effect free there, so it carries no text tables or UI: ≈ 550 KiB): the screenshot suite's sample world
  (`screens/liveworld.mjs`: M1 rules in the real herald/relay shapes, clashes by the same `frontier.wasm`, other
  nations by a seeded script) plus a `fetch` shim that answers the page's `/h/*`, `/gw/*` and `/coop/*` reads in
  the page. Any request to another origin is refused (`walletless demo: no network`). Each game page loads it
  before `app.mjs`.

It works from any static host and any path prefix (`/`, `/play/`, `/wylls/`). It does not work from `file://`
(Chrome refuses module scripts and SVG `<use>` there).

## The world

- `createLive({opening, territory, nations})`: the guest picks one of six nations and gets a first village at
  once; every nation has an AI village (`nations`), and they march into the guest's province and take land.
- Land is the sample world's arrival-control rule (`screens/territory.mjs`: a host that arrives alone on an open
  tile takes it for its nation), with the real V1 food upkeep (`landUpkeep`): the land logistics horizon card shows.
  It is not the live game's "take 1 tile" claim (Q-WD-4).
- A turn lasts 12 s (`--turn`), the first turn begins 3 s after load (`--delay`). Reloading starts a new world
  (same seed); the demo clears its own `ps-*` storage at load and keeps only the language.
- The pre-join screen says "Playable demo · no wallet needed / 体験版・ウォレット不要" next to "Choose a nation".
  A demo world does not show the test-world end turn (1,008) while it is ahead (join screen, standings card), and
  hides the map's "Records" button (a demo has no recorded wide world).
- The season record carries `sample.demo = {live}`: the page's tag says "Playable demo / 体験版" and, only when
  `--live-url https://…` is given, links the live world ("The live world / 本物の世界へ"). There is no default: the
  label promises a world to play, so it must not point at the source repository (Q-WD-1).
- Hosting: put the demo on an origin that never serves the real page. At load the demo clears every `ps-*` key of
  its origin's `localStorage` (keeping only `ps-lang`), so on a shared origin it would wipe the real page's saved
  wallet choice and in-game key.

## Build options

`node build.mjs [--out dist] [--live-url https://…] [--turn 12] [--delay 3] [--land-ms 400]`
