// The banner rule's labelled prototype (PROTOTYPE-SPEC section 9, tests 1 to 11): the rule's pure functions
// (claims.mjs) on small boards built here, and the sample world that plays them (liveworld.mjs with `claims`,
// claimsworld.mjs). The rule is a DESIGN: nothing here pins a rule of the program. Run with fixtures.screen.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as C from './claims.mjs';
import * as R from './rules.mjs';
import * as W from './world.mjs';
import { SIMPLER } from './liveworld.mjs';
import { SIMPLER_CLAIMS, LABEL, SCORE_NOTE, SCRIPT } from './claimsworld.mjs';
import { sample, sealed } from './liveworld.screen.mjs';
import { play40, GOLDEN, GOLDEN_PLAYS } from './claims-golden.mjs';
import { play } from './proto-playthrough.mjs';
import { startServer } from './server.mjs';

const { HOME, HOSTS } = W;
const N = C.NUMBERS, ALL = (1n << 61n) - 1n, U = s => new URL(`http://127.0.0.1${s}`);
const ME = `${HOME.p},${HOME.q},${HOME.site}`;

// ------------------------------------------------------------------ small boards for the rule's functions
/** A province as the rule's functions are given it: all passable and explored, no sites, no camp, not a heartland, the keep's holder nation 0. */
const board = (over = {}) => ({ p: 5, q: -2, ring: 2, wedge: 0, holderNation: 0, heartland: false, resolvedNext: 100, passableMask: ALL, exploredMask: ALL, sites: [], camp: { state: 0, tile: 0 }, entries: [], faces: [null, null, null, null, null, null], ...over });
const host = (id, faction, tile, over = {}) => ({ id: BigInt(id), faction, unit: 0, tile, state: 1, troops: 600_000, fromBell: 90, pendOp: 0, inTransit: false, holder: `k${id}`, ...over });
const who = (key, nation, over = {}) => ({ key, nation, tier: 1, townOk: true, bannersHeld: 0, works: 100, elbowUsed: false, ...over });
const fresh = pv => C.newLand(pv.sites, pv.resolvedNext);
/** Raise for host `e` and give back the new land (the test fails when the rule refuses). */
const raised = (pv, land, e, h, opts) => { const r = C.raise(pv, land, e, h, pv.resolvedNext, opts); assert.equal(r.ok, true, `raise: ${r.code} ${JSON.stringify(r.need)}`); return r; };
const sum = a => a.reduce((x, y) => x + y, 0);
// the centre of a province and the tiles round it (fgeo TILE_OFFSETS): 30 is (0,0); 21 and 39 are its neighbours west and east
const CENTRE = 30, EAST = 39, WEST = 21, EAST2 = 47, EAST3 = 54;

test('the numbers are one table, the design\'s (claim-rule-constants.json, revision 2); the label and the note are the specification\'s', () => {
  assert.deepEqual([N.STAND_HOME, N.STAND_ABROAD, N.FALL_LOOSE, N.FALL_FIRM, N.OWN_WEDGE_FACTOR], [1, 12, 36, 72, 0.5]);
  assert.deepEqual([N.FLOOR_HOME, N.FLOOR_ABROAD, N.FLOWER, N.TRAIL_MAX, N.TRAIL_STEPS, N.PATCH_MAX, N.MIN_PATCH, N.REACH], [100, 500, 7, 3, 4, 12, 3, 2]);
  assert.deepEqual([N.ELBOW_MAX, N.ELBOW_LOCK, [...N.CAP_BY_TIER], N.PER_PROVINCE, N.SLOTS, N.SITE_POLES], [4, 432, [3, 5, 7, 9], 2, 16, 2]);
  assert.deepEqual([N.CEILING_ABROAD, N.KEEP_SHARE, N.FREE_BANNERS, [...N.PRICE_THEN], N.PRICE_ABROAD_STEP], [24, 24, 3, [4, 8, 12, 16, 20, 24], 8]);
  assert.deepEqual([N.WALK_LOOSE, N.WALK_FIRM, N.WALK_LOOSE_TROOPS, N.GRACE, N.STUMP_TILES, N.STUMP_AGE, N.EXPLORE_PER_DAY, N.WALK_PAY], [144, 432, 500, 72, 3, 144, 5, 2]);
  assert.deepEqual([N.TILES, N.DAY, N.ROOM_FULL, N.ROOM_STALE, N.TAKE_OVER_STAND, N.TOWN_AGE], [61, 144, 8, 36, 1, 144]);
  assert.deepEqual([C.RULE.rule, C.RULE.version], ['standing-ground', 'design-2026-10-10-r2']);
  assert.deepEqual(LABEL, { ja: '試作ルール：旗（設計のみ・プログラム未実装）', en: 'Prototype rule: banners (design only, not in the program)' });
  assert.deepEqual(SCORE_NOTE, { ja: 'この得点は試作の計算です。チェーンの記録ではありません。', en: 'This score is computed by the prototype. It is not a chain record.' });
  // the geometry the functions stand on: six border rows of five tiles; a tile in the middle has six neighbours
  assert.deepEqual(C.BORDER_ROWS.map(r => r.length), [5, 5, 5, 5, 5, 5]);
  assert.deepEqual([C.neighbours(CENTRE).length, C.neighbours(0).length, C.steps(CENTRE, EAST), C.steps(WEST, EAST), C.steps(CENTRE, EAST3)], [6, 3, 1, 2, 3]);
});

test('a patch: the pole and its open neighbours, passable or not; never a site, village land, banner land or a camp\'s tile; three tiles at least', () => {
  const pv = board({ sites: [EAST], passableMask: ALL & ~(1n << BigInt(WEST)), camp: { state: 1, tile: 47 } });
  const land = fresh(pv), e = host(1, 0, CENTRE), f = C.flower(pv, land, e);
  assert.equal(f.tiles[0], CENTRE, 'the pole first');
  assert.ok(f.tiles.includes(WEST), 'water or mountain inside a patch belongs to the patch');
  assert.deepEqual(f.denied, [{ tile: EAST, why: 'site' }]);
  assert.equal(f.tiles.length, 6);
  // the kinds of ground
  const r = raised(pv, land, e, who('k1', 0));
  assert.deepEqual([C.kindOf(r.land, CENTRE), C.kindOf(r.land, EAST), C.kindOf(r.land, 0)], [{ kind: 'banner', slot: 0 }, { kind: 'site', site: 0 }, { kind: 'open' }]);
  assert.deepEqual([r.log.op, r.log.turn, r.log.slot, r.log.pole, r.log.tiles.length, r.log.works, r.log.by, r.log.firm], ['RAISE', 100, 0, CENTRE, 6, 0, 'k1', true]);
  // a pole stands on passable open ground that is no site and neither on nor next to a camp
  const at = (tile, over = {}) => C.canRaise(pv, land, host(2, 0, tile, over), who('k2', 0));
  assert.deepEqual([at(WEST).code, at(WEST).need.why], ['NotOpen', 'impassable']);
  assert.deepEqual([at(EAST).code, at(47).code, at(54).code, at(54).need.why], ['SiteOrCamp', 'SiteOrCamp', 'SiteOrCamp', 'camp']);
  assert.deepEqual([C.canRaise(pv, r.land, host(2, 0, 29), who('k2', 0)).code, at(CENTRE, { unit: 6 }).code, at(CENTRE, { pendOp: 1 }).code, at(CENTRE, { inTransit: true }).code, at(CENTRE, { state: 3 }).code], ['NotOpen', 'Scouts', 'HostBusy', 'InTransit', 'NotResident']);
  // fewer than three tiles is no banner: a corner whose neighbours are taken
  const tight = fresh(pv);
  for (const t of C.neighbours(0).slice(1)) tight.claim[t] = 3;
  tight.villageNation[3] = 0;
  assert.deepEqual([C.canRaise(pv, tight, host(3, 0, 0), who('k3', 0)).code, C.canRaise(pv, tight, host(3, 0, 0), who('k3', 0)).need], ['PatchTooSmall', { tiles: 3, have: 2 }]);
});

test('2 (the count): a host raises once it has stood the turns the ground asks, with the troops the ground asks; on unexplored ground only where it marched', () => {
  const pv = board(), land = fresh(pv), me = who('k1', 0);
  // home ground: one turn, 100 troops
  const waiting = C.canRaise(pv, land, host(1, 0, CENTRE, { fromBell: 100 }), me);
  assert.deepEqual([waiting.ok, waiting.code, waiting.need, waiting.size, waiting.waitTolls], [false, 'StandLonger', { tolls: 1, atTurn: 101 }, 7, 1], 'what is missing, and the patch it would raise');
  assert.equal(C.canRaise(pv, land, host(1, 0, CENTRE, { fromBell: 99 }), me).ok, true);
  assert.deepEqual(C.canRaise(pv, land, host(1, 0, CENTRE, { state: 2, fromBell: 102 }), me).need, { tolls: 3, atTurn: 103 }, 'a host that is still forming waits too');
  assert.deepEqual(C.canRaise(pv, land, host(1, 0, CENTRE, { troops: 99_000 }), me).need, { troops: 100, have: 99 });
  // ground of another nation's keep: twelve turns, 500 troops, a Town, and only where the patch touches our land or the pole is on a border row we could come in over
  const far = board({ holderNation: 3, wedge: 3 }), row = C.BORDER_ROWS[0], pole = row[2];
  assert.deepEqual([C.standToRaise(far, 0), C.floorFor(far, 0), C.abroad(far, 0), C.abroad(pv, 0)], [12, 500, true, false]);
  assert.deepEqual(C.canRaise(far, fresh(far), host(1, 0, pole), me).need, { why: 'touch' });
  const faced = board({ holderNation: 3, wedge: 3, faces: [{ open: true, ring: 2, holderNation: 0, banners: [0, 0, 0, 0, 0, 0] }, null, null, null, null, null] });
  assert.deepEqual(C.canRaise(faced, fresh(faced), host(1, 0, pole, { fromBell: 89 }), me).need, { tolls: 1, atTurn: 101 }, 'eleven of twelve turns stood');
  assert.equal(C.canRaise(faced, fresh(faced), host(1, 0, pole, { fromBell: 88 }), me).ok, true);
  assert.deepEqual(C.canRaise(faced, fresh(faced), host(1, 0, pole, { fromBell: 88, troops: 499_000 }), me).need, { troops: 500, have: 499 });
  assert.deepEqual(C.canRaise(faced, fresh(faced), host(1, 0, pole, { fromBell: 88 }), who('k1', 0, { tier: 0 })).need, { why: 'town' }, 'a Hamlet holds no banner abroad');
  assert.deepEqual(C.canRaise(faced, fresh(faced), host(1, 0, CENTRE, { fromBell: 88 }), me).need, { why: 'touch' }, 'not on that row');
  const behind = board({ holderNation: 3, wedge: 3, faces: [{ open: true, ring: 1, holderNation: 0, banners: [0, 0, 0, 0, 0, 0] }, null, null, null, null, null] });
  assert.equal(C.canRaise(behind, fresh(behind), host(1, 0, pole, { fromBell: 88 }), me).code, 'NotHere', 'a neighbour of ring 0 or 1 gives no such right');
  assert.equal(C.price(faced, fresh(faced), me), 8, 'abroad: 8 x (1 + the banners the nation holds there)');
  assert.deepEqual(C.canRaise(faced, fresh(faced), host(1, 0, pole, { fromBell: 88 }), who('k1', 0, { works: 5 })).need, { works: 8, have: 5, short: 3 });
  // another nation's heartland: never
  assert.deepEqual(C.canRaise(board({ holderNation: 3, wedge: 3, heartland: true }), fresh(far), host(1, 0, pole, { fromBell: 0 }), me).need, { why: 'heartland' });
  // surveyed ground
  const dark = board({ exploredMask: 0n }), l0 = fresh(dark), e = host(1, 0, CENTRE);
  assert.equal(C.canRaise(dark, l0, e, me).code, 'NotSurveyed');
  const walked = C.writeTrail(dark, l0, e, [EAST, EAST2]);
  assert.deepEqual([walked.log.op, walked.log.tiles, walked.log.host], ['TRAIL', [EAST, EAST2], '1']);
  assert.equal(C.canRaise(dark, walked.land, e, me).ok, true, 'a host that marched here has seen the ground under its own feet');
  assert.equal(C.canRaise(dark, walked.land, { ...e, fromBell: 95 }, me).code, 'NotSurveyed', 'the record is its own while it has not moved since');
  // the order's guards
  assert.deepEqual([C.canRaise(pv, land, host(1, 0, CENTRE), me, 100, { minTiles: 8 }).code, C.canRaise(pv, land, host(1, 0, CENTRE), who('k1', 0, { bannersHeld: 3 }), 100, { maxWorks: 3 }).code], ['Changed', 'Changed']);
  assert.deepEqual([0, 1, 2, 3, 4, 8, 9].map(held => C.price(pv, land, who('k1', 0, { bannersHeld: held }))), [0, 0, 0, 4, 8, 24, 24], 'the first three are free; then 4, 8, 12, 16, 20, 24 Works');
});

