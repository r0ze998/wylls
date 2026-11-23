// (external-wide-orders, 2026-11-23) ⑬'s local resident in a LOCAL WIDE-LAND world: the wide land's own orders — the
// wide claim 0xD9, a wide village's WideTrain / WideMuster / WideDepart (the page's planner), the rim → wide expedition
// (the page's depart route) — as candidates of its brain, steps of its ④ plans, and sends of its runner, with the same
// limits as every other order (one action per turn, the doubling hold, the journal's signature before the submit).
// KEY-FREE: the observation's `wideLand` is made here (wide.mjs createWideEyes reads it live); the send port is a fake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localCandidates, localRule, noteOutcome, settled, storesAt, LOCAL_LIMITS } from '../resident/local/brain.mjs';
import { freshState, enterWorld } from '../resident/local/journal.mjs';
import { localStep } from '../resident/local/runner.mjs';
import { makePlanSteps, checkStep, wideSteps, PLAN_ORDERS } from '../resident/local/plan.mjs';
import { WIDE_ORDERS, WIDE_LIMITS, EXPEDITION, claimNotDue, wideInventory, noteWide, wideMem } from '../resident/local/wide.mjs';
import { GOALS } from '../resident/goals.mjs';
import { createPlanExecutor } from '../resident/local/executor.mjs';
import { PLAN_LIMITS } from '../resident/local/plan.mjs';
import { createPlansClient } from '../../04-execution/clients/plans.mjs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { settlerCost } from '../../../permutation-server/web/frontier/flocalplay-wide.mjs';
import { LOCAL_ACT_NAMES } from '../../../permutation-server/web/frontier/flocalplay-act.mjs';
import { RESOURCE_ORDER } from '../../../permutation-server/web/frontier/resources.mjs';

const NOW = 1_800_000_000;
const PROD = [40, 30, 20, 15, 0, 15, 5, 0];
const RIM = { p: -64, q: -64, site: 5, tile: 7 };   // ring 128
function village({ stores = [500, 500, 300, 200, 0, 200, 0, 0], reserve = 0, production = PROD } = {}) {
  return { p: RIM.p, q: RIM.q, site: RIM.site, tile: RIM.tile, tier: 0, flags: 0, walls: 0, hostSeq: 0, lastOwnerAction: NOW,
    stores: stores.map((v, i) => ({ value: BigInt(v * 1000), rate: BigInt(production[i] * 1000), cap: 9_000_000n, t0: BigInt(NOW), frac: 0n })),
    production: production.map(x => BigInt(x * 1000)), upkeep: Array(8).fill(0n), queue: [], reserve: [reserve, 0, 0, 0, 0, 0, 0, 0], transit: [] };
}
const TARGET = { p: '-65', q: '-65' };   // ring 130, distance 1
function wideLand(o = {}) {
  return { bell: 50, villages: [], bound: 0, need: settlerCost(2), slot: 2, border: [{ p: -65, q: -64 }], targets: [{ ...TARGET, free: [2, 4] }], host: null, expedition: null, ...o };
}
function obsOf(raw, wl = wideLand(), extra = {}) {
  return { bell: 50, nowSecs: NOW, genesisTs: NOW - 30000, seasonId: '11', programVersion: 1, joined: true, faction: 3, wide: true, holding: { ...RIM },
    province: { resolvedNext: 49 }, landStage: 'final', settled: settled(raw, NOW), stores: storesAt(raw, NOW, RESOURCE_ORDER).map(s => ({ resource: s.resource, value: s.value, perHour: s.perHour, cap: s.cap })),
    ...(wl ? { wideLand: wl } : {}), ...extra };
}
const mem = (o = {}) => ({ ...freshState({ wallet: 'W', goal: 'village-first', nation: 3 }), ...o });
const RICH = [3000, 3000, 2000, 500, 0, 900, 0, 0];
const ids = c => c.candidates.map(x => x.id);
const memStore = st => ({ state: st, save() {} });

