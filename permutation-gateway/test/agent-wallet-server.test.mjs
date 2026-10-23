// The agent wallet's wiring: config flags and checks, the relay process
// with --agent-wallet (its own state file, the custody key and agent keys
// as 0600 files, the reconcile timer), the ledger's own invariants.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Keypair } from '@solana/web3.js';
import { CLOCK_SYSVAR, FrontierAddresses } from '../client/src/frontier/addresses.mjs';
import { encodeAccount } from '../client/src/frontier/codec.mjs';
import { AgentLedger, budgetDay } from '../src/frontier/agent/ledger.mjs';
import { ERR } from '../src/frontier/agent/contract.mjs';
import { checkFrontierConfig, loadFrontierConfig } from '../src/frontier/config.mjs';
import { startFrontierRelay } from '../src/frontier/server.mjs';
import { clockAccount, fakeChain, GENESIS, ownerCommand, policy, seasonAccount, VILLAGE } from './agent-wallet-fixtures.mjs';

test('config: --agent-wallet and --agent-runner flags, their environment names and their checks', () => {
  const base = ['--program', Keypair.generate().publicKey.toBase58(), '--season', '5'];
  const off = loadFrontierConfig(base);
  assert.equal(off.agentWallet, false);
  assert.equal(off.agentRunner, false);
  assert.equal(off.agentInferencePrice, 10_000);
  const on = loadFrontierConfig([...base, '--agent-wallet', '--prize-program', 'p', '--prize-mint', 'm', '--agent-inference-price', '2500', '--agent-runner', '--agent-tick-ms', '5000', '--agent-llm', 'http://127.0.0.1:41901']);
  assert.deepEqual([on.agentWallet, on.agentRunner, on.agentInferencePrice, on.agentTickMs, on.agentLlmUrl], [true, true, 2500, 5000, 'http://127.0.0.1:41901']);
  const env = loadFrontierConfig(base, { FRONTIER_AGENT_WALLET: '1', FRONTIER_PRIZE_PROGRAM: 'p', FRONTIER_PRIZE_MINT: 'm', FRONTIER_AGENT_KEYS_DIR: '/tmp/k' });
  assert.deepEqual([env.agentWallet, env.agentKeysDir], [true, '/tmp/k']);
  // The model name the runner records: the pinned Gemma 4 alias by default; another loaded model is named by the operator, never assumed.
  assert.equal(off.agentLlmAlias, 'gemma-4-26b-a4b-it');
  assert.equal(loadFrontierConfig(base, { FRONTIER_AGENT_LLM_ALIAS: 'gemma-3-4b-it' }).agentLlmAlias, 'gemma-3-4b-it');
  assert.throws(() => loadFrontierConfig([...base, '--agent-wallet']), /--prize-mint/);
  assert.throws(() => loadFrontierConfig([...base, '--agent-runner']), /--agent-wallet/);
  assert.throws(() => loadFrontierConfig([...base, '--agent-wallet', '--prize-program', 'p', '--prize-mint', 'm', '--cluster', 'devnet']), /localnet only/);
  assert.throws(() => loadFrontierConfig([...base, '--agent-llm', 'http://10.0.0.2:8080']), /loopback only/);
  assert.ok(checkFrontierConfig({ ...on, agentTickMs: 10 }).some(e => /agent-tick-ms/.test(e)));
  assert.ok(checkFrontierConfig({ ...on, agentReconcileMs: 10 }).some(e => /agent-reconcile-ms/.test(e)));
  // The proposed call controls carry test defaults; the unresolved deadline is off unless given.
  assert.deepEqual([on.agentMinCallGapMs, on.agentOwnerCallGapMs, on.agentMaxCallsPerDay, on.agentUnresolvedReleaseMs], [60_000, 10_000, 200, null]);
  assert.equal(loadFrontierConfig([...base, '--agent-owner-call-gap-ms', '2500']).agentOwnerCallGapMs, 2500);
  assert.equal(loadFrontierConfig(base, { FRONTIER_AGENT_OWNER_CALL_GAP_MS: '4000' }).agentOwnerCallGapMs, 4000);
  const tuned = loadFrontierConfig([...base, '--agent-min-call-gap-ms', '30000', '--agent-max-calls-per-day', '50', '--agent-unresolved-release-ms', '3600000']);
  assert.deepEqual([tuned.agentMinCallGapMs, tuned.agentMaxCallsPerDay, tuned.agentUnresolvedReleaseMs], [30_000, 50, 3_600_000]);
});

