// A new resident's directory, stopped from the start, from public values only (2026-11-17. WRITTEN ONLY, NOT RUN).
// Temporary directories made by the test (mkdtemp) and removed by it; no key, no network (fetch throws if called),
// no Resident constructed, nothing signed or sent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, rmSync, statSync, symlinkSync, mkdirSync, lstatSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initialResident, writeInitialResident, initialContentProblems } from '../resident/live/initial.mjs';
import { charterOf, initialStateOf } from '../resident/resident.mjs';
import { readResidentState } from '../resident/live/resident-state.mjs';
import { runOnce } from '../resident/live/once.mjs';

const OWNER = 'Aw1111111111111111111111111111111', WALLET = 'Me1111111111111111111111111111111';
const input = (o = {}) => ({ dir: '/srv/residents/asa', id: 'asa', name: 'Asa', goal: 'surplus-use', owner: { address: OWNER, name: 'operator' }, wallet: WALLET, createdAtMs: 1_800_000_000_000, ...o });
const fsOf = (dir, files, halt = false) => ({ readText: p => { const n = path.basename(p); if (path.dirname(p) !== dir || !(n in files)) throw Object.assign(new Error('no'), { code: 'ENOENT' }); return JSON.stringify(files[n]); }, exists: () => halt });

test('the pure assembly: the resident\'s own charter and state formats, the ledger\'s own record, stopped, nothing allowed', () => {
  const r = initialResident(input());
  assert.equal(r.ok, true);
  assert.deepEqual(r.charter, charterOf('/srv/residents/asa', { id: 'asa', name: 'Asa', goal: 'surplus-use', pos: null, owner: { address: OWNER, name: 'operator' } }));
  assert.equal(r.charter.haltFile, '/srv/residents/asa/HALT');
  assert.equal(r.charter.funder.address, OWNER, 'the funder is the owner when not given (the charter\'s rule)');
  const { agentWallet, ...st } = r.state;
  assert.deepEqual(st, initialStateOf(r.charter));
  const rec = agentWallet.agents.asa;
  assert.equal(rec.mode, 'manual');
  assert.deepEqual(rec.policy, { allowed: [], budget: { total: r.charter.budget.total, perDay: r.charter.budget.perDay, callsPerDay: r.charter.budget.callsPerDay }, version: 1 });
  assert.equal(rec.agentKey, WALLET);
  assert.equal(rec.owner, OWNER);
  assert.equal(rec.createdAt, 1_800_000_000_000);
  assert.equal(rec.bal.available, '0');
  assert.deepEqual(Object.keys(agentWallet.agents), ['asa']);
  assert.equal(JSON.stringify(initialResident(input())), JSON.stringify(r), 'the same input, the same content (no clock, no random id)');
});

test('missing or malformed values are named; nothing is invented', () => {
  const r = initialResident({});
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing.map(m => m.field), ['dir', 'id', 'name', 'goal', 'owner.address', 'wallet', 'createdAtMs']);
  for (const o of [{ dir: 'rel' }, { dir: '/' }, { dir: '/a/../b' }, { id: 'two words' }, { id: 'x'.repeat(65) }, { goal: 'world-domination' }, { owner: { name: 'no address' } }, { funder: { address: 'bad' } }, { wallet: '' }, { createdAtMs: 0 }, { createdAtMs: 1.5 }]) {
    assert.equal(initialResident(input(o)).ok, false, JSON.stringify(o));
  }
});

test('read back: the files read as a resident stopped by its owner, with no submitted key', () => {
  const r = initialResident(input());
  const s = readResidentState({ dir: '/srv/residents/asa', wallet: WALLET, fs: fsOf('/srv/residents/asa', { 'charter.json': r.charter, 'state.json': r.state }) });
  assert.deepEqual(s.stop, { why: 'stopped-by-owner' });
  assert.deepEqual([...s.submitted.keys], []);
  assert.deepEqual([...s.submitted.held], []);
  assert.deepEqual([...s.unsent], []);
  assert.equal(readResidentState({ dir: '/srv/residents/asa', wallet: 'Other111111111111111111111111111', fs: fsOf('/srv/residents/asa', { 'charter.json': r.charter, 'state.json': r.state }) }).stop.why, 'state-unknown', 'another wallet');
});

