// The banner rule's PROTOTYPE on the board (PROTOTYPE-SPEC.md sections 1, 6 and 7; the lead's amendments A to C).
// "Standing Ground" is a DESIGN: it is not in the program, the rules crate or the ABI, and nothing of it is sent to a
// chain. The sample world serves its records only when it is started with `claims=1`; the board reads them through
// one pure function (permutation-server/web/frontier/proto/board-model.mjs) and draws them (map/protoboard.mjs,
// map/protoland.mjs). What these tests hold:
//   * with `sample.proto.claims` absent the model is null and the map draws exactly what it drew before;
//   * the model keeps no number of the rule: every count is the difference of two turns of a record;
//   * every moment starts from a difference between two models (records), never from an order's answer;
//   * the label of section 1 is on the page whenever the map is given a model;
//   * counts are said in turns (amendment B), the words 領土 / territory are nowhere in what the board says.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CLAIM, bannerOfHex, claimKind, dialOf, floodOrder, protoBoardModel, protoEvent, protoLandAt } from '../../permutation-server/web/frontier/proto/board-model.mjs';
import { protoFeedOf } from '../../permutation-server/web/frontier/proto/board-feed.mjs';
import { protoModelOf } from '../../permutation-server/web/frontier/proto/board-mount.mjs';
import { ProtoBoard, POLE_AT } from '../../permutation-server/web/frontier/map/protoboard.mjs';
import * as PB from '../../permutation-server/web/frontier/map/protoboard.mjs';
import * as OWN from '../../permutation-server/web/frontier/map/ownland.mjs';
import * as HM from '../../permutation-server/web/frontier/map/hostmarks.mjs';
import * as PL from '../../permutation-server/web/frontier/map/protoland.mjs';
import { PROTO_LEGEND, PROTO_WORDS, aboutTime, protoLegendLine, protoTag, refusalGlyph, refusalWords, tagged } from '../../permutation-server/web/frontier/map/protowords.mjs';
import { renderProtoLegend, renderSurveyHelp, setProtoLegend } from '../../permutation-server/web/frontier/map/legend.mjs';
import { protoLabelText } from '../../permutation-server/web/frontier/map/protochip.mjs';
import { FrontierMap } from '../../permutation-server/web/frontier/map/fmap.mjs';
import { SAMPLES } from '../../permutation-server/web/frontier/fx/demo.mjs';
import { bus } from '../../permutation-server/web/frontier/fx/bus.mjs';
import { clock } from '../../permutation-server/web/frontier/fx/clock.mjs';
import { hostId } from '../../permutation-server/web/frontier/faddr.mjs';
import { hexDistance, locate, tileHex } from '../../permutation-server/web/frontier/fgeo.mjs';
import { EN, setLang } from '../../permutation-server/web/lang.mjs';

