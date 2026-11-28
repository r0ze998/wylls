// The fog of war of a LOCAL TEST world (map/fog.mjs): the LEAK tests. One world with another nation's village, keep,
// march and clash OUT of the viewer's sight is run through every surface the play page shows them by (the map's
// records, the keep lists and panel, the inspector, the chronicle, the legend); none of those places or nations may
// reach what the renderers read. The pure model's tests: web-frontier-fog-local.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as F from '../../permutation-server/web/frontier/map/fog.mjs';
import * as S from '../../permutation-server/web/frontier/map/survey.mjs';
import { tileHex } from '../../permutation-server/web/frontier/fgeo.mjs';
import * as inspect from '../../permutation-server/web/frontier/hud/inspect.mjs';
import { chronicleRows } from '../../permutation-server/web/frontier/screens/chronicle.mjs';
import { keepFor } from '../../permutation-server/web/frontier/screens/conquest.mjs';
import { renderSurveyHelp, fogLegendText } from '../../permutation-server/web/frontier/map/legend.mjs';
import { setLang, L } from '../../permutation-server/web/lang.mjs';
import * as chart from '../../permutation-server/web/frontier/map/chart.mjs';

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

const keepMap = () => new Map([
  ['2,0', { p: 2, q: 0, tile: 40, holder: VIEWER, troops: 50, heartland: false, contender: 7, progress: 0, asOfBell: 40 }],
  ['0,-2', { p: 0, q: -2, tile: 30, holder: ENEMY, troops: 250, heartland: false, contender: ALLY, progress: 9, asOfBell: 40 }],
  ['-2,0', { p: -2, q: 0, tile: 30, holder: ENEMY, troops: 400, heartland: false, contender: VIEWER, progress: 3, asOfBell: 40 }],
]);

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
  // (fog-devnet: a fogged world says the fog from its first picture — fogActive — so the page without fog is a non-local one)
  assert.match(String(renderSurveyHelp({ ...FS, localPlay: null })), /spectate\.html/);
});

test('the page\'s wiring: every surface that shows the map reads the fogged copies; the gate is the local world', async () => {
  const { readFileSync } = await import('node:fs');
  const read = f => readFileSync(new URL(`../../permutation-server/web/frontier/${f}`, import.meta.url), 'utf8');
  const app = read('app.mjs'), ctl = read('controller.mjs'), feed = read('hud/feed.mjs'), kh = read('hud/keephand.mjs'), km = read('map/keepmount.mjs');
  // the fog view is made with the survey, for a local test world with a village of the viewer's
  assert.ok(app.includes('FS.fog = fogger({ active: fogActive(FS) && (FS.holdings ?? []).length > 0, survey: FS.survey, overviews: FS.overviews, wide: wideLandRaw?.land?.() ?? null,'));
  assert.ok(app.includes('if (LOCAL_FOG && cfg.localPlay && FS.mode === \'play\') setBlankChart(FOG_RULES.blankChart);'), 'plain paper only in a local world');
  // the map source, the wide land, the minimap, search and the people layer
  assert.ok(app.includes('return { overviews: shownOverviews(), ringsOpen: ringsOpenNow(),'));
  assert.ok(app.includes('control: FS.conquest?.control?.provinces ?? null });'), 'the territory from the control snapshot');
  assert.ok(app.includes('deps.push(wideLandRaw?.land?.() ?? null, FS.conquest?.control ?? null, ...FS.overviews.values());'));
  assert.ok(app.includes('wideLandRef = { ...raw, land: () => shownWide(raw.land()) };'));
  assert.ok(app.includes('const entries = [...shownOverviews()];'), 'the minimap');
  assert.ok(app.includes('for (const ov of shownOverviews().values()) for (const r of ov.provinces) recs.set(`${r.p},${r.q}`, r);\n  searchHits = search.searchMap('), 'search');
  assert.ok(app.includes('departures: scene.departuresAt(shownLog, shownOv, bell),'), 'other nations\' columns on the board');
  assert.ok(app.includes('reportScreen.renderLinks(recentClashes(FS), L`最近の衝突`, { FS }),') && app.includes('for (const x of [...myReports(FS), ...reportScreen.clashesFrom(shownChronicle() ?? [])])'), 'the recent clashes list (fix-loop22: the viewer\'s own, then the fogged chronicle)');
  assert.ok(app.includes('if (!fogWorld) try { wideModeRef = mountWideMode('), 'the recorded world\'s sheet is not offered under the fog');
  assert.ok(app.includes('caravans: s1Memo.marks.caravans.filter(c => c.own || (seen(c.from) && seen(c.to)))'), 'S1 marks');
  // the keep lists and the incoming warnings
  // (fix-lp29-fog-fort, owner 2026-11-28 Q-LP29-1 (b): both reach lists read guideKeeps = viewKeeps plus the capture demo's
  //  prepared fort only — web-frontier-fix-lp29-fog-fort.test.mjs; in every other world exactly viewKeeps)
  assert.equal(ctl.split('keeps: guideKeeps(cq.keeps)').length - 1, 2, 'both reach lists');
  assert.ok(ctl.includes('if (fog.on) FS.incoming = fog.incoming(FS.incoming, { nowBell: nowBell(), departures });'));
  assert.ok(km.includes('const keeps = viewKeeps(cq.keeps);'));
  assert.ok(feed.includes('viewClash({ p: e.p, q: e.q, keepTile: keepTileIn(FS.overviews, e.p, e.q), mine: !!e.side })'), 'keep news (verify-pr117: the keep tile, not any tile)');
  assert.ok(kh.indexOf(': fogNow().on ? html`<p class="pop-line">') < kh.indexOf(': Number(FS.conquest?.keepsPending ?? 0) > 0 ? html`<p class="pop-line kh-loading">'), 'nothing unseen is "being worked out"');
});
