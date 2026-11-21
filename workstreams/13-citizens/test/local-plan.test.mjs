// (2026-11-22) workstream 04 as the multi-turn PLAN executor inside ⑬'s local resident (resident/local/plan.mjs,
// executor.mjs, runner.mjs `plan`; workstreams/04-execution src/plans.rs through clients/plans.mjs). The store is the
// REAL runexec binary on a temp SQLite file (skipped when it is not built: `cd workstreams/04-execution && cargo build
// --release --locked --bin runexec`, or WS04_RUNEXEC=<path>). KEY-FREE: the send port is a fake that hands back
// made-up signatures; the world is a fixture village whose production grows as builds land.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { makePlanSteps, checkStep, planSpec, PLAN_LIMITS } from '../resident/local/plan.mjs';
import { createPlanExecutor } from '../resident/local/executor.mjs';
import { localStep } from '../resident/local/runner.mjs';
import { freshState, settleIntendedOnOpen, OPEN_LINE_MS } from '../resident/local/journal.mjs';
import { parseArgs } from '../resident/local/client.mjs';
import { createPlansClient } from '../../04-execution/clients/plans.mjs';
import { GOALS } from '../resident/goals.mjs';
import { settled, storesAt } from '../resident/local/brain.mjs';
import { BUILD_ITEMS } from '../../../permutation-server/web/frontier/fland.mjs';
import { RESOURCE_ORDER } from '../../../permutation-server/web/frontier/resources.mjs';
import { LOCAL_ACT_NAMES } from '../../../permutation-server/web/frontier/flocalplay-act.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const BIN = process.env.WS04_RUNEXEC ?? path.resolve(here, '../../04-execution/target/release/runexec');
const skip = existsSync(BIN) ? false : `runexec is not built (${BIN})`;

const NOW = 1_800_000_000;
const PROD = [40, 30, 20, 15, 10, 15, 5, 0];
function village({ stores = [5000, 5000, 5000, 5000, 5000, 5000, 0, 0], reserve = 0, queue = [], production = PROD } = {}) {
  return { p: 2, q: 0, site: 3, tile: 7, tier: 0, flags: 0, walls: 0, hostSeq: 0, lastOwnerAction: NOW,
    stores: stores.map((v, i) => ({ value: BigInt(v * 1000), rate: BigInt(production[i] * 1000), cap: 9_000_000n, t0: BigInt(NOW), frac: 0n })),
    production: production.map(x => BigInt(x * 1000)), upkeep: Array(8).fill(0n), queue, reserve: [reserve, 0, 0, 0, 0, 0, 0, 0], transit: [] };
}
function obsOf(raw, extra = {}) {
  return { bell: 10, nowSecs: NOW, genesisTs: NOW - 6000, seasonId: '11', programVersion: 1, joined: true, faction: 3, holding: { p: 2, q: 0, site: 3, tile: 7 },
    province: { resolvedNext: 9 }, settled: settled(raw, NOW), stores: storesAt(raw, NOW, RESOURCE_ORDER).map(s => ({ resource: s.resource, value: s.value, perHour: s.perHour, cap: s.cap })), ...extra };
}
const mem = () => ({ ...freshState({ wallet: 'Wa11etAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', goal: 'village-first', nation: 3 }) });
const memStore = st => ({ state: st, saves: [], save() { this.saves.push(JSON.parse(JSON.stringify(this.state))); } });
const fakeSig = n => `SIG${n}Z`.padEnd(88, 'x');
const OWNER = 'Wa11etAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

/** A world whose village takes each landed order in: a build raises that resource's production (a built copy). */
function world({ bell = 10 } = {}) {
  const w = { bell, raw: village(), province: 9, landed: [] };
  w.observe = async () => ({ ...obsOf(w.raw), bell: w.bell, province: { resolvedNext: w.province } });
  w.apply = order => {
    w.landed.push({ bell: w.bell, name: order.name, fields: order.fields });
    if (order.name === 'Build') { const r = RESOURCE_ORDER.indexOf(BUILD_ITEMS[order.fields.item].resource); w.raw.production[r] += BigInt(BUILD_ITEMS[order.fields.item].perHour * 1000); w.raw.stores[r].rate = w.raw.production[r]; }
    if (order.name === 'Train') w.raw.reserve[0] = Number(w.raw.reserve[0]) + order.fields.n;
    if (order.name === 'Muster') w.raw.reserve[0] = Number(w.raw.reserve[0]) - order.fields.troops;
  };
  return w;
}

