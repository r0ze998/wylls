// territory-impl (owner decisions 2026-11-24 12:09 JST): the page's / relay's / AI's builder of the single-tile claim
// (0xDA op 7 WideClaimTile) and its territory record views match the Rust side byte for byte. The literals are pinned
// on both sides (frontier-abi world_index/territory.rs `seeds_and_wire_are_pinned_for_the_page_copy`). Key-free.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as T from '../../permutation-server/web/frontier/flocalplay-territory.mjs';
import { encode } from '../../permutation-server/web/sdk/base58.mjs';

const PROGRAM = encode(new Uint8Array(32).fill(0x45));
const WALLET = encode(new Uint8Array(32).fill(0x0a));
const HOME = { p: 128, q: 0, site: 2 };

test('seeds are the Rust ones (pinned literals)', () => {
  assert.equal(T.territoryProvinceSeed('130', '0'), 'wna7ca105a668a517c0fbe0bb3149f25');
  assert.equal(T.territoryPlayerSeed(encode(new Uint8Array(32).fill(1))), 'wuca297c5a8f581acf1f8ebc6fda812b');
});

test('V1 numbers: the claim cost rises 2 % per tile, the upkeep grows past 3 provinces', () => {
  assert.equal(T.claimCostV1(0), 10);
  assert.equal(T.claimCostV1(100), 30);
  assert.equal(T.tileUpkeepV1(2), 33);
  assert.equal(T.tileUpkeepV1(8), 113);
});

test('the wire: 23 bytes, op 7, the witness byte and the account order', () => {
  const intent = T.territoryClaimIntent({ holding: HOME, target: { p: '130', q: '-2' }, witness: { kind: 'own', p: '130', q: '0' } }, { tile: 17 });
  const ix = T.territoryClaimInstruction(intent, { programId: PROGRAM, seasonId: 1, wallet: WALLET });
  const want = new Uint8Array(23);
  want.set([0xda, 0xff, 0x01, 0x07]);
  const dv = new DataView(want.buffer);
  dv.setBigInt64(4, 130n, true); dv.setBigInt64(12, -2n, true);
  want.set([17, 2, 0], 20);
  assert.deepEqual([...ix.data], [...want]);
  assert.equal(ix.keys.length, 11);
  assert.deepEqual(ix.keys.map(k => [k.isSigner, k.isWritable]), [
    [true, false], [true, true], [false, false], [false, true], [false, false], [false, true], [false, true],
    [false, true], [false, false], [false, false], [false, false],
  ]);
  const none = T.territoryClaimInstruction(T.territoryClaimIntent({ holding: HOME, target: { p: '129', q: '0' } }, { tile: 3 }), { programId: PROGRAM, seasonId: 1, wallet: WALLET });
  assert.equal(none.keys.length, 10);
  assert.equal(none.data[21], 0);
});

test('the intent refuses what the program would', () => {
  const bad = (s, f) => assert.throws(() => T.territoryClaimIntent(s, f, 'X'));
  bad({ holding: HOME, target: { p: '129', q: '0' } }, { tile: 61 });
  bad({ holding: HOME, target: { p: '129', q: '-8' } }, { tile: 1 }); // 8 from home
  bad({ holding: HOME, target: { p: '100', q: '0' } }, { tile: 1 }); // not wide land
  bad({ holding: HOME, target: { p: '129', q: '0' }, witness: { kind: 'friend', p: '129', q: '1' } }, { tile: 1 });
  assert.throws(() => T.territoryClaimIntent({ holding: { p: 129, q: 0, site: 1 }, target: { p: '129', q: '0' } }, { tile: 1 }), /LocalActWideHolding/);
  // a far tile through a witness within range
  assert.equal(T.territoryClaimIntent({ holding: HOME, target: { p: '129', q: '-8' }, witness: { kind: 'nation', p: '129', q: '-6' } }, { tile: 1 }).name, T.TERRITORY_CLAIM);
});

test('record views decode the Rust layouts', () => {
  const tp = new Uint8Array(672);
  tp.set([...'PSFXWTN1'].map(c => c.charCodeAt(0)));
  tp[18] = 1; tp[19] = 1; tp[69] = 30;
  new DataView(tp.buffer).setBigUint64(104 + 8 * 5, 77n, true);
  tp[592 + 5] = 4;
  const p = T.decodeTerritoryProvince(tp);
  assert.equal(p.owners[5], '77');
  assert.equal(p.owners[4], null);
  assert.equal(p.dist[5], 4);
  const pl = new Uint8Array(320);
  pl.set([...'PSFXWTU1'].map(c => c.charCodeAt(0)));
  const dv = new DataView(pl.buffer);
  pl[18] = 1; pl[19] = 1; dv.setUint32(120, 99, true);
  dv.setBigUint64(84, 77n, true); dv.setUint32(92, 61, true); dv.setBigUint64(96, 122n, true);
  const v = T.decodeTerritoryPlayer(pl);
  assert.equal(v.tiles, 61);
  assert.equal(v.unpaidSince, 99);
  assert.equal(v.upkeepMilliPerHour, 61 * 33 + 16 * 122);
  assert.equal(T.decodeTerritoryPlayer(new Uint8Array(320)), null);
  assert.equal(T.citizenTagOf(encode(Uint8Array.from([1, 0, 0, 0, 0, 0, 0, 0, ...new Array(24).fill(9)]))), '1');
});
