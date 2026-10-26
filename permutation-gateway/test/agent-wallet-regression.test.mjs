// The fifth round's regressions (docs/agent-wallet/DESIGN.md §7.1, §12.1):
//   1. the day's call count across a UTC midnight: the cap fills, the day rolls in the view before any hold, the first
//      hold of the new day starts the count, a restart keeps today's count and rolls after midnight, an inference that
//      began yesterday and settles today is not counted twice and does not block today, nothing slips past the cap;
//   2. the herald's real response shapes: a province's bytes at `bytes` next to `slots` (not `province.bytes_b64`),
//      the owner's `/h/me` with `holdings[].bytes_b64` and `citizen.bytes_b64`; an arrival in the province and a camp
//      change are events; a quiet turn (the resolution counter, the event sequence, the summary) is not; an
//      unchanged world asks nothing over many ticks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Keypair } from '@solana/web3.js';
import { encodeAccount } from '../client/src/frontier/codec.mjs';
import { ERR } from '../src/frontier/agent/contract.mjs';
import { budgetDay } from '../src/frontier/agent/ledger.mjs';
import { AgentObserver, AgentScheduler, llmDecider, triggersOf } from '../src/frontier/agent/runner.mjs';
import { createAgent, delegate, deposit, policy, relay, sound, VILLAGE } from './agent-wallet-fixtures.mjs';

const PRICE = '10000';
const restart = (r, over = {}) => relay({ chain: r.chain, prices: { inference: PRICE }, agentState: JSON.parse(JSON.stringify(r.agentStore.state)), keyring: r.gateway.keyring, ...over });
// The next UTC midnight after now (owner commands are signed with the wall clock's expiry, so agents are made at
// "now" and the test clock then moves to the evening before that midnight).
const MIDNIGHT = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() + 1);

async function ready(r, { balance = 10_000_000n, policy: p = policy(['economy'], '100000000', '100000000') } = {}) {
  const owner = Keypair.generate();
  const o = owner.publicKey.toBase58();
  const made = await createAgent(r, owner, { policy: p });
  if (balance > 0n) await deposit(r, o, made.agentId, balance);
  delegate(r, o, made.agentKey);
  r.gateway.setMode(made.agentId, o, 'auto');
  return { owner, o, ...made };
}
const fakeLlm = () => ({ alias: 'f', calls: 0, async complete() { this.calls++; return { ok: true, content: JSON.stringify({ action: 'rest', fields: {}, reason: '' }), usage: null }; } });

