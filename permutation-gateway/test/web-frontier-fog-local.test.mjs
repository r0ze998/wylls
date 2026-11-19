// The fog of war of a LOCAL TEST world (permutation-server/web/frontier/map/fog.mjs; owner t387u / t387s1100,
// 2026-11-19): a player sees only round their own villages and hosts and round their own nation's villages and held
// provinces; land seen before stays as last seen; other nations' hosts, marches and clashes only in current sight;
// never-seen land is blank. Presentation only: the chain's records stay public and untouched, and a page that is not a
// local test world never applies any of it (fogActive; LOCAL_FOG is the one switch).
//
// The leak tests at the end build one world with another nation's village, keep, march and wide village OUT of the
// viewer's sight, run every surface the play page shows them through (the map's records, the wide land, the keep
// lists, the incoming warnings, the inspector, the chronicle, the legend) and assert that none of those places or
// nations reaches what the renderers read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as F from '../../permutation-server/web/frontier/map/fog.mjs';
import * as S from '../../permutation-server/web/frontier/map/survey.mjs';
import * as chart from '../../permutation-server/web/frontier/map/chart.mjs';
import { landOfCells, wideLandOf } from '../../permutation-server/web/frontier/map/wideland.mjs';
import { tileHex, provinceCentre, hexDistance } from '../../permutation-server/web/frontier/fgeo.mjs';
import * as inspect from '../../permutation-server/web/frontier/hud/inspect.mjs';
import { chronicleRows } from '../../permutation-server/web/frontier/screens/chronicle.mjs';
import { keepFor } from '../../permutation-server/web/frontier/screens/conquest.mjs';
import { renderSurveyHelp, fogLegendText } from '../../permutation-server/web/frontier/map/legend.mjs';
import { setLang, L } from '../../permutation-server/web/lang.mjs';

// ------------------------------------------------------------------ a small world
const VIEWER = 3, ENEMY = 0, ALLY = 1;
const HOME = { p: 2, q: 0, tile: 7 };
// every province's twelve sites stand on tiles 7, 9, …, 29 (a fixture; the real terrain says where)
const SITES = Array.from({ length: 12 }, (_, j) => 7 + 2 * j);
const terrainOf = () => ({ sites: SITES, terrain: Array(61).fill(0), names: ['Grassland'] });
const rec = (p, q, over = {}) => ({ p, q, owners: Array(12).fill(7), sites: Array(12).fill(0), hosts: Array(7).fill(0), clash: false, dormant: false, opened: true, resolvedNext: 0,
  occupiers: Array(12).fill(7), siegeStates: Array(12).fill(0), siteKinds: Array(12).fill(3), keepTile: null, keepTroops: 0, immune: Array(12).fill(false), v1: new Uint8Array(24), ...over });
const withVillage = (r, site, f) => { r.owners[site] = f; r.sites[site] = 1; return r; };
const homeRec = () => withVillage(rec(2, 0, { hosts: [0, 0, 0, 2, 0, 0, 1], clash: false, keepTile: 40, keepTroops: 50, control: VIEWER }), 0, VIEWER);
// an enemy village far away (province -2, 0), an enemy keep with a contest (province 0, -2), an ally's village (-1, 2)
const enemyRec = () => withVillage(rec(-2, 0, { hosts: [5, 0, 0, 0, 0, 0, 0], clash: true, keepTile: 30, keepTroops: 400, control: ENEMY, contender: VIEWER, contestProgress: 3, contestRequired: 72 }), 4, ENEMY);
const keepRec = () => rec(0, -2, { keepTile: 30, keepTroops: 250, control: ENEMY, contender: ALLY, contestProgress: 9, contestRequired: 72 });
const allyRec = () => withVillage(rec(-1, 2), 3, ALLY);
const overviews = () => new Map([[2, { ring: 2, bell: 40, provinces: [homeRec(), enemyRec(), keepRec(), allyRec()] }]]);
const memStore = () => { const m = new Map(); return { get: k => m.get(k) ?? null, set: (k, v) => { m.set(k, v); return true; }, m }; };
const surveyOf = (anchors, extra = {}) => { const sv = S.buildSurvey({ ringsOpen: 3, anchors, ...extra }); sv.rev = Math.random(); return sv; };
const homeSight = () => S.anchorsOf({ villages: [{ ...HOME, tier: 0 }] });
const at = (p, q, tile) => tileHex(p, q, tile);
const sightOn = (p, q, tile, radius = 2) => { const h = at(p, q, tile); return { q: h.q, r: h.r, radius, level: S.L3, kind: 'host' }; };

