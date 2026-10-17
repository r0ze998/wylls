// The review of 2026-10-17 (docs/agent-wallet/DESIGN.md §5.1, §6.1):
// 1. what a model-driven action costs, exactly: the fixed inference price
//    per call, never a game or network charge, with the shipped defaults;
// 2. deposits: nothing is credited without a confirmed, successful,
//    classic-SPL-Token TransferChecked of the custody mint into the custody
//    account by the owner, read with its result metadata; one signature is
//    credited once across agents and across restarts; strict mode refuses a
//    node without token balances;
// 3. stops racing with sends: a stop after the send rolls nothing back, a
//    stop during a model call still charges the call and refuses what it
//    decided, a stop-and-restart while a request is in flight refuses it
//    (epoch), and a request without modeEpoch is refused the same way;
// 4. the delegation the chain holds is reported next to the server's mode.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, PublicKey } from '@solana/web3.js';
import { encode as base58 } from '../client/src/base58.mjs';
import { ata, TOKEN_PROGRAM } from '../client/src/frontier/prize.mjs';
import { ERR } from '../src/frontier/agent/contract.mjs';
import { DEFAULT_INFERENCE_PRICE } from '../src/frontier/agent/gateway.mjs';
import { llmDecider, ruleDecider, runOnce } from '../src/frontier/agent/runner.mjs';
import { FRONTIER_DEFAULTS, loadFrontierConfig } from '../src/frontier/config.mjs';
import { A, actionRequest, call, createAgent, delegate, deposit, depositTx, fakeChain, MINT, ownerCommand, policy, relay, sound } from './agent-wallet-fixtures.mjs';

const IP = '127.0.0.1';
const post = (r, path, body) => call(r.public, 'POST', path, { body, ip: IP });
const get = (r, path) => call(r.public, 'GET', path, { ip: IP });
const slow = (f, ms = 5) => async (...a) => { await new Promise(res => setTimeout(res, ms)); return f(...a); };

async function ready(r, { balance = 100_000n, policy: p = policy(['economy'], '1000000', '1000000') } = {}) {
  const owner = Keypair.generate();
  const o = owner.publicKey.toBase58();
  const made = await createAgent(r, owner, { policy: p });
  if (balance > 0n) await deposit(r, o, made.agentId, balance);
  delegate(r, o, made.agentKey);
  const m = await post(r, '/f/agent/command', ownerCommand(owner, 'mode', { agentId: made.agentId, params: { mode: 'auto' } }));
  assert.equal(m.status, 200, JSON.stringify(m.json));
  return { owner, o, ...made, act: (over = {}) => r.gateway.submit(actionRequest(made.agentId, over), { capability: made.capability }) };
}

