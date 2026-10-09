// The land (UX brief §5; permutation-server/web/frontier/map/ownland.mjs,
// actions.mjs, homepointer.mjs, labels.mjs, landing.mjs, names.mjs and the
// places that use them). What every test here leans on:
//   · the viewer's own land is told from a nation-mate's by the SITE that
//     claims a tile, and gold marks only what is the viewer's own;
//   · the lit tiles come from the rule functions (reachTiles over the rules
//     module's passable mask, exploreTargets, actionBlocks), and a tile is
//     never called an attack where the map draws nothing to attack;
//   · the map never says "fighting" for history, and a camp's troops are
//     whole troops.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as LAND from '../../permutation-server/web/frontier/map/ownland.mjs';
import * as ACT from '../../permutation-server/web/frontier/map/actions.mjs';
import * as PTR from '../../permutation-server/web/frontier/map/homepointer.mjs';
import { layoutLabels } from '../../permutation-server/web/frontier/map/labels.mjs';
import * as BOOK from '../../permutation-server/web/frontier/map/landing.mjs';
import { placeName, placeWhere } from '../../permutation-server/web/frontier/map/names.mjs';
import * as S from '../../permutation-server/web/frontier/map/survey.mjs';
import { SpriteArt, buildRealms, OTHER_WASH } from '../../permutation-server/web/frontier/map/sprites.mjs';
import { CLOUD_RINGS, FrontierMap, paintRealmLabels } from '../../permutation-server/web/frontier/map/fmap.mjs';
import { HEX_W, SHEET, paintSheet, paintTable, sheetOf, tableShows, woodTexture } from '../../permutation-server/web/frontier/map/table.mjs';
import { CloudSea, PUFF, driftTexture, puffsOf, seaField } from '../../permutation-server/web/frontier/map/cloudsea.mjs';
import { landBox } from '../../permutation-server/web/frontier/map/camera.mjs';
import * as inspect from '../../permutation-server/web/frontier/hud/inspect.mjs';
import * as ACTIVITY from '../../permutation-server/web/frontier/people/activity.mjs';
import { DIRECTIONS, hexDistance, locate, ringOf, ringProvinces, tileHex, PROVINCE_TILES } from '../../permutation-server/web/frontier/fgeo.mjs';
import { hostId } from '../../permutation-server/web/frontier/faddr.mjs';
import { DEPART_STAMINA } from '../../permutation-server/web/frontier/fmarch.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';
import { RADIUS, project } from '../../permutation-server/web/map.mjs';
import { GLYPHS } from '../../permutation-server/web/frontier/map/glyphs.mjs';
import { FACTION_COLORS } from '../../permutation-server/web/frontier/fi18n.mjs';

const HOME = { p: 2, q: 0, tile: 7 };
const home = tileHex(HOME.p, HOME.q, HOME.tile);
const dist = (a, b) => hexDistance(a.q, a.r, b.q, b.r);

// ------------------------------------------------------------------ the viewer's land
test('the land of a village: the tiles it works by tier, less what is refused; its own tile always', () => {
  assert.deepEqual([0, 1, 2, 3].map(tier => LAND.landTiles({ ...home, tier }).length), [7, 19, 19, 37], 'radius 1, 2, 2, 3');
  const dry = LAND.landTiles({ ...home, tier: 1 }, (q, r, d) => d < 2);
  assert.equal(dry.length, 7);
  assert.deepEqual(LAND.landTiles({ ...home, tier: 0 }, () => false), [{ q: home.q, r: home.r, d: 0 }], 'the village stands on its own tile whatever is refused');
  assert.ok(LAND.landTiles({ ...home, tier: 3 }).every(t => t.d === dist(t, home)));
});

test('the outline of a land: closed loops along its outer edges; a hole is a loop of its own', () => {
  const flower = LAND.landShape(LAND.landTiles({ ...home, tier: 0 }));
  assert.equal(flower.loops.length, 1);
  assert.equal(flower.loops[0].length, 18, 'seven hexes: 18 outer edges');
  assert.deepEqual(flower.rings.map(r => r.length), [1, 6]);
  assert.equal(flower.maxD, 1);
  assert.deepEqual(flower.centre, project(home.q, home.r));
  // every corner of a loop is one hex side from the next (the loop is walked edge by edge and closes)
  const side = Math.hypot(...[0, 1].map(i => flower.loops[0][0][i] - flower.loops[0][1][i]));
  flower.loops[0].forEach((c, i, all) => { const n = all[(i + 1) % all.length]; assert.ok(Math.abs(Math.hypot(n[0] - c[0], n[1] - c[1]) - side) < RADIUS * 0.3 + 1e-6); });
  // a ring of tiles around a tile left out (a lake in the middle): outside and inside
  const ring = LAND.landShape(LAND.landTiles({ ...home, tier: 1 }).filter(t => t.d === 2 || t.d === 1).map(t => ({ ...t })));
  assert.equal(ring.loops.length, 2);
  assert.deepEqual(ring.loops.map(l => l.length).sort((a, b) => a - b), [6, 30]);
  assert.notEqual(LAND.landShape(LAND.landTiles({ ...home, tier: 0 })).key, ring.key);
});

test('the landing: the colour floods ring by ring about 90 ms apart, then the border, then the standard drops and raises dust', () => {
  const T = LAND.LANDING;
  assert.equal(T.ring, 90);
  const at = t => LAND.landingAt(t, 1);
  assert.deepEqual([at(0).ring(0).fill, at(0).ring(1).fill, at(0).border, at(0).standard.shown, at(0).dust], [0, 0, 0, false, null], 'nothing yet at the start');
  assert.ok(at(200).ring(0).fill > 0 && at(200).ring(1).fill === 0, 'at 200 ms the village\'s own tile has begun, the ring around it not yet');
  assert.ok(at(200).ring(0).flash > 0, 'light runs ahead of the colour');
  assert.ok(at(500).ring(1).fill > 0.9 && at(500).border > 0 && !at(500).standard.shown, 'at 500 ms the land is in and the border is drawing on');
  const mid = at(900).standard;
  assert.ok(mid.shown && mid.lift > 0 && mid.lift < 1, 'at 900 ms the standard is falling');
  assert.ok(at(1500).standard.lift < 0.08 && at(1500).dust !== null, 'at 1500 ms it stands and its dust still hangs');
  assert.equal(at(LAND.landingMs(1)).done, true);
  assert.equal(at(LAND.landingMs(1) - 1).done, false);
  // a larger land takes one ring longer per ring; each ring starts 90 ms after the one before
  assert.equal(LAND.landingMs(3) - LAND.landingMs(1), 2 * T.ring);
  const starts = [0, 1, 2, 3].map(d => { for (let t = 0; t < 2000; t++) if (LAND.landingAt(t, 3).ring(d).fill > 0) return t; return -1; });
  assert.deepEqual(starts.slice(1).map((t, i) => t - starts[i]), [90, 90, 90]);
  // the fall: from high to the ground, never below it by more than a short rebound
  assert.equal(LAND.dropCurve(0), 1);
  assert.ok(Math.abs(LAND.dropCurve(T.impact)) < 1e-9 && Math.abs(LAND.dropCurve(1)) < 1e-9);
  for (let k = 0; k <= 1; k += 0.05) assert.ok(LAND.dropCurve(k) >= 0 && LAND.dropCurve(k) <= 1);
});

