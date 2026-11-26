// (2026-11-22) ⑬'s resident brain as an external-resident client of a local-play TEST world (resident/local/):
// the six orders only, the goals' plan on the page's own numbers, the limits (one action per turn, doubling holds,
// idle back-off, allowance), the journal (signature saved before the submit; a restart never acts twice in a turn),
// the observer's reads (own records only), the provider boundary (no charge, fail-closed). KEY-FREE: no key is made,
// derived or used (the send port is a fake that hands back a made-up signature); state files go to a temp dir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { localCandidates, localRule, decideLocal, noteOutcome, planBuildsReal, LOCAL_ORDERS, LOCAL_LIMITS, PLAN_ITEMS, settled, storesAt } from '../resident/local/brain.mjs';
import { openState, settleIntendedOnOpen, blockedWhy, freshState, enterWorld, OPEN_LINE_MS, MAX_ATTEMPTS_PER_TURN } from '../resident/local/journal.mjs';
import { localStep } from '../resident/local/runner.mjs';
import { createObserver } from '../resident/local/observe.mjs';
import { parseArgs } from '../resident/local/client.mjs';
import { UNSUPPORTED } from '../resident/live/candidates.mjs';
import { LOCAL_ACT_NAMES } from '../../../permutation-server/web/frontier/flocalplay-act.mjs';
import { RESOURCE_ORDER } from '../../../permutation-server/web/frontier/resources.mjs';

const NOW = 1_800_000_000;
const PROD = [40, 30, 20, 15, 0, 15, 5, 0];
function village({ stores = [500, 500, 300, 200, 0, 200, 0, 0], reserve = 0, queue = [], production = PROD, transit = [] } = {}) {
  return { p: 2, q: 0, site: 3, tile: 7, tier: 0, flags: 0, walls: 0, hostSeq: 0, lastOwnerAction: NOW,
    stores: stores.map((v, i) => ({ value: BigInt(v * 1000), rate: BigInt(production[i] * 1000), cap: 2_000_000n, t0: BigInt(NOW), frac: 0n })),
    production: production.map(x => BigInt(x * 1000)), upkeep: Array(8).fill(0n), queue, reserve: [reserve, 0, 0, 0, 0, 0, 0, 0], transit };
}
function obsOf(raw, extra = {}) {
  return { bell: 10, nowSecs: NOW, genesisTs: NOW - 6000, seasonId: '11', programVersion: 1, joined: true, faction: 3, holding: { p: 2, q: 0, site: 3, tile: 7 },
    province: { resolvedNext: 9 }, settled: settled(raw, NOW), stores: storesAt(raw, NOW, RESOURCE_ORDER).map(s => ({ resource: s.resource, value: s.value, perHour: s.perHour, cap: s.cap })), ...extra };
}
const mem = (o = {}) => ({ ...freshState({ wallet: 'W', goal: 'village-first', nation: 3 }), ...o });
const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'ws13-local-')); return { d, done: () => rmSync(d, { recursive: true, force: true }) }; };
const memStore = st => ({ state: st, saves: [], save() { this.saves.push(JSON.parse(JSON.stringify(this.state))); } });

test('LR1 a newcomer joins its nation by the page\'s own Join (⑤B), held without a chain clock; join is no longer "unsupported" for local play', () => {
  const c = localCandidates({ bell: 0, nowSecs: NOW, joined: false }, mem());
  assert.deepEqual(c.candidates.map(x => x.order.name), ['Join']);
  assert.equal(c.candidates[0].order.fields.faction, 3);
  assert.equal(c.candidates[0].order.fields.session_expiry, NOW + 30 * 86400 - 600);
  assert.equal(localRule(c).choice, 'join');
  const h = localCandidates({ bell: 0, nowSecs: null, joined: false }, mem());
  assert.match(h.candidates[0].held[0], /chain clock/);
  assert.equal(localRule(h).choice, 'wait');
  assert.match(UNSUPPORTED.join, /local-play/);
});