function rig({ db, clock, holder = 'h1', steps = 12 }) {
  const logs = [];
  const plans = createPlansClient({ bin: BIN, db, nowMs: () => clock.t });
  const plan = createPlanExecutor({ plans, owner: OWNER, holder, goal: GOALS['village-first'], goalName: 'village-first', limits: { ...PLAN_LIMITS, steps }, leaseMs: 20_000, log: (s, f) => logs.push({ s, ...f }), nowMs: () => clock.t });
  return { plans, plan, logs };
}
const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'ws04-plan-')); return { d, db: path.join(d, 'plans.sqlite'), done: () => rmSync(d, { recursive: true, force: true }) }; };

test('LP1 a new plan: 12 steps of the six local orders only (no caravan), a build chain on the page\'s catalogue with copy numbers, training, a host last', () => {
  const steps = makePlanSteps(obsOf(village()), GOALS['village-first']);
  assert.equal(steps.length, 12);
  for (const s of steps) { assert.ok(LOCAL_ACT_NAMES.slice(0, 6).includes(s.name), s.name); assert.doesNotMatch(s.name, /Caravan/); }
  assert.deepEqual(steps.map(s => s.name), ['Build', 'Build', 'Build', 'Harvest', 'Train', 'Build', 'Build', 'Train', 'Build', 'Build', 'Build', 'Muster']);
  // copy numbers run on per item (the plan counts its own earlier builds)
  const last = {};
  for (const s of steps.filter(x => x.name === 'Build')) { if (last[s.fields.item] !== undefined) assert.equal(s.expect.copy, last[s.fields.item] + 1); last[s.fields.item] = s.expect.copy; }
  assert.equal(steps.at(-1).fields.tile, 7);
  assert.equal(makePlanSteps({ holding: null }, GOALS['village-first']), null);
  assert.equal(planSpec({ planId: 'x', owner: 'o', world: 'w', goal: 'g', steps }).schema, 'p04-plan/0.1');
});

test('LP2 a step is checked as the page checks a person\'s order: go, wait (coverable shortfall, full queue, reserve, resident_ok) or replan (changed world)', () => {
  const o = obsOf(village());
  const [b0] = makePlanSteps(o, GOALS['village-first']).map((s, idx) => ({ ...s, idx }));
  assert.equal(checkStep(b0, o, mem()).go.order.name, 'Build');
  // the copy exists already (it landed outside the plan's knowledge): a replan, never a second copy by mistake
  assert.match(checkStep({ ...b0, expect: { copy: b0.expect.copy + 1 } }, o, mem()).replan, /state changed/);
  // short, production covers it soon → wait; nothing produces it → replan
  const poor = obsOf(village({ stores: [0, 0, 0, 0, 0, 0, 0, 0] }));
  assert.match(checkStep(b0, poor, mem(), { patience: 48 }).wait, /short/);
  const dead = obsOf(village({ stores: [0, 0, 0, 0, 0, 0, 0, 0], production: [0, 0, 0, 0, 0, 0, 0, 0] }));
  assert.match(checkStep(b0, dead, mem()).replan, /short/);
  const full = obsOf(village({ queue: [{ kind: 1, arg: 0, doneAt: BigInt(NOW + 9000) }, { kind: 1, arg: 1, doneAt: BigInt(NOW + 9000) }] }));
  assert.match(checkStep(b0, full, mem()).wait, /queue is full/);
  const muster = { idx: 11, name: 'Muster', fields: { unit: 0, troops: 100, tile: 7 }, expect: { reserveAtLeast: 100 } };
  assert.match(checkStep(muster, o, mem()).wait, /reserve 0/);
  const rich = obsOf(village({ reserve: 200 }));
  assert.equal(checkStep(muster, rich, mem()).go.order.fields.troops, 100);
  assert.match(checkStep(muster, { ...rich, province: { resolvedNext: 5 } }, mem()).wait, /resident_ok/);
  assert.match(checkStep({ ...muster, fields: { ...muster.fields, tile: 8 } }, rich, mem()).replan, /tile/);
  assert.equal(checkStep({ idx: 4, name: 'Train', fields: { unit: 0, n: 100 }, expect: {} }, o, mem()).go.order.name, 'Train');
  assert.equal(checkStep({ idx: 3, name: 'Harvest', fields: {}, expect: {} }, o, mem()).go.order.name, 'Harvest');
});

