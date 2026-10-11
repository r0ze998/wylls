// The integration of the three tracks of the submission screens (2026-10-11): what the hand tells the board to light
// (`map.setKeepReach`, the board's own shape), a press on a keep of the lit reach, the board's `keep:captured` with the
// keep's tile for the effects, and "Provinces held" counting from the control record while it is newer than the
// standings record (a capture the board has just played is counted in the same moment).
// The records are those of run ux-check on the local test chain (hud/handdemo-data.mjs: keep 4,-1, taken at turn 83).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as K from '../../permutation-server/web/frontier/hud/keephand.mjs';
import * as P from '../../permutation-server/web/frontier/hud/provstrip.mjs';
import { STANDINGS_BEFORE, STANDINGS_AFTER } from '../../permutation-server/web/frontier/hud/handdemo-data.mjs';
import { KeepBoard, paintReachRing } from '../../permutation-server/web/frontier/map/keeps.mjs';

const WEB = new URL('../../permutation-server/web/frontier/', import.meta.url);
const src = f => readFileSync(new URL(f, WEB), 'utf8');
const SEASON = { programVersion: 3, layoutVersion: 2, endBell: 2016, bellSecs: 600, conquestParams: { keepBells: 72 } };

/** The 54 keeps of rings 2 to 4 as controller.mjs lays them from a control record of turn `bell`: nine a nation, `moved` provinces changed. */
function keepsAt(bell, holders = [9, 9, 9, 9, 9, 9], stale = null) {
  const keeps = new Map();
  let i = 0;
  holders.forEach((n, f) => { for (let k = 0; k < n; k++, i++) keeps.set(`${i},0`, { p: i, q: 0, tile: 10, holder: f, heartland: false, asOfBell: stale !== null && i === 0 ? stale : bell }); });
  return keeps;
}
const fs = ({ standings = STANDINGS_BEFORE, control = null, keeps = new Map(), bell = 84 } = {}) => ({ mode: 'play', season: SEASON, citizen: { faction: 0 }, nowBell: bell, conquest: { status: 'ready', standings, final: null, control, keeps } });

test('"Provinces held" counts from the control record while it is the newer record, and never from a partial reading', () => {
  // the standings record alone (turn 82): nine each
  assert.deepEqual(P.stripModel(fs()).rows.map(r => r.provinces), [9, 9, 9, 9, 9, 9]);
  // the control record of turn 84 says Aster holds ten and Fjordal eight (the capture of turn 83): the strip says so now
  const ahead = P.stripModel(fs({ control: { bell: 84 }, keeps: keepsAt(84, [10, 9, 9, 9, 9, 8]) }));
  assert.deepEqual(ahead.rows.map(r => r.provinces), [10, 9, 9, 9, 9, 8]);
  assert.equal(ahead.bell, 84, 'the turn the figures speak of is the control record\'s');
  assert.deepEqual(ahead.rows.map(r => r.lead), [true, false, false, false, false, false]);
  assert.deepEqual(P.changedCounts(P.stripModel(fs()), ahead), [{ faction: 0, from: 9, to: 10 }, { faction: 5, from: 9, to: 8 }], 'the beat is the same +1 and −1');
  // a control record no newer than the standings: the standings stand
  assert.deepEqual(P.stripModel(fs({ control: { bell: 82 }, keeps: keepsAt(82, [10, 9, 9, 9, 9, 8]) })).rows.map(r => r.provinces), [9, 9, 9, 9, 9, 9]);
  // a keep still read from an older record, or a count that does not add up to the standings' sum: the standings stand
  assert.equal(P.controlCounts({ control: { bell: 84 }, keeps: keepsAt(84, [10, 9, 9, 9, 9, 8], 80) }), null);
  assert.deepEqual(P.stripModel(fs({ control: { bell: 84 }, keeps: keepsAt(84, [10, 9, 9, 9, 9, 7]) })).rows.map(r => r.provinces), [9, 9, 9, 9, 9, 9]);
  assert.equal(P.controlCounts({ control: null, keeps: keepsAt(84) }), null);
  assert.equal(P.controlCounts({ control: { bell: 84 }, keeps: new Map() }), null);
  // once the standings record has caught up it is the record again
  const caught = P.stripModel(fs({ standings: STANDINGS_AFTER, control: { bell: 92 }, keeps: keepsAt(92, [10, 9, 9, 9, 9, 8]) }));
  assert.deepEqual([caught.bell, caught.rows.map(r => r.provinces)], [92, [10, 9, 9, 9, 9, 8]]);
  // the season's end: the final record alone
  const over = fs({ bell: 2016, control: { bell: 2015 }, keeps: keepsAt(2015, [10, 9, 9, 9, 9, 8]) });
  over.conquest.final = STANDINGS_AFTER;
  assert.deepEqual([P.stripModel(over).final, P.stripModel(over).bell], [true, 92]);
});

