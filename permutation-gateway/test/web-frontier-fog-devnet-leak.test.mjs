// The fog of war on the DEVNET page path (fog-devnet; owner t387u: the local test world's player view, map/fog.mjs, now
// also for a devnet season's play page). The LEAK tests of the devnet data paths: the page's records there come from the
// herald (overviews, the wide land, the conquest control / keeps / day files, the chronicle) and the gateway (the devnet
// play info, the wide claim targets), never from a local relay or launcher. Each test builds the play page's state as a
// DEVNET page holds it — `FS.pin.cluster === 'devnet'`, `FS.devnetPlay` set, no `FS.localPlay` — and checks that what
// every surface reads holds nothing of another nation out of the viewer's sight. Pure; no network, no keys, no chain.
// The local world's leak tests: web-frontier-fog-local-leak*.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as F from '../../permutation-server/web/frontier/map/fog.mjs';
import * as S from '../../permutation-server/web/frontier/map/survey.mjs';
import { tileHex } from '../../permutation-server/web/frontier/fgeo.mjs';
import * as inspect from '../../permutation-server/web/frontier/hud/inspect.mjs';
import { chronicleRows } from '../../permutation-server/web/frontier/screens/chronicle.mjs';
import { keepFor } from '../../permutation-server/web/frontier/screens/conquest.mjs';
import { keepFeedOf } from '../../permutation-server/web/frontier/map/keepmount.mjs';
import { renderSurveyHelp, fogLegendText } from '../../permutation-server/web/frontier/map/legend.mjs';
import { wideTargetsOf, devnetWide } from '../../permutation-server/web/frontier/fdevnetplay.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';

// ------------------------------------------------------------------ a devnet page's world
const VIEWER = 3, ENEMY = 0, OTHER = 5;
const HOME = { p: 2, q: 0, tile: 7 };
const SITES = Array.from({ length: 12 }, (_, j) => 7 + 2 * j);
const terrainOf = () => ({ sites: SITES, terrain: Array(61).fill(0), names: ['Grassland'] });
const rec = (p, q, over = {}) => ({ p, q, owners: Array(12).fill(7), sites: Array(12).fill(0), hosts: Array(7).fill(0), clash: false, dormant: false, opened: true, resolvedNext: 0,
  occupiers: Array(12).fill(7), siegeStates: Array(12).fill(0), siteKinds: Array(12).fill(3), keepTile: null, keepTroops: 0, immune: Array(12).fill(false), ...over });
const withVillage = (r, site, f) => { r.owners[site] = f; r.sites[site] = 1; return r; };
// the herald's overview of ring 2: the viewer's home (2, 0); an enemy village + keep + clash + hosts at (-2, 0); an enemy
// keep under another nation's contest at (0, -2); a third nation's village at (-1, 2)
const overviews = () => new Map([[2, { ring: 2, bell: 40, provinces: [
  withVillage(rec(2, 0, { hosts: [0, 0, 0, 2, 0, 0, 0], keepTile: 40, keepTroops: 50, control: VIEWER }), 0, VIEWER),
  withVillage(rec(-2, 0, { hosts: [5, 0, 0, 0, 0, 0, 0], clash: true, keepTile: 30, keepTroops: 400, control: ENEMY, contender: OTHER, contestProgress: 3, contestRequired: 72 }), 4, ENEMY),
  rec(0, -2, { keepTile: 30, keepTroops: 250, control: ENEMY, contender: OTHER, contestProgress: 9, contestRequired: 72 }),
  withVillage(rec(-1, 2), 3, OTHER),
] }]]);
const keepMap = () => new Map([
  ['2,0', { p: 2, q: 0, tile: 40, holder: VIEWER, troops: 50, heartland: false, contender: 7, progress: 0, asOfBell: 40 }],
  ['0,-2', { p: 0, q: -2, tile: 30, holder: ENEMY, troops: 250, heartland: false, contender: OTHER, progress: 9, asOfBell: 40 }],
  ['-2,0', { p: -2, q: 0, tile: 30, holder: ENEMY, troops: 400, heartland: false, contender: OTHER, progress: 3, asOfBell: 40 }],
]);
const PIN = { cluster: 'devnet', programId: 'Prog1111111111111111111111111111111111111111', seasonId: '7', addresses: { season: 'Seas111111111111111111111111111111111111111' } };
const DEVNET_PLAY = { relay: 'http://127.0.0.1:41705', programId: PIN.programId, seasonAddress: PIN.addresses.season, seasonId: '7' };
const memStore = () => { const m = new Map(); return { get: k => m.get(k) ?? null, set: (k, v) => { m.set(k, v); return true; }, m }; };
const surveyOf = (anchors, memory = null) => { const sv = S.buildSurvey({ ringsOpen: 3, anchors, memory }); sv.rev = Math.random(); sv.ownHosts = new Set(); sv.faction = VIEWER; return sv; };
const homeAnchors = () => S.anchorsOf({ villages: [{ ...HOME, tier: 0 }] });
const sightOn = (p, q, tile, radius = 2) => { const h = tileHex(p, q, tile); return { q: h.q, r: h.r, radius, level: S.L3, kind: 'host' }; };
const chronicle = () => [
  { seq: 1, record: { name: 'CLASH', bell: 40, p: -2, q: 0 } },
  { seq: 2, record: { name: 'DEPART', bell: 40, host_id: 'h-enemy', origin_p: -2, origin_q: 0, origin_tile: SITES[4], depart_bell: 40, arrive_bell: 46 } },
];

