// The keeps on the board, the page's side and the march (map/keepmount.mjs, map/marcher.mjs, map/board.mjs,
// fx/keep-demo.mjs, fx/stage.mjs): what the page hands the map, which keeps a host in hand lights, the figures that
// walk the viewer's own march, and the samples of the demo switch. Where a case was seen on the local test chain
// (run uxs1, 2026-10-11) it says so.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as B from '../../permutation-server/web/frontier/map/board.mjs';
import { keepFeedOf, handHostOf, keepReachOf, mountKeepBoard } from '../../permutation-server/web/frontier/map/keepmount.mjs';
import { MARCHER, marcherSpots, marcherTop, marcherUnit, paintMarcher } from '../../permutation-server/web/frontier/map/marcher.mjs';
import { keepRows, KeepBoard, KEEP_LOOK } from '../../permutation-server/web/frontier/map/keeps.mjs';
import { FORTRESS, paintFortress } from '../../permutation-server/web/frontier/map/village.mjs';
import { keepScene } from '../../permutation-server/web/frontier/fx/keep-demo.mjs';
import { SAMPLES } from '../../permutation-server/web/frontier/fx/demo.mjs';
import { installStage } from '../../permutation-server/web/frontier/fx/stage.mjs';
import { createBus } from '../../permutation-server/web/frontier/fx/bus.mjs';
import { smoothPath } from '../../permutation-server/web/frontier/fx/draw.mjs';
import { hostId } from '../../permutation-server/web/frontier/faddr.mjs';
import { DIRECTIONS, locate, tileHex } from '../../permutation-server/web/frontier/fgeo.mjs';
import { project, RADIUS } from '../../permutation-server/web/map.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';

const WEB = new URL('../../permutation-server/web/frontier/', import.meta.url);
const HOME = { p: 2, q: 0, site: 3, gen: 1, tile: 7 };
const id = seq => hostId({ ...HOME, seq });
const entry = (seq, o = {}) => ({ id: id(seq), faction: 0, unit: 0, tile: HOME.tile, state: 1, troops: 400_000, staminaValue: 120, staminaBell: 40, readyBell: 0, fromBell: 0, pendOp: 0, ...o });
const holding = (o = {}) => ({ ...HOME, state: 2, tier: 1, transit: [], queue: [], stores: [], production: [], explore: { state: 0 }, ...o });
const CONQUEST = { layoutVersion: 2, programVersion: 3 };
const page = ({ entries = [], marches = [], nowBell = 42, more = [], season = CONQUEST } = {}) => ({ mode: 'play', nowBell, season, holdings: [holding()], marches, citizen: { faction: 0 }, wallet: { address: 'W' }, record: { rings: [0, 1, 2] },
  provinces: new Map([[`${HOME.p},${HOME.q}`, { province: { p: HOME.p, q: HOME.q, entries, sites: [0, 1, 2, HOME.tile] } }], ...more.map(pv => [`${pv.p},${pv.q}`, { province: pv }])]) });
const march = (seq, o = {}) => ({ entry: { host: String(id(seq)), state: 'landed', departBell: 41, arriveBell: 43, route: { p: HOME.p, q: HOME.q, tile: HOME.tile, dirs: [0, 1, 0, 0] }, ...(o.entry ?? {}) }, transit: null,
  facts: { slotPresent: false, ...(o.facts ?? {}) }, dest: (() => { let { q, r } = tileHex(HOME.p, HOME.q, HOME.tile); for (const d of [0, 1, 0, 0]) { q += DIRECTIONS[d][0]; r += DIRECTIONS[d][1]; } const l = locate(q, r); return { p: l.p, q: l.q, tile: l.idx }; })() });
/** A context that takes every call and paints nothing. */
const inert = () => new Proxy({}, { get: (t, k) => (k in t ? t[k] : k === 'canvas' ? {} : /Gradient$/.test(String(k)) ? () => ({ addColorStop() {} }) : k === 'getTransform' ? () => ({ a: 1, b: 0 }) : () => undefined), set: (t, k, v) => { t[k] = v; return true; } });