test('what the hand tells the board to light is in the board\'s own shape: reachable, the card\'s arrival turn, the defenders, the hot row', () => {
  const rows = [{ p: 4, q: -1, tile: 10, holder: 5, troops: 100, arrive: 58, key: '4,-1' }, { p: 0, q: 4, tile: 26, holder: 1, troops: null, arrive: 60, key: '0,4' }];
  const lit = K.keepLights({ state: 'ready', wait: null, rows }, '0,4');
  assert.deepEqual(lit, [
    { p: 4, q: -1, tile: 10, arriveTurn: 58, holder: 5, defenders: 100, troops: 100, reachable: true, why: null, hot: false },
    { p: 0, q: 4, tile: 26, arriveTurn: 60, holder: 1, defenders: null, troops: null, reachable: true, why: null, hot: true }]);
  // a host that cannot depart yet: its keeps are lit, and no turn of arrival is promised
  assert.deepEqual(K.keepLights({ state: 'ready', wait: { why: 'forming', turn: 61 }, rows }).map(x => x.arriveTurn), [null, null]);
  assert.deepEqual(K.keepLights({ state: 'loading', rows: [] }), []);
  // the board takes that list: the lit keeps, and the hot one is a change of what is lit
  const board = new KeepBoard({ invalidate() {}, tick() {} });
  assert.equal(board.setReach(lit), true);
  assert.equal(board.reachOwn, true, 'the page lights its own reach: the board\'s default is off');
  assert.deepEqual([...board.lit.values()].map(x => [x.p, x.q, x.reachable, x.arriveTurn, !!x.hot]), [[4, -1, true, 58, false], [0, 4, true, 60, true]]);
  assert.equal(board.setReach(lit), false, 'the same list changes nothing');
  assert.equal(board.setReach(K.keepLights({ state: 'ready', wait: null, rows }, '4,-1')), true, 'another row under the pointer is a change');
  assert.equal(board.setReach(null), true);
  assert.equal(board.lit, null);
  // the ring's painter takes `hot` and draws without a context that lacks gradients
  const calls = [];
  const g = new Proxy({}, { get: (_, k) => (k === 'save' || k === 'restore' || k === 'stroke' || k === 'fill' || k === 'beginPath' || k === 'translate' || k === 'scale' ? () => calls.push(k) : k === 'arc' ? (...a) => calls.push(['arc', a[2]]) : undefined), set: () => true });
  paintReachRing(g, 0, 0, { now: 0, still: true });
  const plainR = calls.find(c => Array.isArray(c))[1];
  calls.length = 0;
  paintReachRing(g, 0, 0, { now: 0, still: true, hot: true });
  assert.ok(calls.find(c => Array.isArray(c))[1] > plainR * 1.15, 'the hot keep\'s ring is wider');
});

