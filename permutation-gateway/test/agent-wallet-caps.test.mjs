// The two questions of the fourth round (docs/agent-wallet/DESIGN.md §6.5, §7.1):
//   1. a hold given back (a stop, a restart, the TTL, the deadline release, an operator refund) never gives the
//      day's model-call count back: the owner's callsPerDay and the operator's cap count attempts, so a release
//      cannot be used to call past them;
//   2. who settled an unresolved call is taken from the credential (the operator listener and its token), and the
//      caller's own label is kept apart as a claim.
// An owner change inside the minimum gap is answered once per owner gap, not once per tick; the caps hold for it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import { ERR } from '../src/frontier/agent/contract.mjs';
import { INFERENCE_HOLD_TTL_MS } from '../src/frontier/agent/gateway.mjs';
import { AgentScheduler, llmDecider } from '../src/frontier/agent/runner.mjs';
import { call, createAgent, delegate, deposit, OPERATOR, policy, relay, sound } from './agent-wallet-fixtures.mjs';

const PRICE = '10000';
const operator = (r, method, path, body, headers = {}) => call(r.operator, method, path, { body, headers: { authorization: `Bearer ${OPERATOR}`, ...headers } });
const gated = () => { let release; const gate = new Promise(res => { release = res; }); return { gate, release }; };

async function ready(r, { balance = 10_000_000n, policy: p = policy(['economy'], '100000000', '100000000') } = {}) {
  const owner = Keypair.generate();
  const o = owner.publicKey.toBase58();
  const made = await createAgent(r, owner, { policy: p });
  if (balance > 0n) await deposit(r, o, made.agentId, balance);
  delegate(r, o, made.agentKey);
  r.gateway.setMode(made.agentId, o, 'auto');
  return { owner, o, ...made };
}

test('a released hold never gives the day\'s call count back: stop, TTL, deadline release and an operator refund all leave the count; the cap then refuses', async () => {
  let t = Date.now();
  const r = relay({ prices: { inference: PRICE }, now: () => t, unresolvedReleaseMs: 3_600_000 });
  const a = await ready(r, { policy: { allowed: ['economy'], budget: { total: '100000000', perDay: '100000000', callsPerDay: 4 } } });
  const L = r.gateway.ledger;
  const calls = () => r.gateway.view(a.agentId).day.calls;
  // 1: held, then given back by a stop (manual).
  L.hold(a.agentId, { category: 'inference', amount: PRICE, key: 'k1' });
  r.gateway.setMode(a.agentId, a.o, 'manual');
  assert.equal(Object.keys(L.get(a.agentId).holds).length, 0, 'the stop released the held hold');
  assert.equal(calls(), 1);
  r.gateway.setMode(a.agentId, a.o, 'auto');
  // 2: running, past its TTL → unresolved → released by the deadline rule.
  const h2 = L.hold(a.agentId, { category: 'inference', amount: PRICE, key: 'k2', ttlMs: INFERENCE_HOLD_TTL_MS });
  L.markRunning(a.agentId, h2.id);
  t += INFERENCE_HOLD_TTL_MS + 1;
  L.expire();
  assert.equal(L.get(a.agentId).holds[h2.id].state, 'unresolved');
  t += 3_600_000 + 1;
  await r.gateway.reconcile();
  assert.equal(L.get(a.agentId).holds[h2.id], undefined, 'released at the deadline');
  assert.equal(calls(), 2);
  // 3: running, then a restart → unresolved → the operator refunds.
  const h3 = L.hold(a.agentId, { category: 'inference', amount: PRICE, key: 'k3' });
  L.markRunning(a.agentId, h3.id);
  L.markUnresolved(a.agentId, h3.id, 'restart');
  r.gateway.settleUnresolved(a.agentId, h3.id, 'refund', 'no request in the model log', { by: { via: 'test' } });
  assert.equal(calls(), 3);
  // 4: a plain release.
  const h4 = L.hold(a.agentId, { category: 'inference', amount: PRICE, key: 'k4' });
  L.release(a.agentId, h4.id, 'released');
  assert.equal(calls(), 4);
  // Every one of the four was given back: the money is whole, the count is full, the fifth attempt is refused.
  const b = r.gateway.view(a.agentId).balance;
  assert.deepEqual([b.available, b.reserved, b.spent.inference], ['10000000', '0', '0']);
  assert.throws(() => L.hold(a.agentId, { category: 'inference', amount: PRICE, key: 'k5' }), e => e.code === ERR.CALL_LIMIT);
  assert.equal(calls(), 4, 'a refused attempt is not counted either');
  // The scheduler's own cap reads the same count: it does not call.
  const llm = { alias: 'f', calls: 0, async complete() { this.calls++; return { ok: true, content: JSON.stringify({ action: 'rest', fields: {}, reason: '' }), usage: null }; } };
  const s = new AgentScheduler({ gateway: r.gateway, decider: llmDecider({ llm }), minCallGapMs: 0, maxCallsPerDay: 4, now: () => t, log: () => {} });
  assert.equal((await s.tick())[0].skipped, 'call-limit');
  assert.equal(llm.calls, 0);
  // The next UTC day starts the count again (the day is the budget's unit, not the release).
  t += 86_400_000;
  L.hold(a.agentId, { category: 'inference', amount: PRICE, key: 'k6' });
  assert.equal(calls(), 1);
  sound(r);
});

