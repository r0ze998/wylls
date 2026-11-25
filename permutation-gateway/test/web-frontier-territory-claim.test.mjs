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
  assert.equal(T.tileUpkeepV1(2), 330); // Q-LP15-1 (b): ×10
  assert.equal(T.tileUpkeepV1(8), 1130);
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
  assert.equal(v.upkeepMilliPerHour, 61 * 330 + 160 * 122);
  assert.equal(T.decodeTerritoryPlayer(new Uint8Array(320)), null);
  assert.equal(T.citizenTagOf(encode(Uint8Array.from([1, 0, 0, 0, 0, 0, 0, 0, ...new Array(24).fill(9)]))), '1');
});

test('a village claim in a territory world names the territory record (13th account) and skips the home range', async () => {
  const W = await import('../../permutation-server/web/frontier/flocalplay-wide.mjs');
  const { seasonAddresses } = await import('../../permutation-server/web/frontier/faddr.mjs');
  const far = W.wideClaimIntent({ holding: HOME, target: { p: '129', q: '-8' }, territory: true }, { site: 3, slot: 2 });
  const ix = W.wideClaimInstruction(far, { programId: PROGRAM, seasonId: 1, wallet: WALLET });
  assert.equal(ix.keys.length, 13);
  const A = seasonAddresses(PROGRAM, '1');
  assert.equal(ix.keys[12].pubkey, T.territoryProvinceAddress(A.season, PROGRAM, '129', '-8'));
  assert.equal(ix.keys[12].isWritable, false);
  assert.throws(() => W.wideClaimIntent({ holding: HOME, target: { p: '129', q: '-8' }, territory: true, reach: { p: '129', q: '-6' } }, { site: 3, slot: 2 }));
  assert.throws(() => W.wideClaimIntent({ holding: HOME, target: { p: '129', q: '-8' }, territory: 'yes' }, { site: 3, slot: 2 }));
});

test('the wide province trailer: the territory byte and the keep captor record are read as the Rust reader does', async () => {
  const { wideTrailerReservedOk } = await import('../../permutation-server/web/frontier/map/widecapture.mjs');
  const t = 4736, b = new Uint8Array(4864);
  assert.equal(wideTrailerReservedOk(b, t), true, 'all zero: no territory, no capture');
  b[t + 53] = 1; assert.equal(wideTrailerReservedOk(b, t), true, 'territory V1');
  b[t + 104] = 1; b[t + 110] = 7; assert.equal(wideTrailerReservedOk(b, t), true, 'a captor record');
  b[t + 104] = 2; assert.equal(wideTrailerReservedOk(b, t), false, 'unknown captor tag');
  b[t + 104] = 0; assert.equal(wideTrailerReservedOk(b, t), false, 'untagged bytes');
  b[t + 110] = 0; b[t + 53] = 2; assert.equal(wideTrailerReservedOk(b, t), false, 'unknown territory rule');
  b[t + 53] = 0; b[t + 55] = 1; assert.equal(wideTrailerReservedOk(b, t), false, 'still reserved');
});

// verify-pr206-209 (owner TQ-2): the upkeep distance from the NEAREST own village — an own wide village nearer than the
// first home is named: village byte 1 and its wide holding address after the witness, read-only.
test('the nearest own village is named: byte 22 = 1, the wide holding after the witness', async () => {
  const { wideHoldingAddress } = await import('../../permutation-server/web/frontier/fwide.mjs');
  const { seasonAddresses } = await import('../../permutation-server/web/frontier/faddr.mjs');
  const target = { p: '131', q: '-3' };
  assert.equal(T.nearerOwnVillage(HOME, target, []), null);
  assert.equal(T.nearerOwnVillage(HOME, target, [{ p: '120', q: '0', site: 1 }]), null, 'farther than home: not named');
  const v = T.nearerOwnVillage(HOME, target, [{ p: 131n, q: -2n, site: 4 }, { p: '129', q: '0', site: 1 }]);
  assert.deepEqual(v, { p: '131', q: '-2', site: 4 });
  const intent = T.territoryClaimIntent({ holding: HOME, target, witness: { kind: 'own', p: '130', q: '0' }, village: v }, { tile: 9 });
  const ix = T.territoryClaimInstruction(intent, { programId: PROGRAM, seasonId: 1, wallet: WALLET });
  assert.equal(ix.data[22], 1);
  assert.equal(ix.keys.length, 12);
  const A = seasonAddresses(PROGRAM, '1');
  assert.deepEqual(ix.keys[11], { pubkey: wideHoldingAddress(A.season, PROGRAM, 131n, -2n, 4), isSigner: false, isWritable: false });
  // a heartland "village" is not a wide one: refused
  assert.throws(() => T.territoryClaimIntent({ holding: HOME, target, village: { p: '10', q: '0', site: 1 } }, { tile: 9 }));
  // without a village the byte stays 0 (unchanged wire)
  const plain = T.territoryClaimInstruction(T.territoryClaimIntent({ holding: HOME, target: { p: '129', q: '0' } }, { tile: 9 }), { programId: PROGRAM, seasonId: 1, wallet: WALLET });
  assert.equal(plain.data[22], 0);
});

test('the page card reads a territory province from its capture (trailer byte 1), nothing otherwise', async () => {
  const { territoryOfCapture } = await import('../../permutation-server/web/frontier/map/wideland.mjs');
  const b = new Uint8Array(4864);
  b[262] = 3; b.set([5, 20, 40], 250); b[4480] = 30;
  assert.equal(territoryOfCapture(Buffer.from(b).toString('base64')), null);
  b[4789] = 1;
  assert.deepEqual(territoryOfCapture(Buffer.from(b).toString('base64')), { siteTiles: [5, 20, 40], keepTile: 30 });
  assert.equal(territoryOfCapture(undefined), null);
});