test('LR2 a citizen without a village places its home on an untried free site of its nation; tried sites are skipped', () => {
  const homes = [{ p: 2, q: 1, site: 0 }, { p: 2, q: 1, site: 1 }];
  const c = localCandidates({ bell: 3, nowSecs: NOW, joined: true, faction: 3, holding: null, homes }, mem({ triedHomes: ['2,1,0'] }));
  assert.equal(localRule(c).choice, 'home:2,1,1');
  assert.deepEqual(c.candidates[0].order.fields, { p: 2, q: 1, site: 1 });
  const none = localCandidates({ bell: 3, nowSecs: NOW, joined: true, faction: 3, holding: null, homes: [] }, mem());
  assert.equal(localRule(none).choice, 'wait');
});

test('LR3 every candidate is one of the six local orders, which the page\'s own transport lists', () => {
  for (const o of [obsOf(village()), obsOf(village({ reserve: 300 })), { bell: 0, nowSecs: NOW, joined: false }]) {
    for (const c of localCandidates(o, mem()).candidates) { assert.ok(LOCAL_ORDERS.includes(c.order.name), c.order.name); assert.ok(LOCAL_ACT_NAMES.includes(c.order.name)); }
  }
  assert.deepEqual([...LOCAL_ORDERS], LOCAL_ACT_NAMES.slice(0, 6));
});

test('LR4 village-first builds the next of its plan — what the village makes least of, on the page\'s catalog — when the stores pay for it', () => {
  const o = obsOf(village());
  const c = localCandidates(o, mem());
  assert.equal(c.assessment.next, 3);   // ore 15/h ties gold 15/h: the lower item
  assert.deepEqual(c.assessment.plan, ['Ore#1', 'Gold#1']);
  assert.equal(localRule(c).choice, 'build:3');
  // a building already counts: the next copy's number goes up and the plan moves on
  const plan = planBuildsReal(o.settled, [40, 30, 20, 21, 0, 15, 5, 0], 2);
  assert.deepEqual(plan.map(p => p.item), [4, 2]);   // gold 15/h first, then stone 20/h < ore 21/h
  assert.deepEqual(PLAN_ITEMS, [0, 1, 2, 3, 4]);
  // a mine still in the queue counts as owned (goals.mjs planBuilds), so the plan does not ask for ore again
  const q = obsOf(village({ queue: [{ kind: 1, arg: 3, delta: 6000n, doneAt: BigInt(NOW + 3600) }] }));
  assert.equal(localCandidates(q, mem()).assessment.next, 4);
});

test('LR5 when the plan\'s build is short, idle stock beyond plan and reserve trains spearmen; surplus-use trains before building', () => {
  // no wood or stone: no building is affordable; food/ore/gold beyond the plan's needs
  const o = obsOf(village({ stores: [900, 0, 0, 300, 0, 300, 0, 0] }));
  const c = localCandidates(o, mem());
  assert.equal(c.assessment.affordable, false);
  assert.ok(c.candidates.filter(x => x.kind === 'build').every(x => x.held?.some(h => /Insufficient/.test(h))));
  const d = localRule(c);
  assert.equal(d.choice, 'train:0');
  assert.equal(c.candidates.find(x => x.id === 'train:0').order.fields.n % 100, 0);
  const s = localCandidates(obsOf(village({ stores: [2000, 2000, 2000, 2000, 0, 2000, 0, 0] })), mem({ goal: 'surplus-use' }));
  // surplus-use (use 1.0, growth 0.35): idle stock to work first, although the plan's build is affordable
  assert.equal(localRule(s).choice, 'train:0');
  assert.ok(!s.candidates.find(x => x.id === 'build:3').held);
  assert.equal(localRule(localCandidates(obsOf(village({ stores: [2000, 2000, 2000, 2000, 0, 2000, 0, 0] })), mem())).choice, 'build:3', 'village-first builds');
});

