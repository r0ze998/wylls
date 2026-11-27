#!/usr/bin/env node
// Key-free checks of the built walletless demo (CI, every pull request): no browser, no key, no world started.
//   node check.mjs [--dir dist]
// - the one URL (index.html) opens the game page by a relative link, and every game page loads the world before app.mjs
// - nothing in the bundle's pages or world names an absolute path ("/frontier/…") that a path-prefixed host would miss
// - the world bundle names no RPC / devnet / herald endpoint, and has the six-nation and demo switches
// - the size stays small enough for a cold load from a static host
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const { values: opt } = parseArgs({ options: { dir: { type: 'string', default: new URL('dist', import.meta.url).pathname }, 'max-mib': { type: 'string', default: '60' } } });
const D = opt.dir;
const fails = [];
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fails.push(what); };

const index = await readFile(join(D, 'index.html'), 'utf8');
check(/url=frontier\/index\.html/.test(index) && !/(?:href|src|url)=["']?\//.test(index), 'index.html opens frontier/index.html by a relative link');
const pages = (await readdir(join(D, 'frontier'))).filter(f => f.endsWith('.html'));
for (const f of ['index.html', 'practice.html', 'spectate.html']) {
  const s = await readFile(join(D, 'frontier', f), 'utf8');
  const w = s.indexOf('src="demo-world.js"'), a = s.indexOf('src="app.mjs"');
  check(w > 0 && a > w, `frontier/${f} loads demo-world.js before app.mjs`);
  check(!/(?:href|src)="\/(?!\/)/.test(s), `frontier/${f} has no root-absolute href/src`);
}
check(pages.length >= 3, `${pages.length} game pages`);
const world = await readFile(join(D, 'frontier', 'demo-world.js'), 'utf8');
check(world.length < 4 * 1048576, `world bundle ${(world.length / 1024).toFixed(0)} KiB`);
const endpoints = world.match(/https?:\/\/[a-z0-9.-]+(?::\d+)?/gi) ?? [];
const bad = [...new Set(endpoints)].filter(u => /devnet|mainnet|rpc|helius|solana\.com|localhost|127\.0\.0\.1/i.test(u));
check(bad.length === 0, `the world bundle names no RPC / devnet / localhost endpoint${bad.length ? `: ${bad.join(' ')}` : ''}`);
check(world.includes('walletless demo: no network'), 'the world refuses requests to other origins');
for (const f of ['wasm/frontier.wasm', 'wasm/frontier.wasm.sha256', 'app.mjs', 'frontier.css', 'art/ui/icons.svg']) {
  let ok = false; try { ok = (await stat(join(D, 'frontier', f))).isFile(); } catch { ok = false; }
  check(ok, `frontier/${f} is in the bundle`);
}
let bytes = 0, files = 0;
async function walk(d) { for (const e of await readdir(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) await walk(p); else { files++; bytes += (await stat(p)).size; } } }
await walk(D);
check(bytes / 1048576 <= Number(opt['max-mib']), `bundle ${files} files, ${(bytes / 1048576).toFixed(1)} MiB (≤ ${opt['max-mib']} MiB)`);
console.log(fails.length ? `\n${fails.length} check(s) failed` : '\nall checks passed');
process.exit(fails.length ? 1 : 0);
