// Before the take (2026-10-11): the viewer's character at the capture of a keep.
//
// While the viewer's lead host holds a keep's tile the character stands with it there; with the capture the host goes
// into the keep, the roster of that turn keeps its entry on the keep's tile in state 3, and one turn later has none.
// A sealed host with no order of this browser was read as "away", so at the capture — the moment the film builds
// to — the viewer's character stood by its village, out of the picture, and the victory pose the capture cues
// (fx/sheetfx.mjs playCapture) was played by nobody on screen. The records are those of run uxs1 on the local test
// chain (test/fixtures/uxs1-keep-captured.json: province -3,4 after turns 344, 345 and 346; taken at turn 345).
//
//   map/board.mjs       a host on a keep's own tile is marked; a sealed one with no march of the viewer's is "in the keep"
//   people/onboard.mjs  beside the fortress (KEEP_SPOT), and by the keep while a capture it was there for plays (captureStand)
//   map/keeps.mjs       the capture's word carries the host that went into the keep where the record read names it
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decode } from '../../permutation-server/web/frontier/fcodec.mjs';
import { fromBase64 } from '../../permutation-server/web/sdk/bytes.mjs';
import { RADIUS, project } from '../../permutation-server/web/map.mjs';
import { tileHex } from '../../permutation-server/web/frontier/fgeo.mjs';
import { boardRecords, characterPlace, ownHostRows } from '../../permutation-server/web/frontier/map/board.mjs';
import { surveyInput } from '../../permutation-server/web/frontier/map/viewer.mjs';
import { KeepBoard } from '../../permutation-server/web/frontier/map/keeps.mjs';
import { setBoardCharacters, characterTokens, captureStand, noteCapture, hexAt, HOST_SPOT, KEEP_SPOT, CAPTURE_STAND } from '../../permutation-server/web/frontier/people/onboard.mjs';
import { FORTRESS } from '../../permutation-server/web/frontier/map/village.mjs';
import { createLabelPass } from '../../permutation-server/web/frontier/map/labelpass.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';
import { KEEP_LOOK } from '../../permutation-server/web/frontier/map/keeps.mjs';

const WEB = new URL('../../permutation-server/web/frontier/', import.meta.url);
const src = f => readFileSync(new URL(f, WEB), 'utf8');
const FIX = JSON.parse(readFileSync(new URL('./fixtures/uxs1-keep-captured.json', import.meta.url), 'utf8'));
const [P, Q] = FIX.province, HOST = FIX.host, TILE = FIX.keepTile;
const after = bell => decode('Province', fromBase64(FIX.after[bell].bytes));
const SEASON = { programVersion: 3, layoutVersion: 2, conquestParams: { keepBells: 72 } };
// (a Holding as the page reads it: its site and generation, its tile, and no host of it on the road)
const HOME = { ...FIX.village, tile: 7, tier: 0, transit: [] };
/** The page of the player whose host took the keep, holding the province as it was after turn `bell`. */
const page = (bell, extra = {}) => ({ mode: 'play', season: SEASON, citizen: { faction: 2 }, holdings: [HOME], activeHolding: 0, marches: [], nowBell: bell + 1, provinces: new Map([[`${P},${Q}`, { province: after(bell) }]]), ...extra });

test('the real records of a capture: the host stands on the keep\'s tile, is on it in state 3 in the turn of the capture, and is in no roster after', () => {
  const state = bell => after(bell).entries.filter(e => e.state).map(e => [String(e.id), e.state, e.tile]);
  assert.deepEqual(state(344), [[HOST, 1, TILE]]);
  assert.deepEqual(state(345), [[HOST, 3, TILE]]);
  assert.deepEqual(state(346), []);
  assert.deepEqual([after(344).keep.holder, after(345).keep.holder, after(345).keep.tile, after(345).keep.troops], [1, 2, TILE, 243]);
});