test('a burst of owner commands is one call per owner gap, the change is not lost, and the caps hold for owner changes too', async () => {
  let t = Date.now();
  const r = relay({ prices: { inference: PRICE }, now: () => t });
  const a = await ready(r);
  const obs = { ok: true, bell: 1, holding: 'h', province: 'p', citizen: 'c' };
  const llm = { alias: 'f', calls: 0, async complete() { this.calls++; return { ok: true, content: JSON.stringify({ action: 'rest', fields: {}, reason: '' }), usage: null }; } };
  const s = new AgentScheduler({ gateway: r.gateway, decider: llmDecider({ llm }), observer: { async observe() { return { ...obs }; } }, minCallGapMs: 60_000, ownerCallGapMs: 10_000, maxCallsPerDay: 6, now: () => t, log: () => {} });
  await s.tick();
  assert.equal(llm.calls, 1);
  // 100 policy changes, one per second: the owner gets through the minimum gap, but once per 10 s; the change is never dropped (the next tick after the gap sees it).
  let n = 1;
  for (let i = 0; i < 100; i++) {
    r.gateway.setPolicy(a.agentId, a.o, policy(['economy'], String(100_000_000 + i), '100000000'));
    t += 1_000;
    const out = (await s.tick())[0];
    if (!out.skipped) n++;
    else assert.ok(['owner-gap', 'call-limit'].includes(out.skipped), JSON.stringify(out));
  }
  assert.equal(llm.calls, n);
  // 100 s at one call per 10 s would be 11; the operator's cap of 6 stopped it, owner change or not.
  assert.equal(llm.calls, 6, JSON.stringify(s.stats));
  assert.ok(s.stats.skipped['owner-gap'] >= 40 && s.stats.skipped['call-limit'] >= 40, JSON.stringify(s.stats.skipped));
  assert.equal(r.gateway.view(a.agentId).day.calls, 6);
  // The next day: the first owner change past the owner gap is answered at once (the pending change was not lost). The
  // view shows the new day's count (0) although the ledger rolls its day only at the next hold: the cap must not read
  // yesterday's count, or the agent would never be asked again (nothing else would roll the day).
  t += 86_400_000;
  assert.equal(r.gateway.view(a.agentId).day.calls, 0, 'a new day in the view before any hold');
  const before = llm.calls;
  assert.deepEqual((await s.tick())[0].triggers, ['owner']);
  assert.equal(llm.calls, before + 1);
  assert.equal(r.gateway.view(a.agentId).day.calls, 1);
  sound(r);
});

