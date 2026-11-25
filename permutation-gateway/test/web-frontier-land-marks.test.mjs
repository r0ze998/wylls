// The land preview on the map and in the selection (TEST-ONLY worlds with --world-option land-preview-v1): a change of
// owner in a province far from the viewer's villages is drawn (the land4 world of 2026-11-15 took 3 tiles of (4,-2) and
// the page showed nothing). The records below are the land4 evidence of (4,-2) (owners and counts as the herald served
// them at bells 27, 129, 130, 136), rebuilt as bytes. Keyless; no world, no chain.
import test from 'node:test';
import assert from 'node:assert/strict';
import { LAND, RULE, parseLand, landTile, landTileLines } from '../../permutation-server/web/frontier/land.mjs';
import { landMarks, landMarksKey, paintLandMarks, runAlong } from '../../permutation-server/web/frontier/map/landmarks.mjs';
import { recordLands } from '../../permutation-server/web/frontier/map/fmap.mjs';
import { inspectModel, render as renderInspect } from '../../permutation-server/web/frontier/hud/inspect.mjs';
import { buildSurvey, anchorsOf } from '../../permutation-server/web/frontier/map/survey.mjs';
import { tileHex } from '../../permutation-server/web/frontier/fgeo.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';

const BANNED_EN = /\bsettle(d|s)?\b|settlement|keeper|beacon|\bseed\b|\bbell \d|secret|lamport|site ticket/i;
const SEASON = 11n;
const OWNERS = {
  27: '................55......55......5............................',
  130: '................50......00......5............................',
};
/** A land record of (p, q) as the herald carries it: owners (61 chars), counts {tile: [by, turns]}. */
function envLand(owners, counts = {}, { p = 4, q = -2, bell = 1, village = [] } = {}) {
  const b = new Uint8Array(LAND.SIZE), dv = new DataView(b.buffer);
  [...LAND.MAGIC].forEach((c, i) => (b[i] = c.charCodeAt(0)));
  dv.setBigUint64(LAND.SEASON_ID, SEASON, true); dv.setUint16(LAND.VERSION, 1, true); dv.setUint32(LAND.NEXT_BELL, bell, true);
  let vm = 0n; for (const t of village) vm |= 1n << BigInt(t); dv.setBigUint64(LAND.VILLAGE, vm, true);
  dv.setInt16(LAND.P, p, true); dv.setInt16(LAND.Q, q, true);
  [...owners].forEach((c, t) => (b[LAND.OWNER + t] = c === '.' ? 255 : Number(c)));
  b.fill(255, LAND.BY, LAND.BY + LAND.TILES);
  for (const [t, [by, n]] of Object.entries(counts)) { b[LAND.BY + Number(t)] = by; b[LAND.COUNT + Number(t)] = n; }
  return { key: `ld:${p},${q}`, bytes: Buffer.from(b).toString('base64') };
}
const parsed = (owners, counts, o = {}) => parseLand(envLand(owners, counts, o), { p: o.p ?? 4, q: o.q ?? -2, seasonId: SEASON });
// A's host stood on tile 25 of (4,-2): sight 2 around it (map/survey.mjs SIGHT.host)
const sight = buildSurvey({ ringsOpen: 5, anchors: anchorsOf({ hosts: [{ p: 4, q: -2, tile: 25, unit: 0 }] }) });
const levelAt = (p, q, idx) => sight.levelOf(p, q, idx);

test('the record carries the counts; a tile says who holds it and how far a take or a fade has come', () => {
  const before = parsed(OWNERS[27], { 25: [0, 71] }, { bell: 129 });
  assert.deepEqual(before.by.slice(24, 27), [255, 0, 255]);
  assert.equal(before.count[25], 71);
  assert.deepEqual(landTile(before, 25), { owner: 5, village: false, claimed: true, count: { kind: 'take', by: 0, turns: 71, of: RULE.SEIZE } });
  assert.deepEqual(landTile(before, 0), { owner: null, village: false, claimed: false, count: null });
  const after = parsed(OWNERS[130], { 32: [5, 7] }, { bell: 136 });
  assert.equal(landTile(after, 25).owner, 0, 'tile 25 became Aster\'s');
  assert.deepEqual(landTile(after, 32).count, { kind: 'fade', by: 5, turns: 7, of: RULE.FRAY }, 'a cut-off tile counts its own fade');
  assert.deepEqual(RULE, { STAND: 6, SEIZE: 72, FRAY: 36 }, 'the build\'s numbers (the launcher checks 6/72/36)');
  assert.equal(landTile(null, 3), null);
});