test('LP3 a 12-step plan runs to done in workstream 04\'s store, one step per turn, each landed once', { skip }, async () => {
  const t = tmp(); const clock = { t: 1_000_000 };
  try {
    const { plan, plans } = rig({ db: t.db, clock });
    const st = mem(); const store = memStore(st); const w = world();
    let n = 0;
    const send = async (order, { onSigned }) => { await onSigned(fakeSig(++n)); w.apply(order); return { outcome: 'landed', signature: fakeSig(n) }; };
    for (let i = 0; i < 40 && w.landed.length < 13; i++) {
      await localStep({ store, observe: w.observe, send, follow: async () => 'landed', bellNow: async () => w.bell, plan, nowMs: () => clock.t });
      await localStep({ store, observe: w.observe, send, follow: async () => 'landed', bellNow: async () => w.bell, plan, nowMs: () => clock.t });   // a second look in the same turn: blocked
      w.bell += 1; clock.t += 10_000;
      w.province = w.bell - 1;   // the province keeps up (resident_ok)
    }
    const cur = await plans.current({ owner: OWNER, world: `11:${NOW - 6000}` });
    const first = await plans.view({ plan: `${OWNER.slice(0, 8)}.11.1` });
    assert.equal(first.state, 'done', JSON.stringify(first.transitions.slice(-3)));
    assert.equal(first.landed, 12);
    const bells = w.landed.slice(0, 12).map(x => x.bell);
    assert.equal(new Set(bells).size, 12, 'one action per turn');
    assert.ok(cur.plans >= 1);
    assert.deepEqual(w.landed.slice(0, 12).map(x => x.name), first.steps.map(s => s.name));
  } finally { t.done(); }
});

test('LP4 SIGKILL after the signature was recorded: the restarted resident (a new holder) waits out the old lease, settles the step by its signature, never sends it again', { skip }, async () => {
  const t = tmp(); const clock = { t: 2_000_000 };
  try {
    const st = mem(); const store = memStore(st); const w = world();
    let submits = 0;
    const a = rig({ db: t.db, clock, holder: 'pid-A' });
    // step 0 lands normally
    await localStep({ store, observe: w.observe, send: async (o, { onSigned }) => { await onSigned(fakeSig(1)); submits++; w.apply(o); return { outcome: 'landed', signature: fakeSig(1) }; }, follow: async () => 'landed', bellNow: async () => w.bell, plan: a.plan, nowMs: () => clock.t });
    w.bell = 11; clock.t += 10_000;
    // step 1: signed, submitted, the process dies before it hears anything (SIGKILL)
    let pendingOrder = null;
    await assert.rejects(localStep({ store, observe: w.observe, send: async (o, { onSigned }) => { await onSigned(fakeSig(2)); submits++; pendingOrder = o; throw new Error('SIGKILL'); }, follow: async () => null, bellNow: async () => 11, plan: a.plan, nowMs: () => clock.t }));
    // restart: memory from the last save, a new process (new holder)
    const st2 = JSON.parse(JSON.stringify(store.saves.at(-1))); settleIntendedOnOpen(st2); const store2 = memStore(st2);
    const b = rig({ db: t.db, clock, holder: 'pid-B' });
    clock.t += 1_000; w.bell = 12;
    let followed = 'pending';
    const send2 = async (o, { onSigned }) => { await onSigned(fakeSig(10 + submits)); submits++; w.apply(o); return { outcome: 'landed', signature: fakeSig(10 + submits) }; };
    const r1 = await localStep({ store: store2, observe: w.observe, send: send2, follow: async () => followed, bellNow: async () => 12, plan: b.plan, nowMs: () => clock.t });
    assert.equal(r1.did, 'blocked', 'the journal\'s open line blocks');
    // the order did land on chain while we were down
    w.apply(pendingOrder); followed = 'landed';
    clock.t += 25_000;   // the old lease (20 s) ran out
    const r2 = await localStep({ store: store2, observe: w.observe, send: send2, follow: async () => followed, bellNow: async () => 12, plan: b.plan, nowMs: () => clock.t });
    assert.equal(r2.did, 'act');
    const v = await b.plans.view({ plan: `${OWNER.slice(0, 8)}.11.1` });
    assert.equal(v.steps[1].state, 'landed');
    assert.equal(v.steps[1].signature, fakeSig(2), 'settled by the recorded signature');
    assert.equal(v.steps[2].state, 'landed');
    assert.equal(submits, 3, 'step 1 was never submitted again');
    assert.equal(v.lease.holder, 'pid-B');
    assert.ok(b.logs.some(l => l.what === 'reconciled' && l.outcome === 'landed'));
  } finally { t.done(); }
});