test('the viewer\'s land is a band, not a flood: 0.38 at the border falling to 0.08 two thirds of a hex inward, laid on as a cast; another nation is drawn quieter', () => {
  const F = LAND.OWN_FILL;
  assert.deepEqual([F.rim, F.middle], [0.38, 0.08], 'the brief\'s numbers (section 11.5)');
  assert.ok(Math.abs(F.depth - (2 / 3) * Math.sqrt(3) * RADIUS) < 1e-9, 'two thirds of a hex');
  assert.ok(['overlay', 'soft-light', 'multiply'].includes(F.blend), 'a blend that keeps the ground\'s own colour, never a plain flood');
  // the strokes: widest first, each inside the one before, never past the depth; over the fill they add up to the
  // rim at the border and fall toward the middle
  const steps = LAND.bandSteps();
  assert.equal(steps.length, F.steps);
  assert.ok(Math.abs(steps[0].width - 2 * F.depth) < 1e-9 && steps.every((s, i) => i === 0 || s.width < steps[i - 1].width));
  assert.ok(steps.every(s => s.alpha > 0 && s.alpha < 0.2), 'no step is a visible line');
  const total = n => 1 - (1 - F.middle) * steps.slice(0, n).reduce((a, s) => a * (1 - s.alpha), 1);
  assert.ok(total(steps.length) > 0.34 && total(steps.length) <= F.rim + 1e-9, `at the border: ${total(steps.length).toFixed(3)}`);
  assert.ok(total(1) < 0.12 && total(1) > F.middle, 'the innermost step is almost the middle');
  for (let n = 2; n <= steps.length; n++) assert.ok(total(n) > total(n - 1), 'stronger toward the border');
  // painted under what stands on the land: the fill and the band use the blend, the border plain strokes
  const g = recorder();
  if (typeof Path2D !== 'undefined') {
    LAND.paintOwnLand(g, { shape: LAND.landShape(LAND.landTiles({ ...home, tier: 1 })), provisional: false }, { zoom: 1.3, faction: 0, still: true });
    const modes = g.calls.filter(c => c[0] === '=' && c[1] === 'globalCompositeOperation').map(c => c[2]);
    assert.ok(modes.includes(F.blend) && modes[modes.length - 1] === 'source-over', 'the cast, then plain painting again');
    assert.ok(!modes.includes('color'), 'the ground is never repainted in the nation\'s hue');
  }
  assert.ok(OTHER_WASH < 1);
});

const TERRAIN = { terrain: Array(PROVINCE_TILES).fill(0), sites: [7, 20, 45], names: ['Grassland'] };
const REC = { p: 2, q: 0, owners: [0, 0, 4, 7, 7, 7, 7, 7, 7, 7, 7, 7], sites: [1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0], clash: false };
const PROV = { p: 2, q: 0, relations: 0n, sites: Uint8Array.from([7, 20, 45]), resolveSummary: { bell: 0 }, roadMask: 0n, resolvedNext: 43, passableMask: (1n << 61n) - 1n, exploredMask: 0n,
  siteMirror: [{ state: 1, faction: 0, tier: 1, garrison: 300000, shieldUntilBell: 0 }, { state: 1, faction: 0, tier: 0, garrison: 90000, shieldUntilBell: 0 }, { state: 1, faction: 4, tier: 0, garrison: 50000, shieldUntilBell: 0 }],
  entries: [], camp: { state: 1, tile: 21, troops: 250 } };
/** A viewer of nation 0 whose village is on tile 7 (site 0); tile 20 is a nation-mate's, tile 45 another nation's. Everything in sight. */
function viewer({ state = 2 } = {}) {
  const sv = S.buildSurvey({ ringsOpen: 3, anchors: S.anchorsOf({ villages: [{ ...HOME, tier: 3 }] }) });
  Object.assign(sv, { villages: [{ ...HOME, tier: 1, state }], faction: 0, ownHosts: new Set(), home: HOME, rev: 1 });
  return sv;
}

test('the tile model records the site that claims a tile: the viewer\'s land is told from a nation-mate\'s', () => {
  const sv = viewer();
  const art = new SpriteArt();
  const entry = { p: 2, q: 0, ...TERRAIN, rec: REC, prov: PROV, fog: 'sight', tiers: [1, 0, 0] };
  const m = art.model([entry], { ringsOpen: 3, survey: sv });
  const t = i => m.byId.get(`2,0,${i}`);
  assert.equal(m.owner.get(`${home.q},${home.r}`).s, t(7), 'the claiming site is kept with the claim');
  assert.deepEqual([t(7).wash.mine, t(7).wash.quiet, t(20).wash.mine, t(20).wash.quiet, t(45).wash.mine, t(45).wash.quiet], [true, false, false, false, false, true],
    'mine; a nation-mate\'s (the nation\'s quiet wash); another nation\'s (quieter still)');
  assert.equal(m.lands.length, 1);
  const land = m.lands[0];
  assert.deepEqual([land.key, land.provisional, land.village.tier], ['2,0,7', false, 1]);
  assert.ok(land.tiles.length > 7 && land.tiles.length <= 19, 'a town works two rings, less what a nearer village claims');
  assert.ok(land.tiles.every(x => m.owner.get(`${x.q},${x.r}`).s === t(7)), 'only tiles its own site claims');
  const h20 = tileHex(2, 0, 20);
  assert.ok(!land.tiles.some(x => x.q === h20.q && x.r === h20.r), 'never the nation-mate\'s village');
  assert.equal(land.shape.loops.length >= 1, true);
  // the ground bitmap of the province is painted again when "mine" changes
  assert.match(m.washSig.get('2,0'), /^v0/);
  assert.match(m.washSig.get('2,0'), /m0/);
  // a provisional village
  assert.equal(new SpriteArt().model([entry], { ringsOpen: 3, survey: viewer({ state: 1 }) }).lands[0].provisional, true);
  // a page with no viewer (the spectator): nobody's land is "mine", nothing is quieter
  const open = new SpriteArt().model([entry], { ringsOpen: 3, survey: S.openSurvey(3) });
  assert.deepEqual([open.lands.length, open.byId.get('2,0,7').wash.mine, open.byId.get('2,0,45').wash.quiet], [0, false, false]);
});

test('the far view: the viewer\'s own village keeps its mark and claims no realm land (its land is drawn as its own)', () => {
  if (typeof Path2D === 'undefined') globalThis.Path2D = class { moveTo() {} lineTo() {} closePath() {} };
  const entry = { p: 2, q: 0, ...TERRAIN, rec: { ...REC, owners: [0, 7, 4, 7, 7, 7, 7, 7, 7, 7, 7, 7], sites: [1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0] }, prov: PROV, tiers: [1, 0, 0] };
  const all = buildRealms([entry]);
  assert.ok(all.fill[0] && all.fill[4]);
  const mine = buildRealms([entry], { own: new Set(['2,0,7']) });
  assert.equal(mine.fill[0], undefined, 'no nation wash under the viewer\'s own land');
  assert.ok(mine.fill[4]);
  assert.deepEqual(mine.holdings.map(h => h.f), [0, 4], 'the village is still marked');
});

