// The banner rule's PROTOTYPE, the loss states (a DESIGN: not in the program, the rules crate or the ABI; the sample
// world plays it only when it is started with claims=1). On 2026-10-11 each state was reached on REAL records of the
// sample world through the page's own controls, at 1440 x 900 and 390 x 844: a banner of the viewer's threatened to
// the end, taken, pulled down, frayed, walked back and lapsed; another nation's banner taken and pulled down by the
// viewer; the cap by tier and the ceiling abroad. These tests pin what that play found and what was fixed for it,
// each at the place where the fault was made:
//
//   whose a banner is   the two records (the land's, the viewer's) are read a moment apart: a banner the viewer had
//                       just TAKEN was "the viewer's, under the other nation" for one model, and the board played the
//                       viewer's own taking as 「あなたの旗がアステルに取られました」; the hand told the viewer's own host
//                       on that pole as a threat, 「いつ取られてもおかしくありません」
//   a threat's words    a host that can only pull the banner down was said to "take" it; a count that was done showed
//                       the tick of a count of the viewer's own; a banner that was taken kept its threat's notice
//   the gold line       a threat's hatch and outline lie on the land: the line of "yours" is drawn after them, whole
//   the kept place      the sample world's tag and the chip of the prototype rule: no label of the board, no word of
//                       an effect, no leader's dot, no card and no layer of the page may enter it
//   a seal's survey     the destination and the tiles round it come out of the chart in colour: said once, truthfully
//   the pointer home    it keeps off the viewer's own land and off a threat's count; with no such place it is put away
//   the notices         a summary that sums only live lines of the prototype is no notice; a walk that mends a frayed
//                       banner is said; a frayed banner stays among what the turn holds; one sentence for a lapse
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CLAIM, protoBoardModel } from '../../permutation-server/web/frontier/proto/board-model.mjs';
import { ProtoBoard } from '../../permutation-server/web/frontier/map/protoboard.mjs';
import * as PL from '../../permutation-server/web/frontier/map/protoland.mjs';
import { PROTO_WORDS } from '../../permutation-server/web/frontier/map/protowords.mjs';
import { createLabelPass } from '../../permutation-server/web/frontier/map/labelpass.mjs';
import { KEPT_SELECTORS, KEPT_AIR } from '../../permutation-server/web/frontier/map/fmap.mjs';
import { clearOfLand, slideClear, tabBox } from '../../permutation-server/web/frontier/map/homepointer.mjs';
import { anchorsOf, buildSurvey, gainCause, surveyGain } from '../../permutation-server/web/frontier/map/survey.mjs';
import { KEPT_PIECES, freeFrom, keptAt, keptBoxes, leaveBox } from '../../permutation-server/web/frontier/fx/safe.mjs';
import { playGain } from '../../permutation-server/web/frontier/fx/stage.mjs';
import { bus } from '../../permutation-server/web/frontier/fx/bus.mjs';
import { hudInsets } from '../../permutation-server/web/frontier/hud/insets.mjs';
import * as feed from '../../permutation-server/web/frontier/hud/feed.mjs';
import * as protoHud from '../../permutation-server/web/frontier/hud/proto.mjs';
import * as pm from '../../permutation-server/web/frontier/proto/hand-model.mjs';
import { NATION_FILL } from '../../permutation-server/web/frontier/palette.mjs';
import { hostId } from '../../permutation-server/web/frontier/faddr.mjs';
import { tileHex } from '../../permutation-server/web/frontier/fgeo.mjs';
import { EN, setLang } from '../../permutation-server/web/lang.mjs';

afterEach(() => setLang('ja'));
const WEB = new URL('../../permutation-server/web/frontier/', import.meta.url);
const read = f => readFileSync(new URL(f, WEB), 'utf8');
const text = x => [x].flat(Infinity).map(String).join('').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const HOME = { p: 2, q: 0, site: 3, gen: 1, tile: 30 };
const hid = seq => String(hostId({ ...HOME, seq }));
const ME_KEY = '2,0,3', CINDER = '2,0,7';
const LABEL = { ja: '試作ルール：旗（設計のみ・プログラム未実装）', en: 'Prototype rule: banners (design only, not in the program)' };
const CLAIMS = { rule: 'standing-ground', version: 'design-2026-10-10-r2', label: LABEL, scoreNote: { ja: 'この得点は試作の計算です。チェーンの記録ではありません。', en: 'This score is computed by the prototype. It is not a chain record.' }, numbers: { FALL_LOOSE: 36, FALL_FIRM: 72, WALK_PAY: 2 }, clockLag: 1 };
const SAMPLE = { world: 'sample', turnSecs: 20, proto: { claims: CLAIMS } };
// (the tiles of the real play: the viewer's banner on pole 32, Cinder's on pole 28, in the viewer's home province)
const MINE = [32, 41, 40, 31, 23, 33, 15], THEIRS = [28, 37, 36, 20], VILLAGE = [30, 21, 22, 29, 38, 39, 31].filter(t => !MINE.includes(t));
function land({ r = 62, mine = { nation: 0, holder: ME_KEY }, theirs = { nation: 2, holder: CINDER }, onTheirs = null, onMine = null, frayed = false, walkDue = 476, strikeAt = 548 } = {}) {
  const claim = new Array(61).fill(CLAIM.OPEN);
  for (const t of VILLAGE) claim[t] = HOME.site;
  const banners = [];
  if (mine) { for (const t of MINE) claim[t] = CLAIM.BANNER0 + 1; banners.push({ slot: 1, pole: 32, ...mine, tiles: [...MINE], raisedTurn: 44, tendedTurn: 44, firm: true, border: [], frayed, walkDue, strikeAt, dressedToday: false, elbowLockedUntil: null, contested: onMine }); }
  if (theirs) { for (const t of THEIRS) claim[t] = CLAIM.BANNER0; banners.push({ slot: 0, pole: 28, ...theirs, tiles: [...THEIRS], raisedTurn: 41, tendedTurn: 41, firm: false, border: [], frayed: false, walkDue: 185, strikeAt: 257, dressedToday: false, elbowLockedUntil: null, contested: onTheirs }); }
  return { resolvedNext: r, claim, banners, trails: [], counted: [0, 0, 0, 0, 0, 0], paid: [61, 0, 0, 0, 0, 0], holderNation: 0, rising: [], villages: [{ site: 3, tile: 30, nation: 0, holder: ME_KEY, tiles: VILLAGE.length }] };
}
const VIEWER = { nation: 0, villages: [{ p: 2, q: 0, site: 3, tile: 30 }], ownsHost: id => String(id) === hid(10), holders: [ME_KEY] };
const meOf = slots => ({ holder: ME_KEY, nation: 0, banners: slots.map(slot => ({ p: 2, q: 0, slot })), cap: 5, perProvince: 2 });
const model = (l, slots = [1], events = []) => protoBoardModel({ sample: SAMPLE, provinces: [{ p: 2, q: 0, land: l }], me: meOf(slots), events, viewer: VIEWER });
/** The page's state as the hand's model reads it. */
function page(l, slots = [1], { nowBell = (l.resolvedNext ?? 62) + 1, log = [] } = {}) {
  const FS = { nowBell, chain: { rate: 30 }, sample: { world: 'sample', rate: 30 }, citizen: { faction: 0 }, holdings: [{ ...HOME }], provinces: new Map(), feed: [], orders: [] };
  FS.proto = pm.emptyState(CLAIMS); FS.proto.lands.set('2,0', l); FS.proto.me = { ...meOf(slots), tiles: 20, villageTiles: 7, perTurn: 20, hosts: [] }; FS.proto.log = log;
  return FS;
}
/** A context that records every call and every property set, and paints nothing. */
function recorder() {
  const log = [];
  const show = a => (a && typeof a === 'object' ? (Array.isArray(a) ? `[${a.map(show).join(',')}]` : `<${a.constructor?.name ?? 'o'}>`) : typeof a === 'number' ? String(Math.round(a * 100) / 100) : String(a));
  return new Proxy({ canvas: {} }, {
    get: (t, k) => (k === 'log' ? log : k in t ? t[k] : /Gradient$|createPattern/.test(String(k)) ? () => ({ addColorStop() {} }) : k === 'measureText' ? s => ({ width: String(s).length * 7 }) : (...a) => { log.push(`${String(k)}(${a.map(show).join(',')})`); }),
    set: (t, k, v) => { t[k] = v; log.push(`${String(k)}=${show(v)}`); return true; } });
}
const hadPath = globalThis.Path2D;
globalThis.Path2D = class Path2D { moveTo() {} lineTo() {} closePath() {} rect() {} arc() {} ellipse() {} addPath() {} };
test.after(() => { if (hadPath) globalThis.Path2D = hadPath; else delete globalThis.Path2D; });
const VIEWER_HOST_ON_THEIRS = { nation: 0, host: hid(10), troops: 300, sinceTurn: 44, tolls: 18, canTakeAtTurn: 62, hasFloor: true, onlyPull: null };

