// The survey model (UX brief §3; permutation-server/web/frontier/map/survey.mjs,
// viewer.mjs, chart.mjs and the surfaces that ask it). The rule every test
// here leans on: ONE lookup says what the play map may draw of a tile:
//   L0 cloud sea (ring not open) · L1 chart (terrain only) · L2 surveyed
//   (the land and its villages) · L3 in sight (everything)
// and every surface reads it: the tile model of the painter, the realms of
// the far view, the minimap, the inspector, search. Nothing here is a rule
// of the game: the spectator's survey has every open tile in sight.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as S from '../../permutation-server/web/frontier/map/survey.mjs';
import * as chart from '../../permutation-server/web/frontier/map/chart.mjs';
import { surveyInput } from '../../permutation-server/web/frontier/map/viewer.mjs';
import { SpriteArt, buildRealms } from '../../permutation-server/web/frontier/map/sprites.mjs';
import * as layers from '../../permutation-server/web/frontier/map/layers.mjs';
import * as inspect from '../../permutation-server/web/frontier/hud/inspect.mjs';
import * as MINI from '../../permutation-server/web/frontier/hud/minimap.mjs';
import * as SEARCH from '../../permutation-server/web/frontier/hud/search.mjs';
import { SURVEY_LEGEND, renderSurveyHelp, surveyLine } from '../../permutation-server/web/frontier/map/legend.mjs';
import { hexDistance, locate, tileHex, PROVINCE_TILES } from '../../permutation-server/web/frontier/fgeo.mjs';
import { hostId } from '../../permutation-server/web/frontier/faddr.mjs';
import { factionName } from '../../permutation-server/web/frontier/fi18n.mjs';
import { FACTION_FILL } from '../../permutation-server/web/frontier/people/avatar.mjs';
import * as I from '../../permutation-server/web/frontier/people/identity.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';
import { RADIUS, project } from '../../permutation-server/web/map.mjs';

const HOME = { p: 2, q: 0, tile: 7 };
const home = tileHex(HOME.p, HOME.q, HOME.tile);
const around = (h, n) => { const out = []; for (let dq = -n; dq <= n; dq++) for (let dr = Math.max(-n, -dq - n); dr <= Math.min(n, -dq + n); dr++) out.push({ q: h.q + dq, r: h.r + dr }); return out; };
const village = (tier = 0) => ({ ...HOME, tier });
const survey = (anchors, extra = {}) => S.buildSurvey({ ringsOpen: 3, anchors: S.anchorsOf(anchors), ...extra });

test('sight is counted in tiles: a village 3 + its worked radius, a host 2, a Scout 3', () => {
  assert.deepEqual([0, 1, 2, 3].map(S.SIGHT.village), [4, 5, 5, 6], 'a hamlet sees 4 tiles');
  assert.deepEqual([S.SIGHT.host, S.SIGHT.scout, S.SIGHT.candidate, S.SIGHT.explored], [2, 3, 1, 1]);
  assert.deepEqual(S.LEVELS, ['cloud', 'chart', 'surveyed', 'sight']);
  assert.deepEqual(S.FOG_OF_LEVEL, ['unopened', 'distant', 'known', 'sight'], 'the levels by the names the province painters know');
  const sv = survey({ villages: [village(0)] });
  assert.equal(sv.levelAt(home.q, home.r), S.L3);
  for (const h of around(home, 6)) {
    const d = hexDistance(home.q, home.r, h.q, h.r), at = locate(h.q, h.r), open = Math.max(Math.abs(at.p), Math.abs(at.q), Math.abs(at.p + at.q)) < 3;
    assert.equal(sv.levelAt(h.q, h.r), !open ? S.L0 : d <= 4 ? S.L3 : S.L1, `distance ${d}`);
  }
  assert.equal(sv.levelOf(HOME.p, HOME.q, HOME.tile), S.L3, 'by province and tile index too');
  assert.equal(survey({ villages: [village(3)] }).levelAt(home.q + 6, home.r - 3), S.L3, 'a stronghold sees 6');
  // hosts: the viewer's own, by kind
  const far = { p: 1, q: 0, tile: 30 }, fh = tileHex(1, 0, 30);
  const combat = survey({ hosts: [{ ...far, unit: 0 }] }), scout = survey({ hosts: [{ ...far, unit: S.SCOUT_UNIT }] });
  assert.deepEqual([combat.levelAt(fh.q + 2, fh.r), combat.levelAt(fh.q + 3, fh.r)], [S.L3, S.L1]);
  assert.deepEqual([scout.levelAt(fh.q + 3, fh.r), scout.levelAt(fh.q + 4, fh.r)], [S.L3, S.L1]);
});

