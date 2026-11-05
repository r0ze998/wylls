// ⑯ independent probe of the ⑮ candidate "exact source identity"
// (15-separate.patch / the ⑮ part of 13-15-integrated.patch). Literal input
// only: no key generation, derivation or signing, no chain or network.
// Run from workstreams/15-coop-outcomes/test of a tree with the patch applied.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cargoOf, fromS1Records, placeOf } from '../src/adapters/s1-chain.mjs';

const resolve = { actorOfTag: () => null };
const one = (seq, rec = { name: 'UNMAPPED', bell: 1 }) => fromS1Records([{ seq, record: rec }], resolve);

test('V16-15a: the largest exact position is kept; one above, a fraction or a bigint above 2^53-1 is refused', () => {
  assert.equal(one(Number.MAX_SAFE_INTEGER).events[0].seq, Number.MAX_SAFE_INTEGER);
  assert.equal(one('9007199254740991').events[0].seq, Number.MAX_SAFE_INTEGER);
  assert.equal(one(5n).events[0].seq, 5);
  for (const v of [1.5, 9007199254740992n, '9007199254740992', ' 1', '1e3', NaN, Infinity, undefined]) assert.throws(() => one(v), String(v));
});

test('V16-15b: an event id names the position the event carries (no two spellings of one position)', () => {
  // seq '7' (string) and 7 (number) are the same position; their ids should be the same.
  const a = one('7').events[0], b = one(7).events[0], c = one(7n).events[0];
  assert.deepEqual([a.seq, b.seq, c.seq], [7, 7, 7]);
  assert.deepEqual([a.id, b.id, c.id], [b.id, b.id, b.id], `ids differ by input spelling: ${[a.id, b.id, c.id].join(' | ')}`);
});

test('V16-15c: bell is a u32: 0 and 2^32-1 pass the range check, logBell is used when bell is absent, a non-integer is refused', () => {
  assert.doesNotThrow(() => one(0, { name: 'UNMAPPED', bell: 0 }));
  assert.doesNotThrow(() => one(0, { name: 'UNMAPPED', logBell: 3 }));
  for (const bell of [-1, 1.5, '1.0', 2 ** 32]) assert.throws(() => one(0, { name: 'UNMAPPED', bell }), String(bell));
});

test('V16-15d: place and cargo stay exact at their limits', () => {
  assert.equal(placeOf((1n << 64n) - 1n).tile, 255);
  assert.throws(() => placeOf(1n << 64n));
  assert.throws(() => cargoOf(new Uint8Array(31)));
  assert.throws(() => cargoOf(Array(33).fill(0)));
  assert.deepEqual(cargoOf(Array(32).fill(255)), Array(8).fill(0xffffffff));
});
