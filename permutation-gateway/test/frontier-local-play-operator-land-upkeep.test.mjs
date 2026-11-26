// owner-answers-logic (owner 2026-11-26 10:52, Q-LP19-1 (a); no rule change): an operator AI resident skips a
// NATION-REACH village target whose site tile would cost more upkeep per hour than its village's food surplus, and a tile
// the world let go (unpaid upkeep) leaves its memory `ownTiles` (loop-play19 side fact: its 24-tile cap and its next
// site choice counted the released tile). Key-free, pure (the policy over a stated view) plus the land reader over a fake
// herald.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createResidentMemory, decideNext, noteOutcome, landTooDear, pruneOwnTiles, OWN_TILE_READ_GRACE, OPERATOR_TILES_MAX } from '../src/frontier/local-play-operator-policy.mjs';
import { ownLandOf, cachedFor } from '../src/frontier/local-play-operator-residents.mjs';
import { tileUpkeepV1, citizenTagOf } from '../../permutation-server/web/frontier/flocalplay-territory.mjs';
import { distance } from '../../permutation-server/web/frontier/flocalplay-wide.mjs';
import { encode } from '../../permutation-server/web/sdk/base58.mjs';

const TERR = { siteTiles: [5, 9, 14, 20, 25, 33, 40, 44, 48, 52, 56, 60], keepTile: 30 };
// loop-play19: the Borealis AI's village at (-65, 128); the target (64, -131) through the nation's land at (65, -129)
const HOME = { p: -65, q: 128, site: 2, tile: 30 };
const VIEW = { joined: true, faction: 4, holding: HOME, wide: 0 };
const FAR = { p: '64', q: '-131', territory: TERR, reach: { p: '65', q: '-129' } };
const NEAR = { p: '-66', q: '129', territory: TERR, reach: { p: '-66', q: '130' } };   // nation reach, a few provinces away
const HOME_REACH = { p: '-65', q: '129', territory: TERR };                            // within reach of home: no witness
// 40 food/h made, 16 tiles near home (15.84 food/h) — the loop-play19 numbers before the far tile
const LAND = { foodMilliPerHour: 40_000, upkeepMilliPerHour: 16 * 990, tiles: 16 };

test('landTooDear: the loop-play19 far target is too dear; near, home-reach, owned or unknown are not', () => {
  const d = landTooDear(FAR, { home: HOME, land: LAND });
  assert.ok(d, 'the far target');
  assert.equal(d.dist, distance(HOME, FAR));
  assert.ok(d.dist > 200, `${d.dist} provinces`);
  assert.equal(d.addMilli, tileUpkeepV1(d.dist));
  assert.equal(d.surplusMilli, 40_000 - 15_840);
  assert.equal(landTooDear(NEAR, { home: HOME, land: LAND }), null, 'a near nation-reach target');
  assert.equal(landTooDear(HOME_REACH, { home: HOME, land: LAND }), null, 'within reach of home: never judged');
  assert.equal(landTooDear({ ...FAR, territory: undefined }, { home: HOME, land: LAND }), null, 'no territory world: no upkeep');
  assert.equal(landTooDear(FAR, { home: HOME, land: null }), null, 'land not read: nothing judged');
  assert.equal(landTooDear(FAR, { home: HOME, land: LAND, ownTiles: [{ p: '64', q: '-131', tile: 9 }] }), null, 'a tile there is its own already');
  // the upkeep distance is from the NEAREST own village (TQ-2): a wide village next to the target makes it cheap
  assert.equal(landTooDear(FAR, { home: HOME, land: LAND, villages: [{ p: '64', q: '-130', site: 1 }] }), null);
  // the border: exactly the surplus is not too dear, one milli more is
  const dist = distance(HOME, NEAR), add = tileUpkeepV1(dist);
  assert.equal(landTooDear(NEAR, { home: HOME, land: { foodMilliPerHour: add, upkeepMilliPerHour: 0 } }), null);
  assert.ok(landTooDear(NEAR, { home: HOME, land: { foodMilliPerHour: add - 1, upkeepMilliPerHour: 0 } }));
  // an unpaid land (upkeep above the food) leaves no surplus: even a near nation-reach tile waits
  assert.ok(landTooDear(NEAR, { home: HOME, land: { foodMilliPerHour: 40_000, upkeepMilliPerHour: 41_000 } }));
});

