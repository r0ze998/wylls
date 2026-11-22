// The fog of war of a LOCAL TEST world (map/fog.mjs), verify-pr117: more ways into another nation's clash than
// leak3 covers, for a province seen only at the EDGE (one rim tile in sight, the keep not), LAST-KNOWN (its keep was
// in sight before, nothing is now) or NEVER SEEN. Owner rule (t387u): only current vision; last-known for terrain and
// ownership; no leaks. A clash's place is its keep tile (or the whole province when it has no keep) — fix-loop5 L5-6.
//   1. the inspector (「戦いを再生」「衝突の報告」 and the 「このターンに衝突あり」 chip), last-known and never seen;
//   2. the map's clash marks: the fogged overview record's `clash` flag (the red ring, the minimap dot, the chip);
//   3. the scenes that play by themselves / the replay / the report: the page's one question (viewClash);
//   4. the chronicle's CLASH line and its 「報告」 button;
//   5. the chronicle's and the notices' keep events (争奪が始まった / 奪われた) — unless the viewer's nation is in them.
//   6. the map's moments (「…の新しい村」, set out, arrival, camp gone) and the march card's 「近くの行き先」 camps.
// Local-only (imports hud/inspect.mjs through src/), like web-frontier-fog-local-leak*.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as F from '../../permutation-server/web/frontier/map/fog.mjs';
import * as S from '../../permutation-server/web/frontier/map/survey.mjs';
import { tileHex } from '../../permutation-server/web/frontier/fgeo.mjs';
import * as inspect from '../../permutation-server/web/frontier/hud/inspect.mjs';
import { chronicleRows } from '../../permutation-server/web/frontier/screens/chronicle.mjs';
import { snapshot } from '../../permutation-server/web/frontier/hud/feed.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';

const VIEWER = 3, ENEMY = 0, OTHER = 1;
const HOME = { p: 2, q: 0, tile: 7 };
const SITES = Array.from({ length: 12 }, (_, j) => 7 + 2 * j);
const terrainOf = () => ({ sites: SITES, terrain: Array(61).fill(0), names: ['Grassland'] });
const rec = (p, q, over = {}) => ({ p, q, owners: Array(12).fill(7), sites: Array(12).fill(0), hosts: Array(7).fill(0), clash: false, dormant: false, opened: true, resolvedNext: 0,
  occupiers: Array(12).fill(7), siegeStates: Array(12).fill(0), siteKinds: Array(12).fill(3), keepTile: null, keepTroops: 0, immune: Array(12).fill(false), ...over });
const memStore = () => { const m = new Map(); return { get: k => m.get(k) ?? null, set: (k, v) => { m.set(k, v); return true; }, m }; };
const homeSight = () => S.anchorsOf({ villages: [{ ...HOME, tier: 0 }] });
const sightOn = (p, q, tile, radius = 0) => { const h = tileHex(p, q, tile); return { q: h.q, r: h.r, radius, level: S.L3, kind: 'host' }; };
const sv = anchors => { const s = S.buildSurvey({ ringsOpen: 3, anchors }); s.rev = Math.random(); s.ownHosts = new Set(); s.faction = VIEWER; return s; };
const KEEP = 30, RIM = 60, BELL = 11;
const EDGE = () => [sightOn(-2, 0, RIM)], KEEPSIGHT = () => [sightOn(-2, 0, KEEP)], NONE = () => [];
// LAST-KNOWN: the province was surveyed before (level 2 around its keep), nothing of it is in sight now
const KNOWN = () => [{ ...sightOn(-2, 0, KEEP, 2), level: S.L2, kind: 'explored' }];
const CLASH_REC = { name: 'CLASH', p: -2, q: 0, bell: BELL, engagements: 2 };
const keepEvent = (kind, from, to) => ({ kind, seq: '9', bell: BELL, p: -2, q: 0, from, to });