test('LR6 a reserve of 100+ musters a host; nothing affordable and a recent touch → wait; otherwise a harvest at most every few turns', () => {
  const m = localCandidates(obsOf(village({ stores: [0, 0, 0, 0, 0, 0, 0, 0], reserve: 300 })), mem({ lastTouchBell: 9 }));
  assert.equal(localRule(m).choice, 'muster:0');
  assert.equal(m.candidates.find(x => x.id === 'muster:0').order.fields.troops, 300);
  // the program's resident_ok: a province the world has not resolved to the turn before holds the muster
  const lag = localCandidates(obsOf(village({ stores: [0, 0, 0, 0, 0, 0, 0, 0], reserve: 300 }), { province: { resolvedNext: 8 } }), mem({ lastTouchBell: 9 }));
  assert.match(lag.candidates.find(x => x.id === 'muster:0').held.join(), /resolved to turn 8/);
  assert.match(localCandidates(obsOf(village({ reserve: 300 }), { province: null }), mem()).candidates.find(x => x.id === 'muster:0').held.join(), /not read/);
  const w = localCandidates(obsOf(village({ stores: [0, 0, 0, 0, 0, 0, 0, 0] })), mem({ lastTouchBell: 9 }));
  assert.equal(localRule(w).choice, 'wait');
  const h = localCandidates(obsOf(village({ stores: [0, 0, 0, 0, 0, 0, 0, 0] })), mem({ lastTouchBell: 10 - LOCAL_LIMITS.touchEveryBells }));
  assert.equal(localRule(h).choice, 'harvest');
});

test('LR7 a refused or failed order is held, doubling (4, 8, 16, 32, at most 36 turns); a landing clears it; not-sent holds nothing', () => {
  const m = mem();
  const cand = { kind: 'build', order: { name: 'Build', fields: { item: 3 } } };
  const holds = [];
  for (let i = 0; i < 6; i++) { noteOutcome(m, cand, 'refused', { bell: 100, code: 'Insufficient' }); holds.push(m.failures['Build:3'].until - 100); }
  assert.deepEqual(holds, [4, 8, 16, 32, 36, 36]);
  const c = localCandidates({ ...obsOf(village()), bell: 101 }, m);
  assert.match(c.candidates.find(x => x.id === 'build:3').held.join(), /refusal/);
  noteOutcome(m, cand, 'landed', { bell: 140 });
  assert.equal(m.failures['Build:3'], undefined);
  assert.equal(m.lastTouchBell, 140);
  noteOutcome(m, cand, 'not-sent', { bell: 141 });
  assert.equal(m.failures['Build:3'], undefined);
});

test('LR8 an injected provider goes through ⑬\'s fail-closed boundary: a charging one is refused, a held or unoffered choice is a wait', () => {
  const c = localCandidates(obsOf(village({ reserve: 0 })), mem());
  assert.equal(decideLocal({ candidates: c.candidates }, { name: 'paid', decide: () => ({ choice: 'build:3' }) }).choice, 'wait');
  assert.equal(decideLocal({ candidates: c.candidates }, { name: 'free', charges: false, decide: () => ({ choice: 'muster:0' }) }).choice, 'wait');
  assert.equal(decideLocal({ candidates: c.candidates }, { name: 'free', charges: false, decide: () => ({ choice: 'send-everything' }) }).choice, 'wait');
  assert.equal(decideLocal({ candidates: c.candidates }, { name: 'free', charges: false, decide: () => ({ choice: 'harvest' }) }).choice, 'harvest');
});

// ------------------------------------------------------------------ runner + journal
function world({ bell = 10, raw = village() } = {}) {
  const w = { bell, raw, calls: 0 };
  w.observe = async () => ({ ...obsOf(w.raw), bell: w.bell });
  return w;
}
const fakeSig = n => `SIG${n}`.padEnd(88, '1');