/**
 * The devnet page: FS as app.mjs/controller.mjs hold it on a devnet season (pin from the herald's record, devnet play
 * verified, no local play), and the fog view the page's fogger makes — `active` exactly as app.mjs fogUpdate says.
 */
function devnetPage({ anchors = homeAnchors(), storage = memStore(), wallet = 'Wal1', over = {}, seenTiles = null } = {}) {
  const sv = surveyOf(anchors, seenTiles);
  const FS = { mode: 'play', pin: PIN, record: { cluster: 'devnet' }, devnetPlay: DEVNET_PLAY, localPlay: null, wallet: { address: wallet },
    citizen: { faction: VIEWER }, holdings: [{ ...HOME, site: 0, tier: 0 }], nowBell: 41, land: { stage: 'final' }, survey: sv, overviews: overviews(),
    provinces: new Map(), roster: { ownerOf: () => null, tierOf: () => 0 }, season: { programVersion: 3, endBell: 1008 },
    conquest: { keeps: keepMap(), events: [{ kind: 'keep_contest', seq: 1, bell: 40, p: 0, q: -2, from: ENEMY, to: OTHER }, { kind: 'keep_contest', seq: 2, bell: 40, p: 2, q: 0, from: VIEWER, to: ENEMY }] },
    chronicle: chronicle(), ...over };
  const fogger = F.createFogger({ storage });
  const memKey = F.fogMemoryKey({ cluster: PIN.cluster, programId: PIN.programId, seasonId: PIN.seasonId }, wallet, PIN.addresses.season);
  FS.fog = fogger({ active: F.fogActive(FS) && FS.holdings.length > 0, survey: sv, overviews: FS.overviews, viewer: VIEWER, terrainOf, memKey });
  return { FS, fogger, sv, storage, memKey };
}
const recsOf = ovs => [...ovs.values()].flatMap(o => o.provinces);
const done = () => F.resetFogNow();

// ------------------------------------------------------------------ 1. the gate
test('DEVNET gate: one switch per mode; a devnet season\'s play page is fogged by its pin, every other page as before', () => {
  assert.equal(F.LOCAL_FOG, true);
  assert.equal(F.DEVNET_FOG, true, 'the devnet switch is on in this branch (false: a devnet page shows the full map as before)');
  assert.equal(F.fogModeOf({ mode: 'play', pin: PIN }), 'devnet');
  assert.equal(F.fogActive({ mode: 'play', pin: PIN }), true, 'on by the pin alone: also before (or without) the gateway\'s devnet play answer');
  assert.equal(F.fogActive({ mode: 'play', pin: null, record: { cluster: 'devnet' } }), true, 'the herald record\'s cluster before the pin');
  assert.equal(F.fogActive({ mode: 'play', pin: { ...PIN, cluster: 'localnet' } }), false, 'a localnet season that is not local play: never');
  assert.equal(F.fogActive({ mode: 'play', pin: { ...PIN, cluster: 'mainnet-beta' } }), false);
  assert.equal(F.fogActive({ mode: 'spectate', pin: PIN }), false, 'the spectator page of a devnet season is not a player view');
  assert.equal(F.fogActive({ mode: 'practice', pin: PIN }), false);
  assert.equal(F.fogModeOf({ mode: 'play', localPlay: { address: 'x' }, pin: PIN }), 'local', 'local play keeps its own switch');
  assert.equal(F.fogSwitchOn('devnet'), F.DEVNET_FOG);
  assert.equal(F.fogSwitchOn(null), false);
});

