// node --test workstreams/08-persistence/sim/
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, step, run, goodsInWorld, goodsByLedger, isOnline, boundary, wealth, farmValue } from './world.mjs';
import { BASE } from './params.mjs';
import { PROPOSALS } from './proposals.mjs';
import { SCENARIOS } from './scenarios.mjs';
import { measure, experiment, paired, PAIRED_KEYS } from './run.mjs';
import { renderMarkdown } from './report.mjs';
import { gini, quantile, hhi } from './stats.mjs';
import { pairedSummary } from './paired.mjs';
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
  const levers = { standingOrders: true, quitOnDefeat: 0.3, quitHazard: 0.1, freqDrop: 0.1, returnProb: 0.5, rushHours: 48, altFoundCost: 500 };
  for (const sc of ['standard', 'alts', 'churn', 'kingmaker', 'feeder', 'proxy']) {
    for (const base of Object.values(PROPOSALS)) {
      const p = structuredClone(base);
      if (p.id === 'B2') p.demobRefund = 0.5;
      const w = createWorld({ ...BASE, ...levers }, p, SCENARIOS[sc], 11);
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

test('defeat: the home stays in strip mode (P0, A, B1, B2); C removes the village and re-founds it later', () => {
  for (const id of ['P0', 'A', 'B1', 'B2']) {
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
  for (const id of ['B1', 'B2']) {
    const { w, before } = at(id);
    assert.equal(w.theater, before.theater, id); // no rotating region in the decided plan
    assert.ok(w.forts.every((f) => f.holder === null && f.supply === 0 && f.garrison.size === 0), id);
    assert.ok(w.agents.filter((a) => a.active).some((a) => a.farms > BASE.starterFarms), id);
  }
  {
    // B1 (the decided plan) does not disband armies
    const w = createWorld(P_SHORT, PROPOSALS.B1, SCENARIOS.standard, 4);
    while (w.t < U) step(w);
    boundary(w);
    assert.equal(w.demob.length, 0);
    assert.ok(w.agents.filter((a) => a.active).some((a) => a.troops > Math.max(BASE.starterTroops, 2 * a.farms)));
  }
  {
    // B2: armies stand down to the home guard at the cut
    const w = createWorld(P_SHORT, PROPOSALS.B2, SCENARIOS.standard, 4);
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

test('rights at the boundary: P0 voids what is in flight, B1 sends undelivered cargo home, C carries everything', () => {
  const r = (id) => measure(run(BASE, PROPOSALS[id], SCENARIOS.standard, 6));
  const p0 = r('P0');
  const b = r('B1');
  const c = r('C');
  assert.ok(p0['rights.voided'] > 0);
  assert.ok(b['rights.returned'] > 0); // cargo still on the road is its sender's
  assert.equal(c['rights.voided'], 0);
});

test('fort stock at a B cut follows the ownership policy', () => {
  const at = (policy) => {
    const prop = structuredClone(PROPOSALS.B1);
    prop.rights.fortSupply = policy;
    const w = createWorld(P_SHORT, prop, SCENARIOS.standard, 6);
    while (w.t < U) step(w);
    const stock = w.forts.reduce((s, f) => s + f.supply, 0);
    const holders = w.forts.map((f) => f.holder);
    const nationBefore = w.nations.map((n) => n.stock);
    const goodsBefore = w.agents.reduce((s, a) => s + a.goods, 0);
    const voidedBefore = w.ledger.voided;
    boundary(w);
    return { w, stock, holders, nationBefore, goodsBefore, voidedBefore };
  };
  const n = at('nation');
  assert.ok(n.stock > 0, 'some stock in forts at the cut');
  const gained = n.w.nations.reduce((s, x, i) => s + x.stock - n.nationBefore[i], 0);
  assert.ok(gained >= n.stock - 1e-9, 'the holders keep what was given to them');
  const d = at('destroy');
  assert.ok(d.w.ledger.voided - d.voidedBefore >= d.stock - 1e-9);
  const st = at('stay');
  assert.ok(Math.abs(st.w.forts.reduce((s, f) => s + f.supply, 0) - st.stock) < 1e-9, 'stays in the neutral forts');
  const rt = at('return');
  assert.ok(rt.w.agents.reduce((s, a) => s + a.goods, 0) > rt.goodsBefore, 'senders get it back');
});

test('leaving and coming back', () => {
  // everyone defeated leaves; in C nobody re-founds unless they come back
  const P = { ...P_SHORT, quitOnDefeat: 1 };
  const w = run(P, PROPOSALS.C, SCENARIOS.standard, 3);
  for (const a of w.agents.filter((x) => x.cohort === 'defeated')) {
    assert.equal(a.quit, true);
    assert.equal(a.active, false);
    assert.equal(a.history.filter((h) => h.kind === 'refound').length, 0);
  }
  // with returnProb 1 they come back 7..21 days later and found again
  const w2 = run({ ...BASE, quitOnDefeat: 1, returnProb: 1 }, PROPOSALS.C, SCENARIOS.standard, 3);
  let backs = 0;
  for (const a of w2.agents.filter((x) => x.cohort === 'defeated')) {
    const left = a.history.find((h) => h.kind === 'left');
    assert.ok(a.returnT - left.t >= 7 * 24 && a.returnT - left.t <= 21 * 24);
    if (a.returnT >= w2.horizon) continue; // would come back after the run ends
    const back = a.history.find((h) => h.kind === 'came_back');
    assert.equal(back.t, a.returnT);
    assert.ok(a.history.some((h) => h.kind === 'refound' && h.t === back.t));
    backs++;
  }
  assert.ok(backs > 0);
  // a person who left is never online
  const w3 = createWorld({ ...P_SHORT, quitHazard: 0.5, freqDrop: 0.5 }, PROPOSALS.B2, SCENARIOS.standard, 3);
  let checked = 0;
  while (w3.t < w3.horizon) {
    step(w3);
    for (const a of w3.agents) if (a.quit) {
      assert.equal(isOnline(w3, a), false);
      checked++;
    }
  }
  assert.ok(checked > 0 && w3.events.freqDrops > 0);
});

test('exposure: more sessions are online in more commitment windows', () => {
  const w = run(BASE, PROPOSALS.P0, SCENARIOS.standard, 2);
  const m = measure(w);
  assert.ok(m['expo.rate12'] > m['expo.rate2'] && m['expo.rate2'] > m['expo.rate1']);
  assert.ok(m['expo.rate1'] > 0 && m['expo.rate12'] <= 1);
});

test('paired bootstrap is deterministic and brackets the mean', () => {
  const xs = [1, 2, 3, 4, 5, 6, 7, 8];
  const ys = [0, 2, 2, 5, 4, 5, 6, 9];
  const a = pairedSummary(xs, ys, 'k');
  const b = pairedSummary(xs, ys, 'k');
  assert.deepEqual(a, b);
  assert.ok(a.lo <= a.mean && a.mean <= a.hi);
  assert.equal(a.pos + a.neg + a.zero, 8);
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
  const e = experiment('core/standard/mixed', 'standard', { periods: 2 }, [1, 2, 3]);
  e.paired = paired(e, PAIRED_KEYS);
  const md = renderMarkdown({ generatedBy: 'test', seeds: 3, firstSeed: 1 }, [{ group: 'core', ...e }]);
  assert.match(md, /core\/standard\/mixed/);
  assert.match(md, /1b\. 対になった差/);
  assert.match(md, /B2−A/);
});

test('wealth values buildings at their build cost, so building does not change it', () => {
  const w = createWorld(BASE, PROPOSALS.P0, SCENARIOS.standard, 1);
  for (let n = 0; n < 12; n++) {
    const cost = BASE.farmBaseCost * BASE.farmCostGrowth ** n;
    assert.ok(Math.abs(farmValue(w, n + 1) - farmValue(w, n) - cost) < 1e-9);
  }
  const a = { goods: 1000, troops: 0, farms: 3, tower: false, workshop: false };
  const before = wealth(w, a);
  const cost = BASE.farmBaseCost * BASE.farmCostGrowth ** 3;
  const after = wealth(w, { ...a, goods: 1000 - cost, farms: 4 });
  assert.ok(Math.abs(after - before) < 1e-9);
});

test('an extra village is founded only once its full cost is paid', () => {
  const cost = 1000;
  const w = run({ ...BASE, altFoundCost: cost }, PROPOSALS.B2, SCENARIOS.alts_control, 4);
  const alts = w.agents.filter((a) => a.cohort === 'alt');
  assert.ok(alts.some((a) => a.joinT !== null));
  for (const a of alts) {
    if (a.joinT === null) continue;
    assert.equal(a.altCostPaid % cost, 0);
    assert.ok(a.altCostPaid >= cost);
    assert.ok(a.joinT >= a.plannedJoinT);
  }
});

// ---------------------------------------------------------------- placement study (geo)
import { provincesInRings, sextant, hexDistance, objectiveProvinces, line } from './geo.mjs';

test('geo: the province grid matches the code (ring d has 6d provinces; 5 home provinces per wedge in rings 2-3)', () => {
  for (const d of [2, 3, 4, 5]) assert.equal(provincesInRings(d, d).length, 6 * d);
  const homes = provincesInRings(2, 3);
  for (let k = 0; k < 6; k++) assert.equal(homes.filter((h) => h.wedge === k).length, 5);
  // hex.rs: (1, 0) is sextant 0 and turning by 60 degrees moves to the next sextant
  assert.equal(sextant({ p: 1, q: 0 }), 0);
  assert.equal(sextant({ p: 0, q: 1 }), 1);
  const obj = objectiveProvinces('corner', 4);
  assert.equal(new Set(obj.map((o) => sextant(o))).size, 6);
  for (const o of obj) assert.equal(hexDistance(o, { p: 0, q: 0 }), 4);
  const l = line({ p: 2, q: 0 }, { p: -2, q: 0 });
  assert.equal(l.length, 5);
});

test('geo: placements put villages where they say', () => {
  const homesOf = (w) => w.agents.filter((a) => a.active && a.prov);
  const W = run({ ...P_SHORT, geo: true, placement: 'PL-W', homeRingMax: 5 }, PROPOSALS.B2, SCENARIOS.standard, 3);
  for (const a of homesOf(W)) assert.equal(a.prov.wedge, a.nation, 'PL-W: own wedge');
  const G = createWorld({ ...P_SHORT, geo: true, placement: 'PL-G', group: 3, spread: 1, homeRingMax: 5 }, PROPOSALS.B2, SCENARIOS.standard, 3);
  step(G);
  for (const g of G.geo.groups) {
    assert.ok(g.members.length <= 3);
    for (const id of g.members) assert.equal(G.agents[id].nation, g.nation);
  }
  const S = run({ ...P_SHORT, geo: true, placement: 'PL-S', homeRingMax: 5 }, PROPOSALS.B2, SCENARIOS.standard, 3);
  const wedges = new Set(homesOf(S).filter((a) => a.nation === 0).map((a) => a.prov.wedge));
  assert.ok(wedges.size >= 3, 'PL-S: a nation is spread over several wedges');
  for (const w of [W, S]) for (const [, ids] of w.geo.occ) assert.ok(ids.length <= w.P.provCap);
});

test('geo: goods are conserved, and a world reset places everyone again', () => {
  for (const pl of ['PL-W', 'PL-G', 'PL-S']) {
    for (const id of ['P0', 'B2', 'C']) {
      const opMode = id === 'B2' ? 'local' : 'single';
      const w = createWorld({ ...BASE, geo: true, placement: pl, homeRingMax: 5, quitOnDefeat: 0.25, returnProb: 0.5, opMode }, PROPOSALS[id], SCENARIOS.alts_control, 5);
      while (w.t < w.horizon) {
        step(w);
        const d = Math.abs(goodsInWorld(w) - goodsByLedger(w));
        assert.ok(d < 1e-6 + 1e-10 * (w.ledger.starter + w.ledger.produced), `${pl}/${id} drift ${d}`);
      }
      const placed = w.agents.filter((a) => a.active).every((a) => a.prov);
      assert.ok(placed, `${pl}/${id}: every active village is on the map`);
    }
  }
  const w = createWorld({ ...P_SHORT, geo: true, placement: 'PL-S', homeRingMax: 5 }, PROPOSALS.P0, SCENARIOS.standard, 2);
  while (w.t < U) step(w);
  const before = w.agents.filter((a) => a.active).map((a) => a.prov.id).join();
  step(w);
  const after = w.agents.filter((a) => a.active).map((a) => a.prov.id).join();
  assert.notEqual(before, after);
});

test('geo off: no village gets a province (earlier results are untouched)', () => {
  const w = run(P_SHORT, PROPOSALS.B2, SCENARIOS.standard, 1);
  assert.equal(w.geo, undefined);
  assert.ok(w.agents.every((a) => a.prov === undefined));
});

test('geo: local operations open one operation per objective nearest to enough members, and each member joins the nearest', () => {
  const w = createWorld({ ...P_SHORT, geo: true, placement: 'PL-S', homeRingMax: 5, opMode: 'local', localMin: 2 }, PROPOSALS.B2, SCENARIOS.standard, 4);
  let sides = 0;
  while (w.t < 24 * 3) {
    step(w);
    for (const n of w.nations) sides += (n.side || []).length;
  }
  assert.ok(sides > 0, 'side operations were opened');
  const single = createWorld({ ...P_SHORT, geo: true, placement: 'PL-S', homeRingMax: 5 }, PROPOSALS.B2, SCENARIOS.standard, 4);
  while (single.t < 24 * 3) {
    step(single);
    for (const n of single.nations) assert.equal((n.side || []).length, 0);
  }
});