test('LR9 one action per turn: the second step in the same turn is blocked; the next turn acts again; a send that ran in the next turn books it', async () => {
  const st = mem(); const store = memStore(st); const w = world();
  let n = 0;
  const send = async (order, { onSigned }) => { onSigned(fakeSig(++n)); return { outcome: 'landed', signature: fakeSig(n) }; };
  const r1 = await localStep({ store, observe: w.observe, send, follow: async () => 'landed', bellNow: async () => w.bell });
  assert.equal(r1.did, 'act');
  const r2 = await localStep({ store, observe: w.observe, send, follow: async () => 'landed', bellNow: async () => w.bell });
  assert.equal(r2.did, 'blocked'); assert.match(r2.why, /one action per turn/);
  w.bell = 11;
  const r3 = await localStep({ store, observe: w.observe, send, follow: async () => 'landed', bellNow: async () => 12 });   // ran in turn 12
  assert.equal(r3.did, 'act');
  w.bell = 12;
  assert.equal((await localStep({ store, observe: w.observe, send, follow: async () => 'landed', bellNow: async () => 12 })).did, 'blocked');
  assert.equal(n, 2);
  assert.equal(st.acted, 2);
});

test('LR10 the signature is saved before the submit; a crash after it leaves an open line that is followed, never sent again', async () => {
  const st = mem(); const store = memStore(st); const w = world();
  let sends = 0;
  const crash = async (order, { onSigned }) => { sends++; onSigned(fakeSig(1)); throw new Error('process died during the submit'); };
  await assert.rejects(localStep({ store, observe: w.observe, send: crash, follow: async () => null, bellNow: async () => 10 }));
  const saved = store.saves.at(-1);
  assert.equal(saved.journal.b10.state, 'signed');
  assert.equal(saved.journal.b10.signature, fakeSig(1));
  // restart in the next turn: the open line blocks a new order until it is settled
  const st2 = JSON.parse(JSON.stringify(saved)); settleIntendedOnOpen(st2); const store2 = memStore(st2);
  w.bell = 11;
  let pending = 'pending';
  const send2 = async () => { sends++; return { outcome: 'landed' }; };
  const r = await localStep({ store: store2, observe: w.observe, send: send2, follow: async () => pending, bellNow: async () => 11 });
  assert.equal(r.did, 'blocked'); assert.match(r.why, /not settled/);
  pending = 'landed';
  const r2 = await localStep({ store: store2, observe: w.observe, send: send2, follow: async () => pending, bellNow: async () => 11 });
  assert.equal(st2.journal.b10.state, 'landed');
  assert.equal(r2.did, 'act');
  assert.equal(sends, 2, 'the crashed order was never sent again; one new order in the new turn');
});

test('LR11 restart: an intended line (no signature) becomes not-sent, and the same turn may then act once; repeated not-sent gives the turn up', async () => {
  const st = mem(); st.world = '11:' + (NOW - 6000);
  st.journal.b10 = { bell: 10, id: 'build:3', kind: 'build', order: 'Build', fields: { item: 3 }, state: 'intended', at: 0, attempts: 1 };
  assert.deepEqual(settleIntendedOnOpen(st), ['b10']);
  assert.equal(blockedWhy(st, 10, Date.now()), null);
  const store = memStore(st); const w = world();
  const passing = async () => ({ outcome: 'refused', code: 'LocalActNoAnswer' });
  for (let i = 1; i < MAX_ATTEMPTS_PER_TURN; i++) assert.equal((await localStep({ store, observe: w.observe, send: passing, follow: async () => null, bellNow: async () => 10 })).outcome, 'not-sent');
  assert.match(blockedWhy(st, 10, Date.now()), /never reached the relay/);
  assert.equal(st.failures['Build:3'], undefined);
});

