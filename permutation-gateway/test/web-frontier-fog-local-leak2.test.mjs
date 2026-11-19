// The fog of war of a LOCAL TEST world (map/fog.mjs): more LEAK tests, from the independent verification of PR #93
// (verify-pr93). Each one is a surface the first round did not fog, or a choice of the owner (t387u: no shared vision
// with allies, no reveal at the season's end, incoming told only ≤ 3 turns out or with the origin in sight):
//   1. the map's keep board played a capture of a LAST-KNOWN keep out of sight (keep events: map/keepmount.mjs)
//   2. the search box found a lord by name on a site seen before, from the live roster (hud/search.mjs)
//   3. the inspector named the lord and the tier of a village seen before, and listed another's S1 vault on an
//      unseen tile (hud/inspect.mjs)
//   4. the hover tip and the name tags named the live lord of a village out of sight (app.mjs fogLords)
//   5. an ally's villages and held provinces give no vision
//   6. the season's end reveals nothing: the fog stays on
//   7. incoming: told only when the origin is in sight or the arrival is at most 3 turns away
// Local-only (imports hud/inspect.mjs through src/), like web-frontier-fog-local-leak.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as F from '../../permutation-server/web/frontier/map/fog.mjs';
import * as S from '../../permutation-server/web/frontier/map/survey.mjs';
import { tileHex } from '../../permutation-server/web/frontier/fgeo.mjs';
import { KeepBook, keepRows } from '../../permutation-server/web/frontier/map/keeps.mjs';
import { keepFeedOf } from '../../permutation-server/web/frontier/map/keepmount.mjs';
import { searchMap } from '../../permutation-server/web/frontier/hud/search.mjs';
import * as inspect from '../../permutation-server/web/frontier/hud/inspect.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';
import * as inspectNames from '../../permutation-server/web/frontier/people/identity.mjs';

const VIEWER = 3, ENEMY = 0, ALLY = 1;
const HOME = { p: 2, q: 0, tile: 7 };
const SITES = Array.from({ length: 12 }, (_, j) => 7 + 2 * j);
const terrainOf = () => ({ sites: SITES, terrain: Array(61).fill(0), names: ['Grassland'] });
const rec = (p, q, over = {}) => ({ p, q, owners: Array(12).fill(7), sites: Array(12).fill(0), hosts: Array(7).fill(0), clash: false, dormant: false, opened: true, resolvedNext: 0,
  occupiers: Array(12).fill(7), siegeStates: Array(12).fill(0), siteKinds: Array(12).fill(3), keepTile: null, keepTroops: 0, immune: Array(12).fill(false), ...over });
const withVillage = (r, site, f) => { r.owners[site] = f; r.sites[site] = 1; return r; };
const memStore = () => { const m = new Map(); return { get: k => m.get(k) ?? null, set: (k, v) => { m.set(k, v); return true; }, m }; };
const homeSight = () => S.anchorsOf({ villages: [{ ...HOME, tier: 0 }] });
const sightOn = (p, q, tile, radius = 2) => { const h = tileHex(p, q, tile); return { q: h.q, r: h.r, radius, level: S.L3, kind: 'host' }; };
const sv = (anchors, extra = {}) => { const s = S.buildSurvey({ ringsOpen: 3, anchors, ...extra }); s.rev = Math.random(); s.ownHosts = new Set(); s.faction = VIEWER; return s; };
const seenTiles = s => new Set([...s.tiles].filter(([, v]) => v === S.L3).map(([k]) => k));
const homeRec = () => withVillage(rec(2, 0, { keepTile: 40, keepTroops: 50, control: VIEWER }), 0, VIEWER);

/**
 * A world in two looks: first the viewer's host stood by the enemy province (-2, 0) — its village (site 4), keep (tile
 * 30) — and saw it; then the host left, so (-2, 0) is LAST-KNOWN. `fog` is the second look's view (the page's).
 */
function lastKnownWorld({ second = r => r } = {}) {
  const fogger = F.createFogger({ storage: memStore() });
  const enemy = () => withVillage(rec(-2, 0, { keepTile: 30, keepTroops: 400, control: ENEMY }), 4, ENEMY);
  const ov1 = new Map([[2, { ring: 2, bell: 40, provinces: [homeRec(), enemy()] }]]);
  const look = sv([...homeSight(), sightOn(-2, 0, 30, 3), sightOn(-2, 0, SITES[4], 1)]);
  fogger({ active: true, survey: look, overviews: ov1, viewer: VIEWER, terrainOf, memKey: 'w' });
  const away = sv(homeSight(), { memory: seenTiles(look) });
  const ov2 = new Map([[2, { ring: 2, bell: 50, provinces: [homeRec(), second(enemy())] }]]);
  const fog = fogger({ active: true, survey: away, overviews: ov2, viewer: VIEWER, terrainOf, memKey: 'w' });
  return { fog, survey: away, ov2 };
}
const recsOf = ovs => new Map([...ovs.values()].flatMap(o => o.provinces).map(r => [`${r.p},${r.q}`, r]));

