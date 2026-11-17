// Restart preflight is exercised without HTTP, a wallet, or a generated key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStateStore } from '../src/config.mjs';
import { loadFrontierConfig, persistInitialRelayState, requireExistingRelayFiles, validateAgentDepositSends, validateRelayRecords } from '../src/frontier/config.mjs';

function fixture(t, extra = []) {
  const dir = mkdtempSync(path.join(tmpdir(), 'relay-resume-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const args = ['--program', 'test-program', '--season', '7', '--state-file', path.join(dir, 'relay-state.json'),
    '--master-seed-file', path.join(dir, 'relay-master.seed'), '--invite-secret-file', path.join(dir, 'invite.secret'), ...extra];
  const cfg = loadFrontierConfig(args);
  const masterSeed = Buffer.alloc(32, 0x11);
  const inviteSecret = Buffer.alloc(32, 0x22);
  // Fixed test bytes, removed with the temporary directory; no keypair is generated.
  writeFileSync(cfg.masterSeedFile, `${masterSeed.toString('hex')}\n`);
  writeFileSync(cfg.inviteSecretFile, `${inviteSecret.toString('hex')}\n`);
  const store = createStateStore(cfg.stateFile);
  store.state = {};
  persistInitialRelayState(store, cfg, { masterSeed, inviteSecret });
  const resume = loadFrontierConfig([...args, '--require-existing-state']);
  return { cfg, resume, store, dir };
}

test('resume flag and first-run state are explicit; an unused relay still has a saved quota and invite book', t => {
  const { cfg, resume, store } = fixture(t);
  assert.equal(cfg.requireExistingState, false);
  assert.equal(resume.requireExistingState, true);
  assert.ok(existsSync(cfg.stateFile));
  assert.deepEqual(store.load().quota, {});
  assert.deepEqual(store.state.invitesUsed, {});
  assert.equal(store.state.runIdentity.programId, cfg.programId);
  assert.equal(store.state.runIdentity.seasonId, String(cfg.seasonId));
  assert.doesNotThrow(() => requireExistingRelayFiles(resume));
  store.state.quota['citizen:test'] = { day: 2, left: 3, lamports: 14 };
  store.state.invitesUsed['11'.repeat(12)] = 123;
  store.save();
  const reloaded = createStateStore(cfg.stateFile);
  reloaded.load();
  assert.equal(reloaded.state.quota['citizen:test'].left, 3);
  assert.equal(reloaded.state.invitesUsed['11'.repeat(12)], 123);
  assert.doesNotThrow(() => requireExistingRelayFiles(resume));
  assert.deepEqual(readdirSync(path.dirname(cfg.stateFile)).filter(name => name.endsWith('.tmp')), []);
  assert.equal(statSync(cfg.stateFile).mode & 0o777, 0o600);
});

test('resume rejects malformed budget, used-invite and faucet values while accepting valid records', t => {
  const { resume, store } = fixture(t, ['--prize-program', 'test-prize', '--prize-mint', 'test-mint']);
  const good = structuredClone(store.state);
  const signature = '1'.repeat(64); // fixed 64-byte test value
  good.quota['citizen:valid'] = { day: 2, left: 3, lamports: 14 };
  good.invitesUsed['ab'.repeat(12)] = 123;
  good.faucet['11111111111111111111111111111111'] = { status: 'pending', amount: '100000000', signature, at: 123 };
  good.claimPending['11111111111111111111111111111111'] = { status: 'pending', signature, at: 123 };
  good.relayPending['msg:' + 'ab'.repeat(32)] = { status: 'unknown', signature, lastValidBlockHeight: 123,
    kind: 'Harvest', quotaKey: 'citizen:valid', day: 2, moved: '1000' };
  assert.doesNotThrow(() => validateRelayRecords(good, { prize: true }));
  const bad = [
    s => { s.quota['citizen:valid'].left = -1; },
    s => { s.quota['citizen:valid'].left = Number.MAX_SAFE_INTEGER; },
    s => { s.quota['citizen:valid'].lamports = -2; },
    s => { s.quota['citizen:valid'].day = 1.5; },
    s => { s.invitesUsed['not-a-nonce'] = 123; },
    s => { s.invitesUsed['ab'.repeat(12)] = 'yesterday'; },
    s => { s.faucet['11111111111111111111111111111111'].amount = '-1'; },
    s => { s.faucet['11111111111111111111111111111111'].amount = '18446744073709551616'; },
    s => { s.faucet['11111111111111111111111111111111'].at = null; },
    s => { s.faucet['11111111111111111111111111111111'].status = 'cleared'; },
    s => { s.claimPending['11111111111111111111111111111111'].status = 'cleared'; },
    s => { s.relayPending['msg:' + 'ab'.repeat(32)].status = 'cleared'; },
    s => { s.relayPending['msg:' + 'ab'.repeat(32)].moved = '-1'; },
  ];
  for (const mutate of bad) {
    const state = structuredClone(good);
    mutate(state);
    writeFileSync(resume.stateFile, JSON.stringify(state));
    assert.throws(() => requireExistingRelayFiles(resume), /invalid; refusing resume/);
  }
});

test('agent resume refuses a missing or malformed signed-deposit journal', () => {
  const signature = '1'.repeat(64); // fixed test bytes, not a generated key
  const good = { agents: { agent1: {} }, deposits: {}, ownerNonces: {}, depositSends: { [signature]: {
    agentId: 'agent1', signature, ownerSignature: signature, amount: '123', lastValidBlockHeight: 150,
    slotFloor: 9, state: 'pending', at: 123,
  } } };
  assert.doesNotThrow(() => validateAgentDepositSends(good));
  assert.throws(() => validateAgentDepositSends({ agents: good.agents }), /signed-deposit records/);
  for (const mutate of [
    s => { s.depositSends[signature].signature = 'wrong'; },
    s => { s.depositSends[signature].ownerSignature = 'wrong'; },
    s => { s.depositSends[signature].amount = '-1'; },
    s => { s.depositSends[signature].agentId = 'missing'; },
    s => { s.depositSends[signature].state = 'cleared'; },
    s => { s.depositSends[signature].lastValidBlockHeight = -1; },
  ]) {
    const state = structuredClone(good);
    mutate(state);
    assert.throws(() => validateAgentDepositSends(state), /signed-deposit record/);
  }
});

test('resume rejects a missing, malformed, or wrong-run relay state without creating a replacement', t => {
  const { resume, store } = fixture(t);
  writeFileSync(resume.stateFile, 'not json');
  assert.throws(() => requireExistingRelayFiles(resume), SyntaxError);
  writeFileSync(resume.stateFile, JSON.stringify({ quota: {}, invitesUsed: {} }));
  assert.throws(() => requireExistingRelayFiles(resume), /identity/);
  const good = store.state;
  for (const [field, value] of [['quota', []], ['invitesUsed', null]]) {
    writeFileSync(resume.stateFile, JSON.stringify({ ...good, [field]: value }));
    assert.throws(() => requireExistingRelayFiles(resume), /records/);
  }
  writeFileSync(resume.stateFile, JSON.stringify({ ...good, runIdentity: { ...good.runIdentity, seasonId: '8' } }));
  assert.throws(() => requireExistingRelayFiles(resume), /identity/);
  rmSync(resume.stateFile);
  assert.throws(() => requireExistingRelayFiles(resume), /missing/);
  assert.equal(existsSync(resume.stateFile), false);
});

test('resume rejects a changed or missing payer seed and a missing join-gate key', t => {
  const { resume } = fixture(t);
  writeFileSync(resume.masterSeedFile, `${'33'.repeat(32)}\n`);
  assert.throws(() => requireExistingRelayFiles(resume), /secrets disagree/);
  rmSync(resume.masterSeedFile);
  assert.throws(() => requireExistingRelayFiles(resume), /does not exist/);
  assert.equal(existsSync(resume.masterSeedFile), false);
  const gateCfg = { ...resume, gateKeyFile: path.join(path.dirname(resume.stateFile), 'missing-gate.json') };
  writeFileSync(resume.masterSeedFile, `${'11'.repeat(32)}\n`);
  assert.throws(() => requireExistingRelayFiles(gateCfg), /join gate key is missing/);
  assert.equal(existsSync(gateCfg.gateKeyFile), false);
  writeFileSync(gateCfg.gateKeyFile, '[1]');
  assert.throws(() => requireExistingRelayFiles(gateCfg), /join gate key is invalid/);
});

test('a prize relay saves empty faucet history; resume rejects its loss and missing agent wallet state', t => {
  const { resume } = fixture(t, ['--prize-program', 'test-prize', '--prize-mint', 'test-mint']);
  const state = JSON.parse(readFileSync(resume.stateFile, 'utf8'));
  assert.deepEqual(state.faucet, {});
  assert.doesNotThrow(() => requireExistingRelayFiles(resume));
  delete state.faucet;
  writeFileSync(resume.stateFile, JSON.stringify(state));
  assert.throws(() => requireExistingRelayFiles(resume), /faucet records/);
  state.faucet = {};
  writeFileSync(resume.stateFile, JSON.stringify(state));
  const agentCfg = { ...resume, agentWallet: true, agentStateFile: path.join(path.dirname(resume.stateFile), 'agent-wallet.json') };
  assert.throws(() => requireExistingRelayFiles(agentCfg), /agent wallet state is missing/);
  assert.equal(existsSync(agentCfg.agentStateFile), false);
});

test('normal startup refuses old relay and agent journals before a listener or replacement key is created', async t => {
  const { cfg, store, dir } = fixture(t);
  const { startFrontierRelay, startAgentWallet } = await import('../src/frontier/server.mjs');
  const oldRelay = structuredClone(store.state);
  delete oldRelay.relayPending;
  writeFileSync(cfg.stateFile, JSON.stringify(oldRelay));
  await assert.rejects(startFrontierRelay(cfg, { connection: {} }), /records are invalid; refusing resume/);
  assert.equal(readFileSync(cfg.stateFile, 'utf8'), JSON.stringify(oldRelay));

  const agentStateFile = path.join(dir, 'agent-wallet.json');
  const agentCfg = { ...cfg, agentWallet: true, agentStateFile, agentCustodyKeyFile: path.join(dir, 'missing-custody.key') };
  writeFileSync(agentStateFile, JSON.stringify({ runIdentity: {
    programId: cfg.programId, seasonId: String(cfg.seasonId), prizeProgram: null, prizeMint: null,
  }, agentWallet: { agents: {}, deposits: {}, ownerNonces: {} } }));
  assert.throws(() => startAgentWallet(agentCfg, {}, { connection: {}, pool: {} }), /signed-deposit records are invalid; refusing resume/);
  assert.equal(existsSync(agentCfg.agentCustodyKeyFile), false);
  assert.equal(existsSync(`${agentStateFile}.lock`), false);
});