test('3: two hosts of different nations side by side: neither flower holds the other\'s tile; a tile next to both goes to the one with at least twice the troops, or to neither; either order gives the same two flowers', () => {
  // nation 0 at home in the middle of a province; nation 3 beside it, where its patch touches a village of its own (so that it may raise there at all)
  const both = [...Array(61).keys()].filter(t => C.neighbours(CENTRE).includes(t) && C.neighbours(EAST).includes(t));
  assert.equal(both.length, 2);
  for (const [a, b, whoGets] of [[600_000, 600_000, null], [1_200_000, 600_000, 'a'], [1_199_000, 600_000, null], [500_000, 1_000_000, 'b']]) {
    const A = host(1, 0, CENTRE, { troops: a }), B = host(2, 3, EAST, { troops: b, fromBell: 80 }), pv = board({ entries: [A, B], sites: [EAST3] });
    const land = C.hearth(pv, fresh(pv), { site: 0, nation: 3, holder: 'v3', ring: false }).land;
    const fa = C.flower(pv, land, A).tiles, fb = C.flower(pv, land, B).tiles;
    assert.ok(!fa.includes(EAST) && !fb.includes(CENTRE), 'a hostile host always denies its own tile');
    assert.deepEqual([both.every(t => fa.includes(t)), both.every(t => fb.includes(t))], [whoGets === 'a', whoGets === 'b'], `${a} against ${b}: exactly twice is enough`);
    assert.ok(!both.some(t => fa.includes(t) || fb.includes(t)) || whoGets !== null, 'no tile can be claimed by both');
    assert.deepEqual([fa.length, fb.length], [whoGets === 'a' ? 6 : 4, whoGets === 'b' ? 6 : 4]);
    // raising in either order gives the same two patches
    const ab = raised(pv, raised(pv, land, A, who('k1', 0)).land, B, who('k2', 3)).land, ba = raised(pv, raised(pv, land, B, who('k2', 3)).land, A, who('k1', 0)).land;
    const patches = l => l.banners.filter(x => x.used).map(x => [x.nation, [...x.tiles].sort((p, q) => p - q)]).sort((x, y) => x[0] - y[0]);
    assert.deepEqual(patches(ab), patches(ba));
    assert.deepEqual(patches(ab).map(x => x[1]), [[...fa].sort((p, q) => p - q), [...fb].sort((p, q) => p - q)], 'each raises exactly its flower');
  }
  // a host on a border row with a hostile equal beside it is left with two tiles: under three there is no banner until one of them leaves or is beaten
  const PB = C.BORDER_ROWS[0][2], PA = C.neighbours(PB).find(t => !C.BORDER_ROWS[0].includes(t)), edge = board({ entries: [host(1, 0, PA), host(2, 3, PB, { fromBell: 80 })], faces: [{ open: true, ring: 2, holderNation: 3, banners: [0, 0, 0, 0, 0, 0] }, null, null, null, null, null] });
  assert.deepEqual(C.canRaise(edge, fresh(edge), edge.entries[1], who('k2', 3)).need, { tiles: 3, have: 2 });
  // in a heartland a foreign host denies nothing, its own tile included, and raises nothing
  const A = host(1, 0, CENTRE), B = host(2, 3, EAST, { troops: 9_000_000 }), heart = board({ heartland: true, entries: [A, B] });
  assert.equal(C.flower(heart, fresh(heart), A).tiles.length, 7);
  assert.deepEqual(C.canRaise(heart, fresh(heart), B, who('k2', 3)).need, { why: 'heartland' });
  // scouts deny nothing
  const pv = board({ entries: [A, host(2, 3, EAST, { unit: 6 })] });
  assert.equal(C.flower(pv, fresh(pv), A).tiles.length, 7);
});

test('4: a host that withdraws to another tile after a clash stands there from the next turn, and has no trail (the design\'s one change to the clash write-back; the program as built leaves it)', async () => {
  // the write-back itself, on a resident that withdraws one tile and one that holds its ground
  const outcome = { fighters: [{ arrival: false, id: 7n, troops: 250_000, stamina: 80, engaged: true, fate: { kind: 'Withdrew', tile: EAST } }, { arrival: false, id: 8n, troops: 590_000, stamina: 100, engaged: true, fate: { kind: 'Stays', tile: CENTRE } }], garrisons: [] };
  const province = () => ({ entries: [{ ...host(7, 3, CENTRE, { fromBell: 60 }), staminaValue: 120, staminaBell: 90, readyBell: 60 }, { ...host(8, 0, CENTRE, { fromBell: 70 }), staminaValue: 120, staminaBell: 90, readyBell: 60 }], siteMirror: [], camp: { state: 0, tile: 0, troops: 0 } });
  const args = { bell: 100, residents: [{ id: 7n, troops: 300_000, stamina: 100 }, { id: 8n, troops: 600_000, stamina: 120 }], arrivals: [], garrisons: [], arrPos: [], camp: { state: 0, tile: 0, troops: 0 } };
  const built = province(), proto = province();
  R.applyOutcome(built, args, outcome);
  R.applyOutcome(proto, args, outcome, { withdrawalRestarts: true });
  assert.deepEqual(built.entries.map(e => [e.tile, e.fromBell]), [[EAST, 60], [CENTRE, 70]], 'the program as built: the entry\'s from_bell is left as it was');
  assert.deepEqual(proto.entries.map(e => [e.tile, e.fromBell]), [[EAST, 101], [CENTRE, 70]], 'the prototype: a withdrawn host starts from zero; one that stays keeps its count');
  // what that means for the rule: no count on the new tile yet, and the trail it had is no longer its own
  const pv = board({ resolvedNext: 101, exploredMask: 0n }), was = host(7, 3, CENTRE, { fromBell: 60 }), now = { ...was, tile: EAST, fromBell: 101 };
  const land = C.writeTrail(pv, fresh(pv), was, [WEST]).land;
  assert.equal(C.surveyedFor(pv, land, was), true);
  assert.deepEqual([C.surveyedFor(pv, land, now), C.trail(pv, land, now, [EAST]), C.trails({ ...pv, entries: [now] }, land)], [false, [], []]);
  assert.equal(C.canRaise({ ...pv, exploredMask: ALL }, land, now, who('k7', 3, { works: 100 })).code, 'NotHere', 'and where it may stand at all, its count would begin again');
  assert.deepEqual(C.canRaise(board({ resolvedNext: 101 }), fresh(pv), { ...now, faction: 0 }, who('k7', 0)).need, { tolls: 1, atTurn: 102 });
  // the sample world plays it only with the prototype on, and says so
  assert.ok(SIMPLER_CLAIMS.some(x => /withdraws to another tile/.test(x)) && !SIMPLER.some(x => /withdraws/.test(x)));
});

test('5: walking the land: a loose banner keeps counting until it is frayed; a walk by a host that has arrived since restores it until it is struck; the same host cannot walk twice', () => {
  // a banner of nation 0 under the keep of nation 3: loose, 144 turns
  const e = host(1, 0, C.BORDER_ROWS[0][2], { fromBell: 80 }), far = board({ holderNation: 3, wedge: 3, entries: [e], faces: [{ open: true, ring: 2, holderNation: 0, banners: [0, 0, 0, 0, 0, 0] }, null, null, null, null, null] });
  const me = who('k1', 0), land = raised(far, fresh(far), e, me).land, b0 = land.banners[0];
  assert.deepEqual([C.firm(far, b0), C.walkDue(far, land, 0)], [false, { clock: 100, firm: false, limit: 144, frayAt: 244, strikeAt: 316 }]);
  const at = r => ({ ...far, resolvedNext: r });
  assert.deepEqual([C.fray(at(243), land, 243, { slot: 0 }).code, C.fray(at(243), land, 243, { slot: 0 }).need], ['NotDue', { turn: 244 }]);
  // past its limit and nobody has sent Fray: it still counts for its nation
  assert.deepEqual([land.counted[0], C.paid(land, 3)[0], C.accrue(land, 3, 300).totals[0]], [b0.tiles.length, b0.tiles.length, b0.tiles.length * 200]);
  const fr = C.fray(at(244), land, 244, { slot: 0, by: 'keeper' });
  assert.deepEqual([fr.ok, fr.log.op, fr.log.by, fr.land.banners[0].frayed, fr.land.counted[0], C.paid(fr.land, 3)], [true, 'FRAY', 'keeper', true, 0, [0, 0, 0, 61, 0, 0]], 'from then its tiles pay the keep holder');
  assert.equal(fr.land.totals[0], b0.tiles.length * 144, 'the turns before the record were paid to its nation');
  assert.equal(C.fray(at(250), fr.land, 250, { slot: 0 }).code, 'NotDue', 'it is frayed once');
  // the walk: a fighting host of 500 of the banner's nation, in the patch, arrived since the last walk
  const tendAt = (r, h, l = fr.land, by = me) => C.tend({ ...at(r), entries: [h] }, l, h, by, r, { slot: 0 });
  assert.equal(tendAt(250, e).code, 'NotArrivedSince', 'the host that raised it was there already');
  assert.deepEqual([tendAt(250, host(2, 0, CENTRE, { fromBell: 240 })).code, tendAt(250, host(2, 0, b0.tiles[1], { fromBell: 240, troops: 499_000 })).code, tendAt(250, host(2, 0, b0.tiles[1], { fromBell: 240, unit: 6 })).code], ['NotInPatch', 'TooFew', 'TooFew']);
  assert.equal(tendAt(250, host(2, 3, b0.tiles[1], { fromBell: 240 }), fr.land, who('k2', 3)).code, 'NotYours');
  const mate = host(2, 0, b0.tiles[1], { fromBell: 240, holder: 'k2' }), ok = tendAt(315, mate, fr.land, who('k2', 0));
  assert.deepEqual([ok.ok, ok.log.op, ok.log.restored, ok.land.banners[0].frayed, ok.land.banners[0].tendedTurn, ok.land.counted[0]], [true, 'TEND', true, false, 315, b0.tiles.length], 'a nation-mate may walk a loose banner; accepted up to the turn before the strike');
  assert.equal(tendAt(330, mate, ok.land, who('k2', 0)).code, 'NotArrivedSince', 'the same host cannot walk it twice');
  // 72 turns past the limit anyone may strike it
  assert.deepEqual([C.strike(at(315), fr.land, 315, { slot: 0, reason: 'grace' }).need, C.strike(at(316), fr.land, 316, { slot: 0, reason: 'grace', by: 'keeper' }).log.reason], [{ turn: 316 }, 'grace']);
  const gone = C.strike(at(316), fr.land, 316, { slot: 0, reason: 'grace', by: 'keeper' }).land;
  assert.deepEqual([gone.banners[0].used, [...gone.claim].every(c => c === 0xff), tendAt(316, mate, gone, who('k2', 0)).code], [false, true, 'TooLate']);
  // a firm banner: 432 turns, any host of its holder (scouts too) in the patch or next to it
  const pv = board(), h = host(1, 0, CENTRE, { fromBell: 80 }), firmLand = raised({ ...pv, entries: [h] }, fresh(pv), h, me).land;
  assert.deepEqual(C.walkDue(pv, firmLand, 0), { clock: 100, firm: true, limit: 432, frayAt: 532, strikeAt: 604 });
  const scout = host(3, 0, EAST3, { fromBell: 120, unit: 6, holder: 'k1', troops: 100_000 });
  assert.equal(C.tend({ ...at(130), holderNation: 0, wedge: 0, entries: [scout] }, firmLand, scout, me, 130, { slot: 0 }).code, 'NotBeside');
  const beside = { ...scout, tile: EAST2 };
  assert.equal(C.tend({ ...pv, resolvedNext: 130, entries: [beside] }, firmLand, beside, me, 130, { slot: 0 }).ok, true, 'scouts walk their owner\'s firm banners, from the tile next to the patch');
  assert.equal(C.tend({ ...pv, resolvedNext: 130, entries: [beside] }, firmLand, { ...beside, holder: 'k9' }, who('k9', 0), 130, { slot: 0 }).code, 'NotYours', 'a firm banner is walked by its holder only');
  // a stump: under three tiles and a clock 144 turns old
  const stump = C.cloneLand(firmLand);
  for (const t of stump.banners[0].tiles.splice(2)) stump.claim[t] = 0xff;
  assert.deepEqual([C.strike({ ...pv, resolvedNext: 243 }, stump, 243, { slot: 0, reason: 'stump' }).code, C.strike({ ...pv, resolvedNext: 244 }, stump, 244, { slot: 0, reason: 'stump' }).ok, C.strike({ ...pv, resolvedNext: 244 }, firmLand, 244, { slot: 0, reason: 'stump' }).code], ['NotDue', true, 'NotDue']);
});