test('LEAK 1: the keep board plays no capture of a last-known keep out of sight (keep events fogged); the viewer\'s own side and in-sight keeps still play', () => {
  const { fog } = lastKnownWorld({ second: r => ({ ...r, control: ALLY }) });
  const recs = recsOf(fog.overviews);
  assert.equal(recs.get('-2,0').fog, 'memory');
  assert.equal(recs.get('-2,0').control, ENEMY, 'the last-known holder, not the live one');
  const taken = { kind: 'keep_taken', seq: 9, bell: 49, p: -2, q: 0, tile: 30, from: ENEMY, to: ALLY };
  const ownLoss = { kind: 'keep_taken', seq: 10, bell: 49, p: 2, q: 0, tile: 40, from: VIEWER, to: ENEMY };
  const FS = { season: { programVersion: 3, layoutVersion: 2 }, citizen: { faction: VIEWER }, nowBell: 50, conquest: { events: [taken, ownLoss] } };
  const feed = keepFeedOf(FS);
  assert.deepEqual(feed.events.map(e => e.seq), [10], 'the out-of-sight capture is not the board\'s; the viewer\'s own loss is');
  assert.equal(keepFeedOf(FS).events, feed.events, 'kept per events array and fog view (asked once a frame)');
  // the board itself: with the fogged feed, the last-known keep keeps its last-known holder
  const book = new KeepBook();
  book.read({ rows: keepRows(recs), events: [], viewer: VIEWER, now: 0, bell: 50 });
  const moments = book.read({ rows: keepRows(recs), events: feed.events, viewer: VIEWER, now: 1, bell: 50 });
  assert.equal(moments.some(m => m.p === -2 && m.q === 0), false, 'no capture flood at -2,0');
  assert.equal(book.shown('-2,0'), ENEMY);
  // (the unfogged feed would have played it: this is the leak the filter closes)
  const leaky = new KeepBook();
  leaky.read({ rows: keepRows(recs), events: [], viewer: VIEWER, now: 0, bell: 50 });
  assert.ok(leaky.read({ rows: keepRows(recs), events: [taken], viewer: VIEWER, now: 1, bell: 50 }).some(m => m.kind === 'captured' && m.p === -2));
  F.resetFogNow();
  assert.equal(keepFeedOf(FS).events.length, 2, 'without the fog: every event, as before');
});

test('LEAK 2: search finds no lord by name on a site out of sight (the roster is live); in sight and without the fog as before', () => {
  setLang('ja');
  const { fog, survey } = lastKnownWorld();
  const recs = recsOf(fog.overviews);
  const entry = { p: -2, q: 0, site: 4, tag: 'ab'.repeat(16) };
  const roster = { entries: () => [entry] };
  const sitesOf = () => SITES;
  const probe = q => searchMap(q, { recs, roster, sitesOf, survey }).filter(x => x.kind === 'lord');
  const raw = q => searchMap(q, { recs: new Map([...recs].map(([k, r]) => [k, { ...r, fog: undefined }])), roster, sitesOf, survey }).filter(x => x.kind === 'lord');
  setLang('en');
  const q = inspectNames.displayName(inspectNames.identityOf(entry.tag), { full: true, language: 'en' }).slice(0, 4);
  assert.equal(raw(q).length, 1, 'without the fog the lord is found where the viewer surveyed the village');
  assert.equal(probe(q).length, 0, 'under the fog: out of sight now, not found');
  // in sight now: found
  const near = sv([...homeSight(), sightOn(-2, 0, SITES[4], 1)]);
  const fogger = F.createFogger({ storage: memStore() });
  const view = fogger({ active: true, survey: near, overviews: new Map([[2, { ring: 2, bell: 50, provinces: [homeRec(), withVillage(rec(-2, 0), 4, ENEMY)] }]]), viewer: VIEWER, terrainOf, memKey: 'n' });
  assert.equal(searchMap(q, { recs: recsOf(view.overviews), roster, sitesOf, survey: near }).filter(x => x.kind === 'lord').length, 1);
  setLang('ja');
  F.resetFogNow();
});

test('LEAK 3: the inspector does not name the live lord or tier of a village seen before, nor list another\'s S1 vault out of sight', () => {
  setLang('ja');
  const { fog, survey, ov2 } = lastKnownWorld();
  const FS = { mode: 'play', localPlay: { address: 'W' }, citizen: { faction: VIEWER }, holdings: [{ ...HOME, site: 0, tier: 0 }], nowBell: 50, land: { stage: 'final' }, survey, fog,
    overviews: ov2, provinces: new Map(), season: { programVersion: 3 }, conquest: { keeps: new Map() },
    roster: { ownerOf: () => ({ tag: 'cd'.repeat(16) }), tierOf: () => 4 },
    s1: { vaults: [{ p: -2, q: 0, tile: SITES[4], owner: 'x'.repeat(64), faction: ENEMY }], structures: [], caravans: [] } };
  FS.selected = { p: -2, q: 0, idx: SITES[4] };
  const m = inspect.inspectModel(FS, terrainOf);
  assert.equal(m.level, 2, 'seen before, out of sight now');
  assert.equal(m.tile.site?.state, 'holding', 'the last-known village is there');
  assert.equal(m.tile.site.owner, null, 'no live lord named');
  assert.equal(m.tile.site.tier, null, 'no live tier');
  assert.equal(m.tile.s1, undefined, 'no S1 vault of another out of sight');
  // without the fog the same inspector names them (as before)
  F.resetFogNow();
  const m2 = inspect.inspectModel({ ...FS, fog: { on: false } }, terrainOf);
  assert.ok(m2.tile.site?.owner, 'without the fog: the roster names the lord');
});