/** The page's look at the enemy province (-2, 0): keep on tile 30, an AI-vs-AI clash resolved at turn 11. */
function world(anchors, { storage = memStore(), keepTile = KEEP, events = [] } = {}) {
  const survey = sv([...homeSight(), ...anchors]);
  const overviews = new Map([[2, { ring: 2, bell: 12, provinces: [rec(2, 0, { control: VIEWER }), rec(-2, 0, { keepTile, keepTroops: 288, control: ENEMY, clash: true })] }]]);
  const fog = F.createFogger({ storage })({ active: true, survey, overviews, viewer: VIEWER, terrainOf, memKey: 'w' });
  const province = { p: -2, q: 0, resolveSummary: { bell: BELL }, sites: SITES, relations: 0n };
  return { mode: 'play', localPlay: { address: 'W' }, citizen: { faction: VIEWER }, holdings: [{ ...HOME, site: 0, tier: 0 }], marches: [], nowBell: 12, land: { stage: 'final' }, survey, fog,
    overviews, provinces: new Map([['-2,0', { province }]]), season: { programVersion: 3 }, conquest: { keeps: new Map(), events }, chronicle: [], selected: { p: -2, q: 0 } };
}
const offers = FS => inspect.inspectActions(FS, inspect.inspectModel(FS, terrainOf)).map(a => a.act).filter(a => a === 'battle-play' || a === 'report-open');
const fogged = FS => { for (const o of F.viewOverviews(FS).values()) { const r = o.provinces.find(x => x.p === -2 && x.q === 0); if (r) return r; } return null; };
const run = f => { setLang('ja'); try { return f(); } finally { F.resetFogNow(); } };

test('leak4/1 inspector: LAST-KNOWN (keep seen before, nothing in sight now) and NEVER SEEN offer no replay, no report, no clash chip', () => run(() => {
  const storage = memStore();
  const before = world(KEEPSIGHT(), { storage });
  assert.deepEqual(offers(before), ['battle-play', 'report-open'], 'in sight: offered');
  const later = world(KNOWN(), { storage });
  assert.ok(storage.m.size > 0, 'the keep was remembered');
  assert.equal(fogged(later).fog, 'memory');
  const m = inspect.inspectModel(later, terrainOf);
  assert.equal(m.reportBell, null); assert.equal(m.clash, false);
  assert.deepEqual(offers(later), []);
  const never = world(NONE());
  assert.equal(inspect.inspectModel(never, terrainOf).clash, false);
  assert.deepEqual(offers(never), []);
}));

test('leak4/2 map marks: the fogged record\'s clash flag (red ring, minimap dot, 「このターンに衝突あり」) is off at the EDGE, last-known and never seen; on with the keep in sight', () => run(() => {
  assert.equal(fogged(world(KEEPSIGHT())).clash, true, 'keep in sight: the clash flag is live');
  const edge = world(EDGE());
  assert.equal(fogged(edge).clash, false, 'one rim tile in sight: no clash mark');
  assert.equal(inspect.inspectModel(edge, terrainOf).clash, false, 'no 「このターンに衝突あり」 chip');
  const storage = memStore(); world(KEEPSIGHT(), { storage });
  assert.equal(fogged(world(KNOWN(), { storage })).clash, false, 'last-known');
  assert.equal(fogged(world(NONE())).clash, false, 'never seen');
  // a province without a keep: the whole province must be in sight
  assert.equal(fogged(world(EDGE(), { keepTile: null })).clash, false);
  assert.equal(fogged(world(Array.from({ length: 61 }, (_, i) => sightOn(-2, 0, i, 1)), { keepTile: null })).clash, true);
}));

test('leak4/3 scenes, replay, report and clash art: the page\'s one question (viewClash) answers no at the edge, last-known and never seen', () => run(() => {
  const ask = FS => F.viewClash({ p: -2, q: 0, keepTile: KEEP, mine: inspect.ownClashPlace(FS, -2, 0, BELL) });
  assert.equal(ask(world(KEEPSIGHT())), true);
  assert.equal(ask(world(EDGE())), false);
  const storage = memStore(); world(KEEPSIGHT(), { storage });
  assert.equal(ask(world(KNOWN(), { storage })), false);
  assert.equal(ask(world(NONE())), false);
}));

test('leak4/4 chronicle: another nation\'s CLASH line (and its 「報告」 button) only while its keep is in sight', () => run(() => {
  const rows = FS => chronicleRows([{ seq: 1, record: CLASH_REC }], () => false, 60, FS, []).filter(r => r.clash);
  assert.equal(rows(world(KEEPSIGHT())).length, 1, 'keep in sight: told');
  assert.deepEqual(rows(world(EDGE())), [], 'edge only: not told');
  const storage = memStore(); world(KEEPSIGHT(), { storage });
  assert.deepEqual(rows(world(KNOWN(), { storage })), [], 'last-known: not told');
  assert.deepEqual(rows(world(NONE())), [], 'never seen: not told');
  // the page's fogged chronicle (app.mjs shownChronicle → the recent clashes list 「最近の衝突」, the board's columns)
  // asks the same filter: fog.seen
  assert.equal(world(KEEPSIGHT()).fog.seen(CLASH_REC, () => false), true);
  assert.equal(world(EDGE()).fog.seen(CLASH_REC, () => false), false, 'shownChronicle, edge only');
  assert.equal(world(NONE()).fog.seen(CLASH_REC, () => false), false, 'shownChronicle, never seen');
  assert.equal(world(EDGE()).fog.seen(CLASH_REC, () => true), true, 'the viewer\'s own');
  // the viewer's own clash is always told
  assert.equal(chronicleRows([{ seq: 1, record: CLASH_REC }], () => true, 60, world(EDGE()), []).filter(r => r.clash).length, 1);
}));

