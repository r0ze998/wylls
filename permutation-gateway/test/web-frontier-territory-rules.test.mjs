// territory-q2 (owner Q-2, 2026-11-24): the page's and the operator AI's territory rules give the Rust kernel's
// answers for every committed vector (`permutation-rules/vectors/territory-preview.json`, written by
// `cargo test -p permutation-rules --features territory-preview --test territory_vectors`). Key-free.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as T from '../../permutation-server/web/frontier/territory-rules.mjs';

const V = JSON.parse(readFileSync(new URL('../../permutation-rules/vectors/territory-preview.json', import.meta.url), 'utf8'));

test('same kernel version as the vectors', () => assert.equal(T.TERRITORY_VERSION, V.version));

test('upkeep, the one-more delta and the natural size match the kernel', () => {
  let n = 0;
  for (const v of V.upkeep) {
    if ('distances' in v) {
      assert.equal(T.upkeepPerHour(v.curve, v.distances), v.upkeep, JSON.stringify(v));
      assert.equal(T.upkeepDelta(v.curve, v.distances, v.deltaAt), v.delta, JSON.stringify(v));
    } else {
      assert.equal(T.naturalSize(v.curve, v.income, v.at), v.naturalSize, JSON.stringify(v));
    }
    n++;
  }
  assert.ok(n >= 40);
});

test('claim cost matches, including the no-fit case', () => {
  for (const v of V.claimCost) {
    const got = T.claimCost({ base: v.base, perOwnedBps: v.perOwnedBps }, v.owned);
    assert.equal(got == null ? null : String(got), v.cost, JSON.stringify(v));
  }
});

test('every claim judgement matches (refusal names and order)', () => {
  assert.ok(V.claims.length >= 100);
  for (const v of V.claims) {
    const p = { reach: { range: v.range, sources: v.sources }, cost: v.cost, claimsPerTurn: v.perTurn, claimOwned: v.claimOwned, unpaid: { blockClaims: v.blockClaims } };
    const c = { open: true, owner: v.owner, nearest: v.nearest, owned: v.owned, claimsThisTurn: v.claimsThisTurn, upkeepUnpaid: v.upkeepUnpaid, balance: v.balance };
    const r = T.mayClaim(p, c);
    assert.deepEqual('ok' in r ? { ok: String(r.ok) } : r, v.result, JSON.stringify(v));
  }
  assert.deepEqual(T.mayClaim({ reach: { range: 0, sources: 0 }, cost: { base: 1, perOwnedBps: 0 } }, { open: false }), { refused: 'NotOpen' });
});

test('unpaid upkeep effect and release order match', () => {
  for (const v of V.unpaid) {
    const e = T.unpaidEffect({ blockClaims: true, productionBps: 5000, decayAfterBells: v.decayAfterBells, decayEveryBells: v.decayEveryBells }, v.since, v.now);
    assert.deepEqual(e, { claimsBlocked: v.claimsBlocked, productionBps: v.productionBps, cellsReleased: v.cellsReleased }, JSON.stringify(v));
  }
  assert.deepEqual(T.releaseOrder('farthest', V.releaseOrder.cells), V.releaseOrder.farthest);
  assert.deepEqual(T.releaseOrder('newest', V.releaseOrder.cells), V.releaseOrder.newest);
});