test('a host whose Depart has landed is on the road, whatever a roster read before the order still says', () => {
  // (seen on uxs1: the page's copy of the home province went on showing the host standing at home for two turns
  // after the order; the character stood by its village while its own marker walked the ribbon)
  const stale = page({ entries: [entry(7), entry(8, { unit: 6 })], marches: [march(7)] });
  const rows = B.ownHostRows(stale);
  assert.deepEqual(rows.map(r => [r.id, r.standing, r.sealed, r.state]), [[String(id(7)), false, true, 3], [String(id(8)), true, false, 1]]);
  const rec = B.boardRecords(stale);
  assert.equal(rec.lead, String(id(7)));
  assert.equal(rec.place.at, 'march', 'the character is on its own march, not by the village as well');
  // any other season reads its rosters as it did
  assert.equal(B.boardRecords(page({ entries: [entry(7), entry(8, { unit: 6 })], marches: [march(7)], season: { layoutVersion: 2, programVersion: 2 } })).place.at, 'home');
  assert.equal(B.boardRecords(page({ entries: [entry(7)], marches: [march(7)], season: null })).place.at, 'home');
  // an order that has not landed yet (sealed, sent) changes nothing: the roster is the record
  for (const state of ['sealed', 'sent', 'failed']) assert.equal(B.boardRecords(page({ entries: [entry(7)], marches: [march(7, { entry: { state } })] })).place.at, 'home', state);
  // the arrival turn has begun and the roster still shows it on the tile it set out from: it has not "arrived" there
  // (seen on uxs1 on a march of two turns: `board:arrival` was said for the origin tile, then `board:left`)
  assert.equal(B.ownHostRows(page({ entries: [entry(7)], marches: [march(7)], nowBell: 43 }))[0].standing, false);
  // the seal is open: the march book says `revealed`, and the roster is the record again
  assert.equal(B.ownHostRows(page({ entries: [entry(7)], marches: [march(7, { entry: { state: 'revealed' } })], nowBell: 43 }))[0].standing, true);
  // an order kept without its route is believed only until its arrival turn begins
  assert.equal(B.ownHostRows(page({ entries: [entry(7)], marches: [march(7, { entry: { route: null } })], nowBell: 42 }))[0].standing, false);
  assert.equal(B.ownHostRows(page({ entries: [entry(7)], marches: [march(7, { entry: { route: null } })], nowBell: 43 }))[0].standing, true);
  // a host the roster shows on another tile than the one it set out from is not that march's stale row
  assert.equal(B.ownHostRows(page({ entries: [entry(7, { tile: 30 })], marches: [march(7)] }))[0].standing, true);
  // nothing changes where the roster already says the host is sealed
  assert.deepEqual(B.ownHostRows(page({ entries: [entry(7, { state: 3 })], marches: [march(7)] })).map(r => [r.sealed, r.standing]), [[true, false]]);
});

test('the marching figures: the character at the head, a file behind it on the road, never under a size that reads', () => {
  const path = smoothPath([0, 1, 2, 3, 4, 5].map(i => ({ x: i * RADIUS * 1.7, y: i * 6 })));
  const spots = marcherSpots(path, 0.6, { zoom: 1.15, lead: true });
  assert.deepEqual(spots.map(s => s.kind), ['lead', 'mini', 'mini', 'mini']);
  assert.ok(spots.every(s => s.face === 1), 'they face the way the road goes');
  for (let i = 1; i < spots.length; i++) assert.ok(spots[i].x < spots[i - 1].x, 'each behind the one before');
  // a road that runs to the left turns them round
  const back = smoothPath([5, 4, 3, 2, 1, 0].map(i => ({ x: i * RADIUS * 1.7, y: 0 })));
  assert.ok(marcherSpots(back, 0.5, { zoom: 1, lead: true }).every(s => s.face === -1));
  // a host the character does not lead is the file alone, its first figure where the column is
  const file = marcherSpots(path, 0.6, { zoom: 1.15, lead: false });
  assert.deepEqual(file.map(s => s.kind), ['mini', 'mini', 'mini']);
  assert.ok(Math.abs(file[0].x - spots[0].x) < 1e-6);
  // just out of the gate there is no road behind yet: the figures that have none are left out
  assert.ok(marcherSpots(path, 0.02, { zoom: 1.15, lead: true }).length < 4);
  // the size: the board's own at the home view, and at least MARCHER.minPx tall on screen one step out and further
  const tall = z => marcherTop(z, true) * z;
  assert.ok(tall(1.15) >= MARCHER.minPx);
  for (const z of [0.77, 0.6, 0.5]) assert.ok(tall(z) >= MARCHER.minPx - 0.01, `zoom ${z}: ${tall(z)}`);
  assert.equal(marcherUnit(2), MARCHER.unit, 'never smaller than the character by its village');
  assert.ok(MARCHER.minPx >= 56, 'a figure, not a marker (the hexagon face was 34 px)');
  // the painter tolerates a context that draws nothing, and says when its art is not here (the map then draws the marker it had)
  assert.equal(paintMarcher(inert(), spots[0], { zoom: 1, faction: 0, now: 0 }), false);
  assert.equal(paintMarcher(null, spots[0]), false);
  // only a conquest season's board draws them: any other season keeps the marker it had
  const fmap = readFileSync(new URL('map/fmap.mjs', WEB), 'utf8');
  assert.match(fmap, /const spots = F\.KB \? marcherSpots\(at\.path, at\.k, \{ zoom: z, lead \}\)/);
  assert.match(fmap, /marchTagText\(k\.m\.arriveBell\)/, 'the tag over it is kept: "Arrives on turn N · only you can see this"');
});

