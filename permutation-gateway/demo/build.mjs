#!/usr/bin/env node
// Build the walletless static demo: `node build.mjs [--out dist] [--live-url URL] [--turn 12] [--delay 3]`.
//
//   dist/                 a copy of permutation-server/web/ (the real page: HTML, JS modules, CSS, art, i18n, wasm)
//   dist/index.html       the one URL to share: opens frontier/ (the game page) at once
//   dist/frontier/demo-world.js   the sample world (screens/liveworld.mjs) + the fetch shim, bundled by esbuild
//   every frontier/*.html page loads demo-world.js before app.mjs
//
// No server, no chain, no wallet, no RPC: the bundle is plain static files and works under any path prefix.
import { build } from 'esbuild';
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
  turn: { type: 'string', default: '12' }, delay: { type: 'string', default: '3' }, 'land-ms': { type: 'string', default: '400' },
} });
const OUT = opt.out;
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
    b.onLoad({ filter: /.*/, namespace: 'demo' }, a => ({ loader: 'js', contents: a.path === 'demo:files' ? `export const FILES = ${JSON.stringify(embedded)};` : `export const DEMO = Object.freeze(${JSON.stringify(DEMO)});` }));
  },
};
const res = await build({
  entryPoints: [join(HERE, 'src', 'boot.mjs')],
  bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true, legalComments: 'none',
  outfile: join(OUT, 'frontier', 'demo-world.js'),
  inject: [join(HERE, 'src', 'shim-globals.mjs')],
  nodePaths: [join(HERE, 'node_modules')],
  plugins: [virtual], metafile: true, logLevel: 'warning',
});

// ------------------------------------------------------------------ the pages
const TAG = '<script type="module" src="demo-world.js"></script>\n';
const pages = (await readdir(join(OUT, 'frontier'))).filter(f => f.endsWith('.html'));
for (const f of pages) {
  const p = join(OUT, 'frontier', f);
  let s = await readFile(p, 'utf8');
  if (!/<script type="module" src="(?:app|agent-page)\.mjs"><\/script>/.test(s)) continue;
  s = s.replace(/<script type="module" src="(app|agent-page)\.mjs"><\/script>/, m => TAG + m);
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
await writeFile(join(OUT, '.nojekyll'), '');

let files = 0, bytes = 0;
async function walk(d) { for (const e of await readdir(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) await walk(p); else { files++; bytes += (await stat(p)).size; } } }
await walk(OUT);
const world = Object.values(res.metafile.outputs)[0].bytes;
console.log(`walletless demo → ${relative(process.cwd(), OUT) || '.'}: ${files} files, ${(bytes / 1048576).toFixed(1)} MiB (world bundle ${(world / 1024).toFixed(0)} KiB), ${Date.now() - t0} ms`);
console.log(`  turn ${DEMO.turnSecs} s, first toll after ${DEMO.delaySecs} s, live world link ${DEMO.liveUrl || '(none: pass --live-url https://… to show one)'}`);
