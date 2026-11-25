// territory-map-2 (owner decisions 2026-11-25 12:04 JST, inbox 2026-11-25-1204-r0ze-noon-decisions.md item 5):
//   Q-TM-1 (b)  a tile seen before keeps the owner it had when last seen, drawn FADED; never-seen tiles stay hidden;
//   Q-TM-4 (c)  the herald publishes the territory records (GET /h/world/wide/territory); the page (and the MCP reader)
//               read them from there, the relay's account read only as a fallback for a herald without the route.
// Pure modules (map/territorytiles.mjs, flocalplay-territory.mjs, map/widelegend.mjs, herald.mjs with a stand-in fetch)
// plus source pins of the page's wiring.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  heraldTerritoryOwners, mountTerritoryTiles, territoryLand, paintTerritoryTiles, rememberTerritory, rememberedOf, createTerritoryMemory,
  territoryMemoryKey, NOBODY, FADED, TILE_LOOK, TERRITORY_HERALD_PATH, TERRITORY_UNCHANGED,
} from '../../permutation-server/web/frontier/map/territorytiles.mjs';
import { heraldTerritoryRecords } from '../../permutation-server/web/frontier/flocalplay-territory.mjs';
import { fogMemoryKey } from '../../permutation-server/web/frontier/map/fog.mjs';
import { landOfCells } from '../../permutation-server/web/frontier/map/wideland.mjs';
import { territoryLegendRows, mountWideLegend } from '../../permutation-server/web/frontier/map/widelegend.mjs';
import { createHerald } from '../../permutation-server/web/frontier/herald.mjs';
import { provincePixel, PROVINCE_CIRCUMRADIUS } from '../../permutation-server/web/frontier/map/layers.mjs';
import { NATION_LAND } from '../../permutation-server/web/frontier/palette.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';

const VIEWER = 3, ASTER = 0, CINDER = 2;
const ME = '1111', ASTER_TAG = '2222', CINDER_TAG = '3333';
const ALL = { x0: -1e9, y0: -1e9, x1: 1e9, y1: 1e9 };
const src = p => readFileSync(new URL(`../../permutation-server/web/frontier/${p}`, import.meta.url), 'utf8');
const ownersOf = map => { const o = Array(61).fill(null); for (const [i, t] of Object.entries(map)) o[Number(i)] = t; return o; };
const cell = (p, q) => {
  const c = provincePixel(p, q), r = PROVINCE_CIRCUMRADIUS;
  return { p, q, key: `${p},${q}`, ring: 200, wedge: 0, holder: null, villages: [], owners: [], terrain: null, keep: null, hosts: [], territory: { siteTiles: [], keepTile: 0 },
    colour: '#c8bb98', x: c.x, y: c.y, box: { x0: c.x - r, y0: c.y - r, x1: c.x + r, y1: c.y + r } };
};
const landOf = cells => landOfCells(cells, { rings: { min: 200, max: 200 }, reach: 201 });
const tagNation = new Map([[ASTER_TAG, ASTER], [CINDER_TAG, CINDER]]);
/** A storage stand-in (map/survey.mjs browserStorage's shape). */
const store = () => { const m = new Map(); return { m, get: k => m.get(k) ?? null, set: (k, v) => { m.set(k, v); return true; } }; };
/** The herald's answer (herald wide_territory.rs territory_json) for `rows` [{p, q, tiles: {tile: tag}}]. */
function answer(rows, extra = {}) {
  const tags = [];
  const ix = t => { let i = tags.indexOf(t); if (i < 0) { tags.push(t); i = tags.length - 1; } return i; };
  return { v: 1, experimental: true, readOnly: true, verification: 'captured-unverified', season: '7', world: 'ab', program: 'Prog', seasonAddress: 'SeasonA', revision: '3',
    provinces: rows.map(r => ({ p: String(r.p), q: String(r.q), address: 'x', slot: '1', archiveSequence: '1', keepTile: 30, owned: Object.keys(r.tiles).length,
      tiles: Object.entries(r.tiles).map(([i, t]) => [Number(i), ix(t), 2]) })), tags, ...extra };
}
function recorder() {
  const log = { fills: [] };
  const ctx = new Proxy({ globalAlpha: 1 }, {
    get: (t, k) => (k in t ? t[k] : k === 'fill' ? () => log.fills.push({ style: t.fillStyle, alpha: t.globalAlpha }) : () => {}),
    set: (t, k, v) => { t[k] = v; return true; },
  });
  return { ctx, log };
}

