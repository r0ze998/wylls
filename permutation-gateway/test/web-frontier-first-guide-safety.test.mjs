// The guard of first-guide-villages.screen.mjs (screens/first-guide-safety.mjs) with FAKE handles, a FAKE disk and FAKE
// timers (2026-11-16): fail-closed reads, a handle that arrives after a trip closed at once, each handle closed once, a
// failed close reported. Nothing real is started, read or written: the module imports nothing; no browser, server,
// file, process, timer, key or network is touched here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createGuard, walkFiles, totalSize, scanStorage, GONE } from '../screens/first-guide-safety.mjs';

const err = code => Object.assign(new Error(code), { code });
const GiB = 2 ** 30, MiB = 2 ** 20;
const fakeTimers = () => { const t = { started: 0, cleared: 0, fn: null, setInterval: fn => { t.started++; t.fn = fn; return { id: 1 }; }, clearInterval: () => { t.cleared++; } }; return t; };
const handle = (name, log, { fails = false } = {}) => ({ name, closed: 0, async close() { this.closed++; log.push(name); if (fails) throw new Error(`${name} close failed`); } });
const guardWith = (over = {}) => {
  const timers = fakeTimers();
  const g = createGuard({ freeBytes: () => 30 * GiB, profileBytes: () => 5 * MiB, freeMin: 22 * GiB, profileMax: 300 * MiB, every: 1000, timers, ...over });
  return { g, timers };
};