test('the one switch and the gate: local test worlds on the play page only', () => {
  assert.equal(F.LOCAL_FOG, true, 'the switch is on in this branch (false turns every mask off)');
  assert.equal(F.fogActive({ localPlay: { address: 'x' }, mode: 'play' }), true);
  assert.equal(F.fogActive({ localPlay: null, mode: 'play' }), false, 'a devnet / non-local page: never');
  assert.equal(F.fogActive({ localPlay: { address: 'x' }, mode: 'spectate' }), false);
  assert.equal(F.fogActive({ localPlay: { address: 'x' }, mode: 'practice' }), false);
  assert.equal(F.fogNow().on, false, 'before a fog view is made: off');
});

test('FOG_RULES: one named table for the choices left open', () => {
  assert.deepEqual([0, 1, 2, 3].map(F.FOG_RULES.nationVillage), [0, 1, 2, 3].map(S.SIGHT.village), 'a nation-mate\'s village sees as one\'s own');
  assert.equal(F.FOG_RULES.nationVillage(undefined), S.SIGHT.village(0), 'tier unknown: a hamlet');
  assert.equal(F.FOG_RULES.territory, 6, 'a held province: its whole radius 4 and 2 tiles past its edge');
  assert.equal(F.FOG_RULES.incomingTurns, 3);
  assert.equal(F.FOG_RULES.blankChart, true);
  assert.ok(Object.isFrozen(F.FOG_RULES));
});

test('vision: the viewer\'s nation sees too (its villages and held provinces); another nation, even an ally, does not', () => {
  const ov = overviews();
  ov.get(2).provinces.push(withVillage(rec(1, -2), 5, VIEWER), rec(-2, 2, { control: VIEWER }));
  const own = new Set([`${HOME.p},${HOME.q},${SITES[0]}`]);
  const src = F.nationSources({ overviews: ov, faction: VIEWER, terrainOf, own });
  assert.deepEqual(src.villages, [{ p: 1, q: -2, tile: SITES[5], tier: 0 }], 'a nation-mate\'s village; the viewer\'s own is the survey\'s already');
  assert.deepEqual(src.territory, [{ p: 2, q: 0 }, { p: -2, q: 2 }], 'the provinces the nation holds');
  const a = F.nationAnchors(src);
  assert.deepEqual(a.map(x => [x.kind, x.radius, x.level]), [['nation', 4, S.L3], ['territory', 6, S.L3], ['territory', 6, S.L3]]);
  const sv = surveyOf(S.anchorsOf({ villages: [{ ...HOME, tier: 0 }], extraAnchors: a }));
  const mate = at(1, -2, SITES[5]), c = provinceCentre(-2, 2);
  assert.equal(sv.levelAt(mate.q, mate.r), S.L3, 'the nation-mate\'s village is in sight');
  assert.equal(sv.levelAt(mate.q + 4, mate.r), S.L3);
  assert.equal(sv.levelAt(c.q, c.r), S.L3, 'a held province is in sight');
  for (let i = 0; i < 61; i++) { const h = tileHex(-2, 2, i); assert.equal(sv.levelAt(h.q, h.r), hexDistance(h.q, h.r, c.q, c.r) <= 6 ? S.L3 : S.L1, `held province tile ${i}`); }
  const ally = at(-1, 2, SITES[3]), enemy = at(-2, 0, SITES[4]);
  assert.notEqual(sv.levelAt(ally.q, ally.r), S.L3, 'an ally\'s village gives the viewer no sight');
  assert.notEqual(sv.levelAt(enemy.q, enemy.r), S.L3);
  assert.deepEqual(F.nationSources({ overviews: ov, faction: null, terrainOf }), { villages: [], territory: [] }, 'no nation yet: nothing more');
});