test('WO1 the wide land\'s orders are the page\'s own: every one is a local act name of the page, or its depart route (Expedition); ④ plans hold them', () => {
  for (const n of WIDE_ORDERS.filter(n => n !== EXPEDITION)) assert.ok(LOCAL_ACT_NAMES.includes(n), n);
  for (const n of WIDE_ORDERS) assert.ok(PLAN_ORDERS.includes(n), n);
  assert.ok(!PLAN_ORDERS.includes('Depart') && !PLAN_ORDERS.some(n => /Caravan/.test(n)), 'never the ordinary march, never a caravan');
});

test('WO2 a rim village within reach claims wide land when the stores hold the settler cost: the nearest target, its first free untried site, slot 2', () => {
  const c = localCandidates(obsOf(village({ stores: RICH })), mem());
  const claim = c.candidates.find(x => x.kind === 'wideclaim');
  assert.ok(claim && !claim.held, JSON.stringify(claim?.held));
  assert.deepEqual(claim.order, { name: 'WideClaim', v: { holding: { p: RIM.p, q: RIM.q, site: RIM.site }, target: TARGET }, fields: { site: 2, slot: 2 } });
  assert.equal(localRule(c).choice, 'wideclaim:-65,-65,2');
  // a tried site is not asked again; every site tried: no claim
  assert.equal(localCandidates(obsOf(village({ stores: RICH })), mem({ wide: { ...wideMem({}), triedClaims: ['-65,-65,2'] } })).candidates.find(x => x.kind === 'wideclaim').order.fields.site, 4);
  assert.ok(!ids(localCandidates(obsOf(village({ stores: RICH })), mem({ wide: { ...wideMem({}), triedClaims: ['-65,-65,2', '-65,-65,4'] } }))).some(i => i.startsWith('wideclaim')));
  // a provisional first village: the claim is held (the program refuses NotFinal), the save goes on
  const prov = localCandidates(obsOf(village({ stores: RICH }), wideLand(), { landStage: 'provisional' }), mem()).candidates.find(x => x.kind === 'wideclaim');
  assert.match(prov.held.join(' '), /not final/);
  // (the flip is lazy: untouched → a touch first; the plan's front is [Harvest, WideClaim]; touched recently → wait)
  assert.match(checkStep({ name: 'WideClaim', idx: 0, fields: {} }, obsOf(village({ stores: RICH }), wideLand(), { landStage: 'provisional' }), mem()).replan, /a touch first/);
  assert.match(checkStep({ name: 'WideClaim', idx: 0, fields: {} }, obsOf(village({ stores: RICH }), wideLand(), { landStage: 'provisional' }), mem({ lastTouchBell: 48 })).wait, /NotFinal/);
  assert.deepEqual(wideSteps(obsOf(village({ stores: RICH }), wideLand(), { landStage: 'provisional' }), mem()).map(s => s.name), ['Harvest', 'WideClaim']);
  assert.deepEqual(makePlanSteps(obsOf(village({ stores: RICH }), wideLand(), { landStage: 'provisional' }), GOALS['village-first'], { mem: mem() }).slice(0, 2).map(s => s.name), ['Harvest', 'WideClaim'], 'adjacent');
  // a wide village already, or no target in reach, or the tries spent: none
  assert.match(claimNotDue(obsOf(village(), wideLand({ villages: [{ p: '-65', q: '-65', site: 2, slot: 2 }], bound: 1 })), mem()), /wide village already/);
  assert.match(claimNotDue(obsOf(village(), wideLand({ targets: [] })), mem()), /within reach/);
  assert.match(claimNotDue(obsOf(village()), mem({ wide: { ...wideMem({}), claims: WIDE_LIMITS.claimTries } })), /stop claiming/);
});