// ------------------------------------------------------------------ the lit tiles
test('what a reached tile is called follows the survey: nothing is an attack where the map draws nothing to attack', () => {
  const prov = { ...PROV, entries: [{ id: 1n, faction: 2, tile: 30, state: 1, troops: 1 }, { id: 2n, faction: 0, tile: 31, state: 1, troops: 1 }] };
  const own = new Set(['2,0,7']);
  const k = (idx, level, extra = {}) => ACT.kindOf(prov, idx, { faction: 0, level, own, nowBell: 42, ...extra });
  assert.equal(k(7, 3), 'home', 'the viewer\'s own village: the way back');
  assert.equal(k(20, 3), 'move', 'a nation-mate\'s village is not gold (gold is the viewer\'s own) and not a target');
  assert.equal(k(45, 3), 'attack', 'another nation\'s village');
  assert.equal(k(45, 2), 'attack', 'a surveyed village is drawn, so it may be named');
  assert.equal(k(45, 1), 'move', 'on the chart the map draws no village: no ember tile either');
  assert.deepEqual([k(21, 3), k(21, 2)], ['attack', 'move'], 'a camp is told only in sight');
  assert.deepEqual([k(30, 3), k(30, 2), k(31, 3)], ['attack', 'move', 'move'], 'a hostile host only in sight; the viewer\'s nation never');
  // a nation the province's relations call not hostile; a village under protection
  assert.equal(ACT.kindOf({ ...prov, relations: 1n << 4n }, 45, { faction: 0, level: 3, own }), 'move');
  const shielded = { ...prov, siteMirror: prov.siteMirror.map((m, j) => (j === 2 ? { ...m, shieldUntilBell: 60 } : m)) };
  assert.equal(ACT.kindOf(shielded, 45, { faction: 0, level: 3, own, nowBell: 42 }), 'move', 'a protected village is not offered as a target');
  assert.equal(ACT.kindOf(null, 3, { level: 3 }), 'move');
});

test('the lit tiles come from the rule functions: the walk over the rules module\'s passable mask, a Scout\'s explore targets', () => {
  const all = (1n << 61n) - 1n;
  const wet = tileHex(2, 0, 8), wetBit = 1n << 8n;
  const lit = ACT.litTiles({ origin: HOME, stamina: 120, faction: 0, nowBell: 42, own: new Set(['2,0,7']),
    provinceOf: (p, q) => (p === 2 && q === 0 ? PROV : null), passableOf: (p, q) => (p === 2 && q === 0 ? all & ~wetBit : all) });
  assert.ok(lit.tiles.length > 60);
  assert.ok(!lit.byHex.has(`${home.q},${home.r}`), 'the host\'s own tile is not a destination');
  assert.ok(!lit.byHex.has(`${wet.q},${wet.r}`), 'a tile the rules module calls impassable is not lit, whatever the account\'s mask says');
  assert.ok(lit.tiles.every(t => t.d >= 1 && t.d <= 6), 'the near reach: at most six steps');
  assert.ok(lit.tiles.every(t => dist({ q: t.hq, r: t.hr }, home) <= t.d));
  const kindAt = idx => { const h = tileHex(2, 0, idx); return lit.byHex.get(`${h.q},${h.r}`)?.kind; };
  assert.deepEqual([kindAt(21), kindAt(45), kindAt(20)], ['attack', 'attack', 'move']);
  assert.ok(lit.tiles.some(t => t.p !== 2 || t.q !== 0), 'the walk goes on into a province the page has not loaded (its terrain is known)');
  // a province the rules module knows nothing of stops the walk
  const shut = ACT.litTiles({ origin: HOME, stamina: 120, faction: 0, provinceOf: () => PROV, passableOf: (p, q) => (p === 2 && q === 0 ? all : null) });
  assert.ok(shut.tiles.every(t => t.p === 2 && t.q === 0));
  // nothing is lit for a host that may not depart; a Scout's targets are lit on their own
  const idle = ACT.litTiles({ origin: HOME, stamina: 120, march: false, explore: [8, 2], passableOf: () => all });
  assert.deepEqual(idle.tiles.map(t => [t.tile, t.kind, t.d]), [[8, 'explore', 1], [2, 'explore', 1]]);
  // with both: the tiles to explore take the place of the plain move on them
  const both = ACT.litTiles({ origin: HOME, stamina: 120, explore: [8], passableOf: () => all, provinceOf: () => PROV });
  assert.equal(both.byHex.get(`${wet.q},${wet.r}`).kind, 'explore');
  assert.equal(both.tiles.filter(t => t.hq === wet.q && t.hr === wet.r).length, 1);
  // survey: a camp out of sight is a plain move
  assert.equal(ACT.litTiles({ origin: HOME, stamina: 120, faction: 0, provinceOf: () => PROV, passableOf: () => all, levelOf: () => 2 }).tiles.find(t => t.p === 2 && t.q === 0 && t.tile === 21).kind, 'move');
});

const id = n => hostId({ p: 2, q: 0, site: 0, gen: 0, seq: n });
const entryOf = (n, o = {}) => ({ id: id(n), faction: 0, unit: 0, tile: 7, state: 1, troops: 600_000, staminaValue: 120, staminaBell: 40, readyBell: 0, pendOp: 0, fromBell: 1, ...o });
const holding = (o = {}) => ({ p: 2, q: 0, site: 0, gen: 0, tile: 7, tier: 1, state: 2, finalTs: 0, ticketBell: 1, transit: [{ state: 0, hostId: 0n }, { state: 0, hostId: 0n }], explore: { state: 0 }, ...o });
const page = (entries, o = {}) => ({ mode: 'play', holdings: [holding(o.holding)], nowBell: 42, now: 1e9, citizen: { faction: 0 }, provinces: new Map([['2,0', { province: { ...PROV, resolvedNext: 42, entries } }]]), ...o.state });

test('the hosts that act for a selected tile: who may march, who may explore, and why not', () => {
  const state = page([entryOf(1), entryOf(2, { unit: 6, troops: 100_000 }), entryOf(3, { state: 3 }), entryOf(4, { tile: 9 }), entryOf(5, { troops: 900_000, staminaValue: 20, staminaBell: 42 })]);
  const actors = ACT.actorsAt(state, 2, 0, 7);
  assert.deepEqual(actors.map(a => [a.troops, a.unit, a.march.ok]), [[600, 0, true], [100, 6, true], [900, 0, false]], 'the host that can march first, then the Scout, then the one that cannot; a host on the road or on another tile is not here');
  assert.deepEqual(actors[2].march.blocks, ['Cooldown']);
  assert.ok(20 < DEPART_STAMINA);
  assert.deepEqual([actors[1].explore.ok, actors[1].explore.targets.length], [true, 6], 'the Scout\'s six neighbours (none explored)');
  assert.equal(actors[0].explore, null);
  assert.equal(actors[0].holdingIndex, 0);
  // a provisional village: its hosts may not depart or explore yet, and the reason is the program's own
  const early = ACT.actorsAt(page([entryOf(1), entryOf(2, { unit: 6 })], { holding: { state: 1, finalTs: 2e9 } }), 2, 0, 7);
  assert.ok(early.every(a => !a.march.ok && a.march.blocks.includes('NotFinal')));
  assert.equal(early[1].explore.ok, false);
  setLang('ja');
  assert.equal(ACT.blockText(early[0]), '村がまだ確定していません');
  assert.equal(ACT.blockText(actors[0]), '');
  assert.equal(ACT.actorText(actors[0]), '槍兵 600');
  setLang('en');
  assert.equal(ACT.actorText(actors[1]), 'Scout 100');
  setLang('ja');
  // no free transit record: the host cannot depart
  assert.deepEqual(ACT.actorsAt(page([entryOf(1)], { holding: { transit: [{ state: 1, hostId: 99n }] } }), 2, 0, 7)[0].march.blocks, ['TransitState']);
  assert.deepEqual(ACT.actorsAt(state, 2, 0, 30), []);
  assert.deepEqual(ACT.actorsAt({ ...state, provinces: new Map() }, 2, 0, 7), [], 'a province the page does not hold yet');
});