// ------------------------------------------------------------------ whose a banner is
test('the viewer takes a banner: read a moment apart, the two records never make it "the viewer\'s, under the other nation"; the board plays ONE moment, the viewer\'s gain', () => {
  const before = land({ onTheirs: VIEWER_HOST_ON_THEIRS });
  // the viewer's own record already lists the banner; its land record is still the one from before the order
  const apart = model(before, [0, 1]);
  const b = apart.banners.find(x => x.slot === 0);
  assert.deepEqual([b.mine, b.nation, b.contested.byViewer], [false, 2, true], 'a banner the land record puts under another nation is not the viewer\'s yet');
  assert.equal(apart.mine.total, VILLAGE.length + MINE.length, 'and its tiles are not in the gold line yet');
  // the land record after the TAKE: the viewer's nation, the viewer as holder; the host still stands on its pole
  const after = land({ r: 63, theirs: { nation: 0, holder: ME_KEY }, onTheirs: null });
  const told = [], off = bus.on('proto:land', e => told.push(e));
  try {
    const B = new ProtoBoard();
    B.set(model(before, [1]), { now: 0 });
    B.set(apart, { now: 100 });
    assert.equal(B.moments.size, 0, 'nothing plays for the moment the two records disagree');
    B.set(model(after, [0, 1], [{ kind: 'PROTO_LAND', proto: true, seq: 9, op: 'TAKE', turn: 62, p: 2, q: 0, slot: 0, pole: 28, nation: 0, holder: ME_KEY, from: 2, host: hid(10), tiles: THEIRS }]), { now: 200 });
    assert.deepEqual(told.map(e => [e.kind, e.mine, e.wasMine, e.from, e.nation]), [['taken', true, false, 2, 0]], 'one moment: taken FROM Cinder BY the viewer');
    const m = [...B.moments.values()][0];
    assert.equal(m.wasMine, false, 'never a loss of the viewer\'s');
  } finally { off?.(); }
  // (a banner of the viewer's nation with a host of that nation on its pole is no contest at all)
  const own = land({ theirs: { nation: 0, holder: ME_KEY }, onTheirs: VIEWER_HOST_ON_THEIRS });
  assert.equal(model(own, [0, 1]).banners.find(x => x.slot === 0).contested, null);
});

test('the hand: the viewer\'s own host on the pole of a banner the viewer has just taken is no threat, and a banner the land record still gives another holder is not threatened "as the viewer\'s"', () => {
  // the land record a moment after the take, as the sample world served it on 2026-10-11: still Cinder's, the viewer's host on its pole
  const apart = page(land({ onTheirs: VIEWER_HOST_ON_THEIRS }), [0, 1]);
  assert.deepEqual(pm.threatsOf(apart), [], 'not 「あなたの旗が狙われています。いつ取られてもおかしくありません」');
  // and after it: the viewer's, nobody hostile on it
  assert.deepEqual(pm.threatsOf(page(land({ theirs: { nation: 0, holder: ME_KEY } }), [0, 1])), []);
  // a real threat is still one, with its count
  const cinder = { nation: 2, host: 'cinder-host', troops: 500, sinceTurn: 54, tolls: 36, canTakeAtTurn: 90, hasFloor: true, onlyPull: null };
  const t = pm.threatsOf(page(land({ onMine: cinder })));
  assert.deepEqual([t.length, t[0].kind, t[0].left, t[0].text], [1, 'take', 28, 'あなたの旗が狙われています。あと28ターン（約9分）で取られます']);
  assert.equal(pm.bannerLines(page(land({ theirs: { nation: 0, holder: ME_KEY }, onTheirs: VIEWER_HOST_ON_THEIRS }), [0, 1]), 2, 0, land({ theirs: { nation: 0, holder: ME_KEY }, onTheirs: VIEWER_HOST_ON_THEIRS }).banners[1], 62).some(x => /狙われて/.test(x.text)), false, 'nor on that banner\'s own card');
});