test('the daily call cap across a UTC midnight, a restart and a call that began the day before: filled, rolled, kept, never slipped', async () => {
  let t = Date.now();
  let r = relay({ prices: { inference: PRICE }, now: () => t });
  const a = await ready(r, { policy: { allowed: ['economy'], budget: { total: '100000000', perDay: '100000000', callsPerDay: 3 } } });
  t = MIDNIGHT - 3_600_000; // 23:00 the day before
  const obs = { ok: true, bell: 1, holding: 'h', province: 'p', citizen: 'c' };
  const observer = { async observe() { return { ...obs }; } };
  const llm = fakeLlm();
  let s = new AgentScheduler({ gateway: r.gateway, decider: llmDecider({ llm }), observer, minCallGapMs: 0, ownerCallGapMs: 0, maxCallsPerDay: 3, now: () => t, log: () => {} });
  // 23:00: three calls fill the day (every tick sees a new state).
  for (let i = 0; i < 5; i++) { obs.holding = `h${i}`; t += 60_000; await s.tick(); }
  assert.equal(llm.calls, 3);
  assert.equal(r.gateway.view(a.agentId).day.calls, 3);
  assert.deepEqual([r.gateway.view(a.agentId).day.key, s.stats.skipped['call-limit']], [budgetDay(MIDNIGHT - 1), 2]);
  // 23:30: a call that began today and will return tomorrow: `running`, counted today (the fourth attempt is refused by the ledger).
  t = MIDNIGHT - 1_800_000;
  const L = r.gateway.ledger;
  assert.throws(() => L.hold(a.agentId, { category: 'inference', amount: PRICE, key: 'late' }), e => e.code === ERR.CALL_LIMIT, 'the owner\'s cap holds at 23:30');
  // A restart at 23:45 keeps today's count: still full.
  t = MIDNIGHT - 900_000;
  r = restart(r, { now: () => t });
  assert.equal(r.gateway.view(a.agentId).day.calls, 3, 'a restart does not reset the day');
  s = new AgentScheduler({ gateway: r.gateway, decider: llmDecider({ llm }), observer, minCallGapMs: 0, ownerCallGapMs: 0, maxCallsPerDay: 3, now: () => t, log: () => {} });
  obs.holding = 'h-restart'; await s.tick();
  assert.equal(llm.calls, 3, 'still full after the restart');
  // 00:00:01: the view shows the new day with no call before any hold; the ledger's stored day is still yesterday's.
  t = MIDNIGHT + 1_000;
  assert.deepEqual([r.gateway.view(a.agentId).day.key, r.gateway.view(a.agentId).day.calls], [budgetDay(t), 0]);
  assert.equal(r.gateway.ledger.get(a.agentId).day.key, budgetDay(MIDNIGHT - 1), 'rolled on the next hold, not before');
  // 00:01: the scheduler asks again; the first hold rolls the day and starts the count at 1; three fill it again.
  for (let i = 0; i < 5; i++) { obs.holding = `n${i}`; t += 60_000; await s.tick(); }
  assert.equal(llm.calls, 6);
  assert.deepEqual([r.gateway.view(a.agentId).day.key, r.gateway.view(a.agentId).day.calls], [budgetDay(t), 3]);
  // A call that began yesterday (23:59) and settles today: counted yesterday, charged to today's money, not counted today, not blocking today.
  t = Date.now();
  let r2 = relay({ prices: { inference: PRICE }, now: () => t });
  const b = await ready(r2, { policy: { allowed: ['economy'], budget: { total: '100000000', perDay: '100000000', callsPerDay: 2 } } });
  t = MIDNIGHT + 86_400_000 - 60_000; // 23:59 of the new day
  const L2 = r2.gateway.ledger;
  const h = L2.hold(b.agentId, { category: 'inference', amount: PRICE, key: 'eve' });
  L2.markRunning(b.agentId, h.id);
  assert.equal(r2.gateway.view(b.agentId).day.calls, 1);
  t += 120_000; // 00:01 the day after
  assert.equal(r2.gateway.view(b.agentId).day.calls, 0, 'the new day before its first hold');
  assert.equal(L2.settle(b.agentId, h.id), true);
  const dv = r2.gateway.view(b.agentId);
  assert.deepEqual([dv.day.key, dv.day.calls, dv.day.spent], [budgetDay(t), 0, PRICE], 'the money lands on the day it settled; the call stays counted on the day it was made');
  L2.hold(b.agentId, { category: 'inference', amount: PRICE, key: 'd1' });
  L2.hold(b.agentId, { category: 'inference', amount: PRICE, key: 'd2' });
  assert.throws(() => L2.hold(b.agentId, { category: 'inference', amount: PRICE, key: 'd3' }), e => e.code === ERR.CALL_LIMIT, 'two calls today, the third refused: yesterday\'s call neither counts today nor hides');
  // The same across a restart at 00:00:30 with yesterday's running call still open: unresolved on restart, today's count 0, the cap whole.
  t = Date.now();
  let r3 = relay({ prices: { inference: PRICE }, now: () => t });
  const c = await ready(r3, { policy: { allowed: ['economy'], budget: { total: '100000000', perDay: '100000000', callsPerDay: 1 } } });
  t = MIDNIGHT + 2 * 86_400_000 - 30_000;
  const hc = r3.gateway.ledger.hold(c.agentId, { category: 'inference', amount: PRICE, key: 'eve2' });
  r3.gateway.ledger.markRunning(c.agentId, hc.id);
  assert.throws(() => r3.gateway.ledger.hold(c.agentId, { category: 'inference', amount: PRICE, key: 'x' }), e => e.code === ERR.CALL_LIMIT);
  t += 60_000;
  r3 = restart(r3, { now: () => t });
  const cv = r3.gateway.view(c.agentId);
  assert.deepEqual([cv.holds.find(x => x.id === hc.id)?.state, cv.balance.unresolved, cv.day.calls], ['unresolved', PRICE, 0]);
  r3.gateway.ledger.hold(c.agentId, { category: 'inference', amount: PRICE, key: 'today' });
  assert.throws(() => r3.gateway.ledger.hold(c.agentId, { category: 'inference', amount: PRICE, key: 'today2' }), e => e.code === ERR.CALL_LIMIT, 'one today, the second refused');
  sound(r); sound(r2); sound(r3);
});