test('Q-TM-4: the herald\'s answer decodes to 61 owners per province with the record\'s dist; a wrong pin, tag or tile is no answer', () => {
  const j = answer([{ p: 130, q: 0, tiles: { 3: ASTER_TAG, 60: ME } }, { p: -131, q: 5, tiles: { 0: ME } }]);
  const recs = heraldTerritoryRecords(j, { seasonAddress: 'SeasonA', program: 'Prog' });
  assert.deepEqual([...recs.keys()], ['130,0', '-131,5']);
  const r = recs.get('130,0');
  assert.equal(r.owners.length, 61);
  assert.deepEqual([r.owners[3], r.owners[60], r.owners[4]], [ASTER_TAG, ME, null]);
  assert.deepEqual([r.dist[3], r.dist[4], r.owned, r.keepTile], [2, 0, 2, 30]);
  const owners = heraldTerritoryOwners(j, { seasonAddress: 'SeasonA' });
  assert.deepEqual(owners.get('-131,5'), ownersOf({ 0: ME }));
  assert.equal(heraldTerritoryRecords(j, { seasonAddress: 'OtherSeason' }), null, 'another season\'s answer');
  assert.equal(heraldTerritoryRecords(j, { program: 'Other' }), null);
  assert.equal(heraldTerritoryRecords({ ...j, v: 2 }), null);
  assert.equal(heraldTerritoryRecords({ ...j, tags: ['01'] }), null, 'not a canonical decimal tag');
  assert.equal(heraldTerritoryRecords({ ...j, tags: ['18446744073709551616'] }), null, 'beyond u64');
  assert.equal(heraldTerritoryRecords(answer([{ p: 1, q: 0, tiles: { 61: ME } }])), null, 'a tile beyond 60');
  assert.equal(heraldTerritoryRecords({ ok: false, code: 'WideWorldUnavailable' }), null);
  // a province beyond a double's exact range is skipped, never rounded onto another
  assert.equal(heraldTerritoryRecords(answer([{ p: '9007199254740993', q: 0, tiles: { 1: ME } }])).size, 0);
});

test('Q-TM-4: the herald client asks again with the caller\'s ETag; an unchanged world (304) is `notModified` and the client holds no answer (verify-pr240)', async () => {
  const calls = [];
  let body = answer([{ p: 130, q: 0, tiles: { 1: ME } }]), status = 200;
  const fetch = async (url, init = {}) => {
    calls.push({ url, inm: init.headers?.['if-none-match'] ?? null });
    if (status === 404) return new Response(JSON.stringify({ ok: false, code: 'NotFound' }), { status: 404 });
    if (init.headers?.['if-none-match'] === '"e1"') return new Response(null, { status: 304, headers: { etag: '"e1"' } });
    return new Response(JSON.stringify(body), { status: 200, headers: { etag: '"e1"', 'content-type': 'application/json' } });
  };
  const h = createHerald({ base: 'http://h', fetch });
  const a = await h.wideTerritory();
  assert.equal(a.ok, true);
  assert.equal(a.json.provinces.length, 1);
  assert.equal(calls[0].url, `http://h${TERRITORY_HERALD_PATH}`);
  assert.equal(calls[0].inm, null);
  assert.equal(a.etag, '"e1"');
  const b = await h.wideTerritory({ etag: a.etag });
  assert.deepEqual([b.ok, b.notModified, calls[1].inm], [true, true, '"e1"']);
  assert.equal(b.json, undefined, 'no answer held by the client: the whole world\'s owners are never kept outside the fogged reader');
  const b2 = await h.wideTerritory();
  assert.deepEqual([b2.ok, b2.notModified ?? false, calls[2].inm, b2.json.provinces.length], [true, false, null, 1], 'no ETag from the caller: the whole answer');
  status = 404;
  const c = await h.wideTerritory();
  assert.deepEqual([c.ok, c.code], [false, 'NotFound']);
});