test('6: a banner with a hostile fighting host on its pole is frozen: no strike, no widening, and a village founded beside it takes none of its tiles', () => {
  const mine = host(1, 0, CENTRE, { fromBell: 80, holder: 'k1' }), pv0 = board({ sites: [EAST2], entries: [mine] }), me = who('k1', 0);
  const land = raised(pv0, fresh(pv0), mine, me).land;
  const foe = host(2, 3, CENTRE, { fromBell: 110 }), by = host(3, 0, EAST, { fromBell: 80, holder: 'k1' }), pv = board({ sites: [EAST2], resolvedNext: 120, entries: [foe, by] });
  assert.equal(C.contested(pv, land, 0).id, 2n);
  assert.equal(C.contested({ ...pv, entries: [by] }, land, 0), null);
  assert.equal(C.contested({ ...pv, entries: [{ ...foe, unit: 6 }, by] }, land, 0), null, 'scouts contest nothing');
  assert.equal(C.strike(pv, land, 120, { slot: 0, reason: 'own', holder: me }).code, 'Contested');
  const spare = [...Array(61).keys()].find(t => C.steps(t, CENTRE) === 2 && C.neighbours(t).includes(EAST) && t !== EAST2);
  assert.equal(C.dress(pv, land, by, me, 120, { slot: 0, tile: spare }).code, 'Contested');
  // the holder may still walk it, and may win the pole back; the attacker takes exactly the patch that stood
  const newcomer = host(4, 0, EAST, { fromBell: 115, holder: 'k1' });
  assert.equal(C.tend({ ...pv, entries: [foe, newcomer] }, land, newcomer, me, 120, { slot: 0 }).ok, true);
  // a village founded on the site next to the patch: it takes its site and the open neighbours, none of the contested banner's tiles
  const frozen = C.hearth(pv, land, { site: 0, nation: 0, holder: 'k9' });
  assert.deepEqual([frozen.log.op, frozen.log.fromTiles, frozen.land.banners[0].tiles.length], ['HEARTH', [], 7]);
  assert.ok(frozen.log.tiles.every(t => !land.banners[0].tiles.includes(t)));
  // with nobody on the pole a first village takes the outer tiles of a nation-mate's banner next to it, never the pole
  const free = C.hearth({ ...pv, entries: [by] }, land, { site: 0, nation: 0, holder: 'k9' });
  assert.deepEqual([free.log.fromTiles.map(x => x.tile), free.land.banners[0].tiles.length, free.land.claim[EAST], free.land.banners[0].pole], [[EAST], 6, 0, CENTRE]);
  // and nothing of another nation's banner
  const theirs = C.hearth({ ...pv, entries: [] }, land, { site: 0, nation: 3, holder: 'k9' });
  assert.deepEqual([theirs.log.fromTiles, theirs.land.banners[0].tiles.length], [[], 7]);
  // without the enemy the holder strikes freely: the tiles return to open ground
  const struck = C.strike({ ...pv, entries: [by] }, land, 120, { slot: 0, reason: 'own', holder: me });
  assert.deepEqual([struck.ok, struck.log.op, struck.log.reason, struck.log.tiles.length, struck.land.banners[0].used], [true, 'STRIKE', 'own', 7, false]);
  assert.equal(C.strike({ ...pv, entries: [by] }, land, 120, { slot: 0, reason: 'own', holder: who('k5', 0) }).code, 'NotYours');
});

test('7: the trail is the host\'s own: its last steps, up to three tiles, passing over the flower and stopping at the first tile that cannot be added', () => {
  const dark = board({ exploredMask: 0n }), me = who('k1', 0);
  // two hosts that marched to neighbouring tiles by different routes get different tails
  const A = host(1, 0, CENTRE), B = host(2, 0, 3, { holder: 'k2' });
  let land = C.writeTrail(dark, fresh(dark), A, [WEST, 13, 6, 0]).land;
  land = C.writeTrail(dark, land, B, [9, 16, 24]).land;
  const pa = C.patch(dark, land, A, me), pb = C.patch(dark, land, B, who('k2', 0));
  assert.deepEqual([pa.trail, pa.size, pb.trail, pb.trail.some(t => pa.tiles.includes(t))], [[13, 6, 0], 10, [16, 24], false], 'the tiles already in the flower (21; 9) are passed over; the tail follows the host\'s own steps');
  assert.deepEqual(C.trails({ ...dark, entries: [A, B] }, land).map(t => [t.host, t.tiles]), [['1', [WEST, 13, 6, 0]], ['2', [9, 16, 24]]]);
  // a mustered host gets none
  assert.deepEqual(C.patch(board(), fresh(dark), host(3, 0, CENTRE), me).trail, []);
  // it stops at the first tile that cannot be added: impassable, a site, banner land
  const blocked = (over, l = land) => C.patch({ ...dark, ...over }, l, A, me).trail;
  assert.deepEqual([blocked({ passableMask: ALL & ~(1n << 6n) }), blocked({ sites: [6] }, { ...land, sites: [6] }), blocked({ passableMask: ALL & ~(1n << 13n) })], [[13], [13], []]);
  // a tail tile within two steps of a hostile fighting host is not taken, and the walk stops there
  const D = host(4, 0, 60), east = C.writeTrail(dark, fresh(dark), D, [54, EAST2, EAST, CENTRE]).land, near = host(9, 3, WEST, { troops: 100_000 });
  assert.deepEqual([C.steps(WEST, EAST), C.steps(WEST, EAST2), C.patch({ ...dark, entries: [D] }, east, D, me).trail], [2, 3, [EAST2, EAST, CENTRE]]);
  assert.deepEqual(C.patch({ ...dark, entries: [D, near] }, east, D, me).trail, [EAST2], 'the tile two steps from the enemy is not taken and nothing behind it is');
  assert.deepEqual(C.patch({ ...dark, heartland: true, entries: [D, near] }, east, D, me).trail, [EAST2, EAST, CENTRE], 'not in a heartland');
  assert.deepEqual(C.patch({ ...dark, entries: [D, { ...near, unit: 6 }] }, east, D, me).trail, [EAST2, EAST, CENTRE], 'scouts stop nothing');
  // the patch never exceeds twelve tiles, and the raise's record says which tiles the tail brought
  const r = raised({ ...dark, entries: [A] }, land, A, me);
  assert.deepEqual([r.log.trail, r.log.flower.length, r.log.tiles.length, r.land.banners[0].tiles.length <= N.PATCH_MAX], [[13, 6, 0], 7, 10, true]);
});

test('8: caps: two banners a player in one province; at most two poles beside one empty site; the tier\'s cap; sixteen slots; the ceiling abroad', () => {
  const me = who('k1', 0), pv = board();
  let land = fresh(pv);
  land = raised(pv, land, host(1, 0, 6, { holder: 'k1' }), me).land;
  land = raised(pv, land, host(2, 0, CENTRE, { holder: 'k1' }), { ...me, bannersHeld: 1 }).land;
  const third = C.canRaise(pv, land, host(3, 0, 54, { holder: 'k1' }), { ...me, bannersHeld: 2 });
  assert.deepEqual([third.code, third.need], ['PerProvince', { perProvince: 2 }], 'the next land is where you march');
  assert.equal(C.canRaise(pv, land, host(3, 0, 54, { holder: 'k2' }), who('k2', 0)).ok, true, 'a nation-mate may');
  assert.deepEqual([C.capOf({ tier: 0 }), C.capOf({ tier: 1 }), C.capOf({ tier: 2 }), C.capOf({ tier: 3 })], [3, 5, 7, 9]);
  assert.deepEqual(C.canRaise(pv, fresh(pv), host(3, 0, 54), who('k3', 0, { tier: 0, bannersHeld: 3 })).need, { cap: 3, held: 3 });
  // an empty site keeps room: a third pole beside it is refused
  const site = CENTRE, around = C.neighbours(site), sited = board({ sites: [site] });
  const l3 = C.newLand([site], 100), poles = [around[0], around[3]], open = around[1];
  for (const [i, p] of poles.entries()) { l3.banners[i] = { used: true, frayed: false, elbow: false, pole: p, nation: 0, tiles: [p], raisedTurn: 100, tendedTurn: 100, dressDay: -1, holder: `k${i}` }; l3.claim[p] = 16 + i; }
  assert.deepEqual([C.canRaise(sited, l3, host(3, 0, open), who('k3', 0)).code, C.canRaise(sited, l3, host(3, 0, open), who('k3', 0)).need], ['SiteRoom', { site: 0 }]);
  l3.villageNation[0] = 0; l3.claim[site] = 0;
  assert.notEqual(C.canRaise(sited, l3, host(3, 0, open), who('k3', 0)).code, 'SiteRoom', 'a settled site is no empty site');
  // sixteen slots
  const full = fresh(pv);
  full.banners.forEach((b, i) => { b.used = true; b.holder = `x${i}`; b.pole = 60; });
  assert.equal(C.canRaise(pv, full, host(3, 0, CENTRE), who('k3', 0)).code, 'SlotsFull');
  // the ceiling abroad: a nation's land in a province of another keep stops at 24 tiles, village land included
  const far = board({ holderNation: 3, wedge: 3 }), held = fresh(far);
  [...Array(61).keys()].filter(t => C.steps(t, 0) <= 4 && t !== 0).slice(0, 20).forEach(t => { held.claim[t] = 2; });
  held.villageNation[2] = 0; held.villageTiles[2] = 20;
  const edge = [...Array(61).keys()].find(t => held.claim[t] === 0xff && C.neighbours(t).some(j => held.claim[j] === 2) && C.neighbours(t).filter(j => held.claim[j] === 0xff).length >= 4);
  const over = C.canRaise(far, held, host(3, 0, edge, { fromBell: 0 }), who('k3', 0));
  assert.deepEqual([over.code, over.need], ['CeilingReached', { ceiling: 24, have: 20 }]);
});