test('the page\'s actions: lit on selection with no button first; the same tile again takes the next host; kept between frames', () => {
  let t = 1000;
  const all = (1n << 61n) - 1n;
  const actions = ACT.createActions({ passableOf: () => all, clock: () => t });
  const state = { ...page([entryOf(1), entryOf(2, { unit: 6, troops: 100_000 })]), selected: { p: 2, q: 0, idx: 7 } };
  const A = actions(state);
  assert.deepEqual([A.mode, A.actor.troops, A.actors.length, A.index, A.t0], ['select', 600, 2, 0, 1000]);
  assert.ok(A.tiles.length > 60 && A.tiles.every(x => x.kind !== 'explore'));
  assert.deepEqual(A.hex, home);
  t = 2000;
  assert.equal(actions(state), A, 'the same model while nothing changed');
  // the Scout: its explore targets in sky blue, its own roll-out
  const B = actions({ ...state, actor: { key: '2,0,7', i: 1 } });
  assert.deepEqual([B.actor.unit, B.index, B.t0], [6, 1, 2000]);
  assert.equal(B.tiles.filter(x => x.kind === 'explore').length, 6);
  // tiles picked for the exploration are marked
  assert.deepEqual(actions({ ...state, actor: { key: '2,0,7', i: 1 }, explore: { host: { id: id(2) }, tiles: [8] } }).chosen, [8]);
  // an actor index kept for another tile does not apply here
  assert.equal(actions({ ...state, actor: { key: '2,0,9', i: 1 } }).index, 0);
  // nothing of the viewer's on the tile, a province chosen as a whole, another page: nothing is lit
  assert.equal(actions({ ...state, selected: { p: 2, q: 0, idx: 30 } }), null);
  assert.equal(actions({ ...state, selected: { p: 2, q: 0 } }), null);
  assert.equal(actions({ ...state, mode: 'spectate' }), null);
  // a march being composed: its host stays the actor wherever the selection goes; a destination dims nothing here but is told
  const c = { host: { id: id(1), tile: 7, unit: 0, troops: 600, staminaValue: 120 }, origin: { p: 2, q: 0 }, dest: { p: 2, q: 0, tile: 21 } };
  const C = actions({ ...state, selected: { p: 2, q: 0, idx: 21 }, compose: c });
  assert.deepEqual([C.mode, C.actor.id, C.origin.tile, C.dest.tile], ['compose', String(id(1)), 7, 21]);
  assert.equal(actions({ ...state, compose: { ...c, sending: true }, selected: { p: 2, q: 0, idx: 30 } }), null, 'nothing is offered while the march is being sent');
  // the survey decides what a lit tile is called
  const blind = S.buildSurvey({ ringsOpen: 3, anchors: [] });
  blind.rev = 7;
  const D = actions({ ...state, survey: blind });
  assert.ok(D.tiles.every(x => x.kind === 'move'), 'nothing surveyed: every lit tile is a plain move');
});

// Rewritten with UX brief §11.7 (it pinned "a fill of at least 0.35 inside the rim" of every lit tile, the whitewash
// the first review named): reach is one shape. No fill per tile for a move; an inward light of at most 0.15; the
// rest of the map 15 to 20% darker; only targets keep a hexagon of their own, with a glyph; and a red nation's
// attack is not the hue of its own land.
test('reach is one shape: 30 ms a ring; a 2.5-px rim, an inward light of at most 0.15, the rest 15 to 20% darker; targets alone keep a hexagon and a glyph', () => {
  assert.equal(ACT.ROLL_RING_MS, 30);
  assert.deepEqual([ACT.rollAt(0, 1), ACT.rollAt(29, 1) === 0, ACT.rollAt(30 + ACT.ROLL_FADE_MS, 1), ACT.rollAt(1e6, 6)], [0, true, 1, 1]);
  assert.ok(ACT.rollAt(100, 1) > ACT.rollAt(100, 2));
  assert.equal(ACT.rollMs(6), 6 * 30 + ACT.ROLL_FADE_MS);
  const R = ACT.REACH;
  assert.equal(R.rim, 2.5);
  assert.ok(R.inner <= 0.15 && R.inner > 0.05, 'the inward light: at most 0.15');
  assert.ok(R.dim >= 0.15 && R.dim <= 0.2, 'everything outside the set dims by 15 to 20%');
  // the strokes of the inward light add up to no more than `inner` at the contour and fall away inward
  const steps = ACT.innerSteps();
  const total = n => 1 - steps.slice(0, n).reduce((a, x) => a * (1 - x.alpha), 1);
  assert.ok(total(steps.length) <= R.inner + 1e-9 && total(steps.length) > R.inner * 0.8);
  for (let n = 2; n <= steps.length; n++) assert.ok(total(n) > total(n - 1) && steps[n - 1].width < steps[n - 2].width);
  // a move has no fill of its own; the three kinds of target have one, and each has its glyph
  assert.equal(ACT.ACTION_COLOURS.move.veil, undefined, 'no frame or fill per tile for a move');
  assert.deepEqual([...ACT.TARGET_KINDS].sort(), ['attack', 'explore', 'home']);
  for (const k of ACT.TARGET_KINDS) { assert.ok(ACT.ACTION_COLOURS[k].veil >= 0.3, `${k}: its own hexagon reads`); assert.ok(GLYPHS[ACT.KIND_GLYPH[k]], `${k}: a glyph of the HUD's sprite`); }
  assert.deepEqual([ACT.KIND_GLYPH.attack, ACT.KIND_GLYPH.home, ACT.KIND_GLYPH.explore], ['swords', 'home', 'eye']);
  assert.deepEqual(ACT.ACTION_COLOURS.move.fill, [216, 243, 234], 'pale teal-white (--reach)');
  assert.deepEqual(ACT.ACTION_COLOURS.attack.fill, [226, 85, 61], 'ember (--ember)');
  assert.deepEqual(ACT.ACTION_COLOURS.home.fill, [243, 213, 138], 'gold (--you)');
  assert.deepEqual(ACT.ACTION_COLOURS.explore.fill, [127, 196, 232], 'sky (--sky)');
  assert.deepEqual(ACT.SELECT_COLOUR, { own: '#f3d58a', other: '#f4efe0' }, 'the selection ring: gold for the viewer\'s own, ivory otherwise');
  setLang('ja');
  assert.equal(ACT.NOTE_TEXT.unreachable(), 'ここへは届きません');
  assert.equal(ACT.arrivalText(44), '到着：ターン 44');
  setLang('en');
  assert.equal(ACT.arrivalText(44), 'Arrives: turn 44');
  assert.equal(ACT.NOTE_TEXT.tooFar(32), 'Too far (at most 32 steps)');
  setLang('ja');
});