test('1. billing: with the shipped defaults a model-chosen action costs exactly one inference price; game and network never charge; the autopilot costs nothing', async () => {
  // The defaults as shipped (not a test override): 10,000 base units per model call, no game price table.
  assert.equal(DEFAULT_INFERENCE_PRICE, '10000');
  assert.equal(FRONTIER_DEFAULTS.agentInferencePrice, 10_000);
  assert.equal(FRONTIER_DEFAULTS.agentGamePricesFile, null);
  const cfg = loadFrontierConfig(['--program', 'x', '--season', '1', '--agent-wallet', '--prize-program', 'p', '--prize-mint', 'm']);
  assert.deepEqual([cfg.agentInferencePrice, cfg.agentGamePricesFile], [10_000, null]);
  const r = relay(); // no prices passed: the gateway's defaults (inference 10,000; game {})
  assert.deepEqual(r.gateway.prices, { inference: '10000', game: {} });
  const a = await ready(r, { balance: 100_000n });
  const llm = { alias: 'fake', async complete() { return { ok: true, content: JSON.stringify({ action: 'Harvest', fields: {}, reason: 'x' }), usage: { prompt_tokens: 40, completion_tokens: 6 } }; } };
  for (let i = 0; i < 2; i++) {
    const out = await runOnce(r.gateway, a.agentId, llmDecider({ llm }), { tick: 1_000 + i });
    assert.deepEqual([out.decided, out.charged, out.result.status], ['Harvest', '10000', 'sent']);
  }
  const v = r.gateway.view(a.agentId);
  // The breakdown of the 20,000: two model calls, nothing else.
  assert.deepEqual(v.balance.spent, { inference: '20000', network: '0', game: '0' });
  const spends = v.history.filter(h => h.type === 'spend');
  assert.equal(spends.length, 2);
  assert.ok(spends.every(h => h.category === 'inference' && h.amount === '10000' && h.model === 'model:fake'));
  const fees = v.history.filter(h => h.type === 'network');
  assert.equal(fees.length, 2, 'one network line per sent action');
  assert.ok(fees.every(h => h.amount === '0' && h.paidBy === 'relay' && BigInt(h.lamports) === 10_000n), 'the relay paid two signatures\' base fee; nothing in USDC');
  assert.equal(r.chain.sent.length, 2);
  // The autopilot: the same action, no charge at all.
  const free = await runOnce(r.gateway, a.agentId, ruleDecider(), { tick: 2_000 });
  assert.deepEqual([free.decided, free.charged, free.result.status], ['Harvest', '0', 'sent']);
  assert.deepEqual(r.gateway.view(a.agentId).balance.spent, { inference: '20000', network: '0', game: '0' });
  // Every delegable action an owner may allow is free unless the (empty) table names it: holds of zero, nothing spent.
  const b = await ready(r, { balance: 50_000n, policy: policy(['economy', 'explore', 'military', 'vigil']) });
  for (const [name, fields] of [['Harvest', {}], ['Build', { item: 1 }], ['Train', { unit: 1, n: 2 }], ['Muster', { unit: 0, troops: 1, tile: 3 }], ['Garrison', { delta: 1 }], ['SetVigil', { start_min: 10 }], ['Dissolve', { host_id: '1' }]]) {
    const res = await b.act({ name, fields, key: `free-${name}` });
    assert.equal(res.status, 'sent', `${name}: ${JSON.stringify(res)}`);
    assert.deepEqual(res.charges, [], name);
  }
  assert.deepEqual(r.gateway.view(b.agentId).balance, { available: '50000', reserved: '0', pendingWithdraw: '0', withdrawn: '0', deposited: '50000', spent: { inference: '0', network: '0', game: '0' } });
  assert.equal(r.gateway.view(b.agentId).history.filter(h => h.type === 'spend').length, 0, 'no USDC spend line for a free action');
  // A price table entry (operator config, not shipped) is the only way a game action charges.
  const priced = relay({ prices: { game: { Harvest: '7' } } });
  const c = await ready(priced, { balance: 100n });
  assert.deepEqual((await c.act({ key: 'p' })).charges, [{ category: 'game', amount: '7', state: 'reserved' }]);
  sound(r);
  sound(priced);
});