// ------------------------------------------------------------------ 2. last-known memory: season + wallet
test('DEVNET memory: the last-known records are keyed by season (program, Season id AND Season account) and wallet', () => {
  const key = (w, season = PIN.addresses.season, id = PIN.seasonId) => F.fogMemoryKey({ cluster: 'devnet', programId: PIN.programId, seasonId: id }, w, season);
  assert.equal(key('Wal1'), `ps-ffog:v1:devnet:${PIN.programId}:7@${PIN.addresses.season}:Wal1`);
  assert.notEqual(key('Wal1'), key('Wal2'), 'another wallet');
  assert.notEqual(key('Wal1'), key('Wal1', 'Other1111111111111111111111111111111111111')), 'a season re-created under the same program and id';
  assert.notEqual(key('Wal1'), key('Wal1', PIN.addresses.season, '8'), 'another Season id');
  assert.equal(F.fogMemoryKey({ cluster: 'localnet', programId: 'P', seasonId: '1' }, 'W'), 'ps-ffog:v1:localnet:P:1:W', 'local worlds key as before');
  // a province seen by wallet 1 is remembered for wallet 1 only, in this season only
  const storage = memStore();
  const seen = devnetPage({ storage, anchors: [...homeAnchors(), sightOn(-2, 0, SITES[4], 3), sightOn(-2, 0, 30, 2)] });
  assert.equal(recsOf(seen.FS.fog.overviews).find(r => r.p === -2 && r.q === 0).owners[4], ENEMY, 'in sight: live');
  seen.FS.fog.memory.save();
  // (the survey's own memory — map/survey.mjs, keyed by the same season + wallet — says those tiles were seen: L2)
  const seenTiles = new Set(); S.remember(seenTiles, seen.sv);
  const later = devnetPage({ storage, seenTiles });
  const mem = recsOf(later.FS.fog.overviews).find(r => r.p === -2 && r.q === 0);
  assert.equal(mem.fog, 'memory');
  assert.equal(mem.owners[4], ENEMY, 'out of sight now: the last-known village');
  assert.deepEqual(mem.hosts, Array(7).fill(0), 'no host kept (units are never remembered)');
  // another wallet on this device: its survey memory (keyed by wallet, too) has not seen it — and even with the tiles
  // surveyed, its last-known records hold nothing of wallet 1's
  assert.equal(recsOf(devnetPage({ storage, wallet: 'Wal2' }).FS.fog.overviews).find(r => r.p === -2 && r.q === 0).fog, 'unseen');
  assert.deepEqual(recsOf(devnetPage({ storage, wallet: 'Wal2', seenTiles }).FS.fog.overviews).find(r => r.p === -2 && r.q === 0).owners, Array(12).fill(7));
  done();
});

// ------------------------------------------------------------------ 3. herald overviews
test('DEVNET LEAK: the herald\'s overviews reach the map with no other nation\'s village, keep, host or clash out of sight', () => {
  const { FS } = devnetPage();
  assert.equal(FS.fog.on, true);
  for (const r of recsOf(FS.fog.overviews)) {
    if (r.p === 2 && r.q === 0) { assert.deepEqual([r.owners[0], r.control, r.keepTile], [VIEWER, VIEWER, 40], 'the viewer\'s own province whole'); continue; }
    assert.deepEqual(r.owners, Array(12).fill(7), `${r.p},${r.q} owners`);
    assert.deepEqual(r.hosts, Array(7).fill(0), `${r.p},${r.q} hosts`);
    assert.deepEqual([r.clash, r.keepTile, r.control, r.contender], [false, null, undefined, undefined], `${r.p},${r.q}`);
  }
  assert.equal(F.viewOverviews(FS), FS.fog.overviews, 'every surface handed FS reads the fogged copy');
  // the inspector on the unseen enemy village
  FS.selected = { p: -2, q: 0, idx: SITES[4] };
  const m = inspect.inspectModel(FS, terrainOf);
  assert.deepEqual([m.owners, m.clash, m.tile.site, m.tile.hosts], [[], false, null, []]);
  done();
});

// ------------------------------------------------------------------ 4. the herald's wide land
test('DEVNET LEAK: the herald\'s wide land shows never-seen wide provinces not at all, the viewer\'s nation\'s always', () => {
  const sv = surveyOf(homeAnchors());
  const cell = (p, q, holder, villages) => ({ p, q, key: `${p},${q}`, ring: 130, holder, villages, holdings: villages.length, terrain: { sites: SITES } });
  const land = { key: 'wide', cells: [cell(9, 0, ENEMY, [{ site: 2, nation: ENEMY }]), cell(-9, 0, OTHER, [{ site: 1, nation: OTHER }]), cell(0, 9, VIEWER, [{ site: 0, nation: VIEWER }])], reach: 131, rings: { min: 130, max: 130 } };
  const out = F.fogWideLand(land, { survey: sv, mem: F.createFogMemory({ storage: memStore() }), viewer: VIEWER });
  assert.deepEqual(out.cells.map(c => c.key), ['0,9'], 'only the province the viewer\'s nation holds');
  assert.doesNotMatch(JSON.stringify(out.cells), /"nation":0|"nation":5|"holder":0|"holder":5/);
  // a devnet page's fogger hands the map that copy
  const fogger = F.createFogger({ storage: memStore() });
  const v = fogger({ active: F.fogActive({ mode: 'play', pin: PIN }), survey: sv, overviews: new Map(), wide: land, viewer: VIEWER, memKey: null });
  assert.deepEqual(v.wide.cells.map(c => c.key), ['0,9']);
  done();
});