test('explored tiles, march destinations and what was once in sight stay surveyed; a ring that is not open is cloud', () => {
  const e = { p: 1, q: 0, tile: 30 }, eh = tileHex(1, 0, 30);
  const sv = survey({ explored: [e], destinations: [{ p: 1, q: 1, tile: 5 }] });
  assert.equal(sv.levelAt(eh.q, eh.r), S.L2);
  assert.equal(sv.levelAt(eh.q + 1, eh.r), S.L2, 'its six neighbours');
  assert.equal(sv.levelAt(eh.q + 2, eh.r), S.L1);
  const d = tileHex(1, 1, 5);
  assert.equal(sv.levelAt(d.q, d.r), S.L2, 'the viewer\'s own destination');
  // memory: surveyed, never more; sight wins over it
  const past = tileHex(-1, 0, 30);
  const memory = new Set([S.hexKey(past.q, past.r), S.hexKey(home.q, home.r)]);
  const m = survey({ villages: [village(0)] }, { memory });
  assert.equal(m.levelAt(past.q, past.r), S.L2);
  assert.equal(m.levelAt(past.q + 1, past.r), S.L1, 'the memory holds tiles, not their surroundings');
  assert.equal(m.levelAt(home.q, home.r), S.L3);
  // the cloud sea: ring 3 is not open, whatever an anchor or the memory says
  const out = tileHex(3, 0, 30);
  const c = S.buildSurvey({ ringsOpen: 3, anchors: [{ q: out.q, r: out.r, radius: 2, level: S.L3 }], memory: new Set([S.hexKey(out.q, out.r)]) });
  assert.equal(c.levelAt(out.q, out.r), S.L0);
  assert.equal(c.tiles.size, 0, 'nothing of a ring that is not open is kept');
  assert.equal(c.province(3, 0).kind, 'cloud');
  // a candidate with no tile yet (its province's terrain is not known) is left out
  assert.deepEqual(S.anchorsOf({ candidates: [{ p: 2, q: 0, site: 5, tile: null }, { p: 2, q: 0, site: 6, tile: 19 }] }).length, 1);
});

test('a page with no viewer shows the whole public world: every open tile in sight', () => {
  const sv = S.openSurvey(3);
  assert.equal(sv.showAll, true);
  assert.equal(sv.levelAt(0, 0), S.L3);
  assert.equal(sv.levelAt(home.q, home.r), S.L3);
  const out = tileHex(3, 0, 0);
  assert.equal(sv.levelAt(out.q, out.r), S.L0);
  assert.deepEqual([sv.province(1, 0).kind, sv.province(3, 0).kind], ['sight', 'cloud']);
  assert.equal(sv.tiles.size, 0, 'no per-tile table is built for it');
});

test('a province\'s summary: chart, mixed or all in sight, and two signatures (any level; surveyed or not)', () => {
  const sv = survey({ villages: [village(0)] });
  assert.equal(sv.province(-2, 0).kind, 'chart');
  assert.deepEqual([sv.province(-2, 0).max, sv.province(-2, 0).sig], [S.L1, '1']);
  const hp = sv.province(2, 0);
  assert.deepEqual([hp.kind, hp.max, hp.min], ['mixed', S.L3, S.L1]);
  assert.equal(sv.province(2, 0), hp, 'computed once');
  // a province next to surveyed land, with none of its own: mixed (the soft edge reaches one tile across the border)
  const edge = tileHex(1, 1, 0);
  const rim = S.buildSurvey({ ringsOpen: 3, anchors: [{ q: edge.q, r: edge.r, radius: 0, level: S.L3 }] });
  const next = [[0, 1], [1, 0], [2, 0], [0, 2], [2, -1], [0, 0]].filter(([p, q]) => (p !== 1 || q !== 1) && rim.province(p, q).kind === 'mixed');
  assert.ok(next.length >= 1, 'the province across the border from a surveyed corner tile');
  for (const [p, q] of next) assert.equal(rim.province(p, q).max, S.L1);
  // a host walking inside surveyed land: the "surveyed or not" signature holds, the full one changes
  const memory = new Set(around(home, 5).map(h => S.hexKey(h.q, h.r)));
  const a = survey({ hosts: [{ ...HOME, unit: 0 }] }, { memory }), b = survey({ hosts: [{ p: 2, q: 0, tile: 8, unit: 0 }] }, { memory });
  assert.equal(a.province(2, 0).sig2, b.province(2, 0).sig2);
  assert.notEqual(a.province(2, 0).sig, b.province(2, 0).sig);
  // a province wholly in sight, rim and all
  const all = S.buildSurvey({ ringsOpen: 3, anchors: [{ q: 0, r: 0, radius: 12, level: S.L3 }] });
  assert.equal(all.province(0, 0).kind, 'sight');
  assert.deepEqual(all.count, { surveyed: all.tiles.size, sight: all.tiles.size });
});

