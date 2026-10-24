// The ore an S1 village takes from the land around it (map/orefield.mjs), against
// permutation-rules arms.rs: the constants are read from the source, and the model
// reckons the tiles as `terrain_ore_per_hour` does.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ORE, oreField, fieldMatches, oreTagText, paintOreField, paintOreGround } from '../../permutation-server/web/frontier/map/orefield.mjs';
import { TILE_OFFSETS, hexDistance } from '../../permutation-server/web/frontier/fgeo.mjs';

const rs = readFileSync(new URL('../../permutation-rules/src/frontier/arms.rs', import.meta.url), 'utf8');
const num = name => Number(rs.match(new RegExp(`pub const ${name}: \\w+ = (\\d+);`))?.[1]);

test('the constants are the rules\' own', () => {
  assert.deepEqual(ORE, { base: num('ORE_BASE_PER_HOUR'), hills: num('ORE_PER_HILLS'), mountain: num('ORE_PER_MOUNTAIN'), iron: num('ORE_PER_IRON'), radius: num('ORE_RADIUS'), cap: num('ORE_TERRAIN_MAX') });
});

// a province of grassland (0) with hills (3), a mountain (4) and an iron resource (1) placed around tile 30, the centre
const at = (dq, dr) => TILE_OFFSETS.findIndex(o => o.q === dq && o.r === dr);
const land = (put = {}) => {
  const terrain = Array(61).fill(0), resource = Array(61).fill(null);
  for (const [i, t] of Object.entries(put.terrain ?? {})) terrain[i] = t;
  for (const [i, r] of Object.entries(put.resource ?? {})) resource[i] = r;
  return { terrain, resource };
};

test('base, hills, a mountain and iron within the radius; nothing beyond it, nothing for the village\'s own tile', () => {
  const c = at(0, 0), L = land({ terrain: { [at(1, 0)]: 3, [at(0, 2)]: 4, [at(3, 0)]: 4, [c]: 4 }, resource: { [at(-1, 1)]: 1, [at(1, 0)]: 1 } });
  const f = oreField(L, c);
  assert.equal(f.perHour, ORE.base + ORE.hills + ORE.iron + ORE.mountain + ORE.iron);
  assert.deepEqual(f.counts, { hills: 1, mountain: 1, iron: 2 });
  assert.ok(f.tiles.every(t => hexDistance(TILE_OFFSETS[t.idx].q, TILE_OFFSETS[t.idx].r, 0, 0) <= ORE.radius && t.idx !== c));
  assert.equal(f.tiles.find(t => t.idx === at(1, 0)).ore, ORE.hills + ORE.iron);
  assert.equal(f.capped, false);
});

test('the terrain part is capped, and the tag says so; the record is matched exactly', () => {
  const c = at(0, 0), hills = {};
  for (const [i, o] of TILE_OFFSETS.entries()) if (i !== c && hexDistance(o.q, o.r, 0, 0) <= 2) hills[i] = 3;
  const f = oreField(land({ terrain: hills }), c);
  assert.equal(f.extra, 18 * ORE.hills);
  assert.equal(f.capped, true);
  assert.equal(f.perHour, ORE.base + ORE.cap);
  assert.ok(fieldMatches(f, String((ORE.base + ORE.cap) * 1000)));
  assert.ok(!fieldMatches(f, 33000));
  assert.match(oreTagText(f, 34000), /地形の鉱石 \+34\/時（丘 18 · 上限 30）/);
});

test('a tile at the province\'s edge counts only the province\'s own tiles; no terrain, no field', () => {
  const edge = at(4, 0);
  const f = oreField(land({ terrain: Object.fromEntries(TILE_OFFSETS.map((o, i) => [i, 3])) }), edge);
  assert.equal(f.tiles.length, TILE_OFFSETS.filter((o, i) => i !== edge && hexDistance(o.q, o.r, 4, 0) <= 2).length);
  assert.equal(oreField(null, 30), null);
  assert.equal(oreField(land(), 99), null);
});

test('the painters tolerate an inert context and an empty field', () => {
  const inert = new Proxy({}, { get: (t, k) => (k === 'measureText' ? () => ({ width: 10 }) : k === 'save' || k === 'restore' ? () => {} : () => {}) });
  const f = oreField(land({ terrain: { [at(1, 0)]: 3 } }), at(0, 0));
  assert.doesNotThrow(() => paintOreGround(inert, { p: 0, q: 0, field: f }));
  assert.doesNotThrow(() => paintOreField(inert, { p: 0, q: 0, tile: at(0, 0), field: f, terrainOre: 6000 }));
  assert.equal(paintOreField(inert, { p: 0, q: 0, tile: 30, field: { tiles: [] } }), null);
});