test('LR12 the relay\'s ResidentAlreadyActed uses the turn up (no hold); an unknown outcome stays open, then expires unsent', async () => {
  const st = mem(); const store = memStore(st); const w = world();
  const r = await localStep({ store, observe: w.observe, send: async (o, { onSigned }) => { onSigned(fakeSig(2)); return { outcome: 'refused', code: 'ResidentAlreadyActed' }; }, follow: async () => null, bellNow: async () => 10 });
  assert.equal(r.outcome, 'refused');
  assert.equal(st.lastActBell, 10);
  assert.deepEqual(st.failures, {});
  w.bell = 11;
  let t = 1_000_000;
  const u = await localStep({ store, observe: w.observe, send: async (o, { onSigned }) => { onSigned(fakeSig(3)); return { outcome: 'unknown', signature: fakeSig(3) }; }, follow: async () => 'pending', bellNow: async () => 11, nowMs: () => t });
  assert.equal(u.outcome, 'unknown');
  w.bell = 12;
  assert.equal((await localStep({ store, observe: w.observe, send: async () => assert.fail('no send while open'), follow: async () => 'pending', bellNow: async () => 12, nowMs: () => t + 1000 })).did, 'blocked');
  const e = await localStep({ store, observe: w.observe, send: async (o, { onSigned }) => { onSigned(fakeSig(4)); return { outcome: 'landed' }; }, follow: async () => 'pending', bellNow: async () => 12, nowMs: () => t + OPEN_LINE_MS + 1 });
  assert.equal(st.journal.b11.state, 'expired-unknown');
  assert.equal(e.did, 'act');
});

test('LR13 the state file is written by rename, refuses another wallet or a changed goal, and a new world starts the world memory again', () => {
  const t = tmp();
  try {
    const s = openState({ dir: t.d, wallet: 'W1', goal: 'village-first', nation: 3 });
    s.state.decisions = 7; s.state.failures = { Harvest: { count: 1, until: 9 } }; s.state.world = 'a'; s.save();
    assert.equal(JSON.parse(readFileSync(path.join(t.d, 'state.json'), 'utf8')).decisions, 7);
    assert.throws(() => openState({ dir: t.d, wallet: 'W2', goal: 'village-first', nation: 3 }), /another wallet/);
    assert.throws(() => openState({ dir: t.d, wallet: 'W1', goal: 'surplus-use', nation: 3 }), /new directory/);
    const again = openState({ dir: t.d, wallet: 'W1', goal: 'village-first', nation: 3 });
    assert.equal(again.state.decisions, 7);
    assert.equal(enterWorld(again.state, 'b'), true);
    assert.deepEqual([again.state.failures, again.state.decisions, again.state.worlds], [{}, 7, 1]);
    assert.equal(enterWorld(again.state, 'b'), false);
  } finally { t.done(); }
});

test('LR14 the halt file pauses new orders (open lines are still followed) and the allowance of decisions stops new ones', async () => {
  const st = mem(); const store = memStore(st); const w = world();
  const r = await localStep({ store, observe: w.observe, send: async () => assert.fail('halted'), follow: async () => null, bellNow: async () => 10, halted: () => true });
  assert.equal(r.did, 'halted');
  st.decisions = LOCAL_LIMITS.maxTurns;
  assert.equal((await localStep({ store, observe: w.observe, send: async () => assert.fail('max'), follow: async () => null, bellNow: async () => 10 })).did, 'max-turns');
});

test('LR15 the observer reads the Season once, the clock, its OWN /h/me, its nation\'s province pages before it has a village, then only its own province', async () => {
  const calls = [];
  const raw = village();
  let holdings = [];
  const herald = { season: async () => { calls.push('season'); return { ok: true, season: { genesisTs: NOW - 6000, programVersion: 1, seasonId: 11 } }; }, pin: () => {},
    me: async wallet => { calls.push(`me:${wallet}`); return { ok: true, citizen: { faction: 3 }, holdings }; },
    province: async (p, q) => { calls.push(`province:${p},${q}`); return { ok: true, province: { resolvedNext: 9, passableMask: 1n } }; } };
  const obs = createObserver({ base: 'http://127.0.0.1:41551', wallet: 'MINE', deps: { herald, getJson: async u => { calls.push(new URL(u).pathname); return { live: [0, NOW] }; }, publicHomes: async (b, f) => { calls.push(`homes:${f}`); return [{ p: 2, q: 1, site: 0 }]; } } });
  const a = await obs();
  assert.equal(a.bell, 10); assert.equal(a.holding, null); assert.equal(a.homes.length, 1);
  holdings = [raw];
  const b = await obs();
  assert.deepEqual(b.holding, { p: 2, q: 0, site: 3, tile: 7 });
  assert.equal(b.stores[0].value, 500);
  assert.equal(b.province.resolvedNext, 9);
  assert.deepEqual(calls, ['season', '/h/status', 'me:MINE', 'homes:3', '/h/status', 'me:MINE', 'province:2,0']);
});

