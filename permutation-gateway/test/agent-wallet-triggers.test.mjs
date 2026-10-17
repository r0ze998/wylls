// When the model is asked (docs/agent-wallet/DESIGN.md §7.1): only on a
// trigger — the owner changed the policy or the mode, the village or its
// province changed on chain, a new turn — never on an unchanged state; one
// call per agent at a time; at least the minimum gap between calls (an
// owner change excepted); after a call that sent nothing, new turns alone
// are sat out 1, 2, 4 … times while an event or an owner change still gets
// through; and never more calls a day than the operator's cap or the
// owner's policy.budget.callsPerDay. A flood of events costs at most one
// call per tick and per gap, and the caps hold.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import { ERR } from '../src/frontier/agent/contract.mjs';
import { AgentScheduler, DEFAULT_OWNER_CALL_GAP_MS, llmDecider, triggersOf, promptOf } from '../src/frontier/agent/runner.mjs';
import { call, createAgent, delegate, deposit, ownerCommand, policy, relay, sound } from './agent-wallet-fixtures.mjs';

const post = (r, path, body) => call(r.public, 'POST', path, { body, ip: '127.0.0.1' });
const PRICE = '10000';

async function ready(r, { balance = 10_000_000n, policy: p = policy(['economy'], '100000000', '100000000') } = {}) {
  const owner = Keypair.generate();
  const o = owner.publicKey.toBase58();
  const made = await createAgent(r, owner, { policy: p });
  if (balance > 0n) await deposit(r, o, made.agentId, balance);
  delegate(r, o, made.agentKey);
  r.gateway.setMode(made.agentId, o, 'auto');
  return { owner, o, ...made };
}
/** A world the test moves by hand: `obs` is what the observer answers. */
function world() {
  const obs = { ok: true, bell: 100, holding: 'h0', province: 'p0', citizen: 'c0' };
  return { obs, observer: { async observe() { return { ...obs }; } }, turn() { obs.bell += 1; }, event() { obs.holding = `h${Math.random()}`; } };
}
const fakeLlm = (answerOf = () => 'rest') => ({ alias: 'f', calls: 0, async complete(body) { this.calls++; return { ok: true, content: JSON.stringify({ action: answerOf(body), fields: {}, reason: 'test' }), usage: null }; } });

test('an unchanged state never asks the model; a new turn, a village event and an owner change do, in that order of strength', async () => {
  let t = Date.now();
  const r = relay({ prices: { inference: PRICE }, now: () => t });
  const a = await ready(r);
  const w = world();
  const llm = fakeLlm();
  const s = new AgentScheduler({ gateway: r.gateway, decider: llmDecider({ llm }), observer: w.observer, minCallGapMs: 0, now: () => t, log: () => {} });
  assert.deepEqual((await s.tick())[0].triggers, ['first']);
  assert.equal(llm.calls, 1);
  for (let i = 0; i < 50; i++) { t += 1_000; assert.equal((await s.tick())[0].skipped, 'no-change'); }
  assert.equal(llm.calls, 1, 'fifty ticks on the same state: no call');
  assert.equal(r.gateway.view(a.agentId).balance.spent.inference, PRICE);
  // The model rested: new turns alone are sat out 1, 2, 4 … times.
  const calledOnTurn = [];
  for (let turn = 1; turn <= 20; turn++) { w.turn(); t += 1_000; const before = llm.calls; await s.tick(); if (llm.calls > before) calledOnTurn.push(turn); }
  assert.deepEqual(calledOnTurn, [2, 5, 10, 19], 'turn triggers after rests: 1, 2, 4, 8 sat out');
  // A village event gets through the sit-out at once; so does an owner change (the policy version moved).
  w.event(); t += 1_000;
  const ev = (await s.tick())[0];
  assert.ok(ev.triggers.includes('event') && !ev.skipped, JSON.stringify(ev));
  const before = llm.calls;
  // (the test clock ran ahead of the wall clock: the owner command goes through the gateway, not the signed route)
  r.gateway.setPolicy(a.agentId, a.o, policy(['economy', 'vigil'], '100000000', '100000000'));
  t += 1_000;
  // Inside the owner gap (a call 1 s ago): not yet, the trigger stays; past it: asked, through the minimum gap.
  assert.deepEqual((await s.tick())[0], { agentId: a.agentId, skipped: 'owner-gap', triggers: ['owner'] });
  t += DEFAULT_OWNER_CALL_GAP_MS;
  assert.deepEqual((await s.tick())[0].triggers, ['owner']);
  assert.equal(llm.calls, before + 1);
  assert.deepEqual(s.stats.skipped['no-change'], 50);
  sound(r);
});