test('the survey can see the wide land past the open rings when told it exists (extraOpen); not otherwise', () => {
  const far = { p: 3, q: 0 }, h = tileHex(3, 0, 0);
  const anchors = [{ q: h.q, r: h.r, radius: 1, level: S.L3, kind: 'host' }];
  assert.equal(S.buildSurvey({ ringsOpen: 3, anchors }).levelAt(h.q, h.r), S.L0, 'ring 3 is not open: cloud');
  const sv = S.buildSurvey({ ringsOpen: 3, anchors, extraOpen: ['3,0'] });
  assert.equal(sv.levelAt(h.q, h.r), S.L3);
  assert.equal(sv.province(3, 0).max, S.L3);
  assert.equal(sv.province(3, 1).kind, 'cloud', 'a province not listed stays cloud');
  const t = tileHex(3, 0, 60);
  assert.equal(sv.levelAt(t.q, t.r), hexDistance(t.q, t.r, h.q, h.r) <= 1 ? S.L3 : S.L1, 'the listed province exists: chart where not seen');
  assert.ok(far);
});

test('a province never seen: no village, camp, keep, host, clash or contest; the raw bytes are dropped', () => {
  const sv = surveyOf(homeSight());
  const out = F.fogProvince(enemyRec(), { survey: sv, sites: SITES, viewer: VIEWER });
  assert.equal(out.fog, 'unseen');
  assert.deepEqual(out.owners, Array(12).fill(7));
  assert.deepEqual(out.sites, Array(12).fill(0));
  assert.deepEqual(out.hosts, Array(7).fill(0));
  assert.deepEqual([out.clash, out.keepTile, out.keepTroops, out.control, out.contender, out.contestProgress], [false, null, 0, undefined, undefined, undefined]);
  assert.equal('v1' in out, false);
  assert.deepEqual([out.p, out.q, out.opened], [-2, 0, true], 'where it is and that it is open land stay (structure, not who is there)');
});

test('in sight: live; then out of sight: the LAST-KNOWN look, not the live record; hosts and clashes only in sight', () => {
  const store = memStore(), mem = F.createFogMemory({ storage: store });
  mem.use('ps-ffog:v1:test:P:1:W');
  const look = surveyOf([...homeSight(), sightOn(-2, 0, SITES[4], 3), sightOn(-2, 0, 30, 1)]);
  const live = F.fogProvince(enemyRec(), { survey: look, mem, sites: SITES, viewer: VIEWER });
  assert.equal(live.fog, 'sight');
  assert.equal(live.owners[4], ENEMY, 'the enemy village, seen');
  assert.deepEqual([live.hosts[0], live.clash, live.keepTile, live.control, live.contender], [5, true, 30, ENEMY, VIEWER]);
  assert.ok(mem.get('-2,0'), 'remembered');
  // the column leaves: out of sight now (still surveyed); the live record changes after that
  const away = surveyOf(homeSight(), { memory: new Set([...look.tiles.keys()].filter(k => look.tiles.get(k) === S.L3)) });
  const changed = enemyRec(); changed.owners[4] = 7; changed.sites[4] = 0; withVillage(changed, 6, ENEMY); changed.control = ALLY; changed.keepTroops = 9;
  const last = F.fogProvince(changed, { survey: away, mem, sites: SITES, viewer: VIEWER });
  assert.equal(last.fog, 'memory');
  assert.equal(last.owners[4], ENEMY, 'the village as last seen');
  assert.equal(last.owners[6], 7, 'a village founded since is not known');
  assert.deepEqual([last.keepTile, last.keepTroops, last.control], [30, 400, ENEMY], 'the keep and its holder as last seen');
  assert.deepEqual([last.hosts[0], last.clash, last.contender, last.contestProgress], [0, false, undefined, undefined], 'no host, clash or contest out of sight: no ghosts');
  assert.deepEqual(last.siegeStates, Array(12).fill(0));
  // the viewer's own hosts are always the viewer's to know
  const ownHosts = F.fogProvince(rec(-2, 0, { hosts: [5, 0, 0, 4, 0, 0, 0] }), { survey: surveyOf(homeSight()), sites: SITES, viewer: VIEWER });
  assert.deepEqual(ownHosts.hosts, [0, 0, 0, 4, 0, 0, 0]);
  // stored per world and player, read back by a new page
  assert.equal(mem.save(), true);
  assert.ok([...store.m.keys()][0].startsWith('ps-ffog:v1:'));
  const again = F.createFogMemory({ storage: store });
  again.use('ps-ffog:v1:test:P:1:W');
  assert.deepEqual(again.get('-2,0'), mem.get('-2,0'));
  const other = F.createFogMemory({ storage: store });
  other.use('ps-ffog:v1:test:P:1:SOMEONE-ELSE');
  assert.equal(other.get('-2,0'), null, 'another player (or world) has a memory of its own');
});