test('WO3 short of the settler cost the claim is held and the village SAVES: what would spend the cost waits, when production covers it within the patience', () => {
  // short 700 food at 10/h (≈ 1.7/turn): ≈ 420 turns > 240 → no save, builds go on
  const slow = localCandidates(obsOf(village({ stores: [500, 1200, 600, 200, 0, 300, 0, 0], production: [10, 30, 20, 15, 0, 15, 5, 0] })), mem());
  assert.match(slow.candidates.find(x => x.kind === 'wideclaim').held.join(' '), /saving for the settler cost/);
  assert.ok(!slow.candidates.filter(x => x.kind === 'build').some(x => (x.held ?? []).some(h => /saving for the wide claim/.test(h))));
  // short 100 food: ≈ 15 turns → builds paid in food/wood/stone/gold that would dip below the cost wait
  const fast = localCandidates(obsOf(village({ stores: [1100, 1300, 700, 400, 0, 320, 0, 0] })), mem());
  const saving = fast.candidates.filter(x => (x.held ?? []).some(h => /saving for the wide claim/.test(h))).map(x => x.id);
  assert.ok(saving.length >= 1, JSON.stringify(fast.candidates.map(x => [x.id, x.held])));
  assert.ok(!saving.includes('harvest') && !saving.includes('muster:0'), 'a harvest and a muster spend nothing');
});

