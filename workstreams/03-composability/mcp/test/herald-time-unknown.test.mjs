// WRITTEN, NOT RUN (2026-11-17, under an execution pause): no part of this file has been executed. Run it only with its
// own approval, through the repository's key-free guard.
//
// The herald's read time (`latestUnix`) is the clock ③ computes the village's stores at (src/game.mjs season/view).
// The herald serves 0 until it has folded a transaction with a block time (frontier-node herald: fold.rs State
// default, local_play.rs seed sets accounts and slot only; findex archive.rs block_time unwrap_or(0)). So:
//   T1 0, absent, negative, a fraction or not a number → GameError Unknown (retryable, reason HeraldTimeUnknown); the
//      stores are never computed at 0
//   T2 a positive whole time is used as before
//   T3 the test worlds give a positive time, so their reads are unchanged
//   T4 the providers this rests on still read so (source text of the herald and findex)
// KEY-FREE: imports node:test, node:assert/strict and node:fs; every file is read as text (game.mjs imports the web
// client, so it is not imported here). Nothing is served, bound or fetched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = rel => readFileSync(new URL(rel, import.meta.url), 'utf8');
const game = read('../src/game.mjs');
const season = game.slice(game.indexOf('  async season() {'), game.indexOf('\n  }\n', game.indexOf('  async season() {')));

test('T1 no read time is Unknown, never 0', () => {
  assert.match(season, /const now = Number\(r\.record\.latestUnix\);/);
  assert.match(season, /if \(!Number\.isSafeInteger\(now\) \|\| now <= 0\) throw new GameError\('Unknown', [^\n]*\{ retryable: true, reason: 'HeraldTimeUnknown' \}\);/);
  assert.doesNotMatch(season, /latestUnix \?\? 0/);
  // what the guard lets through, by the same rule (no import of game.mjs)
  const ok = v => { const n = Number(v); return Number.isSafeInteger(n) && n > 0; };
  assert.deepEqual([0, undefined, null, -5, 1.5, 'x', '0'].map(ok), [false, false, false, false, false, false, false]);
});

test('T2 a real time is used as before', () => {
  assert.match(season, /return \{ record: r\.record, season: r\.season, now \};/);
  const ok = v => { const n = Number(v); return Number.isSafeInteger(n) && n > 0; };
  assert.deepEqual([1_800_003_600, '1800003600'].map(ok), [true, true]);
});

test('T3 the test worlds read a positive time', () => {
  assert.match(read('./fixture.mjs'), /latestUnix: NOW \}\)/);
  assert.match(read('./keyfree/harness.mjs'), /latestUnix: NOW \}\)/);
  assert.match(read('./keyfree/harness.mjs'), /export const NOW = GENESIS \+ 3_600;/);
});

test('T4 the providers', () => {
  const root = '../../../../';
  assert.match(read(`${root}frontier-node/crates/herald/src/views.rs`), /"latestUnix": f\.live\.map_or\(f\.st\.last_time, \|l\| l\.1\),/);
  assert.match(read(`${root}frontier-node/crates/herald/src/fold.rs`), /self\.st\.last_time = self\.st\.last_time\.max\(tx\.block_time\);/);
  assert.match(read(`${root}frontier-node/crates/findex/src/archive.rs`), /block_time: v\.get\("block_time"\)\.and_then\(\|x\| x\.as_i64\(\)\)\.unwrap_or\(0\),/);
});