test('the board\'s rows mark a host on a keep\'s own tile, and the character\'s place follows it into the keep', () => {
  // the hold: the lead stands on the keep's tile
  const hold = boardRecords(page(344));
  assert.deepEqual(hold.hosts.map(h => [h.id, h.state, h.standing, h.onKeep]), [[HOST, 1, true, true]]);
  assert.deepEqual(hold.place, { at: 'host', host: HOST, p: P, q: Q, tile: TILE, unit: 0, alone: true, keep: true });
  // the turn of the capture: the entry is sealed on that tile and no march of this browser is behind it. It was "away"
  const cap = boardRecords(page(345));
  assert.deepEqual(cap.hosts.map(h => [h.id, h.state, h.standing, h.sealed, h.onKeep]), [[HOST, 3, false, true, true]]);
  assert.deepEqual(cap.place, { at: 'host', host: HOST, p: P, q: Q, tile: TILE, unit: 0, alone: false, keep: true, inKeep: true });
  // the turn after: no roster has the host, and the character is by its village again
  assert.deepEqual(boardRecords(page(346)).place, { at: 'home', host: null, p: HOME.p, q: HOME.q, tile: HOME.tile });
  // and it sees from the keep's tile through the turn of the capture, as it did through the hold: the province it has
  // just taken is not out of sight in the second it is taken. After that turn no host is there to see
  const sight = bell => surveyInput(page(bell)).hosts.map(h => [h.p, h.q, h.tile]);
  assert.deepEqual([sight(344), sight(345), sight(346)], [[[P, Q, TILE]], [[P, Q, TILE]], []]);
  // a host standing on a tile that is no keep's is not marked
  const elsewhere = after(344); elsewhere.entries.find(e => e.state).tile = 30;
  assert.equal(ownHostRows({ ...page(344), provinces: new Map([[`${P},${Q}`, { province: elsewhere }]]) })[0].onKeep, undefined);
});

test('only that case: a march of the viewer\'s, a sealed host off a keep\'s tile and another player\'s host are read as before', () => {
  const village = { p: HOME.p, q: HOME.q, tile: HOME.tile };
  const sealed = { id: HOST, p: P, q: Q, tile: TILE, unit: 0, state: 3, standing: false, sealed: true, onKeep: true };
  assert.equal(characterPlace({ village, rows: [sealed], own: true }).inKeep, true);
  // the viewer's own sealed march from that tile: the character is the marker on its ribbon
  assert.equal(characterPlace({ village, rows: [sealed], marches: [{ host: HOST, known: true, open: false }], own: true }).at, 'march');
  // a sealed host on a tile that is no keep's, one on the road in no roster, and another player's: away
  assert.equal(characterPlace({ village, rows: [{ ...sealed, onKeep: undefined }], own: true }).at, 'away');
  assert.equal(characterPlace({ village, rows: [{ ...sealed, road: true }], own: true }).at, 'away');
  assert.equal(characterPlace({ village, rows: [sealed], own: false }).at, 'away');
});

test('beside the fortress: clear of its ring, of the host before its gate and of the dial over its shoulder', () => {
  const [kx, ky] = KEEP_SPOT.character;
  // the fortress's ground: its middle and the ring's half-width, in tile radii (map/keeps.mjs KEEP_LOOK, map/village.mjs FORTRESS)
  const mid = KEEP_LOOK.at.x, ring = FORTRESS.ring * KEEP_LOOK.unit;
  assert.ok(kx < mid - ring - 0.5, `left of the fortress's ring by more than half a figure (${kx} against ${(mid - ring).toFixed(2)})`);
  assert.ok(kx < HOST_SPOT.host[0] - 1.5, 'far from the host that stands before the gate, and from its troop plate');
  // the dial hangs over the fortress's left shoulder, 1.34 fortress units up: the character's feet are level with the gate
  assert.ok(Math.abs(ky) < 0.3 && KEEP_LOOK.dial.up * KEEP_LOOK.unit > 1.6);
  // on the board: the token of a character whose host holds a keep's tile stands there, and on the ground it stands on
  const h = tileHex(P, Q, TILE), c = project(h.q, h.r);
  const own = { p: HOME.p, q: HOME.q, tile: HOME.tile, faction: 2, own: true, tier: 0 };
  setBoardCharacters([own]);
  try {
    const place = boardRecords(page(344)).place;
    const tok = characterTokens({ p: P, q: Q, places: new Map([[`${own.p},${own.q},${own.tile},${own.faction}`, place]]), now: 10, level: 'full', stages: [] });
    assert.equal(tok.length, 1);
    assert.deepEqual([Math.round((tok[0].x - c.x) / RADIUS * 100) / 100, Math.round((tok[0].y - c.y) / RADIUS * 100) / 100, tok[0].tile], [kx, ky, TILE]);
    assert.deepEqual(tok[0].hex, hexAt(tok[0].x, tok[0].y));
    assert.notDeepEqual(tok[0].hex, { q: h.q, r: h.r }, 'its feet are on the ground beside the keep\'s tile');
    // a host that stands on any other tile: at its head, as before
    const plain = characterTokens({ p: P, q: Q, places: new Map([[`${own.p},${own.q},${own.tile},${own.faction}`, { ...place, keep: undefined }]]), now: 11, level: 'full', stages: [] });
    assert.deepEqual([Math.round((plain[0].x - c.x) / RADIUS * 100) / 100, plain[0].hex], [HOST_SPOT.character[0], { q: h.q, r: h.r }]);
  } finally { setBoardCharacters([]); }
});

