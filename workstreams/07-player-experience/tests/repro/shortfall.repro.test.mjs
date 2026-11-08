// REPRO (workstream 07): these tests pin a defect AS THE BASE PAGE HAS IT (a997a756, before patches/). They pass
// on the base and are EXPECTED TO FAIL once the patch that fixes the defect is applied. They are evidence, not part of
// any regular suite: the regular tests are ../*.test.mjs here and permutation-gateway/test/web-frontier-ws07-*.test.mjs
// in the patches (INTEGRATION.ja.md §2).
// Workstream 07, brief item 2: wait / grow / carry / ask, compared when the same
// needed amounts are all there, by the page's own projection of the village.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compareRemedies, storesAt, readyAt } from '../../src/shortfall.mjs';
import { promotionOffer, buildOffers, duplicateCost, buildSecs } from '../../../../permutation-server/web/frontier/hud/rulebook.mjs';
import { accrualAt } from '../../../../permutation-server/web/frontier/fland.mjs';

const H = 3600, NOW = 1_000_000;
/** A store of `v` whole units growing `perHour` (net) with cap `cap` (whole), settled at NOW. */
const store = (v, perHour = 0, cap = 6000) => ({ value: BigInt(v) * 1000n, rate: BigInt(Math.round(perHour * 1000)), cap: BigInt(cap) * 1000n, t0: BigInt(NOW), frac: 0n });
/** A town (tier 1, cap 6,000) with stone 700 at 8 an hour, wood 3,000, gold 2,000, food 1,000 at −5 an hour. */
const town = (over = {}) => ({ p: 0, q: 0, site: 0, tier: 1, state: 2, flags: 0,
  stores: [store(1000, -5), store(3000, 10), store(700, 8), store(0, 4), store(0), store(2000, 6), store(0, 5), store(0)],
  production: [10_000, 10_000, 8_000, 4_000, 0, 6_000, 5_000, 0].map(BigInt), upkeep: [15_000, 0, 0, 0, 0, 0, 0, 0].map(BigInt), queue: [], ...over });
const END = NOW + 14 * 24 * H;
const NEED = [0, 0, 1613, 0, 0, 0, 0, 0];

test('REPRO: the promotion card today says what is short and nothing of when or how it could be there', () => {
  const o = promotionOffer(town(), { now: NOW, have: [1000, 3000, 700, 0, 0, 2000, 0, 0] });
  assert.ok(o.short.length > 0);
  assert.deepEqual(Object.keys(o.short[0]).sort(), ['need', 'r'], 'an amount, no time, no way to fill it');
});
