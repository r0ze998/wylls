// expansion-gameplay-1 (owner t491u 2026-11-24: nations should visibly spread across the map): REACH FROM THE NATION'S
// LAND. A wide claim (0xD9) may name a reach witness — a wide province of the claimer's nation (a village of it, or a
// keep it won) — and then reaches OUTPOST_RANGE provinces from there, not only from the first home (frontier-abi
// world_index/reach.rs, program proc/wide.rs). This file checks the page's and the relay's one builder, the nation's
// land read from captured province bytes, the page card's targets, and the operator AI's choice of where to expand.
// THIS FILE MAKES NO KEY: nothing is signed, sent or served; no chain, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as W from '../../permutation-server/web/frontier/flocalplay-wide.mjs';
import { seasonAddresses } from '../../permutation-server/web/frontier/faddr.mjs';
import { wideHoldingAddress } from '../../permutation-server/web/frontier/fwide.mjs';
import * as P from '../src/frontier/local-play-operator-policy.mjs';
import * as X from '../src/frontier/local-play-operator-expansion.mjs';

const WALLET = 'BbPGAbHDvV5U43zQ5E8FmSnEzZ7r2vwWAZWTNAPTTSUT';
// (the local play program id, local-play-relay.mjs LOCAL_PLAY_PROGRAM)
const LOCAL_PLAY_PROGRAM = '5fQPsn8hoaVddFG26cWQ5QFdqxWtUPNaZ9zH2E6LYzFn';
// a rim first home (ring 128) and wide provinces along ring 129 (distance from the home = |q| + small)
const HOME = { p: 128, q: 0, site: 0 };
const NEAR = { p: '129', q: '0' };        // 1 from home
const FAR = { p: '129', q: '-8' };        // 8 from home
const LAND = { p: '129', q: '-6' };       // 6 from home, 2 from FAR
const refused = (f, code) => assert.throws(f, e => e.code === code, code);

/** A wide province's captured bytes (4,864): villages `[{site, faction}]` in the site mirror, a keep `{holder, changes}`. */
function bytesOf({ villages = [], keep = null, siteCount = 12 } = {}) {
  const b = new Uint8Array(4864);
  b[262] = siteCount;
  for (const v of villages) { const o = 296 + v.site * 64; b[o] = 1; b[o + 1] = v.faction; }
  if (keep) { b[4480] = 30; b[4481] = keep.holder; b[4486] = keep.changes & 0xff; b[4487] = keep.changes >> 8; } else b[4480] = 0xff;
  return b;
}
const b64 = b => Buffer.from(b).toString('base64');

test('the intent: a far target needs a reach witness within outpost_range of it; the witness is never the target', () => {
  refused(() => W.wideClaimIntent({ holding: HOME, target: FAR }, { site: 1, slot: 2 }), 'LocalActShape');
  const i = W.wideClaimIntent({ holding: HOME, target: FAR, reach: LAND }, { site: 1, slot: 2 });
  assert.deepEqual(JSON.parse(JSON.stringify(i)), { name: 'WideClaim', subject: { holding: HOME, target: FAR, reach: LAND }, fields: { site: 1, slot: 2 } });
  refused(() => W.wideClaimIntent({ holding: HOME, target: FAR, reach: FAR }, { site: 1, slot: 2 }), 'LocalActShape');
  refused(() => W.wideClaimIntent({ holding: HOME, target: FAR, reach: { p: '129', q: '-2' } }, { site: 1, slot: 2 }), 'LocalActShape'); // 6 from the target
  refused(() => W.wideClaimIntent({ holding: HOME, target: FAR, reach: { p: '128', q: '-6' } }, { site: 1, slot: 2 }), 'LocalActShape'); // not wide
  refused(() => W.wideClaimIntent({ holding: HOME, target: FAR, reach: { p: 129, q: -6 } }, { site: 1, slot: 2 }), 'LocalActShape');   // not decimal text
  refused(() => W.wideClaimIntent({ holding: HOME, target: FAR, reach: LAND, extra: 1 }, { site: 1, slot: 2 }), 'LocalActShape');
  // without a witness, exactly as before
  const near = W.wideClaimIntent({ holding: HOME, target: NEAR }, { site: 0, slot: 2 });
  assert.equal(Object.hasOwn(near.subject, 'reach'), false);
});