// ------------------------------------------------------------------ a threat's words
test('a threat says what the record lets the host on the pole do: one that can only pull the banner down is never said to take it (the notice, This Turn, the card, the board), in English too', () => {
  const pull = { nation: 2, host: 'cinder-host', troops: 500, sinceTurn: 54, tolls: 72, canTakeAtTurn: 126, hasFloor: true, onlyPull: 'place' };
  const FS = page(land({ onMine: pull }));
  assert.equal(pm.threatsOf(FS)[0].text, 'あなたの旗が狙われています。あと64ターン（約21分）で倒されます');
  assert.equal(pm.threatsOf(FS)[0].onlyPull, 'place');
  assert.match(text(protoHud.turnItems(FS).map(x => x.text)), /試作：あなたの旗が狙われています。あと64ターン（約21分）で倒されます/);
  assert.equal(pm.bannerLines(FS, 2, 0, land({ onMine: pull }).banners[0], 62).find(x => x.tone === 'bad').text, 'あなたの旗が狙われています。あと64ターン（約21分）で倒されます');
  const done = page(land({ r: 126, onMine: pull }));
  assert.equal(pm.threatsOf(done)[0].text, 'あなたの旗が狙われています。いつ倒されてもおかしくありません');
  // the board's model carries what the record says, and its words follow
  const M = model(land({ onMine: pull }));
  assert.equal(M.banners.find(b => b.mine).contested.onlyPull, 'place');
  assert.equal(PROTO_WORDS.threat(64, 20, true), 'あなたの旗が狙われています。あと64ターンで倒されます（約21分）');
  assert.equal(PROTO_WORDS.threatReady(true), 'あなたの旗が狙われています。いつ倒されてもおかしくありません');
  assert.equal(PROTO_WORDS.threat(27, 20), 'あなたの旗が狙われています。あと27ターンで取られます（約9分）', 'a host that can take it: as before');
  assert.notEqual(M.rev, model(land({ onMine: { ...pull, onlyPull: null } })).rev, 'a record that changes what the host may do is a new model');
  setLang('en');
  assert.equal(pm.threatsOf(FS)[0].text, 'Your banner is under threat: it can be pulled down in 64 turns (about 21 min real time)');
  assert.equal(pm.threatsOf(done)[0].text, 'Your banner is under threat: it can be pulled down at any moment');
  assert.equal(PROTO_WORDS.threat(1, 20, true), 'Your banner is under threat: it can be pulled down in 1 turn');
});