test('attack is never the hue of the viewer\'s own land: a red, rose or amber nation attacks in violet, the others in ember', () => {
  const hue = ([r, g, b]) => { const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn; const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; return (h * 60 + 360) % 360; };
  const rgb = c => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16));
  const gap = (a, b) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));
  for (let f = 0; f < 6; f++) {
    const P = ACT.actionPalette(f), own = hue(rgb(FACTION_COLORS[f]));
    assert.ok(gap(hue(P.attack.fill), own) >= ACT.ATTACK_HUE_GAP, `nation ${f}: attack is ${Math.round(gap(hue(P.attack.fill), own))} degrees from its own colour`);
    if (P.attack === ACT.ATTACK_ALT) assert.ok(gap(hue(P.attack.fill), hue(P.home.fill)) > 60, 'the other colour is far from gold too (gold is the viewer\'s own)');
    assert.equal(P.move, ACT.ACTION_COLOURS.move); assert.equal(P.home, ACT.ACTION_COLOURS.home);
  }
  assert.equal(ACT.actionPalette(0).attack, ACT.ATTACK_ALT, 'Aster (red)');
  assert.equal(ACT.actionPalette(1).attack, ACT.ACTION_COLOURS.attack, 'Borealis (teal) keeps ember');
  assert.equal(ACT.actionPalette(null), ACT.ACTION_COLOURS, 'no nation (the spectator): the brief\'s colours');
});

test('the reach set as one box and one outline: the host\'s own tile is part of it; a lit tile knows whether it is chart', () => {
  const A = ACT.createActions({ passableOf: () => (1n << 61n) - 1n })({ ...page([entryOf(1)]), selected: { p: 2, q: 0, idx: 7 } });
  assert.ok(A.tiles.length > 20);
  assert.ok(A.tiles.every(t => Number.isInteger(t.lv)), 'every lit tile carries the survey\'s level');
  const box = ACT.reachBox(A), c = project(home.q, home.r);
  assert.ok(box.x0 < c.x && box.x1 > c.x && box.y0 < c.y && box.y1 > c.y, 'around the host');
  for (const t of A.tiles) { const at = project(t.hq, t.hr); assert.ok(at.x - RADIUS >= box.x0 - 1e-6 && at.x + RADIUS <= box.x1 + 1e-6 && at.y >= box.y0 && at.y <= box.y1); }
  assert.equal(ACT.reachBox(null), null);
  // the outline of the set with the host's tile is one closed loop when nothing inside it is impassable
  const shape = LAND.landShape([...A.tiles.map(t => ({ q: t.hq, r: t.hr, d: t.d })), { q: home.q, r: home.r, d: 0 }]);
  assert.equal(shape.loops.length, 1, 'one contour, no frame per tile');
});

/** A context that records what is called on it (the painters only need these). */
function recorder() {
  const calls = [];
  const g = new Proxy({}, { get: (_, k) => (k === 'calls' ? calls : k === 'measureText' ? t => ({ width: String(t).length * 7 }) : k === 'canvas' ? null : typeof k === 'string' ? (...a) => { calls.push([k, ...a]); } : undefined), set: (_, k, v) => { calls.push(['=', k, v]); return true; } });
  return g;
}

test('the painters draw into any context and write their words through the language', () => {
  setLang('ja');
  const g = recorder();
  ACT.paintTag(g, 0, 0, ACT.arrivalText(44), { zoom: 1.3 });
  assert.ok(g.calls.some(c => c[0] === 'fillText' && c[1] === '到着：ターン 44'));
  const A = ACT.createActions({ passableOf: () => (1n << 61n) - 1n })({ ...page([entryOf(1)]), selected: { p: 2, q: 0, idx: 7 } });
  // (no Path2D here: the lit tiles are simply not drawn, and nothing throws)
  assert.equal(ACT.paintActionGround(g, A, { zoom: 1.3, now: 0 }), typeof Path2D === 'undefined' ? false : true);
  ACT.paintActionTop(g, A, { zoom: 1.3 });
  ACT.paintHoverGround(g, home, { zoom: 1.3, kind: 'attack' });
  ACT.paintSelectionGround(g, home, { zoom: 1.3, own: true });
  ACT.paintRibbon(g, [home, { q: home.q + 1, r: home.r }, { q: home.q + 2, r: home.r }], { zoom: 1.3, kind: 'attack' });
  ACT.paintRefusal(g, home, { zoom: 1.3, age: 100 });
  LAND.paintStandard(g, 0, 0, { u: RADIUS, zoom: 1.3, faction: 2, lift: 0.4, dust: 0.3 });
  LAND.paintBeacon(g, 0, 0, { zoom: 0.1 });
  LAND.paintProvisionalTag(g, { provisional: true, shape: LAND.landShape(LAND.landTiles({ ...home, tier: 0 })) }, { zoom: 1.3 });
  assert.ok(g.calls.some(c => c[0] === 'fillText' && c[1] === '仮'));
  for (const f of [ACT.paintActionGround, ACT.paintActionTop, ACT.paintHoverGround, ACT.paintSelectionGround, ACT.paintRibbon, ACT.paintTag, LAND.paintOwnLand, LAND.paintStandard]) assert.doesNotThrow(() => f(null, null));
});