test('the relay process with --agent-wallet: its own state file, 0600 key files, the routes live; without the flag the routes are 404', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agent-relay-'));
  const program = Keypair.generate().publicKey.toBase58();
  const a = new FrontierAddresses({ programId: program, seasonId: 5n });
  const chain = fakeChain();
  chain.set(a.season, { data: seasonAccount() });
  chain.set(CLOCK_SYSVAR, { data: clockAccount(GENESIS + 3_600) });
  const argv = ['--program', program, '--season', '5', '--port', '0', '--public-port', '0', '--dev', '--pool-size', '3', '--master-seed-file', path.join(dir, 'seed'),
    '--invite-secret-file', path.join(dir, 'inv'), '--state-file', path.join(dir, 'state.json'), '--prize-program', Keypair.generate().publicKey.toBase58(), '--prize-mint', Keypair.generate().publicKey.toBase58()];
  const prices = path.join(dir, 'prices.json');
  writeFileSync(prices, JSON.stringify({ Harvest: '0' }));
  const cfg = loadFrontierConfig([...argv, '--agent-wallet', '--agent-custody-key-file', path.join(dir, 'custody.json'), '--agent-keys-dir', path.join(dir, 'keys'), '--agent-game-prices-file', prices, '--agent-reconcile-ms', '1000']);
  const logs = [];
  const relay = await startFrontierRelay(cfg, { connection: chain, log: m => logs.push(m) });
  try {
    assert.ok(relay.ctx.agents, 'attached');
    for (const k of relay.ctx.pool.publicKeys()) chain.set(k, { lamports: 2_000_000_000 });
    assert.equal(relay.agents.scheduler, null, 'no runner without --agent-runner');
    assert.equal(statSync(path.join(dir, 'custody.json')).mode & 0o777, 0o600);
    assert.ok(logs.some(l => l.startsWith('agent wallet: custody ') && !l.includes('secret')));
    const base = `http://127.0.0.1:${relay.ports.operator}`;
    const terms = await (await fetch(`${base}/f/agent/terms`)).json();
    assert.equal(terms.custodyAccount, relay.ctx.agents.custody.account);
    assert.deepEqual(terms.prices.game, { Harvest: '0' });
    const owner = Keypair.generate();
    const made = await (await fetch(`${base}/f/agent/command`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(ownerCommand(owner, 'create', { params: { village: VILLAGE, policy: policy() } })) })).json();
    assert.ok(made.agent?.agentId, JSON.stringify(made));
    const stateFile = path.join(dir, 'agent-wallet.json');
    assert.ok(existsSync(stateFile), 'the ledger has its own file next to the relay state');
    const saved = JSON.parse(readFileSync(stateFile, 'utf8'));
    assert.ok(saved.agentWallet.agents[made.agent.agentId]);
    assert.equal(JSON.stringify(saved).includes(made.capability.token), false);
    assert.ok(!existsSync(path.join(dir, 'state.json')) || JSON.parse(readFileSync(path.join(dir, 'state.json'), 'utf8')).agentWallet === undefined, 'not in the relay\'s own state');
    const keyFile = path.join(dir, 'keys', `${made.agent.agentId}.key`);
    assert.equal(statSync(keyFile).mode & 0o777, 0o600);
    assert.equal(readFileSync(keyFile, 'utf8').trim().length, 64, 'a 32-byte seed in hex');
  } finally {
    await relay.close();
  }
  // Off: the routes answer 404 and no agent file is made.
  const off = await startFrontierRelay(loadFrontierConfig([...argv, '--state-file', path.join(dir, 'state2.json')]), { connection: chain, log: () => {} });
  try {
    assert.equal(off.ctx.agents, undefined);
    assert.equal((await fetch(`http://127.0.0.1:${off.ports.operator}/f/agent/terms`)).status, 404);
  } finally {
    await off.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ledger: holds, settlement, release, expiry, the daily roll, deposits once, withdrawals and the invariant check', () => {
  let t = Date.UTC(2026, 9, 17, 12);
  const store = { state: {}, saves: 0, save() { this.saves++; } };
  const L = new AgentLedger({ store, now: () => t });
  const owner = Keypair.generate().publicKey.toBase58();
  const rec = L.create({ agentId: 'a1', owner, agentKey: Keypair.generate().publicKey.toBase58(), village: VILLAGE, policy: policy(['Harvest'], '9000', '5000') });
  assert.equal(rec.policy.version, 1);
  assert.throws(() => L.create({ agentId: 'a1', owner, agentKey: 'k', village: VILLAGE, policy: policy() }), e => e.status === 409);
  assert.throws(() => L.get('nope'), e => e.code === ERR.UNKNOWN_AGENT);
  assert.deepEqual(L.credit('a1', 'sig1', '10000'), { credited: true, agentId: 'a1', amount: '10000' });
  assert.deepEqual(L.credit('a1', 'sig1', '10000'), { credited: false, agentId: 'a1', amount: '10000' });
  assert.throws(() => L.credit('a1', 'sig2', '0'), e => e.code === ERR.DEPOSIT_INVALID);
  assert.throws(() => L.hold('a1', { category: 'nope', amount: '1', key: 'x' }), e => e.code === ERR.BAD_REQUEST);
  assert.throws(() => L.hold('a1', { category: 'game', amount: '10001', key: 'x' }), e => e.code === ERR.INSUFFICIENT_BALANCE);
  const h1 = L.hold('a1', { category: 'game', amount: '4000', key: 'k1', ttlMs: 1_000 });
  assert.throws(() => L.hold('a1', { category: 'game', amount: '1001', key: 'k2' }), e => e.code === ERR.DAILY_LIMIT, 'held counts against the day');
  const h2 = L.hold('a1', { category: 'inference', amount: '1000', key: 'k2' });
  assert.deepEqual(L.balance('a1'), { available: '5000', reserved: '5000', unresolved: '0', pendingWithdraw: '0', withdrawn: '0', deposited: '10000', spent: { inference: '0', network: '0', game: '0' } });
  assert.deepEqual(L.check(), []);
  // Settle part of a hold: the rest comes back; settling twice is a no-op; outside the hold is refused.
  assert.throws(() => L.settle('a1', h1.id, '4001'), e => e.code === ERR.BAD_REQUEST);
  assert.equal(L.settle('a1', h1.id, '3000'), true);
  assert.equal(L.settle('a1', h1.id, '3000'), false);
  assert.deepEqual([L.balance('a1').available, L.balance('a1').reserved, L.balance('a1').spent.game], ['6000', '1000', '3000']);
  // Expiry gives back `held` holds only; a `sending` one waits.
  L.markSending('a1', h2.id, 'sig-x', 150);
  const h3 = L.hold('a1', { category: 'game', amount: '500', key: 'k3', ttlMs: 10 });
  t += 11;
  assert.equal(L.expire(), 1);
  assert.equal(L.get('a1').holds[h3.id], undefined);
  assert.equal(L.get('a1').holds[h2.id].state, 'sending');
  // The day rolls at UTC midnight: yesterday's spending no longer counts.
  assert.equal(budgetDay(t), '2026-10-17');
  t = Date.UTC(2026, 9, 18, 0, 0, 1);
  const h4 = L.hold('a1', { category: 'game', amount: '4000', key: 'k4' });
  assert.equal(L.get('a1').day.key, '2026-10-18');
  L.release('a1', h4.id, 'test');
  // The total budget counts settled and held: 3,000 spent + 1,000 held + 5,001 is over 9,000.
  assert.throws(() => L.hold('a1', { category: 'game', amount: '5001', key: 'k5' }), e => e.code === ERR.BUDGET_EXCEEDED);
  L.settle('a1', h2.id);
  // Withdrawals: pending → done, or failed with the money back.
  const w1 = L.holdWithdraw('a1', '2000');
  assert.throws(() => L.holdWithdraw('a1', '4001'), e => e.code === ERR.INSUFFICIENT_BALANCE);
  L.withdrawSending('a1', w1.id, 'sig-w', 160);
  assert.equal(L.finishWithdraw('a1', w1.id), true);
  assert.equal(L.finishWithdraw('a1', w1.id), false);
  const w2 = L.holdWithdraw('a1', '1000');
  assert.equal(L.failWithdraw('a1', w2.id, 'expired'), true);
  assert.deepEqual(L.balance('a1'), { available: '4000', reserved: '0', unresolved: '0', pendingWithdraw: '0', withdrawn: '2000', deposited: '10000', spent: { inference: '1000', network: '0', game: '3000' } });
  assert.deepEqual(L.check(), []);
  assert.equal(L.liabilities(), 4000n);
  // Mode and policy bump their counters; manual releases held holds.
  L.hold('a1', { category: 'game', amount: '100', key: 'k6' });
  L.setMode('a1', 'auto');
  L.setMode('a1', 'manual');
  assert.equal(L.get('a1').modeEpoch, 2);
  assert.equal(L.balance('a1').reserved, '0');
  assert.equal(L.setPolicy('a1', policy()).version, 2);
  // The check catches a broken book.
  L.get('a1').bal.available = '1';
  assert.ok(L.check()[0].includes('deposited'));
});

