# Walletless demo (static)

One URL, no wallet, no sign-up, no server, no chain: the real Wylls page plays a
sample world that runs inside the browser.

```sh
cd permutation-gateway/demo
npm ci --ignore-scripts
node build.mjs            # → dist/ (≈ 41 MiB, ≈ 3,700 files)
node check.mjs            # key-free checks of dist/ (CI runs these)
node serve.mjs --port 41751 --prefix /play/   # try it: http://127.0.0.1:41751/play/
node smoke.mjs --loop     # Playwright play-through (signs with the page's test Dev Wallet: manual key-tests job only)
```

`npm run build:demo` in `permutation-gateway/` does the install, build and check in one go.

## What is in `dist/`

- A copy of `permutation-server/web/` — the same HTML, JS modules, CSS, art, Japanese/English text and
  `frontier.wasm` rules kernel the live page uses.
- `index.html` — the URL to share; it opens `frontier/index.html` by a relative link.
- `frontier/demo-world.js` — `src/boot.mjs` bundled by esbuild: the screenshot suite's sample world
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
  tile takes it for its nation). It is not the live game's tile claim with food upkeep; the land logistics
  horizon card therefore does not appear in the demo yet.
- A turn lasts 12 s (`--turn`), the first turn begins 3 s after load (`--delay`). Reloading starts a new world
  (same seed); the demo clears its own `ps-*` storage at load and keeps only the language.
- The season record carries `sample.demo = {live}`: the page's tag says "Playable demo / 体験版" and links the
  live world (`--live-url`, default the GitHub repository).

## Build options

`node build.mjs [--out dist] [--live-url https://…] [--turn 12] [--delay 3] [--land-ms 400]`
