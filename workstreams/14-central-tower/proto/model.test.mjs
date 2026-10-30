// node --test workstreams/14-central-tower/proto/model.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import * as G from './geometry.mjs';
import * as F from '../../../permutation-server/web/frontier/fgeo.mjs';
import { createSim, run, step, applyControlled, optionsFor, summarize, CASES, DEFAULTS } from './model.mjs';
import { toFacts } from './adapters.mjs';
import { runTriple } from './compare.mjs';

test('geometry matches the client (fgeo.mjs) on rings 0..8', () => {
  for (let d = 0; d <= 8; d++) {
    assert.deepEqual(G.ringProvinces(d), F.ringProvinces(d));
    for (const { p, q } of G.ringProvinces(d)) {
      assert.equal(G.ringOf(p, q), F.ringOf(p, q));
      assert.equal(G.wedgeOf(p, q), F.wedgeOf(p, q));
      assert.deepEqual(G.provinceCentre(p, q), F.provinceCentre(p, q));
    }
  }
});

test('trip: the per-send caps of the rules split long trips', () => {
  const near = G.trip({ p: 2, q: 0 }, { p: 0, q: 0 });
  assert.equal(near.hexes, 18); assert.equal(near.sends, 1);
  const across = G.trip({ p: 3, q: 0 }, { p: -3, q: 0 });
  assert.equal(across.hexes, 54); assert.equal(across.sends, 2);   // 32 steps per send
  const far = G.trip({ p: 8, q: 0 }, { p: 0, q: 0 });
  assert.equal(far.sends, 3);                                       // 9 provinces at 4 per send
});

test('same seed, same world: every case starts from the same villages and people', () => {
  const key = s => JSON.stringify(s.villages.map(v => [v.nation, v.prov, v.land, v.income, v.poor, v.late, v.spd, v.phase, v.profile, v.towerWill, v.leaveTick]));
  const a = createSim({ seed: 7, case: 'A' }), b = createSim({ seed: 7, case: 'B' }), c = createSim({ seed: 7, case: 'C' });
  assert.equal(key(a), key(b)); assert.equal(key(a), key(c));
  assert.notEqual(key(a), key(createSim({ seed: 8, case: 'A' })));
});

test('deterministic: a run is a function of its parameters', () => {
  for (const c of CASES) {
    const x = createSim({ seed: 3, case: c }); run(x);
    const y = createSim({ seed: 3, case: c }); run(y);
    assert.deepEqual(summarize(x), summarize(y));
  }
});

test('A has no tower facts; A and B send nothing to the centre', () => {
  for (const c of ['A', 'B']) {
    const s = createSim({ seed: 2, case: c });
    const sent = [];
    const orig = s.caravans.push.bind(s.caravans);
    s.caravans.push = (...xs) => { sent.push(...xs); return orig(...xs); };
    run(s);
    assert.equal(sent.filter(k => k.toCentre || k.fromCentre).length, 0, c);
    if (c === 'A') assert.equal(s.facts.filter(f => f.kind.startsWith('tower.')).length, 0);
  }
});

test('facts only: nothing names a winner, a score, a rank or an end', () => {
  for (const c of CASES) {
    const s = createSim({ seed: 4, case: c }); run(s);
    const kinds = new Set(s.facts.map(f => f.kind));
    for (const k of kinds) assert.doesNotMatch(k, /win|victor|score|rank|prize|reward|end|finish/i);
    const f = toFacts(s);
    assert.equal(JSON.stringify(f).match(/"(winner|victory|score|rank)"/), null);
  }
});

test('refund: an unmet stage returns contributions as claims, except to those who left', () => {
  const s = createSim({ seed: 5, case: 'C', stageNeed: [{ stone: 1000 }], stageDays: 2, leavers: 0, saboteurs: 0 });
  run(s);
  const lapses = s.facts.filter(f => f.kind === 'tower.stage_lapsed');
  assert.ok(lapses.length >= 1);
  assert.equal(s.tower.stage, 0);
  const claimed = s.facts.filter(f => f.kind === 'tower.refund_claim').reduce((a, f) => a + f.amount, 0);
  assert.ok(claimed > 0);
  const keep = createSim({ seed: 5, case: 'C', stageNeed: [{ stone: 1000 }], stageDays: 2, refund: 'keep', saboteurs: 0 });
  run(keep);
  assert.equal(keep.facts.filter(f => f.kind === 'tower.stage_lapsed').length, 0);
});

test('a leaver keeps no claim on the tower', () => {
  const s = createSim({ seed: 6, case: 'C', stageNeed: [{ stone: 1000 }], stageDays: 9, leavers: 10, leaveDay: 3, saboteurs: 0 });
  run(s);
  for (const v of s.villages.filter(v => v.left)) assert.equal(Object.values(v.claims).reduce((a, b) => a + b, 0), 0);
});

test('the human picks from the same options the AI does, and the hour moves on', () => {
  const s = createSim({ seed: 1, case: 'C' });
  s.control = s.villages.find(v => !v.late).id;
  let turns = 0, opts = null;
  while (s.tick < s.end && turns < 5) {
    opts = step(s);
    if (!opts) continue;
    turns++;
    assert.ok(opts.some(o => o.id === 'idle'));
    const before = s.tick;
    let next = applyControlled(s, opts[0].id);
    while (next) next = applyControlled(s, next[0].id);
    assert.equal(s.tick, before + 1);
  }
  assert.equal(turns, 5);
});

test('not joining the tower is always possible: idle and own-village options never depend on it', () => {
  const s = createSim({ seed: 9, case: 'C' });
  run(s);
  for (const v of s.villages.filter(v => !v.left)) {
    const o = optionsFor(s, v).map(x => x.id);
    assert.ok(o.includes('idle'));
  }
});

test('a scenario triple pairs each village with itself in A', () => {
  const t = runTriple({}, 11);
  assert.equal(t.A.paired.near, 0);
  assert.equal(typeof t.C.paired.nonParticipants === 'number' || t.C.paired.nonParticipants === null, true);
  assert.equal(DEFAULTS.case, 'A');
});