// ---------------------------------------------------------------- the herald's real shapes
const b64 = bytes => Buffer.from(bytes).toString('base64');
const hold = over => encodeAccount('Holding', { P: 1, Q: 2, SITE: 3, GEN: 1, STATE: 2, TIER: 0, STORES: Array.from({ length: 8 }, () => ({ VALUE: 300_000n, RATE: 40_000n, CAP: 2_000_000n, T0: 1_000n, FRAC: 0n })), ...over });
const cit = over => encodeAccount('Citizen', { VIGIL_START_MIN: 0, ...over });
const entry = (id, over = {}) => ({ ID: BigInt(id), FACTION: 1, UNIT: 2, TILE: 7, STATE: 1, TROOPS: 300, STAMINA_VALUE: 0, DEALT_BPS: 0, STAMINA_BELL: 0, READY_BELL: 0, FROM_BELL: 0, PEND_BELL: 0, PEND_OP: 0, OP_A: 0, OP_B: 0, OP_TROOPS: 0, OP_REF: 0, ...over });
const prov = (over = {}, entries = []) => encodeAccount('Province', { P: 1, Q: 2, RESOLVED_NEXT: 10, N_ENTRIES: entries.length, ENTRIES: entries, ...over });
/** A herald as the real one answers (shapes seen on a running stack, 2026-10-17): `/h/me` holdings and citizen under bytes_b64; `/h/province/…/latest` with `bytes` and `slots`. */
function heraldPages({ owner = 'W', village = [1, 2, 3], bell = 7, holding = null, citizen = cit({}), province = null, slots = [] } = {}) {
  const [p, q, site] = village;
  return {
    '/h/season': { genesisTs: 1000, latestUnix: 1000 + 600 * bell + 1 },
    [`/h/me/${owner}`]: { citizen: { bytes_b64: b64(citizen), address: 'C' }, holdings: [{ address: 'H', bytes_b64: b64(holding ?? hold({ P: p, Q: q, SITE: site })), head: 'x', seq: '3', slot: 9 }], hosts: [], transits: [], slots: [] },
    [`/h/province/${p},${q}/latest`]: { key: `pv:${p},${q}`, bell, bytes: b64(province ?? prov({ P: p, Q: q })), slots, seq: '5', slot: 9, head: 'y', day: 1, inputs: null, v: 1 },
  };
}
const observerOver = pages => new AgentObserver({ heraldUrl: 'http://h', fetch: async url => { const p = pages[new URL(url).pathname]; return p ? { ok: true, json: async () => p } : { ok: false }; } });

