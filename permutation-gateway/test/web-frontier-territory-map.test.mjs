// territory-map (owner decisions 2026-11-25 09:33 JST, inbox 2026-11-25-0933-r0ze-no-rec-items-decided.md):
//   item 5  Q-LP15-2 (b) / T-9 / OQ-1  own tiles drawn, the border follows the tiles tile by tile;
//   item 6  OQ-3                       only owned tiles coloured; province control = the keep's icon;
//   item 3  Q-LP15-3 (b) / Q-W13T-2 (b) the viewer's own tiles are always in view (the tile itself).
// Pure modules only (map/territorytiles.mjs, map/widelegend.mjs, map/survey.mjs) plus source pins of the page's wiring.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  territoryOwners, tagNations, territoryCandidates, mountTerritoryTiles, ownTileAnchors, territoryLand, paintTerritoryTiles, paintFarKeeps,
  TERRITORY_PROVINCE_BYTES, OWNERS_AT, TERRITORY_READ_MAX, TERRITORY_READ_SCHEMA, NOBODY, UNKNOWN_NATION, UNKNOWN_LAND, TILE_LOOK, CLAIM_REACH,
} from '../../permutation-server/web/frontier/map/territorytiles.mjs';
import { landOfCells, villageOwner, paintWideLand } from '../../permutation-server/web/frontier/map/wideland.mjs';
import { territoryLegendRows, mountWideLegend } from '../../permutation-server/web/frontier/map/widelegend.mjs';
import { buildSurvey, anchorsOf, L3 } from '../../permutation-server/web/frontier/map/survey.mjs';
import { provincePixel, PROVINCE_CIRCUMRADIUS } from '../../permutation-server/web/frontier/map/layers.mjs';
import { tileHex, TILE_OFFSETS } from '../../permutation-server/web/frontier/fgeo.mjs';
import { NATION_LAND, NATION_DARK } from '../../permutation-server/web/frontier/palette.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';

const VIEWER = 3, ASTER = 0, CINDER = 2;
const ME = '1111', ASTER_TAG = '2222', CINDER_TAG = '3333', STRANGER = '4444';
const ALL = { x0: -1e9, y0: -1e9, x1: 1e9, y1: 1e9 };
const src = p => readFileSync(new URL(`../../permutation-server/web/frontier/${p}`, import.meta.url), 'utf8');

/** A territory province record (672 B): magic, owners @104 (61 × u64 LE). */
function record(owners) {
  const b = new Uint8Array(TERRITORY_PROVINCE_BYTES), dv = new DataView(b.buffer);
  b.set([...'PSFXWTN1'].map(c => c.charCodeAt(0)), 0);
  owners.forEach((t, i) => { if (t) dv.setBigUint64(OWNERS_AT + 8 * i, BigInt(t), true); });
  return b;
}
const ownersOf = map => { const o = Array(61).fill(null); for (const [i, t] of Object.entries(map)) o[Number(i)] = t; return o; };
const cell = (p, q, extra = {}) => {
  const c = provincePixel(p, q), r = PROVINCE_CIRCUMRADIUS;
  return { p, q, key: `${p},${q}`, ring: 200, wedge: 0, holder: null, villages: [], owners: [], terrain: null, keep: null, hosts: [], territory: { siteTiles: [], keepTile: 0 },
    colour: '#c8bb98', x: c.x, y: c.y, box: { x0: c.x - r, y0: c.y - r, x1: c.x + r, y1: c.y + r }, ...extra };
};
const landOf = cells => landOfCells(cells, { rings: { min: 200, max: 200 }, reach: 201 });
function recorder() {
  const log = { fills: [], marks: 0 };
  const ctx = new Proxy({ globalAlpha: 1 }, {
    get: (t, k) => {
      if (k in t) return t[k];
      if (k === 'fill') return () => log.fills.push({ style: t.fillStyle, alpha: t.globalAlpha });
      if (k === 'measureText') return () => ({ width: 40 });
      if (/Gradient|Pattern/.test(k)) return () => ({ addColorStop() {} });
      return () => {};
    },
    set: (t, k, v) => { t[k] = v; return true; },
  });
  return { ctx, log };
}
// the tile at hex offset (dq, dr) from a province's centre (tile 30, the centre: TILE_OFFSETS are sorted by q then r)
const tileAt = (dq, dr) => TILE_OFFSETS.findIndex(o => o.q === dq && o.r === dr);
const C = tileAt(0, 0), E = tileAt(1, 0);