test('the count of a threat that is done shows an alarm mark, never the tick of a count of the viewer\'s own; the sentence of a banner in hand stands in two lines on a narrow screen', () => {
  const tick = recorder(), alarm = recorder();
  PL.paintTurnDial(tick, 0, 0, { left: 0, total: 18, share: 1, colour: PL.GOLD });
  PL.paintTurnDial(alarm, 0, 0, { left: 0, total: 36, share: 1, colour: NATION_FILL[2], alarm: true });
  assert.ok(tick.log.includes('lineJoin=round'), 'the viewer\'s own count that is done: a tick (a stroked line with round joins)');
  assert.ok(!alarm.log.includes('lineJoin=round'), 'a threat that is done: no tick');
  assert.ok(alarm.log.filter(x => x.startsWith('fill(')).length > tick.log.filter(x => x.startsWith('fill(')).length, 'an exclamation mark, filled');
  const n27 = recorder(); PL.paintTurnDial(n27, 0, 0, { left: 27, total: 36, share: 0.25, alarm: true });
  assert.ok(n27.log.some(x => x.startsWith('fillText(27')), 'while the count runs: the turns left, as before');
  const src = read('map/protoboard.mjs');
  assert.match(src, /key: `th:\$\{b\.key\}`[^\n]*alarm: true[^\n]*wrap: 0\.7/, 'a threat on a banner of the viewer\'s: the alarm dial, its sentence wrapped');
  assert.match(src, /key: `fo:\$\{r\.key\}`[^\n]*alarm: true/, 'another nation\'s banner about to rise: the alarm dial');
  assert.doesNotMatch(src, /key: `(rs|tk):[^\n]*alarm: true/, 'the viewer\'s own counts keep their tick');
});

test('a banner that was taken, pulled down or defended keeps no threat\'s notice: an alarm whose threat stands no longer is no notice; a summary of nothing but live lines of the prototype is no notice either', () => {
  const now = 1_000_000, at = now - 1000;
  const alarm = { id: 'th:1,1,1:54', kind: 'proto', proto: true, alarm: true, at, text: 'あなたの旗が狙われています。いつ取られてもおかしくありません' };
  const taken = { id: 'pl:911', kind: 'proto', proto: true, at, lost: 5, text: 'あなたの旗がシンダーに取られました' };
  const sum = { id: 'sum:91', kind: 'summary', at, items: ['pl:911'], text: 'ターン 91 のまとめ：旗（試作） 1' };
  assert.deepEqual(feed.liveToasts([sum, taken, alarm], { now, standing: new Set() }).map(x => x.id), ['pl:911'], 'the loss alone: its threat is gone, and its summary says less than it does');
  assert.deepEqual(feed.liveToasts([alarm, taken], { now, standing: new Set(['th:1,1,1:54']) }).map(x => x.id), ['th:1,1,1:54', 'pl:911'], 'a threat that stands is first');
  // with the prototype off nothing changes: no standing set, no line of the prototype
  const battle = { id: 'b:1', kind: 'battle', at, text: '戦い' }, sum2 = { id: 'sum:42', kind: 'summary', at, items: ['b:1'], text: 'ターン 42 のまとめ：戦い 1' };
  assert.deepEqual(feed.liveToasts([sum2, battle], { now }).map(x => x.id), ['sum:42', 'b:1'], 'the basic game\'s summary stands as it did');
  assert.deepEqual(feed.liveToasts([alarm], { now }).map(x => x.id), ['th:1,1,1:54'], 'no standing set given: an alarm is a notice like any other');
  // a summary that also sums a battle stays
  assert.deepEqual(feed.liveToasts([{ ...sum, items: ['pl:911', 'b:1'] }, taken, battle], { now, standing: new Set() }).map(x => x.id), ['sum:91', 'pl:911', 'b:1']);
});

// ------------------------------------------------------------------ the gold line
test('a threat lies on the land and the gold line of "yours" is drawn after it, whole: Cinder\'s yellow hatch and outline never run over the line', () => {
  const cinder = { nation: 2, host: 'cinder-host', troops: 500, sinceTurn: 54, tolls: 36, canTakeAtTurn: 90, hasFloor: true, onlyPull: null };
  const B = new ProtoBoard();
  B.set(model(land({ onMine: cinder })), { now: 0 });
  const g = recorder();
  B.groundLive(g, { z: 1, fx: 1000, still: true });
  const last = v => g.log.lastIndexOf(`strokeStyle=${v}`), gold = last(PL.GOLD), foe = last(NATION_FILL[2]);
  assert.ok(foe >= 0 && gold > foe, 'the last line drawn is the gold line');
  assert.ok(g.log.slice(gold).includes('stroke(<Path2D>)'), 'stroked along the land\'s own edge');
  assert.ok(g.log.slice(gold).every(x => !x.startsWith('setLineDash([') || x === 'setLineDash([])'), 'whole: no dash');
  // the outline of land the viewer holds is drawn inside the land (clipped to its fill), a band within the line's underlay
  const held = recorder(), open = recorder();
  const tiles = MINE.map(i => { const h = tileHex(2, 0, i); return { q: h.q, r: h.r }; });
  PL.paintThreatGround(held, tiles, tiles[0], { colour: NATION_FILL[2], still: true, held: true });
  PL.paintThreatGround(open, tiles, tiles[0], { colour: NATION_FILL[2], still: true });
  assert.equal(held.log.filter(x => x.startsWith('clip(')).length, 2, 'the hatch and the outline, both inside the land');
  assert.equal(open.log.filter(x => x.startsWith('clip(')).length, 1, 'a threat on ground that is nobody\'s yet: its outline as before');
  // the viewer's own count on another's banner (gold) lays no second gold line round the viewer's land
  const B2 = new ProtoBoard(); B2.set(model(land({ onTheirs: VIEWER_HOST_ON_THEIRS })), { now: 0 });
  const g2 = recorder(); B2.groundLive(g2, { z: 1, fx: 1000, still: true });
  assert.ok(g2.log.includes(`strokeStyle=${PL.GOLD}`), 'the count on their banner is drawn in gold');
  assert.equal(B2.mineOuter(), B2.mineOuter(), 'the land\'s edge is made once per model');
});

// ------------------------------------------------------------------ the kept place
test('the kept place: a no-go rectangle marked `hard` holds no label of the board, not even one that is never left out; the map measures the tag and the chip itself', () => {
  const chip = { x: 376, y: 60, w: 290, h: 25, hard: true }, plain = { x: 376, y: 60, w: 290, h: 25 };
  const box = { x: 500, y: 62, w: 400, h: 22 };   // (a long sentence over a pole that is seen right under the chip)
  const hits = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  const at = (nogo, opts) => { const mv = createLabelPass({ nogo, bounds: { w: 1440, h: 900 } }).place(700, 73, box, opts); return mv && { x: box.x + mv.dx, y: box.y + mv.dy, w: box.w, h: box.h }; };
  // a label that is never left out stayed under a piece of the HUD when no place lay within reach of it…
  const stuck = at([plain, { x: 0, y: 0, w: 1440, h: 60 }, { x: 0, y: 85, w: 1440, h: 300 }], { keep: true });
  assert.ok(hits(stuck, plain), 'the old behaviour, for a piece that is not a kept place');
  // …but never in a kept place: it goes out by the shortest way, however far that is
  const out = at([chip, { x: 0, y: 0, w: 1440, h: 60 }, { x: 0, y: 85, w: 1440, h: 300 }], { keep: true });
  assert.ok(!hits(out, chip), 'out of the chip');
  assert.ok(out.y + out.h > 0 && out.y < 900, 'and still in the picture');
  // (and whole in the picture when a way out leaves it whole: the shortest way out of a chip right under the top of the screen
  // is up, where the screen cuts the label in half — the English recording of 2026-10-11; it goes down instead)
  const high = { x: 300, y: 6, w: 380, h: 26, hard: true }, lab = { x: 440, y: 2, w: 230, h: 22 };
  const uncut = (nogo, opts = { keep: true }) => { const mv = createLabelPass({ nogo, bounds: { w: 1440, h: 900 } }).place(560, 120, lab, opts), at = { ...lab, x: lab.x + mv.dx, y: lab.y + mv.dy }; return !hits(at, high) && at.y >= 0 && at.y + at.h <= 900 && at.x >= 0 && at.x + at.w <= 1440; };
  assert.ok(uncut([high]), 'out of the chip and not cut by the screen (a place within reach)');
  assert.ok(uncut([high, { x: 0, y: 32, w: 1440, h: 120 }]), 'and when the nearest whole place is far, under another piece of the HUD: whole all the same');
  // two kept places side by side (the tag and the chip): out of both
  const tag = { x: 54, y: 68, w: 232, h: 28, hard: true };
  const both = createLabelPass({ nogo: [tag, { ...chip, x: 290, w: 380 }], bounds: { w: 1440, h: 900 } });
  const b2 = { x: 200, y: 70, w: 300, h: 22 }, mv = both.place(350, 81, b2, { keep: true }), placed = { ...b2, x: b2.x + mv.dx, y: b2.y + mv.dy };
  assert.ok(!hits(placed, tag) && !hits(placed, { ...chip, x: 290, w: 380 }));
  // `hud`: the count of a threat stands clear of the HUD first, over another label, when nothing is free of both
  const notice = { x: 8, y: 186, w: 374, h: 132 }, piece = { x: 100, y: 300, w: 120, h: 60 };
  const crowded = () => { const P = createLabelPass({ nogo: [notice], bounds: { w: 390, h: 786 } }); P.block(0, 0, { x: 0, y: 318, w: 390, h: 200 }); return P; };
  const stays = crowded().place(160, 400, piece, { keep: true }), clears = crowded().place(160, 400, piece, { keep: true, hud: true });
  assert.deepEqual([stays.dx, stays.dy], [0, 0], 'a label that is never left out stays under the notice when the labels beside it are taken');
  assert.ok(piece.y + clears.dy >= notice.y + notice.h, 'a threat\'s count comes out from under the notice');
  assert.match(read('map/protoboard.mjs'), /\{ keep: true, hud: alarm \}/, 'asked for by a threat\'s dial alone');
  // a label that may be left out is left out or moved, as before
  const loose = at([chip], { keep: false });
  assert.ok(loose === null || !hits(loose, chip));
  // the map's own list: the tag, the page's chip (any element with data-proto-chip) and the map's own chip
  assert.equal(KEPT_SELECTORS, '#sample-tag, [data-proto-chip], .proto-chip-map');
  assert.ok(KEPT_AIR >= 2);
  const src = read('map/fmap.mjs');
  assert.match(src, /for \(const el of doc\.querySelectorAll\(KEPT_SELECTORS\)\)[\s\S]{0,400}hard: true/, 'measured by the map whatever the page fed, and marked hard');
});

test('the kept place and the effects: no word of an effect stands on the tag or the chip, a caption\'s dot is not drawn in them, and they never step back for a set piece', () => {
  assert.deepEqual([...KEPT_PIECES], ['#sample-tag', '[data-proto-chip]', '.proto-chip-map']);
  const stage = { left: 0, top: 0, width: 1440, height: 900 };
  const chip = { left: 376, top: 60, width: 290, height: 25, kind: 'fixed', kept: true };
  const F = freeFrom(stage, [{ left: 0, top: 0, width: 1440, height: 52 }, chip, { left: 12, top: 64, width: 304, height: 280, kind: 'ghost' }]);
  assert.equal(F.kept.length, 1);
  // a caption that wants to stand on the chip is moved off it
  const at = F.place(520, 72, 150, 26, 5);
  assert.ok(at.moved && (at.y - 13 >= 85 || at.y + 13 <= 60 || at.x - 75 >= 666 || at.x + 75 <= 376), 'the tag\'s plate is off the chip');
  // …for a set piece too (the corner pieces step back; a kept place does not)
  const st = F.placeStage(520, 72, 150, 26, 5);
  assert.ok(st.moved, 'a kept place is `fixed`: it stays for a set piece');
  // the tile under the chip: no dot there, the leader begins at the chip's edge
  const kept = keptAt(F.kept, 380, 72);
  assert.ok(kept, 'a point on the chip\'s first character');
  assert.equal(keptAt(F.kept, 380, 120), null);
  const edge = leaveBox({ x: 380, y: 72 }, { x: 380, y: 160 }, kept);
  assert.deepEqual([edge.x, edge.y], [380, 87], 'where the leader leaves the chip (2 px of air)');
  assert.deepEqual(leaveBox({ x: 380, y: 72 }, { x: 390, y: 75 }, kept).t, 1, 'a plate that is itself in the place: no leader');
  // a page: the kept places are measured beside the HUD's own list, whatever it lists
  const el = (r, hidden = false) => ({ hidden, getBoundingClientRect: () => ({ left: r[0], top: r[1], right: r[0] + r[2], bottom: r[1] + r[3], width: r[2], height: r[3] }) });
  const doc = { defaultView: { getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) }, querySelectorAll: sel => (sel === '#sample-tag' ? [el([54, 68, 232, 28])] : sel === '[data-proto-chip]' ? [el([376, 60, 290, 25]), el([0, 0, 10, 10], true)] : []) };
  assert.deepEqual(keptBoxes(doc).map(b => [b.left, b.top, b.kind, b.kept]), [[54, 68, 'fixed', true], [376, 60, 'fixed', true]]);
  const fx = read('fx/effects.mjs'), css = read('fx/fx.css');
  assert.match(fx, /const kept = keptAt\(s\.free\.kept, A\.x, A\.y\)/); assert.match(fx, /el\.dataset\.blind = '1'/);
  assert.match(css, /\.fx-tag\[data-blind\] \.fx-tag-dot \{ display: none; \}/);
  assert.match(read('fx/safe.mjs').replace(/\s+/g, ' '), /out\.push\(\.\.\.keptBoxes\(doc\)\); return out; \}[\s\S]*out\.push\(\.\.\.keptBoxes\(doc\)\); return out; \}/, 'both readings of the HUD carry the kept places');
});

test('the kept place and the page: the chip is the page\'s top layer, the stores\' pop-over opens under the tag\'s row, and a phone\'s tag and chip stand clear of the dial and of the buttons', () => {
  const css = read('proto-board.css'), frontier = read('frontier.css'), fxcss = read('fx/fx.css'), hand = read('proto-hand.css');
  const z = (src, sel) => Number((src.match(new RegExp(`${sel.replace(/[.#[\]"=]/g, '\\$&')}\\s*\\{[^}]*z-index:\\s*(\\d+)`)) ?? [])[1]);
  const chipZ = z(css, '.hud-proto-chip, .proto-chip-map');
  assert.equal(chipZ, 75);
  for (const [name, n] of [['the effects\' layer', z(fxcss, '.fx-hud')], ['a milestone\'s banner', z(frontier, '.mile-banner')], ['the stores\' pop-over', z(frontier, '.res-pop')], ['the dial\'s card', z(frontier, '.dial-pop')], ['the top strip', z(frontier, '.topbar')]]) {
    assert.ok(Number.isFinite(n) && n < chipZ, `${name} (${n}) lies under the chip`);
  }
  // (every z-index of the page is under it: nothing new can be laid over the label without this test saying so)
  for (const src of [frontier, fxcss, hand]) for (const m of src.matchAll(/z-index:\s*(\d+)/g)) assert.ok(Number(m[1]) < chipZ, `z-index ${m[1]} is under the chip`);
  assert.match(css, /body\[data-proto="banners"\] \.res-pop \{ top: calc\(var\(--strip\) \+ 56px\); \}/, 'under the tag and the chip on a wide screen');
  const phone = css.slice(css.indexOf('@media (max-width: 759px)'));
  // (rewritten at the merge of 2026-10-11. The old expectation pinned this sheet's own layout of the phone's tag,
  // `flex-direction: column … max-width: calc(100vw - 252px)`. It was wrong once the phone pass's layout of the same
  // tag (proto-hand.css, the more specific selector) was in the page: that rule won, this one never applied, and the
  // tag slid under the dial's rim again while this pin still passed — the browser test "the kept place @ 390" said
  // so. The tag is laid out by ONE rule now, the hand sheet's, with a width that ends it before the dial's left
  // edge; this sheet keeps only the row's height. Both are pinned.)
  assert.match(phone, /body\[data-proto="banners"\] \.sample-tag \{ min-height: 36px; \}/, 'the tag\'s row is two lines tall, so the chip under it does not move');
  assert.equal([...css.matchAll(/\.sample-tag[^{]*\{([^}]*)\}/g)].filter(m => /max-width|flex-direction|display/.test(m[1])).length, 0, 'this sheet does not lay the tag out a second time');
  assert.match(hand, /:is\(body\[data-proto="banners"\], html\[lang="en"\] body\) \.sample-tag \{ display: block; max-width: calc\(50vw - var\(--edge\) - var\(--target\) - 2px\);/, 'the one rule: the tag ends before the dial\'s left edge (the dial stands 12 px right of the middle)');
  assert.match(phone, /body\[data-proto="banners"\] \.hud-proto-chip \{[^}]*left: calc\(var\(--edge\) \+ var\(--target\) \+ 6px\); right: calc\(var\(--edge\) \+ 88px\)[^}]*white-space: normal[^}]*overflow: visible/, 'the chip between the two columns of buttons, its words whole');
  assert.match(phone, /body\[data-proto="banners"\] \.res-pop \{ top: calc\(var\(--strip\) \+ 80px\); \}/);
  // every rule of it is the prototype's: with the switch off the page is the page it was
  for (const line of css.slice(css.indexOf('THE KEPT PLACE'), css.indexOf('the legend\'s entries')).split('\n').filter(l => /\{/.test(l) && !/^\s*\/\*|@media/.test(l))) assert.match(line, /proto|hp-away/, line.trim().slice(0, 60));
  // the sheet is linked after the hand's, so that its rules for the chip hold
  const html = read('index.html');
  assert.ok(html.indexOf('proto-board.css') > html.indexOf('proto-hand.css'));
});

// ------------------------------------------------------------------ a seal's survey
test('sealing a march surveys its destination and the six tiles round it: with the prototype on the chip says once that this is a survey and not land', () => {
  const villages = [{ p: 2, q: 0, tile: 7, tier: 1 }];
  const before = buildSurvey({ ringsOpen: 3, anchors: anchorsOf({ villages }) });
  const after = buildSurvey({ ringsOpen: 3, anchors: anchorsOf({ villages, destinations: [{ p: 1, q: 1, tile: 47 }] }) });
  const g = surveyGain(before, after);
  assert.equal(g.n, 7, 'the destination and its six neighbours');
  assert.equal(gainCause(after, g), 'destination');
  assert.equal(gainCause(after, { q: 999, r: 999 }), null); assert.equal(gainCause(after, null), null);
  const host = buildSurvey({ ringsOpen: 3, anchors: anchorsOf({ villages, hosts: [{ p: 1, q: 1, tile: 47, unit: 0 }] }) });
  assert.equal(gainCause(host, surveyGain(before, host)), 'host', 'a host that arrived is told as before');
  const said = a => { const out = []; playGain({ play: (name, x) => { if (name === 'tag') out.push([x.text, x.dur]); }, sound() {} }, a); return out[0]; };
  assert.deepEqual(said({ n: 7, q: g.q, r: g.r, seq: 1, kind: 'destination', claims: true }), ['+7 マス測量（土地ではありません）', 4.2], 'surveyed, not owned');
  assert.deepEqual(said({ n: 7, q: g.q, r: g.r, seq: 1, kind: 'destination', claims: false }), ['+7 マス測量', 2.8], 'with the prototype off: the words and the time they stood');
  assert.deepEqual(said({ n: 19, q: g.q, r: g.r, seq: 2, kind: 'host', claims: true }), ['+19 マス測量', 2.8], 'only the seal\'s own survey says it');
  assert.equal(EN['+{0} マス測量（土地ではありません）'](7), '+{0} tiles surveyed (not your land)'); assert.equal(EN['+{0} マス測量（土地ではありません）'](1), '+{0} tile surveyed (not your land)');
  assert.match(read('map/fmap.mjs'), /fxEmit\('survey:gain', \{ n: g\.n, q: g\.q, r: g\.r, seq: g\.seq, faction, kind: g\.kind \?\? null, claims: this\.proto\.on \}\)/);
});

// ------------------------------------------------------------------ the pointer home
test('the pointer home keeps off the viewer\'s own land and off a threat\'s count; with no place off them on its edge it is put away', () => {
  const place = { edge: 'top', x: 200, y: 100, box: { x0: 0, y0: 100, x1: 390, y1: 600 } };
  const box = tabBox(place, { w: 120, h: 44 });
  const land1 = [{ x: 150, y: 90, w: 110, h: 80 }];
  const hits = (b, a) => b.x + b.w > a.x && b.x < a.x + a.w && b.y + b.h > a.y && b.y < a.y + a.h;
  assert.ok(hits(slideClear(place, box, []), land1[0]), 'it lay on the land');
  const off = clearOfLand(place, box, [], land1);
  assert.ok(off && !hits(off, land1[0]), 'it slides along its edge until it is off the land');
  assert.equal(clearOfLand(place, box, [], [{ x: -50, y: 0, w: 600, h: 400 }]), null, 'the edge is all the viewer\'s land: put away');
  assert.deepEqual(clearOfLand(place, box, [], []), slideClear(place, box, []), 'no land (the prototype is off): exactly as before');
  // the board says where its alarms' counts stand
  const cinder = { nation: 2, host: 'cinder-host', sinceTurn: 54, canTakeAtTurn: 90, onlyPull: null };
  const B = new ProtoBoard(); B.set(model(land({ onMine: cinder })), { now: 0 });
  assert.equal(B.alarmSpots(1).length, 1);
  const calm = new ProtoBoard(); calm.set(model(land({ onTheirs: VIEWER_HOST_ON_THEIRS })), { now: 0 });
  assert.equal(calm.alarmSpots(1).length, 0, 'the viewer\'s own count on another\'s banner is no alarm');
  const src = read('map/fmap.mjs'), hp = read('map/homepointer.mjs'), css = read('proto-board.css');
  assert.match(src, /land: at \? this\.ownLandBoxes\(size\) : \[\]/); assert.match(src, /const tiles = this\.proto\.on \? this\.proto\.model\?\.mine\?\.tiles \?\? \[\] : \[\];/);
  assert.match(hp, /b\.classList\?\.toggle\('hp-away', !box\)/); assert.match(css, /\.home-pointer\.hp-away \{ visibility: hidden; pointer-events: none; \}/);
});

// ------------------------------------------------------------------ a phone's free part of the map
test('on a phone with the prototype on, the chip, the score and a notice across the top count as covered: 見る sets a banner down under them no longer', () => {
  const rect = (x, y, w, h) => ({ left: x, top: y, right: x + w, bottom: y + h, width: w, height: h });
  const el = (r, more = {}) => ({ hidden: false, dataset: {}, getBoundingClientRect: () => r, ...more });
  const page = ({ proto = true, notice = true, sheet = true } = {}) => {
    const els = { 'frontier-map': el(rect(0, 0, 390, 844)), topbar: el(rect(0, 0, 390, 52)), panel: el(rect(0, 620, 390, 224), { dataset: { drawer: 'closed' } }), 'proto-chip': el(rect(58, 106, 236, 20)), 'proto-score': el(rect(60, 130, 322, 64)), hand: null, 'hand-pop': null };
    return { body: { dataset: proto ? { proto: 'banners' } : {} }, getElementById: id => els[id] ?? null, querySelector: () => null, querySelectorAll: sel => (sel === '#feed > *' && notice ? [el(rect(8, 186, 374, 130))] : []),
      defaultView: { innerWidth: 390, getComputedStyle: e => ({ display: 'block', visibility: 'visible', position: e === els.panel && sheet ? 'absolute' : 'fixed' }) } };
  };
  assert.deepEqual(hudInsets(page()), { top: 316, right: 0, bottom: 224, left: 0 }, 'the free part begins under the notice');
  assert.deepEqual(hudInsets(page({ notice: false })), { top: 194, right: 0, bottom: 224, left: 0 }, 'under the score');
  assert.deepEqual(hudInsets(page({ proto: false })), { top: 52, right: 0, bottom: 224, left: 0 }, 'with the prototype off: as before');
  // (never so much that less than a third of the map's height is left free)
  const tall = page(); tall.querySelectorAll = sel => (sel === '#feed > *' ? [el(rect(8, 186, 374, 400))] : []);
  assert.ok(Math.abs(844 - hudInsets(tall).top - 224 - 844 / 3) < 1, 'a third of the map stays free');
});

// ------------------------------------------------------------------ what the turn holds, and what is said
test('a frayed banner and a walk that is near stay among what the turn holds, with 見る; a walk that mends a banner is said; one sentence for a lapse, on the board and in the notice', () => {
  // a loose banner past its limit, as the sample world served it at turn 204 on 2026-10-11
  const frayed = page(land({ r: 203, frayed: true, walkDue: 203, strikeAt: 275 }));
  const w = pm.walksDue(frayed);
  assert.deepEqual(w.map(x => [x.kind, x.left, x.tile, x.text]), [['frayed', 72, 32, 'あなたの旗がほつれています。あと72ターン（約24分）のうちに見回れば戻ります']]);
  const items = protoHud.turnItems(frayed);
  assert.deepEqual(items.map(x => [x.text, x.go, x.tone]), [['試作：あなたの旗がほつれています。あと72ターン（約24分）のうちに見回れば戻ります', { p: 2, q: 0, tile: 32 }, 'warn']]);
  const soon = page(land({ r: 155, walkDue: 203, strikeAt: 275 }));
  assert.deepEqual(pm.walksDue(soon).map(x => [x.kind, x.left, x.text]), [['walk', 48, 'あなたの旗を、あと48ターン（約16分）のうちに見回ってください']]);
  assert.deepEqual(pm.walksDue(page(land({ r: 154, walkDue: 203 }))), [], 'not before the board itself begins to warn');
  assert.equal(pm.WALK_SOON, PL.PROTO_LOOK.walkSoon, 'the list and the board begin to warn in the same turn');
  // the walk that mended it
  const tend = { seq: 30, op: 'TEND', turn: 208, p: 2, q: 0, slot: 1, pole: 32, nation: 0, holder: ME_KEY, tiles: MINE, by: ME_KEY, host: hid(10) };
  const FS = page(land({ r: 208 }));
  assert.deepEqual([pm.newsOf(FS, { ...tend, restored: true }).text, !!pm.newsOf(FS, { ...tend, restored: true }).quiet], ['旗を見回りました。ほつれが直り、また得点になります', false]);
  assert.equal(pm.newsOf(FS, { ...tend, restored: false }).quiet, true, 'an ordinary walk is a line of the list, as before');
  // (with the mending, the day's pay is a line of the list and no notice of its own: a phone shows one notice)
  const walk = { seq: 31, op: 'WALK', turn: 208, p: 2, q: 0, slot: 1, pole: 32, nation: 0, holder: ME_KEY, tiles: [], works: 2, by: ME_KEY };
  const fresh = log => { const F = page(land({ r: 208 }), [1], { log: [] }); pm.freshNews(F); F.proto.log = log; return pm.freshNews(F).items.map(x => [x.text, !!x.quiet]); };
  assert.deepEqual(fresh([{ ...tend, restored: true }, walk]), [['旗を見回りました。ほつれが直り、また得点になります', false], ['今日最初の見回り：功績 +2', true]]);
  assert.deepEqual(fresh([{ ...tend, restored: false }, walk]), [['旗を見回りました', true], ['今日最初の見回り：功績 +2', false]], 'an ordinary first walk of the day: its pay is the notice, as before');
  // the lapse: the keeper's STRIKE for a banner past its grace
  const strike = { seq: 40, op: 'STRIKE', turn: 424, p: 2, q: 0, slot: 1, pole: 32, nation: 0, holder: ME_KEY, fromHolder: ME_KEY, tiles: MINE, by: 'keeper', reason: 'grace' };
  assert.equal(pm.newsOf(FS, strike).text, PROTO_WORDS.lapsed(MINE.length));
  assert.equal(PROTO_WORDS.lapsed(8), '見回りがなく、あなたの旗がなくなりました（−8マス）');
  assert.equal(pm.newsOf(FS, { ...strike, reason: 'stump' }).text, 'あなたの旗が片づけられました（−7マス）', 'another reason keeps its own sentence');
  // a record read a moment before the clock: its line is stamped with the turn it can be told in, so that turn's list holds it
  const early = page(land({ r: 424, mine: null }), [], { nowBell: 424 });
  assert.equal(pm.newsOf(early, strike).bell, 425, 'settled turn 424, told in turn 425');
  assert.equal(pm.newsOf(page(land({ r: 424, mine: null }), [], { nowBell: 430 }), strike).bell, 430, 'a record read later is told when it is read');
  setLang('en');
  assert.equal(pm.walksDue(frayed)[0].text, 'Your banner is frayed: a walk within 72 turns (about 24 min real time) restores it');
  assert.equal(pm.newsOf(FS, { ...tend, restored: true }).text, 'You walked the banner: it is mended and counts again');
  assert.equal(PROTO_WORDS.lapsed(8), 'Your banner was not walked and has lapsed (−8 tiles)');
});

test('the board\'s moments of a banner that is gone: frayed land drains from its hatch, the viewer\'s own taking down is no loss, and a banner the viewer pulled down is said at its pole', () => {
  const ev = (op, more = {}) => [{ kind: 'PROTO_LAND', proto: true, seq: 50, op, turn: 424, p: 2, q: 0, slot: 1, pole: 32, nation: 0, holder: ME_KEY, tiles: MINE, ...more }];
  // lapsed while frayed
  const B = new ProtoBoard();
  B.set(model(land({ r: 423, frayed: true, walkDue: 352, strikeAt: 424 })), { now: 0 });
  B.set(model(land({ r: 424, mine: null }), [], ev('STRIKE', { by: 'keeper' })), { now: 1000 });
  const m = [...B.moments.values()][0];
  assert.deepEqual([m.kind, m.wasMine, m.frayed, m.own], ['lapsed', true, true, false]);
  const g = recorder(); B.groundLive(g, { z: 1, fx: 1010, still: false });
  assert.ok(!g.log.some(x => x.startsWith('fillStyle=') && /^fillStyle=#e8dcc0/.test(x)), 'no tile is filled solid again (the parchment that levels the ground under a fill is not laid)');
  assert.ok(B.shakeAt(1000 + PL.LOSS.pull.fall + 20) !== 0, 'a loss shakes the board');
  // the viewer's own taking down
  const C = new ProtoBoard();
  C.set(model(land({ r: 100 })), { now: 0 });
  C.set(model(land({ r: 100, mine: null }), [], ev('STRIKE', { by: ME_KEY })), { now: 1000 });
  const own = [...C.moments.values()][0];
  assert.deepEqual([own.kind, own.own], ['lapsed', true]);
  assert.equal(C.shakeAt(1000 + PL.LOSS.pull.fall + 20), 0, 'no shake for what the player chose');
  assert.equal(PROTO_WORDS.struck(7), '旗を取り下げました（−7マス）');
  // another nation's banner pulled down by a host of the viewer's
  const D = new ProtoBoard();
  D.set(model(land({ onTheirs: VIEWER_HOST_ON_THEIRS })), { now: 0 });
  D.set(model(land({ r: 63, theirs: null }), [1], [{ kind: 'PROTO_LAND', proto: true, seq: 51, op: 'PULL', turn: 62, p: 2, q: 0, slot: 0, pole: 28, nation: 2, holder: CINDER, from: 2, host: hid(10), tiles: THEIRS }]), { now: 1000 });
  const pulled = [...D.moments.values()][0];
  assert.deepEqual([pulled.kind, pulled.wasMine, pulled.byViewer], ['pulled', false, true]);
  assert.match(read('map/protoboard.mjs'), /m\.byViewer \? PROTO_WORDS\.pulledTheirs\(\)/);
  assert.equal(PROTO_WORDS.pulledTheirs(), '旗を倒しました');
  // (pulled down by someone else: nothing is said at the pole of a banner that was not the viewer's)
  const E = new ProtoBoard();
  E.set(model(land()), { now: 0 });
  E.set(model(land({ r: 63, theirs: null }), [1], [{ kind: 'PROTO_LAND', proto: true, seq: 52, op: 'PULL', turn: 62, p: 2, q: 0, slot: 0, pole: 28, nation: 2, holder: CINDER, from: 2, host: 'someone-else', tiles: THEIRS }]), { now: 1000 });
  assert.equal([...E.moments.values()][0].byViewer, false);
});

test('the cap and a march onto another nation\'s pole, in words: the plate prices no banner that cannot be raised, and the order card says what standing on that pole does', () => {
  const m = { cap: 5, held: 5, nextPrice: 12 };
  assert.equal(pm.plateNext(m), '旗はこれ以上立てられません', 'not 「つぎの旗：功績 12」 beside 「旗 5/5」');
  assert.equal(pm.plateNext({ cap: 5, held: 4, nextPrice: 8 }), 'つぎの旗：功績 8');
  assert.equal(pm.plateNext({ cap: 5, held: 0, nextPrice: 0 }), 'つぎの旗：無料');
  assert.equal(pm.plateNext({ cap: null, held: 9, nextPrice: 4 }), 'つぎの旗：功績 4', 'a record that names no cap');
  const FS = page(land());
  assert.equal(text(protoHud.marchLine(FS, { arrive: 47, dest: { p: 2, q: 0, tile: 28 }, answer: { ok: false, code: 'NotOpen', need: { why: 'banner', slot: 0 } } })), '試作 到着：ターン 47・シンダーの旗が立つマスです。ここに立ちつづけると、その旗を取るか倒せます');
  assert.match(text(protoHud.marchLine(FS, { arrive: 47, dest: { p: 2, q: 0, tile: 37 }, answer: { ok: false, code: 'NotOpen', need: { why: 'banner', slot: 0 } } })), /ここでは旗を立てられません/, 'a tile of that banner\'s land that is not its pole: as before');
  assert.equal(text(protoHud.marchLine(FS, { arrive: 47, dest: { p: 2, q: 0, tile: 32 }, answer: { ok: false, code: 'NotOpen', need: { why: 'banner', slot: 1 } } })), '試作 到着：ターン 47・あなたの旗の土地です', 'the viewer\'s own banner: as before');
  // the place of a new host on that pole says the same
  assert.equal(text(protoHud.placeLine(FS, { ok: false, code: 'NotOpen', need: { why: 'banner', slot: 0 }, p: 2, q: 0, tile: 28 })), '試作 シンダーの旗が立つマスです。ここに立ちつづけると、その旗を取るか倒せます');
  assert.match(text(protoHud.placeLine(FS, { ok: false, code: 'NotOpen', need: { why: 'banner', slot: 0 }, p: 2, q: 0, tile: 37 })), /ここでは旗を立てられません/);
  setLang('en');
  assert.equal(pm.plateNext(m), 'No more banners can be raised');
  assert.match(text(protoHud.marchLine(FS, { arrive: 47, dest: { p: 2, q: 0, tile: 28 }, answer: { ok: false, code: 'NotOpen', need: { why: 'banner', slot: 0 } } })), /Arrives on turn 47: the pole of a banner of Cinder\. A host that keeps standing here can take that banner or pull it down/);
});