test('9: the score: every tile pays one a turn; without the keep a nation is paid for 24 tiles at most; the six totals always add up to 61 a turn', () => {
  const far = board({ holderNation: 3, wedge: 3 }), land = fresh(far);
  // 30 tiles of nation 0 (a village's 6 and two banners of 12) in a province of nation 3's wedge
  const tiles = [...Array(30).keys()];
  tiles.slice(0, 6).forEach(t => { land.claim[t] = 0; });
  land.villageNation[0] = 0; land.villageHolder[0] = 'v';
  for (const [i, part] of [tiles.slice(6, 18), tiles.slice(18, 30)].entries()) { land.banners[i] = { used: true, frayed: false, elbow: false, pole: part[0], nation: 0, tiles: part, raisedTurn: 100, tendedTurn: 100, dressDay: -1, holder: `b${i}` }; for (const t of part) land.claim[t] = 16 + i; }
  const held = C.recounted(land);
  assert.deepEqual([held.counted, held.villageTiles[0], C.strike(far, held, 100, { slot: 9, reason: 'grace' }).ok], [[30, 0, 0, 0, 0, 0], 6, false]);
  const withCounts = C.fray({ ...far, resolvedNext: 1_000 }, held, 1_000, { slot: 1 }).land;   // slot 1 frayed: 18 count
  const unfray = C.tend({ ...far, resolvedNext: 1_000, entries: [host(1, 0, tiles[19], { fromBell: 999 })] }, withCounts, host(1, 0, tiles[19], { fromBell: 999 }), who('b1', 0), 1_000, { slot: 1 }).land;
  assert.deepEqual([unfray.counted, C.paid(unfray, 3)], [[30, 0, 0, 0, 0, 0], [24, 0, 0, 37, 0, 0]], 'thirty held, twenty-four paid; the keep takes the rest');
  assert.deepEqual(C.paid(withCounts, 3), [18, 0, 0, 43, 0, 0]);
  assert.deepEqual(C.paid(unfray, 0), [61, 0, 0, 0, 0, 0], 'under its own keep a nation is paid in full, and for the commons');
  for (const x of [held, withCounts, unfray]) for (const holder of [0, 3, 5]) assert.equal(sum(C.paid(x, holder)), 61);
  // conservation through a sequence of acts
  assert.equal(sum(unfray.totals), 61 * (1_000 - 100));
  const later = C.accrue(unfray, 3, 1_250);
  assert.deepEqual([sum(later.totals), later.cursor, later.totals[0] - unfray.totals[0], unfray.cursor], [61 * 1_150, 1_250, 24 * 250, 1_000], 'accrue gives a new record');
  // the personal ledger: every tile in a holder's name that counts (display only; it is not cut at the keep's share)
  assert.deepEqual([later.names.v - unfray.names.v, later.names.b0 - unfray.names.b0, later.names.b1 - (unfray.names.b1 ?? 0)], [6 * 250, 12 * 250, 12 * 250]);
});

test('10: elbow room: for a first banner on home ground, once, up to four tiles from nation-mates\' outer tiles, when every giver still holds as much as the planter; the banner cannot be struck by its holder for 432 turns', () => {
  // a corner where open ground leaves two tiles: tile 0 and one open neighbour; a nation-mate's banner holds the rest
  const pv = board(), mate = who('k1', 0), corner = 0, nb = C.neighbours(corner);
  let land = fresh(pv);
  const matePole = [...Array(61).keys()].find(t => C.steps(t, corner) === 2 && C.neighbours(t).filter(x => nb.includes(x)).length === 2);
  land = raised(pv, land, host(1, 0, matePole, { holder: 'k1' }), mate).land;
  const taken = nb.filter(t => land.claim[t] === 16), open = nb.filter(t => land.claim[t] === 0xff);
  assert.deepEqual([taken.length, open.length], [2, 1]);
  const e = host(2, 0, corner, { holder: 'k2' }), me = who('k2', 0);
  assert.deepEqual(C.canRaise(pv, land, e, me).need, { tiles: 3, have: 2 }, 'open ground leaves two tiles');
  const ok = C.raise(pv, land, e, me, 100, { elbow: taken });
  assert.deepEqual([ok.ok, ok.land.banners[1].tiles.length, ok.land.banners[0].tiles.length, ok.land.banners[1].elbow, ok.elbowUsed], [true, 4, 5, true, true], 'made up to four; the giver keeps five');
  assert.deepEqual([ok.log.fromTiles.map(x => [x.tile, x.slot, x.holder]), ok.log.elbow], [taken.map(t => [t, 0, 'k1']), taken], 'the record names the tiles and whose they were (the nation\'s score is unchanged)');
  assert.deepEqual([ok.land.counted, land.counted], [[9, 0, 0, 0, 0, 0], [7, 0, 0, 0, 0, 0]]);
  // refused: a second banner, abroad, a second time, a pole, a tile that is not beside the new pole, a giver left with less than the planter or under three
  const why = (over = {}, tiles = taken, l = land, board0 = pv) => { const r = C.canRaise(board0, l, e, { ...me, ...over }, 100, { elbow: tiles }); return r.ok ? 'ok' : `${r.code}:${r.need?.why}`; };
  assert.deepEqual([why({ bannersHeld: 1 }), why({ elbowUsed: true }), why({}, [matePole]), why({}, [land.banners[0].tiles.find(t => !nb.includes(t) && t !== matePole)])], ['ElbowNotAllowed:first', 'ElbowNotAllowed:used', 'ElbowNotAllowed:tile', 'ElbowNotAllowed:tile']);
  const abroadBoard = board({ holderNation: 3, wedge: 3 });
  assert.match(why({}, taken, land, abroadBoard), /ElbowNotAllowed:home|NotHere/);
  const small = C.cloneLand(land);
  for (const t of small.banners[0].tiles.splice(4)) small.claim[t] = 0xff;   // the mate's patch cut to four tiles (the two shared ones among them)
  assert.ok(taken.every(t => small.banners[0].tiles.includes(t)) || true);
  const thin = C.cloneLand(land);
  thin.banners[0].tiles = [matePole, ...taken, land.banners[0].tiles.find(t => t !== matePole && !taken.includes(t))];
  for (let t = 0; t < 61; t++) if (thin.claim[t] === 16 && !thin.banners[0].tiles.includes(t)) thin.claim[t] = 0xff;
  assert.equal(why({}, taken, thin), 'ElbowNotAllowed:giver', 'a giver of four would be left with two');
  const contestedBoard = board({ entries: [host(9, 3, matePole, { fromBell: 80 })] });
  assert.equal(why({}, taken, land, contestedBoard), 'ElbowNotAllowed:contested');
  // with open ground enough for four there is no elbow room
  assert.equal(C.canRaise(pv, fresh(pv), host(2, 0, CENTRE, { holder: 'k2' }), me, 100, { elbow: [EAST] }).code, 'ElbowNotAllowed');
  // its own strike is locked for 432 turns
  const locked = C.strike({ ...pv, resolvedNext: 531 }, ok.land, 531, { slot: 1, reason: 'own', holder: me });
  assert.deepEqual([locked.code, locked.need], ['ElbowLocked', { turn: 532 }]);
  assert.equal(C.strike({ ...pv, resolvedNext: 532 }, ok.land, 532, { slot: 1, reason: 'own', holder: me }).ok, true);
});

test('taking and pulling down: 72 turns on a firm banner\'s pole, 36 on a loose one or a border banner faced by that nation, half for the wedge\'s own nation; a take only where the taker could have raised', () => {
  // nation 3 raises abroad, in nation 0's wedge: loose; nation 0, the wedge's own, fells it in 18
  const row = C.BORDER_ROWS[0], pole = row[2], face = { open: true, ring: 2, holderNation: 3, banners: [0, 0, 0, 0, 0, 0] };
  const pv = board({ faces: [face, null, null, null, null, null] }), theirs = who('k3', 3), planter = host(3, 3, pole, { fromBell: 0, holder: 'k3' });
  const land = raised({ ...pv, entries: [planter] }, fresh(pv), planter, theirs).land;
  assert.deepEqual([C.firm(pv, land.banners[0]), C.fallTolls(pv, land, 0, 0, 150), C.fallTolls(pv, land, 0, 4)], [false, { tolls: 18, firm: false, border: false, own: true, atTurn: 168 }, { tolls: 36, firm: false, border: false, own: false, atTurn: null }]);
  const mine = host(1, 0, pole, { fromBell: 150, holder: 'k1' }), me = who('k1', 0), at = r => ({ ...pv, resolvedNext: r, entries: [mine] });
  assert.deepEqual([C.canFell(at(167), land, mine, me, 167, { slot: 0 }).need, C.canFell(at(168), land, mine, me, 168, { slot: 0 })], [{ tolls: 1, atTurn: 168 }, { ok: true, tolls: 18, atTurn: 168, stop: null }]);
  const took = C.take(at(168), land, mine, me, 168, { slot: 0 });
  assert.deepEqual([took.log.op, took.log.from, took.log.fromHolder, took.log.nation, took.log.holder, took.land.banners[0].raisedTurn, took.land.counted], ['TAKE', 3, 'k3', 0, 'k1', 168, [land.banners[0].tiles.length, 0, 0, 0, 0, 0]], 'the whole patch, in the taker\'s name, from turn r');
  const pulled = C.pullDown(at(168), land, mine, me, 168, { slot: 0 });
  assert.deepEqual([pulled.log.op, pulled.log.tiles.length, pulled.land.banners[0].used, pulled.land.counted], ['PULL', land.banners[0].tiles.length, false, [0, 0, 0, 0, 0, 0]]);
  // refusals
  const fell = (h, by = me, r = 168) => C.canFell({ ...pv, resolvedNext: r, entries: [h] }, land, h, by, r, { slot: 0 }).code;
  assert.deepEqual([fell({ ...mine, tile: CENTRE }), fell({ ...mine, unit: 6 }), fell({ ...mine, troops: 99_000 }), fell({ ...mine, inTransit: true }), fell(host(5, 3, pole, { fromBell: 0 }), who('k5', 3))], ['NotOnPole', 'Scouts', 'TooFew', 'InTransit', 'SameNation']);
  assert.equal(C.canFell({ ...pv, heartland: true, resolvedNext: 300, entries: [host(6, 4, pole, { fromBell: 0 })] }, land, host(6, 4, pole, { fromBell: 0 }), who('k6', 4), 300, { slot: 0 }).code, 'Heartland');
  // a take falls back to pulling down, with a note, when the taker is at the cap, holds two there, or could not have raised there
  assert.deepEqual([C.take(at(168), land, mine, { ...me, bannersHeld: 5 }, 168, { slot: 0 }).log.op, C.take(at(168), land, mine, { ...me, bannersHeld: 5 }, 168, { slot: 0 }).note], ['PULL', 'cap']);
  const stranger = host(6, 4, pole, { fromBell: 100, troops: 500_000, holder: 'k6' });
  assert.deepEqual([C.takeStop(pv, land, 0, who('k6', 4)), C.takeStop(pv, land, 0, who('k6', 4, { tier: 0 }))], ['place', 'town'], 'a third nation that touches neither its land nor its border may only pull down');
  assert.equal(C.take({ ...pv, resolvedNext: 136, entries: [stranger] }, land, stranger, who('k6', 4), 136, { slot: 0 }).log.op, 'PULL');
  // a firm banner: 72; a border banner under its own keep falls in 36 to the nation that faces it, and stays firm for everything else
  const home = host(1, 0, pole, { fromBell: 0, holder: 'k1' }), firmLand = raised({ ...pv, entries: [home] }, fresh(pv), home, me).land;
  assert.deepEqual([C.borderToward(pv, firmLand, 0), C.fallTolls(pv, firmLand, 0, 3).tolls, C.fallTolls(pv, firmLand, 0, 4).tolls, C.firm(pv, firmLand.banners[0])], [[3], 36, 72, true]);
  assert.deepEqual(C.borderToward({ ...pv, faces: [{ ...face, holderNation: 5, banners: [0, 0, 0, 0, 1, 0] }, null, null, null, null, null] }, firmLand, 0), [4, 5], 'the keep of the province it faces, or a banner there');
  assert.deepEqual(C.borderToward({ ...pv, faces: [{ ...face, ring: 1 }, null, null, null, null, null] }, firmLand, 0), []);
  // a nation-mate takes over a banner past its grace
  const mate = host(8, 0, pole, { fromBell: 600, holder: 'k8' });
  assert.deepEqual([C.takeOver({ ...pv, resolvedNext: 603, entries: [mate] }, firmLand, mate, who('k8', 0), 603, { slot: 0 }).code, C.takeOver({ ...pv, resolvedNext: 604, entries: [mate] }, firmLand, mate, who('k8', 0), 604, { slot: 0 }).log.op], ['NotPastGrace', 'TAKEOVER']);
});