test('the device\'s memory: a compact text per season and wallet, read back exactly, damage ignored', () => {
  assert.equal(S.memoryKey({ cluster: 'localnet', programId: 'PROG', seasonId: 7 }, 'WALLET'), 'ps-fsurvey:localnet:PROG:7:WALLET');
  const keys = new Set(around(home, 4).map(h => S.hexKey(h.q, h.r)));
  const text = S.packMemory(keys);
  assert.ok(text.length < 200, `61 tiles in ${text.length} characters`);
  assert.deepEqual([...S.unpackMemory(text)].sort(), [...keys].sort());
  assert.deepEqual(S.keyHex(S.hexKey(-37, 12)), { q: -37, r: 12 });
  for (const bad of [null, '', '{', '[]', '{"v":2,"t":{}}', '{"v":1,"t":{"x":"ff"}}', '{"v":1,"t":{"1,0":"zz"}}', '{"v":1,"t":{"1,0":5}}']) assert.equal(S.unpackMemory(bad).size, 0, String(bad));
  assert.equal(JSON.parse(S.packMemory(keys, 1)).t && Object.keys(JSON.parse(S.packMemory(keys, 1)).t).length, 1, 'bounded');
  const memory = new Set();
  const sv = survey({ villages: [village(0)], explored: [{ p: 1, q: 0, tile: 30 }] });
  assert.equal(S.remember(memory, sv), 61, 'what is in sight is remembered');
  assert.equal(S.remember(memory, sv), 0);
  assert.equal(memory.has(S.hexKey(tileHex(1, 0, 30).q, tileHex(1, 0, 30).r)), false, 'an explored tile is surveyed from the records every time: not stored');
});

test('the reveal: tiles in sight for the first time, later the further from what sees them', () => {
  const before = survey({ villages: [village(0)] });
  const host = { p: 2, q: 0, tile: 7, unit: S.SCOUT_UNIT };
  const far = tileHex(1, 1, 30);
  const after = survey({ villages: [village(0)], hosts: [{ p: 1, q: 1, tile: 30, unit: 0 }] });
  const plan = S.revealPlan(before, after, 1000);
  assert.equal(plan.size, 19, 'the 19 tiles of a combat host\'s sight, none of them seen before');
  assert.equal(plan.get(S.hexKey(far.q, far.r)), 1000, 'nearest first');
  assert.equal(plan.get(S.hexKey(far.q + 2, far.r)), 1000 + 2 * S.REVEAL_STAGGER_MS);
  assert.equal(S.revealPlan(before, survey({ villages: [village(0)], hosts: [host] }), 0).size, 0, 'nothing new in sight: nothing dissolves');
  // what the memory already holds is not new
  const known = S.buildSurvey({ ringsOpen: 3, anchors: before.anchors, memory: new Set([S.hexKey(far.q, far.r)]) });
  assert.equal(S.revealPlan(known, after, 0).has(S.hexKey(far.q, far.r)), false);
  assert.equal(S.revealPlan(null, before, 0).size, 61, 'against nothing, all of it');
  assert.equal(S.revealAt(plan, S.hexKey(far.q, far.r), 1000 + S.REVEAL_MS / 2), 0.5);
  assert.equal(S.revealAt(plan, S.hexKey(far.q + 2, far.r), 1000), 0, 'still chart while it waits its turn');
  assert.equal(S.revealAt(plan, S.hexKey(far.q, far.r), 99999), 1);
  assert.equal(S.revealAt(plan, S.hexKey(0, 0), 1000), null);
  assert.ok(S.REVEAL_MS >= 800 && S.REVEAL_MS <= 1000, 'about 900 ms');
});

