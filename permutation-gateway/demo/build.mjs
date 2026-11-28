#!/usr/bin/env node
// Build the walletless static demo: `node build.mjs [--out dist] [--live-url URL] [--base /wylls/] [--turn 12] [--delay 3]`.
//
//   dist/                 a copy of permutation-server/web/ (the real page: HTML, JS modules, CSS, art, i18n, wasm)
//   dist/index.html       the one URL to share: opens frontier/ (the game page) at once
//   dist/frontier/demo-world.js   the sample world (screens/liveworld.mjs) + the fetch shim, bundled by esbuild
//   dist/frontier/app.bundle.mjs  the page itself (app.mjs and its ~350 modules), bundled + split by esbuild (first-load size)
//   every game page loads demo-world.js, then app.bundle.mjs in place of app.mjs
//
// No server, no chain, no wallet, no RPC: the bundle is plain static files and works under any path prefix.
import { build, transform } from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile, readdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { parseArgs } from 'node:util';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const WEB = join(REPO, 'permutation-server', 'web');
const { values: opt } = parseArgs({ options: {
  out: { type: 'string', default: join(HERE, 'dist') },
  // (no default: the tag's "The live world" link appears only when a real, public live-world page is given — a link to the
  //  source repository under that label would mislead players; verify-pr301, Q-WD-1)
  'live-url': { type: 'string', default: '' },
  // the path the host serves dist/ under (GitHub Pages: /<repo>/). Only 404.html uses it: a host serves 404.html at
  // whatever missing URL was asked for, so its links must be absolute. Every other file stays relative (any prefix).
  base: { type: 'string', default: '' },
  turn: { type: 'string', default: '12' }, delay: { type: 'string', default: '3' }, 'land-ms': { type: 'string', default: '400' },
} });
const OUT = opt.out;
if (opt.base && !/^\/(?:[\w.-]+\/)*$/.test(opt.base)) throw new Error(`--base must start and end with "/" (got ${opt.base})`);
const DEMO = { turnSecs: Number(opt.turn), delaySecs: Number(opt.delay), landMs: Number(opt['land-ms']), liveUrl: opt['live-url'] };

// What the page never needs in the demo (server-only pages, the art sources, the docs).
const SKIP = [/\/art\/.*\.(?:blend|psd|kra|xcf|md)$/i, /\/README\.md$/i, /\.test\.mjs$/];
const t0 = Date.now();
await rm(OUT, { recursive: true, force: true });
await cp(WEB, OUT, { recursive: true, filter: src => !SKIP.some(re => re.test(src)) });

// ------------------------------------------------------------------ the world bundle
const embedded = {
  'presets.json': await readFile(join(REPO, 'frontier-abi', 'vectors', 'presets.json'), 'utf8'),
  'frontier-vectors.json': await readFile(join(REPO, 'permutation-gateway', 'test', 'frontier-vectors.json'), 'utf8'),
};
const virtual = {
  name: 'demo-virtual',
  setup(b) {
    const shims = { 'node:fs': 'shim-fs.mjs', 'node:path': 'shim-path.mjs', 'node:url': 'shim-url.mjs' };
    b.onResolve({ filter: /^node:(fs|path|url)$/ }, a => ({ path: join(HERE, 'src', shims[a.path]) }));
    b.onResolve({ filter: /^node:/ }, a => ({ errors: [{ text: `walletless demo: ${a.path} has no browser shim (imported by ${a.importer})` }] }));
    // the sample world's kernel reads the wasm with node:fs: the browser kernel is loaded before the world is made
    b.onResolve({ filter: /\/kernel\.mjs$/ }, a => (a.importer.includes(`${join('screens')}`) ? { path: join(HERE, 'src', 'kernel.mjs') } : undefined));
    b.onResolve({ filter: /^demo:(files|config)$/ }, a => ({ path: a.path, namespace: 'demo' }));
    // The world takes data helpers from the page's modules (keys, codecs, clash arguments, the clock), never its UI:
    // the page's modules are marked free of side effects here, so the world bundle keeps only what it calls and not
    // the text tables, effects and state that come along by import (the page has its own copies in its bundle).
    b.onResolve({ filter: /\.mjs$/ }, async a => {
      if (a.namespace !== 'file' || a.pluginData?.inner) return undefined;
      const r = await b.resolve(a.path, { resolveDir: a.resolveDir, kind: a.kind, importer: a.importer, pluginData: { inner: true } });
      return r.errors.length || !r.path.startsWith(WEB + '/') ? undefined : { ...r, sideEffects: false };
    });
    b.onLoad({ filter: /.*/, namespace: 'demo' }, a => ({ loader: 'js', contents: a.path === 'demo:files' ? `export const FILES = ${JSON.stringify(embedded)};` : `export const DEMO = Object.freeze(${JSON.stringify(DEMO)});` }));
  },
};
const res = await build({
  entryPoints: [join(HERE, 'src', 'boot.mjs')],
  bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true, legalComments: 'none', charset: 'utf8',
  outfile: join(OUT, 'frontier', 'demo-world.js'),
  inject: [join(HERE, 'src', 'shim-globals.mjs')],
  nodePaths: [join(HERE, 'node_modules')],
  plugins: [virtual], metafile: true, logLevel: 'warning',
});