test('a territory province record is read as the program writes it: 61 Citizen tags at 104, 0 = nobody; anything else is no record', () => {
  const o = territoryOwners(record(ownersOf({ 0: ME, 5: ASTER_TAG, 60: '18446744073709551615' })));
  assert.equal(o.length, 61);
  assert.deepEqual([o[0], o[5], o[60], o[1]], [ME, ASTER_TAG, '18446744073709551615', null]);
  assert.equal(territoryOwners(new Uint8Array(671)), null);
  const bad = record([]); bad[0] = 0x51;
  assert.equal(territoryOwners(bad), null, 'wrong magic');
  // (frontier-abi world_index/territory.rs TerritoryProvince: OWNER @104 "[u64;61]", size 672)
  const rs = readFileSync(new URL('../../frontier-abi/src/world_index/territory.rs', import.meta.url), 'utf8');
  assert.match(rs, /OWNER @ 104 : "\[u64;61\]" = 488;/);
  assert.match(rs, /\| \[`TerritoryProvince`\] \| 672 \|/);
});

test('whose nation a tag is: the wide villages\' owners, the roster with the overview\'s site owner, and the viewer — never guessed', () => {
  // a wide holding capture: 1,344 B, OWNER_CITIZEN @72 (the tag is its first 8 bytes LE), FACTION @112
  const h = new Uint8Array(1344); new DataView(h.buffer).setBigUint64(72, 2222n, true); h[112] = ASTER;
  assert.deepEqual(villageOwner({ capture: { bytes_b64: Buffer.from(h).toString('base64') } }), { tag: ASTER_TAG, nation: ASTER });
  assert.equal(villageOwner({ capture: { bytes_b64: Buffer.from(h.subarray(0, 1280)).toString('base64') } }), null);
  h[112] = 7;
  assert.equal(villageOwner({ capture: { bytes_b64: Buffer.from(h).toString('base64') } }), null, 'no nation');
  const map = tagNations({ cells: [cell(0, 0, { owners: [{ tag: ASTER_TAG, nation: ASTER }] })], roster: [{ p: 1, q: 1, site: 4, tag: 3333n }, { p: 9, q: 9, site: 0, tag: 4444n }],
    siteNation: (p, q, site) => (p === 1 && site === 4 ? CINDER : null), own: { tag: ME, nation: VIEWER } });
  assert.deepEqual([...map].sort(), [[ME, VIEWER], [ASTER_TAG, ASTER], [CINDER_TAG, CINDER]].sort());
  assert.equal(map.has(STRANGER), false, 'a roster tag whose site has no known owner is not named');
});

test('which provinces are read: the viewer\'s tiles first, then its reach (3 provinces), then the land in sight; at most `max`', () => {
  const cells = [cell(0, 0), cell(1, 0), cell(3, 0), cell(4, 0), cell(9, 0), cell(12, 0), cell(20, 0, { territory: null })];
  assert.equal(CLAIM_REACH, 3);
  const keys = territoryCandidates({ cells, ownAt: ['9,0'], anchors: [{ p: 0, q: 0 }], sight: c => c.p === 20 || c.p === 12 });
  // (own first; then the reach — 3 provinces — of the village and of the own province, nearest first: 12,0 is 3 from 9,0;
  //  4,0 is 4 from 0,0 and 5 from 9,0, out of reach and not in sight)
  assert.deepEqual(keys, ['9,0', '0,0', '1,0', '12,0', '3,0']);
  assert.ok(!keys.includes('20,0'), 'a province without territory has no record');
  assert.deepEqual(territoryCandidates({ cells, ownAt: [], anchors: [], sight: null }), [], 'pre-join: nothing');
  assert.equal(territoryCandidates({ cells, ownAt: [], anchors: [{ p: 0, q: 0 }], sight: () => true, max: 2 }).length, 2);
});

