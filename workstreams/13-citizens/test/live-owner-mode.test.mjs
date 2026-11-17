// The owner's signed mode command on a resident directory, without a Resident (2026-11-17. WRITTEN ONLY, NOT RUN).
// Temporary directories made and removed by the test. The refusals need no key; the signed cases use the test world's
// operator identity (world/identity.mjs) and skip in the keyless default, as continuity.test.mjs does.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyOwnerModeCommand } from '../resident/live/owner-mode.mjs';
import { writeInitialResident } from '../resident/live/initial.mjs';
import { readResidentState } from '../resident/live/resident-state.mjs';
import { existsForHalt } from '../resident/live/factory.mjs';
import { signCommand } from '../../../permutation-gateway/src/frontier/agent/owner-auth.mjs';
import { identityFor, NEEDS_KEYS } from '../world/identity.mjs';

const WALLET = 'Me1111111111111111111111111111111';
const OWNER_ADDR = 'Aw1111111111111111111111111111111';
const fs = { readText: p => readFileSync(p, 'utf8'), exists: existsForHalt };
const withResident = async (owner, f) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ws13-mode-'));
  try {
    const dir = path.join(root, 'asa');
    assert.equal(writeInitialResident({ dir, id: 'asa', name: 'Asa', goal: 'surplus-use', owner: { address: owner }, wallet: WALLET, createdAtMs: 1_800_000_000_000 }).ok, true);
    await f(dir);
  } finally { rmSync(root, { recursive: true, force: true }); }
};
const cmd = (o = {}) => ({ op: 'mode', owner: OWNER_ADDR, agentId: 'asa', nonce: 'n0000001', expiresAt: Date.now() + 60_000, params: { mode: 'auto' }, ...o });

test('refused before anything is read or written: another op, withdraw, an unknown mode or parameter', async () => {
  await withResident(OWNER_ADDR, async dir => {
    const before = readFileSync(path.join(dir, 'state.json'), 'utf8');
    for (const command of [cmd({ op: 'policy', params: { extendTurns: 1 } }), cmd({ params: { mode: 'manual', withdraw: true } }), cmd({ params: { mode: 'endless' } }), cmd({ params: { mode: 'auto', extra: 1 } }), cmd({ params: undefined }), null]) {
      const r = applyOwnerModeCommand({ dir, wallet: WALLET, signed: { command, signature: 'AAAA' } });
      assert.equal(r.ok, false);
      assert.equal(r.step, 'command', JSON.stringify(command));
    }
    assert.equal(readFileSync(path.join(dir, 'state.json'), 'utf8'), before);
  });
});

test('refused without a valid signature, for an unknown state, or another wallet; nothing written, the nonce not consumed', async () => {
  await withResident(OWNER_ADDR, async dir => {
    const before = readFileSync(path.join(dir, 'state.json'), 'utf8');
    const bad = applyOwnerModeCommand({ dir, wallet: WALLET, signed: { command: cmd(), signature: Buffer.alloc(64).toString('base64') } });
    assert.equal(bad.step, 'verify');
    assert.equal(readFileSync(path.join(dir, 'state.json'), 'utf8'), before, 'nothing saved: no mode, no nonce');
    assert.equal(applyOwnerModeCommand({ dir, wallet: 'Other1111111111111111111111111111', signed: { command: cmd(), signature: 'x' } }).step, 'state');
    assert.equal(applyOwnerModeCommand({ dir: path.join(dir, 'missing'), wallet: WALLET, signed: { command: cmd(), signature: 'x' } }).step, 'state');
    assert.equal(readResidentState({ dir, wallet: WALLET, fs }).stop.why, 'stopped-by-owner', 'still stopped');
  });
});

test('signed by the owner: applied once, saved, the nonce kept; a replay, another owner or an expired command refused', { skip: NEEDS_KEYS }, async () => {
  const owner = identityFor('operator');
  await withResident(owner.address, async dir => {
    const sign = c => ({ command: c, signature: signCommand(c, owner.keypair) });
    const c1 = { ...cmd({ owner: owner.address, nonce: 'auto0001' }) };
    const r = applyOwnerModeCommand({ dir, wallet: WALLET, signed: sign(c1) });
    assert.deepEqual(r, { ok: true, mode: 'auto', modeEpoch: 1 });
    assert.equal(readResidentState({ dir, wallet: WALLET, fs }).stop, null, 'running: the live step now proposes (still never enacts)');
    const replay = applyOwnerModeCommand({ dir, wallet: WALLET, signed: sign(c1) });
    assert.equal(replay.step, 'verify', 'a used nonce is refused');
    const st = JSON.parse(readFileSync(path.join(dir, 'state.json'), 'utf8'));
    assert.ok(st.agentWallet.ownerNonces[owner.address]?.auto0001, 'the nonce is on disk');
    assert.equal(applyOwnerModeCommand({ dir, wallet: WALLET, signed: sign(cmd({ owner: owner.address, agentId: 'ren', nonce: 'other001' })) }).step, 'owner', 'another agent');
    assert.equal(applyOwnerModeCommand({ dir, wallet: WALLET, signed: sign(cmd({ owner: owner.address, nonce: 'late0001', expiresAt: Date.now() - 1 })) }).step, 'verify', 'expired');
    const back = applyOwnerModeCommand({ dir, wallet: WALLET, signed: sign(cmd({ owner: owner.address, nonce: 'manual01', params: { mode: 'manual' } })) });
    assert.deepEqual(back, { ok: true, mode: 'manual', modeEpoch: 2 });
    const same = applyOwnerModeCommand({ dir, wallet: WALLET, signed: sign(cmd({ owner: owner.address, nonce: 'manual02', params: { mode: 'manual' } })) });
    assert.deepEqual(same, { ok: true, mode: 'manual', modeEpoch: 2 }, 'the same mode: unchanged, the nonce still kept');
    assert.ok(JSON.parse(readFileSync(path.join(dir, 'state.json'), 'utf8')).agentWallet.ownerNonces[owner.address].manual02);
  });
});

test('as text: the same contract as Resident.command for mode, narrower; no key, no clock from the caller, no send', () => {
  const src = readFileSync(new URL('../resident/live/owner-mode.mjs', import.meta.url), 'utf8');
  const code = src.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '');
  assert.match(code, /verifyCommand\(\{ command, signature: signed\.signature \}, \{ op: 'mode', nonces: ledger\.db\.ownerNonces \}\)/, 'owner-auth\'s own clock: no `now` passed');
  assert.match(code, /command\.owner !== charter\.owner\.address \|\| command\.agentId !== charter\.id\) return \{ ok: false, step: 'owner', why: 'NotOwner' \}/);
  assert.ok(code.indexOf('verifyCommand(') < code.indexOf('ledger.setMode(') && code.indexOf('ledger.setMode(') < code.indexOf('ledger.save();'), 'verified, then applied, then saved');
  assert.doesNotMatch(code, /new Resident|loadOrCreateKey|newKeypair|signCommand|signTalk|Date\.now|withdrawUnsent|\.post\(|\.submit\(|writeFileSync|rmSync|unlink/);
  const res = readFileSync(new URL('../resident/resident.mjs', import.meta.url), 'utf8');
  assert.match(res, /verifyCommand\(\{ command, signature \}, \{ op, nonces: this\.ledger\.db\.ownerNonces, now \}\);\n    if \(command\.owner !== this\.charter\.owner\.address \|\| command\.agentId !== this\.id\) throw new Error\('NotOwner'\);/, 'the resident\'s own rule this mirrors');
});