test('Q-TM-4: the reader takes the herald\'s whole answer but keeps only the candidates; ownRev moves with the viewer\'s own tiles only', async () => {
  let world = new Map([['0,0', ownersOf({ 1: ME })], ['1,0', ownersOf({ 2: ASTER_TAG })], ['50,50', ownersOf({ 5: CINDER_TAG })]]);
  let fail = false, changes = 0;
  const timers = [];
  const r = mountTerritoryTiles({
    reads: () => ({ ownTag: ME, all: async () => (fail ? null : world) }),
    candidates: () => ['0,0', '1,0', '2,0'], onChange: () => changes++, setTimer: f => { timers.push(f); return timers.length; }, clearTimer: () => {},
  });
  const step = async () => { const f = timers.shift(); await f(); };
  await step();
  let s = r.now();
  assert.deepEqual([...s.owners.keys()].sort(), ['0,0', '1,0'], 'a far province neither in reach nor in sight is not kept');
  assert.deepEqual(s.read, ['0,0', '1,0', '2,0']);
  assert.deepEqual([s.rev, s.ownRev, changes], [1, 1, 1]);
  world = new Map(world); world.set('1,0', ownersOf({ 2: ASTER_TAG, 3: ASTER_TAG }));
  await step();
  s = r.now();
  assert.deepEqual([s.rev, s.ownRev], [2, 1], 'another player\'s claim: no new survey');
  world = new Map(world); world.set('2,0', ownersOf({ 0: ME }));
  await step();
  assert.deepEqual([r.now().rev, r.now().ownRev], [3, 2], 'a claim of mine: a new survey');
  assert.deepEqual(r.now().ownAt, ['0,0', '2,0']);
  fail = true;
  await step();
  assert.equal(r.now().owners.size, 3, 'the herald did not answer: the last answer stays');
  r.stop();
});

test('Q-TM-1: memory is written only from tiles in sight; a free tile in sight is forgotten; the viewer\'s own tiles are never remembered', () => {
  const mem = createTerritoryMemory({ storage: store() });
  mem.use('k');
  const owners = new Map([['0,0', ownersOf({ 1: ASTER_TAG, 2: CINDER_TAG, 3: ME })]]);
  let sight = (p, q, t) => t === 1 || t === 3;
  assert.equal(rememberTerritory(mem, { owners, read: ['0,0', '1,0'], ownTag: ME, seen: sight }), true);
  assert.deepEqual([...rememberedOf(mem, '0,0')], [[1, ASTER_TAG]], 'Cinder\'s tile was never in sight; mine is current, not memory');
  assert.equal(mem.get('1,0'), null, 'a read province with nothing seen owned leaves no empty entry');
  assert.equal(rememberTerritory(mem, { owners, read: ['0,0'], ownTag: ME, seen: sight }), false, 'nothing new');
  // out of sight now: the memory stays as it was, whatever the record now says
  const later = new Map([['0,0', ownersOf({ 1: CINDER_TAG, 2: CINDER_TAG })]]);
  rememberTerritory(mem, { owners: later, read: ['0,0'], ownTag: ME, seen: () => false });
  assert.deepEqual([...rememberedOf(mem, '0,0')], [[1, ASTER_TAG]]);
  // in sight again: the owner now (Cinder took it), and a tile now free in sight is forgotten
  sight = (p, q, t) => t === 1;
  rememberTerritory(mem, { owners: later, read: ['0,0'], ownTag: ME, seen: sight });
  assert.deepEqual([...rememberedOf(mem, '0,0')], [[1, CINDER_TAG]]);
  rememberTerritory(mem, { owners: new Map(), read: ['0,0'], ownTag: ME, seen: sight });
  assert.deepEqual([...rememberedOf(mem, '0,0')], []);
  // a province the last answer did not cover is not touched (not read ≠ free)
  rememberTerritory(mem, { owners: new Map([['5,5', ownersOf({ 1: ASTER_TAG })]]), read: ['5,5'], ownTag: ME, seen: () => true });
  rememberTerritory(mem, { owners: new Map(), read: [], ownTag: ME, seen: () => true });
  assert.deepEqual([...rememberedOf(mem, '5,5')], [[1, ASTER_TAG]]);
  // a remembered tile the record now names as mine is dropped (my tiles are always drawn as they are)
  rememberTerritory(mem, { owners: new Map([['5,5', ownersOf({ 1: ME })]]), read: ['5,5'], ownTag: ME, seen: () => false });
  assert.deepEqual([...rememberedOf(mem, '5,5')], []);
});