const WEB = new URL('../../permutation-server/web/frontier/', import.meta.url);
const read = f => readFileSync(new URL(f, WEB), 'utf8');
const HOME = { p: 2, q: 0, site: 3, gen: 1, tile: 30 };
const hid = seq => String(hostId({ ...HOME, seq }));
const RING = [[0, 0], [1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
/** The tile index, in the home province, of the hex `(dq, dr)` away from tile `from` (null outside the province). */
const off = (from, dq, dr) => { const h = tileHex(HOME.p, HOME.q, from); const l = locate(h.q + dq, h.r + dr); return l.p === HOME.p && l.q === HOME.q ? l.idx : null; };
const flower = pole => RING.map(([a, b]) => off(pole, a, b)).filter(i => i !== null);
const LABEL = { ja: '試作ルール：旗（設計のみ・プログラム未実装）', en: 'Prototype rule: banners (design only, not in the program)' };
const SAMPLE = { world: 'sample', turnSecs: 20, proto: { claims: { rule: 'standing-ground', version: 'design-2026-10-10-r2', label: LABEL, scoreNote: { ja: 'この得点は試作の計算です。チェーンの記録ではありません。', en: 'This score is computed by the prototype. It is not a chain record.' }, numbers: { FALL_LOOSE: 36 }, reduced: ['no keeps'] } } };
const POLE = off(HOME.tile, 3, -1), TAIL = [off(HOME.tile, 2, -2)].filter(i => i !== null), THEIRS = off(HOME.tile, -3, 1);
/** A province's `proto.land` in the shape of PROTOTYPE-SPEC section 6: the viewer's village land, one banner of the viewer's (with a tail), one of another nation. */
function land({ turn = 50, mine = true, theirs = true, contested = null, trails = [], rising = [], frayed = false, walkDue = 400, nation2 = 2 } = {}) {
  const claim = new Array(61).fill(CLAIM.OPEN);
  for (const i of flower(HOME.tile)) claim[i] = HOME.site;
  const banners = [];
  if (mine) { const tiles = [...flower(POLE), ...TAIL]; for (const i of tiles) claim[i] = CLAIM.BANNER0 + 0; banners.push({ slot: 0, pole: POLE, nation: 0, holder: 'W', tiles, raisedTurn: 44, tendedTurn: 44, firm: true, border: [], frayed, walkDue, strikeAt: walkDue + 72, dressedToday: false, elbowLockedUntil: null, contested }); }
  if (theirs) { const tiles = flower(THEIRS); for (const i of tiles) claim[i] = CLAIM.BANNER0 + 5; banners.push({ slot: 5, pole: THEIRS, nation: nation2, holder: 'cinder-town', tiles, raisedTurn: 40, tendedTurn: 40, firm: false, border: [], frayed: false, walkDue: 184, strikeAt: 256, dressedToday: false, elbowLockedUntil: null, contested: null }); }
  const counted = [0, 0, 0, 0, 0, 0];
  claim.forEach(v => { const k = claimKind(v); if (k.kind === 'village') counted[0]++; else if (k.kind === 'banner') counted[k.slot === 0 ? 0 : nation2]++; });
  return { resolvedNext: turn, claim, banners, trails, counted, paid: counted, holderNation: 0, rising };
}
const VIEWER = { nation: 0, villages: [{ p: HOME.p, q: HOME.q, site: HOME.site, tile: HOME.tile }], ownsHost: id => [7, 8].map(hid).includes(String(id)), hostAt: id => (String(id) === hid(7) ? { p: HOME.p, q: HOME.q, tile: POLE } : null) };
const model = (l = land(), more = {}) => protoBoardModel({ sample: SAMPLE, provinces: [{ p: HOME.p, q: HOME.q, land: l }], me: l.banners.some(b => b.slot === 0 && b.nation === 0 && b.holder === 'W') ? { banners: [{ p: HOME.p, q: HOME.q, slot: 0 }], cap: 5, perProvince: 2 } : { banners: [], cap: 5, perProvince: 2 }, viewer: VIEWER, siteTiles: () => [HOME.tile], ...more });
/** A context that records every call and every property set (a painter's whole trace), and paints nothing. */
function recorder() {
  const log = [];
  const show = a => (a && typeof a === 'object' ? (Array.isArray(a) ? `[${a.map(show).join(',')}]` : a.constructor?.name === 'Object' ? '{}' : `<${a.constructor?.name ?? 'o'}>`) : typeof a === 'number' ? String(Math.round(a * 100) / 100) : String(a));
  const ctx = new Proxy({ canvas: {} }, {
    get: (t, k) => (k === 'log' ? log : k in t ? t[k] : /Gradient$|createPattern/.test(String(k)) ? () => ({ addColorStop() {} }) : k === 'measureText' ? s => ({ width: String(s).length * 7 }) : (...a) => { log.push(`${String(k)}(${a.map(show).join(',')})`); }),
    set: (t, k, v) => { t[k] = v; log.push(`${String(k)}=${show(v)}`); return true; } });
  return ctx;
}
/** node has no Path2D: a stand-in for the length of this file, so the painters run to their strokes and fills. */
const hadPath = globalThis.Path2D;
globalThis.Path2D = class Path2D { moveTo() {} lineTo() {} closePath() {} rect() {} arc() {} ellipse() {} addPath() {} };
test.after(() => { if (hadPath) globalThis.Path2D = hadPath; else delete globalThis.Path2D; setLang('ja'); });

test('the switch: with sample.proto.claims absent the model is null; with it, the model carries the record\'s own label and nothing invented', () => {
  assert.equal(protoBoardModel({}), null);
  assert.equal(protoBoardModel({ sample: { world: 'sample', turnSecs: 20 }, provinces: [{ p: 2, q: 0, land: land() }] }), null, 'a sample world without the prototype');
  assert.equal(protoBoardModel({ sample: { proto: {} }, provinces: [{ p: 2, q: 0, land: land() }] }), null);
  const M = model();
  assert.equal(M.on, true); assert.deepEqual(M.label, LABEL); assert.equal(M.turnSecs, 20); assert.equal(M.rule, 'standing-ground');
  assert.equal(M.numbers.FALL_LOOSE, 36, 'the rule\'s table is the record\'s, passed through by name');
  // the page's own state without the switch gives the map nothing
  assert.equal(protoModelOf({ sample: null, holdings: [] }, protoFeedOf()), null);
  assert.equal(protoModelOf({ sample: { world: 'sample' }, holdings: [] }, protoFeedOf()), null);
});

test('the model keeps no number of the rule: its source names none of the table\'s values, and a count is two turns of a record', () => {
  const code = read('proto/board-model.mjs').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  // (the values of PROTOTYPE-SPEC section 3: stand, fall, floor, patch, walk, cap, ceiling, price)
  for (const n of [24, 36, 72, 100, 144, 432, 500]) assert.ok(!new RegExp(`(^|[^\\w.])${n}([^\\w]|$)`).test(code), `no ${n} in proto/board-model.mjs`);
  assert.deepEqual(dialOf(41, 77, 50), { since: 41, at: 77, total: 36, done: 9, left: 27, share: 0.25, ready: false });
  assert.equal(dialOf(41, 77, 90).left, 0, 'never negative'); assert.equal(dialOf(41, 77, 90).share, 1); assert.equal(dialOf(41, 77, 90).ready, true);
  assert.equal(dialOf(41, 77, 30).done, 0, 'never before its start');
  assert.equal(dialOf(null, 77, 50).left, 27, 'without a start it still counts down'); assert.equal(dialOf(41, null, 50), null);
  // a dial never runs backwards while the settled turn goes on
  let last = -1; for (let r = 40; r < 80; r++) { const d = dialOf(41, 77, r); assert.ok(d.done >= last); last = d.done; }
});

test('the records of section 6 as the board reads them: village land, banner land, the union that the gold line closes round, the commons, trails, claims in progress', () => {
  const tail3 = [off(HOME.tile, 1, 0), off(POLE, -1, 0)].filter(i => i !== null);
  const M = model(land({ trails: [{ host: hid(7), nation: 0, tiles: tail3 }, { host: 'other', nation: 2, tiles: [off(THEIRS, 1, 0)] }], rising: [{ host: hid(8), nation: 0, tile: off(HOME.tile, 0, 3), sinceTurn: 49, canRaiseAtTurn: 51, tiles: 7 }, { host: 'cinder-host', nation: 2, tile: off(HOME.tile, -1, 3), sinceTurn: 44, canRaiseAtTurn: 56, tiles: 6 }] }));
  const mine = M.banners.find(b => b.mine), theirs = M.banners.find(b => !b.mine);
  assert.equal(M.banners.length, 2);
  assert.equal(mine.key, '2,0,0'); assert.equal(mine.firm, true); assert.equal(mine.tiles.length, flower(POLE).length + TAIL.length);
  assert.deepEqual({ q: mine.pole.q, r: mine.pole.r }, tileHex(2, 0, POLE), 'tiles are absolute hexes');
  assert.equal(mine.walk.every, 400 - 44, 'how often it must be walked: two turns of its own record');
  assert.equal(theirs.nation, 2); assert.equal(theirs.mate, false); assert.equal(theirs.mine, false);
  // the viewer's land: the village's tiles and the banner's, one list (the gold line closes round their union)
  assert.equal(M.mine.villageTiles, 7); assert.equal(M.mine.bannerTiles, mine.tiles.length); assert.equal(M.mine.total, 7 + mine.tiles.length); assert.equal(M.mine.banners, 1);
  assert.equal(M.mine.tiles.filter(t => t.village).length, 7);
  assert.equal(M.villages.length, 1); assert.equal(M.villages[0].mine, true);
  // the commons: every open tile of the province, in the holder nation's name
  const claimed = 7 + mine.tiles.length + theirs.tiles.length;
  assert.equal(M.commons.length, 1); assert.equal(M.commons[0].ours, true); assert.equal(M.commons[0].tiles.length, 61 - claimed);
  // a trail is its host's own, in the order it was walked (the step beside the host last)
  const tr = M.trails.find(t => t.mine), at = tileHex(2, 0, POLE);
  assert.equal(tr.host, hid(7));
  assert.ok(hexDistance(tr.tiles[0].q, tr.tiles[0].r, at.q, at.r) >= hexDistance(tr.tiles.at(-1).q, tr.tiles.at(-1).r, at.q, at.r));
  assert.equal(M.trails.find(t => !t.mine).nation, 2);
  // claims in progress: the viewer's own with its dial, another nation's on the viewer's nation's ground
  const up = M.rising.find(r => r.mine), ghost = M.rising.find(r => !r.mine);
  assert.deepEqual([up.dial.left, up.dial.total, up.n], [1, 2, 7]);
  assert.equal(ghost.enemyHere, true); assert.equal(ghost.dial.left, 6);
  // where a banner could rise, the cheap form: open ground of a province the viewer's nation holds, while its own record leaves room
  assert.ok(M.canRise.length > 0 && M.canRise.every(t => !bannerOfHex(M, t.q, t.r)));
  assert.equal(model(land(), { me: { banners: [{ p: 2, q: 0, slot: 0 }, { p: 2, q: 0, slot: 1 }], cap: 5, perProvince: 2 } }).canRise.length, 0, 'two banners here already (the viewer\'s own record says how many a province takes)');
  assert.equal(model(land(), { me: { banners: [{ p: 2, q: 0, slot: 0 }], cap: 1, perProvince: 2 } }).canRise.length, 0, 'the cap is reached');
  // from afar: who holds how many of the province's tiles (the holder has the rest)
  const pv = M.provinces[0];
  assert.equal(pv.shares.reduce((a, s) => a + s.tiles, 0), 61); assert.equal(pv.shares[0].nation, 0); assert.equal(pv.shares.find(s => s.nation === 2).tiles, theirs.tiles.length);
  // what a tile is, for a tip
  const ph = tileHex(2, 0, POLE), vh = tileHex(2, 0, HOME.tile), oh = M.commons[0].tiles[0];
  assert.equal(protoLandAt(M, ph.q, ph.r).kind, 'banner'); assert.equal(protoLandAt(M, vh.q, vh.r).kind, 'village'); assert.equal(protoLandAt(M, oh.q, oh.r).kind, 'commons');
  assert.equal(protoLandAt(null, 0, 0), null);
  // another's land is drawn only where the viewer has seen it; the viewer's own always
  const blind = model(land(), { levelAt: () => 1 });
  assert.equal(blind.banners.length, 1); assert.equal(blind.banners[0].mine, true); assert.equal(blind.commons.length, 0);
});

test('a threat and a taking are the same record read from two seats; a banner of a nation-mate is told from the viewer\'s own', () => {
  const threat = model(land({ contested: { nation: 2, host: 'cinder-host', sinceTurn: 41, canTakeAtTurn: 77 } })).banners.find(b => b.mine).contested;
  assert.deepEqual([threat.nation, threat.byViewer, threat.dial.left, threat.dial.total], [2, false, 27, 36]);
  // the viewer's host on another nation's pole
  const l = land(); l.banners[1].contested = { nation: 0, host: hid(7), sinceTurn: 38, canTakeAtTurn: 62 };
  assert.equal(model(l).banners.find(b => !b.mine).contested.byViewer, true);
  // a banner of the viewer's nation held by another player
  const mate = model(land({ nation2: 0 })).banners.find(b => !b.mine);
  assert.equal(mate.mate, true);
  // mine by the holder key too (a page without the viewer's own record)
  const byKey = protoBoardModel({ sample: SAMPLE, provinces: [{ p: 2, q: 0, land: land() }], me: null, viewer: { ...VIEWER, holders: ['W'] } });
  assert.equal(byKey.banners.filter(b => b.mine).length, 1);
});

test('a PROTO_LAND record is read whatever the page shape of the log; anything else is not a record of the prototype', () => {
  const e = protoEvent({ seq: '812', kind: 'PROTO_LAND', proto: true, op: 'raise', turn: 50, p: 2, q: 0, slot: 0, pole: POLE, nation: 0, holder: 'W', tiles: [1, 2, 3], from: null, works: 0, by: 'W' });
  assert.deepEqual([e.seq, e.op, e.p, e.q, e.slot, e.pole, e.tiles.length], [812, 'RAISE', 2, 0, 0, POLE, 3]);
  assert.equal(protoEvent({ seq: 5, proto: true, kind: 'PROTO_LAND', fields: { op: 'TAKE', p: 2, q: 0, slot: 1, nation: 2 } }).op, 'TAKE');
  assert.equal(protoEvent({ seq: 5, record: { name: 'PROTO_LAND', op: 'PULL', p: 2, q: 0, slot: 1 } }).op, 'PULL');
  assert.equal(protoEvent({ seq: 5, body_b64: 'AAAA' }), null, 'a chain-shaped record is the basic game\'s');
  assert.equal(protoEvent({ kind: 'PROTO_LAND', proto: true, op: 'RAISE' }), null, 'no province');
  assert.equal(protoEvent(null), null);
});

test('the flood runs from the far end of the tail, through the pole, then round it; the timelines only go forward', () => {
  const M = model(), b = M.banners.find(x => x.mine), order = floodOrder(b.tiles, b.pole);
  assert.equal(order.length, b.tiles.length);
  const d = t => hexDistance(t.q, t.r, b.pole.q, b.pole.r), ds = order.map(d), at = ds.indexOf(0);
  assert.ok(ds.slice(0, at).every(x => x > 1), 'the tail first'); assert.ok(ds.slice(at + 1).every(x => x === 1), 'the flower after the pole');
  for (let i = 1; i < at; i++) assert.ok(ds[i] <= ds[i - 1], 'the far end first');
  // a raise (rewritten 2026-10-11 with the timeline: the first cut took the waiting colour away at the record and paid off
  // a second or two later). Nothing is cleared and it is fast: the tail's tiles come one every `tail` ms from the far
  // end, the pole lands as the colour reaches its tile, the tiles round it come together, each over-bright and
  // settling; the gold line is drawn from `lineAt`; the number leaves the pole at its landing; the chip at `chipAt`
  const n = 10, tail = 3, T = PL.RAISE;
  assert.equal(PL.raiseTileAt(0, n, tail), 0, 'with a whole tail the flood begins in the frame of the record');
  assert.deepEqual([0, 1, 2, 3, 4, 9].map(i => PL.raiseTileAt(i, n, tail)), [0, 60, 120, 180, 240, 240], 'the tail one tile every 60 ms, the pole, the six round it together');
  assert.ok(PL.raiseTileAt(n - 1, n, tail) + T.tileIn + 120 <= 450, 'the whole flood in under 450 ms');
  assert.equal(PL.raiseTileAt(0, 7, 0), T.poleAt, 'without a tail the pole\'s own tile is the first, as the pole lands');
  { const R = PL.raiseAt(0, n, tail); assert.equal(R.pole.shown, true); assert.equal(R.pole.lift, 1); assert.equal(R.tile(n - 1).in, 0); assert.equal(R.closed, false); assert.equal(R.line, null); assert.equal(R.number, null); assert.equal(R.chip, null); }
  assert.equal(PL.raiseAt(T.poleAt, n, tail).pole.lift, 0, 'the pole is down at 180 ms');
  assert.ok(PL.raiseAt(T.poleAt / 2, n, tail).pole.lift > 0.5, 'and it falls faster as it goes (ease-in)');
  assert.equal(PL.raiseAt(T.poleAt, n, tail).dust, 0); assert.equal(PL.raiseAt(T.poleAt, n, tail).number, 0); assert.ok(PL.raiseAt(T.poleAt + T.dust, n, tail).dust === null);
  assert.ok(Math.abs(PL.raiseAt(T.poleAt, n, tail).pole.pop - T.popFrom) < 1e-9); assert.ok(Math.abs(PL.raiseAt(T.poleAt + T.pop, n, tail).pole.pop - 1) < 1e-9, 'the cloth lands large and settles');
  { const a = PL.raiseAt(1, n, tail).tile(0), b = PL.raiseAt(T.settle + 1, n, tail).tile(0); assert.ok(a.hot > 0.95 && a.in > 0, 'a tile arrives over-bright'); assert.equal(b.hot, 0); assert.equal(b.in, 1); }
  for (let i = 1; i <= tail; i++) assert.ok(PL.raiseAt(PL.raiseTileAt(i, n, tail) - 1, n, tail).tile(i - 1).in > PL.raiseAt(PL.raiseTileAt(i, n, tail) - 1, n, tail).tile(i).in, 'tile by tile along the tail');
  assert.equal(PL.raiseAt(T.lineAt - 1, n, tail).line, null); assert.equal(PL.raiseAt(T.lineAt, n, tail).line, 0); assert.ok(PL.raiseAt(T.lineAt + T.line - 1, n, tail).line > 0.99);
  assert.equal(PL.raiseCloseAt(n), T.lineAt + T.line);
  assert.equal(PL.raiseAt(PL.raiseCloseAt(n) - 1, n, tail).closed, false); assert.equal(PL.raiseAt(PL.raiseCloseAt(n), n, tail).closed, true);
  assert.equal(PL.raiseAt(T.chipAt - 1, n, tail).chip, null); assert.equal(PL.raiseAt(T.chipAt, n, tail).chip, 0); assert.ok(T.chipAt <= 450);
  assert.equal(PL.raiseAt(PL.raiseMs(n), n, tail).done, true);
  // a banner widened by a tile: the tile at once, no pole, no number
  { const R = PL.raiseAt(1, 1, 0, { dress: true }); assert.ok(R.tile(0).in > 0); assert.equal(R.pole.shown, false); assert.equal(R.number, null); assert.equal(R.dust, null); assert.equal(PL.raiseAt(PL.raiseCloseAt(1, { dress: true }), 1, 0, { dress: true }).closed, true); }
  // a trail: 120 ms a tile
  assert.equal(PL.TRAIL.tile, 120); assert.equal(PL.trailAt(0, 0), 0); assert.equal(PL.trailAt(119, 1), 0); assert.ok(PL.trailAt(130, 1) > 0); assert.equal(PL.trailAt(5000, 3), 1);
  // a loss (rewritten 2026-10-11: it was a quiet recolouring). Taken: a flash and a shake in the frame of the record, the
  // gold line breaks up in 400 ms, the taker's colour runs from the pole in 350 ms, the cloth is swapped in 200 ms, the
  // words come with the flash
  { const K = PL.LOSS.take, a = PL.lossAt(0, 7, 'taken');
    assert.equal(a.flash, 1); assert.equal(a.words, 0); assert.equal(a.line, 0); assert.equal(a.tile(0), 1); assert.equal(a.cloth.old, 1);
    assert.equal(PL.lossAt(K.flash, 7, 'taken').flash, 0); assert.ok(Math.abs(PL.lossAt(50, 7, 'taken').shake) > 0.5 && Math.abs(PL.lossAt(50, 7, 'taken').shake) <= K.shakePx); assert.equal(PL.lossAt(K.shake, 7, 'taken').shake, 0);
    assert.ok(PL.lossAt(120, 7, 'taken').tile(0) < PL.lossAt(120, 7, 'taken').tile(6), 'from the pole outward'); assert.equal(PL.lossAt(K.flood, 7, 'taken').tile(6), 0);
    assert.equal(PL.lossAt(K.cloth, 7, 'taken').cloth.next, 1); assert.equal(PL.lossAt(K.line, 7, 'taken').line, null); }
  // pulled down: the pole falls in 350 ms, faster as it goes; dust and a small shake where it hits; then all the tiles
  // drain together in 400 ms; the gold line draws back in 300 ms; the number sinks from the pole at the impact, the words after it
  { const K = PL.LOSS.pull;
    assert.equal(PL.lossAt(0, 7).fall, 0); assert.equal(PL.lossAt(K.fall, 7).fall, 1); assert.ok(PL.lossAt(K.fall / 2, 7).fall < 0.5, 'ease-in');
    assert.equal(PL.lossAt(K.fall - 1, 7).dust, null); assert.equal(PL.lossAt(K.fall, 7).dust, 0); assert.equal(PL.lossAt(K.fall, 7).number, 0); assert.equal(PL.lossAt(K.fall - 1, 7).words, null);
    assert.equal(PL.lossAt(K.fall, 7).tile(0), 1); assert.equal(PL.lossAt(K.fall + K.drain / 2, 7).tile(0), PL.lossAt(K.fall + K.drain / 2, 7).tile(6), 'all the tiles together'); assert.equal(PL.lossAt(K.fall + K.drain, 7).tile(3), 0);
    assert.equal(PL.lossAt(0, 7).line, 0); assert.equal(PL.lossAt(K.back, 7).line, null); assert.equal(PL.lossAt(K.fall + K.fade, 7).flag, 0);
    assert.equal(PL.lossAt(PL.lossMs(7), 7).done, true); assert.equal(PL.lossAt(PL.lossMs(7, 'taken'), 7, 'taken').done, true); }
});

test('every moment starts from a difference between two models: nothing plays for what a page opens with, or for a province whose record has just arrived', () => {
  const said = [];
  const off1 = bus.on('proto:land', e => said.push(e)), off2 = bus.on('proto:trail', e => said.push({ kind: 'trail', ...e }));
  const B = new ProtoBoard();
  // what the page opens with is simply there
  assert.equal(B.set(model(land({ mine: false })), { now: 1000 }), true);
  assert.equal(B.moments.size, 0); assert.equal(said.length, 0); assert.equal(B.on, true);
  // the same records again: nothing
  assert.equal(B.set(model(land({ mine: false })), { now: 1500 }), false);
  // a banner that was not there: a raise, said once, with what the plate needs
  B.set(model(land({ turn: 51 })), { now: 2000 });
  const m = B.moments.get('2,0,0');
  assert.equal(m.kind, 'raise'); assert.equal(m.t0, 2000); assert.equal(m.mine, true); assert.equal(m.n, flower(POLE).length + TAIL.length);
  assert.deepEqual(said.map(e => [e.kind, e.key, e.mine, e.n]), [['raise', '2,0,0', true, m.n]]);
  assert.deepEqual(said[0].pole, { p: 2, q: 0, tile: POLE });
  // until the gold line closes the viewer's land is drawn as it was; then the new tiles are in it
  const vill = [{ p: 2, q: 0, tile: HOME.tile, state: 2 }];
  assert.equal(B.mineLands(vill, 2000 + 100)[0].tiles.length, 7);
  assert.equal(B.mineLands(vill, 2000 + PL.raiseCloseAt(m.n) + 1)[0].tiles.length, 7 + m.n);
  assert.equal(B.mineLands(vill, 2100)[0].key, `2,0,${HOME.tile}`, 'the land keeps its village\'s key (the landing floods it as before)');
  assert.equal(B.mineLands(vill, 2100)[0].proto, true);
  assert.notEqual(B.staticKey(2100, {}), B.staticKey(2000 + PL.raiseCloseAt(m.n) + 1, {}), 'the still ground is painted again when the flood has closed');
  B.prune(2000 + PL.raiseMs(m.n) + 1);
  assert.equal(B.moments.size, 0);
  // a threat's dial moving is no moment
  B.set(model(land({ turn: 52, contested: { nation: 2, host: 'x', sinceTurn: 51, canTakeAtTurn: 87 } })), { now: 9000 });
  assert.equal(B.moments.size, 0);
  // the banner under another nation: taken (the colour turns from the pole outward)
  said.length = 0;
  const taken = land({ turn: 87 }); Object.assign(taken.banners[0], { nation: 2, holder: 'cinder-town' });
  B.set(protoBoardModel({ sample: SAMPLE, provinces: [{ p: 2, q: 0, land: taken }], me: { banners: [], cap: 5, perProvince: 2 }, viewer: VIEWER, events: [{ kind: 'PROTO_LAND', proto: true, seq: 9, op: 'TAKE', p: 2, q: 0, slot: 0, nation: 2 }] }), { now: 10000 });
  const t = B.moments.get('2,0,0');
  assert.deepEqual([t.kind, t.from, t.nation, t.wasMine, t.mine], ['taken', 0, 2, true, false]);
  assert.equal(hexDistance(t.tiles[0].q, t.tiles[0].r, t.pole.q, t.pole.r), 0, 'from the pole outward');
  assert.deepEqual(said.map(e => [e.kind, e.wasMine]), [['taken', true]]);
  assert.equal(B.mineLands(vill, 10001)[0].tiles.length, 7, 'the viewer\'s land is the village\'s again at once');
  // gone: pulled down (PULL) or lapsed (STRIKE), by the record that says so
  B.moments.clear(); said.length = 0;
  B.set(model(land({ turn: 88, mine: false }), { events: [{ kind: 'PROTO_LAND', proto: true, seq: 10, op: 'PULL', p: 2, q: 0, slot: 0 }] }), { now: 12000 });
  assert.deepEqual([B.moments.get('2,0,0').kind, said[0].kind, said[0].n], ['pulled', 'pulled', m.n]);
  B.moments.clear();
  B.set(model(land({ turn: 89, mine: false, theirs: false }), { events: [{ kind: 'PROTO_LAND', proto: true, seq: 11, op: 'STRIKE', p: 2, q: 0, slot: 5 }] }), { now: 13000 });
  assert.equal(B.moments.get('2,0,5').kind, 'lapsed'); assert.equal(B.moments.get('2,0,5').wasMine, false);
  // a province whose record arrives for the first time: its banners are simply there
  B.moments.clear(); said.length = 0;
  const other = { ...land({ turn: 89 }) };
  B.set(protoBoardModel({ sample: SAMPLE, provinces: [{ p: 2, q: 0, land: land({ turn: 89, mine: false, theirs: false }) }, { p: 1, q: 1, land: other }], me: { banners: [], cap: 5, perProvince: 2 }, viewer: VIEWER }), { now: 14000 });
  assert.equal(B.moments.size, 0); assert.equal(said.length, 0);
  // a trail that is new is inked from its record's arrival; when it goes it fades
  B.set(model(land({ turn: 90, mine: false, theirs: false, trails: [{ host: hid(7), nation: 0, tiles: TAIL }] })), { now: 15000 });
  assert.equal(B.trailSeen.get(`2,0,${hid(7)}`), 15000); assert.deepEqual(said.map(e => e.kind), ['trail']);
  B.set(model(land({ turn: 91, mine: false, theirs: false })), { now: 16000 });
  assert.equal(B.trailGone.length, 1); assert.equal(B.trailSeen.size, 0);
  // reduced motion: the pictures are at their end at once, the words still run
  const C = new ProtoBoard();
  C.set(model(land({ mine: false })), { now: 0, still: true }); C.set(model(land()), { now: 100, still: true });
  assert.ok(C.at(C.moments.get('2,0,0'), 100) >= PL.raiseCloseAt(C.moments.get('2,0,0').n));
  assert.equal(C.mineLands(vill, 101)[0].tiles.length, 7 + m.n);
  // off: everything is put away
  assert.equal(B.set(null), true); assert.equal(B.on, false); assert.equal(B.mineLands(vill), null); assert.equal(B.set(null), false);
  off1(); off2();
});

test('the look the art critic asked for (2026-10-11): one colour on any ground, the gold line last and widest, a watch in cream, a threat in the threatening nation\'s colour', () => {
  const L = PL.PROTO_LOOK;
  // the fill: parchment first (stronger on dark ground), then the nation's colour lightened; both plain paint
  assert.ok(PL.levelOf('grassland') > PL.levelOf('plains') && PL.levelOf('forest') > PL.levelOf('plains')); assert.equal(PL.levelOf('plains'), 0.15); assert.equal(PL.levelOf(null), L.fill.levelElse);
  assert.equal(L.fill.level, '#e8dcc0'); assert.equal(PL.fillColour(0), PL.lighten('#cc303b', L.fill.lighten)); assert.notEqual(PL.fillColour(0), '#cc303b');
  const h = tileHex(HOME.p, HOME.q, POLE), tile = { q: h.q, r: h.r };
  let g = recorder();
  PL.paintLandTile(g, tile, { nation: 0, terrainAt: () => 'grassland' });
  assert.ok(!g.log.some(x => /globalCompositeOperation/.test(x)), 'no blend mode: plain paint');
  assert.deepEqual(g.log.filter(x => /^fillStyle=/.test(x)), ['fillStyle=#e8dcc0', `fillStyle=${PL.fillColour(0)}`]);
  assert.deepEqual(g.log.filter(x => /^globalAlpha=/.test(x)), ['globalAlpha=0.4', `globalAlpha=${L.fill.wash}`]);
  // water: no fill, an inner line of the colour
  g = recorder();
  PL.paintLandTile(g, tile, { nation: 0, terrainAt: () => 'water' });
  assert.ok(!g.log.some(x => /^fill\(/.test(x)), 'water takes no fill'); assert.ok(g.log.some(x => /^clip\(/.test(x)) && g.log.some(x => /^stroke\(/.test(x)));
  // a flood's front: over-bright, then settled to exactly the resting fill
  g = recorder();
  PL.paintFloodTile(g, tile, { nation: 0, terrainAt: () => 'plains', state: { in: 1, hot: 1 } });
  assert.ok(g.log.includes(`globalAlpha=${PL.RAISE.hot}`) && g.log.includes('fillStyle=#ffffff') && g.log.includes(`globalAlpha=${PL.RAISE.flash}`));
  const rest = recorder(), settled = recorder();
  PL.paintLandTile(rest, tile, { nation: 0, terrainAt: () => 'plains' }); PL.paintFloodTile(settled, tile, { nation: 0, terrainAt: () => 'plains', state: { in: 1, hot: 0 } });
  assert.deepEqual(settled.log, rest.log, 'a flood ends as the land it leaves');
  // a tile the front has not reached keeps the claim's faint colour: nothing is cleared at the record
  g = recorder();
  PL.paintFloodTile(g, tile, { nation: 0, state: { in: 0, hot: 0 } });
  assert.ok(g.log.includes(`globalAlpha=${L.claim.fill}`) && g.log.some(x => /^fill\(/.test(x)));
  // whose land: the viewer's whole, a nation-mate's about half with a thin dark rim, another nation's rim darker than its fill
  assert.equal(L.mine.fill, 1); assert.ok(L.mate.fill <= 0.5 && L.mate.rim <= 1.5 && L.mate.under === 0); assert.ok(L.other.darken >= 0.4 && L.other.rim === 2);
  g = recorder();
  PL.paintPatch(g, [tile], { nation: 2, look: L.other });
  assert.ok(g.log.includes(`strokeStyle=${PL.darken('#eac21b', 0.4)}`), 'Cinder\'s rim is dark yellow, never the viewer\'s gold');
  // the gold line: 4 px on a 6 px dark underlay with a gilded rim inside, no line of the nation's colour beside it; drawn again over what stands
  assert.deepEqual({ gold: OWN.PROTO_LINE.gold, under: OWN.PROTO_LINE.under, band: OWN.PROTO_LINE.band, colour: OWN.PROTO_LINE.colour, dark: OWN.PROTO_LINE.dark }, { gold: 4, under: 6, band: 8, colour: '#ffd76a', dark: '#2e2208' });
  assert.equal(L.line, OWN.PROTO_LINE); assert.equal(PL.GOLD, '#ffd76a');
  const landOf = B0 => B0.mineLands([{ p: 2, q: 0, tile: HOME.tile, state: 2 }], 0)[0];
  const B0 = new ProtoBoard(); B0.set(model(), { now: 0 });
  g = recorder(); OWN.paintOwnLand(g, landOf(B0), { zoom: 1, faction: 0, still: true });
  assert.ok(g.log.includes('strokeStyle=#ffd76a') && g.log.includes('strokeStyle=#2e2208')); assert.ok(!g.log.includes('strokeStyle=#cc303b'), 'no twin in the nation\'s colour'); assert.ok(!g.log.some(x => /soft-light/.test(x)), 'no cast: the fill is the prototype\'s own');
  g = recorder(); OWN.paintOwnOutline(g, landOf(B0), { zoom: 1 });
  assert.ok(g.log.includes('strokeStyle=#ffd76a') && g.log.includes(`globalAlpha=${OWN.PROTO_LINE.top}`));
  // (a land that is not the prototype's keeps the rim it had)
  g = recorder(); OWN.paintOwnLand(g, { ...landOf(B0), proto: false }, { zoom: 1, faction: 0, still: true });
  assert.ok(g.log.includes('strokeStyle=#cc303b'));
  // a watch beside held land: a thin cream rim, no wash
  assert.deepEqual({ ...L.quiet }, { colour: '#f3e9cf', alpha: 0.55, width: 1.5 });
  const w = { key: 'w', q: h.q, r: h.r, radius: 1, tiles: [tile] };
  g = recorder(); HM.paintWatch(g, w, { zoom: 1, faction: 0, quiet: L.quiet });
  assert.ok(g.log.includes('strokeStyle=#f3e9cf') && !g.log.some(x => /^fill\(/.test(x)) && !g.log.includes('strokeStyle=#cc303b'));
  g = recorder(); HM.paintWatchTop(g, w, { zoom: 1, faction: 0, quiet: L.quiet });
  assert.equal(g.log.length, 0);
  // a threat: the land at stake under the threatening nation's colour, a 4 px ring; a dial that lands large when its count changes
  g = recorder(); PL.paintThreatGround(g, [tile], tile, { zoom: 1, still: true, colour: '#eac21b' });
  assert.ok(g.log.includes('strokeStyle=#eac21b') && g.log.some(x => /^setLineDash\(\[8/.test(x)) && g.log.some(x => /^ellipse\(/.test(x)));
  assert.equal(L.threat.ring, 4); assert.equal(L.threat.outline, 3); assert.ok(L.threat.pulseFast < L.threat.pulse);
  const D = new ProtoBoard();
  assert.equal(D.bumpOf('k', 12, 1000, false), 0, 'a dial seen for the first time does not jump');
  assert.equal(D.bumpOf('k', 12, 1100, false), 0); assert.equal(D.bumpOf('k', 11, 2000, false), 1); assert.ok(D.bumpOf('k', 11, 2100, false) > 0 && D.bumpOf('k', 11, 2100, false) < 1); assert.equal(D.bumpOf('k', 11, 2000 + PB.DIAL_BUMP_MS + 1, false), 0);
  assert.equal(D.bumpOf('k', 10, 3000, true), 0, 'nothing jumps under reduced motion');
  // a banner's pole stands to the upper left of its tile's middle, clear of the host and its character
  assert.ok(PB.POLE_AT.x <= -0.7 * 44 && PB.POLE_AT.y < -0.3 * 44);
});

test('a moment of the viewer\'s own is read alone, a loss shakes the board, and a trail is drawn only where it is not land yet', () => {
  const B = new ProtoBoard();
  B.set(model(land({ turn: 50, mine: false })), { now: 0 });
  assert.equal(B.hush(100), false); assert.equal(B.shakeAt(100), 0);
  B.set(model(land({ turn: 51 })), { now: 2000 });
  const m = B.moments.get('2,0,0');
  assert.equal(m.tail, TAIL.length, 'the raise knows how many of its tiles are the tail');
  assert.equal(B.hush(2100), true); assert.equal(B.hush(2000 + PL.RAISE.hush + 1), false);
  assert.equal(B.hush(2100, { q: m.pole.q + 1, r: m.pole.r }), true); assert.equal(B.hush(2100, { q: m.pole.q + 5, r: m.pole.r }), false, 'only near the moment');
  assert.deepEqual(B.flooding(2100).map(x => x.key), ['2,0,0']); assert.deepEqual(B.flooding(2000 + PL.raiseCloseAt(m.n)).length, 0);
  assert.equal(B.shakeAt(2050), 0, 'a raise does not shake the board');
  // taken: the board shakes for a fifth of a second, and the still ground waits for the taker's colour
  const taken = land({ turn: 87 }); Object.assign(taken.banners[0], { nation: 2, holder: 'cinder-town' });
  B.moments.clear();
  B.set(protoBoardModel({ sample: SAMPLE, provinces: [{ p: 2, q: 0, land: taken }], me: { banners: [], cap: 5, perProvince: 2 }, viewer: VIEWER, events: [] }), { now: 10000 });
  assert.ok(Math.abs(B.shakeAt(10050)) > 0.5); assert.equal(B.shakeAt(10000 + PL.LOSS.take.shake + 1), 0);
  assert.deepEqual(B.flooding(10100).map(x => x.kind), ['taken']); assert.equal(B.pending(10100).length, 0, 'it is not the viewer\'s land: the gold line lets go at once');
  assert.equal(B.flooding(10000 + PL.LOSS.take.flood).length, 0);
  // a trail of the viewer's whose tiles are all banner land already is drawn no more
  const T = new ProtoBoard();
  T.set(model(land({ turn: 60, trails: [{ host: hid(7), nation: 0, tile: POLE, tiles: TAIL }] })), { now: 0 });
  const g = recorder();
  T.groundLive(g, { z: 1, fx: 5000, still: true });
  assert.ok(!g.log.some(x => /^ellipse\(/.test(x)), 'no footprints on land that is held');
});

test('what the board says: counts in turns with the clock time beside them, the tag before a tip, no word of territory, every sentence in English too', () => {
  setLang('ja');
  assert.equal(protoTag(), '試作'); assert.equal(tagged('x'), '試作 · x'); assert.equal(tagged(''), '');
  assert.equal(PROTO_WORDS.gain(7, 1, 20), '+7マス・1ターン', 'amendment B: the page says ターン');
  assert.equal(PROTO_WORDS.gain(6, 12, 20), '+6マス・12ターン（約4分）');
  assert.equal(PROTO_WORDS.gain(6, 12, 600), '+6マス・12ターン（約2時間）');
  assert.equal(PROTO_WORDS.threat(27, 20), 'あなたの旗が狙われています。あと27ターンで取られます（約9分）');
  assert.equal(PROTO_WORDS.threat(27, 600), 'あなたの旗が狙われています。あと27ターンで取られます（約4時間30分）');
  assert.equal(PROTO_WORDS.raised(9), '+9マス あなたの土地になりました');
  assert.equal(PROTO_WORDS.rising(1, 20), 'あと1ターンで旗を立てられます');
  assert.equal(PROTO_WORDS.pulled(7), 'あなたの旗が倒されました（−7マス）');
  assert.equal(PROTO_WORDS.yoursFirm(432), 'あなたの旗（しっかり立っています・3日に1回見回り）'); assert.equal(PROTO_WORDS.yoursLoose(144), 'あなたの旗（他国の州：1日1回の見回りが必要）');
  assert.equal(PROTO_WORDS.border(36), '国境に触れています：向かいの国には36ターンで取られます');
  assert.equal(aboutTime(3, 20), '約60秒'); assert.equal(aboutTime(0, 20), ''); assert.equal(aboutTime(5, null), '');
  // a refusal on its tile, with its glyph
  assert.equal(refusalWords({ ok: false, code: 'NotSurveyed' }), 'まだ測量していません（進軍して着けば測量は要りません）'); assert.equal(refusalGlyph({ code: 'NotSurveyed' }), 'eye');
  assert.equal(refusalWords({ ok: false, code: 'NotHere', why: 'must touch our land' }), 'わたしたちの土地に接していません');
  assert.equal(refusalWords({ ok: false, code: 'NotHere', why: 'heartland' }), '他国の中核地です'); assert.equal(refusalWords({ ok: false, code: 'NotHere', why: 'needs a Town' }), '町になってから');
  assert.equal(refusalWords({ ok: false, code: 'PerProvince' }, { perProvince: 2 }), 'この州の旗は2本までです：次の旗は別の州へ', 'the count is the viewer\'s own record\'s'); assert.equal(refusalGlyph({ code: 'PerProvince' }), 'full');
  assert.equal(refusalWords({ ok: false, code: 'WorksShort', need: 4 }), 'Works があと4足りません'); assert.equal(refusalGlyph({ code: 'WorksShort' }), 'short');
  // the sample world's own detail (`need` is an object there)
  assert.equal(refusalWords({ ok: false, code: 'WorksShort', need: { works: 8, have: 4, short: 4 } }), 'Works があと4足りません');
  assert.equal(refusalWords({ ok: false, code: 'NotHere', need: { why: 'touch' } }), 'わたしたちの土地に接していません'); assert.equal(refusalWords({ ok: false, code: 'NotHere', need: { why: 'heartland' } }), '他国の中核地です');
  assert.equal(refusalWords({ ok: false, code: 'PerProvince', need: { perProvince: 2 } }), 'この州の旗は2本までです：次の旗は別の州へ');
  assert.equal(refusalWords({ ok: false, code: 'CapReached', need: { cap: 5, held: 5 } }), '旗はもう立てられません（5/5）');
  assert.equal(refusalWords({ ok: false, code: 'TooFew', need: { troops: 100, have: 40 } }), '兵が足りません（100人から）');
  assert.equal(refusalWords({ ok: false, code: 'SiteOrCamp', need: { why: 'site' } }), '村の用地や野営地には立てられません'); assert.equal(refusalWords({ ok: false, code: 'NotOpen', need: { why: 'impassable' } }), 'ここは通れない土地です');
  assert.ok(refusalWords({ ok: false, code: 'SomethingNew' }).length > 0);
  // no bell-count words (鐘N回), and the words of territory are nowhere in what the board itself says
  const words = read('map/protowords.mjs').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/鐘/.test(words), 'counts are turns'); assert.ok(!/領土/.test(words)); assert.ok(!/チェーンの記録/.test(words), 'the score\'s note is the HUD\'s; the board never calls anything a chain record');
  // English: British spelling, turns, no "territory"
  setLang('en');
  assert.equal(protoTag(), 'Prototype');
  assert.equal(PROTO_WORDS.gain(7, 1, 20), '+7 tiles after 1 turn'); assert.equal(PROTO_WORDS.gain(6, 12, 20), '+6 tiles after 12 turns (about 4 min real time)');
  assert.equal(PROTO_WORDS.raised(9), '+9 tiles are now yours'); assert.equal(PROTO_WORDS.raised(1), '+1 tile is now yours');
  assert.match(PROTO_WORDS.threat(27, 20), /^Your banner is under threat: it can be taken in 27 turns \(about 9 min real time\)$/);
  assert.equal(refusalWords({ ok: false, code: 'NotSurveyed' }), 'Not surveyed yet (a host that marches here needs no survey)');
  const all = [PROTO_WORDS.villageLand(7), PROTO_WORDS.canRise(), PROTO_WORDS.trail(), PROTO_WORDS.risingReady(9), PROTO_WORDS.yoursFirm(432), PROTO_WORDS.yoursLoose(144), PROTO_WORDS.border(36), PROTO_WORDS.border(0), PROTO_WORDS.mate(null), PROTO_WORDS.commonsOurs(), PROTO_WORDS.commonsOf(2), PROTO_WORDS.bannerOf(2),
    PROTO_WORDS.enemyRising(2, 9), PROTO_WORDS.walkSoon(30), PROTO_WORDS.frayed(72), PROTO_WORDS.taking(12, 20), PROTO_WORDS.takingReady(), PROTO_WORDS.taken(2), PROTO_WORDS.lapsed(7), protoLegendLine(), ...PROTO_LEGEND.flatMap(x => [x.name(), x.text()])];
  for (const s of all) { assert.ok(!/[぀-ヿ一-鿿]/.test(s), `English for: ${s}`); assert.ok(!/territor/i.test(s), s); assert.ok(!/\btoll/i.test(s), s); }
  assert.ok(EN['試作ルール：旗（設計のみ・プログラム未実装）']);
  setLang('ja');
});

test('the label: the legend has the prototype\'s entries only while the map draws it, under the record\'s own label', () => {
  setLang('ja');
  setProtoLegend(null);
  const plain = String(renderSurveyHelp());
  assert.equal(String(renderProtoLegend()), ''); assert.ok(!plain.includes('試作'));
  setProtoLegend(LABEL);
  const on = String(renderSurveyHelp());
  assert.ok(on.includes('試作：試作ルール：旗（設計のみ・プログラム未実装）')); assert.ok(on.includes('旗の土地・国の共有地・村の土地の色分けは、設計中の「旗のルール」の試作です。'));
  for (const x of PROTO_LEGEND) assert.ok(on.includes(`proto-${x.id}`));
  assert.equal(on.replace(String(renderProtoLegend()), ''), plain, 'nothing else of the legend changes');
  setLang('en'); assert.equal(protoLabelText(LABEL), LABEL.en); setLang('ja'); assert.equal(protoLabelText(LABEL), LABEL.ja); assert.equal(protoLabelText(null), '');
  setProtoLegend(null);
  assert.equal(String(renderSurveyHelp()), plain);
  // the chip is the record's label and nothing else's; it stands down for the page's own (data-proto-chip)
  const chip = read('map/protochip.mjs');
  assert.match(chip, /\[data-proto-chip\]:not\(\[hidden\]\):not\(#\$\{ID\}\)/, 'the page\'s chip while it is shown; a hidden one (a demo sample on a page with no season record of the prototype) leaves the map\'s own up'); assert.ok(!/[぀-ヿ一-鿿]/.test(chip.replace(/\/\/.*$/gm, '')), 'no words of its own');
});

test('the map with the prototype off draws exactly what it drew before; on, the viewer\'s land is the records\' land', () => {
  const tileOf = (dq, dr) => off(HOME.tile, dq, dr);
  // (the effects clock stands still: two pictures of the same records are the same picture)
  clock.seek(5);
  const fs = { mode: 'play', nowBell: 50, holdings: [{ ...HOME, state: 2, tier: 1, transit: [], queue: [], stores: [], production: [], explore: { state: 0 } }], marches: [], citizen: { faction: 0 }, wallet: { address: 'W' }, record: { rings: [0, 1, 2] },
    provinces: new Map([[`2,0`, { province: { p: 2, q: 0, entries: [{ id: hostId({ ...HOME, seq: 7 }), faction: 0, unit: 0, tile: tileOf(3, -1), state: 1, troops: 400_000, staminaValue: 120, staminaBell: 40, readyBell: 0, fromBell: 0, pendOp: 0 }], sites: [0, 1, 2, HOME.tile] } }]]) };
  const page0 = { ringsOpen: 3, overviews: new Map(), own: [{ p: 2, q: 0, tile: HOME.tile, tier: 1 }], open: { ready: true, active: 0 }, survey: null, selected: null };
  const c = tileHex(2, 0, HOME.tile);
  const trace = (prep, lod = 'tile') => {
    const map = new FrontierMap({ clientWidth: 900, clientHeight: 700 }, { source: () => page0 });
    map.setSample(fs);
    prep(map);
    const ctx = recorder(), view = { x: Math.sqrt(3) * 44 * (c.q + c.r / 2), y: 44 * 1.5 * c.r * 0.76, zoom: lod === 'tile' ? 1 : lod === 'province' ? 0.3 : 0.1 };
    const r = map.paintScene(ctx, map.source(), view, lod, { width: 900, height: 700 }, 1, { now: 5000 });
    r.over(ctx);
    const out = ctx.log.join('\n');
    map.destroy();
    return out;
  };
  for (const lod of ['tile', 'province', 'world']) {
    const before = trace(() => {}, lod);
    assert.ok(before.length > 500, `the ${lod} view paints`);
    assert.equal(trace(m => m.setProto(null), lod), before, `${lod}: null is the map as it was`);
    assert.equal(trace(m => m.setProto(protoBoardModel({ sample: { world: 'sample', turnSecs: 20 }, provinces: [{ p: 2, q: 0, land: land() }] })), lod), before, `${lod}: a sample world without claims is the map as it was`);
    assert.equal(trace(m => { m.setProto(model()); m.setProto(null); }, lod), before, `${lod}: switched off again, nothing of it stays`);
    assert.equal(trace(m => m.showRaisePreview({ ok: true, tiles: flower(POLE), trail: [], size: 7, price: 0, waitTurns: 1, p: 2, q: 0, tile: POLE }), lod), before, `${lod}: a preview shows nothing while the prototype is off`);
    assert.notEqual(trace(m => m.setProto(model()), lod), before, `${lod}: on, the board draws it`);
  }
  // on: the viewer's land is one land, the village's tiles and the banner's; the API answers from the model
  const map = new FrontierMap({ clientWidth: 900, clientHeight: 700 }, { source: () => page0 });
  map.setSample(fs);
  assert.equal(map.proto.on, false); assert.equal(map.bannerAt(10, 10), null); assert.equal(map.flyToBanner({ p: 2, q: 0, slot: 0 }), false); assert.equal(map.protoAt(2, 0, POLE), null);
  assert.equal(map.showRaisePreview({ ok: true, tiles: [], trail: [], size: 7, waitTurns: 1, p: 2, q: 0, tile: POLE }), false);
  const M = model();
  map.setProto(M);
  const F = map.youFrame(map.source(), map.source().survey, 'tile', 1, null);
  const lands = F.lands();
  assert.equal(lands.length, 1); assert.equal(lands[0].proto, true); assert.equal(lands[0].tiles.length, M.mine.total);
  assert.equal(map.flyToBanner({ p: 2, q: 0, slot: 0 }), true); assert.equal(map.flyToBanner({ p: 2, q: 0, slot: 9 }), false);
  assert.deepEqual(map.protoAt(2, 0, POLE).banner, { p: 2, q: 0, slot: 0 }); assert.equal(map.protoAt(2, 0, POLE).tag, '試作'); assert.equal(map.protoAt(2, 0, POLE).line, 'あなたの旗（しっかり立っています）');
  assert.equal(map.protoAt(2, 0, HOME.tile).line, '村の土地 7マス'); assert.equal(map.protoAt(2, 0, THEIRS).mine, false);
  // the preview route's answer, with its place: in the answer or beside it
  assert.equal(map.showRaisePreview({ ok: true, tiles: flower(tileOf(0, 3)), trail: [], size: 7, price: 0, waitTurns: 1 }, { p: 2, q: 0, tile: tileOf(0, 3) }), true);
  assert.deepEqual([map.proto.preview.ok, map.proto.preview.size, map.proto.preview.waitTurns, map.proto.preview.tiles.length], [true, 7, 1, flower(tileOf(0, 3)).length]);
  assert.equal(map.showRaisePreview({ ok: false, code: 'PerProvince', p: 2, q: 0, tile: tileOf(0, 3) }), true);
  assert.equal(map.proto.preview.words, 'この州の旗は2本までです：次の旗は別の州へ'); assert.equal(map.proto.preview.glyph, 'full');
  assert.equal(map.showRaisePreview(null), false); assert.equal(map.proto.preview, null);
  map.setProto(null);
  assert.equal(F.lands === undefined, false); assert.equal(map.proto.preview, null);
  map.destroy();
  // in the map's own source every pass of the prototype is behind its switch
  const src = read('map/fmap.mjs');
  assert.match(src, /const PB = this\.proto\.on \? this\.proto : null/); assert.match(src, /if \(this\.proto\.on\) this\.proto\.top\(ctx, F\);/); assert.match(src, /if \(this\.proto\.on\) this\.proto\.over\(ctx, F, hid\);/); assert.match(src, /if \(this\.proto\.on && F\.limited\) \{ this\.proto\.far\(ctx, F\)/);
  assert.match(src, /const mine = this\.proto\.on \? this\.proto\.mineLands\(villages, fxNow\(\)\) : null;/);
  // app.mjs: one marked block
  const app = read('app.mjs');
  assert.equal(app.split('>>> proto-board').length, 2); assert.equal(app.split('<<< proto-board').length, 2); assert.equal((app.match(/mountProtoBoard/g) ?? []).length, 2, 'the import and the one call');
});

// (rewritten at the integration of 2026-10-10: the board no longer reads the network beside the page. The page reads the
// prototype's records once, into FS.proto, and this adapter hands that one reading to the board's model.)
test('the board\'s feed: the page\'s one reading of the records (lands, the viewer\'s record, PROTO_LAND records, the preview route\'s answers) handed on; the board itself asks the network for nothing', async () => {
  const L0 = land();
  const P = { lands: new Map([['2,0', L0], ['1,1', { ...land(), banners: [] }], ['2,-2', land()]]), me: { banners: [{ p: 2, q: 0, slot: 0 }], cap: 5, perProvince: 2 }, rev: 3,
    log: [{ seq: '701', kind: 'PROTO_LAND', proto: true, op: 'RAISE', turn: 50, p: 2, q: 0, slot: 0, pole: POLE, nation: 0, holder: 'W', tiles: L0.banners[0].tiles }, { seq: '702', kind: 'DEPART' }] };
  const asked = [], held = new Map();
  const answers = { [`${hid(7)}|2,0,${POLE}`]: { ok: true, tiles: flower(POLE), trail: TAIL, size: 8, price: 0, waitTurns: 1 }, 'x|2,0,5': { ok: false, code: 'NotSurveyed' }, 'new:100|2,0,16': { ok: true, mode: 'form', tiles: [16], trail: [], size: 1, price: 0, waitTurns: 1 } };
  // (the page's one asker, as controller.mjs wantPreview behaves: the answer held, undefined while it is asked, null when it cannot be had)
  const want = (x, onAnswer) => {
    const key = `${x.host ?? `new:${x.troops ?? ''}`}|${x.p},${x.q},${x.tile}`;
    if (held.has(key)) return held.get(key);
    asked.push(key);
    setTimeout(() => { const a = answers[key] ?? null; held.set(key, a); onAnswer?.(a); }, 0);
    return undefined;
  };
  let state = P;
  const feed = protoFeedOf({ state: () => state, want, seen: (p, q) => !(p === 2 && q === -2) });
  assert.deepEqual([...feed.lands.keys()], ['2,0', '1,1'], 'a province the viewer has seen nothing of is not handed to the board');
  assert.equal(feed.me.cap, 5); assert.deepEqual(feed.events.map(e => [e.seq, e.op]), [[701, 'RAISE']], 'only the prototype\'s records, as the model reads them');
  assert.equal(feed.events, feed.events, 'the same log: the same list');
  const r0 = feed.rev(); P.rev++; assert.notEqual(feed.rev(), r0, 'the page read something new');
  // the preview route through the page's asker: the answer with its place beside it, one request a place
  const a = await feed.preview(hid(7), 2, 0, POLE);
  assert.deepEqual([a.ok, a.size, a.p, a.q, a.tile, a.host], [true, 8, 2, 0, POLE, hid(7)]);
  await feed.preview(hid(7), 2, 0, POLE);
  assert.equal(asked.filter(k => k.startsWith(hid(7))).length, 1);
  assert.deepEqual(await feed.preview('x', 2, 0, 5), { ok: false, code: 'NotSurveyed', host: 'x', p: 2, q: 0, tile: 5 });
  assert.deepEqual([(await feed.preview(null, 2, 0, 16, { troops: 100 })).mode, (await feed.preview('', 2, 0, 16, { troops: 100 })).host], ['form', null], 'no host: a host formed there now');
  assert.equal(await feed.preview('y', 9, 9, 9), null, 'an answer that cannot be had');
  assert.deepEqual(feed.previewNow(hid(7), 2, 0, POLE).size, 8); assert.equal(feed.previewNow('z', 2, 0, 3), undefined);
  // the model from the page's state and the feed
  const fs = { sample: SAMPLE, holdings: [{ ...HOME }], citizen: { faction: 0 }, wallet: { address: 'W' }, provinces: new Map(), overviews: new Map(), terrainOf: () => ({ sites: [HOME.tile] }) };
  const M = protoModelOf(fs, feed, null);
  assert.equal(M.banners.find(b => b.mine).key, '2,0,0'); assert.equal(M.mine.total, 7 + L0.banners[0].tiles.length); assert.equal(M.events.length, 1);
  // off: nothing held, nothing handed on
  state = null;
  assert.equal(feed.lands.size, 0); assert.equal(feed.me, null); assert.deepEqual(feed.events, []); assert.equal(feed.rev(), ''); assert.equal(await feed.preview('q', 1, 1, 1), null);
  // neither the feed nor the mount names a route, a fetch or a timer: the reading is the page's
  const src = (read('proto/board-feed.mjs') + read('proto/board-mount.mjs')).replace(/^\s*\/\/.*$|^\s*\*.*$|\/\*\*?.*$/gm, '');
  assert.doesNotMatch(src, /fetch|setInterval|\/h\/|\/gw\/|method:/, 'the board reads nothing by itself');
  assert.match(read('proto/board-mount.mjs'), /if \(!FS\.sample\?\.proto\?\.claims \|\| !state\(\)\)/, 'off: the map is given null');
  assert.match(read('app.mjs'), /protoBoard\?\.build\(\)/, 'the page builds the board\'s model from its own reading');
});

test('the demo switch has a sample for each moment of the prototype, each laid as records through the board\'s own model', () => {
  for (const n of ['proto-land', 'proto-trail', 'proto-raise', 'proto-threat', 'proto-taken', 'proto-pulled', 'proto-frayed', 'proto-choose', 'proto-ghost', 'proto-take']) { assert.equal(typeof SAMPLES[n]?.run, 'function', n); assert.equal(SAMPLES[n].proto, true, n); }
  const demo = read('fx/proto-demo.mjs');
  assert.match(demo, /protoBoardModel\(/, 'the samples go through the model the records go through');
  assert.match(demo, /run\.map\.setProto\(model, \{ at:/);
  // the pole stands clear of a host on the tile
  assert.ok(POLE_AT.x < 0);
});

test('the sample world\'s own records (as dumped by the world track on 2026-10-10) read as the spec\'s do: the player key is its village, a claim in progress carries the land it would take', () => {
  // (the shapes of scratch proto6/records: province-2,0-after-raise.json, me-after-raise.json, event-RAISE.json; values shortened)
  const claim = [255, 3, 3, 255, 255, 255, 3, 3, 3, 17, 255, 255, 255, 3, 3, 17, 17, 17, 7, 255, 16, 255, 255, 17, 255, 255, 7, 7, 16, ...new Array(6).fill(255), 7, 16, 16, ...new Array(23).fill(255)];
  const real = { resolvedNext: 45, day: 0, claim, banners: [{ slot: 0, pole: 28, nation: 2, holder: '2,0,7', tiles: [28, 37, 36, 20], raisedTurn: 41, tendedTurn: 41, firm: false, border: [], frayed: false, walkDue: 185, strikeAt: 257, dressedToday: false, elbowLockedUntil: null, contested: null },
    { slot: 1, pole: 16, nation: 0, holder: '2,0,3', tiles: [16, 23, 15, 9, 17], raisedTurn: 45, tendedTurn: 45, firm: true, border: [], frayed: false, walkDue: 477, strikeAt: 549, dressedToday: false, elbowLockedUntil: null, contested: null }],
    trails: [{ host: '126443837194247', nation: 0, tile: 32, tiles: [23, 15, 8] }], counted: [12, 0, 8, 0, 0, 0], paid: [53, 0, 8, 0, 0, 0], holderNation: 0, heartland: true,
    rising: [{ host: '126443837194247', nation: 0, holder: '2,0,3', tile: 32, sinceTurn: 42, canRaiseAtTurn: 43, tiles: 5, patch: [32, 41, 40, 31, 33], trail: [], ready: true, forming: false }],
    villages: [{ site: 3, tile: 7, nation: 0, holder: '2,0,3', tiles: 7 }, { site: 7, tile: 26, nation: 2, holder: '2,0,7', tiles: 4 }], openedTurn: 41, ceiling: 24 };
  assert.equal(claim.length, 61);
  const me = { holder: '2,0,3', nation: 0, tiles: 12, villageTiles: 7, bannerTiles: 5, banners: [{ p: 2, q: 0, slot: 1, pole: 16, tiles: 5, frayed: false }], bannersHeld: 1, cap: 5, perProvince: 2 };
  const viewer = { nation: 0, villages: [{ p: 2, q: 0, site: 3, tile: 7 }], ownsHost: id => String(id).startsWith('1264438371942') };
  const M = protoBoardModel({ sample: SAMPLE, provinces: [{ p: 2, q: 0, land: real }], me, viewer, events: [{ seq: '854', chainSlot: 128757, kind: 'PROTO_LAND', proto: true, op: 'RAISE', turn: 45, p: 2, q: 0, slot: 1, pole: 16, nation: 0, holder: '2,0,3', tiles: [16, 23, 15, 9, 17], from: null, works: 0, by: '2,0,3', host: '126443837194250', firm: true }] });
  const mine = M.banners.find(b => b.mine);
  assert.equal(mine.key, '2,0,1'); assert.equal(mine.walk.every, 432); assert.equal(M.mine.total, 12); assert.equal(M.mine.villageTiles, 7);
  assert.equal(M.banners.find(b => !b.mine).nation, 2);
  // the other village's land is named by the land record itself
  assert.deepEqual(M.villages.map(v => [v.site, v.nation, v.mine, v.tiles.length]).sort(), [[3, 0, true, 7], [7, 2, false, 4]]);
  // the claim in progress: its flower from the record's own patch
  const up = M.rising[0];
  assert.deepEqual([up.mine, up.dial.left, up.dial.ready, up.flower.length, up.tail.length], [true, 0, true, 5, 0]);
  // the trail, as walked: the step beside the host (tile 32) last
  const at = tileHex(2, 0, 32), tr = M.trails[0];
  assert.ok(hexDistance(tr.tiles.at(-1).q, tr.tiles.at(-1).r, at.q, at.r) <= hexDistance(tr.tiles[0].q, tr.tiles[0].r, at.q, at.r));
  assert.deepEqual([M.events[0].op, M.events[0].key, M.events[0].mine, M.events[0].hexes.length], ['RAISE', '2,0,1', true, 5]);
  // where a banner can be widened today: the viewer's own record says it host by host
  const buds = protoBoardModel({ sample: SAMPLE, provinces: [{ p: 2, q: 0, land: real }], me: { ...me, hosts: [{ host: '126443837194247', p: 2, q: 0, tile: 32, dress: [{ slot: 1, tiles: [31], code: null }] }, { host: '126443837194250', p: 2, q: 0, tile: 16, dress: [{ slot: 1, tiles: [], code: null }] }] }, viewer }).buds;
  assert.deepEqual(buds.map(b => [b.idx, b.slot]), [[31, 1]]); assert.equal(M.buds.length, 0);
  // mine by the player key alone (the viewer's record not read yet): the village's "P,Q,site"
  assert.equal(protoBoardModel({ sample: SAMPLE, provinces: [{ p: 2, q: 0, land: real }], me: null, viewer: { ...viewer, holders: ['2,0,3'] } }).banners.filter(b => b.mine).length, 1);
});