test('the instruction: the witness is a 13th, read-only account at its wide province address; none without it', () => {
  const ctx = { programId: LOCAL_PLAY_PROGRAM, seasonId: 11, wallet: WALLET };
  const with13 = W.wideClaimInstruction(W.wideClaimIntent({ holding: HOME, target: FAR, reach: LAND }, { site: 1, slot: 2 }), ctx);
  const with12 = W.wideClaimInstruction(W.wideClaimIntent({ holding: HOME, target: NEAR }, { site: 1, slot: 2 }), ctx);
  assert.equal(with12.keys.length, 12);
  assert.equal(with13.keys.length, 13);
  const season = seasonAddresses(LOCAL_PLAY_PROGRAM, '11').season;
  assert.deepEqual(with13.keys[12], { pubkey: W.wideProvinceAddress(season, LOCAL_PLAY_PROGRAM, LAND.p, LAND.q), isSigner: false, isWritable: false });
  assert.deepEqual(with13.keys.slice(0, 12).map(k => k.isWritable), with12.keys.map(k => k.isWritable), 'the first twelve as always');
  assert.deepEqual([...with13.data], [...W.wideClaimInstruction(W.wideClaimIntent({ holding: HOME, target: FAR, reach: LAND }, { site: 1, slot: 2 }), ctx).data]);
});

test('the nation\'s land from captured bytes: a village of the nation, or a keep it WON — never the opening mosaic', () => {
  assert.equal(W.isNationLandBytes(bytesOf({ villages: [{ site: 3, faction: 2 }] }), 2), true);
  assert.equal(W.isNationLandBytes(bytesOf({ villages: [{ site: 3, faction: 4 }] }), 2), false, 'another nation\'s village');
  assert.equal(W.isNationLandBytes(bytesOf({ villages: [{ site: 11, faction: 2 }], siteCount: 10 }), 2), false, 'past the site count');
  assert.equal(W.isNationLandBytes(bytesOf({ keep: { holder: 2, changes: 0 } }), 2), false, 'the keep the province opened with');
  assert.equal(W.isNationLandBytes(bytesOf({ keep: { holder: 2, changes: 1 } }), 2), true, 'a keep the nation took');
  assert.equal(W.isNationLandBytes(bytesOf({ keep: { holder: 3, changes: 4 } }), 2), false, 'won by another nation');
  assert.equal(W.isNationLandBytes(new Uint8Array(10), 2), false);
  assert.equal(W.isNationLandBytes(bytesOf({ villages: [{ site: 0, faction: 2 }] }), 9), false);
  const entries = [{ ...LAND, bytes_b64: b64(bytesOf({ villages: [{ site: 0, faction: 2 }] })) }, { ...NEAR, bytes_b64: b64(bytesOf({ keep: { holder: 2, changes: 0 } })) }, { p: '129', q: '-3', bytes_b64: 'AAAA' }];
  assert.deepEqual(W.nationLandsOf(entries, 2), [LAND]);
  // the page's cells (map/wideland.mjs): villages with their nation, the keep with its holder and changes
  const cells = [{ p: 129, q: -6, ring: 129, villages: [{ site: 0, nation: 2 }], keep: null }, { p: 129, q: 0, ring: 129, villages: [], keep: { holder: 2, changes: 0 } },
    { p: 130, q: -10, ring: 130, villages: [], keep: { holder: 2, changes: 2 } }];
  assert.deepEqual(W.nationLandsOfCells(cells, 2), [{ p: '129', q: '-6' }, { p: '130', q: '-10' }]);
  assert.deepEqual(W.nationLandsOfCells(cells, null), []);
  assert.deepEqual(W.mergeOpened([NEAR], cells), [NEAR, { p: '129', q: '-6' }, { p: '130', q: '-10' }]);
});

test('claim targets: home range first (unchanged without land), then the land\'s reach, each with its nearest witness', () => {
  const opened = [NEAR, FAR, LAND, { p: '129', q: '-20' }, { p: '130', q: '-9' }];
  assert.deepEqual(W.claimTargets(HOME, opened), [NEAR], 'no land: the old list');
  const t = W.claimTargets(HOME, opened, [LAND]);
  assert.deepEqual(t[0], NEAR);
  assert.deepEqual(t.slice(1), [{ ...FAR, reach: LAND }, { p: '130', q: '-9', reach: LAND }]);
  assert.ok(!t.some(x => x.p === LAND.p && x.q === LAND.q), 'a land is not its own witness (and nothing else reaches it here)');
  // two lands: the nearer witness
  const t2 = W.claimTargets(HOME, opened, [LAND, { p: '129', q: '-9' }]);
  assert.deepEqual(t2.find(x => x.q === '-8').reach, { p: '129', q: '-9' });
});