test('the reader: batches of at most 16 through the relay\'s read-only account read; a change tells the map once; a failed read keeps the last answer', async () => {
  const keys = Array.from({ length: 20 }, (_, i) => `${i},0`);
  let answer = new Map([['0,0', record(ownersOf({ 1: ME }))], ['17,0', record(ownersOf({ 2: ASTER_TAG }))]]);
  const asked = [];
  let fail = false, changes = 0;
  const timers = [];
  const r = mountTerritoryTiles({
    reads: () => ({ ownTag: ME, province: (p, q) => `A${p},${q}`, read: async addrs => { asked.push(addrs.length); if (fail) throw new Error('relay down'); return addrs.map(a => answer.get(a.slice(1)) ?? null); } }),
    candidates: () => keys, onChange: () => changes++, setTimer: (f) => { timers.push(f); return timers.length; }, clearTimer: () => {},
  });
  const step = async () => { const f = timers.shift(); await f(); };
  await step();
  assert.deepEqual(asked, [16, 4]);
  assert.equal(TERRITORY_READ_MAX, 16);
  let s = r.now();
  assert.deepEqual([...s.owners.keys()].sort(), ['0,0', '17,0']);
  assert.deepEqual(s.ownAt, ['0,0']);
  assert.equal(changes, 1);
  await step();
  assert.equal(changes, 1, 'the same land: the map is not told again');
  answer.set('5,0', record(ownersOf({ 3: ME })));
  await step();
  assert.equal(changes, 2);
  assert.deepEqual(r.now().ownAt, ['0,0', '5,0'], 'a new claim appears');
  fail = true;
  await step();
  assert.equal(r.now().owners.size, 3, 'the relay did not answer: the last answer stays');
  r.stop();
  assert.equal(TERRITORY_READ_SCHEMA, 'frontier-local-play-act-wide-read-v1');
});

test('decision 3: each of the viewer\'s own tiles is in sight (the tile itself, radius 0) — fog or not; its neighbours are not lifted', () => {
  const owners = new Map([['0,0', ownersOf({ [C]: ME, [tileAt(0, 1)]: ASTER_TAG })]]);
  const a = ownTileAnchors(owners, ME);
  assert.deepEqual(a.map(x => [x.radius, x.level, x.kind]), [[0, L3, 'own-tile']]);
  const t0 = tileHex(0, 0, C);
  assert.deepEqual([a[0].q, a[0].r], [t0.q, t0.r]);
  const survey = buildSurvey({ ringsOpen: 2, anchors: anchorsOf({ extraAnchors: a }) });
  assert.equal(survey.levelOf(0, 0, C), L3, 'the own tile is in view');
  assert.ok(survey.levelOf(0, 0, E) < L3, 'a neighbouring tile stays fogged');
  assert.ok(survey.levelOf(0, 0, tileAt(0, 1)) < L3, 'another player\'s tile beside it is not lifted by it');
  assert.deepEqual(ownTileAnchors(owners, null), []);
  // the page: its survey's extra anchors carry them, and a new read is a new survey
  const app = src('app.mjs');
  assert.match(app, /extraAnchors: \[\.\.\.nationAnchors\(src\), \.\.\.ownTileAnchors\(t\?\.owners, t\?\.ownTag\)\]/);
  assert.ok(app.includes('if (fog) deps.push(territoryRef?.now?.().rev ?? 0);'));
});

