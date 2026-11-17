// Workstream 07: the S1 walk port is the rules crate's, over the vectors
// rust-vectors/ writes from permutation-rules (structure.rs, caravan.rs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as W from '../src/s1walk.mjs';
import { fastestPath, stepSecsOf } from '../../../permutation-server/web/frontier/fcaravan.mjs';

const V = JSON.parse(readFileSync(new URL('../vectors/s1-walk-v1.json', import.meta.url), 'utf8'));
const landsOf = c => c.lands.map(l => ({ p: l.p, q: l.q, passable: BigInt(l.passable), rough: BigInt(l.rough), road: BigInt(l.road),
  structures: l.structures.map(s => ({ ...s, p: l.p, q: l.q })) }));

test('the tower coverage, the wear curve, the wear of an amount and the mounted units are structure.rs\'s', () => {
  assert.deepEqual(W.COVER.map(String), V.coverage);
  for (const [s, b] of V.wearBps) assert.equal(W.wearBps(s), b, `wear_bps(${s})`);
  for (const [v, b, out] of V.wear) assert.equal(W.wear(v, b), out, `wear(${v}, ${b})`);
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7].map(W.isCavalry), V.cavalry);
});

test('who a work stops is structure.rs `stops`, for every nation, walker and expelled flag', () => {
  for (const [n, f, e, out] of V.stops) assert.equal(W.stops(V.stances, n, f, !!e), !!out, `stops(${n}, ${f}, ${e})`);
});

test('what a walker meets in a Province is structure.rs `watch`', () => {
  for (const c of V.walks) for (const l of landsOf(c)) {
    const w = W.watchOf(l.structures, V.stances, c.faction, c.expelled);
    const want = c.lands.find(x => x.p === l.p && x.q === l.q);
    assert.equal(String(w.wear), want.wear, `case ${c.case} ${l.p},${l.q} wear`);
    assert.equal(String(w.block), want.block, `case ${c.case} ${l.p},${l.q} block`);
  }
});

test('the fastest road, and the fastest road with the stopped palisades removed, are caravan.rs `fastest_path`', () => {
  let differ = 0;
  for (const c of V.walks) {
    const lands = landsOf(c);
    const watchAt = (p, q) => W.watchOf(W.structuresIn(lands.flatMap(l => l.structures), p, q), V.stances, c.faction, c.expelled);
    const plain = fastestPath(c.origin, c.dst, lands);
    assert.deepEqual(plain?.dirs ?? null, c.fastest, `case ${c.case} fastest`);
    const avoid = fastestPath(c.origin, c.dst, W.avoidingPalisades(lands, watchAt));
    assert.deepEqual(avoid?.dirs ?? null, c.fastestAvoiding, `case ${c.case} avoiding`);
    if (JSON.stringify(c.fastest) !== JSON.stringify(c.fastestAvoiding)) differ++;
  }
  assert.ok(differ >= 10, `the vectors hold roads a palisade changes (${differ})`);
});

test('what a march and a caravan meet on the fastest road is `march_watch` and `caravan_watch`', () => {
  let blocked = 0, worn = 0;
  for (const c of V.walks) {
    if (!c.fastest?.length) continue;
    const lands = landsOf(c);
    const watchAt = (p, q) => W.watchOf(W.structuresIn(lands.flatMap(l => l.structures), p, q), V.stances, c.faction, c.expelled);
    const watched = lands.map(l => ({ ...l, watch: watchAt(l.p, l.q) }));
    assert.equal(W.marchWatch(c.origin, c.fastest, watched, c.cavalry), c.march, `case ${c.case} march`);
    const secs = stepSecsOf(c.origin, c.fastest, lands, c.caravan.bps);
    const steps = W.stepTiles(c.origin, c.fastest).map((s, i) => ({ ...s, atSecs: secs[i] }));
    assert.equal(W.caravanWatch(steps, watchAt), c.caravan.walked, `case ${c.case} caravan`);
    if (c.march === 'blocked') blocked++; else if (c.march > 0) worn++;
  }
  assert.ok(blocked >= 10 && worn >= 50, `the vectors hold blocked (${blocked}) and worn (${worn}) walks`);
});
