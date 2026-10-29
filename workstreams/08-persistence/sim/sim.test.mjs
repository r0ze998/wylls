// node --test workstreams/08-persistence/sim/
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, step, run, goodsInWorld, goodsByLedger, isOnline, boundary } from './world.mjs';
import { BASE } from './params.mjs';
import { PROPOSALS } from './proposals.mjs';
import { SCENARIOS } from './scenarios.mjs';
import { measure, experiment } from './run.mjs';
import { renderMarkdown } from './report.mjs';
import { gini, quantile, hhi } from './stats.mjs';
import { draw } from './rng.mjs';

const U = BASE.periodDays * 24;
const P_SHORT = { ...BASE, periods: 2 };

test('the same seed gives the same world; another seed does not', () => {
  for (const p of Object.values(PROPOSALS)) {
    const a = JSON.stringify(measure(run(P_SHORT, p, SCENARIOS.standard, 7)));
    const b = JSON.stringify(measure(run(P_SHORT, p, SCENARIOS.standard, 7)));
    const c = JSON.stringify(measure(run(P_SHORT, p, SCENARIOS.standard, 8)));
    assert.equal(a, b, p.id);
    assert.notEqual(a, c, p.id);
  }
});

test('draws are keyed, not sequential (common random numbers)', () => {
  assert.equal(draw(1, 'x', 2, 3), draw(1, 'x', 2, 3));
  assert.notEqual(draw(1, 'x', 2, 3), draw(1, 'x', 3, 2));
  assert.notEqual(draw(1, 'x', 2), draw(1, 'y', 2));
  const xs = Array.from({ length: 4000 }, (_, i) => draw(5, 'u', i));
  const m = xs.reduce((s, x) => s + x, 0) / xs.length;
  assert.ok(m > 0.47 && m < 0.53, `mean ${m}`);
});

test('goods are conserved every hour, in every proposal and exploit scenario', () => {
  for (const sc of ['standard', 'alts', 'churn', 'kingmaker', 'feeder']) {
    for (const p of Object.values(PROPOSALS)) {
      const w = createWorld({ ...BASE, standingOrders: true }, p, SCENARIOS[sc], 11);
      while (w.t < w.horizon) {
        step(w);
        const d = Math.abs(goodsInWorld(w) - goodsByLedger(w));
        const scale = w.ledger.starter + w.ledger.produced; // float rounding grows with the volume booked
        assert.ok(d < 1e-6 + 1e-10 * scale, `${sc}/${p.id} drift ${d} at ${w.t}`);
      }
    }
  }
});

test('a protected village is never raided', () => {
  for (const p of Object.values(PROPOSALS)) {
    const w = createWorld({ ...P_SHORT, raidPower: 2, behaviourMix: 'raider' }, p, SCENARIOS.standard, 3);
    // protection can end inside an hour (growth, attacking, dormancy); a raid must find it ended
    let raids = 0;
    while (w.t < w.horizon) {
      const t = w.t;
      step(w);
      for (const a of w.agents) {
        if (a.history.some((h) => h.kind === 'raided' && h.t === t)) {
          raids++;
          assert.ok(a.protectedUntil <= t, `${p.id}: ${a.id} raided at ${t} while protected until ${a.protectedUntil}`);
        }
      }
    }
    assert.ok(raids > 0, `${p.id}: no raids at all`);
  }
});

test('P0 follows the code: join closes at day 10.5, a late joiner waits for the next unit', () => {
  const w = run(BASE, PROPOSALS.P0, SCENARIOS.standard, 1);
  for (const a of w.agents.filter((x) => x.cohort === 'late')) {
    assert.equal(a.plannedJoinT, U + 12 * 24);
    assert.equal(a.joinT, 2 * U);
  }
  for (const a of w.agents.filter((x) => x.cohort === 'mid')) assert.equal(a.joinT, a.plannedJoinT);
});

test('P0 protection: 24 h on day one, 24 + 36 h for a later joiner', () => {
  const w = createWorld(BASE, PROPOSALS.P0, SCENARIOS.standard, 1);
  step(w);
  const d1 = w.agents.find((a) => a.cohort === 'day1');
  assert.equal(d1.protectedUntil, 0 + 24);
  while (w.t <= U + 5 * 24) step(w);
  const mid = w.agents.find((a) => a.cohort === 'mid');
  assert.equal(mid.protectedUntil, mid.joinT + 60);
});

test('P0: a protected village never raids (code: a shielded holding cannot be a siege source)', () => {
  const w = createWorld({ ...P_SHORT, raidPower: 2, behaviourMix: 'raider' }, PROPOSALS.P0, SCENARIOS.standard, 9);
  let raids = 0;
  while (w.t < w.horizon) {
    const t = w.t;
    const prot = new Map(w.agents.map((a) => [a.id, a.protectedUntil]));
    step(w);
    for (const d of w.agents) {
      for (const h of d.history) {
        if (h.kind !== 'raided' || h.t !== t) continue;
        raids++;
        assert.ok(prot.get(h.by) <= t, `attacker ${h.by} protected at ${t}`);
      }
    }
  }
  assert.ok(raids > 0);
});