test('LP5 a crash between the intent and the signature: nothing left; the next holder\'s claim makes it not-sent and the step is sent once', { skip }, async () => {
  const t = tmp(); const clock = { t: 3_000_000 };
  try {
    const st = mem(); const store = memStore(st); const w = world();
    const a = rig({ db: t.db, clock, holder: 'pid-A' });
    await assert.rejects(localStep({ store, observe: w.observe, send: async () => { throw new Error('SIGKILL before signing'); }, follow: async () => null, bellNow: async () => 10, plan: a.plan, nowMs: () => clock.t }));
    const st2 = JSON.parse(JSON.stringify(store.saves.at(-1))); settleIntendedOnOpen(st2); const store2 = memStore(st2);
    const b = rig({ db: t.db, clock, holder: 'pid-B' });
    clock.t += 21_000;
    let submits = 0;
    const r = await localStep({ store: store2, observe: w.observe, send: async (o, { onSigned }) => { await onSigned(fakeSig(5)); submits++; w.apply(o); return { outcome: 'landed', signature: fakeSig(5) }; }, follow: async () => null, bellNow: async () => 10, plan: b.plan, nowMs: () => clock.t });
    assert.equal(r.did, 'act');
    const v = await b.plans.view({ plan: `${OWNER.slice(0, 8)}.11.1` });
    assert.equal(v.steps[0].state, 'landed');
    assert.equal(v.steps[0].attempts, 2);
    assert.equal(submits, 1);
    assert.ok(b.logs.some(l => l.what === 'claimed' && l.resetIntents === 1));
  } finally { t.done(); }
});

test('LP6 the chain refuses a step: the plan stops and the next turn\'s plan replaces it, made from what the world shows', { skip }, async () => {
  const t = tmp(); const clock = { t: 4_000_000 };
  try {
    const st = mem(); const store = memStore(st); const w = world();
    const { plan, plans, logs } = rig({ db: t.db, clock });
    let n = 0;
    await localStep({ store, observe: w.observe, send: async (o, { onSigned }) => { await onSigned(fakeSig(++n)); return { outcome: 'failed', code: 'Custom(26)', signature: fakeSig(n) }; }, follow: async () => null, bellNow: async () => 10, plan, nowMs: () => clock.t });
    const p1 = await plans.view({ plan: `${OWNER.slice(0, 8)}.11.1` });
    assert.equal(p1.state, 'stopped');
    assert.match(p1.stopReason, /chain-refused.*Custom\(26\)/);
    w.bell = 11; clock.t += 10_000;
    // (the refused build is held by the brain's failure memory: the new plan waits on it or builds something else)
    await localStep({ store, observe: w.observe, send: async (o, { onSigned }) => { await onSigned(fakeSig(++n)); w.apply(o); return { outcome: 'landed', signature: fakeSig(n) }; }, follow: async () => null, bellNow: async () => 11, plan, nowMs: () => clock.t });
    const cur = await plans.current({ owner: OWNER, world: `11:${NOW - 6000}` });
    assert.equal(cur.active.replaces, p1.planId);
    assert.ok(logs.some(l => l.what === 'made' && /replan: chain-refused/.test(l.why)));
  } finally { t.done(); }
});