test('fog: the viewer\'s own tiles always shown; another player\'s only while the tile is in sight; none before the first village', () => {
  const land = landOf([cell(0, 0), cell(1, 0)]);
  const owners = new Map([['0,0', ownersOf({ 0: ME, 1: ASTER_TAG, 2: STRANGER })], ['1,0', ownersOf({ 0: CINDER_TAG })]]);
  const tagNation = new Map([[ASTER_TAG, ASTER], [CINDER_TAG, CINDER]]);
  const inSight = (p, q, t) => p === 0 && t === 1;
  const fog = territoryLand(land, { owners, tagNation, ownTag: ME, viewer: VIEWER, fogged: true, seen: inSight });
  const c0 = fog.byKey.get('0,0');
  assert.deepEqual([c0.tiles[0], c0.tiles[1], c0.tiles[2]], [VIEWER, ASTER, NOBODY], 'the stranger\'s tile is out of sight');
  assert.deepEqual(c0.mine, [0]);
  assert.equal(fog.byKey.get('1,0').tiles, undefined, 'a province with nothing shown is passed as it is');
  assert.deepEqual(fog.territory, { tiles: 2, mine: 1, nations: [ASTER, VIEWER] });
  // all in sight: an unknown nation's tiles are its own grey, never a guessed nation
  const open = territoryLand(land, { owners, tagNation, ownTag: ME, viewer: VIEWER, fogged: true, seen: () => true });
  assert.equal(open.byKey.get('0,0').tiles[2], UNKNOWN_NATION);
  assert.deepEqual(open.territory.nations, [ASTER, CINDER, VIEWER, UNKNOWN_NATION]);
  // a fogged page with no village yet (no vision): only the viewer's own
  const pre = territoryLand(land, { owners, tagNation, ownTag: ME, viewer: VIEWER, fogged: false, hidden: true });
  assert.deepEqual(pre.territory, { tiles: 1, mine: 1, nations: [VIEWER] });
  assert.equal(territoryLand(land, { owners: new Map() }), land, 'nothing read: the land as it is');
});

test('the border follows the tiles tile by tile: a side is rim where the next tile is not the same nation\'s, across provinces too', () => {
  const land = landOf([cell(0, 0)]);
  const one = territoryLand(land, { owners: new Map([['0,0', ownersOf({ [C]: ME })]]), ownTag: ME, viewer: VIEWER });
  assert.equal(one.byKey.get('0,0').geo[0].rim.length, 6, 'one tile: its six sides');
  const two = territoryLand(land, { owners: new Map([['0,0', ownersOf({ [C]: ME, [E]: ME })]]), ownTag: ME, viewer: VIEWER });
  assert.deepEqual(two.byKey.get('0,0').geo.map(g => g.rim.length), [5, 5], 'two tiles side by side: the shared side is no border');
  // a neighbour of another nation: both carry the side (each its own colour inside its own tile)
  const mixed = territoryLand(land, { owners: new Map([['0,0', ownersOf({ [C]: ME, [E]: ASTER_TAG })]]), tagNation: new Map([[ASTER_TAG, ASTER]]), ownTag: ME, viewer: VIEWER, fogged: false });
  assert.deepEqual(mixed.byKey.get('0,0').geo.map(g => [g.nation, g.rim.length]).sort(), [[ASTER, 6], [VIEWER, 6]]);
  // growth, tile by tile: a third tile in a row — the border moves out, the middle tile keeps only its two open sides
  const three = territoryLand(land, { owners: new Map([['0,0', ownersOf({ [tileAt(-1, 0)]: ME, [C]: ME, [E]: ME })]]), ownTag: ME, viewer: VIEWER });
  assert.deepEqual(three.byKey.get('0,0').geo.map(g => g.rim.length), [5, 4, 5]);
  // across a province edge: the rim tile of province (0, 0) next to the rim tile of province (1, 0)
  const land2 = landOf([cell(0, 0), cell(1, 0)]);
  let pair = null;
  for (let i = 0; i < 61 && !pair; i++) for (let j = 0; j < 61; j++) {
    const a = tileHex(0, 0, i), b = tileHex(1, 0, j);
    if (Math.abs(a.q - b.q) + Math.abs(a.r - b.r) + Math.abs(a.q + a.r - b.q - b.r) === 2) { pair = [i, j]; break; }
  }
  const across = territoryLand(land2, { owners: new Map([['0,0', ownersOf({ [pair[0]]: ME })], ['1,0', ownersOf({ [pair[1]]: ME })]]), ownTag: ME, viewer: VIEWER });
  assert.equal(across.byKey.get('0,0').geo[0].rim.length, 5);
  assert.equal(across.byKey.get('1,0').geo[0].rim.length, 5, 'one border round both, across the province edge');
});