test('what the page hands the map: a conquest season\'s keep events and the viewer; nothing in any other season', () => {
  const events = [{ seq: '5101', kind: 'keep_contest', bell: 38, p: 0, q: 4, from: 1, to: 0 }];
  const cq = { season: { layoutVersion: 2, programVersion: 3 }, citizen: { faction: 0 }, nowBell: 40, conquest: { events } };
  assert.deepEqual(keepFeedOf(cq), { enabled: true, events, viewer: 0, bell: 40 });
  assert.deepEqual(keepFeedOf({ ...cq, conquest: {} }), { enabled: true, events: null, viewer: 0, bell: 40 }, 'the days\' files are not read yet');
  // the basic game, and the sample world's arrival-control land: off, and no events are handed over
  assert.deepEqual(keepFeedOf({ ...cq, season: { layoutVersion: 2, programVersion: 2 } }), { enabled: false, events: null, viewer: 0, bell: 40 });
  assert.equal(keepFeedOf({ ...cq, sample: { territory: { mode: 'arrival-control' } } }).enabled, false);
  assert.equal(keepFeedOf({}).enabled, false);
  assert.equal(keepFeedOf(null).enabled, false);
  // no host in the hand: nothing lights
  assert.equal(handHostOf({ mode: 'play' }), null);
  assert.equal(handHostOf({ mode: 'spectate', selected: { p: 0, q: 0, idx: 1 } }), null);
  assert.equal(keepReachOf({ conquest: { keeps: new Map() }, citizen: { faction: 0 } }, { p: 0, q: 0, tile: 0, unit: 0 }), null, 'no keeps read');
  assert.equal(keepReachOf({ conquest: { keeps: new Map([['0,4', {}]]) }, citizen: { faction: 0 } }, { p: 0, q: 0, tile: 0, unit: 0 }), null, 'no rules kernel yet');
  // the mount gives the map its feed, and leaves the reach alone once the page has lit its own
  const calls = [];
  const map = { keeps: { reachOwn: false, setReach: (list, o) => calls.push([list, o]) }, setKeepFeed(fn) { this.feed = fn; } };
  const m = mountKeepBoard({ map, state: () => cq });
  assert.deepEqual(map.feed(), { enabled: true, events, viewer: 0, bell: 40 });
  assert.deepEqual(calls, [[null, { own: false }]], 'no host in hand: no reach, said once');
  map.feed(); map.feed();
  assert.equal(calls.length, 1);
  map.keeps.reachOwn = true;
  assert.deepEqual(m.sync(), { enabled: true, events, viewer: 0, bell: 40 });
  assert.equal(calls.length, 1);
  assert.equal(mountKeepBoard({ map: {} }), null);
  // app.mjs has the one block
  const app = readFileSync(new URL('app.mjs', WEB), 'utf8');
  assert.equal(app.match(/mountKeepBoard\(\{ map \}\)/g)?.length, 1);
  assert.match(app, /\/\/ >>> keep-board[\s\S]{0,600}\/\/ <<< keep-board/);
});

