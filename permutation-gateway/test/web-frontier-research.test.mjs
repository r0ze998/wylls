// World goal ② research (owner r0ze 2026-11-25 08:56, every Q-RS recommendation): the page's / relay's / AI's builder of
// the pledge and the apply (0xDA op 8, 0xDC op 16), the record views and the V1 numbers match the Rust side. The seed
// literals are pinned on both sides (frontier-abi world_index/research.rs `seeds_are_pinned_for_the_js_mirror`), the
// record offsets by `layout_offsets_are_pinned_for_the_js_mirror`. Key-free.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as R from '../../permutation-server/web/frontier/flocalplay-research.mjs';
import { encode } from '../../permutation-server/web/sdk/base58.mjs';
import { worldBytes, nationBytes } from './research-fixtures.mjs';

const PROGRAM = encode(new Uint8Array(32).fill(0x45));
const WALLET = encode(new Uint8Array(32).fill(0x0a));
const HOME = { p: 3, q: -1, site: 2 };

test('seeds are the Rust ones (pinned literals)', () => {
  assert.equal(R.researchWorldSeed(), 'weed9a37491f1b6cb789f30a8a718917');
  assert.equal(R.nationResearchSeed(0), 'wkf23f021f1c9e2a9e225e935ffc2430');
  assert.equal(R.nationResearchSeed(5), 'wkcef1b317c4e9e2088f4326567f1ba9');
});

test('V1 numbers: costs by era, −20 % per other nation up to 3, the era step and the refusals', () => {
  assert.deepEqual([0, 1, 2, 3, 4].map(k => R.costV1(0, k)), [300, 240, 180, 120, 120]);
  assert.equal(R.costV1(4, 0), 800);
  assert.equal(R.costV1(8, 3), 800);
  assert.equal(R.costV1(12, 0), null);
  assert.equal(R.refusalOf(4, 2, 1), 'EraClosed', 'V1 opens era 1 only (Q-RS-6 (a))');
  assert.equal(R.refusalOf(0, 1, 1), 'Known');
  assert.equal(R.refusalOf(3, 1, 0), null);
  assert.equal(R.eraAfter(1, 0b0111), 2);
  assert.equal(R.eraAfter(1, 0b0011), 1);
  assert.equal(R.RESEARCH_V1.roadsEffectLive, false);
});

test('the effects mirror the kernel (masonry −10 % time, bronze −10 % ore, agriculture +10 % food, rounded down)', () => {
  assert.equal(R.buildSecsWith(0b10, 5400), 4860);
  assert.equal(R.buildSecsWith(0, 5400), 5400);
  assert.equal(R.trainOreWith(0b100, 20_000), 18_000);
  assert.equal(R.foodRateWith(0b1, 40_000), 44_000);
});

test('the village mask: techs, nation, the banked-science cut; gated by the village\'s nation', () => {
  const h = new Uint8Array(1280);
  const m = 0b0101 | ((2 + 1) << 12) | 0x8000;
  h[1258] = m & 0xff; h[1259] = m >> 8;
  const v = R.villageMaskOf(h);
  assert.deepEqual(v, { techs: 0b0101, nation: 2, rebased: true });
  assert.equal(R.effectiveTechs(v, 2), 0b0101);
  assert.equal(R.effectiveTechs(v, 3), 0, 'a captured village plays without them until the next apply');
  assert.deepEqual(R.villageMaskOf(new Uint8Array(1280)), { techs: 0, nation: null, rebased: false });
});