test('the explicit save: from the settings only; a new directory only, exclusive files, nothing overwritten or cleaned up; then runOnce says stopped', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ws13-init-'));
  try {
    const dir = path.join(root, 'asa');
    const w = writeInitialResident(input({ dir }));
    assert.deepEqual(w, { ok: true, wrote: ['charter.json', 'state.json'] });
    assert.deepEqual(JSON.parse(readFileSync(path.join(dir, 'state.json'), 'utf8')), JSON.parse(JSON.stringify(initialResident(input({ dir })).state)), 'what was saved is what initialResident builds');
    assert.equal(statSync(path.join(dir, 'state.json')).mode & 0o777, 0o600);
    assert.equal(existsSync(path.join(dir, 'HALT')), false, 'no halt file is made (the stop is the manual mode)');
    assert.equal(existsSync(path.join(dir, 'resident.key')), false, 'no key');
    const before = readFileSync(path.join(dir, 'state.json'), 'utf8');
    const again = writeInitialResident(input({ dir }));
    assert.equal(again.ok, false);
    assert.equal(again.step, 'mkdir', 'an existing directory is refused');
    assert.equal(readFileSync(path.join(dir, 'state.json'), 'utf8'), before, 'nothing overwritten');
    // a charter or state from elsewhere is not a setting: refused before anything is made
    const forged = writeInitialResident({ ...input({ dir: path.join(root, 'forged') }), state: { v: 2, journal: { k: {} } }, charter: {} });
    assert.equal(forged.step, 'input');
    assert.ok(forged.missing.some(m => m.field === 'state') && forged.missing.some(m => m.field === 'charter'));
    assert.equal(existsSync(path.join(root, 'forged')), false);
    // a link where the new directory would be: refused, the link and its target untouched
    const target = path.join(root, 'elsewhere'); mkdirSync(target);
    const link = path.join(root, 'linked'); symlinkSync(target, link);
    const viaLink = writeInitialResident(input({ dir: link }));
    assert.equal(viaLink.ok, false);
    assert.ok(lstatSync(link).isSymbolicLink());
    assert.equal(existsSync(path.join(target, 'state.json')), false);
    assert.equal(writeInitialResident(input({ dir: path.join(root, 'no', 'parent') })).step, 'parent');
    // the usage: a stopped resident; one step reads only its files (no network: fetch throws if called)
    const res = await runOnce({ heraldUrl: 'http://127.0.0.1:1', wallet: WALLET, residentDir: dir }, { fetchImpl: async () => { throw new Error('no network expected'); } });
    assert.equal(res.outcome, 'stopped');
    assert.equal(res.stop.why, 'stopped-by-owner');
    assert.deepEqual(res.stopA.confirmed, []);
    assert.equal(res.enacted, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('as text: no key, no auto, no clock, no Resident, no removal; the resident\'s own builders are the one source', () => {
  const src = readFileSync(new URL('../resident/live/initial.mjs', import.meta.url), 'utf8').replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(src, /setMode|loadOrCreateKey|newKeypair|keyIdentity|new Resident|createCharter\(|Date\.now|randomUUID|rmSync|unlink|rmdir|recursive: true|writeFileSync|'w'\)|fetch\(/);
  assert.match(src, /mkdirSync\(dir, \{ mode: 0o700 \}\)/, 'non-recursive: an existing directory is an error');
  assert.match(src, /openSync\(file, 'wx', 0o600\)/, 'exclusive files');
  const res = readFileSync(new URL('../resident/resident.mjs', import.meta.url), 'utf8');
  assert.match(res, /export function createCharter\(dir, c\) \{\n  const charter = charterOf\(dir, c\);\n  mkdirSync\(dir, \{ recursive: true \}\);\n  writeFileSync\(path\.join\(dir, 'charter\.json'\), JSON\.stringify\(charter, null, 2\)\);/);
  assert.match(res, /this\.store\.state = initialStateOf\(this\.charter\);/);
  assert.match(res, /this\.ledger\.setMode\(this\.charter\.id, 'auto'\);/, 'the constructor still switches a new resident to auto: that is why it is not used here');
});

// (2026-11-17, second tip; WRITTEN ONLY, NOT RUN) only a verified new, stopped content is ever saved
test('initialContentProblems: anything but a new, stopped resident with nothing allowed is named', () => {
  const r = initialResident(input());
  const ctx = { dir: '/srv/residents/asa', wallet: WALLET };
  assert.deepEqual(initialContentProblems(r.charter, r.state, ctx), []);
  const tamper = f => { const st = JSON.parse(JSON.stringify(r.state)); f(st, st.agentWallet.agents.asa); return initialContentProblems(r.charter, st, ctx); };
  for (const [what, f] of [
    ['a submitted journal line', st => { st.journal.k = { key: 'k', port: 'action', state: 'sent', sendKey: 'k' }; }],
    ['a turn taken', st => { st.turn = 3; }],
    ['auto', (st, rec) => { rec.mode = 'auto'; }],
    ['something allowed', (st, rec) => { rec.policy.allowed = ['Build']; }],
    ['revoked set', (st, rec) => { rec.policy.revoked = false; }],
    ['a balance', (st, rec) => { rec.bal.available = '5'; }],
    ['a hold', (st, rec) => { rec.holds.h = {}; }],
    ['another wallet', (st, rec) => { rec.agentKey = 'Other111111111111111111111111111'; }],
    ['another agent', st => { st.agentWallet.agents.ren = {}; }],
    ['a nonce used', st => { st.agentWallet.ownerNonces = { [OWNER]: { n: 1 } }; }],
    ['a mode epoch', (st, rec) => { rec.modeEpoch = 1; }],
  ]) assert.ok(tamper(f).length > 0, what);
  assert.ok(initialContentProblems(r.charter, r.state, { dir: '/srv/residents/other', wallet: WALLET }).length > 0, 'another directory');
});

test('limits, budget and siblings only in the charter\'s own forms; other settings refused', () => {
  assert.equal(initialResident(input({ limits: { maxTurns: 50 }, budget: { total: '1000', callsPerDay: 4 }, siblings: [OWNER] })).ok, true);
  for (const o of [{ limits: { maxTurns: 0 } }, { limits: { maxTurns: '50' } }, { limits: { endless: 1 } }, { limits: [] },
    { budget: { total: 1000 } }, { budget: { total: '-1' } }, { budget: { callsPerDay: -1 } }, { budget: { allowance: '1' } },
    { siblings: ['bad'] }, { siblings: 'x' }, { mode: 'auto' }, { policy: { allowed: ['Build'] } }, { state: {} }]) {
    assert.equal(initialResident(input(o)).ok, false, JSON.stringify(o));
  }
});
