// ⑧ P1/P2 (TEST-ONLY, not for production): the launcher's `--continuous local-continuous-v1` and `--persist
// local-persist-v1`. Exact words, natural worlds without the demo only; the runner's first line must state exactly what
// was asked; a persisted world's directories are private (0700) and a looser one is refused. No key is made here and
// no process is started.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, chmodSync, statSync, symlinkSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import * as L from '../src/frontier/local-play-launcher.mjs';

const W = 'BbPGAbHDvV5U43zQ5E8FmSnEzZ7r2vwWAZWTNAPTTSUT';
const abs = ['--root', '/r', '--data', '/d', '--runner', '/x/runner', '--herald', '/x/herald', '--depart', '/x/depart', '--preview', '/x/preview', '--resident', '/x/resident', '--artifact', '/x/a.so', '--artifact-sha', 'ab'.repeat(32)];
const natural = [...abs, '--world-preset', 'local-natural-v1', '--natural-runner', '/x/natural', '--economy', 'page-signed-v1'];
const trial = [...natural, '--march-trial', L.MARCH_TRIAL_MODE];
const fault = async (args, code) => assert.rejects(L.parseConfig(args), e => e.code === code, code);
// (well-formed: every check of the words passes; it fails only later, at the paths, which do not exist here)
const WORD_CODES = ['InvalidContinuous', 'InvalidPersist', 'PersistNeedsNaturalWorld', 'InvalidArguments', 'PersistNotPrivate'];
const pathsOnly = async args => assert.rejects(L.parseConfig(args), e => !WORD_CODES.includes(e.code), String(args));

test('the words: exactly local-continuous-v1 and local-persist-v1', () => {
  assert.equal(L.CONTINUOUS_MODE, 'local-continuous-v1');
  assert.equal(L.PERSIST_MODE, 'local-persist-v1');
  assert.equal(L.PERSIST_PAGE_WORD, 'local');
});

test('parseConfig: each word exact, once, on a natural world without the capture demo only', async () => {
  for (const v of ['true', 'yes', 'continuous', 'local-continuous-v2', 'LOCAL-CONTINUOUS-V1']) await fault([...natural, '--continuous', v], 'InvalidContinuous');
  for (const v of ['true', 'local', 'local-persist-v2', 'LOCAL-PERSIST-V1']) await fault([...natural, '--persist', v], 'InvalidPersist');
  await fault([...natural, '--persist', L.PERSIST_MODE, '--persist', L.PERSIST_MODE], 'InvalidArguments');
  await fault([...natural, '--continuous', L.CONTINUOUS_MODE, '--continuous', L.CONTINUOUS_MODE], 'InvalidArguments');
  // (not a natural world: the expedition lane has no Season of its own to make continuous or to resume)
  await fault([...abs, '--continuous', L.CONTINUOUS_MODE], 'PersistNeedsNaturalWorld');
  await fault([...abs, '--persist', L.PERSIST_MODE], 'PersistNeedsNaturalWorld');
  // (never with the capture demo: its compressed clock cannot be resumed)
  const demo = ['--capture-demo', L.CAPTURE_DEMO_MODE, '--demo-scale', '20'];
  await fault([...trial, ...demo, '--persist', L.PERSIST_MODE], 'PersistNeedsNaturalWorld');
  await fault([...trial, ...demo, '--continuous', L.CONTINUOUS_MODE], 'PersistNeedsNaturalWorld');
  for (const args of [[...natural, '--continuous', L.CONTINUOUS_MODE], [...natural, '--persist', L.PERSIST_MODE], [...trial, '--continuous', L.CONTINUOUS_MODE, '--persist', L.PERSIST_MODE]]) await pathsOnly(args);
});

test('startWorld refuses either option off a natural world, with the demo, or in another shape, before anything starts', async () => {
  const base = { worldPreset: 'local-natural-v1', naturalRunner: '/x/natural', economy: 'page-signed-v1' };
  const refused = async (c, why) => assert.rejects(L.startWorld(c, W, 0, () => {}), e => e.code === 'InvalidWorldPreset', why);
  await refused({ economy: 'page-signed-v1', persist: true }, 'persist off a natural world');
  await refused({ economy: 'page-signed-v1', continuous: true }, 'continuous off a natural world');
  await refused({ ...base, marchTrial: true, captureDemo: { scale: 20 }, persist: true }, 'persist with the demo');
  await refused({ ...base, marchTrial: true, captureDemo: { scale: 20 }, continuous: true }, 'continuous with the demo');
  await refused({ ...base, persist: 'yes' }, 'persist not exactly true');
  await refused({ ...base, continuous: 1 }, 'continuous not exactly true');
});