test('the pledge wire: 9 bytes, op 8, the account order (first home and wide village)', () => {
  const intent = R.researchPledgeIntent({ holding: HOME, nation: 4 }, { tech: 2, amount: 300 });
  const ix = R.researchPledgeInstruction(intent, { programId: PROGRAM, seasonId: 1, wallet: WALLET });
  assert.deepEqual([...ix.data], [0xda, 0xff, 0x01, 0x08, 2, 44, 1, 0, 0]);
  assert.deepEqual(ix.keys.map(k => [k.isSigner, k.isWritable]), [[true, false], [true, true], [false, false], [false, true], [false, true], [false, true], [false, true]]);
  const wide = R.researchPledgeIntent({ wide: { p: '130', q: '-2', site: 1 }, nation: 4 }, { tech: 0, amount: 1 });
  const wix = R.researchPledgeInstruction(wide, { programId: PROGRAM, seasonId: 1, wallet: WALLET });
  assert.notEqual(wix.keys[4].pubkey, ix.keys[4].pubkey);
  assert.equal(wix.keys[6].pubkey, ix.keys[6].pubkey, 'the same nation record');
  assert.throws(() => R.researchPledgeIntent({ holding: HOME, nation: 0 }, { tech: 12, amount: 1 }), /LocalActShape/);
  assert.throws(() => R.researchPledgeIntent({ holding: HOME, nation: 0 }, { tech: 0, amount: 0 }), /LocalActShape/);
  assert.throws(() => R.researchPledgeIntent({ holding: { p: 130, q: 0, site: 1 }, nation: 0 }, { tech: 0, amount: 1 }), /LocalActWideHolding/);
  assert.throws(() => R.researchPledgeIntent({ holding: HOME }, { tech: 0, amount: 1 }), /LocalActShape/, 'the nation is named');
  assert.throws(() => R.researchPledgeIntent({ holding: HOME, nation: 0, extra: 1 }, { tech: 0, amount: 1 }), /LocalActShape/);
});

test('the apply, settle and start wires', () => {
  const a = R.researchApplyInstruction(R.researchApplyIntent({ holding: HOME, nation: 1 }, {}), { programId: PROGRAM, seasonId: 1, wallet: WALLET });
  assert.deepEqual([...a.data], [0xdc, 0xff, 0x01, 0x10]);
  assert.deepEqual(a.keys.map(k => [k.isSigner, k.isWritable]), [[true, true], [false, false], [false, false], [false, false], [false, true], [false, true]]);
  const s = R.researchSettleInstruction({ programId: PROGRAM, seasonId: 1, wallet: WALLET, faction: 1, tech: 3 });
  assert.deepEqual([...s.data], [0xdc, 0xff, 0x01, 0x0f, 3]);
  const st = R.startResearchInstruction({ programId: PROGRAM, seasonId: 1, authority: WALLET, startBell: 0x0102 });
  assert.deepEqual([...st.data], [0xdb, 0xff, 0x01, 0x01, 1, 2, 1, 0, 0]);
  assert.equal(st.keys.length, 10);
});

test('the record views', () => {
  const w = R.decodeResearchWorld(worldBytes({ first: { 1: 5 }, firstNations: { 1: 0b10100 }, known: { 1: 0b10110 } }));
  assert.equal(w.era, 1);
  assert.deepEqual(w.techs[1], { id: 1, firstBell: 5, firstNations: [2, 4], knownBy: [1, 2, 4] });
  assert.equal(w.techs[0].firstBell, null);
  const n = R.decodeNationResearch(nationBytes(2, { learned: { 1: 5 }, pledged: { 1: 300, 0: 40 } }));
  assert.equal(n.nation, 2);
  assert.equal(n.known, 0b10);
  assert.deepEqual(n.techs[1], { id: 1, known: true, pledged: 300, firstPledgeBell: null, learnedBell: 5 });
  assert.equal(R.decodeResearchWorld(new Uint8Array(256)), null);
});

test('a receipt from the program log', () => {
  const body = new Uint8Array(57), dv = new DataView(body.buffer);
  body.set([1, 2, 5, 0]); dv.setUint32(4, 77, true); body.fill(9, 8, 40); dv.setUint32(40, 10, true); dv.setUint32(44, 30, true); dv.setUint32(48, 300, true); body[52] = 1;
  const r = R.decodeResearchReceipt([new TextEncoder().encode('PSR1'), body]);
  assert.equal(r.kind, 'pledge'); assert.equal(r.tech, 2); assert.equal(r.nation, 5); assert.equal(r.amount, 10); assert.equal(r.bell, 77);
  body[56] = 1;
  assert.equal(R.decodeResearchReceipt([new TextEncoder().encode('PSR1'), body]), null);
});
