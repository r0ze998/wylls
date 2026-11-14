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
  assert.match(doc, /stopped by hand \(Ctrl-C\) about 17 minutes after it started,\s+at 4\/72\. It did not reach its limit\./);
  assert.ok(!/ended first, by its 45-minute limit/.test(doc));
  // (the second run, with the demo pace: one turn short at its limit, which was not extended; the page lagged the chain)
  assert.match(doc, /the chain's hold count was \*\*71\/72\*\*, one turn short, and the world ended by itself\./);
  assert.match(doc, /45-minute limit\n?\s*\(not extended\)/);
  assert.match(doc, /resolved every 29\.9 s\n?\s*on average/);
  assert.match(doc, /The page\n?\s*showed 65\/72 at that moment/);
  assert.match(doc, /on a demo world only, the keeper's next tick comes after 1 s while\n?\s*its steps land \(at most 8 in a row\); a natural world ticks as before\./);
  assert.ok(!/capture (has been|was) completed on screen|72\/72/.test(doc), 'no claim of a finished capture');
  // (the third run, ×30: no capture possible, the demo's forts were then the player's own nation's; what the demo does since)
  assert.match(doc, /both forts the demo opened then\n?\s*belonged to the player's own nation\./);
  assert.match(doc, /Since then the demo opens a fort of \*\*another\*\* nation/);
  // (the page's re-read: what was checked in a real browser (the play read), and what only by tests (the season read)
  assert.match(doc, /reads the latest state at once\n?\s*\(checked in a real browser, 2026-11-14, for the play read\)/);
  assert.match(doc, /that part is proven by tests only, not yet in a real browser\./);
  assert.match(doc, /offers 「最新の状態を読み直す」, which only reads\./);
});

test('the demo pace the guide states is the source\'s', () => {
  const kl = read('frontier-node/crates/itest/src/keeper_loop.rs'), bin = read('frontier-node/crates/itest/src/bin/localnet_natural_play.rs');
  assert.match(kl, /pub const DEMO_PACE: Pace = Pace::Demo \{ short: Duration::from_secs\(1\), burst: 8 \}/);
  assert.match(bin, /let pace = if demo\.is_some\(\) \{ itest::keeper_loop::DEMO_PACE \} else \{ itest::keeper_loop::Pace::Natural \};/);
});

test('stopping says the key goes only with the world\'s own tab, and other tabs are left alone', () => {
  assert.match(doc, /Ctrl-C alone does not remove the page's memory-only key from the browser;\n\s+closing the tab discards it\./);
  assert.match(doc, /Close only the tab you opened for this world and leave every other tab alone\./);
  assert.ok(!/its key is gone with the page/.test(doc));
});

test('no machine-local path, address or secret in the guide', () => {
  for (const bad of [/\/Users\//, /\/private\//, /\/tmp\//, /scratchpad/i, /[\w.+-]+@[\w-]+\.[\w.]+/, /BEGIN [A-Z ]*PRIVATE KEY/, /\b[1-9A-HJ-NP-Za-km-z]{43,44}\b/]) assert.ok(!bad.test(doc), String(bad));
});

test('two people in one world: TEST-ONLY, people on both sides, the nation shown on the page (not in a log), one stop for both', () => {
  assert.match(doc, /### \(3\) Two people in one world \(TEST-ONLY contest pair\)/);
  assert.match(doc, /--contest-pair contest-pair-v1/);
  assert.match(doc, /there is \*\*no automatic opponent\*\* and nothing here is an AI/);
  assert.match(doc, /presses 「二人の対戦の国と砦を確認」/);
  assert.match(doc, /The choice stays the\n?\s*player's: the page chooses nothing and sends nothing\./);
  assert.ok(!/runner\.out|second_player_nation/.test(doc), 'no log reading is asked of the player');
  assert.match(doc, /one Ctrl-C \(or the end of the world's time\) ends the world for \*\*both\*\*/);
});

test('ports and disk: the launcher\'s own rules, as the source has them', () => {
  const src = readFileSync(new URL('../src/frontier/local-play-launcher.mjs', import.meta.url), 'utf8');
  assert.match(src, /some\(p => p >= 41904 && p <= 41907\)\) throw fault\('InvalidPorts'\)/);
  assert.match(doc, /must avoid 41904–41907/);
  assert.match(src, /DISK_FLOOR = 5\.25 \* 1024 \*\* 3/); assert.match(src, /WORLD_OUTPUT_MAX = 128 \* 1024 \*\* 2/);
  assert.match(doc, /less than 5\.25 GiB free/); assert.match(doc, /records pass 128 MiB/);
  // the two Rust pins the guide names are the repository's
  const root = readFileSync(new URL('../../rust-toolchain.toml', import.meta.url), 'utf8'), node = readFileSync(new URL('../../frontier-node/rust-toolchain.toml', import.meta.url), 'utf8');
  assert.match(root, /channel = "1\.89\.0"/); assert.match(node, /channel = "1\.95\.0"/);
  assert.match(doc, /pins \*\*1\.89\.0\*\*/); assert.match(doc, /pins \*\*1\.95\.0\*\*/);
});