test('the AI: farther from home first, along its heading, a province the nation already holds counts less', () => {
  assert.deepEqual([0, 1, 2, 3].map(X.headingOf), ['outward', 'clockwise', 'counter-clockwise', 'outward']);
  const entries = [NEAR, FAR, LAND, { p: '130', q: '-9' }, { p: '131', q: '-10' }].map(e => ({ ...e, bytes_b64: null }));
  entries[2].bytes_b64 = b64(bytesOf({ villages: [{ site: 0, faction: 1 }] }));
  const wideNow = { opened: entries.map(({ p, q }) => ({ p, q })), entries };
  const best = X.expansionTargets(HOME, wideNow, 1, { heading: 'outward' });
  assert.equal(best[0].reach?.q, '-6', 'the best target is reached through the nation\'s land');
  assert.ok(W.distance(HOME, best[0]) > W.distance(HOME, best[best.length - 1]), 'the frontier first, the home\'s neighbour last');
  assert.deepEqual(X.expansionTargets(HOME, null, 1), []);
  // heading: outward prefers the outer ring among equally far targets
  assert.ok(X.headingBonus(HOME, { p: '131', q: '-10' }, 'outward') > X.headingBonus(HOME, { p: '129', q: '-10' }, 'outward'));
  const cw = X.headingBonus(HOME, { p: '129', q: '5' }, 'clockwise'), ccw = X.headingBonus(HOME, { p: '129', q: '5' }, 'counter-clockwise');
  assert.ok((cw > 0) !== (ccw > 0) || (cw === 0 && ccw === 0), 'the two lateral headings never both pull one way');
  // no nation land: only home's reach, as before
  const plain = X.expansionTargets(HOME, { opened: wideNow.opened, entries: entries.map(e => ({ ...e, bytes_b64: null })) }, 1);
  assert.deepEqual(plain, [NEAR]);
});

test('the AI policy names the witness for a far target, none inside home range', () => {
  const v1 = { joined: true, faction: 1, holding: { p: 128, q: 0, site: 0, tile: 5 }, wide: 0 };
  const d = P.decideNext(P.createResidentMemory(0), v1, { homes: [], wide: { targets: [{ ...FAR, reach: LAND, free: [2] }], canClaim: true }, nowSecs: 1 });
  assert.deepEqual([d.name, d.fields.site, JSON.parse(JSON.stringify(d.v.reach))], ['WideClaim', 2, LAND]);
  const d2 = P.decideNext(P.createResidentMemory(0), v1, { homes: [], wide: { targets: [{ ...NEAR, free: [0] }], canClaim: true }, nowSecs: 1 });
  assert.equal(Object.hasOwn(d2.v, 'reach'), false);
});

test('a slot-3 claim names the slot-2 WIDE village as its previous pair (refused before: the anchor pair, BadAccount)', () => {
  const PREV = { p: '129', q: '-6', site: 4 };
  refused(() => W.wideClaimIntent({ holding: HOME, target: FAR, reach: LAND }, { site: 1, slot: 3 }), 'LocalActShape');          // slot 3 without it
  refused(() => W.wideClaimIntent({ holding: HOME, target: NEAR, previous: PREV }, { site: 1, slot: 2 }), 'LocalActShape');      // slot 2 with it
  refused(() => W.wideClaimIntent({ holding: HOME, target: FAR, reach: LAND, previous: { ...PREV, site: 12 } }, { site: 1, slot: 3 }), 'LocalActShape');
  const i = W.wideClaimIntent({ holding: HOME, target: FAR, reach: LAND, previous: PREV }, { site: 1, slot: 3 });
  const ix = W.wideClaimInstruction(i, { programId: LOCAL_PLAY_PROGRAM, seasonId: 11, wallet: WALLET });
  const season = seasonAddresses(LOCAL_PLAY_PROGRAM, '11').season;
  assert.equal(ix.keys.length, 13);
  assert.deepEqual(ix.keys[9], { pubkey: wideHoldingAddress(season, LOCAL_PLAY_PROGRAM, 129n, -6n, 4), isSigner: false, isWritable: true });
  assert.deepEqual(ix.keys[10], { pubkey: W.wideProvinceAddress(season, LOCAL_PLAY_PROGRAM, '129', '-6'), isSigner: false, isWritable: false });
  // the AI names its known second village, or waits for one
  const v1 = { joined: true, faction: 1, holding: { p: 128, q: 0, site: 0, tile: 5 }, wide: 1 };
  const m = P.createResidentMemory(0); m.claims = 1; m.wideVillages = [PREV];
  const d = P.decideNext(m, v1, { homes: [], wide: { targets: [{ ...FAR, reach: LAND, free: [2] }], canClaim: true }, nowSecs: 1 });
  assert.deepEqual([d.name, d.fields.slot, JSON.parse(JSON.stringify(d.v.previous))], ['WideClaim', 3, PREV]);
  const m2 = P.createResidentMemory(0); m2.claims = 1;
  assert.equal(P.decideNext(m2, v1, { homes: [], wide: { targets: [{ ...FAR, reach: LAND, free: [2] }], canClaim: true }, nowSecs: 1 }).name, 'Harvest');
});