test('the selection says it in plain English, without the machinery words', () => {
  setLang('en');
  const names = ['Aster', 'Borealis', 'Cinder', 'Dunmar', 'Ember', 'Fjordal'], nameOf = f => names[f];
  const before = parsed(OWNERS[27], { 25: [0, 71] });
  const a = landTileLines(landTile(before, 25), { viewer: 0, nameOf }).map(x => x.text);
  assert.deepEqual(a, ['Land held by Fjordal (fields trial)', 'Your nation is taking it: turn 71 of 72']);
  const b = landTileLines(landTile(before, 25), { viewer: 5, nameOf });
  assert.equal(b[1].text, 'Aster is taking it: turn 71 of 72'); assert.equal(b[1].tone, 'bad', 'the holder sees its land being taken');
  const after = parsed(OWNERS[130], { 32: [5, 7] });
  assert.deepEqual(landTileLines(landTile(after, 25), { viewer: 0, nameOf }).map(x => [x.text, x.tone]), [['Your nation\'s land (fields trial)', 'you']]);
  assert.equal(landTileLines(landTile(after, 32), { viewer: 0, nameOf })[1].text, 'Cut off from its nation\'s land, fading: turn 7 of 36');
  assert.equal(landTileLines(landTile(after, 0), { viewer: 0, nameOf })[0].text, 'Open ground, no nation\'s land (fields trial)');
  const v = parsed('0' + '.'.repeat(60), {}, { village: [0] });
  assert.equal(landTileLines(landTile(v, 0), { viewer: 0, nameOf })[0].text, 'Village land of your nation (fields trial)');
  for (const l of [...a, ...b.map(x => x.text)]) assert.doesNotMatch(l, BANNED_EN);
  setLang('ja');
});

test('the map marks the holder of each tile in sight, and the take changes what it draws', () => {
  const before = landMarks([{ p: 4, q: -2, land: parsed(OWNERS[27], { 25: [0, 71] }) }], { levelAt });
  const after = landMarks([{ p: 4, q: -2, land: parsed(OWNERS[130], { 32: [5, 1] }) }], { levelAt });
  const at = (m, idx) => m.tiles.find(t => t.idx === idx);
  assert.deepEqual([16, 17, 24, 25, 32].map(i => at(before, i)?.owner), [5, 5, 5, 5, 5]);
  assert.deepEqual([16, 17, 24, 25, 32].map(i => at(after, i)?.owner), [5, 0, 0, 0, 5]);
  assert.equal(at(before, 25).count.kind, 'take');
  assert.equal(at(after, 32).count.kind, 'fade');
  assert.notEqual(landMarksKey(before), landMarksKey(after), 'a kept layer is painted again after the take');
  const h = tileHex(4, -2, 24);
  assert.equal(after.owners.get(`${h.q},${h.r}`), 0);
  // out of sight: nothing (current ownership only where the viewer sees now)
  const far = buildSurvey({ ringsOpen: 5, anchors: [] });
  assert.equal(landMarks([{ p: 4, q: -2, land: parsed(OWNERS[130]) }], { levelAt: (p, q, i) => far.levelOf(p, q, i) }).tiles.length, 0);
  assert.equal(landMarks([{ p: 4, q: -2, land: null }]).tiles.length, 0, 'no record: nothing');
});