test('the page\'s surveyor: one object per input, the first picture is not a reveal, what comes after is; the memory is kept per wallet', () => {
  const store = new Map();
  const storage = { get: k => store.get(k) ?? null, set: (k, v) => { store.set(k, v); return true; } };
  let t = 5000;
  const surveyor = S.createSurveyor({ storage, now: () => t });
  const scope = { cluster: 'localnet', programId: 'PROG', seasonId: 7 };
  const base = { mode: 'play', ringsOpen: 3, scope, wallet: 'W1', stage: 'final', faction: 0, home: HOME };
  // while the viewer's record has not answered: chart only, nothing remembered
  const wait = surveyor({ ...base, ready: false, villages: [village(1)] });
  assert.equal(store.size, 0);
  assert.equal(wait.reveals.size, 0);
  const a = surveyor({ ...base, ready: true, villages: [village(1)], hostIds: ['5', '6'] });
  assert.equal(surveyor({ ...base, ready: true, villages: [village(1)], hostIds: ['5', '6'] }), a, 'the same input: the same object (painters key their caches on it)');
  assert.equal(a.count.sight, 91, 'a town sees 5 tiles');
  assert.equal(a.reveals.size, 0, 'the first picture is what the records say: no reveal');
  assert.deepEqual([...a.ownHosts], ['5', '6']);
  assert.deepEqual([a.home, a.faction, a.stage, a.showAll], [HOME, 0, 'final', false]);
  assert.equal(S.unpackMemory(store.get('ps-fsurvey:localnet:PROG:7:W1')).size, 91, 'what is in sight is kept on this device');
  // a host arrives somewhere new: those tiles dissolve
  t = 9000;
  const b = surveyor({ ...base, ready: true, villages: [village(1)], hosts: [{ p: 1, q: 1, tile: 30, unit: 0 }], hostIds: ['5', '6'] });
  assert.notEqual(b, a);
  assert.ok(b.rev > a.rev);
  assert.equal(b.reveals.size, 19);
  assert.equal(Math.min(...b.reveals.values()), 9000);
  // the host leaves: what it saw stays surveyed (the memory), and nothing dissolves again when it returns
  t = 20000;
  const c = surveyor({ ...base, ready: true, villages: [village(1)], hostIds: ['5', '6'] });
  const far = tileHex(1, 1, 30);
  assert.equal(c.levelAt(far.q, far.r), S.L2);
  assert.equal(c.reveals.size, 0, 'finished reveals are dropped');
  const d = surveyor({ ...base, ready: true, villages: [village(1)], hosts: [{ p: 1, q: 1, tile: 30, unit: 0 }], hostIds: ['5', '6'] });
  assert.equal(d.reveals.size, 0);
  // another wallet: its own memory
  const other = surveyor({ ...base, wallet: 'W2', ready: true, villages: [] });
  assert.equal(other.tiles.size, 0);
  // a page that is not the play page: the open survey
  assert.equal(surveyor({ mode: 'spectate', ringsOpen: 3 }).showAll, true);
  // a new page for W1: the memory comes back from the device (surveyed, not in sight)
  const again = S.createSurveyor({ storage, now: () => 0 })({ ...base, ready: true, villages: [] });
  assert.equal(again.levelAt(far.q, far.r), S.L2);
  assert.equal(again.count.sight, 0);
});

