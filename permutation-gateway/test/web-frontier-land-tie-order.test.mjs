// G1c (2026-11-16): two `latest` envelopes of one province that tie on seq, slot and bell while their land records
// differ (FoldLand writes the land record, not the Province). SOURCE ONLY — NOT run: all new test runs are paused.
// controller.mjs latestEnvelope is read as text and built alone (as test/web-frontier-land-freshness does; the module
// is not imported). The land already held is kept only for a REAL tie of the same season's same province, both sides
// carrying a parsed record of it with a valid nextBell, the held one higher; everything else comes from the newer answer.
// Key-free, pure data; no request, nothing stored.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const c = readFileSync(new URL('../../permutation-server/web/frontier/controller.mjs', import.meta.url), 'utf8');
const m = /export function latestEnvelope\(previous, next\) \{\n([\s\S]*?)\n\}\n/.exec(c);
const latest = new Function('previous', 'next', m[1]);

const province = (extra = {}) => ({ p: 2, q: 0, seasonId: 5n, gen: 1, ...extra });
const land = (nextBell, extra = {}) => ({ p: 2, q: 0, nextBell, owners: [], ...extra });
const env = (o = {}) => ({ seq: '900', slot: '81', bell: 20, province: province(), slots: [{ key: 'ar:2,0,20,1,0' }], day: { d: 1 }, inputs: null, ...o });

test('the function is found and built alone', () => { assert.ok(m); });

test('a real tie, the held land newer (41) and the answer\'s older (40): the held land kept, everything else the answer\'s', () => {
  const held = env({ land: land(41) }), slow = env({ land: land(40), slots: [{ key: 'ar:2,0,20,1,1' }], day: { d: 2 } });
  const r = latest(held, slow);
  assert.equal(r.land, held.land);
  assert.equal(r.slots, slow.slots); assert.equal(r.day, slow.day); assert.equal(r.province, slow.province);
});

test('a real tie, equal nextBell or the answer newer: the answer, as before', () => {
  const held = env({ land: land(41) });
  for (const nb of [41, 42]) { const n = env({ land: land(nb) }); assert.equal(latest(held, n), n); }
});

test('no real tie: a missing or unreadable seq / slot / bell is never taken for one', () => {
  for (const o of [{ seq: '' }, { seq: undefined }, { seq: null }, { seq: 'x' }, { slot: '' }, { bell: undefined }]) {
    const held = env({ ...o, land: land(41) }), slow = env({ ...o, land: land(40) });
    assert.equal(latest(held, slow), slow, JSON.stringify(o));
  }
});

test('not the same season or province: the answer (a season closed and created again carries another seasonId)', () => {
  const held = env({ land: land(41) });
  for (const pv of [province({ seasonId: 6n }), province({ seasonId: undefined }), province({ q: 1 }), null]) {
    const slow = env({ province: pv, land: land(40) });
    assert.equal(latest(held, slow), slow, String(pv?.seasonId));
  }
  const noSeason = env({ province: province({ seasonId: undefined }), land: land(41) });
  const slow2 = env({ province: province({ seasonId: undefined }), land: land(40) });
  assert.equal(latest(noSeason, slow2), slow2, 'no seasonId on either side: no protection');
});

test('a record of another province, or an invalid nextBell: the answer', () => {
  const slowOf = l => env({ land: l });
  assert.equal(latest(env({ land: land(41, { q: 1 }) }), slowOf(land(40))).land.nextBell, 40);
  for (const bad of [NaN, -1, 40.5, '41', undefined]) {
    const held = env({ land: land(bad) }), slow = slowOf(land(40));
    assert.equal(latest(held, slow), slow, String(bad));
  }
});