test('LP7 a second copy of the resident cannot act on a plan another holds; a stale holder\'s signature is refused, so it never submits', { skip }, async () => {
  const t = tmp(); const clock = { t: 5_000_000 };
  try {
    const w = world();
    const a = rig({ db: t.db, clock, holder: 'pid-A' });
    const b = rig({ db: t.db, clock, holder: 'pid-B' });
    const sa = memStore(mem()), sb = memStore(mem());
    let submits = 0;
    const ok = async (o, { onSigned }) => { await onSigned(fakeSig(++submits + 20)); w.apply(o); return { outcome: 'landed', signature: fakeSig(submits + 20) }; };
    assert.equal((await localStep({ store: sa, observe: w.observe, send: ok, follow: async () => null, bellNow: async () => 10, plan: a.plan, nowMs: () => clock.t })).did, 'act');
    w.bell = 11; clock.t += 5_000;
    const rb = await localStep({ store: sb, observe: w.observe, send: ok, follow: async () => null, bellNow: async () => 11, plan: b.plan, nowMs: () => clock.t });
    assert.equal(rb.did, 'plan-wait'); assert.match(rb.why, /held by pid-A/);
    // A stalls between its intent and its signature; B takes over after the lease; A's signature is fenced: no submit
    w.bell = 12; clock.t += 1_000;
    let aSubmitted = false;
    const stalled = async (o, { onSigned }) => {
      clock.t += 30_000;
      await localStep({ store: sb, observe: w.observe, send: ok, follow: async () => null, bellNow: async () => 12, plan: b.plan, nowMs: () => clock.t });
      try { await onSigned(fakeSig(99)); } catch (e) { return { outcome: 'refused', code: e.code }; }
      aSubmitted = true; return { outcome: 'landed', signature: fakeSig(99) };
    };
    const ra = await localStep({ store: sa, observe: w.observe, send: stalled, follow: async () => null, bellNow: async () => 12, plan: a.plan, nowMs: () => clock.t });
    assert.equal(aSubmitted, false);
    assert.equal(ra.outcome, 'not-sent');
    const v = await b.plans.view({ plan: `${OWNER.slice(0, 8)}.11.1` });
    assert.equal(v.lease.holder, 'pid-B');
    assert.equal(v.steps.filter(s => s.state === 'landed').length, 2);
    assert.equal(new Set(w.landed.map(x => x.bell)).size, w.landed.length, 'one action per turn across both copies');
  } finally { t.done(); }
});

test('LP8 an unknown outcome past the blockhash life stops the plan (outcome-unknown), never resends; the replan reads the world', { skip }, async () => {
  const t = tmp(); const clock = { t: 6_000_000 };
  try {
    const st = mem(); const store = memStore(st); const w = world();
    const { plan, plans } = rig({ db: t.db, clock });
    let submits = 0;
    await localStep({ store, observe: w.observe, send: async (o, { onSigned }) => { await onSigned(fakeSig(30)); submits++; return { outcome: 'unknown', signature: fakeSig(30) }; }, follow: async () => 'pending', bellNow: async () => 10, plan, nowMs: () => clock.t });
    w.bell = 11; clock.t += OPEN_LINE_MS + 1;
    const send = async (o, { onSigned }) => { await onSigned(fakeSig(31)); submits++; w.apply(o); return { outcome: 'landed', signature: fakeSig(31) }; };
    await localStep({ store, observe: w.observe, send, follow: async () => 'pending', bellNow: async () => 11, plan, nowMs: () => clock.t });
    const p1 = await plans.view({ plan: `${OWNER.slice(0, 8)}.11.1` });
    assert.equal(p1.state, 'stopped');
    assert.match(p1.stopReason, /^outcome-unknown/);
    assert.equal(p1.steps[0].state, 'expired-unknown');
    assert.ok(submits <= 2);
  } finally { t.done(); }
});

test('LP9 caravans are refused by the store itself (owner question Q4), and the client\'s --plan flags', { skip }, async () => {
  const t = tmp();
  try {
    const plans = createPlansClient({ bin: BIN, db: t.db });
    await assert.rejects(plans.accept(planSpec({ planId: 'c', owner: OWNER, world: 'w', goal: 'g', steps: [{ name: 'SendCaravan', fields: {}, expect: {} }] })), e => e.code === 'NotLocalOrder' && /Q4/.test(e.message));
    const base = ['--launcher', 'http://localhost:41550', '--key', '/k', '--dir', '/tmp/r'];
    const o = parseArgs([...base, '--plan', '--runexec', BIN]);
    assert.equal(o.plan, true); assert.equal(o.planDb, '/tmp/r/plans.sqlite'); assert.equal(o.planSteps, 12);
    assert.throws(() => parseArgs([...base, '--plan']), /--runexec/);
    assert.throws(() => parseArgs([...base, '--runexec', BIN]), /go with --plan/);
    assert.throws(() => parseArgs([...base, '--plan', '--runexec', BIN, '--plan-db', 'rel.sqlite']), /absolute/);
    assert.equal(parseArgs(base).plan, false);
  } finally { t.done(); }
});