test('2. deposits: credited only from a confirmed, successful, classic-SPL-Token TransferChecked into the custody account by the owner, once across agents and restarts', async () => {
  const r = relay();
  const owner = Keypair.generate();
  const o = owner.publicKey.toBase58();
  const { agentId } = await createAgent(r, owner);
  const refuse = async (what, over, code = ERR.DEPOSIT_INVALID) => {
    const bad = await deposit(r, o, agentId, 100_000n, over).catch(e => ({ res: e }));
    assert.equal(bad.res.code, code, `${what}: ${JSON.stringify(bad.res)}`);
  };
  // No result metadata yet: pending, never credited.
  const sigNoMeta = base58(Buffer.alloc(64, 9));
  const noMeta = depositTx({ owner: o, custody: r.custody, amount: 100_000n });
  delete noMeta.meta;
  r.chain.transactions.set(sigNoMeta, noMeta);
  await assert.rejects(r.gateway.deposit(agentId, sigNoMeta), e => e.code === ERR.DEPOSIT_PENDING);
  // Another program with the same instruction bytes (not the classic SPL Token program).
  const other = Keypair.generate().publicKey.toBase58();
  const sigProg = base58(Buffer.alloc(64, 10));
  const prog = depositTx({ owner: o, custody: r.custody, amount: 100_000n });
  prog.transaction.message.staticAccountKeys.push(new PublicKey(other));
  prog.transaction.message.compiledInstructions[0].programIdIndex = prog.transaction.message.staticAccountKeys.length - 1;
  r.chain.transactions.set(sigProg, prog);
  await assert.rejects(r.gateway.deposit(agentId, sigProg), e => e.code === ERR.DEPOSIT_INVALID);
  // The transfer only inside a CPI (an inner instruction of some other program): not read, not credited.
  const sigInner = base58(Buffer.alloc(64, 11));
  const inner = depositTx({ owner: o, custody: r.custody, amount: 100_000n });
  inner.meta.innerInstructions = [{ index: 0, instructions: inner.transaction.message.compiledInstructions }];
  inner.transaction.message.staticAccountKeys.push(new PublicKey(other));
  inner.transaction.message.compiledInstructions = [{ programIdIndex: inner.transaction.message.staticAccountKeys.length - 1, accountKeyIndexes: [], data: new Uint8Array([1]) }];
  r.chain.transactions.set(sigInner, inner);
  await assert.rejects(r.gateway.deposit(agentId, sigInner), e => e.code === ERR.DEPOSIT_INVALID);
  // The transaction's own result: an error, a missing owner signature, another authority, destination or mint, a zero amount.
  await refuse('failed', { err: { InstructionError: [1, { Custom: 1 }] } });
  await refuse('owner not a signer', { signers: [other] });
  await refuse('another authority', { authority: other, signers: [o, other] });
  await refuse('another destination', { dest: ata(other, MINT) });
  await refuse('another mint', { mint: Keypair.generate().publicKey.toBase58() });
  await refuse('no transfer', { transfer: false });
  const sigZero = base58(Buffer.alloc(64, 12));
  r.chain.transactions.set(sigZero, depositTx({ owner: o, custody: r.custody, amount: 0n }));
  await assert.rejects(r.gateway.deposit(agentId, sigZero), e => e.code === ERR.DEPOSIT_INVALID);
  assert.equal(r.gateway.view(agentId).balance.deposited, '0', 'nothing above was credited');
  // Two transfers in one transaction add up; a validator's balances must agree with that sum.
  const sigTwo = base58(Buffer.alloc(64, 13));
  const two = depositTx({ owner: o, custody: r.custody, amount: 30_000n, balances: true, gained: 60_000n });
  two.transaction.message.compiledInstructions.push({ ...two.transaction.message.compiledInstructions[0] });
  r.chain.transactions.set(sigTwo, two);
  assert.equal((await r.gateway.deposit(agentId, sigTwo)).amount, '60000');
  await refuse('balances disagree', { balances: true, gained: 1n });
  // Once, ever: the same signature again, for another agent of the owner, and after a restart from the saved state.
  const { sig } = await deposit(r, o, agentId, 100_000n);
  assert.equal(r.gateway.view(agentId).balance.deposited, '160000');
  const { agentId: second } = await createAgent(r, owner);
  for (const id of [agentId, second]) {
    const again = await post(r, '/f/agent/deposit', { agentId: id, signature: sig });
    assert.deepEqual([again.json.credited, again.json.already, again.json.agentId], [false, true, agentId], id);
  }
  const restarted = relay({ chain: r.chain, agentState: JSON.parse(JSON.stringify(r.agentStore.state)) });
  const afterRestart = await post(restarted, '/f/agent/deposit', { agentId, signature: sig });
  assert.deepEqual([afterRestart.json.credited, afterRestart.json.already], [false, true]);
  assert.equal(restarted.gateway.view(agentId).balance.deposited, '160000');
  assert.equal(restarted.gateway.view(second).balance.deposited, '0');
  // Strict mode (a full validator): a node without token balances is refused; with them the same deposit passes.
  const strict = relay();
  strict.custody.strictBalances = true;
  const w = Keypair.generate();
  const { agentId: sid } = await createAgent(strict, w);
  const bare = await deposit(strict, w.publicKey.toBase58(), sid, 100_000n).catch(e => ({ res: e }));
  assert.equal(bare.res.code, ERR.DEPOSIT_INVALID);
  assert.match(bare.res.message, /token balances/);
  assert.equal((await deposit(strict, w.publicKey.toBase58(), sid, 100_000n, { balances: true })).res.credited, true);
  sound(r);
  sound(restarted);
  sound(strict);
});