test('a province partly in sight: each site and the keep by its own tile; without terrain, the sites as one', () => {
  const sv = surveyOf([...homeSight(), sightOn(-2, 0, SITES[4], 1)]);
  const out = F.fogProvince(enemyRec(), { survey: sv, sites: SITES, viewer: VIEWER });
  assert.equal(out.owners[4], ENEMY);
  assert.equal(out.keepTile, null, 'its keep tile (30) is not in sight and was never seen');
  assert.equal(out.fog, 'sight');
  const whole = F.fogProvince(enemyRec(), { survey: sv, sites: null, viewer: VIEWER });
  assert.deepEqual([whole.owners[4], whole.keepTile], [ENEMY, null], 'the sites as one with the province; the keep still by its own tile (the record names it)');
});

test('the memory: bounded, damage ignored, nothing stored without a key', () => {
  const store = memStore();
  const mem = F.createFogMemory({ storage: store, limit: 2 });
  mem.use('k');
  mem.put('1,0', { o: [] }); mem.put('2,0', { o: [] }); mem.put('3,0', { o: [] });
  assert.equal(mem.size(), 2);
  assert.equal(mem.get('1,0'), null, 'the oldest dropped');
  assert.equal(mem.put('3,0', { o: [] }), false, 'the same snapshot is no change');
  store.set('bad', '{not json');
  const b = F.createFogMemory({ storage: store }); b.use('bad');
  assert.equal(b.size(), 0);
  const none = F.createFogMemory({ storage: store }); none.use(null); none.put('1,0', {});
  assert.equal(none.save(), false);
  assert.equal(F.fogMemoryKey({ cluster: 'local', programId: 'P', seasonId: 7 }, 'W'), 'ps-ffog:v1:local:P:7:W');
});

// ------------------------------------------------------------------ the wide land
const wideCapture = () => {
  // a 4,864-byte province capture with terrain 0 and twelve sites at tiles 7…29 (map/wideland.mjs terrainOfCapture)
  const b = new Uint8Array(4864);
  b[262] = 12; SITES.forEach((t, j) => { b[250 + j] = t; });
  return Buffer.from(b).toString('base64');
};
const wideHolding = (site, f) => { const b = new Uint8Array(1344); b[112] = f; return { site, capture: { bytes_b64: Buffer.from(b).toString('base64') } }; };
const wideWalk = () => {
  const entries = new Map();
  for (const [p, q, holder, villages] of [[3, 0, ENEMY, [[4, ENEMY]]], [3, -1, VIEWER, [[0, VIEWER]]], [-3, 3, ENEMY, [[2, ENEMY]]]]) {
    entries.set(`${p},${q}`, { p: BigInt(p), q: BigInt(q), ring: 3n, state: 'open', wedge: 0, wide: { keepHolder: holder, holdings: villages.map(([s, f]) => wideHolding(s, f)), capture: { bytes_b64: wideCapture() } } });
  }
  return { entries, world: 'w', snapshot: { epoch: 1, stamp: 1 } };
};