// (2026-11-16, G1b one-sided, claude/g1b-land-presence-20261116 — SOURCE ONLY, NOT run) within one season a land
// record does not disappear once it exists (no program path closes it; the herald drops a capture only for an absent
// account), so under the same real tie and identity a held record beats an answer without one.
test('a real tie, the held record against an answer without one (absent, or null: version 0 or refused bytes): the held land kept, the rest the answer\'s', () => {
  const held = env({ land: land(41) });
  const absent = env({ slots: [{ key: 'ar:2,0,20,1,1' }] }), r1 = latest(held, absent);
  assert.equal(r1.land, held.land); assert.equal(r1.slots, absent.slots);
  const nulled = env({ land: null }); assert.equal(latest(held, nulled).land, held.land);
});
test('the answer has the record and the held one does not: the answer (first appearance), as before', () => {
  assert.equal(latest(env(), env({ land: land(40) })).land.nextBell, 40);
  assert.equal(latest(env({ land: null }), env({ land: land(40) })).land.nextBell, 40);
});
test('one-sided, but not a real tie, or another season / province, or the held record invalid: the answer, as before', () => {
  const held = env({ land: land(41) });
  const newer = env({ seq: '901' }); assert.equal(latest(held, newer), newer, 'a newer Province without land is authoritative here (G1b server contract)');
  const otherSeason = env({ province: province({ seasonId: 6n }) }); assert.equal(latest(held, otherSeason), otherSeason);
  const noTie = env({ seq: '' }); assert.equal(latest(env({ seq: '', land: land(41) }), noTie), noTie);
  for (const bad of [land(41, { q: 1 }), land(-1), land(2 ** 32)]) { const h = env({ land: bad }), a = env(); assert.equal(latest(h, a), a); }
});

test('not a tie: as before (a newer seq is the answer; an older seq keeps the held envelope whole)', () => {
  const held = env({ land: land(41) });
  const newer = env({ seq: '901', land: land(40) }); assert.equal(latest(held, newer), newer);
  const older = env({ seq: '899', land: land(42) }); assert.equal(latest(held, older), held);
});

// (2026-11-16, review addendum — SOURCE ONLY, NOT run) only what the herald's answer can carry makes a tie: a
// non-negative BigInt, a non-negative safe integer, or a plain decimal string (parseEnvelope: seq String(env.seq ?? ''),
// slot / bell as they came). The same bad value on both sides is still no tie.
test('no tie from values the answer cannot carry: booleans, spaces, signs, fractions, exponents, unsafe numbers', () => {
  const bad = [{ seq: false }, { seq: true }, { seq: ' 900' }, { seq: '900 ' }, { seq: '-900' }, { seq: '+900' }, { seq: '9e2' }, { seq: '900.0' },
    { slot: 81.5 }, { slot: -81 }, { slot: Number.MAX_SAFE_INTEGER + 2 }, { bell: '20x' }, { bell: -20 }, { bell: NaN }, { seq: -900n }];
  for (const o of bad) {
    const held = env({ ...o, land: land(41) }), slow = env({ ...o, land: land(40) });
    assert.equal(latest(held, slow), slow, JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? `${v}n` : v)));
  }
});
test('values it can carry still tie: BigInt, safe integers, decimal strings', () => {
  for (const o of [{ seq: 900n }, { slot: 81 }, { bell: '20' }, { seq: '0900' }]) {
    const held = env({ ...o, land: land(41) }), slow = env({ ...o, land: land(40) });
    assert.equal(latest(held, slow).land, held.land, JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? `${v}n` : v)));
  }
});
test('the province identity: integer p and q, a BigInt seasonId on both sides; else no protection', () => {
  const held = env({ land: land(41) });
  for (const pv of [province({ seasonId: 5 }), province({ seasonId: '5' }), province({ q: 0.5 }), province({ p: '2' })]) {
    const h = env({ province: pv, land: land(41, { q: pv.q, p: pv.p }) }), slow = env({ province: pv, land: land(40, { q: pv.q, p: pv.p }) });
    assert.equal(latest(h, slow), slow, JSON.stringify(pv, (k, v) => (typeof v === 'bigint' ? `${v}n` : v)));
  }
  assert.equal(latest(held, env({ land: land(40) })).land, held.land, 'the well-formed case still protects');
});
test('nextBell within uint32 (parseLand reads it with getUint32); beyond it, no protection', () => {
  for (const nb of [2 ** 32, Number.MAX_SAFE_INTEGER]) {
    const held = env({ land: land(nb) }), slow = env({ land: land(40) });
    assert.equal(latest(held, slow), slow, String(nb));
  }
  const top = env({ land: land(2 ** 32 - 1) }); assert.equal(latest(top, env({ land: land(40) })).land, top.land);
});