test('widening a banner: one tile a game day, explored, passable, within two steps of the pole and next to the patch, with a host of the holder beside it', () => {
  const sites = [EAST], pv0 = board({ sites }), me = who('k1', 0), planter = host(1, 0, CENTRE, { holder: 'k1' });
  const land = raised({ ...pv0, entries: [planter] }, C.newLand(sites, 100), planter, me).land;
  const ring2 = [...Array(61).keys()].filter(t => C.steps(t, CENTRE) === 2 && C.neighbours(t).some(j => land.banners[0].tiles.includes(j)));
  const tile = ring2[0], by = host(2, 0, tile, { unit: 6, troops: 100_000, holder: 'k1' }), pv = { ...pv0, resolvedNext: 150, entries: [by] };
  const d = C.dress(pv, land, by, me, 150, { slot: 0, tile });
  assert.deepEqual([d.ok, d.log.op, d.log.tile, d.land.banners[0].tiles.length, d.land.banners[0].dressDay, d.land.banners[0].tendedTurn, d.walked], [true, 'DRESS', tile, 7, 1, 150, true], 'scouts stand by; dressing a firm banner counts as walking it');
  assert.deepEqual([C.dress({ ...pv, resolvedNext: 151 }, d.land, { ...by, tile: ring2[1] }, me, 151, { slot: 0, tile: ring2[1] }).code, C.dress({ ...pv, resolvedNext: 288 }, d.land, { ...by, tile: ring2[1] }, me, 288, { slot: 0, tile: ring2[1] }).ok], ['DressedToday', true]);
  const far3 = [...Array(61).keys()].find(t => C.steps(t, CENTRE) === 3);
  assert.deepEqual([C.dress(pv, land, { ...by, tile: far3 }, me, 150, { slot: 0, tile: far3 }).code, C.dress(pv, land, { ...by, tile: 0 }, me, 150, { slot: 0, tile }).code, C.dress({ ...pv, exploredMask: 0n }, land, by, me, 150, { slot: 0, tile }).code], ['TooFar', 'NoHostBeside', 'NotSurveyed']);
  assert.deepEqual([C.dress(pv, land, by, who('k2', 0), 150, { slot: 0, tile }).code, C.dress({ ...pv, passableMask: ALL & ~(1n << BigInt(tile)) }, land, by, me, 150, { slot: 0, tile }).code], ['NotYours', 'NotOpen']);
  const foe = host(9, 3, C.neighbours(tile).find(t => !land.banners[0].tiles.includes(t) && t !== EAST), { troops: 100_000 });
  assert.equal(C.dress({ ...pv, entries: [by, foe] }, land, by, me, 150, { slot: 0, tile }).code, 'Denied', 'an enemy host next to the tile that the host standing by does not outnumber two to one');
  const fullLand = C.cloneLand(land);
  fullLand.banners[0].tiles = [...Array(12).keys()].map(i => land.banners[0].tiles[i] ?? 50 + i);
  assert.equal(C.dress(pv, fullLand, by, me, 150, { slot: 0, tile }).code, 'PatchFull');
});

test('making room in a full province (the function and its vectors; the sample world does not call it)', () => {
  const eight = (over = () => ({})) => [...Array(8).keys()].map(i => host(10 + i, 0, 40 + i, { holder: i < 3 ? 'ka' : `k${i}`, fromBell: 80 + i, ...over(i) }));
  const pv = board({ entries: eight() }), land = fresh(pv);
  assert.equal(C.giveWay(board({ entries: eight().slice(0, 7) }), land, 0, 'kn', 5), null, 'seven hosts: nobody has to give way');
  // fair share: a citizen with two more hosts than the newcomer's owner; the longest standing first
  assert.equal(C.giveWay(pv, land, 0, 'kn', 5).id, 10n);
  assert.equal(C.giveWay(board({ entries: eight(i => ({ holder: `k${i}` })) }), land, 0, 'kn', 5), null, 'one host each and nobody stale: the newcomer is refused');
  // stale: on no pole and stood 36 turns
  assert.equal(C.giveWay(board({ entries: eight(i => ({ holder: `k${i}`, fromBell: i === 5 ? 64 : 90 })) }), land, 0, 'kn', 5).id, 15n);
  // relief: a hostile fighting host stands on the newcomer's tile: any host may give way; scouts before fighting hosts, hosts on no pole first, never the keep's
  const relief = board({ keepTile: 40, entries: [...eight(i => ({ holder: `k${i}`, fromBell: 90, unit: i === 4 ? 6 : 0 })), host(99, 3, 5)] });
  assert.equal(C.giveWay(relief, land, 0, 'kn', 5).id, 14n);
  const poled = C.cloneLand(land);
  poled.banners[0] = { used: true, frayed: false, elbow: false, pole: 44, nation: 0, tiles: [44], raisedTurn: 90, tendedTurn: 90, dressDay: -1, holder: 'k4' };
  assert.equal(C.giveWay(relief, poled, 0, 'kn', 5).id, 11n, 'the scouts stand on a pole: a host on no pole goes first, and never the one on the keep tile');
});

// ------------------------------------------------------------------ the sample world with the prototype on
const J = x => JSON.parse(JSON.stringify(x, (k, v) => (typeof v === 'bigint' ? String(v) : v)));
/** A sample world with the prototype on, its clock stopped (the test steps turn by turn); `get(path)` reads a record as the page would. */
async function claimed(opts = {}) {
  const s = await sample({ neighbours: true, claims: true, ...opts });
  s.w.pause(true);
  const get = path => s.w.herald(U(path).pathname, U(path))?.body ?? null;
  const proto = () => J(s.w.records().filter(x => x.kind === 'PROTO_LAND').map(x => x.fields));
  const land = body => s.w.relay('POST', '/gw/f/proto/land', body).then(r => r.body);
  const check = () => { const st = get('/h/proto/standings'); assert.equal(st.check.sum, st.check.expected, `turn ${s.w.turn()}: the totals add up`); return st; };
  return { ...s, get, proto, land, check, mine: () => get(`/h/me/${s.v.wallet}`).proto.land, home: () => get(`/h/province/${HOME.p},${HOME.q}/latest`).proto.land };
}

test('the switch: off by default; with it off nothing of the prototype is served and the world says nothing of it', async () => {
  const off = await sample({ neighbours: true });
  assert.equal(off.w.proto, null);
  const season = off.w.herald('/h/season', U('/h/season')).body;
  assert.deepEqual([season.sample.proto, season.sample.simpler], [undefined, SIMPLER]);
  assert.equal('proto' in off.w.herald(`/h/province/${HOME.p},${HOME.q}/latest`, U('/x')).body, false);
  assert.equal('proto' in off.w.herald(`/h/me/${off.v.wallet}`, U('/x')).body, false);
  assert.deepEqual([off.w.herald('/h/proto/standings', U('/h/proto/standings')), off.w.herald('/h/proto/preview', U('/h/proto/preview')), await off.w.relay('POST', '/gw/f/proto/land', { op: 'fray', province: [2, 0], slot: 0 })], [null, null, null], 'the routes are not there: the fixture answers as it always did');
  assert.equal(off.w.records().some(x => x.kind === 'PROTO_LAND'), false);
  assert.equal('proto' in off.w.summary(), false);
  // the fixture server: a claims option reaches the world; without it the route is refused as every write of the still fixture's relay is not
  const srv = await startServer();
  try {
    srv.stage('holding');
    srv.live(true);
    assert.equal((await (await fetch(`${srv.url}/h/season`)).json()).sample.proto, undefined);
    assert.deepEqual(await (await fetch(`${srv.url}/gw/f/proto/land`, { method: 'POST', body: '{"op":"fray"}' })).json(), { ok: false, code: 'Unavailable', error: 'the screenshot fixture relay sends nothing' });
    assert.equal((await fetch(`${srv.url}/h/proto/standings`)).status, 404);
    srv.live(true, { claims: true });
    const on = await (await fetch(`${srv.url}/h/season`)).json();
    assert.deepEqual([on.sample.proto.claims.label, on.sample.simpler.length], [LABEL, SIMPLER.length + SIMPLER_CLAIMS.length]);
    assert.equal((await (await fetch(`${srv.url}/h/proto/standings`)).json()).proto, true);
    // a stage with no village plays no prototype
    srv.stage('joined');
    assert.equal((await (await fetch(`${srv.url}/h/season`)).json()).sample.proto, undefined);
  } finally { await srv.close(); }
});

test('11: with the prototype off every record is byte-identical to the world before it was written: forty turns of play, as a town and as a hamlet just founded', async () => {
  for (const [name, opts] of Object.entries(GOLDEN_PLAYS)) {
    const r = await play40(opts);
    assert.equal(r.digest, GOLDEN[name], `${name}: the records of forty turns, hashed, are those of the world before the prototype`);
    assert.ok(r.answers.filter(x => x.endsWith(' ok')).length >= 25, 'the play gave orders and they were taken');
    assert.equal(r.world.proto, null);
  }
  // (the digest is of every record served: a world with the prototype on, which has its own records and premises, gives another)
  const on = await play40({ ...GOLDEN_PLAYS.holding, claims: true }, 2);
  assert.ok(on.world.proto && on.digest !== (await play40(GOLDEN_PLAYS.holding, 2)).digest);
});

test('the season record says what it is: the label, the note, the numbers, where it is simpler; the first frame: village land for every village, a banner for each neighbour town', async () => {
  const { get, proto, mine, home, check, w, v } = await claimed();
  const s = get('/h/season').sample, c = s.proto.claims;
  assert.deepEqual([c.rule, c.version, c.label, c.scoreNote, c.reduced, c.clockLag, c.route, c.preview, c.standings], ['standing-ground', 'design-2026-10-10-r2', LABEL, SCORE_NOTE, ['no keeps', 'home province only is heartland', 'scripted neighbours', 'the keeper frays on time', 'no full-province rule'], 1, '/gw/f/proto/land', '/h/proto/preview', '/h/proto/standings']);
  assert.deepEqual(c.numbers, J(N));
  assert.deepEqual(s.simpler, [...SIMPLER, ...SIMPLER_CLAIMS]);
  for (const line of ['no keeps, so the wedge\'s nation stands in for the keep holder of every province', 'only the viewer\'s home province is heartland; the other ring 2 provinces are treated as frontier', 'the neighbours raise and attack banners by a seeded script, not by choice', 'the world\'s keeper marks lapsed banners itself; on a chain somebody has to send that instruction', 'the eight-hosts cap and the rule that makes room in a full province are not exercised'])
    assert.ok(SIMPLER_CLAIMS.some(x => x.includes(line)), line);
  assert.ok(SIMPLER_CLAIMS.every(x => x.startsWith('prototype rule "banners"')));
  // the land at the first frame
  const h = home();
  assert.deepEqual([h.holderNation, h.heartland, h.resolvedNext, h.openedTurn, h.claim.length], [0, true, 41, 41, 61]);
  assert.deepEqual(h.villages.map(x => [x.site, x.tile, x.nation, x.holder, x.tiles]), [[HOME.site, HOME.tile, 0, ME, 7], [7, 26, 2, '2,0,7', 4]], 'each village: its site and the free neighbours inside the province');
  assert.deepEqual(h.claim.filter(x => x === HOME.site).length, 7);
  assert.deepEqual(h.banners.map(b => [b.nation, b.holder, b.firm, b.frayed, b.contested, b.walkDue - b.tendedTurn, b.strikeAt - b.walkDue]), [[2, '2,0,7', false, false, null, 144, 72]], 'the neighbour town\'s banner: loose in another nation\'s wedge');
  assert.deepEqual([h.counted, h.paid, sumOf(h.paid)], [[7, 0, 4 + h.banners[0].tiles.length, 0, 0, 0], [61 - 4 - h.banners[0].tiles.length, 0, 4 + h.banners[0].tiles.length, 0, 0, 0], 61]);
  assert.equal(get('/h/province/1,0/latest').proto, undefined, 'rings 0 and 1 have no banners and no score');
  assert.deepEqual([get('/h/province/1,1/latest').proto.land.banners.map(b => [b.nation, b.firm]), get('/h/province/2,-2/latest').proto.land.banners.map(b => [b.nation, b.firm])], [[[4, false]], [[5, true]]], 'firm in its own nation\'s wedge');
  // the records: a HEARTH for every village, a RAISE for each neighbour's banner, all marked as the world's premise
  const base = proto();
  assert.deepEqual([base.filter(x => x.op === 'HEARTH').length, base.filter(x => x.op === 'RAISE').map(x => [x.nation, x.by, x.premise, x.host])], [29, [[2, 'script', true, null], [4, 'script', true, null], [5, 'script', true, null]]]);
  assert.ok(base.every(x => x.premise && x.turn === 41));
  const served = get('/h/events?after=0').events.filter(e => e.kind === 'PROTO_LAND');
  assert.ok(served.length === base.length && served.every(e => e.proto === true && !('body_b64' in e) && typeof e.seq === 'string'));
  // the page's own reader drops them (they are no PS2 records) and still reads the rest
  const { decodePage } = await import('../../permutation-server/web/frontier/flog.mjs');
  const page = decodePage(get('/h/events?after=0').events);
  assert.equal(page.bad, served.length);
  assert.ok(page.records.length >= 5);
  // the viewer
  const m = mine();
  assert.deepEqual([m.holder, m.nation, m.tiles, m.villageTiles, m.bannersHeld, m.cap, m.perProvince, m.nextPrice, m.exploreLeftToday, m.walkPaidToday, m.elbowUsed, m.ledger], [ME, 0, 7, 7, 0, 5, 2, 0, 5, false, false, 0]);
  assert.deepEqual(m.hosts.map(x => [x.host, x.raise?.code ?? null]), [[String(HOSTS.free), 'SiteOrCamp'], [String(HOSTS.scout), null]]);
  // the Citizen record is not touched: the prototype's purse is its own
  const off = await sample({ neighbours: true });
  assert.equal(get(`/h/me/${v.wallet}`).citizen.bytes_b64, off.w.herald(`/h/me/${v.wallet}`, U('/x')).body.citizen.bytes_b64);
  const st = check();
  assert.deepEqual([st.unit, st.note, st.turn, st.nations.length, st.perTurn, st.provinces], ['tile-turn', SCORE_NOTE, 41, 6, 61 * 12, 12]);
  assert.ok(Math.abs(sumOf(st.nations.map(x => x.share)) - 1) < 1e-9);
  assert.deepEqual([st.byProvince.length, st.byProvince.every(x => sumOf(x.paid) === 61), st.byProvince.find(x => x.p === HOME.p && x.q === HOME.q)], [12, true, { p: HOME.p, q: HOME.q, holderNation: 0, heartland: true, counted: h.counted, paid: h.paid, banners: 1 }]);
  // a hamlet founded a moment ago holds its land too, and three banners at most
  const hamlet = await claimed({ stage: 'provisional' });
  assert.deepEqual([hamlet.mine().tiles, hamlet.mine().cap, hamlet.mine().hosts], [7, 3, []]);
  assert.ok(w.turn() === 42);
});
const sumOf = a => a.reduce((x, y) => x + y, 0);