test('the wide land: never seen is left out (cloud), seen is last-known, in sight is live; borders drawn again', () => {
  // (the fixture's wide provinces sit in ring 3 — wideLandOf keeps rings past 128 only, so the land is made from cells directly)
  const raw = wideLandOf(wideWalk());
  assert.equal(raw.cells.length, 0, 'wideLandOf keeps rings past 128 only');
  const cells = [...wideWalk().entries.values()].map(e => ({ p: Number(e.p), q: Number(e.q), key: `${e.p},${e.q}`, ring: 3, holder: e.wide.keepHolder,
    villages: e.wide.holdings.map(h => ({ site: h.site, nation: h.capture ? new Uint8Array(Buffer.from(h.capture.bytes_b64, 'base64'))[112] : null })), terrain: { sites: SITES }, x: 0, y: 0, box: {} }));
  const land = landOfCells(cells, { rings: { min: 3, max: 3 }, reach: 4, far: 0, key: 'L' });
  assert.equal(land.cells.length, 3);
  const extraOpen = cells.map(c => c.key);
  const mem = F.createFogMemory({ storage: memStore() }); mem.use('k');
  const look = S.buildSurvey({ ringsOpen: 3, extraOpen, anchors: [sightOn(3, 0, 20, 6), sightOn(3, -1, 20, 6)] }); look.rev = 1;
  const a = F.fogWideLand(land, { survey: look, mem, relayout: landOfCells });
  assert.deepEqual(a.cells.map(c => c.key).sort(), ['3,-1', '3,0'], 'the far enemy wide province (-3,3) was never seen: not drawn');
  assert.deepEqual(a.cells.find(c => c.key === '3,0').villages, [{ site: 4, nation: ENEMY }]);
  assert.match(a.key, /\|fog:1:2$/);
  // later: out of sight, the enemy wide village gone from the record → still the last-known look
  const memory = new Set([...look.tiles].filter(([, v]) => v === S.L3).map(([k]) => k));
  const away = S.buildSurvey({ ringsOpen: 3, extraOpen, anchors: [sightOn(3, -1, 20, 1)], memory }); away.rev = 2;
  const moved = landOfCells(cells.map(c => (c.key === '3,0' ? { ...c, holder: ALLY, villages: [] } : c)), land);
  const b = F.fogWideLand(moved, { survey: away, mem, relayout: landOfCells });
  const c30 = b.cells.find(c => c.key === '3,0');
  assert.deepEqual([c30.holder, c30.villages, c30.fog], [ENEMY, [{ site: 4, nation: ENEMY }], 'memory']);
  assert.ok(Array.isArray(c30.edges), 'borders are drawn again for the fogged land');
});

// ------------------------------------------------------------------ keeps, marches, the chronicle
const keepMap = () => new Map([
  ['2,0', { p: 2, q: 0, tile: 40, holder: VIEWER, troops: 50, heartland: false, contender: 7, progress: 0, asOfBell: 40 }],
  ['0,-2', { p: 0, q: -2, tile: 30, holder: ENEMY, troops: 250, heartland: false, contender: ALLY, progress: 9, asOfBell: 40 }],
  ['-2,0', { p: -2, q: 0, tile: 30, holder: ENEMY, troops: 400, heartland: false, contender: VIEWER, progress: 3, asOfBell: 40 }],
]);