test('who is looking: the anchors read out of the page state for each stage', () => {
  const holding = { p: 2, q: 0, site: 3, gen: 0, tile: 7, tier: 1, state: 2, explore: { state: 1, bell: 40, p: 2, q: 0, tiles: [8, 9], host: 1n } };
  const id = n => hostId({ p: 2, q: 0, site: 3, gen: 0, seq: n });
  const stranger = hostId({ p: 2, q: 0, site: 7, gen: 0, seq: 1 });
  const entry = (hid, tile, unit, state) => ({ id: hid, faction: 0, unit, tile, state, troops: 100_000, staminaValue: 100, staminaBell: 40, readyBell: 0, pendOp: 0, fromBell: 1 });
  const transit = Array.from({ length: 4 }, () => ({ state: 0, hostId: 0n }));
  const fs = {
    mode: 'play', record: { rings: [{}, {}, {}] }, wallet: { address: 'W' }, citizen: { faction: 0 }, land: { stage: 'final' }, nowBell: 42,
    holdings: [{ ...holding, transit }],
    provinces: new Map([['2,0', { province: { p: 2, q: 0, entries: [entry(id(8), 7, 0, 1), entry(id(9), 12, 6, 1), entry(id(7), 7, 0, 3), entry(stranger, 20, 0, 1)] } }]]),
    chronicle: [{ record: { name: 'EXPLORE', host_id: id(9), p: 2, q: 0, n: 1, tiles: [30, 0] } }, { record: { name: 'EXPLORE', host_id: stranger, p: 2, q: 0, n: 2, tiles: [40, 41] } }],
    marches: [{ dest: { p: 1, q: 1, tile: 5 } }, { dest: null }],
  };
  const x = surveyInput(fs, { ready: true, scope: { cluster: 'c', programId: 'p', seasonId: 1 } });
  assert.deepEqual(x.villages, [{ p: 2, q: 0, tile: 7, tier: 1, state: 2 }]);
  assert.deepEqual(x.hosts, [{ p: 2, q: 0, tile: 7, unit: 0 }, { p: 2, q: 0, tile: 12, unit: 6 }], 'own hosts that stand; one on the road gives no sight; a stranger\'s never');
  assert.deepEqual(x.hostIds, [String(id(7)), String(id(8)), String(id(9))].sort(), 'every host of the viewer is the viewer\'s own, marching or not');
  assert.deepEqual(x.explored, [{ p: 2, q: 0, tile: 8 }, { p: 2, q: 0, tile: 9 }, { p: 2, q: 0, tile: 30 }], 'the Holding\'s record and the viewer\'s own EXPLORE events');
  assert.deepEqual(x.destinations, [{ p: 1, q: 1, tile: 5 }]);
  assert.deepEqual([x.stage, x.faction, x.wallet, x.home.tile], ['final', 0, 'W', 7]);
  // a ticket: the candidates' tiles come from the terrain; without it they wait
  const ticket = { mode: 'play', record: { rings: [{}, {}, {}] }, citizen: { faction: 0 }, holdings: [], land: { stage: 'ticket', ticket: { sites: [{ p: 2, q: 0, site: 5 }, { p: 1, q: 1, site: 4 }] } } };
  assert.deepEqual(surveyInput(ticket, { terrainOf: (p, q) => (p === 2 ? { sites: [1, 2, 3, 4, 5, 19] } : null) }).candidates, [{ p: 2, q: 0, site: 5, tile: 19 }, { p: 1, q: 1, site: 4, tile: null }]);
  assert.deepEqual(surveyInput({ mode: 'play', citizen: null, holdings: [] }).stage, 'none');
  assert.deepEqual(surveyInput({ mode: 'spectate', record: { rings: [{}, {}] } }), { mode: 'spectate', ringsOpen: 2 });
});

test('the edge between paint and chart: a distance field of the surveyed tiles, solid on them, gone a little way out', () => {
  const sv = survey({ villages: [village(0)] });
  const c = project(home.q, home.r), box = { x: c.x - 300, y: c.y - 300, w: 600, h: 600 }, mres = 0.25;
  const { f, w, h } = chart.surveyField(sv, box, mres, S.L2);
  assert.equal(f.length, w * h);
  const at = (x, y) => f[Math.floor((y - box.y) * mres) * w + Math.floor((x - box.x) * mres)];
  assert.ok(at(c.x, c.y) < 0.2, 'on a surveyed tile\'s centre');
  assert.equal(at(c.x - 290, c.y - 290) > 2 || at(c.x - 290, c.y - 290) === Infinity, true, 'far from all of them');
  assert.equal(chart.coverage(0.3, 10, 10), 1);
  assert.equal(chart.coverage(3, 10, 10), 0);
  assert.equal(chart.coverage(Infinity, 10, 10), 0);
  let last = 1;
  for (let d = 0.6; d <= 1.8; d += 0.05) { const v = chart.coverage(d, 123, 45); assert.ok(v <= last + 1e-9 && v >= 0 && v <= 1, `falls with distance at ${d}`); last = v; }
  assert.ok(chart.EDGE.paint.inner - chart.EDGE.paint.rough > 0.8, 'a surveyed hex keeps (nearly) all its own paint: its inscribed circle is solid');
  assert.deepEqual([chart.MUTED.saturation, chart.MUTED.brightness], [0.35, 0.7]);
  // no canvas here: the painters return quietly
  assert.equal(chart.parchment(), null);
  assert.equal(chart.paintReveal(null, { reveals: new Map([[1, 0]]) }), 0);
  chart.paintChart(null, [{ q: 0, r: 0, x: 0, y: 0, name: 'plains' }]);
  chart.applySurvey(null, { box, res: 1, survey: sv, sig: '12' });
  assert.equal(chart.mutedSprite(null), null);
  assert.equal(typeof chart.fxNow(), 'number');
  globalThis.__fxNow = () => 42;
  try { assert.equal(chart.fxNow(), 42, 'the effects engine\'s clock when it has one'); } finally { delete globalThis.__fxNow; }
});