test('the module imports nothing (pure)', () => {
  const src = readFileSync(new URL('../screens/first-guide-safety.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /^\s*import\s/m);
  assert.doesNotMatch(src, /\bawait import\(|require\(/);
});

test('readings within the limits: no trip; the peaks are kept', () => {
  const { g } = guardWith();
  g.sample();
  assert.equal(g.state().tripped, null);
  assert.deepEqual(g.state().peak, { profile: 5 * MiB, freeLow: 30 * GiB });
});

for (const [why, over, re] of [
  ['free space unreadable (throws)', { freeBytes: () => { throw err('EIO'); } }, /free space unreadable: EIO/],
  ['free space not a number', { freeBytes: () => NaN }, /free space unreadable/],
  ['free space infinite', { freeBytes: () => Infinity }, /free space unreadable/],
  ['profile size unreadable', { profileBytes: () => { throw err('EACCES'); } }, /profile size unreadable: EACCES/],
  ['free space at the floor', { freeBytes: () => 22 * GiB }, /≤ 22 GiB/],
  ['profile over the limit', { profileBytes: () => 301 * MiB }, /> 300 MiB/],
]) test(`fail-closed: ${why} trips and closes this test's handles`, async () => {
  const { g } = guardWith(over), log = [];
  await g.adopt('srv', handle('srv', log)); await g.adopt('browser', handle('browser', log));
  g.sample(); await g.closeAll();
  assert.match(g.state().tripped, re);
  assert.deepEqual(log, ['browser', 'srv'], 'both closed, browser before server');
  assert.deepEqual(g.state().open, []);
});

test('a browser whose launch was still running when the guard tripped: closed at once, the adoption throws, nothing left', async () => {
  const { g } = guardWith({ freeBytes: () => 1 * GiB }), log = [];
  let resolve; const launching = new Promise(r => { resolve = r; });
  const adopting = g.adopt('browser', launching);
  g.sample(); await g.closeAll();   // trips while the launch is pending
  const late = handle('browser', log);
  resolve(late);
  await assert.rejects(adopting, /arrived after the guard closed/);
  assert.equal(late.closed, 1);
  assert.deepEqual(g.state().open, []);
});

test('each handle closed once, whoever asks first; context, then browser, then server; the timer stopped', async () => {
  const { g, timers } = guardWith(), log = [];
  g.start(); g.start();
  assert.equal(timers.started, 1);
  await g.adopt('srv', handle('srv', log)); await g.adopt('browser', handle('browser', log)); await g.adopt('ctx', handle('ctx', log));
  await Promise.all([g.closeAll(), g.closeAll()]); await g.closeAll();
  assert.deepEqual(log, ['ctx', 'browser', 'srv']);
  assert.equal(timers.cleared, 1);
  assert.equal(g.state().closed, true);
  await assert.rejects(g.adopt('ctx', handle('ctx2', log)), /arrived after the guard closed/, 'nothing is adopted after a close');
  g.sample(); assert.equal(g.state().tripped, null, 'no sampling after a close');
});

test('a close that fails is reported, not taken as success', async () => {
  const { g } = guardWith(), log = [];
  await g.adopt('browser', handle('browser', log, { fails: true }));
  await g.closeAll();
  assert.deepEqual(g.state().closeErrors, ['browser: browser close failed']);
});

test('a close that resolves WITH an Error (the fixture server\'s close) is reported too', async () => {
  const { g } = guardWith();
  await g.adopt('srv', { async close() { return new Error('ERR_SERVER_NOT_RUNNING'); } });
  await g.closeAll();
  assert.deepEqual(g.state().closeErrors, ['srv: ERR_SERVER_NOT_RUNNING']);
});

test('a handle adopted twice is refused', async () => {
  const { g } = guardWith(), log = [];
  await g.adopt('srv', handle('srv', log));
  await assert.rejects(g.adopt('srv', handle('srv2', log)), /adopted twice/);
});

// the disk helpers, on a fake tree
const tree = { '/t': [{ name: 'a', dir: true }, { name: 'f1', dir: false }], '/t/a': [{ name: 'f2', dir: false }] };
const DISK = { join: (d, n) => `${d}/${n}`, list: d => { if (d === '/t/locked') throw err('EACCES'); if (d === '/t/gone') throw err(GONE); return tree[d]; } };

test('walkFiles: nested files; a folder gone is empty; a folder that cannot be listed fails', () => {
  assert.deepEqual(walkFiles('/t', DISK), ['/t/a/f2', '/t/f1']);
  assert.deepEqual(walkFiles('/t/gone', DISK), []);
  assert.throws(() => walkFiles('/t/locked', DISK), /EACCES/);
});

test('totalSize: a gone file adds nothing; a file that cannot be read fails', () => {
  const size = f => { if (f === 'gone') throw err(GONE); if (f === 'locked') throw err('EACCES'); return 10; };
  assert.equal(totalSize(['x', 'gone', 'y'], { size }), 20);
  assert.throws(() => totalSize(['x', 'locked'], { size }), /EACCES/);
});

test('scanStorage: a leak is found; a gone file is skipped; an unreadable one is reported (not taken as clean)', () => {
  const read = f => { if (f === 'gone') throw err(GONE); if (f === 'locked') throw err('EACCES'); return Buffer.from(f === 'ls' ? '...ps-wallet...' : 'nothing'); };
  assert.deepEqual(scanStorage(['ls', 'ok', 'gone', 'locked'], ['ps-wallet', 'ws07:keyUses'], { read }), { leaked: ['ls'], unreadable: ['locked: EACCES'] });
});

test('the screen test wires this guard and keeps no fail-open path of its own (pinned as text)', () => {
  const s = readFileSync(new URL('../screens/first-guide-villages.screen.mjs', import.meta.url), 'utf8');
  assert.match(s, /import \{ createGuard, walkFiles, totalSize, scanStorage \} from '\.\/first-guide-safety\.mjs';/);
  assert.match(s, /browser = await guard\.adopt\('browser', chromium\.launch\(/);
  assert.match(s, /srv = await guard\.adopt\('srv', startServer\(/);
  assert.match(s, /ctx = await guard\.adopt\('ctx', browser\.newContext\(/);
  assert.match(s, /assert\.deepEqual\(scan\.unreadable, \[\], 'every profile file could be read'\);/);
  assert.match(s, /assert\.deepEqual\(st\.closeErrors, \[\], 'every close succeeded'\);/);
  assert.doesNotMatch(s, /catch \{ return \[\]; \}|catch \{ return a; \}|catch \{ return false; \}|\.catch\(\(\) => \{\}\)|let free = Infinity/);
});
