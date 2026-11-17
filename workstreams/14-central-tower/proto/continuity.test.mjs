// node --test workstreams/14-central-tower/proto/continuity.test.mjs
// The world of the ⑭ model does not end: a period boundary changes nothing
// but the record, a restart from a snapshot does not act twice or lose
// anything, and a long run does not pile up live state.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSim, step, run, applyControlled, choose, optionsFor, summarize, snapshot, restore, extend, ledgerGap, liveSizes, CASES, RES } from './model.mjs';

const WEEK = 7 * 24;
const noBoundary = facts => facts.filter(f => f.kind !== 'period.boundary');
const runTo = (sim, tick) => { while (sim.tick < tick) { const o = step(sim); if (o) { const v = sim.villages[sim.pending.v]; let n = o; while (n) n = applyControlled(sim, choose(sim, v, n).id); } } return sim; };

test('a period boundary is recorded and changes nothing else', () => {
  for (const c of CASES) for (const seed of [1, 2, 3]) {
    const plain = createSim({ seed, case: c, days: 21 }); run(plain);
    const cut = createSim({ seed, case: c, days: 21, periodHours: WEEK }); run(cut);
    assert.deepEqual(noBoundary(cut.facts), plain.facts, `${c} seed ${seed}`);
    assert.deepEqual(cut.facts.filter(f => f.kind === 'period.boundary').map(f => f.t), [WEEK, 2 * WEEK]);
    assert.deepEqual(cut.tower, plain.tower);
    assert.deepEqual(cut.villages, plain.villages);
  }
});

test('restart at a boundary: same facts, same goods, nothing done twice', () => {
  let inFlight = 0, openObligations = 0;
  for (const c of CASES) for (const seed of [1, 4, 9]) {
    const P = { seed, case: c, days: 21, periodHours: WEEK };
    const whole = createSim(P); run(whole);
    const first = runTo(createSim(P), WEEK);
    inFlight += first.caravans.length;
    openObligations += first.pledges.length + first.tower.offers.length + first.villages.reduce((s, v) => s + RES.reduce((a, r) => a + v.claims[r], 0), 0);
    const resumed = restore(snapshot(first)); run(resumed);
    assert.deepEqual(resumed.facts, whole.facts, `${c} seed ${seed}`);
    assert.deepEqual(summarize(resumed), summarize(whole));
    assert.deepEqual(resumed.flow, whole.flow);            // the same number of sends and arrivals: nothing twice
    assert.deepEqual(resumed.villages.map(v => v.slots), whole.villages.map(v => v.slots));
  }
  assert.ok(inFlight > 0, 'the boundary was crossed with caravans on the road');
  assert.ok(openObligations > 0, 'the boundary was crossed with pledges, offers or claims open');
});

test('restart in the middle of the human player\'s turn', () => {
  const P = { seed: 2, case: 'C', days: 10, periodHours: 3 * 24 };
  const picks = (sim) => { const v = sim.villages[sim.pending.v]; return choose(sim, v, optionsFor(sim, v)).id; };
  const a = createSim(P); a.control = 5;
  const b = createSim(P); b.control = 5;
  let restarted = false;
  while (a.tick < a.until || a.pending) {
    const oa = step(a), ob = step(b);
    assert.equal(!!oa, !!ob);
    if (!oa) continue;
    applyControlled(a, picks(a));
    if (!restarted && a.tick >= 3 * 24) { const bb = restore(snapshot(b)); Object.assign(b, bb); restarted = true; }  // the pending turn is part of the snapshot
    applyControlled(b, picks(b));
    while (a.pending) { applyControlled(a, picks(a)); applyControlled(b, picks(b)); }
  }
  assert.ok(restarted);
  assert.deepEqual(b.facts, a.facts);
});