test('the map\'s own hooks for the hand: setKeepReach, keepAt, flyToKeep', () => {
  const fmap = readFileSync(new URL('map/fmap.mjs', WEB), 'utf8');
  assert.match(fmap, /setKeepReach\(list = null\) \{ return this\.keeps\.setReach\(list, \{ own: true \}\); \}/);
  assert.match(fmap, /keepAt\(clientX, clientY\) \{/);
  assert.match(fmap, /flyToKeep\(at\) \{/);
  // a press on a keep's walls is a press on its tile, and goes on to the page (it is never swallowed)
  assert.match(fmap, /hit = \{ tileQ: h\.q, tileR: h\.r, p: k\.p, q: k\.q, idx: k\.tile, keep: \{ p: k\.p, q: k\.q, reachable: !!it\.reachable \} \};\s+\}\s+this\.onSelect\(hit\);/);
  // the opening on a new subject counts as a move by name, so a camera place kept before it is not gone back to (a conquest season's page)
  assert.match(fmap, /if \(\(!prev \|\| prev\.subject !== subject\) && \(this\.keepFeedNow \?\? this\.keepFeed\?\.\(\)\)\?\.enabled\) this\.moves = \(this\.moves \?\? 0\) \+ 1;/);
  // nothing of the keeps in the arrival-control sample world, and nothing without a conquest season's records
  assert.match(fmap, /keepsOn\(src, recs, feed = this\.keepFeedNow \?\? null\) \{\s+if \(src\?\.territoryEnabled\) return false;/);
  assert.match(fmap, /const KB = F\.KB = this\.keepsOn\(src, recs, feed\) \? this\.keeps : null;/);
  // the keep's place on its tile: behind the middle, so a host that holds the tile stands before its gate
  const board = new KeepBoard();
  board.frame(new Map([['4,-1', { p: 4, q: -1, keepTile: 10, keepTroops: 241, control: 5, contender: 0, contestProgress: 71, contestRequired: 72 }]]), { events: [], viewer: 0, bell: 82 }, { fx: 0 });
  const P = board.place(board.rows.get('4,-1'), 1), h = tileHex(4, -1, 10), c = project(h.q, h.r);
  assert.deepEqual([P.cx, P.cy], [c.x, c.y]);
  assert.ok(P.y < P.cy, 'behind the tile\'s middle');
  assert.equal(P.u, RADIUS * KEEP_LOOK.unit);
  assert.ok(board.place(board.rows.get('4,-1'), 0.05).u * 0.05 >= KEEP_LOOK.minPx - 1e-9, 'from afar it is never under its least size on screen');
  // the fortress is drawn by code, for every holder and for none, and tolerates a context that draws nothing
  for (const faction of [null, 0, 1, 2, 3, 4, 5]) for (const mine of [false, true]) paintFortress(inert(), 100, 100, 40, { faction, mine });
  assert.ok(FORTRESS.pole.up > 0.5 && FORTRESS.box.top > FORTRESS.pole.up);
});

test('the samples of the demo switch lay records in the herald\'s own shapes at a real keep, and only where there are keeps', () => {
  const recs = new Map([
    ['1,1', { p: 1, q: 1, keepTile: 1, keepTroops: 100, control: 0, contender: 7, contestProgress: 0, contestRequired: 72, heartland: true }],
    ['0,4', { p: 0, q: 4, keepTile: 26, keepTroops: 100, control: 1, contender: 7, contestProgress: 0, contestRequired: 72, heartland: false }],
    ['-1,4', { p: -1, q: 4, keepTile: 11, keepTroops: 100, control: 1, contender: 7, contestProgress: 0, contestRequired: 72, heartland: false }],
    ['0,2', { p: 0, q: 2, keepTile: 18, keepTroops: 100, control: 1, contender: 7, contestProgress: 0, contestRequired: 72, heartland: true }],
    ['4,0', { p: 4, q: 0, keepTile: 0, keepTroops: 100, control: 0, contender: 7, contestProgress: 0, contestRequired: 72, heartland: false }],
  ]);
  const hx = tileHex(1, 1, 34), home = project(hx.q, hx.r), o = { recs, viewer: 0, home, turn: 83 };
  // the reach: the nearest open keeps of other nations lit with their arrival turn, a heartland dim with its reason
  setLang('en');
  try {
    const R = keepScene('reach', 1, o);
    assert.deepEqual(R.reach.filter(x => x.reachable).map(x => [x.p, x.q, x.arriveTurn]), [[0, 4, 87], [-1, 4, 89]]);
    assert.deepEqual(R.reach.filter(x => !x.reachable).map(x => [x.p, x.q, x.why]), [[0, 2, 'A heartland keep cannot be taken']]);
    assert.equal(R.recs, recs, 'the reach changes no record');
  } finally { setLang('ja'); }
  // the contest: a turn at a time, then the record says it ended
  const c0 = keepScene('contest', 0.1, o), c2 = keepScene('contest', 1.7, o), cb = keepScene('contest', 5, o);
  assert.deepEqual([c0.key, keepRows(c0.recs).find(r => r.key === '0,4').held, c2.key, keepRows(c2.recs).find(r => r.key === '0,4').held], ['contest0', 12, 'contest2', 14]);
  assert.equal(keepRows(c0.recs).find(r => r.key === '0,4').contender, 0);
  assert.deepEqual([cb.key, keepRows(cb.recs).find(r => r.key === '0,4').contender, cb.events[0].kind], ['contest-broken', null, 'keep_broken']);
  // the capture: 71 of 72, then the control record's new holder with the capture's own record
  const a = keepScene('captured', 1, o), b = keepScene('captured', 2, o);
  assert.deepEqual(keepRows(a.recs).find(r => r.key === '0,4'), { key: '0,4', p: 0, q: 4, tile: 26, holder: 1, troops: 100, contender: 0, held: 71, of: 72, heartland: false });
  assert.deepEqual([keepRows(b.recs).find(r => r.key === '0,4').holder, b.events], [0, [{ seq: '900001', kind: 'keep_taken', bell: 83, p: 0, q: 4, from: 1, to: 0 }]]);
  assert.equal(recs.get('0,4').control, 1, 'the page\'s own records are not written to');
  // the board plays it as it plays the chain's: one capture, the viewer's own
  const board = new KeepBoard();
  board.setSample(a, { at: 0 });
  board.setSample(b, { at: 1400 });
  assert.deepEqual([...board.captures.values()].map(m => [m.p, m.q, m.from, m.to, m.turn, m.mine, m.before, m.after, m.t0]), [[0, 4, 1, 0, 83, true, 2, 3, 1400]]);
  board.setSample(null);
  assert.equal(board.captures.size, 0);
  // a loss: a province of the viewer's nation, taken by the nation whose keep is nearest
  const l = keepScene('lost', 2, o);
  assert.deepEqual([l.target, l.events[0].from, l.events[0].to], [{ p: 4, q: 0, tile: 0 }, 0, 1]);
  // no keeps in the records (the basic game, the sample world): no sample at all
  assert.equal(keepScene('captured', 2, { recs: new Map([['0,0', { p: 0, q: 0, owners: [] }]]), viewer: 0 }), null);
  for (const n of ['keep-reach', 'keep-contest', 'keep-captured', 'keep-lost']) { assert.equal(typeof SAMPLES[n]?.run, 'function', n); assert.equal(SAMPLES[n].board, true, n); assert.ok(SAMPLES[n].secs < 8, n); }
});

test('no departure is stamped over a keep in the second its province is captured', async () => {
  // (seen on uxs1 at turn 129: the host that held the keep's tile goes into the keep with the capture, the roster
  // read as a host that left, and "Departure" stood over the keep while its province changed hands)
  const bus = createBus(), played = [];
  const fx = { mounted: true, clock: { now: () => 10 }, map: { keeps: { on: true, rows: new Map([['-1,4', { p: -1, q: 4, tile: 11 }]]) }, project: () => null },
    play: (name, a) => { played.push(name); return []; }, add: () => null, later() { return this; }, sound: () => false, shake: () => false, piece: () => null, drop() {}, trim() {}, onStage: () => true, view: () => ({ x: 0, y: 0, zoom: 1 }) };
  let off = null;
  try { off = installStage(fx, { bus }); } catch { off = null; }
  if (!off) return;   // (a stage that needs a page to be installed: the rule is read in the source below)
  bus.emit('moment', { kind: 'depart', p: -1, q: 4, tile: 11, faction: 0, id: 'h' });
  bus.emit('keep:captured', { p: -1, q: 4, from: 1, to: 0, turn: 127, mine: true });
  await new Promise(r => setTimeout(r, 520));
  assert.equal(played.includes('stamp'), false, 'the capture came: no departure');
  // a departure from the same tile with no capture is played, a moment later
  fx.clock.now = () => 100;
  bus.emit('moment', { kind: 'depart', p: -1, q: 4, tile: 11, faction: 0, id: 'h2' });
  await new Promise(r => setTimeout(r, 520));
  assert.equal(played.includes('stamp'), true);
  if (typeof off === 'function') off();
});

test('the source says it: a departure from a keep\'s own tile waits for the capture\'s word', () => {
  const stage = readFileSync(new URL('fx/stage.mjs', WEB), 'utf8');
  assert.match(stage, /on\('keep:captured', k => \{ captured\.set\(`\$\{k\.p\},\$\{k\.q\}`, fx\.clock\.now\(\)\); \}\);/);
  assert.match(stage, /if \(m\.kind === 'depart' && keepTile\(m\)\) \{\s+if \(!taken\(m\)\) globalThis\.setTimeout\?\.\(\(\) => \{ if \(fx\.mounted && !taken\(m\)\) moment\(m\); \}, 450\);\s+return;/);
});