test('Q-TM-1: the memory is kept per world and player on the device, under the fog\'s own key', () => {
  const st = store();
  const scope = { cluster: 'localnet', programId: 'P', seasonId: '7' };
  const key = territoryMemoryKey(fogMemoryKey(scope, 'W1'));
  assert.equal(key, 'ps-fterr:v1:localnet:P:7:W1');
  assert.equal(territoryMemoryKey(fogMemoryKey(scope, 'W1', 'SeasonA')), 'ps-fterr:v1:localnet:P:7@SeasonA:W1', 'a devnet page\'s key names its Season account too');
  assert.equal(territoryMemoryKey(null), null);
  const a = createTerritoryMemory({ storage: st });
  a.use(key);
  rememberTerritory(a, { owners: new Map([['0,0', ownersOf({ 4: ASTER_TAG })]]), read: ['0,0'], ownTag: ME, seen: () => true });
  assert.equal(a.save(), true);
  const b = createTerritoryMemory({ storage: st });
  b.use(key);
  assert.deepEqual([...rememberedOf(b, '0,0')], [[4, ASTER_TAG]], 'a reload remembers');
  b.use(territoryMemoryKey(fogMemoryKey(scope, 'W2')));
  assert.deepEqual([...rememberedOf(b, '0,0')], [], 'another player on the same device remembers nothing of it');
  // a damaged entry is not drawn
  st.set('bad', JSON.stringify({ v: 1, m: { '0,0': { o: [[99, ASTER_TAG], [1, 'x'], [2, ASTER_TAG]] } } }));
  b.use('bad');
  assert.deepEqual([...rememberedOf(b, '0,0')], [[2, ASTER_TAG]]);
});

test('Q-TM-1: out of sight a seen tile keeps its last-seen owner FADED; in sight the owner now; never seen hidden; none before the first village', () => {
  const land = landOf([cell(0, 0), cell(1, 0)]);
  // now: Aster holds tile 1 (in sight), Cinder holds tile 2 (out of sight, never seen), Cinder holds 1,0 tile 5 (out of sight; remembered as Aster's)
  const owners = new Map([['0,0', ownersOf({ 0: ME, 1: ASTER_TAG, 2: CINDER_TAG })], ['1,0', ownersOf({ 5: CINDER_TAG })]]);
  const memory = new Map([['0,0', new Map([[1, CINDER_TAG]])], ['1,0', new Map([[5, ASTER_TAG], [6, ASTER_TAG]])]]);
  const remembered = k => memory.get(k) ?? new Map();
  const seen = (p, q, t) => p === 0 && t === 1;
  const out = territoryLand(land, { owners, tagNation, ownTag: ME, viewer: VIEWER, fogged: true, seen, remembered });
  const c0 = out.byKey.get('0,0'), c1 = out.byKey.get('1,0');
  assert.deepEqual([c0.tiles[0], c0.tiles[1], c0.tiles[2]], [VIEWER, ASTER, NOBODY], 'own always; in sight the owner now (not the memory); never seen hidden');
  assert.deepEqual(c0.faded, []);
  assert.deepEqual([c1.tiles[5], c1.tiles[6], c1.tiles[7]], [ASTER, ASTER, NOBODY], 'out of sight: as last seen — never the record now (Cinder)');
  assert.deepEqual(c1.faded, [5, 6]);
  assert.deepEqual(out.territory, { tiles: 4, mine: 1, faded: 2, nations: [ASTER, VIEWER] });
  assert.ok(c1.geo.every(g => g.faded) && c0.geo.every(g => !g.faded));
  // a memory-only land (nothing read yet) still draws what was seen
  const memOnly = territoryLand(land, { owners: new Map(), tagNation, ownTag: ME, viewer: VIEWER, fogged: true, seen: () => false, remembered });
  assert.equal(memOnly.territory.faded, 3);
  // no vision yet (a fogged page before the first village) and no fog: nothing from memory
  assert.equal(territoryLand(land, { owners: new Map(), fogged: false, hidden: true, remembered }), land);
  assert.equal(territoryLand(land, { owners: new Map(), fogged: false, remembered }), land);
  // a remembered tile of mine is not drawn from memory (mine are current)
  const mineMem = territoryLand(land, { owners: new Map(), tagNation, ownTag: ME, viewer: VIEWER, fogged: true, seen: () => false, remembered: () => new Map([[9, ME]]) });
  assert.equal(mineMem, land);
});