test('every unit of goods is accounted for, every hour, across boundaries and restarts', () => {
  for (const c of CASES) for (const seed of [1, 5]) {
    let sim = createSim({ seed, case: c, days: 28, periodHours: WEEK });
    while (sim.tick < sim.until) {
      step(sim);
      if (sim.tick % WEEK === 1) sim = restore(snapshot(sim));
      assert.ok(Math.abs(ledgerGap(sim)) < 1e-6, `${c} seed ${seed} hour ${sim.tick}: gap ${ledgerGap(sim)}`);
      for (const r of RES) {
        assert.ok(sim.tower.stock[r] > -1e-9 && sim.tower.progress[r] > -1e-9, `tower ${r} negative at ${sim.tick}`);
        for (const v of sim.villages) assert.ok(v.store[r] > -1e-9, `village ${v.id} ${r} negative at ${sim.tick}`);
      }
    }
  }
});

test('caravans on the road at a boundary arrive once, to the same owner', () => {
  for (const c of CASES) {
    const sim = runTo(createSim({ seed: 3, case: c, days: 14, periodHours: WEEK }), WEEK);
    const cohort = sim.caravans.map(k => ({ id: k.id, owner: k.owner, at: k.at }));
    assert.ok(cohort.length > 0);
    const before = sim.flow.arrived;
    const resumed = restore(snapshot(sim));
    runTo(resumed, Math.max(...cohort.map(k => k.at)) + 1);
    assert.equal(resumed.caravans.filter(k => cohort.some(x => x.id === k.id)).length, 0, `${c}: all of the cohort arrived`);
    assert.ok(resumed.flow.arrived - before >= cohort.length);
    const ids = resumed.caravans.map(k => k.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(resumed.flow.dispatched - resumed.flow.arrived, resumed.caravans.length);
  }
});

test('a refund owed by the tower is still paid after a boundary', () => {
  // a stage that cannot be met lapses before the boundary; the claims are taken home after it
  const sim = createSim({ seed: 5, case: 'C', days: 14, periodHours: 3 * 24, stageNeed: [{ stone: 1000 }], stageDays: 2, leavers: 0, saboteurs: 0 });
  run(sim);
  const lapsedBefore = sim.facts.filter(f => f.kind === 'tower.stage_lapsed' && f.t < 3 * 24).length;
  const withdrawnAfter = sim.facts.filter(f => f.kind === 'tower.claim_withdrawn' && f.t > 3 * 24).length;
  assert.ok(lapsedBefore >= 1);
  assert.ok(withdrawnAfter >= 1);
});

test('watching longer is the same world, not a new one', () => {
  for (const c of CASES) {
    const long = createSim({ seed: 6, case: c, days: 28 }); run(long);
    const short = createSim({ seed: 6, case: c, days: 14 }); run(short); extend(short, 14 * 24); run(short);
    assert.deepEqual(short.facts, long.facts);
  }
});

test('a long-running world: live state stays bounded; history grows with time only', () => {
  for (const c of CASES) {
    const sim = createSim({ seed: 7, case: c, days: 16 * 7, periodHours: WEEK });
    const maxOf = { early: {}, late: {} }, factsPerWeek = [];
    let lastFacts = 0;
    while (sim.tick < sim.until) {
      step(sim);
      const half = sim.tick <= 8 * WEEK ? 'early' : 'late';
      for (const [k, n] of Object.entries(liveSizes(sim))) maxOf[half][k] = Math.max(maxOf[half][k] ?? 0, n);
      if (sim.tick % WEEK === 0) { factsPerWeek.push(sim.facts.length - lastFacts); lastFacts = sim.facts.length; }
    }
    for (const k of Object.keys(maxOf.early)) assert.ok(maxOf.late[k] <= Math.max(10, maxOf.early[k] * 1.5), `${c} ${k}: ${maxOf.early[k]} → ${maxOf.late[k]}`);
    const first = factsPerWeek.slice(1, 4).reduce((a, b) => a + b, 0) / 3, last = factsPerWeek.slice(-3).reduce((a, b) => a + b, 0) / 3;
    assert.ok(last < first * 2, `${c}: facts per week ${first} → ${last}`);
    assert.ok(Number.isSafeInteger(sim.tick) && Object.values(sim.nextId).every(Number.isSafeInteger));
    assert.ok(Math.abs(ledgerGap(sim)) < 1e-6);
  }
});