test('the runner\'s terms say which decision schema the model gets (the strict schema is opt-in; a run records which one it had)', async () => {
  for (const [flags, want] of [[[], 'loose'], [['--agent-llm-strict-schema'], 'strict'], [null, null]]) {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'agent-relay-'));
    const program = Keypair.generate().publicKey.toBase58();
    const a = new FrontierAddresses({ programId: program, seasonId: 5n });
    const chain = fakeChain();
    chain.set(a.season, { data: seasonAccount() });
    chain.set(CLOCK_SYSVAR, { data: clockAccount(GENESIS + 3_600) });
    const argv = ['--program', program, '--season', '5', '--port', '0', '--public-port', '0', '--dev', '--pool-size', '3', '--master-seed-file', path.join(dir, 'seed'),
      '--invite-secret-file', path.join(dir, 'inv'), '--state-file', path.join(dir, 'state.json'), '--prize-program', Keypair.generate().publicKey.toBase58(), '--prize-mint', Keypair.generate().publicKey.toBase58(),
      '--agent-wallet', '--agent-custody-key-file', path.join(dir, 'custody.json'), '--agent-keys-dir', path.join(dir, 'keys'), '--agent-runner', '--agent-tick-ms', '60000',
      ...(flags ? ['--agent-llm', 'http://127.0.0.1:41999', ...flags] : [])];
    const relay = await startFrontierRelay(loadFrontierConfig(argv), { connection: chain, log: () => {} });
    try {
      const terms = await (await fetch(`http://127.0.0.1:${relay.ports.operator}/f/agent/terms`)).json();
      assert.equal(terms.runner.schema, want, `${JSON.stringify(flags)}: ${JSON.stringify(terms.runner)}`);
      assert.equal(terms.runner.free, flags === null, 'no model: the free rule decider');
    } finally {
      await relay.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