test('while the capture plays the character is by the keep it took, whatever the roster says by then; and only for that capture', () => {
  const id = 'c1', home = { at: 'home', host: null, p: HOME.p, q: HOME.q, tile: HOME.tile };
  const held = { at: 'host', host: HOST, p: P, q: Q, tile: TILE, unit: 0, alone: true, keep: true };
  // it led the host on the keep's tile (seen at second 100), the roster then lost the host (the capture's turn went by)
  assert.equal(captureStand(id, held, 100), held);
  assert.equal(captureStand(id, home, 160), home, 'no capture was heard: by its village');
  // the capture's word comes 90 s later (a turn and a half of the film's season): it stands by the keep while it plays
  noteCapture({ p: P, q: Q, tile: TILE, mine: true, donor: null }, 190);
  assert.deepEqual(captureStand(id, home, 191), { at: 'host', host: HOST, p: P, q: Q, tile: TILE, alone: false, keep: true, inKeep: true, capture: true });
  assert.equal(captureStand(id, home, 190 + CAPTURE_STAND.secs + 0.1), home, 'and goes home when it is over');
  // a roster that still has the host on that tile: the records' own place stands
  assert.equal(captureStand(id, held, 191.5), held);
  // not for another keep, not for a host other than the one the record names, not for a capture by another nation,
  // and not when it last led a host there too long ago
  const far = { at: 'host', host: HOST, p: 0, q: 3, tile: 5 };
  captureStand('c2', far, 200); noteCapture({ p: P, q: Q, tile: TILE, mine: true }, 201);
  assert.equal(captureStand('c2', home, 202), home);
  captureStand('c3', held, 300); noteCapture({ p: P, q: Q, tile: TILE, mine: true, donor: '999' }, 301);
  assert.equal(captureStand('c3', home, 302), home);
  noteCapture({ p: P, q: Q, tile: TILE, mine: true, donor: HOST }, 303);
  assert.equal(captureStand('c3', home, 304).capture, true);
  captureStand('c4', held, 400); noteCapture({ p: 9, q: 9, tile: 1, mine: true }, 399); noteCapture({ p: P, q: Q, tile: TILE, mine: false, lost: true }, 401);
  assert.equal(captureStand('c4', home, 402), home, 'a capture that is not the viewer\'s nation\'s is not heard');
  captureStand('c5', held, 500); noteCapture({ p: P, q: Q, tile: TILE, mine: true }, 500 + CAPTURE_STAND.heard + 1);
  assert.equal(captureStand('c5', home, 500 + CAPTURE_STAND.heard + 2), home);
  noteCapture({ p: 9, q: 9, tile: 1, mine: true }, -1e6);
});

test('the capture\'s word carries the tile and the host that went into the keep, and the pose is cued by that word', () => {
  // (the page's merged keep events do not carry the record's donor today: null there, and the tile alone decides)
  const keeps = src('map/keeps.mjs');
  assert.match(keeps, /capture\(row, nation\(e\.from\) \? e\.from : this\.shown\(row\.key\), e\.to, e\.bell, 'record', e\.detail\?\.donor \?\? e\.donor \?\? null\);/);
  assert.match(keeps, /fxEmit\('keep:captured', \{ p: m\.p, q: m\.q, tile: m\.tile, [^}]*donor: m\.donor \?\? null \}\)/);
  assert.match(src('people/onboard.mjs'), /busOn\('keep:captured', e => noteCapture\(e\)\)/);
  assert.match(src('fx/sheetfx.mjs'), /if \(e\.mine && out\.length\) cueLeaderMotion\(MOTION_LEADERS\[e\.to\]\.key, 'victory'/);
  assert.equal(typeof KeepBoard, 'function');
});