// ------------------------------------------------------------------ every surface asks the same lookup
const TERRAIN = { terrain: Array(PROVINCE_TILES).fill(0), sites: [7, 20, 45], names: ['Grassland'] };
const REC = { p: 2, q: 0, owners: [0, 2, 4, 7, 7, 7, 7, 7, 7, 7, 7, 7], sites: [1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0], clash: true };
const PROV = { p: 2, q: 0, relations: 0n, sites: Uint8Array.from([7, 20, 45]), resolveSummary: { bell: 41 }, roadMask: 0n, resolvedNext: 43,
  siteMirror: [{ state: 1, faction: 0, tier: 1, garrison: 300000, shieldUntilBell: 50 }, { state: 1, faction: 2, tier: 1, garrison: 90000, shieldUntilBell: 0 }, { state: 1, faction: 4, tier: 0, garrison: 50000, shieldUntilBell: 0 }],
  entries: [{ id: 5n, faction: 0, unit: 0, tile: 7, state: 1, troops: 400000 }, { id: 6n, faction: 2, unit: 0, tile: 20, state: 1, troops: 200000 }, { id: 9n, faction: 0, unit: 0, tile: 45, state: 1, troops: 100000 }],
  camp: { state: 1, tile: 21, troops: 250 } };
/** A survey over province (2,0) with exact levels for chosen tiles: tile 7 in sight, tile 20 surveyed, tile 45 chart. */
function threeLevels() {
  const h7 = tileHex(2, 0, 7), h20 = tileHex(2, 0, 20), h21 = tileHex(2, 0, 21);
  const sv = S.buildSurvey({ ringsOpen: 3, anchors: [{ q: h7.q, r: h7.r, radius: 0, level: S.L3 }, { q: h20.q, r: h20.r, radius: 0, level: S.L2 }, { q: h21.q, r: h21.r, radius: 0, level: S.L2 }] });
  sv.ownHosts = new Set(['9']);
  assert.deepEqual([7, 20, 21, 45].map(i => sv.levelOf(2, 0, i)), [3, 2, 2, 1]);
  return sv;
}

test('the tile model of the painter: the chart keeps terrain only; surveyed land keeps its villages and nothing that is happening', () => {
  const sv = threeLevels();
  const art = new SpriteArt();
  const entry = { p: 2, q: 0, ...TERRAIN, rec: REC, prov: PROV, fog: 'sight', tiers: [1, 1, 0] };
  const m = art.model([entry], { ringsOpen: 3, survey: sv });
  const t = i => m.byId.get(`2,0,${i}`);
  assert.deepEqual([t(7).lv, t(7).site, t(7).state, t(7).owner, t(7).shield, t(7).fog], [3, 0, 1, 0, true, 'sight']);
  assert.deepEqual([t(20).lv, t(20).site, t(20).state, t(20).owner, t(20).tier, t(20).shield, t(20).fog], [2, 1, 1, 2, 1, false, 'known'], 'a surveyed village: nation and tier');
  assert.deepEqual([t(45).lv, t(45).site, t(45).state, t(45).owner, t(45).fog], [1, undefined, undefined, undefined, 'distant'], 'on the chart there is no village');
  assert.equal(t(45).name, 'grassland', 'the terrain is public: the chart draws it');
  assert.equal(t(21).camp, false, 'a camp is told in sight only');
  assert.equal(t(45).wash, null, 'no nation wash on the chart');
  assert.ok(t(7).wash && t(20).wash, 'surveyed land keeps its nation\'s wash');
  assert.equal(t(8).wash, null, 'a village\'s land reaches only as far as the survey');
  assert.equal(t(8).fringe, true, 'chart next to surveyed land lies under the paint that bleeds out');
  assert.equal(art.model([entry], { ringsOpen: 3, survey: sv }), m, 'kept while the survey is the same object');
  // the whole public world: as before
  const open = art.model([entry], { ringsOpen: 3, survey: S.openSurvey(3) });
  assert.deepEqual([open.byId.get('2,0,45').lv, open.byId.get('2,0,45').state, open.byId.get('2,0,21').camp, open.byId.get('2,0,45').fog], [3, 1, true, 'sight']);
  assert.equal(art.model([entry], { ringsOpen: 3 }).byId.get('2,0,45').state, 1, 'no survey at all (a caller of old): everything');
});

test('the far view\'s realms: only surveyed villages, their land only as far as it is surveyed', () => {
  if (typeof Path2D === 'undefined') globalThis.Path2D = class { moveTo() {} lineTo() {} closePath() {} };
  const sv = threeLevels();
  const entry = { p: 2, q: 0, ...TERRAIN, rec: REC, prov: PROV, tiers: [1, 1, 0] };
  assert.deepEqual(buildRealms([entry]).holdings.map(h => h.f), [0, 2, 4], 'the spectator\'s: all three');
  const r = buildRealms([entry], { levelAt: sv.levelAt });
  assert.deepEqual(r.holdings.map(h => h.f), [0, 2], 'the village on the chart is not marked');
  assert.equal(r.fill[4], undefined, 'and its nation has no land there');
  assert.ok(r.fill[0] && r.fill[2]);
});