test('the runner\'s first line must state exactly the continuous preset and the persistence asked for', () => {
  const p = (resumed = false) => ({ mode: L.PERSIST_MODE, resumed, test_only: true, not_for_production: true });
  const ok = (meta, want, why) => assert.equal(L.runnerPersistAgrees(meta, want), true, why);
  const no = (meta, want, why) => assert.equal(L.runnerPersistAgrees(meta, want), false, why);
  ok({}, {}, 'an older runner that states neither, on a plain launcher');
  ok({ continuous: false, memory_only: true }, {}, 'a plain world');
  ok({ continuous: true, continuous_mode: L.CONTINUOUS_MODE, memory_only: true }, { continuous: true });
  ok({ continuous: false, memory_only: false, persist: p() }, { persist: true }, 'a new persisted world');
  ok({ continuous: true, continuous_mode: L.CONTINUOUS_MODE, memory_only: false, persist: p(true) }, { continuous: true, persist: true }, 'a resumed continuous world');
  no({}, { continuous: true }, 'the runner did not make the continuous Season');
  no({ continuous: true, continuous_mode: L.CONTINUOUS_MODE }, {}, 'a continuous Season this launcher did not ask for');
  no({ continuous: true }, { continuous: true }, 'no mode word');
  no({ continuous: 'true', continuous_mode: L.CONTINUOUS_MODE }, { continuous: true }, 'not a boolean');
  no({ memory_only: true }, { persist: true }, 'the runner does not persist');
  no({ memory_only: false, persist: p() }, {}, 'the runner persists, this launcher did not ask');
  no({ memory_only: false }, {}, 'a runner that is not memory-only without saying why');
  no({ memory_only: true, persist: p() }, { persist: true }, 'says both');
  no({ memory_only: false, persist: { ...p(), test_only: false } }, { persist: true }, 'not test-only');
  no({ memory_only: false, persist: { ...p(), not_for_production: undefined } }, { persist: true }, 'not marked not-for-production');
  no({ memory_only: false, persist: { ...p(), mode: 'local-persist-v2' } }, { persist: true }, 'another mode');
  no({ memory_only: false, persist: { ...p(), resumed: 'no' } }, { persist: true }, 'resumed not a boolean');
  no({ memory_only: false, persist: { ...p(), extra: 1 } }, { persist: true }, 'anything more');
});

