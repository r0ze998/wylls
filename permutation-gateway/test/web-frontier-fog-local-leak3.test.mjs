// The fog of war of a LOCAL TEST world (map/fog.mjs): the clash LEAK of loop-play5 (L5-6, fix-loop5). A province with
// only a few rim tiles in sight offered 「戦いを再生」「ターン 11 の衝突の報告」 in the inspector, and the report opened the
// full AI-vs-AI clash (both sides' troops). #93's rule: other nations' clashes show only inside CURRENT vision.
// Now a clash is offered, read, played or marked only when it is the viewer's own or its place is in sight now: the
// keep tile when the province has a keep, else the whole province.
// Local-only (imports hud/inspect.mjs through src/), like web-frontier-fog-local-leak*.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as F from '../../permutation-server/web/frontier/map/fog.mjs';
import * as S from '../../permutation-server/web/frontier/map/survey.mjs';
import { tileHex } from '../../permutation-server/web/frontier/fgeo.mjs';
import * as inspect from '../../permutation-server/web/frontier/hud/inspect.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';

const VIEWER = 3, ENEMY = 0;
const HOME = { p: 2, q: 0, tile: 7 };
const SITES = Array.from({ length: 12 }, (_, j) => 7 + 2 * j);
const terrainOf = () => ({ sites: SITES, terrain: Array(61).fill(0), names: ['Grassland'] });
const rec = (p, q, over = {}) => ({ p, q, owners: Array(12).fill(7), sites: Array(12).fill(0), hosts: Array(7).fill(0), clash: false, dormant: false, opened: true, resolvedNext: 0,
  occupiers: Array(12).fill(7), siegeStates: Array(12).fill(0), siteKinds: Array(12).fill(3), keepTile: null, keepTroops: 0, immune: Array(12).fill(false), ...over });
const memStore = () => { const m = new Map(); return { get: k => m.get(k) ?? null, set: (k, v) => { m.set(k, v); return true; }, m }; };
const homeSight = () => S.anchorsOf({ villages: [{ ...HOME, tier: 0 }] });
const sightOn = (p, q, tile, radius = 0) => { const h = tileHex(p, q, tile); return { q: h.q, r: h.r, radius, level: S.L3, kind: 'host' }; };
const sv = anchors => { const s = S.buildSurvey({ ringsOpen: 3, anchors }); s.rev = Math.random(); s.ownHosts = new Set(); s.faction = VIEWER; return s; };
const KEEP = 30, RIM = 60, CLASH_BELL = 11;

/** The page's look at the enemy province (-2, 0) — keep on tile 30, an AI-vs-AI clash resolved at turn 11 — with `anchors`. */
function world(anchors, { keepTile = KEEP, holdings = [{ ...HOME, site: 0, tier: 0 }], marches = [] } = {}) {
  const survey = sv([...homeSight(), ...anchors]);
  const overviews = new Map([[2, { ring: 2, bell: 13, provinces: [rec(2, 0, { control: VIEWER }), rec(-2, 0, { keepTile, keepTroops: 288, control: ENEMY, clash: true })] }]]);
  const fog = F.createFogger({ storage: memStore() })({ active: true, survey, overviews, viewer: VIEWER, terrainOf, memKey: 'w' });
  const province = { p: -2, q: 0, resolveSummary: { bell: CLASH_BELL }, sites: SITES, relations: 0n };
  const FS = { mode: 'play', localPlay: { address: 'W' }, citizen: { faction: VIEWER }, holdings, marches, nowBell: 13, land: { stage: 'final' }, survey, fog,
    overviews, provinces: new Map([['-2,0', { province }]]), season: { programVersion: 3 }, conquest: { keeps: new Map() }, selected: { p: -2, q: 0 } };
  return FS;
}
const offers = FS => inspect.inspectActions(FS, inspect.inspectModel(FS, terrainOf)).map(a => a.act).filter(a => a === 'battle-play' || a === 'report-open');