// ------------------------------------------------------------------ where am I
// Rewritten with UX brief §11.8 (it pinned a round 44-px button standing 40 px inside the edge with a bare number): the
// pointer is a gold tab flush with the edge of the free part of the picture, where the line to the village leaves it;
// it says the village's name when it appears and then the distance with its unit.
test('the pointer home: none while the village is in the picture; else a tab flush with the edge where the line to it leaves, with the distance in tiles', () => {
  const size = { width: 800, height: 600 }, at = project(home.q, home.r);
  assert.equal(PTR.edgePointer({ x: at.x, y: at.y, zoom: 1.3 }, size, at), null, 'home in the middle');
  assert.equal(PTR.edgePointer({ x: at.x + 250, y: at.y, zoom: 1.3 }, size, at), null, 'home still on screen');
  // home far to the right (east): the right edge, pointing right
  const east = PTR.edgePointer({ x: at.x - 2000, y: at.y, zoom: 1 }, size, at);
  assert.deepEqual([east.edge, Math.round(east.x), Math.round(east.y), Math.round(east.angle * 100)], ['right', 800, 300, 0], 'flush with the edge');
  const mid = { q: Math.round((at.x - 2000) / (Math.sqrt(3) * RADIUS) - home.r / 2), r: home.r };
  assert.ok(Math.abs(east.tiles - dist(mid, home)) <= 1, `about ${dist(mid, home)} tiles away`);
  assert.ok(east.tiles > 20);
  assert.deepEqual(PTR.tabBox(east, { w: 96, h: 44 }), { x: 800 - 96, y: 300 - 22, w: 96, h: 44 });
  // up and to the left by the same amount of screen: the wider side decides (the top edge of an 800 x 600 picture), and the tab keeps off the corner
  const nw = PTR.edgePointer({ x: at.x + 3000, y: at.y + 3000, zoom: 1 }, size, at);
  assert.equal(nw.edge, 'top');
  assert.ok(nw.y === 0 && nw.x >= PTR.POINTER_MARGIN - 1e-6 && nw.x < 400);
  assert.ok(nw.angle < -Math.PI / 2);
  assert.deepEqual(PTR.tabBox(nw, { w: 96, h: 44 }).y, 0);
  assert.ok(PTR.tabBox({ ...nw, x: 10 }, { w: 96, h: 44 }).x === 0, 'never out of the picture along its edge');
  // a sheet over the lower part of a phone and a strip above: the edges are those of the part nothing covers
  const phone = { width: 390, height: 734 };
  const below = PTR.edgePointer({ x: at.x, y: at.y - 3000, zoom: 1 }, phone, at, { inset: { top: 48, bottom: 367 } });
  assert.deepEqual([below.edge, below.y], ['bottom', 734 - 367], 'on the sheet\'s upper edge');
  assert.equal(PTR.tabBox(below, { w: 96, h: 44 }).y, 734 - 367 - 44);
  const above = PTR.edgePointer({ x: at.x, y: at.y + 3000, zoom: 1 }, phone, at, { inset: { top: 48, bottom: 367 } });
  assert.deepEqual([above.edge, above.y], ['top', 48], 'under the strip');
  assert.equal(PTR.POINTER_SIZE, 44, 'a 44-px target');
  assert.ok(PTR.POINTER_MIN >= 56, 'about 56 px at least');
  setLang('ja');
  assert.equal(PTR.pointerLabel(12), '自分の村へ移動（12 マス先）');
  assert.equal(PTR.distanceText(5), '5 マス', 'the distance with its unit');
  setLang('en');
  assert.equal(PTR.pointerLabel(12), 'Go to my village (12 tiles away)');
  assert.equal(PTR.distanceText(5), '5 tiles');
  setLang('ja');
  assert.equal(PTR.mountHomePointer({ clientWidth: 1, clientHeight: 1 }), null, 'no document: no button, nothing thrown');
  assert.equal(PTR.edgePointer({ x: 0, y: 0, zoom: 1 }, size, null), null);
});

// Rewritten with UX brief §11.8 (the round pointer moved inward along its line; a tab stays on its edge).
test('the pointer keeps out of the HUD\'s columns: it slides along its edge, the shortest way, and never leaves the edge', () => {
  const place = { edge: 'right', x: 800, y: 80, angle: 0, tiles: 9, box: { x0: 0, y0: 48, x1: 800, y1: 600 } };
  const box = PTR.tabBox(place, { w: 90, h: 44 });
  assert.equal(PTR.slideClear(place, box, []), box);
  assert.equal(PTR.slideClear(place, box, [{ x: 0, y: 0, w: 100, h: 100 }]), box, 'nothing in its way');
  // a column of buttons down the right side from y 40 to 300: the tab goes below it
  const moved = PTR.slideClear(place, box, [{ x: 744, y: 40, w: 48, h: 260 }]);
  assert.equal(moved.x, box.x, 'still flush with its edge');
  assert.ok(moved.y >= 300 + PTR.POINTER_GAP && moved.y < 300 + PTR.POINTER_GAP + 8, `just below the column (${moved.y})`);
  // a thing in the middle of the top edge (the dial): the tab steps aside
  const top = { edge: 'top', x: 400, y: 48, angle: -1.5, tiles: 4, box: place.box };
  const tb = PTR.tabBox(top, { w: 90, h: 44 }), side = PTR.slideClear(top, tb, [{ x: 350, y: 0, w: 100, h: 100 }]);
  assert.equal(side.y, 48);
  assert.ok(side.x + 90 <= 350 - PTR.POINTER_GAP + 6 || side.x >= 450 + PTR.POINTER_GAP);
  // nowhere on the edge is free: it stays where it was
  assert.equal(PTR.slideClear(place, box, [{ x: 700, y: 0, w: 100, h: 600 }]), box);
});

test('the far view\'s names never cover each other; a fixed name stays where it is', () => {
  // six nations whose hearts lie close around the Concord (the spectator's world of three rings)
  const items = [{ text: 'Concord', x: 0, y: 0, w: 70, h: 20, priority: 8, fixed: true }];
  for (let f = 0; f < 6; f++) { const a = f * Math.PI / 3; items.push({ text: `N${f}`, x: Math.cos(a) * 300, y: Math.sin(a) * 120, w: 110, h: 29, priority: 1, dir: { x: Math.cos(a), y: Math.sin(a) } }); }
  const zoom = 0.1;
  const out = layoutLabels(items, { zoom });
  const box = it => ({ x0: it.x * zoom - it.w / 2, x1: it.x * zoom + it.w / 2, y0: it.y * zoom - it.h / 2, y1: it.y * zoom + it.h / 2 });
  for (let i = 0; i < out.length; i++) for (let j = i + 1; j < out.length; j++) { const a = box(out[i]), b = box(out[j]); assert.ok(!(a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1), `${out[i].text} and ${out[j].text} apart`); }
  assert.deepEqual([out[0].x, out[0].y, out[0].moved], [0, 0, 0]);
  assert.deepEqual(out.map(o => o.text), items.map(o => o.text), 'in the order given');
  // names that are apart already do not move
  const far = layoutLabels([{ text: 'a', x: 0, y: 0, w: 40, h: 20 }, { text: 'b', x: 1000, y: 0, w: 40, h: 20 }], { zoom: 1 });
  assert.deepEqual(far.map(o => o.moved), [0, 0]);
  // the viewer's village under its beacon: the nation's name moves off the pip and off the village's name
  const y = layoutLabels([{ text: '', x: 0, y: 0, w: 30, h: 30, priority: 10, fixed: true }, { text: 'village', x: 0, y: 200, w: 90, h: 17, priority: 9, fixed: true }, { text: 'Nation', x: 0, y: 0, w: 100, h: 29, priority: 1, dir: { x: 1, y: 0 } }], { zoom: 0.1 });
  assert.ok(y[2].moved > 0 && y[2].y < 0 && y[2].x === 0, 'above the beacon');
});

test('the world chart names through the layout and writes the names it is given', () => {
  const g = recorder();
  const recs = new Map([['2,0', { p: 2, q: 0, owners: [0, 0, 0, 7, 7, 7, 7, 7, 7, 7, 7, 7], sites: [1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0] }]]);
  paintRealmLabels(g, recs, 0.1, f => (f === 'concord' ? 'C' : `N${f}`), { extra: [{ block: 30, x: 0, y: 0 }, { text: 'My Town', x: 900, y: 0, below: 11 }] });
  const said = g.calls.filter(c => c[0] === 'fillText').map(c => c[1]);
  assert.deepEqual(said.sort(), ['C', 'My Town', 'N0']);
  const quiet = recorder();
  paintRealmLabels(quiet, recs, 0.1, null, { nations: false, extra: [{ text: 'My Town', x: 900, y: 0 }] });
  assert.deepEqual(quiet.calls.filter(c => c[0] === 'fillText').map(c => c[1]), ['My Town'], 'the land lens: the viewer\'s village still has its name');
});

