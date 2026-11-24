// loop-play11 (D-verify-pr177-1): the wide-claim card and the operator AI asked for the settler cost of one village too
// many. The program charges `settler_cost(holdings_n)` with holdings_n = the villages held BEFORE the claim (frontier
// proc wide.rs reads C::HOLDINGS_N; citizen.rs `settler_cost` = duplicate_cost(SETTLER_COST, n)), so a second village
// costs 800 / 800 / 400 / 200 — live: a claim sent at 873 / 818 / 561 / 345 landed and took exactly that — while the
// card shut its button until 1,200 / 1,200 / 600 / 300.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { settlerCost } from '../../permutation-server/web/frontier/flocalplay-wide.mjs';
import { wideClaimModel } from '../../permutation-server/web/frontier/screens/holding.mjs';

const VECTORS = JSON.parse(readFileSync(new URL('../../frontier-abi/vectors/v2/web-rules.json', import.meta.url), 'utf8'));

test('settlerCost(n) is the program\'s settler_cost(n) for every published vector (n = villages held before)', () => {
  assert.ok(VECTORS.settler_cost.length >= 3);
  for (const v of VECTORS.settler_cost) if (v.holdings >= 1) assert.deepEqual(settlerCost(v.holdings), v.units, `holdings ${v.holdings}`);
});

test('the wide-claim card asks the program\'s price: 800 … for the second village, 1,200 … for the third', () => {
  const targets = [{ p: '-66', q: '-63' }, { p: '-67', q: '-62' }];
  const base = { localPlay: { wideLand: { scale: 60, targets } }, holdings: [{ p: -66, q: -62, site: 8, order: 1 }], ui: {} };
  const home = { p: -66, q: -62, site: 8, order: 1 };
  // (the live stores of loop-play11 when the claim landed)
  const live = wideClaimModel(base, { holding: home, have: [873, 818, 561, 0, 0, 345, 0, 0] });
  assert.equal(live.slot, 2);
  assert.deepEqual(live.need, [800, 800, 400, 0, 0, 200, 0, 0]);
  assert.deepEqual(live.short, [], 'enough for the program, so the button is open');
  const short = wideClaimModel(base, { holding: home, have: [799, 800, 400, 0, 0, 200, 0, 0] });
  assert.deepEqual(short.short.map(x => [x.resource, x.need, x.have]), [['Food', 800, 799]]);
  const third = wideClaimModel({ ...base, wideStatus: 'ready', wideHoldings: { slots: [{ inventorySlot: 2, status: 'captured-unverified', holding: { p: -66n, q: -63n } }] } }, { holding: home, have: [1200, 1200, 600, 0, 0, 300, 0, 0] });
  assert.equal(third.slot, 3);
  assert.deepEqual(third.need, [1200, 1200, 600, 0, 0, 300, 0, 0], 'a Hamlet (cap 2,000) can pay for its third village');
  assert.deepEqual(third.short, []);
});

test('the operator AI gates its wide claim on the same price (villages held before = 1 + its wide villages)', () => {
  const src = readFileSync(new URL('../src/frontier/local-play-operator-residents.mjs', import.meta.url), 'utf8');
  // (expansion-gameplay-1: the wide villages held are view.wide or the resident's own record of them, whichever is more —
  //  /h/me lists legacy villages only, so view.wide alone stayed 0 and a third village was priced as a second)
  assert.match(src, /const wideHeld = Math\.max\(Number\.isInteger\(view\?\.wide\) \? view\.wide : 0, \(r\.memory\.wideVillages \?\? \[\]\)\.length\);/);
  assert.match(src, /coversSettlerCost\(v\.decoded, secs, 1 \+ wideHeld\)/);
  assert.doesNotMatch(src, /coversSettlerCost\(v\.decoded, secs, 2 \+/);
});

test('(verify-pr183) the ⑬ external resident saves for the same price (its wide eyes: villages held before = 1 + its wide-bound slots)', () => {
  // (⑬'s own suite — workstreams/13-citizens/test/local-wide.test.mjs WO12 — does not run in CI; this pin does)
  const src = readFileSync(new URL('../../workstreams/13-citizens/resident/local/wide.mjs', import.meta.url), 'utf8');
  assert.match(src, /const owned = 1 \+ obs\.wideInv\.bound;/);
  assert.match(src, /need: settlerCost\(Math\.min\(2, owned\)\)/);
  assert.match(src, /obs\.wideLand\?\.need \?\? settlerCost\(1\)/);
  assert.doesNotMatch(src, /settlerCost\(Math\.min\(3, owned \+ 1\)\)/);
});
