// local-perf (2026-11-21): a launcher that runs a world for a long time. The keeper question reads the runner's lines
// incrementally (runnerFollower), and the guard checks a world's life on every tick, never behind its output walk.
// Temp files only; no port is bound.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runnerFollower, keeperSummary, OUTPUT_EVERY_MS, GUARD_STALL_MS } from '../src/frontier/local-play-launcher.mjs';

const KEEPER = 'frontier-local-play-keeper-v1';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wylls-long-run-'));

test('runnerFollower: the latest line of a schema, read only from where the last read ended', async () => {
  const dir = tmp(), file = path.join(dir, 'runner.out');
  fs.writeFileSync(file, JSON.stringify({ schema: 'meta', program: 'x' }) + '\n' + JSON.stringify({ schema: KEEPER, running: true, bell: 3 }) + '\n');
  const read = runnerFollower(dir, [KEEPER]);
  assert.equal((await read()).get(KEEPER).bell, 3);
  // a line still being written is not one yet; once whole, it is the latest
  fs.appendFileSync(file, '{"schema":"' + KEEPER + '","running":true,"be');
  assert.equal((await read()).get(KEEPER).bell, 3);
  fs.appendFileSync(file, 'll":4}\n' + JSON.stringify({ schema: 'frontier-localnet-wide-land-v1', ring: 129 }) + '\n');
  assert.equal((await read()).get(KEEPER).bell, 4);
  assert.deepEqual(keeperSummary([...(await read()).values()]), { state: 'running', resident: null, resolvedNext: null, bell: 4 });
  // a file that became shorter (another start) is read again from its start
  fs.writeFileSync(file, JSON.stringify({ schema: KEEPER, running: false, stopped: 'x', bell: 1 }) + '\n');
  assert.equal((await read()).get(KEEPER).bell, 1);
});

test('runnerFollower: a long file in steps, a character split between two steps, concurrent questions share one read', async () => {
  const dir = tmp(), file = path.join(dir, 'runner.out');
  const filler = JSON.stringify({ schema: 'frontier-localnet-wide-land-v1', note: 'é'.repeat(300) }) + '\n';
  const lines = [];
  for (let i = 0; i < 2000; i++) lines.push(filler);
  lines.push(JSON.stringify({ schema: KEEPER, running: true, bell: 77, word: '村'.repeat(50) }) + '\n');
  for (let i = 0; i < 500; i++) lines.push(filler);
  fs.writeFileSync(file, lines.join(''));
  assert.ok(fs.statSync(file).size > 4 * 64 * 1024, 'more than a few steps');
  const read = runnerFollower(dir, [KEEPER]);
  const [a, b] = await Promise.all([read(), read()]);
  assert.equal(a.get(KEEPER).bell, 77); assert.equal(a.get(KEEPER).word, '村'.repeat(50)); assert.deepEqual(a, b);
  assert.equal(keeperSummary([...(await read()).values()]).bell, 77);
  // no keeper line at all (a wide world's runner writes none): no summary, as before
  const dir2 = tmp(); fs.writeFileSync(path.join(dir2, 'runner.out'), filler.repeat(10));
  assert.equal(keeperSummary([...(await runnerFollower(dir2, [KEEPER])()).values()]), null);
});

test('the guard: the life first on every tick, the output walk apart and bounded, a stalled measurement given up', () => {
  const src = fs.readFileSync(new URL('../src/frontier/local-play-launcher.mjs', import.meta.url), 'utf8');
  const guard = src.slice(src.indexOf('timer = setInterval(async () => {'), src.indexOf('}, limit.everyMs); timer.unref();'));
  assert.ok(guard.length > 0);
  const ttl = guard.indexOf("if (Date.now() > expiresAt) { stop('ttl'); return; }"), firstAwait = guard.indexOf('await ');
  assert.ok(ttl > 0 && ttl < firstAwait, 'the life is checked before anything is awaited');
  assert.ok(guard.indexOf('if (checking) {') > ttl, 'a measurement under way never holds the life');
  assert.match(guard, /Date\.now\(\) - outputAt >= \(limit\.outputEveryMs \?\? OUTPUT_EVERY_MS\)/);
  assert.match(guard, /launcher_guard: 'stalled'/);
  assert.ok(OUTPUT_EVERY_MS >= 1000 && GUARD_STALL_MS > OUTPUT_EVERY_MS);
  assert.ok(src.includes('const keeperLines = runnerFollower(dir, [KEEPER_LINE]);'), 'the keeper question reads incrementally');
});