// ------------------------------------------------------------------ 5. the devnet wide claim targets (gateway/herald)
test('DEVNET LEAK: the wide claim card (FS.devnetWideLand, the herald\'s raw wide land) carries coordinates only, never a holder or village', () => {
  const raw = { cells: [
    { p: -129, q: 66, ring: 129, holder: ENEMY, villages: [{ site: 0, nation: ENEMY }], terrain: { sites: SITES }, key: '-129,66' },
    { p: -129, q: 65, ring: 129, holder: OTHER, villages: [], key: '-129,65' },
    { p: -128, q: 66, ring: 128, holder: VIEWER, villages: [], key: '-128,66' },
  ] };
  const targets = wideTargetsOf(raw);
  assert.deepEqual(targets, [{ p: '-129', q: '66' }, { p: '-129', q: '65' }], 'opened wide provinces (ring > 128) by coordinates');
  for (const t of targets) assert.deepEqual(Object.keys(t).sort(), ['p', 'q']);
  assert.equal(devnetWide({ devnetPlay: null, record: { rMaxCeiling: 128, ringsOpened: 130 } }), false, 'off without devnet play');
});

// ------------------------------------------------------------------ 6. keeps (herald control) and the keep board (day files)
test('DEVNET LEAK: keeps read from the herald\'s control snapshot and keep day files: the lists, the panel and the board name no unseen keep', () => {
  setLang('ja');
  const { FS } = devnetPage();
  assert.deepEqual([...F.viewKeeps(FS.conquest.keeps).keys()], ['2,0']);
  assert.equal(keepFor(FS, 0, -2), null);
  assert.equal(keepFor(FS, -2, 0), null);
  const feed = keepFeedOf({ ...FS, season: { ...FS.season, conquest: true } });
  if (feed.events) assert.deepEqual(feed.events.map(e => `${e.p},${e.q}`), ['2,0'], 'the board plays only the viewer\'s side\'s or seen keeps\' events');
  done();
  assert.equal(F.viewKeeps(FS.conquest.keeps).size, 3, 'without the fog (another page): as before');
});

// ------------------------------------------------------------------ 7. the herald's chronicle
test('DEVNET LEAK: the herald\'s chronicle tells no out-of-sight clash or march; the same records in sight are told', () => {
  setLang('ja');
  const { FS } = devnetPage();
  const rows = chronicleRows(FS.chronicle, () => false, 60, FS);
  assert.deepEqual(rows.map(r => r.keep ?? null), ['keep_contest'], 'only the contest of the viewer\'s own keep (2,0): the viewer\'s nation is a side');
  assert.doesNotMatch(JSON.stringify(rows), /-2,0|0,-2/, 'the clash and the departure at -2,0 and the contest at 0,-2 are out of sight');
  assert.equal(F.viewRecord(FS.chronicle[1].record), false);
  // the march's origin comes into sight (a host of the viewer's stands beside it): the departure is told
  const seen = devnetPage({ anchors: [...homeAnchors(), sightOn(-2, 0, SITES[4], 2)] });
  assert.equal(F.viewRecord(seen.FS.chronicle[1].record), true, 'an enemy march appears once its origin is in vision');
  done();
});

// ------------------------------------------------------------------ 8. incoming warnings from devnet departures
test('DEVNET LEAK: incoming warnings name an unseen enemy column only within FOG_RULES.incomingTurns of arrival', () => {
  const { FS } = devnetPage();
  const departures = [{ faction: ENEMY, origin_p: -2, origin_q: 0, origin_tile: SITES[4], arrive_bell: 46 }];
  const list = [{ bell: 46, holding: { p: 2, q: 0, site: 0 } }];
  assert.deepEqual(FS.fog.incoming(list, { nowBell: 41, departures }), [], '5 turns out, origin unseen: not told');
  assert.equal(FS.fog.incoming(list, { nowBell: 46 - F.FOG_RULES.incomingTurns, departures }).length, 1, 'inside the village\'s own sight: told');
  const seen = devnetPage({ anchors: [...homeAnchors(), sightOn(-2, 0, SITES[4], 2)] });
  assert.equal(seen.FS.fog.incoming(list, { nowBell: 41, departures }).length, 1, 'origin in sight: told at once');
  done();
});

