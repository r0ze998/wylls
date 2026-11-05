import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cargoOf, fromS1Records, placeOf } from '../src/adapters/s1-chain.mjs';

// Literal input only: no common fixture, keys, derivation, signing, hashing,
// chain, network, provider, timers, filesystem, or external package imports.
test('S1 source positions, packed places and bytes remain exact', () => {
  const resolve = { actorOfTag: () => null };
  const row = seq => [{ seq, record: { name: 'UNMAPPED', bell: 1 } }];
  assert.equal(fromS1Records(row('42'), resolve).events[0].seq, 42);
  for (const value of ['9007199254740993', 9007199254740992, '-1', '01', '', null, true]) {
    assert.throws(() => fromS1Records(row(value), resolve));
  }
  assert.throws(() => fromS1Records([{ seq: 0, record: { name: 'UNMAPPED', bell: 4294967296 } }], resolve));
  assert.throws(() => fromS1Records(row(0), resolve, { worldBell: () => -1 }));
  assert.deepEqual(placeOf(0n), { kind: 0, p: 0, q: 0, site: 0, gen: 0, tile: 0 });
  assert.equal(placeOf('18446744073709551615').tile, 255);
  for (const value of [-1n, '18446744073709551616', 9007199254740992, null, true, '0x10']) {
    assert.throws(() => placeOf(value));
  }
  assert.deepEqual(cargoOf(new Uint8Array(32)), Array(8).fill(0));
  for (const value of [Array(32).fill(-1), Array(32).fill(256), Array(32).fill(1.5), Array(32).fill('1'), null]) {
    assert.throws(() => cargoOf(value));
  }
  const unresolved = fromS1Records([{ seq: 0, record: { name: 'CARAVAN_SETTLED', bell: 1, owner_tag: 1, seq: 1, dst: 0 } }],
    { destination: () => ({ actor: 'a', kind: 'village' }), actorOfTag: () => 'a' });
  assert.equal(unresolved.events.length, 0);
  assert.equal(unresolved.unresolved[0].missing, 'verified exact cargo evidence');
});