// Rewritten with UX brief §11.2 and §11.3. The world used to end in two rings of stamped cloud that a gradient
// dissolved into the table's colour (worldRim). It now ends as a sheet: the cloud sea is a bank between the land's
// edge and the sheet's bare margin, and the sheet has an edge of its own.
test('the edge of the world: a cloud bank between the land and the sheet\'s bare margin; the sheet ends as a sheet', () => {
  assert.equal(CLOUD_RINGS, 1, 'one ring of unopened provinces is in the model, so the land knows where it ends');
  const sheet = sheetOf(3), land = landBox(3);
  assert.equal(sheetOf(3), sheet, 'the same sheet every time');
  const room = (SHEET.sea + SHEET.fade + SHEET.margin) * HEX_W;
  assert.ok(sheet.x >= land.x + room - 1e-6 && sheet.y > land.y + room * 0.7, 'room beyond the land for the bank, its thinning and a bare margin');
  assert.ok(sheet.x > sheet.y, 'wider than tall, as the squashed ground is');
  assert.ok(sheetOf(6).x > sheet.x + 1000, 'a larger world lies on a larger sheet');
  // the outline: a rectangle whose edge is deckled (never ruler-straight, never far from the rectangle)
  let off = 0;
  for (const [x, y] of sheet.points) {
    const d = Math.max(Math.abs(x) - sheet.x, Math.abs(y) - sheet.y);
    assert.ok(d < 20 && d > -60, `an outline point ${d.toFixed(1)} px from the rectangle`);
    off = Math.max(off, Math.abs(d));
  }
  assert.ok(off > 6 && sheet.points.length > 300, 'deckled');
  assert.ok(Math.abs(sheet.rose.x) < sheet.x && Math.abs(sheet.rose.y) < sheet.y, 'the compass rose stands on the sheet');
  // the table shows only where the picture reaches past the sheet
  const inside = [{ x: -500, y: -300 }, { x: 500, y: -300 }, { x: 500, y: 300 }, { x: -500, y: 300 }];
  assert.equal(tableShows(inside, sheet), false);
  assert.equal(tableShows([...inside.slice(0, 3), { x: -sheet.x - 100, y: 300 }], sheet), true);
  // the sea's field: steps from the land, and how much cloud lies at a point
  const sea = seaField(3);
  assert.equal(sea.steps(0, 0), 0, 'the Concord is land');
  const rim = (() => { let q = 0; while (sea.steps(q + 1, 0) === 0) q++; return q; })();
  assert.deepEqual([sea.steps(rim, 0), sea.steps(rim + 1, 0), sea.steps(rim + 2, 0), sea.steps(rim + 3, 0)], [0, 1, 2, 3], 'one step a tile, outward from the last tile of land');
  const at = n => project(rim + n, 0);
  assert.equal(sea.cover(0, 0, sheet), 0, 'no cloud over the land');
  assert.equal(sea.cover(at(-2).x, at(-2).y, sheet), 0, 'two tiles inside its edge: none');
  assert.ok(sea.cover(at(0).x, at(0).y, sheet) < 0.5, 'on the last tile of land at most a thin mist');
  assert.ok(sea.depth(at(0).x + HEX_W / 2, at(0).y) > 0.35 && sea.depth(at(0).x + HEX_W / 2, at(0).y) < 0.65, 'about half a step on the land\'s own edge');
  let thick = 0;
  for (let i = 0; i < 40; i++) { const a = (i / 40) * Math.PI * 2, R = land.x + HEX_W * 2.6; if (sea.cover(Math.cos(a) * R, Math.sin(a) * R * 0.76, sheet) > 0.85) thick++; }
  assert.ok(thick >= 14, `${thick} of 40 points two to three tiles out are deep in the bank (the land is a hexagon: some of that circle is nearer, some further)`);
  // it never reaches the sheet's edge: the margin is bare paper
  for (let i = 0; i < 60; i++) {
    const t = (i / 59) * 2 - 1;
    assert.equal(sea.cover(sheet.x - HEX_W * 0.4, t * sheet.y, sheet), 0);
    assert.equal(sea.cover(t * sheet.x, sheet.y - HEX_W * 0.4 * 0.76, sheet), 0);
  }
  // the puffs: seeded by the tile (the same every time), turned, flipped, sized and moved; never on the lattice
  const a1 = puffsOf(40, -3, 2), a2 = puffsOf(40, -3, 2);
  assert.deepEqual(a1, a2);
  const many = [];
  for (let q = 0; q < 30; q++) for (let r = 0; r < 30; r++) many.push(...puffsOf(q, r, 2));
  assert.ok(many.length > 600 && many.length < 1700, `${many.length} puffs on 900 tiles: not one a tile`);
  assert.ok(many.every(p => Math.abs(p.turn) <= PUFF.turn + 1e-9 && [1, 2, 3].includes(p.variant) && p.size > 0.4 && p.size < 2));
  assert.ok(many.some(p => p.flip) && many.some(p => !p.flip) && new Set(many.map(p => p.variant)).size === 3);
  assert.ok(many.filter(p => Math.hypot(p.dx, p.dy) > 0.1).length > many.length * 0.8, 'moved off their tiles\' middles');
  assert.ok(Math.max(...many.map(p => p.size)) / Math.min(...many.map(p => p.size)) > 2.2, 'small and large');
  // without a canvas the painters return quietly
  assert.equal(woodTexture(), null);
  assert.equal(driftTexture(), null);
  paintTable(null, { view: { x: 0, y: 0, zoom: 1 }, size: { width: 10, height: 10 } });
  paintSheet(null, sheet);
  assert.deepEqual(new CloudSea().paint(null, { box: { x0: 0, y0: 0, x1: 10, y1: 10 } }), { pending: 0, seen: false });
});

test('the landing book: a provisional village lands once on a device; one that is already final is old news', () => {
  const store = new Map();
  const storage = { get: k => store.get(k) ?? null, set: (k, v) => { store.set(k, v); return true; } };
  const key = BOOK.landedKey({ cluster: 'localnet', programId: 'P', seasonId: '7' }, 'W');
  assert.equal(key, 'ps-flanded:localnet:P:7:W');
  const book = BOOK.createLandingBook({ storage });
  assert.equal(book.next(key, []), null);
  assert.equal(book.next(null, [holding({ state: 1 })]), null, 'no season, no wallet: nothing plays');
  const first = book.next(key, [holding({ state: 1 })]);
  assert.deepEqual(first, { id: '2,0,0,0', key: '2,0,7', at: { p: 2, q: 0, tile: 7 } });
  assert.equal(book.next(key, [holding({ state: 1 })]), first, 'the same landing until another village lands (the map starts it once, by its id)');
  assert.deepEqual(BOOK.unpackLanded(store.get(key)), ['2,0,0,0']);
  // a reload: the village is known, nothing plays again
  assert.equal(BOOK.createLandingBook({ storage }).next(key, [holding({ state: 1 })]), null);
  // a village already final the first time this device sees it: noted, not played
  const other = BOOK.createLandingBook({ storage: { get: () => null, set: () => true } });
  assert.equal(other.next(key, [holding({ state: 2 })]), null);
  // a second village, placed later
  const second = book.next(key, [holding({ state: 2 }), holding({ p: 1, q: 1, site: 4, tile: 30, state: 1 })]);
  assert.deepEqual([second.id, second.key], ['1,1,4,0', '1,1,30']);
  // a village that came back under a new generation lands again
  assert.equal(BOOK.villageId(holding({ gen: 2 })), '2,0,0,2');
  assert.deepEqual(BOOK.unpackLanded('{bad'), []);
  assert.deepEqual(BOOK.unpackLanded(JSON.stringify(['a', 7, null])), ['a']);
});

