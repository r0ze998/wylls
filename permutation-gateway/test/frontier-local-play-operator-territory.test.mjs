// territory-impl (owner decisions 2026-11-24 12:09 / 13:15): operator AI residents play player territory by the
// players' rules — in a territory world a village claim is preceded by the claim of the site's tile (with the same reach
// witness), the village claim then names the territory record, and an idle resident grows its land a tile at a time
// from its own tiles. Key-free, pure (the policy over a stated view).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createResidentMemory, decideNext, noteOutcome, OPERATOR_TILES_MAX } from '../src/frontier/local-play-operator-policy.mjs';
import { territoryOfBytes, withTerritory } from '../src/frontier/local-play-operator-expansion.mjs';

const RIM = { joined: true, faction: 1, holding: { p: 128, q: 0, site: 2, tile: 30 }, wide: 0 };
const TERR = { siteTiles: [5, 9, 14, 20, 25, 33, 40, 44, 48, 52, 56, 60], keepTile: 30 };

test('the capture says whether the world plays territory', () => {
  const b = new Uint8Array(4864);
  b.set(TERR.siteTiles, 250); b[262] = 12; b[4480] = 30;
  assert.equal(territoryOfBytes(b), null, 'byte 0: no territory');
  b[4789] = 1;
  assert.deepEqual(territoryOfBytes(b), TERR);
  const entries = [{ p: '129', q: '0', bytes_b64: Buffer.from(b).toString('base64') }];
  assert.deepEqual(withTerritory([{ p: '129', q: '0' }, { p: '129', q: '1' }], { entries }), [{ p: '129', q: '0', territory: TERR }, { p: '129', q: '1' }]);
});

test('tile first, then the village on it with the territory record; then growth from its own tiles', () => {
  const m = createResidentMemory(0);
  const wide = { targets: [{ p: '129', q: '0', territory: TERR, reach: { p: '129', q: '1' } }], canClaim: true };
  let d = decideNext(m, RIM, { homes: [], wide });
  assert.equal(d.name, 'TerritoryClaim');
  assert.deepEqual(d.fields, { tile: 5 });
  assert.deepEqual(d.v.witness, { kind: 'nation', p: '129', q: '1' });
  noteOutcome(m, d, 'landed');
  assert.deepEqual(m.ownTiles.map(o => o.tile), [5]);
  d = decideNext(m, RIM, { homes: [], wide });
  assert.equal(d.name, 'WideClaim');
  assert.equal(d.v.territory, true);
  assert.equal(d.v.reach, undefined, 'never a reach witness beside the territory record');
  assert.equal(d.fields.site, 0);
  // a refused tile is not asked again and cools the claim
  const m2 = createResidentMemory(0);
  const d2 = decideNext(m2, RIM, { homes: [], wide });
  noteOutcome(m2, d2, 'refused');
  assert.ok(m2.triedTiles.includes('129,0,5') && m2.triedClaims.includes('129,0,0'));
  // growth: claims done, an even decision count → one more tile in its own province, not a site or the keep
  m.claims = 2;
  m.decisions = 10;
  d = decideNext(m, RIM, { homes: [], wide: { targets: [], canClaim: false } });
  assert.equal(d.name, 'TerritoryClaim');
  assert.equal(d.growth, true);
  assert.deepEqual(d.v.witness, { kind: 'own', p: '129', q: '0' });
  assert.ok(!TERR.siteTiles.includes(d.fields.tile) && d.fields.tile !== TERR.keepTile);
  assert.ok(OPERATOR_TILES_MAX > 0);
});

test('outside a territory world nothing changes: the village claim as before', () => {
  const m = createResidentMemory(0);
  const d = decideNext(m, RIM, { homes: [], wide: { targets: [{ p: '129', q: '0' }], canClaim: true } });
  assert.equal(d.name, 'WideClaim');
  assert.equal(d.v.territory, undefined);
});