test('the page\'s wiring: the reach while a fighting host has the hand, a press on a keep, the capture\'s tile, the counts', () => {
  const app = src('app.mjs'), keeps = src('map/keeps.mjs');
  // the reach is lit while a fighting host has the hand (not only while the card stands), from the hand's own model, with the board's reasons for the rest
  assert.match(app, /const host = model\?\.kind === 'host' && keephand\.conquestOn\(FS\) && model\.host && model\.host\.unit !== SCOUT && model\.host\.unit !== SETTLER \? model\.host : null;/);
  assert.match(app, /list = keephand\.keepLights\(km, open \? keepHot : null\);/);
  assert.match(app, /for \(const x of keepReachOf\(FS, host\) \?\? \[\]\) if \(!x\.reachable && !lit\.has\(`\$\{x\.p\},\$\{x\.q\}`\)\) list\.push/);
  assert.match(app, /mapRef\?\.setKeepReach\?\.\(list && list\.length \? list : null\)/);
  // the board's hit test takes the page's own pixels (client px, as map.hostAt)
  assert.match(app, /k = mapRef\.keepAt\(e\.clientX, e\.clientY\)/);
  assert.doesNotMatch(app, /keepAt\(e\.clientX - r\.left/);
  // a press on a keep of the lit reach: in reach, its order (the same as its row); out of reach, no order card
  assert.match(app, /if \(hit0\?\.keep && FS\.mode === 'play' && !FS\.compose && !FS\.hand\?\.pick\) \{/);
  assert.match(app, /if \(hit0\.keep\.reachable && !keephand\.waitOf\(FS, sub\.host\)\) Promise\.resolve\(ACTIONS\['cq-march'\]\(\{ host: sub\.host\.id, p: hit0\.keep\.p, q: hit0\.keep\.q, tile: hit0\.idx \}\)\)/);
  // the capture's event carries the keep's tile; the page reads the records again on it (strip, panels), the effects play on it
  // (rewritten before the take, 2026-10-11: the event carries `donor` after the fields it had, for the character at the capture)
  assert.match(keeps, /fxEmit\('keep:captured', \{ p: m\.p, q: m\.q, tile: m\.tile, from: m\.from, to: m\.to, turn: m\.turn, mine: m\.mine, lost: m\.lost, before: m\.before, after: m\.after, donor: m\.donor \?\? null \}\)/);
  assert.match(app, /for \(const ev of \['keep:captured', 'keep:contest'\]\)/);
  assert.match(src('fx/sheetfx.mjs'), /on\('keep:captured', e => \{ if \(once\(`capture\|\$\{e\.p\},\$\{e\.q\}@\$\{e\.turn \?\? ''\}`, 30\)\) playCapture\(fx, e\); \}\);/);
  // one stylesheet for the hand's panels, linked once; the board added none
  assert.equal(src('index.html').match(/conquest-hand\.css/g)?.length, 1);
});

// ------------------------------------------------------------------ what the real play showed (local test chain, 2026-10-11)
import { setLang } from '../../permutation-server/web/lang.mjs';
import { hostId } from '../../permutation-server/web/frontier/faddr.mjs';
import { baseProduction } from '../../permutation-server/web/frontier/fland.mjs';
import { rowsWithOutcome, summaryOf, verdictOf } from '../../permutation-server/web/frontier/screens/report.mjs';
import { renderKeep } from '../../permutation-server/web/frontier/screens/conquest.mjs';
import { lineOf } from '../../permutation-server/web/frontier/screens/chronicle.mjs';
import { KEEP_4_M1, keepAt, recordAt } from '../../permutation-server/web/frontier/hud/handdemo-data.mjs';

const plain = s => String(s).replace(/<[^>]*>/g, ' ').replace(/&#39;/g, '\'').replace(/\s+/g, ' ');

test('a verified report of a march on a keep says its result: the recomputed outcome laid over the record\'s rows', () => {
  // run uxs1, province -1,-3, turn 297: Ember's 500 on Dunmar's keep (100 defenders, keep generation 0). The record's
  // rows before the province after the turn is read: the arrival's own result, the keep's defenders unknown
  const rows = [
    { id: '275981713539072', kind: 'arrival', faction: 4, unit: 0, before: 500, after: 488, fate: 'Stays', tile: 59, mine: true },
    { id: 'keep', kind: 'garrison', faction: 3, before: 100, after: null, posture: 3, tile: 59, fate: null, mine: false, keep: true }];
  assert.equal(summaryOf(rows).result, 'none', 'before: nothing can be said of the result');
  assert.equal(verdictOf(summaryOf(rows)).key, 'none');
  // the kernel's outcome, as the page held it after 「一致」 (ids as the kernel gives them)
  const outcome = { fighters: [{ id: 275981713539072n, arrival: true, troops: 488351, stamina: 29, fate: { kind: 'Stays', tile: 59 }, engaged: true }],
    garrisons: [{ id: 920291232448512n, troops: 300000 }, { id: 18446744073709486079n, troops: 36575 }, { id: 18446744073709551614n, troops: 210000 }] };
  const after = rowsWithOutcome(rows, outcome, { keep: { gen: 0 }, camp: { gen: 1 } });
  assert.deepEqual(after.map(r => [r.id, r.before, r.after, r.fate]), [['275981713539072', 500, 488, 'Stays'], ['keep', 100, 36, null]]);
  assert.equal(summaryOf(after).result, 'held', 'both sides are still on the field: the keep\'s defenders were not all gone that turn');
  assert.equal(verdictOf(summaryOf(after)).key, 'held');
  // a keep of generation 1 has the id one lower; a keep with nothing left is destroyed; a camp is u64::MAX − its generation
  assert.equal(rowsWithOutcome(rows, { fighters: [], garrisons: [{ id: 18446744073709486078n, troops: 0 }] }, { keep: { gen: 1 } })[1].fate, 'Destroyed');
  assert.equal(rowsWithOutcome([{ id: 'camp', kind: 'camp', faction: 6, before: 210, after: null, tile: 3, fate: null }], outcome, { camp: { gen: 1 } })[0].after, 210);
  // a host the page could not read is the fighter of its id; nothing in the outcome: the row is left as it is
  assert.deepEqual(rowsWithOutcome([{ id: '275981713539072', kind: 'arrival', faction: 4, before: 500, after: null, fate: null, tile: 59 }], outcome)[0].after, 488);
  assert.equal(rowsWithOutcome(rows, { fighters: [], garrisons: [] }, { keep: { gen: 0 } })[1].after, null);
  assert.equal(rowsWithOutcome(rows, null), rows);
  // the page uses it only when the recomputed outcome is the chain's record, and then says so of "what if"
  const report = src('screens/report.mjs');
  assert.match(report, /v\?\.outcome && v\.result === 'match' \? rowsWithOutcome\(recRows\(\), v\.outcome, r\.before \?\? null\) : recRows\(\)/);
  assert.match(report, /「練習で試す」は、この戦いでは使えません/);
});

test('a march\'s outcome in the chronicle is read with the log\'s own codes (1 Stays … 5 Destroyed)', () => {
  // record seq 38548 of run uxs1: host 275981713539072 stayed on the keep's tile, outcome 1
  assert.equal(lineOf({ name: 'TRANSIT_SETTLED', outcome: 1 }, null), '進軍の結果：戦場に残った');
  setLang('en');
  try {
    assert.equal(lineOf({ name: 'TRANSIT_SETTLED', outcome: 1 }, null), 'A march ended: Held the field');
    assert.equal(lineOf({ name: 'TRANSIT_SETTLED', outcome: 4 }, null), 'A march ended: Retreated');
  } finally { setLang('ja'); }
});

test('the keep panel says the viewer\'s host holds the keep\'s tile, and does not offer to send it there', () => {
  const SEASON3 = { programVersion: 3, layoutVersion: 2, endBell: 2016, bellSecs: 600, dormantAfterSecs: 86400, releaseAfterSecs: 172800, minLead: 2, maxLead: 72, conquestParams: { keepBells: 72 } };
  const HOME = { p: 2, q: 0, site: 2, gen: 0, tile: 20, faction: 0, state: 2, order: 1, tier: 0, flags: 0, production: baseProduction(0), upkeep: Array(8).fill(0n), stores: [], reserve: Array(8).fill(0), queue: [], transit: [{ state: 0 }], explore: { state: 0 }, lastOwnerAction: 1000n, finalTs: 1n, shieldUntil: 0n };
  const id = hostId({ p: 2, q: 0, site: 2, gen: 0, seq: 1 });
  // the host stands on the keep's own tile (4,-1 tile 10), short of stamina after its march
  const entry = { id, unit: 0, state: 1, tile: 10, troops: 486000, staminaValue: 37, staminaBell: 20, readyBell: 10, pendOp: 0, fromBell: 10, home: { p: 2, q: 0, site: 2, gen: 0 } };
  const bell = 20;
  const fsAt = entries => ({ mode: 'play', season: SEASON3, citizen: { faction: 0 }, holdings: [HOME], nowBell: bell, chain: { now: () => 1000 }, land: { stage: 'final' }, inFlight: 0,
    provinces: new Map([['2,0', { province: { p: 2, q: 0, resolvedNext: bell, entries: [], ticketCohorts: [] } }], ['4,-1', { province: { p: 4, q: -1, resolvedNext: bell, entries, ticketCohorts: [] } }]]),
    conquest: { status: 'ready', keeps: new Map([['4,-1', keepAt(KEEP_4_M1, bell)]]), history: new Map([['4,-1', recordAt(KEEP_4_M1, bell)]]), standings: STANDINGS_BEFORE, final: null, events: [] } });
  const there = K.hostsOnTile(fsAt([entry]), 4, -1, 10);
  assert.deepEqual(there.map(x => [x.unit, x.troops]), [[0, 486]]);
  setLang('en');
  try {
    assert.equal(K.holdingHereText(there), 'Your host is holding this keep\'s tile: 486 Spearmen');
    const out = plain(renderKeep(fsAt([entry]), keepAt(KEEP_4_M1, bell)));
    assert.match(out, /Your host is holding this keep's tile: 486 Spearmen/);
    assert.doesNotMatch(out, /486 Spearmen: short of stamina/, 'the host that holds the tile is not said to be waiting to depart for it');
  } finally { setLang('ja'); }
  assert.deepEqual(K.hostsOnTile(fsAt([]), 4, -1, 10), []);
  // the source: the hosts on the tile are taken out of the offers and the waits
  const cq = src('screens/conquest.mjs');
  assert.match(cq, /const here = FS\.mode === 'play' \? hostsOnTile\(FS, m\.p, m\.q, m\.tile\) : \[\], hereIds = new Set\(here\.map\(x => x\.id\)\);/);
  assert.match(cq, /hostWaits\(FS\)\.filter\(w => !hereIds\.has\(w\.id\) &&/);
});
