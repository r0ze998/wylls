// verify-bin-rebuild: the watch refuses a judge built without `--features verify/playable-lane` (2026-11-28: the
// 74f60922 build lacked it and the watch STOPPED on FAIL ×7986 that were the verifier's, not the chain's).
// Pure checks of verify-watch-lib.mjs + verify-watch.mjs run against fake binaries (no RPC, no port, no cargo).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REQUIRED_FEATURES, checkVerifierFeatures, classify } from '../verify-watch-lib.mjs';

const WATCH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'verify-watch.mjs');
const probe = (features, o = {}) => ({ code: 0, stdout: JSON.stringify({ bin: 'frontier-verify', version: '0.1.0', features, mutated: null, ...o }) + '\n', stderr: '' });

test('checkVerifierFeatures: playable-lane required; mutated, old and foreign binaries refused', () => {
  assert.deepEqual(REQUIRED_FEATURES, ['playable-lane']);
  const ok = checkVerifierFeatures(probe(['playable-lane', 'wide-world-experimental']));
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.features, ['playable-lane', 'wide-world-experimental']);

  const none = checkVerifierFeatures(probe([]));
  assert.equal(none.ok, false);
  assert.match(none.why, /built without playable-lane/);
  assert.match(none.why, /--features verify\/playable-lane/, 'says how to rebuild');

  const mut = checkVerifierFeatures(probe(['playable-lane'], { mutated: 'mutate-vg' }));
  assert.equal(mut.ok, false);
  assert.match(mut.why, /MUTATED build \(mutate-vg\)/);

  // a frontier-verify older than the probe: the arg loop rejects `features` (exit 2, usage)
  const old = checkVerifierFeatures({ code: 2, stdout: '', stderr: 'frontier-verify: unknown argument features\n\n…' });
  assert.equal(old.ok, false);
  assert.match(old.why, /does not report its build features .*exit 2: frontier-verify: unknown argument features/);

  for (const r of [{ code: 0, stdout: 'hello\n' }, { code: 0, stdout: '{"features":"playable-lane"}' }, { code: -1, stdout: '', stderr: 'ENOENT' }, undefined]) {
    assert.equal(checkVerifierFeatures(r).ok, false, JSON.stringify(r));
  }
});

test('classify: V0/UnknownProgramVersion is a misbuilt judge (ERROR), never FAIL', () => {
  const pull = { ok: true, seq: 9615, finals: { consistent: true }, program_hash: { sha256: 'aa' } };
  const summary = { verdict: 'UNVERIFIABLE', fail: 7986, unverifiable: 1941, failCodes: { 'CQ1/FinalStateMismatch': 7071 }, unvCodes: { 'V0/UnknownProgramVersion': 1, 'V0/HistoryUnproven': 1 } };
  const c = classify({ pull, verify: { code: 2, report: {}, summary }, pinnedSha256: 'aa' });
  assert.equal(c.level, 'ERROR');
  assert.equal(c.exit, 0);
  assert.match(c.why, /misbuilt judge: V0\/UnknownProgramVersion/);
  // the same FAIL findings from a judge that knows the version stay a real FAIL
  const real = classify({ pull, verify: { code: 2, report: {}, summary: { ...summary, unvCodes: { 'V0/HistoryUnproven': 1 } } }, pinnedSha256: 'aa' });
  assert.equal(real.level, 'FAIL');
  assert.equal(real.exit, 1);
});

function fakeBin(dir, name, body) {
  const p = path.join(dir, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

function watch(dir, verifyBin) {
  const so = path.join(dir, 'p.so');
  writeFileSync(so, 'x');
  const data = path.join(dir, 'data');
  const r = spawnSync(process.execPath, [WATCH, '--judge-only', '--program', 'GGFRJr9dwzq5g4Dj4w1gN9DdSwhVz1McfUGtekiECMrr', '--season', '3',
    '--data', data, '--verify-bin', verifyBin, '--program-so', so], { encoding: 'utf8', timeout: 20000 });
  return { ...r, data };
}

test('verify-watch.mjs refuses to start with a judge built without playable-lane (nothing written)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vw-feat-'));
  try {
    // the 74f60922 kind: default build — reports no features
    const bin = fakeBin(dir, 'fv-default', `[ "$1" = features ] && { echo '{"bin":"frontier-verify","version":"0.1.0","features":[],"mutated":null}'; exit 0; }\necho JUDGED > "${dir}/judged"; exit 0`);
    const r = watch(dir, bin);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /refusing to start: --verify-bin .*fv-default: the verify binary was built without playable-lane/);
    assert.equal(existsSync(path.join(dir, 'judged')), false, 'judge never ran');
    assert.equal(existsSync(r.data), false, 'data dir not even created');

    // a binary older than the probe
    const old = fakeBin(dir, 'fv-old', `echo "frontier-verify: unknown argument $1" >&2; exit 2`);
    const o = watch(dir, old);
    assert.equal(o.status, 2);
    assert.match(o.stderr, /refusing to start: .*does not report its build features/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('verify-watch.mjs goes past the check with a playable-lane judge', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vw-feat-'));
  try {
    const bin = fakeBin(dir, 'fv-playable', `[ "$1" = features ] && { echo '{"bin":"frontier-verify","version":"0.1.0","features":["playable-lane"],"mutated":null}'; exit 0; }\nexit 9`);
    const r = watch(dir, bin);
    assert.doesNotMatch(r.stderr, /refusing to start/);
    assert.equal(existsSync(r.data), true, 'the watch started (data dir made); --judge-only then needs last-pull.json');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