test('leak4/5 chronicle and notices: other nations\' keep events only while the keep is in sight; the viewer\'s nation\'s always', () => run(() => {
  const theirs = [keepEvent('keep_contest', ENEMY, OTHER), keepEvent('keep_taken', ENEMY, OTHER)].map((e, i) => ({ ...e, seq: String(9 + i) }));
  const chron = FS => chronicleRows([], () => false, 60, FS, FS.conquest.events, VIEWER).filter(r => r.keep);
  const feed = FS => [...snapshot(FS, 0).keeps.values()];
  const keepFS = world(KEEPSIGHT(), { events: theirs });
  assert.equal(chron(keepFS).length, 2); assert.equal(feed(keepFS).length, 2);
  const edge = world(EDGE(), { events: theirs });
  assert.deepEqual(chron(edge), [], 'chronicle, edge only'); assert.deepEqual(feed(edge), [], 'notices, edge only');
  const storage = memStore(); world(KEEPSIGHT(), { storage });
  const last = world(KNOWN(), { storage, events: theirs });
  assert.deepEqual(chron(last), []); assert.deepEqual(feed(last), []);
  const never = world(NONE(), { events: theirs });
  assert.deepEqual(chron(never), []); assert.deepEqual(feed(never), []);
  // the viewer's nation in it (attacked, or taking it): always told
  const ours = [keepEvent('keep_contest', ENEMY, VIEWER)];
  assert.equal(chron(world(NONE(), { events: ours })).length, 1); assert.equal(feed(world(NONE(), { events: ours })).length, 1);
}));

test('leak4/6 moments and the march card\'s 「近くの行き先」: another nation\'s new village / camp in a province the page read but never saw', () => run(() => {
  // the page reads whole provinces it cannot see (AI villages' provinces): the tile decides, not the read
  world(EDGE());
  assert.equal(F.viewTile(-2, 0, RIM), true, 'the rim tile is in sight');
  assert.equal(F.viewTile(-2, 0, KEEP), false, 'a moment on the keep tile (out of sight) does not play');
  assert.equal(F.viewTile(-2, 0, KEEP, S.L2), false, 'never surveyed: no camp listed');
  world(KNOWN());
  assert.equal(F.viewTile(-2, 0, KEEP), false, 'surveyed before, not in sight: no moment');
  assert.equal(F.viewTile(-2, 0, KEEP, S.L2), true, 'surveyed before: its camp may be listed (last-known terrain)');
  world(NONE());
  assert.equal(F.viewTile(-2, 0, KEEP, S.L2), false);
  assert.equal(F.viewTile(-2, 0, null), false, 'no tile: the province\'s best level');
  F.resetFogNow();
  assert.equal(F.viewTile(-2, 0, KEEP), true, 'without fog: always');
  // the wiring (app.mjs checkMoments, controller.mjs quickDestinations)
  const app = readFileSync(new URL('../../permutation-server/web/frontier/app.mjs', import.meta.url), 'utf8');
  // (fix-loop8, LP8-9: the moments in sight are gathered, then new villages of one nation in one province share one
  //  caption with their count; the fog cut still comes first, so only moments in sight are counted)
  assert.ok(app.includes("    if (!own && !taken && !viewTile(m.p, m.q, m.tile)) continue;\n    shown.push({ ...m, lost, taken, own });"));
  assert.ok(app.includes("  for (const m of mergeNewVillages(shown)) fxEmit('moment', m);"));
  const ctl = readFileSync(new URL('../../permutation-server/web/frontier/controller.mjs', import.meta.url), 'utf8');
  assert.ok(ctl.includes("if (camp?.state === 1 && viewTile(env.province.p, env.province.q, camp.tile, 2)) out.push({ kind: 'camp'"));
}));