test('LR16 the client\'s arguments: loopback only, an absolute state directory, a known goal', () => {
  const ok = parseArgs(['--launcher', 'http://localhost:41550', '--key', 'k.json', '--dir', '/tmp/x', '--goal', 'surplus-use', '--nation', '2']);
  assert.deepEqual([ok.goal, ok.nation, ok.cadenceMs], ['surplus-use', 2, 3000]);
  assert.throws(() => parseArgs(['--launcher', 'http://example.com', '--key', 'k', '--dir', '/tmp/x']), /loopback/);
  assert.throws(() => parseArgs(['--launcher', 'http://localhost:41550', '--key', 'k', '--dir', 'rel']), /absolute/);
  assert.throws(() => parseArgs(['--launcher', 'http://localhost:41550', '--key', 'k', '--dir', '/tmp/x', '--goal', 'conquer']), /goal/);
  assert.throws(() => parseArgs(['--launcher', 'http://localhost:41550', '--key', 'k', '--dir', '/tmp/x', '--mcp', 'http://10.0.0.1:1/mcp']), /loopback/);
});

// ------------------------------------------------------------------ external-wide: a local wide-land world
import { WIDE_HOME_ORDER, TICKET_WAIT_BELLS } from '../resident/local/brain.mjs';
import { publicWideHomes } from '../../03-composability/mcp/examples/external-resident/public.mjs';
import { homeNation } from '../../../permutation-server/web/frontier/fgeo.mjs';

test('LW1 in a wide world a rim first village is the page\'s one-site request (FileTicket); a heartland one stays PlaceHome; no wide-land order before a village (local-wide.test.mjs has those)', () => {
  const homes = [{ p: 68, q: 60, site: 1, ticket: true }, { p: 2, q: 1, site: 0, ticket: false }];
  const c = localCandidates({ bell: 5, nowSecs: NOW, joined: true, faction: 3, holding: null, homes, wide: true }, mem());
  assert.equal(localRule(c).choice, 'home:68,60,1');
  assert.deepEqual(c.candidates.map(x => x.order.name), [WIDE_HOME_ORDER, 'PlaceHome']);
  assert.deepEqual(c.candidates[0].order.fields, { sites: [{ p: 68, q: 60, site: 1 }] });
  assert.deepEqual(c.candidates[0].order.v, { sites: [{ p: 68, q: 60, site: 1 }] });
  assert.equal(WIDE_HOME_ORDER, LOCAL_ACT_NAMES[6], 'the page\'s seventh local order');
  for (const x of c.candidates) assert.ok(LOCAL_ACT_NAMES.includes(x.order.name));
  // (a `ticket` mark outside a wide world changes nothing: PlaceHome as before)
  const plain = localCandidates({ bell: 5, nowSecs: NOW, joined: true, faction: 3, holding: null, homes }, mem());
  assert.deepEqual(plain.candidates.map(x => x.order.name), ['PlaceHome', 'PlaceHome']);
  // (with a village, in a wide world: the same six orders as anywhere — no wide claim, no wide host act)
  for (const x of localCandidates(obsOf(village({ reserve: 300 }), { wide: true }), mem()).candidates) assert.ok(LOCAL_ORDERS.includes(x.order.name), x.order.name);
});