test('a flood of events: one call per tick at most, none inside the minimum gap, none past the operator\'s cap; the owner\'s callsPerDay refuses the hold before the model is called', async () => {
  let t = Date.now();
  const r = relay({ prices: { inference: PRICE }, now: () => t });
  const a = await ready(r);
  const w = world();
  const llm = fakeLlm();
  const s = new AgentScheduler({ gateway: r.gateway, decider: llmDecider({ llm }), observer: w.observer, minCallGapMs: 5_000, maxCallsPerDay: 12, now: () => t, log: () => {} });
  // 1,000 events spread over 100 ticks of 1 s: the state changes every tick, the gap allows a call every 5 s, the cap allows 12.
  for (let i = 0; i < 100; i++) { for (let e = 0; e < 10; e++) w.event(); t += 1_000; await s.tick(); }
  assert.equal(llm.calls, 12, `calls: ${llm.calls}; skipped: ${JSON.stringify(s.stats.skipped)}`);
  assert.ok(s.stats.skipped['min-gap'] >= 40 && s.stats.skipped['call-limit'] >= 30, JSON.stringify(s.stats.skipped));
  assert.equal(r.gateway.view(a.agentId).balance.spent.inference, String(12 * 10_000));
  assert.equal(r.gateway.view(a.agentId).day.calls, 12);
  // Next UTC day: the count rolls; the owner's own cap (policy.budget.callsPerDay) is enforced in the ledger: the model is not called past it.
  t += 86_400_000;
  r.gateway.setPolicy(a.agentId, a.o, { allowed: ['economy'], budget: { total: '100000000', perDay: '100000000', callsPerDay: 2 } });
  const s2 = new AgentScheduler({ gateway: r.gateway, decider: llmDecider({ llm }), observer: w.observer, minCallGapMs: 0, maxCallsPerDay: 1000, now: () => t, log: () => {} });
  const before = llm.calls;
  for (let i = 0; i < 5; i++) { w.event(); t += 1_000; await s2.tick(); }
  assert.equal(llm.calls, before + 2, 'two calls, then the policy says no');
  assert.throws(() => r.gateway.ledger.hold(a.agentId, { category: 'inference', amount: PRICE, key: 'x' }), e => e.code === ERR.CALL_LIMIT);
  assert.equal(r.gateway.view(a.agentId).day.calls, 2);
  // Past the owner's cap the runner still acts, free, by the autopilot (the tick's result says so).
  w.event(); t += 1_000;
  const out = (await s2.tick())[0];
  assert.deepEqual([out.charged, out.decided], ['0', 'Harvest']);
  assert.match(out.by, /autopilot \(after CallLimitReached\)/);
  sound(r);
});

test('one call per agent at a time: a tick during a call does not ask again; two ticks at once share one run; an unobservable world asks nothing', async () => {
  const r = relay({ prices: { inference: PRICE } });
  const a = await ready(r);
  const w = world();
  let release;
  const gate = new Promise(res => { release = res; });
  const llm = { alias: 'slow', calls: 0, async complete() { this.calls++; await gate; return { ok: true, content: JSON.stringify({ action: 'rest', fields: {}, reason: '' }), usage: null }; } };
  const s = new AgentScheduler({ gateway: r.gateway, decider: llmDecider({ llm }), observer: w.observer, minCallGapMs: 0, log: () => {} });
  const first = s.tick();
  const second = s.tick();
  await new Promise(res => setTimeout(res, 5));
  assert.ok(s.inflight.has(a.agentId));
  // The scheduler's own guard, exercised directly: an agent in flight is skipped by the next tick's loop.
  assert.equal(s.decideCall(r.gateway.view(a.agentId), { ...w.obs }).call, true, 'decideCall alone would call again');
  release();
  assert.equal(await first, await second, 'a tick in progress is the tick: one run, one result');
  assert.equal(llm.calls, 1);
  w.event();
  s.inflight.add(a.agentId);
  assert.equal((await s.tick())[0].skipped, 'inflight');
  s.inflight.delete(a.agentId);
  // The herald cannot be read: no call, no charge.
  const blind = new AgentScheduler({ gateway: r.gateway, decider: llmDecider({ llm }), observer: { async observe() { return { ok: false }; } }, minCallGapMs: 0, log: () => {} });
  assert.equal((await blind.tick())[0].skipped, 'unobserved');
  assert.equal(llm.calls, 1);
  sound(r);
});