test('the inspector: terrain only on the chart; a surveyed village without what happens there; everything in sight', () => {
  setLang('ja');
  const sv = threeLevels();
  const FS = { mode: 'play', citizen: { faction: 0 }, holdings: [], nowBell: 42, land: { stage: 'final' }, survey: sv, roster: { ownerOf: () => ({ tag: 9n }), tierOf: () => 1 },
    overviews: new Map([[2, { provinces: [REC] }]]), provinces: new Map([['2,0', { province: PROV }]]), selected: { p: 2, q: 0, idx: 45 } };
  const terrainOf = () => TERRAIN;
  const chartTile = inspect.inspectModel(FS, terrainOf);
  assert.deepEqual([chartTile.level, chartTile.tile.terrain, chartTile.tile.site, chartTile.tile.camp], [1, 'Grassland', null, null]);
  assert.deepEqual(chartTile.tile.hosts.map(h => h.id), ['9'], 'the viewer\'s own host is told wherever it stands');
  assert.match(String(inspect.render(FS, terrainOf)), /未測量/);
  FS.selected = { p: 2, q: 0, idx: 20 };
  const seen = inspect.inspectModel(FS, terrainOf);
  assert.deepEqual([seen.level, seen.tile.site.state, seen.tile.site.faction, seen.tile.site.tier, seen.tile.site.garrison, seen.tile.site.shield], [2, 'holding', 2, 1, null, false], 'nation and tier, not the garrison');
  assert.deepEqual(seen.tile.hosts, [], 'another nation\'s host: in sight only');
  assert.match(String(inspect.render(FS, terrainOf)), /測量済み/);
  FS.selected = { p: 2, q: 0, idx: 21 };
  assert.equal(inspect.inspectModel(FS, terrainOf).tile.camp, null, 'a camp: in sight only');
  FS.selected = { p: 2, q: 0, idx: 7 };
  const sight = inspect.inspectModel(FS, terrainOf);
  assert.deepEqual([sight.level, sight.tile.site.garrison, sight.tile.hosts.length, sight.clash, sight.reportBell], [3, 300, 1, true, 41]);
  // the province as a whole: the nations whose villages the viewer has surveyed
  FS.selected = { p: 2, q: 0 };
  assert.deepEqual(inspect.inspectModel(FS, terrainOf).owners, [0, 2]);
  // a province the viewer has seen nothing of: no owners, no clash, no report
  const blank = S.buildSurvey({ ringsOpen: 3, anchors: [] });
  blank.ownHosts = new Set();
  FS.survey = blank;
  const none = inspect.inspectModel(FS, terrainOf);
  assert.deepEqual([none.owners, none.clash, none.reportBell, none.level], [[], false, null, 1]);
  assert.deepEqual(inspect.inspectActions(FS, none).map(a => a.act), ['pin-toggle'], 'nothing to replay there');
  // the spectator (no survey on the page): everything
  delete FS.survey;
  assert.deepEqual(inspect.inspectModel(FS, terrainOf).owners, [0, 2, 4]);
});

test('search: a lord and a nation\'s lands are found where the viewer has surveyed them; a province by its coordinates anywhere', () => {
  setLang('ja');
  const sv = threeLevels();
  const recs = new Map([['2,0', REC]]);
  const roster = { entries: () => [{ p: 2, q: 0, site: 1, tag: 9n, tier: 1 }, { p: 2, q: 0, site: 2, tag: 11n, tier: 0 }] };
  const sitesOf = () => TERRAIN.sites;
  const name = n => I.displayName(I.identityOf(n), { language: 'en' });
  assert.equal(SEARCH.searchMap(name(9n), { recs, roster, sitesOf, survey: sv })[0]?.kind, 'lord', 'the lord of a surveyed village');
  assert.deepEqual(SEARCH.searchMap(name(11n), { recs, roster, sitesOf, survey: sv }).filter(x => x.kind === 'lord'), [], 'the lord of a village on the chart is not found');
  assert.equal(SEARCH.searchMap(name(11n), { recs, roster, sitesOf }).filter(x => x.kind === 'lord').length, 1, 'the spectator finds everyone');
  assert.deepEqual(SEARCH.searchMap('2,0', { recs, survey: S.buildSurvey({ ringsOpen: 3 }) }).map(x => x.kind), ['province'], 'the chart is everyone\'s');
  const lands = q => SEARCH.searchMap(q, { recs, roster, sitesOf, survey: sv }).filter(x => x.kind === 'faction').length;
  assert.deepEqual([lands(factionName(0)), lands(factionName(2)), lands(factionName(4))], [1, 1, 0], 'a nation is found by the villages the viewer has surveyed');
});