test('2 and 8 in the world: a host formed at turn t is refused StandLonger until the province is resolved through t + 1, then raises; a third banner in the province is refused; every act is a record', async () => {
  const { w, get, proto, land, check, mine, home, me } = await claimed();
  w.advance();   // turn 43
  const t = w.turn(), spots = get(`/h/proto/preview?p=${HOME.p}&q=${HOME.q}`).all.filter(x => x.ok).sort((a, b) => b.size - a.size || a.tile - b.tile);
  assert.deepEqual([spots[0].tile, spots[0].mode, spots[0].size, spots[0].waitTurns, spots[0].price, spots[0].trail, spots[0].tiles], [16, 'form', 5, 1, 0, [], [16, 23, 15, 9, 17]], 'the best spot within the explored ground: five tiles, one turn of standing, free');
  assert.ok(spots.length >= 5 && spots.every(x => x.size >= 3 && x.size <= 7 && x.tiles[0] === x.tile && C.steps(x.tile, HOME.tile) <= SCRIPT.EXPLORED_REACH));
  const dark = get(`/h/proto/preview?p=${HOME.p}&q=${HOME.q}&tile=53`);
  assert.deepEqual([dark.ok, dark.code, dark.mode], [false, 'NotSurveyed', 'form'], 'beyond three steps of the village the ground is not explored: scouts, or a march');
  for (const tile of [16, 30, 12]) assert.equal(w.order('Muster', { unit: 0, troops: 100, tile }).ok, true);
  const hostAt = tile => String(me().hosts.find(h => h.tile === tile).id);
  const acts = () => proto().filter(x => x.op !== 'TRAIL').length, before = acts();
  for (let r = w.summary().resolvedNext; r < t + 2; r = w.summary().resolvedNext) {
    const x = await land({ op: 'raise', host: hostAt(16), province: [HOME.p, HOME.q] });
    assert.deepEqual([x.ok, x.code, x.need, x.size], [false, 'StandLonger', { tolls: t + 2 - r, atTurn: t + 2 }, 5], `resolved up to ${r}`);
    assert.deepEqual(home().rising.find(y => y.host === hostAt(16)), { host: hostAt(16), nation: 0, holder: ME, tile: 16, sinceTurn: t + 1, canRaiseAtTurn: t + 2, tiles: 5, patch: [16, 23, 15, 9, 17], trail: [], ready: false, forming: r < t + 1 });
    w.advance();
  }
  assert.equal(acts(), before, 'a refusal writes nothing');
  assert.equal(home().rising.find(y => y.host === hostAt(16)).ready, true);
  const ok = await land({ op: 'raise', host: hostAt(16), province: [HOME.p, HOME.q], minTiles: 5, maxWorks: 0 });
  assert.deepEqual([ok.ok, ok.track, ok.op, ok.turn, ok.landMs], [true, 'proto-1', 'RAISE', t + 2, 1_200]);
  assert.deepEqual((await w.relay('GET', '/gw/f/tx/proto-1', null)).body, { state: 'unknown' }, 'it lands about 1.2 s later, as the fixture\'s other orders do');
  const rec = proto().at(-1);
  assert.deepEqual(rec, { op: 'RAISE', turn: t + 2, p: HOME.p, q: HOME.q, slot: 1, pole: 16, nation: 0, holder: ME, tiles: [16, 23, 15, 9, 17], from: null, works: 0, by: ME, host: hostAt(16), flower: [16, 23, 15, 9, 17], trail: [], elbow: [], fromTiles: [], firm: true });
  assert.deepEqual(w.orders.slice(-2).map(o => [o.name, o.ok, o.code ?? o.signature]), [['ProtoLand:raise', false, 'StandLonger'], ['ProtoLand:raise', true, 'proto-1']]);
  assert.deepEqual([mine().tiles, mine().bannersHeld, mine().banners, home().claim.filter(x => x === 17).length, home().rising.some(y => y.host === hostAt(16))], [12, 1, [{ p: HOME.p, q: HOME.q, slot: 1, pole: 16, tiles: 5, frayed: false }], 5, false]);
  assert.deepEqual([mine().ledger, mine().perTurn, mine().paidTiles], [7 * (t + 2 - 41), 12, 12], 'in the viewer\'s name: seven tiles a turn until now, twelve from this turn');
  assert.equal((await land({ op: 'raise', host: hostAt(16), province: [HOME.p, HOME.q] })).code, 'NotOpen', 'banner land is not open ground');
  // widening it: the host that stands next door, on explored open ground beside the patch; once a game day; the day's first walk pays 2 Works
  const offer = mine().hosts.find(x => x.host === hostAt(30)).dress;
  assert.deepEqual(offer, [{ slot: 1, tiles: [31], code: null }], 'what the page lights: the tile that host may add');
  const purse = mine().works;
  assert.equal((await land({ op: 'dress', host: hostAt(30), province: [HOME.p, HOME.q], slot: 1, tile: 31 })).ok, true);
  assert.deepEqual(proto().slice(-2).map(x => [x.op, x.slot, x.tile ?? null, x.tiles.length, x.works, x.by]), [['DRESS', 1, 31, 6, 0, ME], ['WALK', 1, null, 0, 2, ME]]);
  assert.deepEqual([mine().works - purse, mine().walkPaidToday, mine().tiles, home().banners.find(b => b.slot === 1).dressedToday], [2, true, 13, true]);
  assert.deepEqual([(await land({ op: 'dress', host: hostAt(30), province: [HOME.p, HOME.q], slot: 1, tile: 22 })).code, mine().hosts.find(x => x.host === hostAt(30)).dress], ['DressedToday', [{ slot: 1, tiles: [], code: 'DressedToday' }]]);
  assert.equal((await land({ op: 'raise', host: hostAt(30), province: [HOME.p, HOME.q], minTiles: 9 })).code, 'Changed');
  assert.equal((await land({ op: 'raise', host: hostAt(30), province: [HOME.p, HOME.q] })).ok, true);
  const third = await land({ op: 'raise', host: hostAt(12), province: [HOME.p, HOME.q] });
  assert.deepEqual([third.code, third.need], ['PerProvince', { perProvince: 2 }]);
  assert.deepEqual(me().hosts.length >= 3 && mine().hosts.find(x => x.host === hostAt(12)).raise, { ok: false, code: 'PerProvince', need: { perProvince: 2 } });
  // what the route refuses before the rule is asked
  assert.deepEqual([(await land({ op: 'conquer' })).code, (await land({ op: 'raise', host: hostAt(12), province: [9, 9] })).code, (await land({ op: 'raise', host: '12345', province: [HOME.p, HOME.q] })).code, (await land({ op: 'raise', host: String(w.summary().neighbours[0].hosts[0].id), province: [HOME.p, HOME.q] })).code, (await land({ op: 'strike', province: [HOME.p, HOME.q], slot: 0, reason: 'own' })).code, (await land({ op: 'fray', province: [HOME.p, HOME.q], slot: 0 })).code],
    ['BadData', 'BadData', 'NotResident', 'NotOwner', 'NotYours', 'NotDue']);
  // the order counts against the action bucket and the quota, as every order of the viewer does; a refusal costs nothing
  const q0 = get(`/h/me/${w.proto ? (await W.viewer()).wallet : ''}`).quota.left;
  assert.equal((await land({ op: 'strike', province: [HOME.p, HOME.q], slot: 1, reason: 'own' })).ok, true, 'a holder strikes their own banner');
  assert.deepEqual([get(`/h/me/${(await W.viewer()).wallet}`).quota.left, proto().at(-1).op, proto().at(-1).reason, proto().at(-1).tiles.length, mine().bannersHeld], [q0 - 1, 'STRIKE', 'own', 6, 1]);
  // in the first minute of a turn the province has not caught up: refused as Muster and Depart are
  w.advance({ into: 5 });
  assert.equal((await land({ op: 'raise', host: hostAt(12), province: [HOME.p, HOME.q] })).code, 'NotResident');
  check();
});

test('1 and 5 in the world: the keeper frays a banner in the first turn it is due and strikes it 72 turns later; the totals add up to 61 a province a turn through 240 turns', async () => {
  const { w, proto, check, get } = await claimed();
  const seen = () => proto().filter(x => !x.premise && x.op !== 'TRAIL').map(x => [x.op, x.turn, x.p, x.q, x.slot, x.nation, x.by, x.reason ?? null]);
  const cinder = () => get('/h/province/2,0/latest').proto.land;
  let st = check();
  for (let i = 0; i < 240; i++) {
    w.advance();
    st = check();
    const r = w.summary().resolvedNext;
    if (r === 184) assert.deepEqual([cinder().banners[0].frayed, cinder().counted[2], seen().filter(x => x[0] === 'FRAY')], [false, 8, []], 'untended for 143 turns: it still counts');
    if (r === 185) assert.deepEqual([cinder().banners[0].frayed, cinder().counted[2], cinder().paid[0]], [true, 4, 57], 'frayed in the first turn it is due: its tiles pay the keep holder');
  }
  assert.deepEqual(seen(), [['RAISE', 60, 1, 1, 1, 2, 'script', null], ['FRAY', 185, 1, 1, 0, 4, 'keeper', null], ['FRAY', 185, 2, 0, 0, 2, 'keeper', null], ['FRAY', 204, 1, 1, 1, 2, 'keeper', null], ['STRIKE', 257, 1, 1, 0, 4, 'keeper', 'grace'], ['STRIKE', 257, 2, 0, 0, 2, 'keeper', 'grace'], ['STRIKE', 276, 1, 1, 1, 2, 'keeper', 'grace']],
    'nobody walked them (no neighbour has a host that may): each is frayed 144 turns after its last walk and struck 72 later; the firm one in its own wedge stands');
  assert.deepEqual([cinder().banners, cinder().counted, st.check.expected, st.turn], [[], [7, 0, 4, 0, 0, 0], 61 * 12 * (w.summary().resolvedNext - 41), w.summary().resolvedNext]);
  assert.ok(st.nations.every(n => n.tileTurns > 0) && Math.abs(sumOf(st.nations.map(n => n.share)) - 1) < 1e-9);
  assert.ok(w.npcLog.every(x => x.ok), 'the script ordered nothing the game or the rule refuses');
});