test('3. stops racing with sends: after the send nothing is rolled back; during a model call the call is charged and its action refused; a stop-and-restart in flight refuses (epoch), with or without modeEpoch in the request', async () => {
  // A priced action sent, then the owner stops: the result stays sent, the hold waits for the chain and settles.
  const r = relay({ prices: { inference: '10000', game: { Harvest: '1000' } } });
  const a = await ready(r, { balance: 50_000n });
  const sent = await a.act({ key: 's1' });
  assert.equal(sent.status, 'sent');
  await post(r, '/f/agent/command', ownerCommand(a.owner, 'mode', { agentId: a.agentId, params: { mode: 'manual' } }));
  assert.equal(r.gateway.view(a.agentId).balance.reserved, '1000', 'the sent action\'s hold is not released by the stop');
  assert.equal(r.chain.sent.length, 1);
  assert.equal((await r.gateway.reconcile()).settled, 1);
  assert.equal(r.gateway.view(a.agentId).balance.spent.game, '1000', 'what landed is spent, not rolled back');
  assert.equal((await a.act({ key: 's1' })).status, 'sent', 'the recorded answer stays');
  // A stop during the model call: the call is still charged; what it decided is refused.
  await post(r, '/f/agent/command', ownerCommand(a.owner, 'mode', { agentId: a.agentId, params: { mode: 'auto' } }));
  const epoch = r.gateway.view(a.agentId).modeEpoch;
  let release;
  const gate = new Promise(res => { release = res; });
  const llm = { alias: 'slow', async complete() { await gate; return { ok: true, content: JSON.stringify({ action: 'Harvest', fields: {}, reason: 'x' }), usage: null }; } };
  const pending = runOnce(r.gateway, a.agentId, llmDecider({ llm }), { tick: 7 });
  await new Promise(res => setTimeout(res, 5));
  assert.equal(r.gateway.view(a.agentId).balance.reserved, '10000', 'the model call is held while it runs');
  r.gateway.setMode(a.agentId, a.o, 'manual');
  release();
  const out = await pending;
  assert.deepEqual([out.decided, out.charged, out.result.status, out.result.error.code], ['Harvest', '10000', 'refused', ERR.AGENT_STOPPED]);
  assert.equal(r.gateway.view(a.agentId).balance.spent.inference, '10000', 'the call that ran is paid for');
  assert.equal(r.chain.sent.length, 1, 'nothing sent after the stop');
  // Stop and restart while a request is between its hold and its send: the epoch moved, so it is refused, with or without modeEpoch.
  for (const withEpoch of [true, false]) {
    const chain = fakeChain();
    chain.getBalance = slow(chain.getBalance, 10);
    const rr = relay({ chain, prices: { game: { Harvest: '1000' } } });
    const b = await ready(rr, { balance: 5_000n });
    const e0 = rr.gateway.view(b.agentId).modeEpoch;
    const inflight = b.act({ key: 'x', ...(withEpoch ? { modeEpoch: e0 } : {}) });
    await new Promise(res => setTimeout(res, 3));
    rr.gateway.setMode(b.agentId, b.o, 'manual');
    rr.gateway.setMode(b.agentId, b.o, 'auto');
    assert.equal(rr.gateway.view(b.agentId).mode, 'auto');
    const res = await inflight;
    assert.equal(res.status, 'refused', `epoch ${withEpoch}`);
    assert.equal(res.error.code, ERR.AGENT_STOPPED);
    assert.equal(chain.sent.length, 0);
    assert.deepEqual([rr.gateway.view(b.agentId).balance.available, rr.gateway.view(b.agentId).balance.reserved], ['5000', '0']);
    // A new request under the new epoch goes through; the old epoch is refused up front.
    assert.equal((await b.act({ key: 'y', modeEpoch: e0 })).error.code, ERR.STALE_MODE);
    assert.equal((await b.act({ key: 'z' })).status, 'sent');
    sound(rr);
  }
  sound(r);
});

test('4. the chain\'s delegation is reported next to the server\'s mode: a stop does not revoke it, the owner\'s SetSession does', async () => {
  const r = relay();
  const owner = Keypair.generate();
  const o = owner.publicKey.toBase58();
  const { agentId, agentKey } = await createAgent(r, owner);
  const d0 = (await get(r, `/f/agent?id=${agentId}`)).json.delegation;
  assert.deepEqual([d0.citizen, d0.delegated], [false, false], 'no Citizen yet');
  delegate(r, o, agentKey);
  const d1 = (await get(r, `/f/agent?id=${agentId}`)).json.delegation;
  assert.deepEqual([d1.citizen, d1.delegated, d1.session], [true, true, agentKey]);
  await post(r, '/f/agent/command', ownerCommand(owner, 'mode', { agentId, params: { mode: 'auto' } }));
  await post(r, '/f/agent/command', ownerCommand(owner, 'mode', { agentId, params: { mode: 'manual' } }));
  const d2 = (await get(r, `/f/agent?id=${agentId}`)).json;
  assert.equal(d2.mode, 'manual');
  assert.equal(d2.delegation.delegated, true, 'the server-side stop leaves the chain\'s delegation in place');
  const ownKey = Keypair.generate().publicKey.toBase58();
  delegate(r, o, ownKey);
  const d3 = (await get(r, `/f/agent?id=${agentId}`)).json.delegation;
  assert.deepEqual([d3.delegated, d3.session], [false, ownKey]);
  delegate(r, o, agentKey, { expiry: 1 });
  assert.equal((await get(r, `/f/agent?id=${agentId}`)).json.delegation.delegated, false, 'expired');
  assert.equal((await get(r, `/f/agent/session-terms?id=${agentId}`)).json.agentKey, agentKey);
});