// ------------------------------------------------------------------ the page bundle (first-load size)
// The real page is about 340 ES modules (≈ 7 MiB with their comments) fetched in an import waterfall. esbuild bundles
// them, minified and split at the page's own dynamic imports, into frontier/*.bundle.mjs + frontier/chunk-*.mjs. The
// module sources are not changed; the copies under dist/ stay (the seal workers and the council page load them).
// Every chunk sits in frontier/, so a module's `import.meta.url` (its art, css, wasm and worker URLs) is rebased
// from frontier/ to where the module was: `new URL('map/sprites.mjs', import.meta.url).href` for map/sprites.mjs.
const FRONTIER = join(WEB, 'frontier');
let configPatched = 0;
const CONFIG = join(FRONTIER, 'config.mjs'), DEV_LINE = 'const dev = LOOPBACK(host);', DEMO_DEV_LINE = 'const dev = true; // walletless demo build: the Dev Wallet on any host';
const rebase = {
  name: 'demo-import-meta',
  setup(b) {
    b.onLoad({ filter: /\.mjs$/ }, async a => {
      let src = await readFile(a.path, 'utf8');
      // The demo's guest signs with the page's test Dev Wallet (screens/world.mjs storageFor: its fixed sample seed and
      // `ps-wallet`); the page offers that wallet only when `cfg.dev`, which config.mjs reads from a loopback hostname.
      // GitHub Pages is not loopback, so there the page found no wallet and asked for one (fix-demo-wallet-p0): the demo
      // bundle's config says dev on every host. Only this bundle: the real page's config.mjs is unchanged.
      if (a.path === CONFIG) {
        if (!src.includes(DEV_LINE)) throw new Error(`walletless demo: ${DEV_LINE} is no longer in frontier/config.mjs (the demo must offer the Dev Wallet on any host)`);
        src = src.replace(DEV_LINE, DEMO_DEV_LINE); configPatched++;
        if (!src.includes('import.meta.url')) return { loader: 'js', contents: src };
      }
      if (!a.path.startsWith(WEB + '/') || !src.includes('import.meta.url')) return undefined;
      const rel = relative(FRONTIER, a.path).split('\\').join('/');
      return { loader: 'js', contents: src.replaceAll('import.meta.url', `new URL(${JSON.stringify(rel)}, import.meta.url).href`) };
    });
  },
};
const pageRes = await build({
  entryPoints: { 'app.bundle': join(HERE, 'src', 'page-app.mjs'), 'agent-page.bundle': join(FRONTIER, 'agent-page.mjs') },
  bundle: true, splitting: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true, legalComments: 'none', charset: 'utf8',
  outdir: join(OUT, 'frontier'), entryNames: '[name]', chunkNames: 'chunk-[hash]', outExtension: { '.js': '.mjs' },
  plugins: [rebase], metafile: true, logLevel: 'error',
});
if (configPatched !== 1) throw new Error(`walletless demo: frontier/config.mjs was bundled ${configPatched} times with the demo's Dev Wallet line (want once)`);
// the page's style sheets, minified in place (their url(…) stay relative to the sheet)
let cssIn = 0, cssOut = 0;
async function cssWalk(d) {
  for (const e of await readdir(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) await cssWalk(p);
    else if (e.name.endsWith('.css')) {
      const src = await readFile(p, 'utf8');
      const out = (await transform(src, { loader: 'css', minify: true, target: 'chrome110', legalComments: 'none' })).code;
      cssIn += src.length; cssOut += out.length; await writeFile(p, out);
    }
  }
}
await cssWalk(OUT);