test('a persisted world\'s directory: created 0700; a looser one, a file or a link is refused', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'psf-persist-'));
  try {
    const d = path.join(root, 'persist');
    await L.ensurePrivateDir(d);
    assert.equal(statSync(d).mode & 0o777, 0o700);
    await L.ensurePrivateDir(d);   // (again: accepted as it is)
    chmodSync(d, 0o755);
    await assert.rejects(L.ensurePrivateDir(d), e => e.code === 'PersistNotPrivate' && e.detail?.why === 'mode' && e.detail.mode === 0o755);
    chmodSync(d, 0o701);
    await assert.rejects(L.ensurePrivateDir(d), e => e.code === 'PersistNotPrivate');
    chmodSync(d, 0o700);
    const link = path.join(root, 'link'); symlinkSync(d, link);
    await assert.rejects(L.ensurePrivateDir(link), e => e.code === 'PersistNotPrivate' && e.detail?.why === 'link');
    const file = path.join(root, 'file'); writeFileSync(file, 'x', { mode: 0o600 });
    await assert.rejects(L.ensurePrivateDir(file), e => e.code === 'PersistNotPrivate' && e.detail?.why === 'kind');
    assert.deepEqual(await L.privateMode(file, false), { ok: true, mode: 0o600 });
    chmodSync(file, 0o640);
    assert.deepEqual(await L.privateMode(file, false), { ok: false, why: 'mode', mode: 0o640 });
    await assert.rejects(L.ensurePrivateDir(path.join(root, 'no', 'parent')), e => e.code === 'PersistDirUnavailable');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('parseConfig with --persist makes <data>/persist private and refuses a looser one', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'psf-persist-cfg-'));
  try {
    const bin = name => { const p = path.join(root, name); writeFileSync(p, ''); return p; };
    mkdirSync(path.join(root, 'permutation-gateway/src/frontier'), { recursive: true });
    mkdirSync(path.join(root, 'permutation-server/web'), { recursive: true });
    writeFileSync(path.join(root, 'permutation-gateway/src/frontier/local-play-relay-server.mjs'), '');
    const data = path.join(root, 'data');
    const args = ['--root', root, '--data', data, '--runner', bin('runner'), '--herald', bin('herald'), '--depart', bin('depart'), '--preview', bin('preview'), '--resident', bin('resident'),
      '--artifact', bin('a.so'), '--artifact-sha', 'ab'.repeat(32), '--world-preset', 'local-natural-v1', '--natural-runner', bin('natural'), '--economy', 'page-signed-v1'];
    const c = await L.parseConfig([...args, '--persist', L.PERSIST_MODE, '--continuous', L.CONTINUOUS_MODE]);
    assert.equal(c.persist, true); assert.equal(c.continuous, true);
    assert.equal(statSync(path.join(data, 'persist')).mode & 0o777, 0o700);
    chmodSync(path.join(data, 'persist'), 0o755);
    await assert.rejects(L.parseConfig([...args, '--persist', L.PERSIST_MODE]), e => e.code === 'PersistNotPrivate');
    // (without the words: as before, nothing of either)
    const plain = await L.parseConfig(args);
    assert.equal(plain.persist, undefined); assert.equal(plain.continuous, undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the page is addressed with persist=local only by a persisting launcher, and a disagreeing address is redirected', async () => {
  const ask = async (c, url) => {
    const { server } = L.createLauncherServer({ port: 41399, worldPort: 41350, web: '/nonexistent', ...c }, { close() {}, list: () => [] });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    try {
      const res = await new Promise((resolve, reject) => { http.get({ host: '127.0.0.1', port, path: url, headers: { host: 'localhost:41399' } }, resolve).on('error', reject); });
      res.resume();
      return { status: res.statusCode, location: res.headers.location };
    } finally { server.close(); }
  };
  const nat = { worldPreset: 'local-natural-v1' };
  assert.match((await ask({ ...nat, persist: true }, '/')).location, /&persist=local$/);
  assert.doesNotMatch((await ask(nat, '/')).location, /persist=/);
  const page = '/frontier/frontier/index.html?localPlay=1&launcher=1&devWallet=off&world=natural';
  const r = await ask({ ...nat, persist: true }, page);
  assert.equal(r.status, 302); assert.match(r.location, /persist=local/);
  const back = await ask(nat, `${page}&persist=local`);
  assert.equal(back.status, 302); assert.doesNotMatch(back.location, /persist=/);
});

test('the options reach the runner, the herald and the start answer only from the launcher\'s own config', () => {
  const src = readFileSync(new URL('../src/frontier/local-play-launcher.mjs', import.meta.url), 'utf8');
  assert.match(src, /\.\.\.\(continuous \? \['--continuous', CONTINUOUS_MODE\] : \[\]\)/);
  assert.match(src, /\.\.\.\(persist \? \['--persist-dir', path\.join\(home, 'run'\)\] : \[\]\)/);
  assert.match(src, /launch\('herald', c\.herald, \['--data', path\.join\(home \?\? dir, 'herald'\)/, 'a persisted world\'s herald keeps its records in the wallet\'s directory');
  assert.match(src, /persistWord = c\.persist === true \? PERSIST_PAGE_WORD : ''/, 'the address word comes from the launcher\'s config');
  assert.ok(!/searchParams\.get\('persist'\)[^\n]*persist: true/.test(src), 'no request turns persistence on');
  assert.match(src, /const home = persist \? path\.join\(c\.data, 'persist', wallet\) : null;/, 'keyed by the validated public address only');
  assert.ok(!/fs\.rm\(|rmSync|unlink\(/.test(src), 'the launcher never deletes a world');
});