// verify-pr206-209: a tile claim refused for a reason that passes with time (ore short 21, the turn's claim 29, upkeep
// unpaid 43) only cools the claim; a refusal for good (SiteTaken 11) marks the tile and its site tried; "already
// yours" (52) counts as owned.
test('the AI keeps a site after a temporary tile refusal, drops it after a final one', async () => {
  const { noteOutcome } = await import('../src/frontier/local-play-operator-policy.mjs');
  const d = { name: 'TerritoryClaim', v: { target: { p: '130', q: '0' } }, fields: { tile: 7 }, site: 2 };
  for (const programCode of [21, 29, 43]) {
    const m = { decisions: 0, cooldown: {}, triedHomes: [] };
    noteOutcome(m, d, 'failed', { programCode, code: 'LocalActRejected' });
    assert.equal((m.triedClaims ?? []).length, 0, `code ${programCode}`);
    assert.equal((m.triedTiles ?? []).length, 0);
    assert.ok(m.cooldown.TerritoryClaim > 0);
  }
  const m = { decisions: 0, cooldown: {}, triedHomes: [] };
  noteOutcome(m, d, 'failed', { programCode: 11 });
  assert.deepEqual(m.triedClaims, ['130,0,2']);
  assert.deepEqual(m.triedTiles, ['130,0,7']);
  const m2 = { decisions: 0, cooldown: {}, triedHomes: [] };
  noteOutcome(m2, d, 'failed', { programCode: 52 });
  assert.deepEqual(m2.ownTiles.map(o => o.tile), [7]);
  assert.equal((m2.triedClaims ?? []).length, 0);
});

// verify-pr206-209: in the live ×60 world no AI ever sent a growth claim — the save-for-the-next-village Harvest came
// first. A resident that owns a tile and is SAVING for its next village (stores short of the settler cost) grows its land.
test('a resident saving for its next village still grows its land a tile at a time', () => {
  const m = createResidentMemory(0);
  m.ownTiles = [{ p: '129', q: '0', tile: 5 }];
  m.decisions = 4;
  const wide = { targets: [{ p: '129', q: '1', territory: TERR }, { p: '129', q: '0', territory: TERR }], canClaim: false };
  m.ownTiles.push({ p: '129', q: '1', tile: 5 });
  // (ai-early-mine, owner 2026-11-25 22:28 Q-VPR241-1 (b): while it saves for its FIRST wide village, no tile but the
  //  village's own — the growth below is a resident that already has its first wide village)
  assert.equal(decideNext(m, RIM, { homes: [], wide }).name, 'Harvest', 'saving for the first village: no growth tile');
  m.claims = 1;
  const d = decideNext(m, RIM, { homes: [], wide });
  assert.equal(d.name, 'TerritoryClaim');
  assert.equal(d.growth, true);
  // odd decision: harvest (one growth claim every other decision)
  m.decisions = 5;
  assert.equal(decideNext(m, RIM, { homes: [], wide }).name, 'Harvest');
});

// verify-pr206-209: live, 2 of 3 growth claims were refused Insufficient (Custom 21). A tile claim waits for the ore.
test('no tile claim while the ore read is short of the next tile; never the village before its tile', () => {
  const m = createResidentMemory(0);
  m.ownTiles = [{ p: '129', q: '0', tile: 5 }, { p: '129', q: '1', tile: 5 }];
  m.decisions = 4;
  m.claims = 1;   // (its first wide village stands: growth tiles allowed again — owner 22:28 Q-VPR241-1 (b))
  const wide = { targets: [{ p: '129', q: '1', territory: TERR }, { p: '129', q: '0', territory: TERR }], canClaim: false, ore: 9 };
  assert.equal(decideNext(m, RIM, { homes: [], wide }).name, 'Harvest');
  // (ai-ore-reserve, owner 2026-11-25 09:33: the tile's 10 ore AND one training batch's 20 behind it)
  assert.equal(decideNext(m, RIM, { homes: [], wide: { ...wide, ore: 10 } }).name, 'Harvest');
  assert.equal(decideNext(m, RIM, { homes: [], wide: { ...wide, ore: 29 } }).name, 'Harvest');
  assert.equal(decideNext(m, RIM, { homes: [], wide: { ...wide, ore: 30 } }).name, 'TerritoryClaim');
  // a site's tile not owned and no ore: the village claim is NOT sent (it would be refused NotOwner)
  const m2 = createResidentMemory(0);
  const d = decideNext(m2, RIM, { homes: [], wide: { targets: [{ p: '129', q: '0', territory: TERR }], canClaim: true, ore: 0 } });
  assert.equal(d.name, 'Harvest');
});