test('LW2 a landed rim request is waited for (no second request), its site never asked again; a refusal holds FileTicket only', () => {
  const homes = [{ p: 68, q: 60, site: 1, ticket: true }, { p: 68, q: 60, site: 2, ticket: true }];
  const m = mem();
  const c = localCandidates({ bell: 5, nowSecs: NOW, joined: true, faction: 3, holding: null, homes, wide: true }, m);
  noteOutcome(m, c.candidates[0], 'landed', { bell: 5 });
  assert.deepEqual(m.ticket, { bell: 5, site: '68,60,1' });
  assert.deepEqual(m.triedHomes, ['68,60,1']);
  const w = localCandidates({ bell: 6, nowSecs: NOW, joined: true, faction: 3, holding: null, homes, wide: true }, m);
  assert.equal(localRule(w).choice, 'wait');
  assert.match(w.candidates[0].held.join(' '), /village request for 68,60,1 \(turn 5\) waits/);
  // (past the wait, with no village: the next untried site)
  const later = localCandidates({ bell: 5 + TICKET_WAIT_BELLS, nowSecs: NOW, joined: true, faction: 3, holding: null, homes, wide: true }, m);
  assert.equal(localRule(later).choice, 'home:68,60,2');
  // (a refused request: that site tried, FileTicket held by the doubling rule, PlaceHome not)
  const r = mem();
  const c2 = localCandidates({ bell: 5, nowSecs: NOW, joined: true, faction: 3, holding: null, homes: [...homes, { p: 2, q: 1, site: 0, ticket: false }], wide: true }, r);
  noteOutcome(r, c2.candidates[0], 'failed', { bell: 5, code: 'Custom(9)' });
  assert.deepEqual(r.triedHomes, ['68,60,1']);
  assert.ok(r.failures.FileTicket && !r.failures.PlaceHome);
  const c3 = localCandidates({ bell: 6, nowSecs: NOW, joined: true, faction: 3, holding: null, homes: [...homes, { p: 2, q: 1, site: 0, ticket: false }], wide: true }, r);
  assert.equal(localRule(c3).choice, 'home:2,1,0');
  // (a new world forgets the request)
  enterWorld(m, 'other'); assert.equal(m.ticket, null);
});

test('LW2b (LP20-4) a rim request lost to a nation-mate ends the wait as soon as my citizen record shows no open request, never before its turn can have settled', () => {
  const homes = [{ p: -65, q: -63, site: 9, ticket: true }, { p: 65, q: 63, site: 11, ticket: true }];
  const m = mem();
  const at = (bell, landStage, h = homes) => localCandidates({ bell, nowSecs: NOW, joined: true, faction: 3, holding: null, homes: h, wide: true, landStage }, m);
  noteOutcome(m, { kind: 'home', order: { name: WIDE_HOME_ORDER, fields: { sites: [{ p: -65, q: -63, site: 8 }] } } }, 'landed', { bell: 155 });
  // (the request is open: the wait holds, as before)
  assert.equal(localRule(at(160, 'ticket')).choice, 'wait');
  // (a record read in the turn after the filing that shows no request may not have seen it land yet: still waiting)
  assert.equal(localRule(at(156, 'joined')).choice, 'wait');
  // (the runner settled it and I have no village: the next untried site now, not at turn 227)
  assert.equal(localRule(at(166, 'joined')).choice, 'home:-65,-63,9');
  // (an observer that does not say the stage keeps the timer)
  assert.equal(localRule(at(166, null)).choice, 'wait');
  assert.equal(localRule(at(155 + TICKET_WAIT_BELLS, null)).choice, 'home:-65,-63,9');
});

