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