test('the minimap: chart for what is not surveyed, the surveyed tiles on it, the viewer in gold; no nation colours of the wider world', () => {
  const fills = [], strokes = [];
  const ctx = new Proxy({}, {
    get: (_, k) => (k === 'createRadialGradient' ? () => ({ addColorStop() {} }) : typeof k === 'string' && /^(fillStyle|strokeStyle|lineWidth|globalAlpha)$/.test(k) ? undefined : () => {}),
    set: (_, k, v) => { if (k === 'fillStyle' && typeof v === 'string') fills.push(v); if (k === 'strokeStyle' && typeof v === 'string') strokes.push(v); return true; },
  });
  const recs = new Map();
  for (const [p, q] of [[0, 0], [1, 0], [2, 0], [-1, 0], [0, 1]]) recs.set(`${p},${q}`, { p, q, owners: [3, 3, 3, 7, 7, 7, 7, 7, 7, 7, 7, 7], sites: [1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0], clash: true });
  const sv = survey({ villages: [village(0)] });
  sv.home = HOME;
  MINI.paintMinimap(ctx, { recs, rings: 3, survey: sv, now: 300 });
  assert.ok(fills.includes(MINI.MINI_SURVEY.chart) && fills.includes(MINI.MINI_SURVEY.sight) && fills.includes(MINI.MINI_SURVEY.you));
  assert.equal(fills.includes(FACTION_FILL[3]), false, 'no province is coloured by who holds most of it');
  const inSight = [...recs.values()].filter(r => sv.province(r.p, r.q).max === S.L3).length;
  assert.ok(inSight >= 1 && inSight < recs.size);
  assert.equal(fills.filter(f => f === '#ff5a3c').length, inSight, 'a clash is marked only where some of the province is in sight');
  // the spectator's minimap: every realm, as before
  fills.length = 0;
  MINI.paintMinimap(ctx, { recs, rings: 3, survey: S.openSurvey(3) });
  assert.ok(fills.includes(FACTION_FILL[3]));
  assert.equal(fills.includes(MINI.MINI_SURVEY.chart), false);
  assert.equal(fills.filter(f => f === '#ff5a3c').length, 5);
  assert.ok(RADIUS > 0);
});

test('the legend and its one line: four levels, the whole public world one link away, no word of secrecy', () => {
  setLang('ja');
  assert.deepEqual(SURVEY_LEGEND.map(x => x.id), ['sight', 'surveyed', 'chart', 'cloud']);
  const html = String(renderSurveyHelp());
  assert.match(html, /href="spectate\.html"/);
  assert.match(html, /隠しているのではありません/);
  assert.match(html, /チェーンの記録はすべて公開/);
  assert.equal(/style=/.test(html), false, 'no inline style (the page\'s CSP)');
  for (const x of SURVEY_LEGEND) assert.ok(html.includes(x.name()) && html.includes(`survey-${x.id}`));
  // the words the brief rules out: in none of the legend's own lines (the help line's one denial aside)
  const own = [...SURVEY_LEGEND.flatMap(x => [x.name(), x.text()])].join(' ');
  for (const w of ['隠', '秘密', '敵から見えない']) assert.equal(own.includes(w), false, w);
  assert.equal(surveyLine().split('隠').length, 2, 'the line says once that nothing is being kept back, and nothing else of the kind');
  setLang('en');
  try {
    const en = String(renderSurveyHelp());
    assert.match(en, /every record on the chain is public/);
    assert.match(en, /spectator page/);
    assert.equal(/fog of war|hidden from|secret/i.test(en), false);
  } finally { setLang('ja'); }
});

test('the province painters\' fog names follow the survey: a province is in sight when a tile of it is', () => {
  assert.equal(layers.SIGHT_PROVINCES, 0);
  assert.equal(layers.fogLevel({ ringOpen: true, sightDistance: 0 }), 'sight');
  assert.equal(layers.fogLevel({ ringOpen: true, sightDistance: 1, known: true }), 'known');
  assert.equal(layers.fogLevel({ ringOpen: true }), 'distant');
});