test('LEAK 4: the hover tip, the name tags and lordOf read the roster through the fog (source wiring, app.mjs)', async () => {
  const { readFileSync } = await import('node:fs');
  const app = readFileSync(new URL('../../permutation-server/web/frontier/app.mjs', import.meta.url), 'utf8');
  assert.ok(app.includes('nameOf: fogLords(ownNamer(scene.namer(rosterRef))),'));
  assert.ok(app.includes('lordOf: fogLords((p, q, site) => {'));
  assert.ok(app.includes("const owner = owner0 && FS.fog?.on && FS.survey?.levelOf?.(hit.p, hit.q, hit.idx) !== 3 && t.owner !== FS.citizen?.faction ? null : owner0;"));
  assert.match(app, /function fogLords\(read\) \{\n  return \(p, q, site, faction\) => \{\n    if \(!FS\.fog\?\.on\) return read\(p, q, site, faction\);/);
});

test('LEAK 5: an ally\'s villages and held provinces give the viewer no vision (alliances share nothing)', () => {
  const ally = withVillage(rec(-1, 2, { keepTile: 20, control: ALLY }), 3, ALLY);
  const mine = withVillage(rec(2, 0, { keepTile: 40, control: VIEWER }), 1, VIEWER);
  const overviews = new Map([[2, { ring: 2, provinces: [ally, mine] }]]);
  const src = F.nationSources({ overviews, faction: VIEWER, terrainOf, control: [{ p: -1, q: 2, control: ALLY }, { p: 2, q: 0, control: VIEWER }] });
  assert.deepEqual(src.territory, [{ p: 2, q: 0 }], 'only the viewer\'s own nation\'s province');
  assert.deepEqual(src.villages.map(v => `${v.p},${v.q}`), ['2,0']);
  const survey = sv([...homeSight(), ...F.nationAnchors(src)]);
  const fog = F.createFogger({ storage: memStore() })({ active: true, survey, overviews, viewer: VIEWER, terrainOf, memKey: 'a' });
  const a = recsOf(fog.overviews).get('-1,2');
  assert.equal(a.fog, 'unseen', 'the ally\'s province is as unseen as anyone\'s');
  assert.deepEqual([a.owners[3], a.keepTile, a.control], [7, null, undefined]);
  F.resetFogNow();
});

test('LEAK 6: the season\'s end reveals nothing — the fog stays on for an ended season (no end-of-season reveal)', () => {
  const enemy = withVillage(rec(-2, 0, { keepTile: 30, control: ENEMY }), 4, ENEMY);
  const overviews = new Map([[2, { ring: 2, provinces: [homeRec(), enemy] }]]);
  const FS = { localPlay: { address: 'W' }, mode: 'play', season: { endBell: 100 }, nowBell: 500 };
  assert.equal(F.fogActive(FS), true, 'the gate has no end condition');
  const fog = F.createFogger({ storage: memStore() })({ active: F.fogActive(FS), survey: sv(homeSight()), overviews, viewer: VIEWER, terrainOf, memKey: 'e' });
  assert.equal(fog.on, true);
  assert.equal(recsOf(fog.overviews).get('-2,0').fog, 'unseen');
  assert.equal(F.fogActive({ ...FS, localPlay: null }), false, 'never outside a local test world');
  assert.equal(F.fogActive({ ...FS, mode: 'spectate' }), false, 'nor on the spectator page');
  F.resetFogNow();
});

test('LEAK 7: incoming — told when the origin is in sight, or once the arrival is ≤ 3 turns away; otherwise not', () => {
  const survey = sv(homeSight());
  const far = { origin_p: -2, origin_q: 0, origin_tile: SITES[4], arrive_bell: 60, faction: ENEMY };
  const warn = bell => ({ bell, holding: { p: 2, q: 0, site: 0 } });
  assert.equal(F.FOG_RULES.incomingTurns, 3);
  assert.deepEqual(F.fogIncoming([warn(60)], { nowBell: 50, departures: [far], survey, viewer: VIEWER }), [], '10 turns out, origin unseen: not told');
  assert.equal(F.fogIncoming([warn(60)], { nowBell: 57, departures: [far], survey, viewer: VIEWER }).length, 1, '3 turns out: told');
  const near = sv([...homeSight(), sightOn(-2, 0, SITES[4], 1)]);
  assert.equal(F.fogIncoming([warn(60)], { nowBell: 50, departures: [far], survey: near, viewer: VIEWER }).length, 1, 'origin in sight: told at once');
});