// ------------------------------------------------------------------ 9. clash reports
test('DEVNET LEAK: a clash report is offered only with its keep tile in sight — a province seen only at its rim is not enough', () => {
  // a host of the viewer's sees the rim of (0, -2) but not its keep tile 30
  const rim = [...Array(61).keys()].reverse().find(t => { const sv = surveyOf([sightOn(0, -2, t, 1)]); return sv.levelOf(0, -2, 30) !== S.L3; });
  const edge = devnetPage({ anchors: [...homeAnchors(), sightOn(0, -2, rim, 1)] });
  assert.equal(edge.sv.levelOf(0, -2, rim), S.L3, 'part of the province is in sight');
  assert.notEqual(edge.sv.levelOf(0, -2, 30), S.L3, 'its keep tile is not');
  assert.equal(F.viewClash({ p: 0, q: -2, keepTile: 30 }), false, 'no report, no replay, no scene');
  assert.equal(F.viewRecord({ name: 'CLASH', bell: 40, p: 0, q: -2 }), false, 'no chronicle line');
  const keep = devnetPage({ anchors: [...homeAnchors(), sightOn(0, -2, 30, 1)] });
  assert.equal(keep.sv.levelOf(0, -2, 30), S.L3);
  assert.equal(F.viewClash({ p: 0, q: -2, keepTile: 30 }), true, 'keep tile in sight: offered');
  assert.equal(F.viewClash({ p: -2, q: 0, keepTile: 30, mine: true }), true, 'the viewer\'s own clash: always');
  done();
  assert.equal(F.viewClash({ p: 0, q: -2, keepTile: 30 }), true, 'no fog: as before');
});

// ------------------------------------------------------------------ 10. the spectate links and the 記録 sheet
test('DEVNET LEAK: a devnet play page offers no full-map view — no spectate link (legend, settings), no 「記録」 sheet, blank chart', () => {
  setLang('ja');
  done();
  // before the first village there is no fog view yet: the legend still says the fog, never the spectate link
  const help = String(renderSurveyHelp({ mode: 'play', pin: PIN, devnetPlay: DEVNET_PLAY, holdings: [] }));
  assert.doesNotMatch(help, /spectate\.html/);
  assert.ok(help.includes(fogLegendText()));
  assert.match(String(renderSurveyHelp({ mode: 'play', pin: { ...PIN, cluster: 'localnet' }, holdings: [] })), /spectate\.html/, 'a non-fogged page: as before');
  const app = readFileSync(new URL('../../permutation-server/web/frontier/app.mjs', import.meta.url), 'utf8');
  assert.ok(app.includes("${fogActive(FS) ? '' : html` · <a href=\"spectate.html\">${L`観戦ページ`}</a>`}"), 'settings: the spectate link only without the fog');
  assert.ok(app.includes('herald.pin(record.season, FS.pin.addresses);\n  fogWorldPinned();'), 'the devnet world is laid right after the pin');
  const laid = app.slice(app.indexOf('function fogWorldPinned()'), app.indexOf('/** The overviews the map shows'));
  assert.match(laid, /if \(mode !== 'devnet' \|\| !fogActive\(FS\) \|\| fogWorldLaid === mode\) return;/);
  assert.match(laid, /setBlankChart\(FOG_RULES\.blankChart\);/, 'never-seen land is plain paper on the devnet page too');
  assert.match(laid, /wideModeRef\?\.unmount\?\.\(\);[\s\S]*wideModeRef = null;/, 'the recorded wide world (every keep nation and village) is taken off');
  assert.ok(app.includes("const fogWorld = (LOCAL_FOG && !!cfg.localPlay && FS.mode === 'play') || !!fogWorldLaid;\n    if (!fogWorld) try { wideModeRef = mountWideMode("));
  assert.ok(app.includes("memKey: sc && w ? fogMemoryKey(sc, w, fogModeOf(FS) === 'devnet' ? FS.pin?.addresses?.season ?? null : null) : null });"), 'memory: season + wallet');
});