test('LW2c (LP20-4) the observer says the citizen\'s land stage when it has no village (the same /h/me answer)', async () => {
  const NO = 0xffffffff;
  const citizen = (ticketBell) => ({ faction: 3, ticketEscrow: '0', ticketBell, ticketNext: 0, ticketSites: [{ p: -65, q: -63, site: 8 }] });
  let c = citizen(155);
  const herald = { season: async () => ({ ok: true, season: { genesisTs: NOW - 600, programVersion: 1, seasonId: 11 } }), me: async () => ({ ok: true, citizen: c, holdings: [] }), pin() {} };
  const obs = createObserver({ base: 'http://127.0.0.1:41551', wallet: 'MINE', wide: true, deps: { herald, getJson: async () => ({ live: [0, NOW] }), publicHomes: async () => [], publicWideHomes: async () => [] } });
  assert.equal((await obs()).landStage, 'ticket');
  c = citizen(NO);
  assert.equal((await obs()).landStage, 'joined');
});

test('LW3 the observer of a wide world reads the outward candidates once per turn (public reads only)', async () => {
  const calls = [];
  const herald = { season: async () => ({ ok: true, season: { genesisTs: NOW - 600, programVersion: 1, seasonId: 11 } }), me: async () => ({ ok: true, citizen: { faction: 3 }, holdings: [] }), pin() {} };
  let t = NOW;
  const obs = createObserver({ base: 'http://127.0.0.1:41551', wallet: 'MINE', wide: true, deps: { herald, getJson: async () => ({ live: [0, t] }),
    publicHomes: async () => { calls.push('heartland'); return []; },
    publicWideHomes: async (b, f, o) => { calls.push(`wide:${f}:${o.seed}:${o.nowBell}`); return [{ p: 68, q: 60, site: 1, ticket: true }]; } } });
  const a = await obs(); const b = await obs();
  assert.equal(a.wide, true); assert.deepEqual(a.homes, [{ p: 68, q: 60, site: 1, ticket: true }]); assert.deepEqual(b.homes, a.homes);
  t += 600; await obs();
  assert.deepEqual(calls, ['wide:3:MINE:1', 'wide:3:MINE:2']);
});

test('LW4 publicWideHomes = the page\'s planHomes of a wide local page: outward, settled rim provinces of my nation, read from the outermost ring in', async () => {
  const seed = new Uint8Array(32);
  const place = { placement: 2, heartlandMaxRing: 3, genesisSeed: seed };
  const faction = homeNation(68, 60, place);
  const reads = [];
  const prov = { p: 68, q: 60, siteCount: 3, sites: [1, 2, 3], siteMirror: [{ state: 1, gen: 0 }, { state: 0, gen: 0 }, { state: 0, gen: 0 }], ticketCohorts: [] };
  const herald = {
    season: async () => ({ ok: true, season: { conquestParams: { placement: 2, heartlandMaxRing: 3 }, genesisSeed: seed }, record: { rings: Array.from({ length: 129 }, (_, d) => ({ d })) } }),
    overview: async d => { reads.push(`ov:${d}`); return { ok: true, ring: d, provinces: d === 128 ? [{ p: 68, q: 60, sites: [1, 0, 0], owners: [faction, 7, 7] }] : [] }; },
    province: async (p, q) => { reads.push(`pv:${p},${q}`); return { ok: true, province: prov }; },
  };
  const homes = await publicWideHomes('http://127.0.0.1:41551', faction, { herald, seed: 'MINE' });
  assert.ok(homes.length >= 1);
  assert.ok(homes.every(h => h.p === 68 && h.q === 60 && h.ticket === true && [1, 2].includes(h.site)), JSON.stringify(homes));
  assert.deepEqual(reads.filter(r => r.startsWith('ov:')), Array.from({ length: 8 }, (_, i) => `ov:${128 - i}`), 'the outermost group only: the farthest ring wins');
  // (another nation: nothing of mine on the rim → every ring read inward, still nothing)
  reads.length = 0;
  assert.deepEqual(await publicWideHomes('http://127.0.0.1:41551', (faction + 1) % 6, { herald }), []);
  assert.equal(reads.filter(r => r.startsWith('ov:')).length, 127);
});