test('the AI claims the near target\'s tile, not the far one, and says what it skipped', () => {
  const m = createResidentMemory(1);
  const d = decideNext(m, VIEW, { homes: [], wide: { targets: [FAR, NEAR], canClaim: true, land: LAND } });
  assert.equal(d.name, 'TerritoryClaim');
  assert.deepEqual(d.v.target, { p: NEAR.p, q: NEAR.q });
  assert.deepEqual(d.dear, ['64,-131']);
  assert.match(d.why, /skipped 1 nation-reach target/);
  // the same view without the land read: as before (the far target is first) — the reader below always gives it
  const before = decideNext(createResidentMemory(1), VIEW, { homes: [], wide: { targets: [FAR, NEAR], canClaim: true } });
  assert.deepEqual(before.v.target, { p: FAR.p, q: FAR.q });
});

test('only a far target: no tile and no village claim there, and no saving for it (training is not capped)', () => {
  const m = createResidentMemory(1);
  m.decisions = 1;   // odd: no growth this decision
  const d = decideNext(m, VIEW, { homes: [], wide: { targets: [FAR], canClaim: true, land: LAND, stores: [9999, 9999, 9999, 9999, 0, 9999, 0, 0], ore: 9999 } });
  assert.ok(!['TerritoryClaim', 'WideClaim'].includes(d.name), JSON.stringify(d));
  assert.match(d.why, /skipped 1 nation-reach target/);
  // the rotation is free again: some decision of it trains (no "saving for a village" cap)
  const names = new Set();
  for (let i = 0; i < 12; i++) { const x = decideNext(m, VIEW, { homes: [], wide: { targets: [FAR], canClaim: true, land: LAND, stores: [9999, 9999, 9999, 9999, 0, 9999, 0, 0], ore: 9999 } }); names.add(x.name); noteOutcome(m, x, 'landed'); m.ownTiles = []; }
  assert.ok(names.has('Train'), [...names].join(','));
  // once a village of its own stands next to the target, the target is near: the tile is claimed
  const m2 = createResidentMemory(1);
  m2.wideVillages = [{ p: '64', q: '-130', site: 1 }];
  const d2 = decideNext(m2, VIEW, { homes: [], wide: { targets: [FAR], canClaim: true, land: LAND } });
  assert.equal(d2.name, 'TerritoryClaim');
  assert.deepEqual(d2.v.target, { p: FAR.p, q: FAR.q });
});

test('pruneOwnTiles: a tile the herald shows as not its own leaves the memory; a fresh claim and an unread world stay', () => {
  const tag = '777';
  const owners = new Array(61).fill(null);
  owners[9] = tag; owners[14] = '888';   // 9 its own, 14 another's
  const records = new Map([['129,0', { owners }]]);
  const m = { decisions: 100, ownTiles: [
    { p: '129', q: '0', tile: 9, at: 10 },     // still its own
    { p: '129', q: '0', tile: 14, at: 10 },    // taken by another since
    { p: '129', q: '0', tile: 20 },            // released (no owner now; an old memory without `at`)
    { p: '130', q: '0', tile: 5, at: 20 },     // its province has no owned tile at all now: released
    { p: '130', q: '0', tile: 6, at: 100 - OWN_TILE_READ_GRACE + 1 },   // claimed just now: the read may predate it
  ] };
  const dropped = pruneOwnTiles(m, records, tag);
  assert.deepEqual(dropped, ['129,0,14', '129,0,20', '130,0,5']);
  assert.deepEqual(m.ownTiles.map(o => `${o.p},${o.q},${o.tile}`), ['129,0,9', '130,0,6']);
  // no usable read: nothing changes
  const m2 = { decisions: 100, ownTiles: [{ p: '129', q: '0', tile: 20 }] };
  assert.deepEqual(pruneOwnTiles(m2, null, tag), []);
  assert.deepEqual(pruneOwnTiles(m2, records, ''), []);
  assert.equal(m2.ownTiles.length, 1);
});