test('WO4 a landed claim is waited for (the runner settles it at a turn\'s end); a refused one marks its site and holds WideClaim, doubling', () => {
  const m = mem();
  const o = obsOf(village({ stores: RICH }));
  const claim = localCandidates(o, m).candidates.find(x => x.kind === 'wideclaim');
  noteOutcome(m, claim, 'landed', { bell: 50 });
  assert.equal(m.wide.claims, 1); assert.deepEqual(m.wide.claimWait, { bell: 50, site: '-65,-65,2' }); assert.deepEqual(m.wide.triedClaims, ['-65,-65,2']);
  const c2 = localCandidates({ ...o, bell: 55 }, m).candidates.find(x => x.kind === 'wideclaim');
  assert.match(c2.held.join(' '), /settled at a turn's end/);
  const r = mem();
  noteOutcome(r, claim, 'refused', { bell: 50, code: 'LocalActSendRefused' });
  assert.deepEqual(r.wide.triedClaims, ['-65,-65,2']); assert.equal(r.wide.claims, 0);
  assert.equal(r.failures.WideClaim.until, 50 + Math.min(LOCAL_LIMITS.failureHoldMaxBells, LOCAL_LIMITS.retryBackoffBells * 2));
  // not-sent (nothing reached the chain) marks nothing
  const n = mem(); noteOutcome(n, claim, 'not-sent', { bell: 50 }); assert.deepEqual(n.wide.triedClaims, []);
});

test('WO5 a wide village acts by the page\'s planner (WideTrain → WideMuster → WideDepart); a landed WideTrain is not asked again while it trains', () => {
  const v = { p: '-65', q: '-65', site: 2, slot: 2 };
  const train = { name: 'WideTrain', v: { wide: v }, fields: { unit: 0, n: 100 }, why: 'train 100' };
  const o = obsOf(village(), wideLand({ villages: [v], bound: 1, host: { decision: train } }));
  const c = localCandidates(o, mem());
  const w = c.candidates.find(x => x.kind === 'widehost');
  assert.deepEqual(w.order, { name: 'WideTrain', v: { wide: v }, fields: { unit: 0, n: 100 } });
  const m = mem(); noteOutcome(m, w, 'landed', { bell: 50 });
  assert.equal(m.wide.trainedAt, 50);
  assert.ok(!localCandidates({ ...o, bell: 55 }, m).candidates.some(x => x.kind === 'widehost'), 'training: no second WideTrain');
  assert.ok(localCandidates({ ...o, bell: 50 + WIDE_LIMITS.trainWaitBells }, m).candidates.some(x => x.kind === 'widehost'));
  // the march: its summary is remembered (the planner follows its hold), the count goes up even when the outcome is unknown
  const depart = { name: 'WideDepart', v: { wide: v, standing: { p: v.p, q: v.q } }, fields: { host: 'h', transit_slot: 0, arrive_bell: 70, tip: '0', commit: 'aa', seal: 'bb' }, to: { p: '-66', q: '-65', tile: 30, holder: 1 }, troops: 300, why: 'march' };
  const d = localCandidates(obsOf(village(), wideLand({ villages: [v], bound: 1, host: { decision: depart } })), mem()).candidates.find(x => x.kind === 'widehost');
  assert.deepEqual(d.meta, { to: { p: '-66', q: '-65', tile: 30, holder: 1 }, arrive: 70, troops: 300 });
  const m2 = mem(); noteOutcome(m2, d, 'unknown', { bell: 60 });
  assert.equal(m2.wide.departs, 1); assert.deepEqual(m2.wide.lastDepart, { to: d.meta.to, arrive: 70, troops: 300 });
  // a refused wide act holds that act only
  const m3 = mem(); noteOutcome(m3, w, 'failed', { bell: 50 }); assert.ok(m3.failures.WideTrain); assert.ok(!m3.failures.WideMuster);
});

test('WO6 a ready rim host marches into the bordering wide land (the expedition); with no host at home the village musters first; one per world', () => {
  const plan = { dest: { p: -65, q: -64 }, arriveBell: 58, host: { id: 7n, troops: 200 }, source: {}, season: {} };
  const o = obsOf(village({ reserve: 0 }), wideLand({ targets: [], expedition: { ok: true, plan } }));
  const c = localCandidates(o, mem());
  const x = c.candidates.find(y => y.kind === 'expedition');
  assert.deepEqual(x.order, { name: EXPEDITION, v: {}, fields: { dest: { p: '-65', q: '-64' }, arriveBell: 58, troops: 200, host: '7' } });
  assert.equal(x.plan, plan);
  assert.equal(localRule(c).choice, 'expedition');
  const m = mem(); noteOutcome(m, x, 'landed', { bell: 50 });
  assert.equal(m.wide.expeditions, 1);
  assert.ok(!localCandidates(o, m).candidates.some(y => y.kind === 'expedition'), 'my limit of one');
  // no host at home: the muster is preferred (reserve 300)
  const nh = localCandidates(obsOf(village({ reserve: 300 }), wideLand({ targets: [], expedition: { ok: false, why: 'no host at home', hosts: 0 } })), mem());
  assert.equal(localRule(nh).choice, 'muster:0');
  // off the rim: no expedition is asked for
  const off = obsOf(village(), wideLand({ targets: [], expedition: { ok: true, plan } }), { holding: { p: -60, q: -60, site: 1, tile: 3 } });
  assert.ok(!localCandidates(off, mem()).candidates.some(y => y.kind === 'expedition'));
});

test('WO7 ④ plans: the wide steps come first (claim, the wide host chain, the expedition), each checked as the brain checks it', () => {
  const goal = GOALS['village-first'];
  const m = mem();
  // claim affordable → WideClaim first, then the village's own steps
  const o = obsOf(village({ stores: RICH }));
  const steps = makePlanSteps(o, goal, { mem: m });
  assert.equal(steps[0].name, 'WideClaim'); assert.notEqual(steps[1].name, 'WideClaim');
  const go = checkStep({ ...steps[0], idx: 0 }, o, m);
  assert.equal(go.go.kind, 'wideclaim'); assert.equal(go.go.order.fields.site, 2); assert.equal(go.go.site, '-65,-65,2');
  // short but coverable: a wait (the save); a wide village since: a replan
  assert.match(checkStep({ ...steps[0], idx: 0 }, obsOf(village({ stores: [1100, 1300, 700, 400, 0, 320, 0, 0] })), m).wait, /saving for the settler cost/);
  const v = { p: '-65', q: '-65', site: 2, slot: 2 };
  assert.match(checkStep({ ...steps[0], idx: 0 }, obsOf(village(), wideLand({ villages: [v], bound: 1 })), m).replan, /wide village already/);
  // the wide host chain from the planner's act; another act than the step's → replan; a planner wait → wait
  const host = d => obsOf(village(), wideLand({ villages: [v], bound: 1, host: d }));
  assert.deepEqual(wideSteps(host({ decision: { name: 'WideMuster', v: { wide: v }, fields: {} } }), m).map(s => s.name), ['WideMuster', 'WideDepart']);
  assert.equal(checkStep({ name: 'WideMuster', idx: 0, fields: {} }, host({ decision: { name: 'WideMuster', v: { wide: v }, fields: { unit: 0, troops: 300, tile: 4 } } }), m).go.order.fields.troops, 300);
  assert.match(checkStep({ name: 'WideDepart', idx: 1, fields: {} }, host({ decision: { name: 'WideTrain', v: { wide: v }, fields: {} } }), m).replan, /next act is WideTrain/);
  assert.match(checkStep({ name: 'WideDepart', idx: 1, fields: {} }, host({ why: 'its host is forming or resting', wait: 'host' }), m).wait, /forming/);
  // the expedition: no host → [Train, Muster, Expedition]; ready → go
  const nh = obsOf(village({ reserve: 0 }), wideLand({ targets: [], expedition: { ok: false, hosts: 0, why: 'no host at home' } }));
  assert.deepEqual(wideSteps(nh, m).map(s => s.name), ['Train', 'Muster', EXPEDITION]);
  // a reserve at home already: muster and send before the save (a muster spends nothing of the settler cost)
  const withReserve = obsOf(village({ stores: [1100, 1300, 700, 400, 0, 320, 0, 0], reserve: 500 }), wideLand({ expedition: { ok: false, hosts: 0, why: 'no host at home' } }));
  assert.deepEqual(wideSteps(withReserve, m).map(s => [s.name, s.fields.troops]), [['Muster', 300], [EXPEDITION, undefined]]);
  const plan = { dest: { p: -65, q: -64 }, arriveBell: 58, host: { id: 7n, troops: 200 } };
  const ready = checkStep({ name: EXPEDITION, idx: 2, fields: {} }, obsOf(village(), wideLand({ targets: [], expedition: { ok: true, plan } })), m);
  assert.equal(ready.go.plan, plan);
  assert.match(checkStep({ name: EXPEDITION, idx: 2, fields: {} }, nh, m).replan, /no host at home/);
  assert.match(checkStep({ name: EXPEDITION, idx: 2, fields: {} }, obsOf(village(), wideLand({ targets: [], expedition: { ok: false, why: 'its host is not ready yet', hosts: 1 } })), m).wait, /not ready/);
  assert.match(checkStep({ name: EXPEDITION, idx: 2, fields: {} }, obsOf(village(), wideLand({ targets: [], expedition: { ok: false, why: 'no passable path into the wide land (x: RouteImpassable)', hosts: 1 } })), m).replan, /RouteImpassable/);
  // a Build step that would spend the claim being saved for: the plan is remade (the next one starts with the claim)
  const saving = obsOf(village({ stores: [1100, 1300, 700, 400, 0, 320, 0, 0] }));
  const rs = makePlanSteps(saving, goal, { mem: null }).filter(s => s.name === 'Build').map((st, i) => checkStep({ ...st, idx: i }, saving, m));
  assert.ok(rs.some(r => /saving for the wide claim/.test(r.replan ?? '')), JSON.stringify(rs));
  assert.ok(!rs.some(r => r.go), 'no build that spends the claim goes');
  // a world without the wide land: no wide step at all
  assert.deepEqual(wideSteps(obsOf(village({ stores: RICH }), null), m), []);
});

test('WO8 the runner: one action per turn with the wide orders too; an Expedition goes to the send port with its plan, its signature saved before the submit; a refusal before any signature holds it', async () => {
  const plan = { dest: { p: -65, q: -64 }, arriveBell: 58, host: { id: 7n, troops: 200 } };
  const st = mem(); enterWorld(st, '11:' + (NOW - 30000)); const store = memStore(st);
  let bell = 50; const sent = []; const followed = [];
  const observe = async () => obsOf(village(), wideLand({ targets: [], expedition: { ok: true, plan } }), { bell });
  const wide = { look: async (obs) => obs.wideLand };
  const send = async (order, { onSigned }) => { sent.push(order); assert.equal(st.journal[`b${bell}`].state, 'intended'); await onSigned('SIG' + sent.length); assert.equal(st.journal[`b${bell}`].state, 'signed'); return { outcome: 'landed', signature: 'SIG' + sent.length }; };
  const follow = async (sig, order) => { followed.push([sig, order]); return 'landed'; };
  const step = () => localStep({ store, observe: async () => { const o = await observe(); delete o.wideLand; return o; }, send, follow, bellNow: async () => bell, wide: { look: async () => wideLand({ targets: [], expedition: { ok: true, plan } }) } });
  const r1 = await step();
  assert.equal(r1.order, EXPEDITION); assert.equal(sent[0].plan, plan); assert.equal(st.wide.expeditions, 1);
  assert.equal(st.journal.b50.order, EXPEDITION); assert.deepEqual(st.journal.b50.fields.dest, { p: '-65', q: '-64' });
  const r2 = await step();
  assert.equal(r2.did, 'blocked', 'the same turn: no second order');
  // a refusal before any signature (the depart route's prepare): not sent, but the Expedition is held
  const st2 = mem(); enterWorld(st2, '11:' + (NOW - 30000));
  const r3 = await localStep({ store: memStore(st2), observe: async () => { const o = await observe(); delete o.wideLand; return o; }, wide: { look: async () => wideLand({ targets: [], expedition: { ok: true, plan } }) },
    send: async () => ({ outcome: 'refused', code: 'NotResident', signature: null, holdNotSent: true }), follow, bellNow: async () => bell });
  assert.equal(r3.outcome, 'not-sent'); assert.ok(st2.failures.Expedition, 'held'); assert.equal(st2.wide.expeditions, 0);
  // an open Expedition line is followed on the depart route (the order name is handed to follow)
  const st3 = mem(); enterWorld(st3, '11:' + (NOW - 30000));
  st3.journal.b49 = { bell: 49, id: 'expedition', kind: 'expedition', order: EXPEDITION, fields: {}, state: 'signed', signature: 'OPEN', signedAtMs: Date.now(), attempts: 1 };
  st3.lastActBell = 49;
  await localStep({ store: memStore(st3), observe: async () => { const o = await observe(); delete o.wideLand; return o; }, wide, send: async (order, { onSigned }) => { await onSigned('S3'); return { outcome: 'landed', signature: 'S3' }; }, follow, bellNow: async () => bell });
  assert.deepEqual(followed.at(-1), ['OPEN', EXPEDITION]); assert.equal(st3.journal.b49.state, 'landed'); assert.ok(st3.wide.expeditions >= 1);
  void wide;
});

test('WO9 the wide inventory is read with the page\'s parser only: a record without it (or refused) is no wide village, said, never guessed', () => {
  const r = wideInventory({ v: 1, holdings: [], slots: [] }, null, { wallet: '11111111111111111111111111111111', programId: '11111111111111111111111111111111', seasonAddress: '11111111111111111111111111111111', seasonId: '1' });
  assert.deepEqual(r.villages, []); assert.equal(r.bound, 0); assert.ok(r.unread);
  const bad = wideInventory({ v: 1, wideContext: { x: 1 }, wideHoldings: [] }, null, { wallet: '11111111111111111111111111111111', programId: '11111111111111111111111111111111', seasonAddress: '11111111111111111111111111111111', seasonId: '1' });
  assert.deepEqual(bad.villages, []); assert.ok(bad.unread);
  // a new world forgets the wide memory
  const st = mem({ wide: { ...wideMem({}), claims: 2 } }); enterWorld(st, 'other'); assert.equal(st.wide, null);
  noteWide(st, 'expedition', EXPEDITION, 'landed', { bell: 5 }); assert.equal(st.wide.expeditionUntil, 5 + WIDE_LIMITS.expeditionGapBells);
});

const BIN = process.env.WS04_RUNEXEC ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../04-execution/target/release/runexec');
test('WO10 ④ (real runexec): a plan with no wide step left is remade when the wide land has an act due — a wide village founded since leads the next plan', { skip: existsSync(BIN) ? false : `runexec is not built (${BIN})` }, async () => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'ws13-wide-plan-'));
  try {
    const plans = createPlansClient({ bin: BIN, db: path.join(d, 'plans.sqlite') });
    const logs = [];
    const ex = createPlanExecutor({ plans, owner: 'Wa11etAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', holder: 'h1', goal: GOALS['village-first'], goalName: 'village-first', limits: PLAN_LIMITS, log: (s, f) => logs.push({ s, ...f }) });
    const st = mem();
    // no wide act due (a claim landed and settling): an economy plan
    const settlingMem = { ...st, wide: { ...wideMem({}), claims: 1, claimWait: { bell: 50, site: '-65,-65,2' } } };
    const o1 = obsOf(village({ stores: RICH }));
    const n1 = await ex.next({ obs: o1, mem: settlingMem });
    assert.ok(n1.use, JSON.stringify(n1)); assert.ok(!logs.find(l => l.what === 'made').steps.some(x => WIDE_ORDERS.some(w => x.startsWith(w))), 'no wide step');
    // the wide village is founded: the plan is stopped and remade with its host's chain first
    const v = { p: '-65', q: '-65', site: 2, slot: 2 };
    const o2 = obsOf(village({ stores: RICH }), wideLand({ villages: [v], bound: 1, host: { decision: { name: 'WideTrain', v: { wide: v }, fields: { unit: 0, n: 100 }, why: 'train' } } }), { bell: 51 });
    const n2 = await ex.next({ obs: o2, mem: settlingMem });
    assert.match(n2.wait, /a wide-land act is due/);
    assert.match(logs.find(l => l.what === 'stopped').why, /the wide land has an act due \(WideTrain, WideMuster, WideDepart\)/);
    const n3 = await ex.next({ obs: o2, mem: settlingMem });
    assert.equal(n3.use?.cand.order.name, 'WideTrain', JSON.stringify(n3));
    assert.deepEqual(logs.filter(l => l.what === 'made').at(-1).steps.slice(0, 1), ['WideTrain']);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('WO11 the wide eyes read the wide land once per turn, except a province still finishing its turn (the planner\'s lag wait), read again next round', async () => {
  const { createWideEyes } = await import('../resident/local/wide.mjs');
  const v = { p: '-65', q: '-65', site: 2, slot: 2 };
  const answers = [{ why: 'the province is resolved to 9, the turn is 11', wait: 'lag', lag: 2 }, { decision: { name: 'WideMuster', v: { wide: v }, fields: {} } }];
  let asked = 0;
  const planner = { decide: async () => answers[Math.min(asked++, answers.length - 1)] };
  const march = { plan: async () => ({ ok: false, why: 'x', hosts: 1 }), herald: null };
  const eyes = createWideEyes({ herald: 'http://127.0.0.1:1', identity: { address: 'W', programId: 'P', seasonAddress: 'S' }, wideTargets: [], read: async () => [], getJson: async () => { throw new Error('no'); }, deps: { planner, march } });
  const obs = { ...obsOf(village()), wideInv: { villages: [v], bound: 1 } };
  const st = mem();
  assert.equal((await eyes.look(obs, st)).host.wait, 'lag');
  assert.equal((await eyes.look(obs, st)).host.decision.name, 'WideMuster', 'the same turn, read again after a lag');
  assert.equal(asked, 2);
  await eyes.look(obs, st); assert.equal(asked, 2, 'a decision is kept for the turn: no third read');
  await eyes.look({ ...obs, bell: obs.bell + 1 }, st); assert.equal(asked, 3, 'the next turn reads again');
});
