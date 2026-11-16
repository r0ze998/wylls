// The guard of first-guide-villages.screen.mjs (screens/first-guide-safety.mjs) with FAKE handles, a FAKE disk and FAKE
// timers (2026-11-16): fail-closed reads, a handle that arrives after a trip closed at once, each handle closed once, a
// failed close reported. Nothing real is started, read or written: the module imports nothing; no browser, server,
// file, process, timer, key or network is touched here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createGuard, walkFiles, totalSize, scanStorage, GONE, waitUntil, runPhases, summarize, verdict } from '../screens/first-guide-safety.mjs';

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

// ------------------------------------------------------------------ the phases, the bounded wait and the verdict
const fakeClock = () => { let t = 0; return { now: () => t, sleep: async ms => { t += ms; } }; };

test('waitUntil: ready on the third check; a throwing check is "not ready" with its reason; bounded, with the last reason', async () => {
  const c = fakeClock(); let n = 0;
  const r = await waitUntil(async () => (++n === 1 ? (() => { throw new Error('module not loaded'); })() : { ok: n >= 3, why: `try ${n}` }), { timeoutMs: 1000, everyMs: 250, ...c });
  assert.equal(r.ok, true); assert.equal(n, 3);
  const c2 = fakeClock(); let m = 0;
  await assert.rejects(waitUntil(async () => { m++; return { ok: false, why: 'the province 2,0 is not read yet' }; }, { timeoutMs: 1000, everyMs: 250, ...c2, what: 'ready' }),
    /not ready after 1000 ms: the province 2,0 is not read yet/);
  assert.equal(m, 5, 'checks at 0, 250, 500, 750, 1000 ms, then stopped');
});

const ok = () => {}, boom = msg => () => { throw new Error(msg); };
const run = (open, rdy, cases, audit) => runPhases([{ name: 'open', run: open }, { name: 'ready', run: rdy }, { name: 'cases', run: cases }, { name: 'audit', run: audit, always: true }]);

test('phases: all pass → ok', async () => {
  const s = summarize(await run(ok, ok, ok, ok));
  assert.deepEqual(s, { ok: true, failures: [], skipped: [] });
});
test('phases: the set-up fails → ready and cases skipped, the audit STILL runs; both kept', async () => {
  let audited = false;
  const r = await run(boom('open failed'), ok, ok, () => { audited = true; throw new Error('keys/storage: the browser context never opened'); });
  assert.equal(audited, true);
  assert.deepEqual(summarize(r), { ok: false, failures: ['open: open failed', 'audit: keys/storage: the browser context never opened'], skipped: ['ready', 'cases'] });
});
test('phases: the readiness wait fails (as in 4d12e851) → cases skipped, the audit runs and may pass; still not ok', async () => {
  const s = summarize(await run(ok, boom('not ready after 20000 ms: the province 2,0 is not read yet'), ok, ok));
  assert.equal(s.ok, false); assert.deepEqual(s.skipped, ['cases']); assert.equal(s.failures.length, 1);
});
test('phases: a case fails and the audit fails → both kept', async () => {
  const s = summarize(await run(ok, ok, boom('pill: expected muster'), boom('requests: a POST was asked for')));
  assert.deepEqual(s.failures, ['cases: pill: expected muster', 'audit: requests: a POST was asked for']);
});
test('phases: the cases pass, the audit fails → not ok', async () => {
  assert.equal(summarize(await run(ok, ok, ok, boom('profile storage: page storage was found'))).ok, false);
});

const clean = { tripped: null, closeErrors: [], open: [] };
test('verdict: a clean cleanup and a passed audit → nothing to report', async () => {
  assert.deepEqual(verdict({ state: clean, main: await run(ok, ok, ok, ok) }), []);
});
test('verdict: a clean cleanup does NOT stand for a passed audit (failed, skipped, never run, no main run)', async () => {
  assert.match(verdict({ state: clean, main: await run(ok, ok, ok, boom('origins: another origin')) })[0], /the safety audit did not pass \(origins: another origin\): a clean cleanup is not a passed safety check/);
  assert.match(verdict({ state: clean, main: [{ name: 'audit', ok: null, error: null }] })[0], /did not pass \(skipped\)/);
  assert.deepEqual(verdict({ state: clean, main: [{ name: 'open', ok: true, error: null }] }), ['the safety audit never ran']);
  assert.deepEqual(verdict({ state: clean, main: null }), ['the main run never ran']);
});
test('verdict: cleanup failures are reported with the audit\'s', async () => {
  const v = verdict({ state: { tripped: 'free space unreadable: EIO', closeErrors: ['srv: ERR_SERVER_NOT_RUNNING'], open: ['browser'] }, leftovers: ['playwright-artifacts-x'], main: await run(ok, ok, ok, boom('page errors: x')) });
  assert.deepEqual(v.slice(0, 4), ['the monitor tripped: free space unreadable: EIO', 'close failed: srv: ERR_SERVER_NOT_RUNNING', 'left open: browser', 'temporary folders left: playwright-artifacts-x']);
  assert.match(v[4], /the safety audit did not pass/);
});

test('the screen test wires this guard, waits for its home province, audits always, and gives the cleanup the audit\'s verdict (pinned as text)', () => {
  const s = readFileSync(new URL('../screens/first-guide-villages.screen.mjs', import.meta.url), 'utf8');
  assert.match(s, /import \{ createGuard, walkFiles, totalSize, scanStorage, waitUntil, runPhases, summarize, verdict \} from '\.\/first-guide-safety\.mjs';/);
  assert.match(s, /browser = await guard\.adopt\('browser', chromium\.launch\(/);
  assert.match(s, /srv = await guard\.adopt\('srv', startServer\(/);
  assert.match(s, /ctx = await guard\.adopt\('ctx', browser\.newContext\(/);
  assert.match(s, /\{ name: 'open', run: openPage \},\s*\{ name: 'ready', run: ready \},\s*\{ name: 'cases', run: cases \},\s*\{ name: 'audit', run: audit, always: true \},/);
  assert.match(s, /const v = verdict\(\{ state: st, leftovers, main: MAIN \}\);\s*assert\.deepEqual\(v, \[\], v\.join/);
  assert.match(s, /if \(!env\?\.province\) throw new Error\(`the home province \$\{key\} is not read yet`\);/);
  assert.match(s, /if \(!ctx\) fails\.push\('keys\/storage: the browser context never opened/);
  assert.doesNotMatch(s, /catch \{ return \[\]; \}|catch \{ return a; \}|catch \{ return false; \}|\.catch\(\(\) => \{\}\)|let free = Infinity/);
});