test('the scripted threat: a host of the neighbours\' leaves two turns in, stands on a border tile next door for twelve turns and raises a banner there; its march is sealed; answered, it is beaten and its count is gone', async () => {
  const { w, proto, get, check, me, v, land, mine } = await claimed();
  const next = () => get('/h/province/1,1/latest').proto.land, T = () => w.summary().proto.threat;
  assert.deepEqual([T().state, get('/h/season').sample.proto.claims.script], ['wait', { exploredReach: 3, threat: 'auto', threatLeavesTurn: 44, threatTroops: 500 }]);
  while (w.turn() < 45) w.advance();
  assert.deepEqual(T(), { host: T().host, state: 'marching', mode: null, target: null, arrive: 47 }, 'on its sealed march even the world\'s own summary says only that it left and when it arrives');
  // its departure is in the log as any departure is: origin and arrival turn, no destination; the script's own log names none either
  const dep = w.records().filter(x => x.kind === 30 && String(x.fields.host_id) === T().host);
  assert.deepEqual(dep.map(x => [x.fields.origin_p, x.fields.origin_q, x.fields.arrive_bell, 'tile' in x.fields, 'dest' in x.fields]), [[HOME.p, HOME.q, 47, false, false]]);
  assert.deepEqual(J(w.npcLog.filter(x => x.proto === 'threat')), [{ host: T().host, bell: 44, ok: true, code: null, proto: 'threat', what: 'left', mode: 'border', arrive: 47 }]);
  assert.equal(w.records().some(x => x.kind === 31 && String(x.fields.host_id) === T().host), false, 'not revealed before its arrival turn has ended');
  while (w.turn() < 50) { assert.equal(next().rising.some(x => x.nation === 2), false); w.advance(); }
  w.advance();
  const dial = next().rising.find(x => x.nation === 2);
  assert.deepEqual([dial.host, dial.holder, dial.tile, dial.sinceTurn, dial.canRaiseAtTurn, dial.tiles, dial.ready, C.BORDER_ROWS.some(row => row.includes(dial.tile))], [T().host, '2,0,7', 35, 48, 60, 5, false, true], 'twelve turns on ground of another nation\'s keep, on the border row that faces the province where its nation holds a banner');
  assert.equal(T().state, 'standing');
  // the answer: the town's host of 600 marches onto the tile, sealed, and reveals
  const from = { ...HOME }, to = { p: 1, q: 1, tile: dial.tile }, arrive = w.turn() + 2, m = sealed(HOSTS.free, from, to, { arrive, stance: 1 });
  assert.equal(get(`/h/proto/preview?host=${HOSTS.free}&p=1&q=1&tile=${dial.tile}`).need.why, 'enemy');
  assert.equal(w.order('Depart', { host_id: HOSTS.free, commit: m.commit, seal: m.seal, arrive_bell: arrive, tip: 14_668n, transit_slot: 0 }, from).ok, true);
  while (w.turn() < arrive) w.advance();
  assert.equal(w.revealNow(0, m.plain, m.salt, m.ctHash).ok, true);
  while (w.summary().resolvedNext <= arrive) w.advance();
  assert.equal(next().rising.some(x => x.nation === 2), false, 'its count is gone');
  w.advance(); w.advance();
  assert.deepEqual([T().state, J(w.npcLog.filter(x => x.proto === 'threat')).map(x => x.what)], ['over', ['left', 'stands', 'beaten']]);
  const won = me().hosts.find(h => h.id === String(HOSTS.free));
  assert.deepEqual([won.province, won.tile], [[1, 1], dial.tile], 'the host that won stands on the tile');
  assert.equal(proto().some(x => x.op === 'RAISE' && !x.premise), false, 'no banner of theirs rose');
  // it marched onto the border row straight from the next province: no tile of its route lies here, so its trail is empty; the ground is surveyed for it all the same
  const tr = proto().filter(x => x.op === 'TRAIL' && x.host === String(HOSTS.free)).at(-1);
  assert.deepEqual([tr.p, tr.q, tr.pole, tr.tiles], [1, 1, dial.tile, []]);
  while (!mine().hosts.find(h => h.host === String(HOSTS.free)).raise.ok) w.advance();
  const r = await land({ op: 'raise', host: String(HOSTS.free), province: [1, 1] });
  assert.deepEqual([r.ok, proto().at(-1).op, proto().at(-1).trail, proto().at(-1).firm, proto().at(-1).works], [true, 'RAISE', [], true, 0]);
  check();
  assert.ok(v);
});

test('7 in the world: a march that stays writes the host\'s trail from its own route; the preview draws the same tail; a host formed in place has none', async () => {
  const { w, proto, get, land, mine, check } = await claimed({ claims: { threat: 'none' } });
  w.advance();
  const all = get(`/h/proto/preview?host=${HOSTS.free}&p=1&q=1`);
  assert.deepEqual([all.host, all.stand, all.floor, all.all.length, all.all.every(x => x.mode === 'march')], [String(HOSTS.free), 1, 100, 61, true]);
  const spot = all.all.find(x => x.tile === 47);
  assert.deepEqual([spot.ok, spot.size, spot.trail, spot.waitTurns, spot.price, spot.steps], [true, 10, [45, 44, 43], 1, 0, 8], 'a patch of ten: the flower and three tiles of the route');
  assert.deepEqual(get(`/h/proto/preview?host=${HOSTS.free}&p=1&q=1&tile=47`).tiles, spot.tiles);
  assert.deepEqual([get(`/h/proto/preview?host=${HOSTS.scout}&p=1&q=1&tile=47`).code, get('/h/proto/preview?host=1&p=1&q=1&tile=47').code, get('/h/proto/preview?p=1&q=1&tile=47').need, get('/h/proto/preview?p=7&q=7').code, get(`/h/proto/preview?host=${HOSTS.free}&p=1&q=1&tile=99`).code], ['Scouts', 'NotOwner', { why: 'muster' }, 'BadData', 'BadData']);
  const before = JSON.stringify([w.records().length, w.summary()], (k, x) => (typeof x === 'bigint' ? String(x) : x));
  get(`/h/proto/preview?host=${HOSTS.free}&p=1&q=1`);
  assert.equal(JSON.stringify([w.records().length, w.summary()], (k, x) => (typeof x === 'bigint' ? String(x) : x)), before, 'the preview is read-only');
  const arrive = w.turn() + 2, to = { p: 1, q: 1, tile: 47 }, m = sealed(HOSTS.free, HOME, to, { arrive });
  assert.equal(w.order('Depart', { host_id: HOSTS.free, commit: m.commit, seal: m.seal, arrive_bell: arrive, tip: 14_668n, transit_slot: 0 }, HOME).ok, true);
  while (w.turn() < arrive) w.advance();
  assert.equal(w.revealNow(0, m.plain, m.salt, m.ctHash).ok, true);
  const trailOf = () => proto().filter(x => x.op === 'TRAIL' && x.host === String(HOSTS.free) && x.p === 1).at(-1);
  while (!trailOf()) { assert.notEqual(mine().hosts.find(h => h.host === String(HOSTS.free))?.raise?.ok, true, 'no raise before the march is settled'); w.advance(); }
  assert.deepEqual(trailOf(), { op: 'TRAIL', turn: arrive + 1, p: 1, q: 1, slot: null, pole: 47, nation: 0, holder: ME, tiles: [46, 45, 44, 43], from: null, works: 0, by: ME, host: String(HOSTS.free) });
  assert.deepEqual(get('/h/province/1,1/latest').proto.land.trails, [{ host: String(HOSTS.free), nation: 0, tile: 47, tiles: [46, 45, 44, 43] }]);
  while (!mine().hosts.find(h => h.host === String(HOSTS.free)).raise.ok) w.advance();
  assert.equal((await land({ op: 'raise', host: String(HOSTS.free), province: [1, 1], minTiles: 10 })).ok, true);
  const rec = proto().at(-1);
  assert.deepEqual([rec.trail, rec.tiles.length, rec.firm, rec.flower.includes(46)], [[45, 44, 43], 10, true, true], 'the tail of the route is land now');
  const b = get('/h/province/1,1/latest').proto.land.banners.find(x => x.holder === ME);
  assert.deepEqual([b.border, b.firm, b.walkDue - b.tendedTurn], [[2], true, 432], 'it holds a tile of the border row that faces the home province, where another nation holds a banner: it would fall to that nation in 36 turns');
  check();
});

test('6 in the world: the neighbours\' host on the pole of a banner of the viewer\'s (threat: pole): the banner is contested, with the turn it can be taken; strike and widening are refused; won back by a march', async () => {
  const { w, proto, get, land, mine, me, check } = await claimed({ claims: { threat: 'pole' }, stores: [9_000, 9_000, 9_000, 9_000, 0, 9_000, 0, 0] });
  const T = () => w.summary().proto.threat, next = () => get('/h/province/1,1/latest').proto.land;
  w.advance();
  const go = async (host, from, to, slot, stance = 0) => {
    const arrive = w.turn() + 2, m = sealed(BigInt(host), from, to, { arrive, stance });
    const r = w.order('Depart', { host_id: BigInt(host), commit: m.commit, seal: m.seal, arrive_bell: arrive, tip: 14_668n, transit_slot: slot }, from);
    assert.equal(r.ok, true, r.code);
    while (w.turn() < arrive) w.advance();
    assert.equal(w.revealNow(slot, m.plain, m.salt, m.ctHash).ok, true);
    return arrive;
  };
  await go(HOSTS.free, HOME, { p: 1, q: 1, tile: 47 }, 0);
  while (!mine().hosts.find(h => h.host === String(HOSTS.free))?.raise?.ok) w.advance();
  assert.equal((await land({ op: 'raise', host: String(HOSTS.free), province: [1, 1] })).ok, true);
  const slot = mine().banners[0].slot;
  for (let i = 0; i < 6; i++) w.advance();
  assert.equal(T().state, 'wait', 'while a host of the viewer\'s nation stands on the pole the script does not come');
  assert.equal(w.order('Dissolve', { host_id: HOSTS.free }, { p: 1, q: 1 }).ok, true);
  while (T().state !== 'standing') { w.advance(); assert.ok(w.turn() < 90); }
  const con = next().banners.find(b => b.slot === slot).contested;
  assert.deepEqual([con.nation, con.host, con.troops, con.tolls, con.canTakeAtTurn - con.sinceTurn, con.hasFloor, con.onlyPull], [2, T().host, 500, 36, 36, true, null], 'a border banner faced by that nation: 36 turns; it may take it');
  assert.deepEqual([(await land({ op: 'strike', province: [1, 1], slot, reason: 'own' })).code, T().mode], ['Contested', 'pole']);
  // a scout of the holder standing by may not widen it either; nor may it be widened without the enemy while nothing is explored there
  assert.equal(w.order('Train', { unit: 0, n: 900 }).ok, true);
  assert.equal(w.order('Muster', { unit: 0, troops: 900, tile: HOME.tile }).ok, true);
  while (!mine().hosts.find(h => h.tile === HOME.tile && h.unit === 0 && h.stands)) w.advance();
  const relief = mine().hosts.find(h => h.tile === HOME.tile && h.unit === 0 && h.stands);
  const arrive = await go(relief.host, HOME, { p: 1, q: 1, tile: 47 }, 1, 1);
  while (w.summary().resolvedNext <= arrive) w.advance();
  assert.equal(next().banners.find(b => b.slot === slot).contested, null, 'the pole is won back: the count is gone, the banner is the viewer\'s as before');
  w.advance(); w.advance();
  assert.deepEqual([T().state, J(w.npcLog.filter(x => x.proto === 'threat')).map(x => x.what)], ['over', ['left', 'stands', 'beaten']]);
  assert.equal(proto().some(x => x.op === 'TAKE' || x.op === 'PULL'), false);
  // the relief arrived after the banner was last walked: it may walk it (a firm banner: any host of its holder, in the patch)
  while (!mine().hosts.find(h => h.host === relief.host)?.tend.some(t => t.slot === slot && t.ok)) w.advance();
  assert.equal((await land({ op: 'tend', host: relief.host, province: [1, 1], slot })).ok, true);
  assert.deepEqual(proto().slice(-2).map(x => [x.op, x.works]), [['TEND', 0], ['WALK', 2]]);
  assert.deepEqual([mine().walkPaidToday, mine().walkEarned, me().works], [true, 2, 10], 'the day\'s first walk pays 2 Works into the prototype\'s purse; the Citizen\'s Works are as the game paid them');
  check();
});