test('defeat: the home stays in strip mode (P0, A, B); C removes the village and re-founds it later', () => {
  for (const id of ['P0', 'A', 'B']) {
    const w = createWorld(P_SHORT, PROPOSALS[id], SCENARIOS.standard, 2);
    while (w.t <= U + 4 * 24) step(w);
    for (const a of w.agents.filter((x) => x.cohort === 'defeated')) {
      assert.ok(a.active, id);
      assert.ok(a.farms <= BASE.starterFarms, id);
      assert.equal(a.defeats.length >= 1, true);
    }
  }
  const w = createWorld(P_SHORT, PROPOSALS.C, SCENARIOS.standard, 2);
  while (w.t <= U + 4 * 24) step(w);
  const probes = w.agents.filter((x) => x.cohort === 'defeated');
  for (const a of probes) assert.equal(a.active, false);
  while (w.t <= U + 4 * 24 + 12) step(w);
  for (const a of probes) {
    assert.equal(a.active, true);
    assert.equal(a.foundT, U + 4 * 24 + 12);
    assert.equal(a.protectedUntil, a.foundT + 48);
  }
});

test('boundaries do what each proposal says', () => {
  const at = (id) => {
    const w = createWorld(P_SHORT, PROPOSALS[id], SCENARIOS.standard, 4);
    while (w.t < U) step(w);
    const before = { holders: w.forts.map((f) => f.holder), theater: w.theater, farms: w.agents.filter((a) => a.active).map((a) => a.farms) };
    step(w); // the boundary tick
    return { w, before };
  };
  {
    const { w, before } = at('P0');
    assert.ok(Math.max(...before.farms) > BASE.starterFarms);
    for (const a of w.agents.filter((x) => x.active)) {
      assert.equal(a.foundT, U); // everyone re-founded at the cut
      assert.ok(a.farms <= BASE.starterFarms + 1); // at most the one farm built in that same hour
    }
    assert.ok(w.forts.every((f) => f.holder === null));
    assert.ok(w.agents.every((a) => a.joinT === null || a.history.some((h) => h.kind === 'unit_end')));
  }
  {
    const { w, before } = at('B');
    assert.equal(w.theater, before.theater + 1);
    assert.ok(w.forts.every((f) => f.holder === null && f.supply === 0));
    assert.ok(w.agents.filter((a) => a.active).some((a) => a.farms > BASE.starterFarms));
  }
  {
    // B: armies stand down to the home guard at the cut
    const w = createWorld(P_SHORT, PROPOSALS.B, SCENARIOS.standard, 4);
    while (w.t < U) step(w);
    const troopsBefore = w.agents.filter((a) => a.active).reduce((s, a) => s + a.troops, 0);
    boundary(w);
    for (const a of w.agents.filter((x) => x.active)) {
      assert.ok(a.troops <= Math.max(BASE.starterTroops, 2 * a.farms), `${a.id} troops ${a.troops}`);
    }
    const troopsAfter = w.agents.filter((a) => a.active).reduce((s, a) => s + a.troops, 0);
    assert.ok(troopsAfter < troopsBefore);
  }
  {
    const { w, before } = at('C');
    assert.deepEqual(w.forts.map((f) => f.holder), before.holders);
    assert.equal(w.theater, before.theater);
  }
});

test('history survives every boundary, also where the material world resets', () => {
  const w = run(BASE, PROPOSALS.A, SCENARIOS.standard, 5);
  const d1 = w.agents.find((a) => a.cohort === 'day1');
  assert.equal(d1.history.filter((h) => h.kind === 'unit_end').length, BASE.periods - 1);
  assert.equal(d1.history.filter((h) => h.kind === 'found').length, BASE.periods);
});

test('the AI is online every hour, a human only in sessions', () => {
  const w = createWorld(BASE, PROPOSALS.P0, SCENARIOS.standard, 1);
  const ai = w.agents.find((a) => a.kind === 'ai');
  const h = w.agents.find((a) => a.kind === 'human' && a.sessions === 2);
  let nAi = 0;
  let nH = 0;
  for (let t = 0; t < 24 * 20; t++) {
    if (isOnline(w, ai, t)) nAi++;
    if (isOnline(w, h, t)) nH++;
  }
  assert.equal(nAi, 24 * 20);
  assert.ok(nH > 20 && nH <= 40, `human sessions ${nH}`);
});

test('rights at the boundary: P0 voids what is in flight, B returns fort deposits, C carries everything', () => {
  const r = (id) => measure(run(BASE, PROPOSALS[id], SCENARIOS.standard, 6));
  const p0 = r('P0');
  const b = r('B');
  const c = r('C');
  assert.ok(p0['rights.voided'] > 0);
  assert.ok(b['rights.returned'] > 0);
  assert.equal(c['rights.voided'], 0);
});

test('stats', () => {
  assert.equal(gini([1, 1, 1, 1]), 0);
  assert.ok(Math.abs(gini([0, 0, 0, 1]) - 0.75) < 1e-12);
  assert.equal(quantile([1, 2, 3], 0.5), 2);
  assert.equal(quantile([1, Infinity, Infinity], 0.5), Infinity);
  assert.equal(quantile([1, 2, Infinity], 0.5), 2);
  assert.ok(Math.abs(hhi([1, 1]) - 0.5) < 1e-12);
});

test('the report renders from a small experiment', () => {
  const e = experiment('core/standard/mixed', 'standard', { periods: 2 }, [1, 2]);
  const md = renderMarkdown({ generatedBy: 'test', seeds: 2, firstSeed: 1 }, [{ group: 'core', ...e }]);
  assert.match(md, /core\/standard\/mixed/);
  assert.match(md, /P0より良/);
});