test('the capture\'s number stays in the picture: over the lines where the HUD leaves room, beside the fortress where it does not', () => {
  // (seen on the local test chain at the film's frame, 1280 × 720: with the keep in the middle of the picture
  // 「+1 province」 rose under the top bar and the turn dial and only its last letters were read)
  setLang('en');
  try {
    const rec = (control, contender, held) => new Map([[`${P},${Q}`, { p: P, q: Q, keepTile: TILE, control, contender, contestProgress: held, contestRequired: 72, keepTroops: 0 }]]);
    const taken = { seq: '111105', kind: 'keep_taken', bell: 714, p: P, q: Q, from: 1, to: 2, troops: 241 };
    /** Paint the capture 1.2 s after its record was read, on a 1280 × 720 picture at zoom `z` with the keep's tile at screen (cx, cy) and the HUD's pieces `nogo`. */
    const paint = (z, cx, cy, nogo) => {
      const board = new KeepBoard();
      board.read({ recs: rec(1, 2, 71), events: [], viewer: 2, bell: 714 }, 0);
      board.read({ recs: rec(2, 7, 0), events: [taken], viewer: 2, bell: 716 }, 1000);
      assert.equal(board.captures.size, 1);
      const h = tileHex(P, Q, TILE), c = project(h.q, h.r), texts = [];
      const o = new Proxy({}, { get: (t, k) => (k in t ? t[k] : k === 'measureText' ? x => ({ width: String(x).length * 8 / z }) : k === 'fillText' ? (text, x, y) => { texts.push({ text, x, y, font: t.font }); } : typeof k === 'string' ? () => undefined : undefined), set: (t, k, v) => { t[k] = v; return true; } });
      const screen = (x, y) => ({ x: (x - c.x) * z + cx, y: (y - c.y) * z + cy });
      board.over(o, { z, fx: 2200, still: false, seen: null, up: false, pass: createLabelPass({ nogo, screen, zoom: z, bounds: { w: 1280, h: 720 } }) });
      const big = texts.find(t => t.text === '+1 province'), line = texts.find(t => t.text === 'Provinces held 1 → 2' || /^Provinces held/.test(t.text));
      assert.ok(big && line, 'the number and the line are both painted');
      return { big: screen(big.x, big.y), line: screen(line.x, line.y), keep: { x: cx, y: cy } };
    };
    const HUD = [{ x: 0, y: 0, w: 1280, h: 52 }, { x: 596, y: 0, w: 88, h: 96 }, { x: 60, y: 62, w: 650, h: 44 }];   // the top bar, the turn dial, "Provinces held"
    // room over the keep (the keep low in the picture): the number rises over the line, on the keep's own axis
    const roomy = paint(1.0, 640, 520, HUD);
    assert.ok(Math.abs(roomy.big.x - roomy.line.x) < 2 && roomy.big.y < roomy.line.y - 30, JSON.stringify(roomy));
    // the film's frame with the keep in the middle of the picture at the zoom it is filmed at: its own place is under
    // the dial, so it rises beside the fortress, in the picture and clear of every piece of the HUD and of the line
    const tight = paint(1.6, 640, 318, HUD);
    assert.ok(tight.big.x > tight.keep.x + 120, 'to the right of the fortress: ' + JSON.stringify(tight));
    assert.ok(tight.big.y > 96 + 30 && tight.big.y < 400, 'under the HUD, beside the standard');
    assert.ok(tight.line.y > 106, 'the line is clear of the HUD too');
    // a notice of the page over the right of the map: to the left
    const left = paint(1.6, 640, 318, [...HUD, { x: 700, y: 60, w: 580, h: 300 }]);
    assert.ok(left.big.x < left.keep.x - 120, JSON.stringify(left));
  } finally { setLang('ja'); }
});

test('the pose is ready for the capture: its sheet is asked for while the character stands by a keep its host holds', () => {
  // (asked for only at the cue, the sheet came after the pose's 1.7 s and the pose was never seen on a real capture)
  assert.match(src('people/onboard.mjs'), /if \(c\.own && c\.place\?\.keep\) \{ leaderMotionPick\(c\.key, 'victory', px\); leaderMotionPick\(c\.key, 'victory', leaderCellWidth\(u\) \* contextScale\(ctx\)\); \}/);
});