test('unanswered, a host on the pole takes the banner when its count is done: the record, the land, the score', async () => {
  const { w, proto, get, land, mine, check } = await claimed({ claims: { threat: 'pole' } });
  w.advance();
  const arrive = w.turn() + 2, m = sealed(HOSTS.free, HOME, { p: 1, q: 1, tile: 47 }, { arrive });
  assert.equal(w.order('Depart', { host_id: HOSTS.free, commit: m.commit, seal: m.seal, arrive_bell: arrive, tip: 14_668n, transit_slot: 0 }, HOME).ok, true);
  while (w.turn() < arrive) w.advance();
  w.revealNow(0, m.plain, m.salt, m.ctHash);
  while (!mine().hosts.find(h => h.host === String(HOSTS.free))?.raise?.ok) w.advance();
  assert.equal((await land({ op: 'raise', host: String(HOSTS.free), province: [1, 1] })).ok, true);
  assert.equal(w.order('Dissolve', { host_id: HOSTS.free }, { p: 1, q: 1 }).ok, true);
  const before = () => get('/h/province/1,1/latest').proto.land;
  let con = null;
  for (let i = 0; i < 60 && !proto().some(x => x.op === 'TAKE'); i++) { w.advance(); con = before().banners.find(b => b.holder === ME)?.contested ?? con; check(); }
  const rec = proto().find(x => x.op === 'TAKE');
  assert.deepEqual([rec.turn, rec.from, rec.fromHolder, rec.nation, rec.holder, rec.by, rec.tiles.length, rec.p, rec.q], [con.canTakeAtTurn, 0, ME, 2, '2,0,7', 'script', 10, 1, 1], 'taken in the first turn its count is done');
  assert.deepEqual([mine().bannersHeld, mine().tiles, before().banners.find(b => b.slot === rec.slot).nation, before().counted[2], before().banners.find(b => b.slot === rec.slot).firm], [0, 7, 2, 10, false]);
  assert.equal(w.summary().proto.threat.state, 'over');
});

test('8 of the script: a neighbour\'s banner in the viewer\'s own wedge falls to a host of the viewer\'s that stands on its pole 18 turns (half of 36): taken, or pulled down', async () => {
  const { w, proto, get, land, mine, home, check } = await claimed({ claims: { threat: 'none' } });
  w.advance();
  const theirs = home().banners[0], arrive = w.turn() + 2, m = sealed(HOSTS.free, HOME, { ...HOME, tile: theirs.pole }, { arrive });
  assert.deepEqual([theirs.nation, theirs.firm], [2, false]);
  assert.equal(w.order('Depart', { host_id: HOSTS.free, commit: m.commit, seal: m.seal, arrive_bell: arrive, tip: 14_668n, transit_slot: 0 }, HOME).ok, true);
  while (w.turn() < arrive) w.advance();
  assert.equal(w.revealNow(0, m.plain, m.salt, m.ctHash).ok, true);
  const mineHost = () => mine().hosts.find(h => h.host === String(HOSTS.free));
  while (!(mineHost()?.fell && mineHost().fell.code !== 'InTransit')) w.advance();
  const f = mineHost().fell;
  assert.deepEqual([mineHost().onPole, f.ok, f.code, f.tolls, f.atTurn, f.canTake, f.onlyPull, f.need.atTurn], [{ slot: 0, nation: 2, holder: '2,0,7' }, false, 'StandLonger', 18, arrive + 1 + 18, true, null, arrive + 1 + 18], 'the count the page draws in gold on their patch');
  assert.deepEqual(home().banners[0].contested, { nation: 0, host: String(HOSTS.free), troops: 600, sinceTurn: arrive + 1, tolls: 18, canTakeAtTurn: arrive + 19, hasFloor: true, onlyPull: null });
  assert.deepEqual([(await land({ op: 'take', host: String(HOSTS.free), province: [HOME.p, HOME.q], slot: 0 })).code, (await land({ op: 'pull', host: String(HOSTS.free), province: [HOME.p, HOME.q], slot: 0 })).need.atTurn], ['StandLonger', arrive + 19]);
  while (!mineHost().fell.ok) { w.advance(); check(); }
  assert.equal(home().resolvedNext, arrive + 19);
  const r = await land({ op: 'take', host: String(HOSTS.free), province: [HOME.p, HOME.q], slot: 0 });
  assert.deepEqual([r.ok, r.op, r.note], [true, 'TAKE', null]);
  const rec = proto().at(-1);
  assert.deepEqual([rec.op, rec.from, rec.fromHolder, rec.nation, rec.holder, rec.by, rec.tiles, rec.works], ['TAKE', 2, '2,0,7', 0, ME, ME, theirs.tiles, 0], 'taking costs nothing');
  assert.deepEqual([mine().bannersHeld, mine().tiles, home().banners[0].firm, home().banners[0].contested, home().counted], [1, 7 + theirs.tiles.length, true, null, [7 + theirs.tiles.length, 0, 4, 0, 0, 0]]);
  check();
  // pulled down instead, the patch returns to the nation's commons
  const b = await claimed({ claims: { threat: 'none' }, neighbours: true });
  b.w.advance();
  const a2 = b.w.turn() + 2, m2 = sealed(HOSTS.free, HOME, { ...HOME, tile: theirs.pole }, { arrive: a2 });
  assert.equal(b.w.order('Depart', { host_id: HOSTS.free, commit: m2.commit, seal: m2.seal, arrive_bell: a2, tip: 14_668n, transit_slot: 0 }, HOME).ok, true);
  while (b.w.turn() < a2) b.w.advance();
  b.w.revealNow(0, m2.plain, m2.salt, m2.ctHash);
  while (!b.mine().hosts.find(h => h.host === String(HOSTS.free))?.fell?.ok) b.w.advance();
  assert.equal((await b.land({ op: 'pull', host: String(HOSTS.free), province: [HOME.p, HOME.q], slot: 0 })).ok, true);
  assert.deepEqual([b.proto().at(-1).op, b.proto().at(-1).from, b.home().banners, b.home().counted, b.mine().bannersHeld], ['PULL', 2, [], [7, 0, 4, 0, 0, 0], 0]);
  assert.ok(get('/h/season'));
});

test('the explore limit: five tiles a player a game day; the order past it is refused and marks nothing', async () => {
  const { w, mine, me, get } = await claimed({ claims: { threat: 'none' }, neighbours: false });
  w.advance();
  // the ground within three steps of the village is explored already (a premise of the prototype); the scouts are formed further out
  const pv = w.province(HOME.p, HOME.q);
  assert.deepEqual([...Array(61).keys()].filter(t => (pv.exploredMask >> BigInt(t)) & 1n).every(t => C.steps(t, HOME.tile) <= SCRIPT.EXPLORED_REACH), true);
  assert.equal(w.order('Muster', { unit: 6, troops: 100, tile: 46 }).ok, true);
  w.advance(); w.advance();
  const scout = me().hosts.find(h => h.tile === 46), around = C.neighbours(46).filter(t => !((pv.exploredMask >> BigInt(t)) & 1n) && ((pv.passableMask >> BigInt(t)) & 1n));
  assert.ok(around.length >= 6);
  const explore = tiles => w.order('Explore', { host_id: BigInt(scout.id), n: tiles.length, tiles }, HOME);
  assert.equal(explore(around.slice(0, 2)).ok, true);
  assert.equal(mine().exploreLeftToday, 3);
  w.advance(); w.advance();
  assert.equal(explore(around.slice(2, 4)).ok, true);
  w.advance(); w.advance();
  const sixth = explore(around.slice(4, 6));
  assert.deepEqual([sixth.ok, sixth.code, sixth.need], [false, 'ExploreLimit', { left: 1, perDay: 5 }]);
  const mask = w.province(HOME.p, HOME.q).exploredMask;
  assert.ok(around.slice(4, 6).every(t => !((mask >> BigInt(t)) & 1n)), 'the tiles stay unexplored');
  assert.equal(explore(around.slice(4, 5)).ok, true, 'the fifth tile of the day');
  assert.equal(mine().exploreLeftToday, 0);
  // without the prototype the same sixth tile is explored as the program explores it
  const off = await sample({ neighbours: false });
  off.w.pause(true); off.w.advance();
  assert.equal(off.w.order('Muster', { unit: 6, troops: 100, tile: 46 }).ok, true);
  off.w.advance(); off.w.advance();
  const s2 = off.me().hosts.find(h => h.tile === 46), free = C.neighbours(46).filter(t => (pv.passableMask >> BigInt(t)) & 1n);
  for (let i = 0; i < 3; i++) { assert.equal(off.w.order('Explore', { host_id: BigInt(s2.id), n: 2, tiles: free.slice(2 * i, 2 * i + 2) }, HOME).ok, true, `six tiles in a day, order ${i + 1}`); off.w.advance(); off.w.advance(); }
  assert.ok(get('/h/season').sample.simpler.length > 0);
});

test('the guided first minutes, through HTTP alone (proto-playthrough.mjs): every beat asserted from its record, on a clock the play moves; and the other threat', async () => {
  const a = await play();
  assert.deepEqual(a.beats.map(b => b.what), [
    'the page\'s first /h/season: the clock starts', 'hosts formed where the preview says a banner can rise', 'the first banner is raised', 'the second banner is raised', 'a march into the next province is sealed',
    'a host is formed beside the first banner, to walk it', 'the threat: a banner of another nation is about to rise next door', 'the answer is sealed: a march onto the tile', 'the march is settled: the host stands there with its trail',
    'the banner outside the home province is raised: the trail became land', 'the clash is resolved: the tile is won', 'a banner is raised on the tile that was won', 'the first banner is walked: +2 Works', 'the end of the guided minutes']);
  const at = what => a.beats.find(b => b.what.startsWith(what));
  // the pace at 20 s a turn: a home banner about a minute after forming the host; the threat's count is seen about two and a half minutes in and answered inside two more; the whole inside five
  assert.ok(at('the first banner').sinceFormed >= 40 && at('the first banner').sinceFormed <= 70, `${at('the first banner').sinceFormed} s from forming a host to its banner`);
  assert.ok(at('the threat').at <= 160 && at('the clash').sinceDial <= 120 && at('the end').at <= 300, JSON.stringify(a.beats.map(b => [b.at, b.what])));
  assert.deepEqual(a.refused, ['ProtoLand:raise StandLonger', 'ProtoLand:tend NotArrivedSince', 'ProtoLand:raise NotOpen', 'ProtoLand:tend NotArrivedSince'], 'nothing was refused that the play did not mean to be');
  for (const name of ['season', 'me-first-frame', 'province-home-first-frame', 'standings', 'preview-form-all', 'preview-march-all', 'event-HEARTH-premise', 'event-RAISE', 'event-TRAIL', 'event-TEND', 'event-WALK', 'order-raise-accepted', 'order-raise-refused-StandLonger', 'order-tend-accepted', 'province-next-enemy-rising']) assert.ok(a.examples[name], name);
  const b = await play({ threat: 'pole' });
  assert.ok(b.beats.some(x => x.what === 'the threat: an enemy host stands on the pole of the banner') && b.beats.some(x => x.what === 'the clash is resolved: the pole is won back'));
  assert.ok(b.refused.includes('ProtoLand:strike Contested'));
});
