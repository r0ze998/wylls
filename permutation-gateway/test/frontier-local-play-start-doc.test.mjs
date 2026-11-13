// docs/frontier/LOCAL-PLAY-START.md stays true to the sources: every launcher option it uses is one the launcher
// accepts, every binary it builds is declared with the features it names, the two modes stay apart, the unfinished
// on-screen capture is said, and no machine-local path or address is in it. Nothing is started here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = rel => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
const doc = read('docs/frontier/LOCAL-PLAY-START.md');
const launcher = read('permutation-gateway/src/frontier/local-play-launcher.mjs');

test('every launcher option in the guide is one the launcher accepts', () => {
  const keys = new Set(/const keys = new Set\(\[([^\]]+)\]\)/.exec(launcher)[1].match(/'([a-z-]+)'/g).map(s => s.slice(1, -1)));
  const starts = doc.split('```bash').slice(1).map(b => b.split('```')[0]).filter(b => b.includes('local-play-launcher.mjs') || b.trim().startsWith('--capture-demo'));
  assert.equal(starts.length, 2, 'the natural start and the demo words');
  const used = new Set(starts.join(' ').match(/--[a-z-]+/g).map(s => s.slice(2)));
  for (const k of used) assert.ok(keys.has(k), `--${k}`);
  for (const k of ['root', 'data', 'runner', 'herald', 'depart', 'preview', 'resident', 'artifact', 'artifact-sha', 'world-preset', 'natural-runner', 'economy', 'march-trial']) assert.ok(used.has(k), `the natural start names --${k}`);
  assert.match(doc, /--capture-demo capture-demo-v1 --demo-scale 20/);
  assert.match(launcher, /CAPTURE_DEMO_MODE = 'capture-demo-v1'/);
});

test('every binary the guide builds is declared, with the features it names', () => {
  const itest = read('frontier-node/crates/itest/Cargo.toml'), keeper = read('frontier-node/crates/keeper/Cargo.toml'), herald = read('frontier-node/crates/herald/Cargo.toml');
  const bin = (toml, name) => new RegExp(`name = "${name}"\\npath = "[^"]+"(\\nrequired-features = \\[([^\\]]*)\\])?`).exec(toml);
  for (const n of ['localnet-natural-play', 'localnet-expedition-play']) assert.match(bin(itest, n)?.[2] ?? '', /"localnet-expedition-play"/, n);
  assert.ok(/name = "frontier-herald"/.test(herald), 'the herald');
  for (const [n, f] of [['frontier-experimental-expedition-depart-prepare', 'expedition-dispatch-experimental'], ['frontier-experimental-expedition-prepare', 'expedition-dispatch-experimental'], ['frontier-original-expedition-preview', 'wide-world-experimental']]) assert.equal(bin(keeper, n)?.[2], `"${f}"`, n);
  assert.match(keeper, /expedition-dispatch-experimental = \["wide-world-experimental",/, 'one keeper build covers all three tools');
  assert.match(read('scripts/build-frontier-localnet-conquest-sbf.sh'), /scripts\/build-frontier\.sh --features localnet-conquest-sbf/);
  // (the herald feature the guide says these modes do not need: passed only off the natural preset)
  assert.match(launcher, /\.\.\.\(natural \? \[\] : \['--local-play-metadata'/);
});

test('the two modes stay apart, and the unfinished on-screen capture is said', () => {
  assert.match(doc, /\(1\) Natural world/); assert.match(doc, /\(2\) Capture demo \(TEST-ONLY\)/);
  assert.match(doc, /The 72-turn capture has NOT been completed on screen\./);
  assert.match(doc, /4\/72/);
  assert.match(doc, /has \*\*not\*\* been run end to end yet/);
  // (the demo world was stopped by hand at 4/72; it did not run out its limit)
  assert.match(doc, /stopped by hand \(Ctrl-C\) about 17 minutes after it started, at 4\/72\. It did not reach its limit\./);
  assert.ok(!/ended first, by its 45-minute limit/.test(doc));
});

test('stopping says the key goes only with the world\'s own tab, and other tabs are left alone', () => {
  assert.match(doc, /Ctrl-C alone does not remove the page's memory-only key from the browser;\n\s+closing the tab discards it\./);
  assert.match(doc, /Close only the tab you opened for this world and leave every other tab alone\./);
  assert.ok(!/its key is gone with the page/.test(doc));
});

test('no machine-local path, address or secret in the guide', () => {
  for (const bad of [/\/Users\//, /\/private\//, /\/tmp\//, /scratchpad/i, /[\w.+-]+@[\w-]+\.[\w.]+/, /BEGIN [A-Z ]*PRIVATE KEY/, /\b[1-9A-HJ-NP-Za-km-z]{43,44}\b/]) assert.ok(!bad.test(doc), String(bad));
});