test('the painter fills, lines the holder\'s edge in its colour and draws the count\'s arc', () => {
  const calls = [];
  const g = new Proxy({}, { get: (o, k) => (k in o ? o[k] : typeof k === 'string' && /^[a-z]/i.test(k) ? (...args) => { calls.push([k, args.length]); } : undefined), set: (o, k, v) => { o[k] = v; if (k === 'strokeStyle' || k === 'fillStyle') calls.push([k, v]); return true; } });
  const marks = landMarks([{ p: 4, q: -2, land: parsed(OWNERS[130], { 32: [5, 1] }) }], { levelAt });
  paintLandMarks(g, marks, { zoom: 0.8, viewer: 0 });
  const styles = calls.filter(c => c[0] === 'strokeStyle' || c[0] === 'fillStyle').map(c => c[1]);
  assert.ok(calls.some(c => c[0] === 'fill') && calls.some(c => c[0] === 'stroke'));
  assert.ok(calls.some(c => c[0] === 'clip'), 'another nation\'s land is hatched (clipped to the tile)');
  assert.ok(styles.includes('#c9c3b4'), 'a fade is grey');
  paintLandMarks(null, marks); paintLandMarks(g, { tiles: [], owners: new Map() });
  // village land is the villages' own painters': nothing is filled or lined for it here
  const vcalls = []; const vg = new Proxy({}, { get: (o, k) => (k in o ? o[k] : typeof k === 'string' && /^[a-z]/i.test(k) ? (...a) => { vcalls.push(k); } : undefined), set: (o, k, v) => { o[k] = v; return true; } });
  const home = landMarks([{ p: 4, q: -2, land: parsed('.'.repeat(24) + '0' + '.'.repeat(36), {}, { village: [24] }) }], { levelAt });
  assert.equal(home.tiles.length, 1); assert.equal(home.tiles[0].village, true);
  paintLandMarks(vg, home, { viewer: 0 });
  assert.ok(!vcalls.includes('fill') && !vcalls.includes('stroke'), 'a village tile alone draws nothing');
});

test('a count runs round the tile\'s edge from its top corner, as far as the turns have come', () => {
  const sq = [[0, 0], [10, 0], [10, 10], [0, 10]];
  assert.deepEqual(runAlong(sq, 0), []);
  assert.deepEqual(runAlong(sq, 0.5), [[0, 0], [10, 0], [10, 10]]);
  assert.deepEqual(runAlong(sq, 1).at(-1), [0, 0], 'a full count closes the ring');
  assert.deepEqual(runAlong(sq, 0.125), [[0, 0], [5, 0]]);
});

test('the viewer\'s land far from its villages is outlined as land of its own (land4: (4,-2) is two provinces from home)', () => {
  const FSland = new Map([['4,-2', parsed(OWNERS[130])]]);
  const src = { landOf: (p, q) => FSland.get(`${p},${q}`) ?? null };
  const villages = [{ p: 2, q: 0, tile: 30, state: 2 }];
  const survey = { faction: 0 };
  assert.equal(recordLands(src, survey, villages), null, 'only home and its neighbours read: nothing (the land4 picture)');
  const lands = recordLands(src, survey, villages, ['4,-2']);
  assert.equal(lands.length, 1);
  assert.equal(lands[0].key, 'land:4,-2'); assert.equal(lands[0].village, null);
  assert.equal(lands[0].tiles.length, 3, 'the three tiles Aster took');
  // a record near home still goes to the nearest village, as before
  FSland.set('2,0', parsed('.'.repeat(31) + '0' + '.'.repeat(29), {}, { p: 2, q: 0 }));
  const both = recordLands(src, survey, villages, ['4,-2', '2,0']);
  assert.deepEqual(both.map(l => l.key).sort(), ['2,0,30', 'land:4,-2']);
});

test('the selection carries the land line only for a tile in sight', () => {
  setLang('en');
  const land = parsed(OWNERS[130], { 32: [5, 1] });
  const province = { p: 4, q: -2, sites: [], entries: [], siteMirror: [], relations: 0n };
  const FS = { mode: 'play', citizen: { faction: 0 }, holdings: [], nowBell: 130, survey: sight, overviews: new Map(), provinces: new Map([['4,-2', { province, land }]]), selected: { p: 4, q: -2, idx: 25 } };
  const terrainOf = () => ({ terrain: Array(61).fill(0), names: ['Grassland'], sites: [] });
  const m = inspectModel(FS, terrainOf);
  assert.deepEqual(m.tile.land, { owner: 0, village: false, claimed: true, count: null });
  assert.match(String(renderInspect(FS, terrainOf)), /Your nation&#39;s land \(fields trial\)|Your nation's land \(fields trial\)/);
  FS.selected = { p: 4, q: -2, idx: 60 };
  assert.equal(inspectModel(FS, terrainOf).tile?.land, undefined, 'out of sight: no owner is said');
  setLang('ja');
});