test('keeps: never seen are not listed; in sight live and remembered; seen before: last-known holder, no contest', () => {
  const mem = F.createFogMemory({ storage: memStore() }); mem.use('k');
  const look = surveyOf([...homeSight(), sightOn(2, 0, 40, 1), sightOn(0, -2, 30, 1)]);
  const a = F.fogKeeps(keepMap(), { survey: look, mem });
  assert.deepEqual([...a.keys()].sort(), ['0,-2', '2,0'], 'the keep at -2,0 was never seen');
  assert.equal(a.get('0,-2').contender, ALLY, 'live in sight');
  const away = surveyOf(homeSight(), { memory: new Set([...look.tiles].filter(([, v]) => v === S.L3).map(([k]) => k)) });
  const later = keepMap(); later.get('0,-2').holder = ALLY; later.get('0,-2').troops = 1;
  const b = F.fogKeeps(later, { survey: away, mem });
  assert.deepEqual([b.get('0,-2').holder, b.get('0,-2').troops, b.get('0,-2').contender, b.get('0,-2').progress, b.get('0,-2').fog, b.get('0,-2').asOfBell], [ENEMY, 250, 7, 0, 'memory', 40]);
});

test('the viewer\'s own nation is always known: its villages, provinces and keeps out of sight stay live', () => {
  const sv = surveyOf(homeSight());
  const r = withVillage(rec(-2, 0, { keepTile: 30, keepTroops: 70, control: VIEWER }), 4, VIEWER);
  const out = F.fogProvince(r, { survey: sv, sites: SITES, viewer: VIEWER });
  assert.deepEqual([out.owners[4], out.sites[4], out.keepTile, out.control], [VIEWER, 1, 30, VIEWER]);
  const keeps = new Map([['-2,0', { p: -2, q: 0, tile: 30, holder: VIEWER, troops: 70, contender: ENEMY, progress: 5 }]]);
  assert.equal(F.fogKeeps(keeps, { survey: sv, viewer: VIEWER }).get('-2,0').contender, ENEMY, 'an enemy on the nation\'s own keep is the nation\'s alarm');
  assert.equal(F.fogKeeps(keeps, { survey: sv, viewer: ENEMY }).size, 0, 'another viewer does not see it');
});

test('marches and alarms: another nation\'s departure only from a place in sight; a warning once the column is near', () => {
  const sv = surveyOf(homeSight());
  const near = { origin_p: 2, origin_q: 0, origin_tile: 9, faction: ENEMY, arrive_bell: 50 };
  const far = { origin_p: -2, origin_q: 0, origin_tile: SITES[4], faction: ENEMY, arrive_bell: 60 };
  const mate = { origin_p: -2, origin_q: 0, origin_tile: SITES[4], faction: VIEWER, arrive_bell: 61 };
  assert.deepEqual([near, far, mate].map(d => F.departureSeen(d, { survey: sv, viewer: VIEWER })), [true, false, true]);
  const warn = [{ bell: 50, holding: HOME }, { bell: 60, holding: HOME }, { bell: 43, holding: HOME }];
  assert.deepEqual(F.fogIncoming(warn, { nowBell: 41, departures: [near, far], survey: sv, viewer: VIEWER }).map(w => w.bell), [50, 43], 'the far column is told only 3 turns before it arrives');
  const rows = [{ name: 'CLASH', p: -2, q: 0 }, { name: 'CLASH', p: 2, q: 0, tile: 7 }, { name: 'RING_OPENED', ring: 2 }, { name: 'DEPART', origin_p: -2, origin_q: 0, origin_tile: SITES[4], host_id: 'x' }];
  assert.deepEqual(rows.map(r => F.recordSeen(r, { survey: sv })), [false, true, true, false]);
  assert.equal(F.recordSeen(rows[3], { survey: sv, mine: () => true }), true, 'the viewer\'s own record: always');
});