test('L5-6: a province with only a rim tile in sight offers no replay and no report of another nation\'s clash; the keep in sight does', () => {
  setLang('ja');
  try {
    // only one tile far from the keep is in sight: the province's top level is 3 (that is what leaked), the keep is not
    const rim = world([sightOn(-2, 0, RIM)]);
    assert.equal(rim.survey.province(-2, 0).max, S.L3, 'the province is "in sight" by one rim tile');
    assert.notEqual(rim.survey.levelOf(-2, 0, KEEP), S.L3, 'the keep tile is not');
    const m = inspect.inspectModel(rim, terrainOf);
    assert.equal(m.reportBell, null, 'no clash bell offered');
    assert.deepEqual(offers(rim), [], 'no 「戦いを再生」, no 「ターン 11 の衝突の報告」');
    // the keep tile in sight now: offered, as before
    const keep = world([sightOn(-2, 0, KEEP)]);
    assert.equal(inspect.inspectModel(keep, terrainOf).reportBell, CLASH_BELL);
    assert.deepEqual(offers(keep), ['battle-play', 'report-open']);
    // never seen at all: nothing (as before)
    assert.deepEqual(offers(world([])), []);
    // no keep in the province: only the whole province in sight counts
    assert.deepEqual(offers(world([sightOn(-2, 0, RIM)], { keepTile: null })), []);
    assert.deepEqual(offers(world(Array.from({ length: 61 }, (_, i) => sightOn(-2, 0, i, 1)), { keepTile: null })), ['battle-play', 'report-open'], 'the whole province and its rim in sight');
    // the viewer's own clash is always the viewer's: a march of theirs arriving there at that turn, out of sight or not
    const own = world([sightOn(-2, 0, RIM)], { marches: [{ dest: { p: -2, q: 0 }, entry: { arriveBell: CLASH_BELL } }] });
    assert.deepEqual(offers(own), ['battle-play', 'report-open']);
    // a march of theirs arriving at another turn is not that clash
    assert.deepEqual(offers(world([sightOn(-2, 0, RIM)], { marches: [{ dest: { p: -2, q: 0 }, entry: { arriveBell: 5 } }] })), []);
  } finally { F.resetFogNow(); }
  // without the fog (no local fog view, e.g. a devnet page): every clash, as before
  const plain = world([sightOn(-2, 0, RIM)]); F.resetFogNow();
  assert.ok(F.viewClash({ p: -2, q: 0, keepTile: KEEP }));
});

test('L5-6: clashSeen — the keep tile, else the whole province; mine always; no survey or showAll always', () => {
  const s = sv([sightOn(-2, 0, RIM)]);
  assert.equal(F.clashSeen({ p: -2, q: 0, keepTile: KEEP }, { survey: s }), false);
  assert.equal(F.clashSeen({ p: -2, q: 0, keepTile: RIM }, { survey: s }), true);
  assert.equal(F.clashSeen({ p: -2, q: 0, keepTile: null }, { survey: s }), false);
  assert.equal(F.clashSeen({ p: -2, q: 0, keepTile: KEEP, mine: true }, { survey: s }), true);
  assert.equal(F.clashSeen({ p: -2, q: 0, keepTile: KEEP }, { survey: S.openSurvey(3) }), true);
  assert.equal(F.clashSeen({ p: -2, q: 0, keepTile: KEEP }, {}), true);
  assert.equal(F.clashSeen({ p: 'x', q: 0 }, { survey: s }), false);
});

test('L5-6: every way into a clash asks the same question (source wiring: report, replay, auto-played scenes, map marks; the report says why)', () => {
  const app = readFileSync(new URL('../../permutation-server/web/frontier/app.mjs', import.meta.url), 'utf8');
  assert.match(app, /export async function openReport\(p, q, bell\) \{\n  if \(!heraldRef \|\| !\[p, q, bell\]\.every\(Number\.isInteger\)\) return;\n  \/\/ \(fix-loop5, L5-6[^\n]*\n  if \(!clashHere\(p, q, bell\)\) \{ FS\.report = \{ p, q, bell, world: reportWorld\(\), hidden: true \};/, 'the report is not even asked of the herald');
  assert.match(app, /async function playAsked\(p, q, bell\) \{\n  \/\/ \(fix-loop5, L5-6[^\n]*\n  if \(!clashHere\(p, q, bell\)\) return;/, 'the replay');
  assert.match(app, /if \(!clashHere\(env\.province\.p, env\.province\.q, b\)\) continue;\n    playBattle\(env\.province\.p, env\.province\.q, b, \{ auto: true \}\);/, 'the scenes that play by themselves');
  assert.match(app, /if \(!viewClash\(\{ p, q, keepTile: keepTileOf\(p, q\), mine: inspect\.ownClashPlace\(FS, p, q, rb\) \}\)\) return null;/, 'the map\'s clash marks');
  const report = readFileSync(new URL('../../permutation-server/web/frontier/screens/report.mjs', import.meta.url), 'utf8');
  assert.ok(report.includes('if (r.hidden) return html`'), 'a hidden report says why, and reads nothing');
  assert.ok(report.includes('ほかの国どうしの衝突の報告は、その場所が見えているあいだだけ開けます。'));
});