test('the map plays a landing on demand and leaves a bare canvas alone', () => {
  const map = new FrontierMap({ clientWidth: 800, clientHeight: 600 }, { source: () => ({ ringsOpen: 3, overviews: new Map(), own: [{ ...HOME }], open: { ready: true, active: 0 } }) });
  assert.equal(map.playLanding(), true);
  assert.deepEqual(map.landing?.key, '2,0,7');
  assert.equal(map.lod, 'tile', 'the camera goes to the village');
  assert.equal(new FrontierMap({ clientWidth: 800, clientHeight: 600 }, { source: () => ({ ringsOpen: 3, overviews: new Map(), own: [] }) }).playLanding(), false, 'no village: nothing to land on');
  map.setHover({ tileQ: 1, tileR: 2, p: 0, q: 0, idx: 3 });
  assert.deepEqual(map.hover, { q: 1, r: 2, p: 0, pq: 0, idx: 3 });
  map.setHover(null);
  assert.equal(map.hover, null);
  assert.equal(map.pointer, null, 'no document: no pointer button');
  map.destroy();
});

// ------------------------------------------------------------------ names before coordinates
test('a place is called by its name; its coordinates are the small print', () => {
  setLang('ja');
  const FS = { mode: 'play', citizen: { faction: 0 }, holdings: [holding()], nowBell: 42, land: { stage: 'final' }, roster: { ownerOf: () => ({ tag: 9n }), tierOf: () => 1 },
    overviews: new Map([[2, { provinces: [REC] }]]), provinces: new Map([['2,0', { province: PROV }]]), selected: { p: 2, q: 0, idx: 7 } };
  const terrainOf = () => TERRAIN;
  const m = inspect.inspectModel(FS, terrainOf);
  assert.match(placeName(m), /の町 — アステル$/, 'the village\'s name and its nation');
  // (integration of the HUD track: a tile's number is never shown on the play screen; the small print is the province)
  assert.equal(placeWhere(m), '州 2,0');
  const title = String(inspect.render(FS, terrainOf));
  assert.ok(title.indexOf('の町') >= 0 && title.indexOf('の町') < title.indexOf('州 2,0'), 'the name comes first in the inspector');
  assert.doesNotMatch(title, /マス ?\d/, 'no tile number in the inspector');
  assert.match(String(inspect.renderBrief(FS, terrainOf)), /の町 — アステル/);
  FS.selected = { p: 2, q: 0, idx: 21 };
  assert.equal(placeName(inspect.inspectModel(FS, terrainOf)), '蛮族の野営地');
  assert.equal(inspect.inspectModel(FS, terrainOf).tile.camp.troops, 250, 'a camp\'s troops are whole troops (not a host\'s thousandths)');
  FS.selected = { p: 2, q: 0, idx: 30 };
  assert.equal(placeName(inspect.inspectModel(FS, terrainOf)), '草原');
  FS.selected = { p: 0, q: 0 };
  assert.equal(placeName(inspect.inspectModel(FS, terrainOf)), '大協約');
  FS.selected = { p: 2, q: 0 };
  assert.equal(placeName(inspect.inspectModel(FS, terrainOf)), '第2輪の州');
  setLang('en');
  FS.selected = { p: 2, q: 0, idx: 7 };
  assert.match(placeName(inspect.inspectModel(FS, terrainOf)), /Town — Aster$/);
  setLang('ja');
  assert.equal(placeName(null), '');
});

// ------------------------------------------------------------------ what the capture found
test('nothing is "fighting" for history: a clash is told only while it is this bell\'s; a camp\'s troops are whole troops', () => {
  setLang('ja');
  const e = (resolve, clash = null) => ({ p: 2, q: 0, rec: { clash: true, sites: [1], owners: [0] }, clash,
    prov: { sites: Uint8Array.from([7]), camp: { state: 1, tile: 21, troops: 250 }, siteMirror: [], resolveSummary: { bell: resolve },
      entries: [{ id: 1n, faction: 0, tile: 7, state: 1, troops: 600_000, staminaValue: 120, staminaBell: 0, readyBell: 0 }] } });
  const kinds = x => (ACTIVITY.tileActivities(x, { bell: 42 }).get(7) ?? []).map(a => a.kind);
  assert.deepEqual(kinds(e(42)), ['battle', 'guard'], 'the clash of this bell');
  assert.deepEqual(kinds(e(41)), ['battle', 'guard'], 'or of the bell just closed');
  assert.deepEqual(kinds(e(39)), ['guard'], 'a clash three bells ago is history: nothing is said on the tile');
  assert.deepEqual(kinds(e(0)), ['battle', 'guard'], 'a province with no summary yet: the overview\'s flag is all there is');
  // the tiles of a loaded report are used only when it is the report of that clash
  const old = { bell: 30, arrivals: [{ present: 1, tile: 9, hostId: 5n, stance: 0 }] };
  assert.deepEqual(kinds(e(42, old)), ['battle', 'guard'], 'an older report does not say where this bell\'s clash was');
  assert.deepEqual(kinds(e(42, { bell: 42, arrivals: [{ present: 1, tile: 9, hostId: 5n, stance: 0 }] })), ['guard'], 'this bell\'s report: the clash was on another tile');
  assert.equal(ACTIVITY.activityText({ kind: 'battle' }), 'この鐘で衝突がありました', 'said as what happened (a clash resolves at the toll), never as fighting');
  const camp = ACTIVITY.tileActivities(e(42), { bell: 42 }).get(21)[0];
  assert.deepEqual([camp.kind, camp.n], ['camp', 250]);
  assert.equal(ACTIVITY.activityText(camp), '蛮族の野営地（250 兵）');
  setLang('en');
  assert.equal(ACTIVITY.activityText({ kind: 'battle' }), 'A clash this bell');
  setLang('ja');
  // the inspector: an overview older than the last bell says nothing about now
  const FS = { mode: 'play', citizen: { faction: 0 }, holdings: [], nowBell: 42, overviews: new Map([[2, { bell: 40, provinces: [{ ...REC, clash: true }] }]]), provinces: new Map([['2,0', { province: PROV }]]), selected: { p: 2, q: 0, idx: 7 } };
  assert.equal(inspect.inspectModel(FS, () => TERRAIN).clash, false);
  FS.overviews = new Map([[2, { bell: 41, provinces: [{ ...REC, clash: true }] }]]);
  assert.equal(inspect.inspectModel(FS, () => TERRAIN).clash, true);
});