test('the herald\'s real shapes: an arrival and a camp in the province are events, a quiet turn is not, and an unchanged world asks nothing', async () => {
  // The recorded shape of a real `/h/province/{p},{q}/latest` answer (run agent-e2e-8): the account at `bytes`.
  const real = JSON.parse(readFileSync(new URL('./fixtures/herald-province-latest.json', import.meta.url), 'utf8'));
  assert.ok(typeof real.bytes === 'string' && Array.isArray(real.slots) && real.province === undefined, 'bytes next to slots, no nested province');
  assert.equal(Buffer.from(real.bytes, 'base64').subarray(0, 8).toString(), 'PSF1PROV');
  const pages = heraldPages();
  const ob = observerOver(pages);
  const o0 = await ob.observe({ owner: 'W', village: [1, 2, 3] });
  assert.ok(o0.ok && o0.province && o0.holding && o0.citizen && o0.state, JSON.stringify(o0));
  const last = { ...o0, policyVersion: 1, modeEpoch: 1, historyLength: 0 };
  const view = { policy: { version: 1 }, modeEpoch: 1, history: [] };
  // A quiet turn: the resolution counter, the summary digest and the event sequence move, the bell moves: 'turn' only.
  pages['/h/province/1,2/latest'] = { ...pages['/h/province/1,2/latest'], bell: 8, bytes: b64(prov({ RESOLVED_NEXT: 11, EVENT_SEQ: 99n, LAST_DIGEST: Buffer.alloc(32, 5), RESOLVE_SUMMARY: [{}] })), seq: '6' };
  pages['/h/season'] = { genesisTs: 1000, latestUnix: 1000 + 600 * 8 + 1 };
  const o1 = await ob.observe({ owner: 'W', village: [1, 2, 3] });
  assert.deepEqual(triggersOf(o1, view, last), ['turn']);
  // An arrival: a host of another faction entered the province (an entry in state 1): 'event'.
  pages['/h/province/1,2/latest'] = { ...pages['/h/province/1,2/latest'], bytes: b64(prov({ RESOLVED_NEXT: 11 }, [entry((7n << 44n) | (9n << 40n) | (1n << 32n) | 1n)])) };
  const o2 = await ob.observe({ owner: 'W', village: [1, 2, 3] });
  assert.ok(triggersOf(o2, view, last).includes('event'), 'an arrival is an event');
  assert.deepEqual(o2.state.province.other_hosts, [{ unit: 'Horseman', troops: 300, faction: 1 }]);
  assert.deepEqual(o2.state.threat, { hostile_troops: 300, troops_at_home: 0, outnumbered: true });
  // A camp appeared: 'event'; a camp's troops changed: 'event'.
  const camp = troops => [{ TILE: 3, STATE: 1, TROOPS: troops, NEXT_CHECK_DAY: 0, GEN: 1 }];
  pages['/h/province/1,2/latest'] = { ...pages['/h/province/1,2/latest'], bytes: b64(prov({ RESOLVED_NEXT: 11, CAMP: camp(126) })) };
  const o3 = await ob.observe({ owner: 'W', village: [1, 2, 3] });
  assert.ok(triggersOf(o3, view, last).includes('event') && o3.state.province.camp.troops === 126, 'a camp is an event');
  pages['/h/province/1,2/latest'] = { ...pages['/h/province/1,2/latest'], bytes: b64(prov({ RESOLVED_NEXT: 11, CAMP: camp(90) })) };
  const o4 = await ob.observe({ owner: 'W', village: [1, 2, 3] });
  assert.ok(o4.province !== o3.province && triggersOf(o4, view, { ...o3, policyVersion: 1, modeEpoch: 1, historyLength: 0 }).includes('event'), 'the camp\'s troops changed');
  // An arrival slot (the herald's `slots`) is part of the province's digest too.
  pages['/h/province/1,2/latest'] = { ...pages['/h/province/1,2/latest'], slots: [{ key: 'as:1', bytes_b64: 'AA==' }] };
  const o5 = await ob.observe({ owner: 'W', village: [1, 2, 3] });
  assert.notEqual(o5.province, o4.province);
  // The old nested shape is still read (a herald of another build), and a herald without the province answers without it.
  pages['/h/province/1,2/latest'] = { province: { bytes_b64: b64(prov({ RESOLVED_NEXT: 11, CAMP: camp(90) })) }, slots: [] };
  assert.equal((await ob.observe({ owner: 'W', village: [1, 2, 3] })).province, o4.province);
  delete pages['/h/province/1,2/latest'];
  const o6 = await ob.observe({ owner: 'W', village: [1, 2, 3] });
  assert.ok(o6.ok && o6.province === null && o6.state && o6.state.province === undefined);
  // The scheduler over the real shapes: the same world for 40 ticks asks once; a camp change asks again; a quiet turn after a rest is sat out.
  let t = Date.now();
  const r = relay({ prices: { inference: PRICE }, now: () => t });
  const a = await ready(r);
  const pages2 = heraldPages({ owner: a.o, village: VILLAGE });
  const pv = `/h/province/${VILLAGE[0]},${VILLAGE[1]}/latest`;
  const llm = fakeLlm();
  const s = new AgentScheduler({ gateway: r.gateway, decider: llmDecider({ llm }), observer: observerOver(pages2), minCallGapMs: 0, now: () => t, log: () => {} });
  for (let i = 0; i < 40; i++) { t += 1_000; await s.tick(); }
  assert.equal(llm.calls, 1, `an unchanged world: one call; skipped ${JSON.stringify(s.stats.skipped)}`);
  assert.equal(s.stats.skipped['no-change'], 39);
  pages2[pv] = { ...pages2[pv], bytes: b64(prov({ P: VILLAGE[0], Q: VILLAGE[1], CAMP: camp(126) })) };
  t += 1_000; await s.tick();
  assert.equal(llm.calls, 2, 'the camp asked');
  pages2[pv] = { ...pages2[pv], bell: 8, bytes: b64(prov({ P: VILLAGE[0], Q: VILLAGE[1], RESOLVED_NEXT: 11, CAMP: camp(126) })) };
  pages2['/h/season'] = { genesisTs: 1000, latestUnix: 1000 + 600 * 8 + 1 };
  t += 1_000; const out = (await s.tick())[0];
  assert.deepEqual([out.skipped, llm.calls], ['rest-backoff', 2], 'a quiet turn after a rest is sat out');
  sound(r);
});