// ------------------------------------------------------------------ 11. no reveal at the season's end
test('DEVNET LEAK: the season\'s end reveals nothing — past endBell the devnet page is still fogged', () => {
  const { FS } = devnetPage({ over: { nowBell: 2000, worldEnded: true, season: { programVersion: 3, endBell: 1008 } } });
  assert.equal(F.fogActive(FS), true);
  assert.equal(FS.fog.on, true);
  const enemy = recsOf(FS.fog.overviews).find(r => r.p === -2 && r.q === 0);
  assert.equal(enemy.fog, 'unseen');
  assert.deepEqual(enemy.owners, Array(12).fill(7));
  const src = readFileSync(new URL('../../permutation-server/web/frontier/map/fog.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src.slice(src.indexOf('export function fogModeOf'), src.indexOf('export const fogActive')), /endBell|worldEnded|final/, 'the gate never reads the end');
  done();
});

// ------------------------------------------------------------------ 12. alliances share nothing
test('DEVNET LEAK: another nation\'s villages and keeps (an ally included) give the viewer no vision', () => {
  const src = F.nationSources({ overviews: overviews(), faction: VIEWER, terrainOf, control: [{ p: -2, q: 0, control: ENEMY }, { p: 2, q: 0, control: VIEWER }] });
  assert.deepEqual(src.territory, [{ p: 2, q: 0 }], 'only the viewer\'s own nation\'s province');
  assert.ok(src.villages.every(v => v.p === 2 && v.q === 0));
  assert.deepEqual(F.nationSources({ overviews: overviews(), faction: null, terrainOf }), { villages: [], territory: [] }, 'no nation yet: no nation vision');
});

// ================================================================== verify-pr127: the independent verifier's leak tests
// (written by the verifier: the surfaces the twelve above do not drive — the gate's edges, the LIVE roster in search and
//  the inspector, a read Province account's hosts, the feed's keep captures, the keep panel, the reach list's "loading",
//  an ally's march, the wide-map button, and DEVNET_FOG turned off on a copy of the web tree)
import * as search from '../../permutation-server/web/frontier/hud/search.mjs';
import * as feed from '../../permutation-server/web/frontier/hud/feed.mjs';
import { renderKeep, reachLoading } from '../../permutation-server/web/frontier/screens/conquest.mjs';
import { identityOf, displayName } from '../../permutation-server/web/frontier/people/identity.mjs';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ENEMY_TAG = 'ab'.repeat(32);
// the live roster (app.mjs rosterRef): it knows every lord of every read ring — the enemy's at (-2, 0) site 4 included
const liveRoster = () => ({
  entries: () => [{ p: -2, q: 0, site: 4, tag: ENEMY_TAG }],
  ownerOf: (p, q, site) => (p === -2 && q === 0 && site === 4 ? { tag: ENEMY_TAG } : null),
  tierOf: (p, q, site) => (p === -2 && q === 0 && site === 4 ? 3 : null),
});
const inSightOfEnemy = () => [...homeAnchors(), sightOn(-2, 0, SITES[4], 2)];
const recMap = FS => new Map(recsOf(FS.fog.overviews).map(r => [`${r.p},${r.q}`, r]));

test('VERIFY v1: the gate\'s edges — the pin outranks the record, exact cluster name, spectate/practice never, no pin no fog', () => {
  assert.equal(F.fogModeOf({ pin: { ...PIN, cluster: 'localnet' }, record: { cluster: 'devnet' } }), null, 'a pin saying localnet wins over a record saying devnet');
  assert.equal(F.fogModeOf({ pin: null, record: { cluster: 'devnet' } }), 'devnet', 'no mode: the play page');
  assert.equal(F.fogModeOf({ mode: 'spectate', localPlay: { a: 1 }, pin: PIN }), null);
  assert.equal(F.fogModeOf({ mode: 'play', pin: { ...PIN, cluster: 'Devnet' } }), null, 'only the herald\'s exact cluster name');
  assert.equal(F.fogModeOf({ mode: 'play' }), null);
  assert.equal(F.fogActive({ mode: 'play', pin: PIN, devnetPlay: null }), true, 'the gateway\'s devnet play answer is not needed');
});

test('VERIFY v2: map search finds no unseen enemy lord through the LIVE roster on a devnet page; in sight it does', () => {
  const q = displayName(identityOf(ENEMY_TAG), { full: true, language: 'en' }).slice(0, 5);
  const hits = page => search.searchMap(q, { recs: recMap(page.FS), roster: liveRoster(), sitesOf: () => SITES, survey: page.FS.survey }).filter(x => x.kind === 'lord');
  assert.equal(hits(devnetPage()).length, 0, `"${q}": the lord out of sight is not found`);
  done();
  assert.equal(hits(devnetPage({ anchors: inSightOfEnemy() })).length, 1, `"${q}": in sight he is`);
  done();
  // nation search: the enemy's lands are not found out of sight
  const fname = q2 => search.searchMap(q2, { recs: recMap(devnetPage().FS), survey: devnetPage().FS.survey, sitesOf: () => SITES }).filter(x => x.kind === 'faction' && x.p === -2);
  setLang('ja');
  assert.deepEqual(fname('国'), []);
  done();
});

test('VERIFY v3: the inspector names no lord and no tier for an unseen enemy village even though the live roster knows him', () => {
  const { FS } = devnetPage({ over: { roster: liveRoster(), selected: { p: -2, q: 0, idx: SITES[4] } } });
  const m = inspect.inspectModel(FS, terrainOf);
  assert.equal(m.tile.site?.owner ?? null, null);
  assert.equal(m.tile.site?.tier ?? null, null);
  assert.doesNotMatch(JSON.stringify(m), new RegExp(ENEMY_TAG));
  done();
  const seen = devnetPage({ anchors: inSightOfEnemy(), over: { roster: liveRoster(), selected: { p: -2, q: 0, idx: SITES[4] } } });
  const m2 = inspect.inspectModel(seen.FS, terrainOf);
  assert.notEqual(m2.tile.site?.owner ?? null, null, 'in sight: the lord is named');
  done();
});

test('VERIFY v4: a Province account the page read (RPC/herald) shows no other nation\'s host on an unseen tile', () => {
  const prov = { province: { sites: SITES, siteMirror: [], entries: [{ id: 99n, tile: SITES[4], state: 1, faction: ENEMY, unit: 0, troops: 400000n }] } };
  const { FS } = devnetPage({ over: { provinces: new Map([['-2,0', prov]]), selected: { p: -2, q: 0, idx: SITES[4] } } });
  assert.deepEqual(inspect.inspectModel(FS, terrainOf).tile.hosts, []);
  done();
  const seen = devnetPage({ anchors: inSightOfEnemy(), over: { provinces: new Map([['-2,0', prov]]), selected: { p: -2, q: 0, idx: SITES[4] } } });
  assert.equal(inspect.inspectModel(seen.FS, terrainOf).tile.hosts.length, 1, 'in sight: shown');
  done();
});

test('VERIFY v5: the feed tells no keep capture out of sight (a capture is "news to everyone" without the fog)', () => {
  const events = [{ kind: 'keep_taken', seq: 7, bell: 40, p: 0, q: -2, from: ENEMY, to: OTHER }];
  const { FS } = devnetPage({ over: { conquest: { keeps: keepMap(), events } } });
  assert.deepEqual([...feed.snapshot(FS, 0).keeps.keys()], [], 'unseen keep (0,-2): no capture news');
  done();
  const kt = devnetPage({ anchors: [...homeAnchors(), sightOn(0, -2, 30, 1)], over: { conquest: { keeps: keepMap(), events } } });
  assert.deepEqual([...feed.snapshot(kt.FS, 0).keeps.keys()], ['keep_taken:7'], 'keep tile in sight: told');
  done();
  assert.deepEqual([...feed.snapshot({ ...FS, fog: null }, 0).keeps.keys()], ['keep_taken:7'], 'no fog (a non-devnet page): as before');
});

test('VERIFY v6: the keep panel of an unseen keep says "not seen yet" — never its holder, troops or "loading"; the reach list never "loading"', () => {
  setLang('ja');
  const { FS } = devnetPage({ over: { season: { programVersion: 3, endBell: 1008 }, conquest: { keeps: keepMap(), events: [], keepsPending: 4 } } });
  const out = String(renderKeep(FS, null));
  assert.match(out, /まだ見ていません/);
  assert.doesNotMatch(out, /確認しています/);
  assert.equal(reachLoading(FS), false, 'nothing unseen is "pending"');
  done();
  assert.equal(reachLoading(FS), true, 'without the fog: as before');
});

test('VERIFY v7: an ally\'s (non-hostile nation\'s) march out of sight is not told — alliances share no vision on devnet', () => {
  // relations say ENEMY and VIEWER are allied; ENEMY's departure from its unseen home is still unseen
  const { FS } = devnetPage({ over: { relations: { allied: [[VIEWER, ENEMY]] } } });
  assert.equal(F.viewRecord(FS.chronicle[1].record), false, 'the ally\'s DEPART');
  assert.equal(F.viewClash({ p: -2, q: 0, keepTile: 30 }), false, 'the ally\'s clash');
  const src = F.nationSources({ overviews: overviews(), faction: VIEWER, terrainOf, control: [{ p: -2, q: 0, control: ENEMY }] });
  assert.ok(src.villages.every(v => !(v.p === -2 && v.q === 0)), 'no anchor at the ally\'s village');
  assert.equal(FS.fog.incoming([{ bell: 46, holding: { p: 2, q: 0, site: 0 } }], { nowBell: 41, departures: [{ faction: ENEMY, origin_p: -2, origin_q: 0, origin_tile: SITES[4], arrive_bell: 46 }] }).length, 0);
  done();
});

test('VERIFY v8: last-known memory keeps a seen enemy keep\'s province owner but never its hosts, and nothing crosses Season accounts', () => {
  const storage = memStore();
  const seen = devnetPage({ storage, anchors: inSightOfEnemy() });
  assert.equal(recMap(seen.FS).get('-2,0').hosts[0], 5, 'in sight: the host count');
  seen.FS.fog.memory.save();
  const seenTiles = new Set(); S.remember(seenTiles, seen.sv);
  done();
  const later = devnetPage({ storage, seenTiles });
  const r = recMap(later.FS).get('-2,0');
  assert.equal(r.fog, 'memory');
  assert.deepEqual([r.hosts, r.clash], [Array(7).fill(0), false], 'units and clashes only in current vision');
  done();
  // the same program and Season id, another Season account: the memory key differs, so nothing is loaded
  const otherKey = F.fogMemoryKey({ cluster: 'devnet', programId: PIN.programId, seasonId: PIN.seasonId }, 'Wal1', 'Other1111111111111111111111111111111111111');
  assert.notEqual(otherKey, later.memKey);
  assert.equal(storage.get(otherKey), null);
  assert.ok(storage.m.has(later.memKey), 'the save went under this season\'s key');
  done();
});

test('VERIFY v9: the wide village card offers no 「記録の地図」 button under the devnet fog (the sheet is unmounted there)', () => {
  const src = readFileSync(new URL('../../permutation-server/web/frontier/screens/wideholding.mjs', import.meta.url), 'utf8');
  assert.ok(src.includes("${fogNow().on ? '' : html`<div class=\"actions\"><button type=\"button\" class=\"btn\" data-act=\"wide-map\">"), 'the button is gated on the fog view');
  const app = readFileSync(new URL('../../permutation-server/web/frontier/app.mjs', import.meta.url), 'utf8');
  assert.match(app, /'wide-map': \(\) => \{[\s\S]{0,400}wideModeRef\?\.focusHolding/, 'and with the sheet gone the action is a no-op (optional chaining)');
});

test('VERIFY v10: DEVNET_FOG = false on a copy of the web tree restores the old devnet page exactly; LOCAL_FOG is unaffected', async () => {
  const root = new URL('../../permutation-server/web/', import.meta.url);
  const tmp = mkdtempSync(join(tmpdir(), 'v127-'));
  try {
    cpSync(root, join(tmp, 'web'), { recursive: true });
    const fogPath = join(tmp, 'web', 'frontier', 'map', 'fog.mjs');
    const s = readFileSync(fogPath, 'utf8');
    assert.ok(s.includes('export const DEVNET_FOG = true;'));
    writeFileSync(fogPath, s.replace('export const DEVNET_FOG = true;', 'export const DEVNET_FOG = false;'));
    const F2 = await import(join(tmp, 'web', 'frontier', 'map', 'fog.mjs'));
    const Leg = await import(join(tmp, 'web', 'frontier', 'map', 'legend.mjs'));
    const Lang = await import(join(tmp, 'web', 'lang.mjs'));
    Lang.setLang('ja');
    assert.equal(F2.fogActive({ mode: 'play', pin: PIN }), false, 'a devnet page: no fog');
    assert.equal(F2.fogActive({ mode: 'play', localPlay: { a: 1 } }), true, 'a local world: still fogged');
    assert.match(String(Leg.renderSurveyHelp({ mode: 'play', pin: PIN, holdings: [] })), /spectate\.html/, 'the spectate link is back on the devnet page');
    // the fogger, handed `active: fogActive(FS)` as app.mjs does, passes the herald's records through untouched
    const v = F2.createFogger({ storage: memStore() })({ active: F2.fogActive({ mode: 'play', pin: PIN }), survey: surveyOf(homeAnchors()), overviews: overviews(), viewer: VIEWER, terrainOf, memKey: null });
    assert.equal(v.on, false);
    assert.equal(F2.viewKeeps(keepMap()).size, 3);
    assert.equal(F2.viewClash({ p: 0, q: -2, keepTile: 30 }), true);
    // app.mjs: with the switch off fogWorldPinned returns at once (fogActive false), the settings link is shown, the
    // memory key is passed the Season account only in the devnet mode (unused without the fog)
    const app = readFileSync(join(tmp, 'web', 'frontier', 'app.mjs'), 'utf8');
    assert.match(app, /if \(mode !== 'devnet' \|\| !fogActive\(FS\) \|\| fogWorldLaid === mode\) return;/);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
