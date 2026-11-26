// test-gaps-2 (2026-11-26; tests only, no behaviour changed): ① a request's delivery verdict (coop/ws04.mjs
// fulfilmentOf, the status the board shows and ⑮'s title reads through ①'s proof) over random arrivals, against the
// amounts that really arrived. verify-pr149/152 checked deliveries live; the fixture tests pin chosen cases.
// Each random arrival has a TRUE delivered amount inside what its record proves ([counted, countUpper) per resource,
// ④ QUANTITY-CONTRACT §3), and the verdict must never claim more than the truth allows:
//   'fulfilled'   ⇒ every requested resource truly reached the amount (the lower bounds alone prove it);
//   'not-reached' ⇒ every linked caravan is final and some requested resource truly fell short;
//   'none'        ⇔ no arrival is linked; a duplicate or another request's arrival never counts;
//   lower ≤ the true amount < upperExclusive (when every caravan is final), and a final arrival added later never
//   takes 'fulfilled' away.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fulfilmentOf, FULFILMENT_JA } from '../coop/ws04.mjs';

function rng(seed) {
  let s = BigInt(seed);
  return n => { s = (s * 6364136223846793005n + 1442695040888963407n) & 0xffffffffffffffffn; return Number((s >> 33n) % BigInt(n)); };
}
const RES = ['wood', 'stone', 'ore'];

/** One arrival linked to `requestId` and its TRUE amounts. */
function arrival(r, requestId, i) {
  const kind = ['counted', 'counted', 'unverified', 'unknown-amount', 'zero', 'open'][r(6)];
  const counted = {}, countUpper = {}, truth = {};
  for (const k of RES) {
    if (r(2)) continue;
    const b = r(30);
    if (kind === 'counted') { counted[k] = b; countUpper[k] = b + 1; truth[k] = b; }
    else if (kind === 'unverified') { countUpper[k] = b + 1; truth[k] = r(2) ? b : r(b + 1); }   // (often the bound itself: the edge)
    else if (kind === 'unknown-amount') { countUpper[k] = b + 1; truth[k] = r(2) ? b : r(b + 1); }
    else if (kind === 'zero') { countUpper[k] = 0; truth[k] = 0; }
    else { if (r(2)) counted[k] = b; countUpper[k] = b + 1 + r(50); truth[k] = (counted[k] ?? 0) + r(60); }   // (open: may still grow)
  }
  const a = { id: `a${i}`, requestId, countUpper, countFinal: kind !== 'open' };
  if (Object.keys(counted).length) a.counted = counted;
  if (kind === 'zero') a.verification = 'KnownZero';
  if (kind === 'unknown-amount') { a.state = 'delivered'; a.verification = 'Unverifiable'; }
  if (kind === 'open' && r(3) === 0) a.held = 'DestinationMismatch';
  return { a, truth, kind };
}

function sum(list, k) { return list.reduce((s, x) => s + (x.truth[k] ?? 0), 0); }

test('① fulfilmentOf over 2,000 random requests: "fulfilled" and "not-reached" are never claimed against the true amounts', () => {
  const seen = { fulfilled: 0, 'not-reached': 0, undetermined: 0, none: 0 };
  for (let seed = 1; seed <= 2000; seed++) {
    const r = rng(seed);
    const need = Object.fromEntries(RES.filter(() => r(2)).map(k => [k, 1 + r(40)]));
    if (!Object.keys(need).length) need.wood = 1 + r(40);
    const own = Array.from({ length: r(6) }, (_, i) => arrival(r, 'q1', i));
    // (a third of the requests ask exactly what truly arrived of one resource: the edge between the two claims)
    if (r(3) === 0) { const k = Object.keys(need)[0], t = sum(own, k); if (t > 0) need[k] = t; }
    const q = { id: 'q1', need };
    // noise that must never count: another request's arrival, and a duplicate of one of ours
    const noise = [arrival(r, 'q2', 90).a];
    if (own.length && r(2)) noise.push({ ...own[0].a, id: 'dup', duplicateOf: own[0].a.id, counted: Object.fromEntries(RES.map(k => [k, 1000])) });
    const v = fulfilmentOf(q, [...own.map(x => x.a), ...noise]);
    seen[v.status]++;
    const tag = `seed ${seed} ${JSON.stringify({ need, own: own.map(x => [x.kind, x.a.counted, x.a.countUpper, x.truth]) })}`;
    assert.ok(Object.hasOwn(FULFILMENT_JA, v.status), tag);
    assert.equal(v.links, own.length, `${tag}: a duplicate or another request's arrival was linked`);
    assert.equal(v.status === 'none', own.length === 0, tag);
    for (const k of Object.keys(need)) {
      assert.ok(v.lower[k] <= sum(own, k), `${tag}: lower ${k} ${v.lower[k]} above the truth ${sum(own, k)}`);
      if (v.upperExclusive) assert.ok(sum(own, k) < v.upperExclusive[k] || (v.upperExclusive[k] === 0 && sum(own, k) === 0), `${tag}: the truth ${k} is not below the upper bound`);
    }
    if (v.status === 'fulfilled') for (const [k, n] of Object.entries(need)) assert.ok(sum(own, k) >= n, `${tag}: "fulfilled" but ${k} truly ${sum(own, k)} < ${n}`);
    if (v.status === 'not-reached') {
      assert.equal(v.open, 0, `${tag}: "not-reached" with a caravan still open`);
      assert.ok(Object.entries(need).some(([k, n]) => sum(own, k) < n), `${tag}: "not-reached" but every resource truly reached`);
    }
    // a final, counted arrival added later never takes "fulfilled" away
    if (v.status === 'fulfilled') {
      const more = fulfilmentOf(q, [...own.map(x => x.a), ...noise, { id: 'late', requestId: 'q1', counted: { wood: 3 }, countUpper: { wood: 4 }, countFinal: true }]);
      assert.equal(more.status, 'fulfilled', tag);
    }
  }
  for (const s of Object.keys(seen)) assert.ok(seen[s] > 50, `every verdict must occur (${JSON.stringify(seen)})`);
});