test('a released tile no longer counts toward the 24-tile cap: growth resumes after the prune', () => {
  const tag = '777', owners = new Array(61).fill(null);
  const own = [];
  for (let i = 0, t = 0; own.length < OPERATOR_TILES_MAX; t++) { if (TERR.siteTiles.includes(t) || t === TERR.keepTile) continue; own.push({ p: '129', q: '0', tile: t, at: 0 }); owners[t] = tag; i++; }
  const m = createResidentMemory(1);
  m.claims = 2; m.decisions = 40; m.ownTiles = own.map(o => ({ ...o }));
  const wide = { targets: [{ p: '129', q: '0', territory: TERR }], canClaim: false };
  assert.notEqual(decideNext(m, VIEW, { homes: [], wide }).name, 'TerritoryClaim', 'at the cap: no growth');
  owners[own[own.length - 1].tile] = null;   // the world let the farthest go
  assert.equal(pruneOwnTiles(m, new Map([['129,0', { owners }]]), tag).length, 1);
  const d = decideNext(m, VIEW, { homes: [], wide });
  assert.equal(d.name, 'TerritoryClaim');
  assert.equal(d.growth, true);
});

test('noteOutcome stamps a landed tile with its decision (the prune grace)', () => {
  const m = createResidentMemory(1);
  const d = decideNext(m, VIEW, { homes: [], wide: { targets: [NEAR], canClaim: true, land: LAND } });
  noteOutcome(m, d, 'landed');
  assert.equal(m.ownTiles[0].at, m.decisions);
});

test('ownLandOf: its own summary from the herald (land), the territory tiles only when a tile was let go', async () => {
  const citizen = encode(Uint8Array.from({ length: 32 }, (_, i) => i + 1));
  const tag = citizenTagOf(citizen);
  const bytes = new Uint8Array(320);
  bytes.set([...'PSFXWTU1'].map(c => c.charCodeAt(0)), 0);
  const dv = new DataView(bytes.buffer);
  dv.setBigUint64(84, BigInt(tag), true); dv.setUint32(92, 17, true); dv.setBigUint64(96, 252n, true);
  const answer = { v: 1, citizen, player: { tiles: 17, unpaid: false, unpaidSince: null, citizenTag: tag, bytes_b64: Buffer.from(bytes).toString('base64') } };
  let tileReads = 0;
  const deps = { territoryPlayer: async c => { assert.equal(c, citizen, 'FOG: its own Citizen only'); return answer; }, territoryTiles: async () => { tileReads++; return { v: 1, tags: [tag], provinces: [] }; } };
  const a = await ownLandOf({ citizen, foodMilliPerHour: 40_000, rememberedTiles: 17, deps });
  assert.deepEqual(a.land, { foodMilliPerHour: 40_000, upkeepMilliPerHour: 17 * 990 + 480 * 252, tiles: 17 });
  assert.equal(a.records, null); assert.equal(tileReads, 0, 'remembered = the record: no tile read');
  const b = await ownLandOf({ citizen, foodMilliPerHour: 40_000, rememberedTiles: 18, deps });
  assert.ok(b.records instanceof Map); assert.equal(tileReads, 1);
  // never claimed: no record, upkeep 0
  const c = await ownLandOf({ citizen, foodMilliPerHour: 40_000, rememberedTiles: 0, deps: { territoryPlayer: async () => ({ v: 1, citizen, player: null }) } });
  assert.deepEqual(c.land, { foodMilliPerHour: 40_000, upkeepMilliPerHour: 0, tiles: 0 });
  // another Citizen's answer, a failed read or no food rate: no land
  assert.equal((await ownLandOf({ citizen, foodMilliPerHour: 40_000, rememberedTiles: 0, deps: { territoryPlayer: async () => ({ ...answer, citizen: 'x' }) } })).land, null);
  assert.equal((await ownLandOf({ citizen, foodMilliPerHour: 40_000, rememberedTiles: 0, deps: { territoryPlayer: async () => { throw new Error('down'); } } })).land, null);
  assert.equal((await ownLandOf({ citizen, foodMilliPerHour: null, rememberedTiles: 0, deps })).land, null);
});

test('cachedFor: one answer shared for its window, a failure not kept', async () => {
  let n = 0, t = 0;
  const ask = cachedFor(1000, async () => { n++; if (n === 2) throw new Error('down'); return n; }, () => t);
  assert.equal(await ask(), 1); assert.equal(await ask(), 1); assert.equal(n, 1);
  t = 2000; await assert.rejects(ask()); assert.equal(await ask(), 3);
});