test('the page\'s fogger: off unless active; rings fogged again only when their record or the survey changed', () => {
  const fogger = F.createFogger({ storage: memStore() });
  assert.equal(fogger({ active: false, survey: surveyOf(homeSight()) }).on, false);
  assert.equal(F.fogNow().on, false);
  const sv = surveyOf(homeSight()), ov = overviews();
  const a = fogger({ active: true, survey: sv, overviews: ov, viewer: VIEWER, terrainOf, memKey: 'k' });
  assert.equal(a.on, true);
  assert.equal(F.fogNow(), a, 'kept for the modules that are not handed it');
  const b = fogger({ active: true, survey: sv, overviews: ov, viewer: VIEWER, terrainOf, memKey: 'k' });
  assert.equal(b.overviews.get(2), a.overviews.get(2), 'the same ring object while nothing changed');
  const sv2 = surveyOf(homeSight());
  assert.notEqual(fogger({ active: true, survey: sv2, overviews: ov, viewer: VIEWER, terrainOf, memKey: 'k' }).overviews.get(2), a.overviews.get(2), 'a new survey: fogged again');
  assert.equal(fogger({ active: true, survey: S.openSurvey(3), overviews: ov }).on, false, 'a survey that shows everything is not fogged');
  F.resetFogNow();
});

test('never-seen land is plain paper under the fog (chart.mjs setBlankChart); the chart is unchanged when it is off', () => {
  const calls = [];
  const g = new Proxy({}, { get: (_, k) => (k === 'getTransform' ? undefined : (...a) => { calls.push(k); return k === 'createPattern' ? {} : undefined; }), set: () => true });
  const tiles = [{ q: 0, r: 0, x: 0, y: 0, name: 'mountain' }, { q: 1, r: 0, x: 26, y: 0, name: 'water' }];
  chart.setBlankChart(true);
  try {
    assert.equal(chart.chartIsBlank(), true);
    chart.paintChart(g, tiles, { res: 1 });
    assert.equal(calls.filter(c => c === 'stroke').length, 0, 'no lattice, coast or glyph');
  } finally { chart.setBlankChart(false); }
  calls.length = 0;
  chart.paintChart(g, tiles, { res: 1 });
  assert.ok(calls.filter(c => c === 'stroke').length > 0, 'off: the chart draws its ink as before');
});

// ------------------------------------------------------------------ the leak tests
/**
 * One world, as the play page holds it, with the viewer's village at HOME and, OUT of sight: an enemy village at
 * (-2, 0) site 4 with a keep at tile 30 and a clash, an enemy keep (0, -2) under contest, an enemy march leaving
 * (-2, 0), an enemy wide village at (3, 0). What every surface reads is checked for those places and nations.
 */
function leakWorld() {
  const ov = overviews();
  const sv = surveyOf(S.anchorsOf({ villages: [{ ...HOME, tier: 0 }] }));
  sv.ownHosts = new Set(); sv.villages = [{ ...HOME, tier: 0 }]; sv.faction = VIEWER;
  const fogger = F.createFogger({ storage: memStore() });
  const fog = fogger({ active: true, survey: sv, overviews: ov, viewer: VIEWER, terrainOf, memKey: 'leak' });
  const FS = { mode: 'play', localPlay: { address: 'W' }, citizen: { faction: VIEWER }, holdings: [{ ...HOME, site: 0, tier: 0 }], nowBell: 41, land: { stage: 'final' }, survey: sv, fog,
    overviews: ov, provinces: new Map(), roster: { ownerOf: () => null, tierOf: () => 0 }, conquest: { keeps: keepMap(), events: [{ kind: 'keep_contest', seq: 1, bell: 40, p: 0, q: -2, from: ENEMY, to: ALLY }] }, season: { programVersion: 3 },
    chronicle: [{ seq: 1, record: { name: 'CLASH', bell: 40, p: -2, q: 0 } }, { seq: 2, record: { name: 'DEPART', bell: 40, host_id: 'h', origin_p: -2, origin_q: 0, origin_tile: SITES[4], depart_bell: 40, arrive_bell: 46 } }] };
  return { FS, fog, sv };
}
const ENEMY_PLACES = ['-2,0', '0,-2'];
const recsOf = ovs => [...ovs.values()].flatMap(o => o.provinces);