test('who settled an unresolved call comes from the credential: the operator token\'s fingerprint and the address, not the body\'s label (kept as a claim)', async () => {
  const r = relay({ prices: { inference: PRICE } });
  const a = await ready(r);
  const L = r.gateway.ledger;
  const h = L.hold(a.agentId, { category: 'inference', amount: PRICE, key: 'k1' });
  L.markRunning(a.agentId, h.id);
  L.markUnresolved(a.agentId, h.id, 'restart');
  // A label in the body claiming someone else: recorded as the claim; the identity is the token.
  const dec = await operator(r, 'POST', '/f/agent/settle', { agentId: a.agentId, holdId: h.id, outcome: 'charge', note: 'seen in the log', by: 'someone-else', evidence: 'line 1' });
  assert.equal(dec.status, 200, JSON.stringify(dec.json));
  assert.equal(dec.json.by.via, 'operator-token');
  assert.match(dec.json.by.token, /^[0-9a-f]{8}$/);
  assert.equal(JSON.stringify(dec.json).includes(OPERATOR), false, 'the token itself is never in the answer');
  assert.equal(dec.json.claimedBy, 'someone-else');
  const list = (await operator(r, 'GET', '/f/agent/unresolved')).json;
  const s = list.settlements.at(-1);
  assert.deepEqual([s.by.via, s.by.token, s.claimedBy, s.outcome], ['operator-token', dec.json.by.token, 'someone-else', 'charge']);
  assert.equal(JSON.stringify(list).includes(OPERATOR), false);
  const spend = r.gateway.view(a.agentId).history.find(x => x.type === 'spend' && x.key === 'k1');
  assert.deepEqual([spend.decidedBy.via, spend.claimedBy], ['operator-token', 'someone-else']);
  // Without the label: the claim is null, the identity the same. Without the token: refused before anything is recorded.
  const h2 = L.hold(a.agentId, { category: 'inference', amount: PRICE, key: 'k2' });
  L.markRunning(a.agentId, h2.id); L.markUnresolved(a.agentId, h2.id, 'ttl');
  const dec2 = await operator(r, 'POST', '/f/agent/settle', { agentId: a.agentId, holdId: h2.id, outcome: 'refund', note: 'no request in the log' });
  assert.deepEqual([dec2.json.by.via, dec2.json.by.token, dec2.json.claimedBy], ['operator-token', dec.json.by.token, null]);
  const h3 = L.hold(a.agentId, { category: 'inference', amount: PRICE, key: 'k3' });
  L.markRunning(a.agentId, h3.id); L.markUnresolved(a.agentId, h3.id, 'ttl');
  const no = await call(r.operator, 'POST', '/f/agent/settle', { body: { agentId: a.agentId, holdId: h3.id, outcome: 'refund', by: 'operator' }, headers: { authorization: 'Bearer wrong' } });
  assert.equal(no.json.code, 'OperatorOnly');
  assert.equal(L.get(a.agentId).holds[h3.id].state, 'unresolved');
  assert.equal((await operator(r, 'GET', '/f/agent/unresolved')).json.settlements.length, 2);
  sound(r);
});