test('Q-TM-1: a faded tile is painted at FADED of the wash and the border; the paint counts the faded tiles in the picture', () => {
  const land = landOf([cell(0, 0)]);
  const owners = new Map([['0,0', ownersOf({ 1: ASTER_TAG })]]);
  const shown = territoryLand(land, { owners, tagNation, ownTag: ME, viewer: VIEWER, fogged: true, seen: (p, q, t) => t === 1, remembered: () => new Map([[2, ASTER_TAG]]) });
  const { ctx, log } = recorder();
  const r = paintTerritoryTiles(ctx, shown, { seen: ALL, zoom: 1, level: 'tile' });
  assert.equal(r.faded, 1);
  assert.equal(r.tiles, 2);
  const alphas = log.fills.filter(f => f.style === NATION_LAND[ASTER]).map(f => +f.alpha.toFixed(3));
  assert.ok(alphas.includes(TILE_LOOK.tile.wash), 'the current wash');
  assert.ok(alphas.includes(+(TILE_LOOK.tile.wash * FADED.wash).toFixed(3)), 'the faded wash');
  assert.ok(log.fills.some(f => f.alpha === FADED.band), 'the faded border');
  assert.ok(log.fills.some(f => f.alpha === 1), 'the current border');
  assert.ok(FADED.wash < 1 && FADED.band < 1);
});

test('Q-TM-1: the key says what a faded colour means — English and Japanese — only when a faded tile is in the picture', () => {
  setLang('ja');
  let rows = territoryLegendRows([ASTER], { viewer: VIEWER, faded: true, keeps: true });
  assert.deepEqual(rows.map(r => r.key), ['n0', 'faded', 'keep']);
  assert.equal(rows[1].text, '薄い色：前に見たときの持ち主（いまは見えていません）');
  assert.deepEqual(territoryLegendRows([ASTER], { viewer: VIEWER }).map(r => r.key), ['n0']);
  assert.deepEqual(territoryLegendRows([], { faded: true }), [], 'no tiles in the picture: no row');
  setLang('en');
  rows = territoryLegendRows([ASTER], { viewer: VIEWER, faded: true });
  assert.equal(rows[1].text, 'Faded: the owner when last seen (out of sight now)');
  assert.doesNotMatch(rows.map(r => r.text).join(' '), /season/i);
  // the mounted key reads the paint's `territory.faded`
  const el = () => ({ children: [], attrs: {}, dataset: {}, append(...c) { this.children.push(...c); }, setAttribute(k, v) { this.attrs[k] = v; }, remove() {}, set textContent(v) { this.children = []; } });
  const doc = { createElement: el, body: el() };
  const lg = mountWideLegend({ doc, parent: doc.body });
  lg.update({ nations: [ASTER], keeps: [], territory: { faded: 2 } }, VIEWER);
  assert.deepEqual(lg.el.children[1].children.map(li => li.children[0].attrs['data-key']), ['n0', 'faded']);
  lg.update({ nations: [ASTER], keeps: [], territory: { faded: 0 } }, VIEWER);
  assert.deepEqual(lg.el.children[1].children.map(li => li.children[0].attrs['data-key']), ['n0']);
  setLang('ja');
  assert.match(src('frontier.css'), /\.wide-legend-swatch\[data-key="faded"\]/);
});