test('painted: each owned tile in its nation\'s land colour, the border band and a dark seam near, the wash only from far; under the villages\' marks', () => {
  const land = territoryLand(landOf([cell(0, 0)]), { owners: new Map([['0,0', ownersOf({ [C]: ME, [E]: ME, 0: ASTER_TAG })]]), tagNation: new Map([[ASTER_TAG, ASTER]]), ownTag: ME, viewer: VIEWER });
  const near = recorder();
  const t = paintTerritoryTiles(near.ctx, land, { seen: ALL, zoom: 1, level: 'tile' });
  assert.deepEqual([t.tiles, t.mine, t.nations], [3, 2, [ASTER, VIEWER]]);
  const styles = near.log.fills.map(f => [f.style, f.alpha]);
  for (const n of [ASTER, VIEWER]) {
    assert.ok(styles.some(([s, a]) => s === NATION_LAND[n] && a === TILE_LOOK.tile.wash), 'the wash');
    assert.ok(styles.some(([s, a]) => s === NATION_LAND[n] && a === 1), 'the band');
    assert.ok(styles.some(([s]) => s === NATION_DARK[n]), 'the seam');
  }
  const far = recorder();
  paintTerritoryTiles(far.ctx, land, { seen: ALL, zoom: 0.01, level: 'world' });
  assert.ok(far.log.fills.every(f => f.alpha === TILE_LOOK.world.wash), 'from far: the wash only');
  assert.equal(paintTerritoryTiles(far.ctx, land, { seen: { x0: 1e8, y0: 1e8, x1: 1e8 + 1, y1: 1e8 + 1 }, zoom: 1, level: 'tile' }).tiles, 0, 'out of view: nothing');
  // the legend's nations are those whose tiles stand in the picture
  const c = land.byKey.get('0,0');
  const g30 = c.geo.find(g => g.tile === 0);
  const box = [{ x: g30.x - 5, y: g30.y - 5 }, { x: g30.x + 5, y: g30.y - 5 }, { x: g30.x + 5, y: g30.y + 5 }, { x: g30.x - 5, y: g30.y + 5 }];
  assert.deepEqual(paintTerritoryTiles(recorder().ctx, land, { seen: ALL, zoom: 1, level: 'tile', view: box }).nations, [ASTER]);
  // wideland calls it over the land, before the villages' marks (paintWideLand `overLand`)
  const order = [];
  paintWideLand(recorder().ctx, land, { seen: ALL, zoom: 0.01, level: 'world', overLand: () => { order.push('tiles'); return { nations: [] }; } });
  assert.deepEqual(order, ['tiles']);
  const wl = src('map/wideland.mjs');
  assert.ok(wl.indexOf('const territory = overLand ? overLand(ctx) : null;\n    const villages = paintVillageMarks') > 0);
});