test('what the model is told: the village state from the herald\'s records (stores, queue, troops, a derived threat), the catalog, and never a secret; an unaffordable or empty answer is refused before the chain', async () => {
  const { villageState, threatOf, affordable, promptOf, llmDecider, CATALOG } = await import('../src/frontier/agent/runner.mjs');
  const { encodeAccount } = await import('../client/src/frontier/codec.mjs');
  const { decodeAccount } = await import('../client/src/frontier/codec.mjs');
  const now = 1_785_630_236 + 3_600;
  const accrual = (v, rate) => ({ VALUE: BigInt(v) * 1000n, RATE: BigInt(rate) * 1000n, CAP: 2_000_000n, T0: 1_785_630_236n, FRAC: 0n });
  const hold = decodeAccount('Holding', encodeAccount('Holding', { P: 3, Q: 0, SITE: 2, GEN: 1, TIER: 1, STATE: 2, STORES: [accrual(300, 40), accrual(300, 30), accrual(200, 20), accrual(100, 15), accrual(0, 0), accrual(100, 15), accrual(20, 5), accrual(0, 0)],
    PRODUCTION: [40_000n, 30_000n, 20_000n, 15_000n, 0n, 15_000n, 5_000n, 0n], QUEUE: [{ DONE_AT: BigInt(now + 1_000), KIND: 1, ARG: 1, DELTA: 10_000n }, { DONE_AT: 0n, KIND: 0, ARG: 0, DELTA: 0n }, { DONE_AT: 0n, KIND: 0, ARG: 0, DELTA: 0n }, { DONE_AT: 0n, KIND: 0, ARG: 0, DELTA: 0n }], RESERVE: [250, 0, 0, 0, 0, 0, 0, 0], WALLS: 3 }));
  const hostId = (site, gen) => (BigInt(7) << 44n) | (BigInt(site) << 40n) | (BigInt(gen) << 32n) | 1n;
  const prov = decodeAccount('Province', encodeAccount('Province', { P: 3, Q: 0, ENTRIES: [{ ID: hostId(2, 1), FACTION: 0, UNIT: 0, TILE: 5, STATE: 1, TROOPS: 50 }, { ID: hostId(9, 1), FACTION: 1, UNIT: 2, TILE: 7, STATE: 2, TROOPS: 300 }, { ID: hostId(9, 1), FACTION: 1, UNIT: 2, TILE: 7, STATE: 0, TROOPS: 999 }],
    CAMP: [{ TILE: 3, STATE: 1, TROOPS: 200, NEXT_CHECK_DAY: 0, GEN: 1 }], SITE_MIRROR: Array.from({ length: 12 }, (_, i) => ({ STATE: 0, FACTION: 0, ORDER: 0, TIER: 0, GEN: 0, GARRISON: i === 2 ? 120 : 0, PEND0_BELL: 0, PEND0_DELTA: 0n, PEND1_BELL: 0, PEND1_DELTA: 0n, WALLS_COMMITTED: 0, WALL_ITEM0_BELL: 0, WALL_ITEM0_DELTA: 0, WALL_ITEM1_BELL: 0, WALL_ITEM1_DELTA: 0, SHIELD_UNTIL_BELL: 0 })) }));
  const cit = decodeAccount('Citizen', encodeAccount('Citizen', { VIGIL_START_MIN: 600 }));
  const s = villageState({ holding: hold, province: prov, citizen: cit, site: 2, now });
  // Stores projected an hour on at the rate (300 + 40 = 340 Food), whole units; the queue's one building; troops at home and in the province.
  assert.deepEqual([s.tier, s.stores.Food, s.stores.Wood, s.store_cap, s.walls, s.free_queue_slots, s.queue, s.reserve_troops, s.garrison, s.hosts, s.vigil_start_min],
    ['Village', 340, 330, 2000, 3, 3, [{ what: 'Wood building', done_in_s: 1000 }], { Spearman: 250 }, 120, [{ unit: 'Spearman', troops: 50 }], 600]);
  assert.deepEqual(s.province, { other_hosts: [{ unit: 'Horseman', troops: 300, faction: 1 }], camp: { troops: 200 } });
  assert.deepEqual(s.threat, { hostile_troops: 500, troops_at_home: 420, outnumbered: true });
  assert.equal(threatOf({ ...s, province: { other_hosts: [], camp: null } }), null);
  // The prompt carries the state, the actions' notes and the catalog for the allowed actions; no key, no token, no address of the owner.
  const view = { agentId: 'a', village: [3, 0, 2], owner: 'OWNERWALLET', agentKey: 'AGENTKEY', policy: { version: 1, allowed: ['Harvest', 'Build', 'Train'], budget: { total: '1', perDay: '1' } }, modeEpoch: 1, history: [], balance: { available: '1', spent: { inference: '0', network: '0', game: '0' } } };
  const text = JSON.stringify(promptOf(view, ['Harvest', 'Build', 'Train'], { bell: 9, triggers: ['event'], state: s }));
  assert.ok(text.includes('threat') && text.includes('catalog') && text.includes('Spearman') && text.includes('outnumbered'), 'the state, the catalog and the threat reach the model');
  assert.ok(!text.includes('OWNERWALLET') && !text.includes('AGENTKEY') && !text.includes('capability'));
  assert.ok(!text.includes('SetVigil'), 'only the allowed actions are offered');
  // Affordability by the catalog: a Food building (Wood 80, Stone 40) yes; two batches of Knights (Gold 26 × 2) no; Train n=0 no.
  assert.equal(affordable({ name: 'Build', fields: { item: 0 } }, s), true);
  assert.equal(affordable({ name: 'Build', fields: { item: 0 } }, { ...s, free_queue_slots: 0 }), false);
  assert.equal(affordable({ name: 'Train', fields: { unit: 5, n: 300 } }, s), false, 'three batches of Knights: Ore 159 over 115');
  assert.equal(affordable({ name: 'Train', fields: { unit: 0, n: 100 } }, s), true);
  assert.equal(affordable({ name: 'Train', fields: { unit: 0, n: 0 } }, s), false);
  assert.equal(CATALOG.train[2].cost_per_100.Ore, 20, 'the conquest table: a Horseman costs as a Spearman');
  // The decider refuses what the state cannot pay for and an empty training, before anything reaches the chain.
  const answers = [];
  const llm = { alias: 'f', async complete() { return { ok: true, content: JSON.stringify(answers.shift()), usage: { prompt_tokens: 1, completion_tokens: 1 } }; } };
  const d = llmDecider({ llm });
  answers.push({ action: 'Train', fields: { unit: 0, n: 0 }, reason: 'cannot afford' });
  await assert.rejects(() => d.decide(view, { state: s }), /Train\.n must be at least 1/);
  answers.push({ action: 'Train', fields: { unit: 5, n: 300 }, reason: '' });
  await assert.rejects(() => d.decide(view, { state: s }), /not affordable/);
  answers.push({ action: 'Build', fields: { item: 0 }, reason: 'ok' });
  assert.deepEqual((await d.decide(view, { state: s })).choice, { name: 'Build', fields: { item: 0 } });
  answers.push({ action: 'Build', fields: { item: 0 }, reason: 'no state: the chain decides' });
  assert.deepEqual((await d.decide(view, null)).choice, { name: 'Build', fields: { item: 0 } });
});