test('triggersOf and the prompt: what counts as a change, and what the model is told', () => {
  const view = { agentId: 'a', policy: { version: 1 }, modeEpoch: 1, history: [], village: [1, 2, 3], balance: { available: '1', spent: { inference: '0', network: '0', game: '0' } } };
  const obs = { bell: 5, holding: 'h', province: 'p', citizen: 'c' };
  const last = { bell: 5, holding: 'h', province: 'p', citizen: 'c', policyVersion: 1, modeEpoch: 1, historyLength: 0 };
  assert.deepEqual(triggersOf(obs, view, null), ['first']);
  assert.deepEqual(triggersOf(obs, view, last), []);
  assert.deepEqual(triggersOf({ ...obs, bell: 6 }, view, last), ['turn']);
  assert.deepEqual(triggersOf({ ...obs, province: 'q' }, view, last), ['event']);
  assert.deepEqual(triggersOf(obs, { ...view, modeEpoch: 2 }, last), ['owner']);
  assert.deepEqual(triggersOf({ ...obs, bell: 6, holding: 'x' }, { ...view, policy: { version: 2 } }, last), ['owner', 'event', 'turn']);
  assert.deepEqual(triggersOf(obs, { ...view, history: [{ type: 'action', source: 'browser' }] }, last), ['result'], 'the owner acted by hand');
  assert.deepEqual(triggersOf(obs, { ...view, history: [{ type: 'action', source: 'ai' }] }, last), [], 'the agent\'s own line is not a trigger');
  const prompt = promptOf({ ...view, policy: { ...view.policy, budget: { total: '1', perDay: '1' } } }, ['Harvest'], { bell: 7, triggers: ['turn'] });
  const u = JSON.parse(prompt[1].content);
  assert.deepEqual([u.turn, u.why], [7, ['turn']]);
  assert.match(prompt[0].content, /asked only when something changed/);
});

test('the observer\'s digests: a quiet turn (resolution counters, event sequence) is not an event; a host arriving, a store moving, a session change are', async () => {
  const { encodeAccount } = await import('../client/src/frontier/codec.mjs');
  const { accountDigest, AgentObserver } = await import('../src/frontier/agent/runner.mjs');
  const prov = over => encodeAccount('Province', { SEASON_ID: 5n, P: 1, Q: 2, RESOLVED_NEXT: 10, N_ENTRIES: 0, ...over });
  assert.equal(accountDigest('Province', prov({})), accountDigest('Province', prov({ RESOLVED_NEXT: 11, EVENT_SEQ: 99n })), 'a resolved turn alone is quiet');
  assert.notEqual(accountDigest('Province', prov({})), accountDigest('Province', prov({ N_ENTRIES: 1 })), 'a host arriving is an event');
  const hold = over => encodeAccount('Holding', { SEASON_ID: 5n, P: 1, Q: 2, SITE: 3, STATE: 2, ...over });
  assert.equal(accountDigest('Holding', hold({})), accountDigest('Holding', hold({ EVENT_SEQ: 7n, LAST_OWNER_ACTION: 123n })), 'the counters alone are quiet');
  assert.notEqual(accountDigest('Holding', hold({})), accountDigest('Holding', hold({ TIER: 1 })), 'a promotion is an event');
  const cit = over => encodeAccount('Citizen', { SEASON_ID: 5n, WALLET: new Uint8Array(32).fill(1), SESSION: new Uint8Array(32).fill(2), SESSION_EXPIRY: 100n, ...over });
  assert.equal(accountDigest('Citizen', cit({})), accountDigest('Citizen', cit({ LAST_ACTION_TS: 9n, BUCKET_T: 3n })));
  assert.notEqual(accountDigest('Citizen', cit({})), accountDigest('Citizen', cit({ SESSION: new Uint8Array(32).fill(3) })), 'the owner took the key back');
  // The observer over a fake herald: the village's holding is picked by p,q,site; a province whose only change is its resolution counter reads the same.
  const pages = { '/h/season': { genesisTs: 1000, latestUnix: 1000 + 600 * 7 + 1 }, '/h/me/W': { citizen: { bytes_b64: Buffer.from(cit({})).toString('base64') }, holdings: [{ bytes_b64: Buffer.from(hold({ SITE: 9 })).toString('base64') }, { bytes_b64: Buffer.from(hold({})).toString('base64') }] }, '/h/province/1,2/latest': { bytes: Buffer.from(prov({})).toString('base64'), slots: [{ key: 'as:1' }], seq: '5' } };
  const o = new AgentObserver({ heraldUrl: 'http://h', fetch: async url => ({ ok: true, json: async () => pages[new URL(url).pathname] }) });
  const a = await o.observe({ owner: 'W', village: [1, 2, 3] });
  assert.deepEqual([a.ok, a.bell, a.holding === accountDigest('Holding', hold({}))], [true, 7, true]);
  pages['/h/province/1,2/latest'] = { bytes: Buffer.from(prov({ RESOLVED_NEXT: 12 })).toString('base64'), slots: [{ key: 'as:1' }], seq: '6' };
  const b = await o.observe({ owner: 'W', village: [1, 2, 3] });
  assert.equal(b.province, a.province, 'a quiet turn: the same province digest');
  pages['/h/province/1,2/latest'].slots.push({ key: 'as:2' });
  assert.notEqual((await o.observe({ owner: 'W', village: [1, 2, 3] })).province, a.province, 'a new arrival slot: an event');
  const dead = new AgentObserver({ heraldUrl: 'http://h', fetch: async () => { throw new Error('down'); } });
  assert.equal((await dead.observe({ owner: 'W', village: [1, 2, 3] })).ok, false);
});