test('decision 6: a province is never coloured by its keep — the keep\'s icon in its holder\'s colour says who holds it, from far too', () => {
  const land = landOf([cell(0, 0, { holder: ASTER, keep: { tile: 30, holder: ASTER } }), cell(1, 0, { holder: 6, keep: { tile: 30, holder: 6 } }), cell(2, 0, { holder: CINDER, holderKnown: false, keep: { tile: 30, holder: CINDER } })]);
  const { ctx, log } = recorder();
  const out = paintWideLand(ctx, land, { seen: ALL, zoom: 0.5, level: 'province' });
  assert.ok(!log.fills.some(f => Object.values(NATION_LAND).includes(f.style)), 'no nation colour on any province');
  assert.deepEqual(out.borders, []);
  assert.equal(paintFarKeeps(recorder().ctx, land, { seen: ALL, zoom: 0.01, level: 'world', viewer: VIEWER }), 1, 'Aster\'s keep only: not a neutral keep, not one whose holder the fog does not know');
  assert.equal(paintFarKeeps(recorder().ctx, land, { seen: ALL, zoom: 1, level: 'tile' }), 0, 'nearer, map/widemarks.mjs draws the keep');
  const fmap = src('map/fmap.mjs');
  assert.match(fmap, /paintFarKeeps\(ctx, wideLand, \{ seen, zoom: z, level: wideLevel\(lod, coarse\)/);
});

test('the key: the nations whose tiles are in the picture, a player of unknown nation, and what the keep\'s colour means — English and Japanese, no "season"', () => {
  setLang('en');
  try {
    const rows = territoryLegendRows([UNKNOWN_NATION, ASTER, VIEWER], { viewer: VIEWER, keeps: true });
    assert.deepEqual(rows.map(r => [r.key, r.text]), [['n3', 'Your nation (Dunmar)'], ['n0', 'Aster'], ['unknown', 'A player\'s land (nation not known)'], ['keep', 'Keep colour: the nation holding the province']]);
    for (const r of rows) { assert.doesNotMatch(r.text, /season/i); assert.doesNotMatch(r.text, /[぀-ヿ一-鿿]/); }
    assert.equal(rows[2].colour, UNKNOWN_LAND);
  } finally { setLang('ja'); }
  assert.deepEqual(territoryLegendRows([UNKNOWN_NATION], { keeps: true }).map(r => r.text), ['国のわからないプレイヤーの土地', '城の色：その州を持つ国']);
  assert.deepEqual(territoryLegendRows([], { viewer: VIEWER }), []);
  // the page's box reads `nations` and `keeps`
  const el = tag => { const e = { tag, children: [], attrs: {}, dataset: {}, hidden: false, _t: '', set textContent(x) { e._t = x; if (x === '') e.children = []; }, get textContent() { return e._t; }, setAttribute(k, x) { e.attrs[k] = x; }, append(...xs) { e.children.push(...xs); }, remove() {} }; return e; };
  const lg = mountWideLegend({ doc: { createElement: el, body: el('body'), querySelector: () => null } });
  lg.update({ nations: [VIEWER], keeps: [ASTER] }, VIEWER);
  assert.deepEqual(lg.el.children[1].children.map(li => li.children[0].attrs['data-key']), ['n3', 'keep']);
  const css = src('frontier.css');
  assert.match(css, /\.wide-legend-swatch\[data-key="unknown"\] \{ background: #9a9a92; border-color: #4a4a44; \}/);
  assert.match(css, /\.wide-legend-swatch\[data-key="keep"\]/);
  assert.ok(css.indexOf('.wide-legend-swatch[data-key="keep"]') < css.lastIndexOf('@media'), 'above the film frame\'s block');
});

test('read-only: the page reads the records through the relay\'s account read for a local wide world only; nothing is signed or sent', () => {
  const c = src('controller.mjs');
  const at = c.indexOf('export function territoryMapReads()');
  assert.ok(at > 0);
  const body = c.slice(at, c.indexOf('\n}\n', at));
  assert.match(body, /if \(!localPlay\?\.wideLand/);
  assert.match(body, /schema: TERRITORY_MAP_READ, addresses/);
  assert.doesNotMatch(body, /\bsign|sendTx|\bsend\(|[^l]act\(/i);
  assert.match(c, /const TERRITORY_MAP_READ = 'frontier-local-play-act-wide-read-v1';/);
  const app = src('app.mjs');
  assert.match(app, /if \(cfg\.localPlay && !territoryRef\) try \{ territoryRef = mountTerritoryTiles\(\{ reads: territoryMapReads,/);
  assert.ok(app.includes('if (wideLandRef) { const shown = wideLandRef.land; wideLandRef = { ...wideLandRef, land: () => withTerritory(shown()) }; }'));
});