test('LEAK: the map\'s records (map source overviews) hold no other nation\'s village, keep, host or clash out of sight', () => {
  const { fog } = leakWorld();
  for (const r of recsOf(fog.overviews)) {
    if (!ENEMY_PLACES.includes(`${r.p},${r.q}`) && !(r.p === -1 && r.q === 2)) continue;
    assert.deepEqual(r.owners, Array(12).fill(7), `${r.p},${r.q} owners`);
    assert.deepEqual(r.sites, Array(12).fill(0), `${r.p},${r.q} sites`);
    assert.deepEqual(r.hosts, Array(7).fill(0), `${r.p},${r.q} hosts`);
    assert.deepEqual([r.clash, r.keepTile, r.keepTroops, r.control, r.contender], [false, null, 0, undefined, undefined], `${r.p},${r.q} keep/clash`);
    assert.equal('v1' in r, false);
  }
  // the viewer's own province stays whole
  const home = recsOf(fog.overviews).find(r => r.p === 2 && r.q === 0);
  assert.deepEqual([home.owners[0], home.control, home.keepTile], [VIEWER, VIEWER, 40]);
  // nothing of an enemy nation is left anywhere in what the painters read
  const text = JSON.stringify(recsOf(fog.overviews).filter(r => !(r.p === 2 && r.q === 0)), (_, v) => (typeof v === 'bigint' ? String(v) : v));
  assert.doesNotMatch(text, /"control":0|"owners":\[[^\]]*\b0\b/, 'no enemy (nation 0) holder or owner in the records');
});

test('LEAK: the keep lists, the keep panel and the reach input never name an unseen keep', () => {
  const { FS } = leakWorld();
  const shown = F.viewKeeps(FS.conquest.keeps);
  assert.deepEqual([...shown.keys()], ['2,0'], 'only the viewer\'s own keep (in sight)');
  assert.equal(keepFor(FS, 0, -2), null);
  assert.equal(keepFor(FS, -2, 0), null);
  setLang('ja');
  assert.ok(keepFor(FS, 2, 0));
  F.resetFogNow();
  assert.equal(F.viewKeeps(FS.conquest.keeps).size, 3, 'without the fog: as before');
});

test('LEAK: the inspector says nothing of an unseen enemy village, its keep or its hosts', () => {
  const { FS } = leakWorld();
  FS.selected = { p: -2, q: 0, idx: SITES[4] };
  const m = inspect.inspectModel(FS, terrainOf);
  assert.deepEqual(m.owners, []);
  assert.equal(m.clash, false);
  assert.equal(m.tile.site, null);
  assert.deepEqual(m.tile.hosts, []);
  F.resetFogNow();
});

test('LEAK: the chronicle tells no clash, march or keep event out of sight; the legend offers no full-map view', () => {
  setLang('ja');
  const { FS } = leakWorld();
  const rows = chronicleRows(FS.chronicle, () => false, 60, FS);
  assert.deepEqual(rows, [], 'the clash and the departure at -2,0 and the contest at 0,-2 are all out of sight');
  const help = String(renderSurveyHelp(FS));
  assert.doesNotMatch(help, /spectate\.html/, 'no way to the whole world from a fogged page');
  assert.ok(help.includes(fogLegendText()));
  setLang('en');
  assert.match(fogLegendText(), /^Fog of war: you see only around your own villages/);
  assert.match(L`この州の砦は、まだ見ていません。`, /not seen this province's keep/);
  assert.match(L`最後に見たときのようすです（いまは見えていません）。`, /As you last saw it/);
  setLang('ja');
  F.resetFogNow();
  // without the fog the chronicle lists them as before
  assert.equal(chronicleRows(FS.chronicle, () => false, 60, FS).length > 0, true);
  assert.match(String(renderSurveyHelp(FS)), /spectate\.html/);
});