test('no leak through the new path: the page remembers only from sight, under the fog, keyed by the fog\'s key; nothing is signed or sent', () => {
  const app = src('app.mjs');
  const at = app.indexOf('function territoryMemoryNow(');
  const body = app.slice(at, app.indexOf('\n}\n', at));
  assert.match(body, /territoryMemory\.use\(fogged && sc && w \? territoryMemoryKey\(fogMemoryKey\(sc, w,/);
  assert.match(body, /if \(!fogged \|\| !t\) return territoryMemory;/);
  assert.match(body, /seen: \(p, q, tile\) => survey\.levelOf\(p, q, tile\) === 3/);
  assert.match(app, /remembered: k => rememberedOf\(mem, k\)/);
  const t = src('map/territorytiles.mjs');
  assert.match(t, /const recall = fogged && !hidden && typeof remembered === 'function' \? remembered : null;/);
  // the reader keeps only the candidates of the herald's whole answer, filtered by the page's fog as it arrives
  assert.match(t, /take\(keys, k => all\.get\(k\) \?\? null, r\.ownTag \?\? null\);/);
  assert.match(app, /keep: territoryKeep,/);
  const kb = app.slice(app.indexOf('function territoryKeep('), app.indexOf('\n}\n', app.indexOf('function territoryKeep(')));
  assert.match(kb, /if \(FS\.fog\?\.on\) return FS\.survey\?\.levelOf\?\.\(p, q, tile\) === 3;\n  return !fogActive\(FS\);/);
  assert.match(app, /if \(fog\) territorySightChanged\(\);/);
  const h = src('herald.mjs');
  const w = h.slice(h.indexOf('async wideTerritory('), h.indexOf('/** Separate read-only index observations.'));
  assert.doesNotMatch(w, /\bsign[A-Z(]|sendTx|'POST'/);
});

test('no leak: under the fog the reader keeps only the owners of tiles in sight (and the viewer\'s own); `known` names what it knows', async () => {
  const world = new Map([['0,0', ownersOf({ 1: ASTER_TAG, 2: CINDER_TAG, 3: ME })]]);
  let sight = new Set([1]);
  const timers = [];
  const r = mountTerritoryTiles({
    reads: () => ({ ownTag: ME, all: async () => world }), candidates: () => ['0,0', '1,0'],
    keep: (p, q, i) => p === 0 && q === 0 && sight.has(i), setTimer: f => { timers.push(f); return timers.length; }, clearTimer: () => {},
  });
  const step = async () => { const f = timers.shift(); await f(); };
  await step();
  let s = r.now();
  assert.deepEqual(s.owners.get('0,0'), ownersOf({ 1: ASTER_TAG, 3: ME }), 'Cinder\'s tile out of sight is not kept at all');
  assert.deepEqual(s.known.get('0,0'), [1, 3]);
  assert.equal(s.known.has('1,0'), false);
  assert.ok(!JSON.stringify([...s.owners]).includes(CINDER_TAG), 'nothing of it anywhere in the state');
  // sight moves onto tile 2: the next read (the page reloads on a new survey) knows it
  sight = new Set([1, 2]);
  r.reload(); await step();
  s = r.now();
  assert.deepEqual(s.owners.get('0,0'), ownersOf({ 1: ASTER_TAG, 2: CINDER_TAG, 3: ME }));
  assert.deepEqual(s.known.get('0,0'), [1, 2, 3]);
  // a tile in sight now that the last read did not know: its memory is neither cleared nor overdrawn by "free"
  const mem = createTerritoryMemory({ storage: store() });
  mem.use('k');
  mem.put('0,0', { o: [[5, CINDER_TAG]] });
  rememberTerritory(mem, { owners: s.owners, read: s.read, known: s.known, ownTag: ME, seen: (p, q, i) => i === 5 });
  assert.deepEqual([...rememberedOf(mem, '0,0')], [[5, CINDER_TAG]]);
  const land = landOf([cell(0, 0)]);
  const out = territoryLand(land, { owners: s.owners, known: s.known, tagNation, ownTag: ME, viewer: VIEWER, fogged: true, seen: (p, q, i) => i === 5 || i === 1, remembered: k => rememberedOf(mem, k) });
  const c = out.byKey.get('0,0');
  assert.deepEqual([c.tiles[1], c.tiles[5]], [ASTER, CINDER]);
  assert.deepEqual(c.faded, [5], 'in sight but not read yet: its memory, faded, until the next read');
  r.stop();
});

test('verify-pr240: a 304 keeps the filtered state for the same candidates; new candidates ask for the whole answer again (fresh)', async () => {
  const world = new Map([['0,0', ownersOf({ 1: ASTER_TAG, 3: ME })], ['1,0', ownersOf({ 4: CINDER_TAG })]]);
  let keys = ['0,0'], unchanged = false;
  const asked = [], timers = [];
  const r = mountTerritoryTiles({
    reads: () => ({ ownTag: ME, all: async ({ fresh = false } = {}) => { asked.push(fresh); return unchanged && !fresh ? TERRITORY_UNCHANGED : world; } }),
    candidates: () => keys, keep: () => true, setTimer: f => { timers.push(f); return timers.length; }, clearTimer: () => {},
  });
  const step = async () => { const f = timers.shift(); await f(); };
  await step();
  const s1 = r.now();
  assert.deepEqual([...s1.owners.keys()], ['0,0']);
  unchanged = true;
  r.reload(); await step();
  assert.equal(r.now().rev, s1.rev, '304, same candidates: the state stays');
  assert.deepEqual(asked, [false, false]);
  keys = ['0,0', '1,0'];
  r.reload(); await step();
  assert.deepEqual(asked, [false, false, false, true], 'new candidates: the whole answer again');
  assert.deepEqual([...r.now().owners.keys()].sort(), ['0,0', '1,0']);
  r.stop();
});