// ------------------------------------------------------------------ the pages
const TAG = '<script type="module" src="demo-world.js"></script>\n';
const pages = (await readdir(join(OUT, 'frontier'))).filter(f => f.endsWith('.html'));
for (const f of pages) {
  const p = join(OUT, 'frontier', f);
  let s = await readFile(p, 'utf8');
  if (!/<script type="module" src="(?:app|agent-page)\.mjs"><\/script>/.test(s)) continue;
  s = s.replace(/<script type="module" src="(app|agent-page)\.mjs"><\/script>/, (m, name) => `${TAG}<script type="module" src="${name}.bundle.mjs"></script>`);
  await writeFile(p, s);
}
await writeFile(join(OUT, 'index.html'), `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta http-equiv="refresh" content="0; url=frontier/index.html">
<meta name="description" content="Wylls — a shared world of six nations. Playable demo in your browser: no wallet, no sign-up.">
<title>Wylls — playable demo</title>
<link rel="icon" href="frontier/art/ui/logo.svg" type="image/svg+xml">
</head>
<body style="background:#10221f;color:#e8dfc8;font:16px system-ui,sans-serif">
<p><a href="frontier/index.html" style="color:#e8dfc8">Wylls — open the playable demo</a></p>
</body>
</html>
`);
// (GitHub Pages) a missing path — an old or mistyped link — sends the player to the demo instead of a host error page
if (opt.base) await writeFile(join(OUT, '404.html'), `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta http-equiv="refresh" content="0; url=${opt.base}">
<meta name="robots" content="noindex">
<title>Wylls — playable demo</title>
</head>
<body style="background:#10221f;color:#e8dfc8;font:16px system-ui,sans-serif">
<p><a href="${opt.base}" style="color:#e8dfc8">Wylls — open the playable demo</a></p>
</body>
</html>
`);
// (static hosts that run Jekyll would drop files and folders whose names start with "_")
await writeFile(join(OUT, '.nojekyll'), '');
// (DEMO_META=<file>: write both esbuild metafiles there, for size analysis)
if (process.env.DEMO_META) await writeFile(process.env.DEMO_META, JSON.stringify({ world: res.metafile, page: pageRes.metafile }));

let files = 0, bytes = 0;
async function walk(d) { for (const e of await readdir(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) await walk(p); else { files++; bytes += (await stat(p)).size; } } }
await walk(OUT);
const world = Object.values(res.metafile.outputs)[0].bytes;
const pageOut = Object.values(pageRes.metafile.outputs).reduce((n, o) => n + o.bytes, 0), pageIn = Object.keys(pageRes.metafile.inputs).length;
console.log(`walletless demo → ${relative(process.cwd(), OUT) || '.'}: ${files} files, ${(bytes / 1048576).toFixed(1)} MiB (world bundle ${(world / 1024).toFixed(0)} KiB), ${Date.now() - t0} ms`);
console.log(`  page bundle: ${pageIn} modules → ${Object.keys(pageRes.metafile.outputs).length} files, ${(pageOut / 1024).toFixed(0)} KiB; css ${(cssIn / 1024).toFixed(0)} → ${(cssOut / 1024).toFixed(0)} KiB`);
console.log(`  base ${opt.base ? `${opt.base} (404.html sends missing paths there)` : '(none: no 404.html; pass --base /wylls/ for GitHub Pages)'}`);
console.log(`  turn ${DEMO.turnSecs} s, first toll after ${DEMO.delaySecs} s, live world link ${DEMO.liveUrl || '(none: pass --live-url https://… to show one)'}`);
