// The keeps on the board (map/keeps.mjs): the records' reader and the capture's timeline, on REAL records of a
// finished conquest season on the local test chain (run ux-check: the keep of province 4,-1, held by Fjordal (5),
// contested by Aster (0) from turn 12 and taken at turn 83). The control rows below are the herald's own
// /h/control/{turn}.bin of turns 11, 12, 13, 82, 83 and 84, decoded (herald.mjs decodeControl) and cut down to the
// five provinces round that keep; the keeps' tiles and defenders are /h/overview2's; the capture is /h/keep/4,-1.json
// `captures[0]`, in the shape /h/conquest/{day}.json gives its `keep_taken` event.
import test from 'node:test';
import assert from 'node:assert/strict';
import { KeepBook, KeepBoard, keepRows, provinceCounts, captureAt, captureMs, CAPTURE, CONTROL_GRACE_MS, KEEP_NEWS_TURNS, provinceGeo, holdText, countText, gainText } from '../../permutation-server/web/frontier/map/keeps.mjs';
import { applyControl, mergeKeepEvents } from '../../permutation-server/web/frontier/fconquest.mjs';
import { bus } from '../../permutation-server/web/frontier/fx/bus.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';

const OVERVIEW = [{ p: 3, q: -1, keepTile: 10, keepTroops: 100 }, { p: 3, q: 0, keepTile: 1, keepTroops: 100 }, { p: 4, q: -2, keepTile: 4, keepTroops: 100 }, { p: 4, q: -1, keepTile: 10, keepTroops: 241 }, { p: 4, q: 0, keepTile: 0, keepTroops: 100 }];
const row = (p, q, control, contender, progress, heartland) => ({ p, q, control, contender, progress, required: 72, heartland });
const CONTROL = {
  11: [row(3, 0, 0, 7, 0, true), row(3, -1, 5, 7, 0, true), row(4, 0, 0, 7, 0, false), row(4, -2, 5, 7, 0, false), row(4, -1, 5, 7, 0, false)],
  12: [row(3, 0, 0, 7, 0, true), row(3, -1, 5, 7, 0, true), row(4, 0, 0, 7, 0, false), row(4, -2, 5, 7, 0, false), row(4, -1, 5, 0, 1, false)],
  13: [row(3, 0, 0, 7, 0, true), row(3, -1, 5, 7, 0, true), row(4, 0, 0, 7, 0, false), row(4, -2, 5, 7, 0, false), row(4, -1, 5, 0, 2, false)],
  82: [row(3, 0, 0, 7, 0, true), row(3, -1, 5, 7, 0, true), row(4, 0, 0, 7, 0, false), row(4, -2, 5, 7, 0, false), row(4, -1, 5, 0, 71, false)],
  83: [row(3, 0, 0, 7, 0, true), row(3, -1, 5, 7, 0, true), row(4, 0, 0, 7, 0, false), row(4, -2, 5, 7, 0, false), row(4, -1, 0, 7, 0, false)],
  84: [row(3, 0, 0, 7, 0, true), row(3, -1, 5, 7, 0, true), row(4, 0, 0, 7, 0, false), row(4, -2, 5, 7, 0, false), row(4, -1, 0, 7, 0, false)],
};
/** The capture's record (/h/keep/4,-1.json captures[0]) as the day's file lists it. */
const TAKEN = { seq: '10696', bell: 83, sig: '4WwZktjF2KUobqepbfLWNhCPWXAWGcbYLBSAQfwYKkPGge7feRf6SwdcsLX17pee8xmDgXHL6wtM25HuAvidVBMK', kind: 'keep_taken', p: 4, q: -1, from: 5, to: 0, detail: { troops: 241 } };
const CONTEST = { seq: '1502', bell: 12, kind: 'keep_contest', p: 4, q: -1, from: 5, to: 0, detail: { progress: 1 } };

/** The map's records at `turn`, as the page makes them: the overview's provinces with the control record laid on them (fconquest.mjs applyControl). */
function recsAt(turn) {
  const ov = { provinces: OVERVIEW.map(r => ({ ...r })) };
  applyControl(new Map([[4, ov]]), { provinces: CONTROL[turn] });
  return new Map(ov.provinces.map(r => [`${r.p},${r.q}`, r]));
}
const events = (...list) => mergeKeepEvents(null, list);

test('keepRows reads a keep, its holder and its contest from the control record laid on the overview', () => {
  const rows = keepRows(recsAt(82)), k = rows.find(r => r.key === '4,-1');
  assert.equal(rows.length, 5);
  assert.deepEqual({ tile: k.tile, holder: k.holder, troops: k.troops, contender: k.contender, held: k.held, of: k.of, heartland: k.heartland }, { tile: 10, holder: 5, troops: 241, contender: 0, held: 71, of: 72, heartland: false });
  // (contender 7 is "nobody": the record's own way of saying it)
  assert.equal(rows.find(r => r.key === '4,0').contender, null);
  assert.deepEqual(provinceCounts(rows), [2, 0, 0, 0, 0, 3]);
  // a province without a keep (rings 0 and 1), or records that are not a conquest season's, give no row
  assert.deepEqual(keepRows(new Map([['0,0', { p: 0, q: 0, keepTile: null, control: 0 }], ['1,0', { p: 1, q: 0 }]])), []);
  assert.deepEqual(keepRows(null), []);
});

test('what a page opens with is simply there: no moment for a contest or a capture of the past', () => {
  const book = new KeepBook();
  assert.deepEqual(book.read({ rows: keepRows(recsAt(82)), events: events(CONTEST), viewer: 0, now: 0, bell: 82 }), []);
  assert.equal(book.shown('4,-1'), 5);
  assert.deepEqual(book.contests.get('4,-1'), { by: 0, held: 71, of: 72 });
  // a page that opens after the capture: the record's past is not played, whenever its day's file is read
  const late = new KeepBook();
  assert.deepEqual(late.read({ rows: keepRows(recsAt(84)), events: null, viewer: 0, now: 0, bell: 84 }), []);
  assert.deepEqual(late.read({ rows: keepRows(recsAt(84)), events: events(CONTEST, TAKEN), viewer: 0, now: 100, bell: 84 }), []);
  assert.deepEqual(late.read({ rows: keepRows(recsAt(84)), events: events(CONTEST, TAKEN, { ...TAKEN, seq: '9', bell: 20, p: 4, q: 0, from: 5, to: 0 }), viewer: 0, now: 200, bell: 84 }), [], 'an old capture read late is the past');
  assert.equal(late.shown('4,-1'), 0);
});

test('a contest: the turn the contender begins, each turn it holds, and the turn the record says it ended', () => {
  const book = new KeepBook();
  book.read({ rows: keepRows(recsAt(11)), events: [], viewer: 0, now: 0, bell: 11 });
  const begun = book.read({ rows: keepRows(recsAt(12)), events: events(CONTEST), viewer: 0, now: 1000, bell: 12 });
  assert.deepEqual(begun, [{ kind: 'contest', p: 4, q: -1, tile: 10, held: 1, of: 72, by: 0, mine: true, defend: false, fresh: true }]);
  const next = book.read({ rows: keepRows(recsAt(13)), events: events(CONTEST), viewer: 0, now: 2000, bell: 13 });
  assert.deepEqual(next, [{ kind: 'contest', p: 4, q: -1, tile: 10, held: 2, of: 72, by: 0, mine: true, defend: false, fresh: false }]);
  // the same reading again says nothing
  assert.deepEqual(book.read({ rows: keepRows(recsAt(13)), events: events(CONTEST), viewer: 0, now: 2500, bell: 13 }), []);
  // the record says the contest ended (`keep_broken`): the hold is broken with that word, while the control record read
  // with it is still the turn's before (seen on uxs1, turn 147: the record came some twenty seconds before the snapshot)
  const BROKEN = { seq: '1600', bell: 14, kind: 'keep_broken', p: 4, q: -1, from: 0, to: 5 };
  const broken = book.read({ rows: keepRows(recsAt(13)), events: events(CONTEST, BROKEN), viewer: 0, now: 3000, bell: 14 });
  assert.deepEqual(broken, [{ kind: 'broken', p: 4, q: -1, tile: 10, held: 2, of: 72, by: 0, mine: true, defend: false }]);
  assert.equal(book.contests.has('4,-1'), false);
  // the old snapshot again does not begin it anew; the snapshot without the contender says nothing more
  assert.deepEqual(book.read({ rows: keepRows(recsAt(13)), events: events(CONTEST, BROKEN), viewer: 0, now: 3200, bell: 14 }), []);
  assert.deepEqual(book.read({ rows: keepRows(recsAt(11)), events: events(CONTEST, BROKEN), viewer: 0, now: 3400, bell: 15 }), []);
  // a new contest by the same nation after that begins at one turn, and is told
  assert.deepEqual(book.read({ rows: keepRows(recsAt(12)), events: events(CONTEST, BROKEN), viewer: 0, now: 3600, bell: 16 }).map(m => [m.kind, m.held, m.fresh]), [['contest', 1, true]]);
  // without the record (the day's file unread) the control record alone says it: the contender is gone, the holder the same
  const alone = new KeepBook();
  alone.read({ rows: keepRows(recsAt(13)), events: null, viewer: 0, now: 0, bell: 13 });
  assert.deepEqual(alone.read({ rows: keepRows(recsAt(11)), events: null, viewer: 0, now: 10, bell: 14 }), [{ kind: 'broken', p: 4, q: -1, tile: 10, held: 2, of: 72, by: 0, mine: true, defend: false }]);
  // seen from the holder's side the same contest is one to defend against
  const theirs = new KeepBook();
  theirs.read({ rows: keepRows(recsAt(11)), events: [], viewer: 5, now: 0, bell: 11 });
  assert.deepEqual(theirs.read({ rows: keepRows(recsAt(12)), events: [], viewer: 5, now: 1, bell: 12 }).map(m => [m.kind, m.mine, m.defend]), [['contest', false, true]]);
});

test('the capture is played once, from its own record, with the provinces counted before and after', () => {
  const book = new KeepBook();
  book.read({ rows: keepRows(recsAt(82)), events: events(CONTEST), viewer: 0, now: 0, bell: 82 });
  // the control record and the day's file of turn 83 arrive together
  const got = book.read({ rows: keepRows(recsAt(83)), events: events(CONTEST, TAKEN), viewer: 0, now: 5000, bell: 84 });
  // (rewritten before the take, 2026-10-11: the capture's moment also carries `donor`, the host that went into the keep
  // where the record the page holds names it — the viewer's character stands by the keep it took while the capture
  // plays, people/onboard.mjs captureStand. The page's merged keep events do not carry it, so it is null here)
  assert.deepEqual(got, [{ kind: 'captured', p: 4, q: -1, tile: 10, from: 5, to: 0, turn: 83, mine: true, lost: false, before: 2, after: 3, lostBefore: 3, lostAfter: 2, by: 'record', donor: null }]);
  assert.equal(book.shown('4,-1'), 0);
  assert.deepEqual(book.counts(), [3, 0, 0, 0, 0, 2]);
  // neither the next reading nor the next turn's records play it again, and the contest that ended in it is not "broken"
  assert.deepEqual(book.read({ rows: keepRows(recsAt(83)), events: events(CONTEST, TAKEN), viewer: 0, now: 6000, bell: 84 }), []);
  assert.deepEqual(book.read({ rows: keepRows(recsAt(84)), events: events(CONTEST, TAKEN), viewer: 0, now: 9000, bell: 85 }), []);
});

test('the capture record before the control record, and the control record before the capture record: one capture either way', () => {
  // the day's file first: the board believes the capture's own record and shows the new holder; the old snapshot does not undo it
  const a = new KeepBook();
  a.read({ rows: keepRows(recsAt(82)), events: events(CONTEST), viewer: 5, now: 0, bell: 82 });
  const first = a.read({ rows: keepRows(recsAt(82)), events: events(CONTEST, TAKEN), viewer: 5, now: 1000, bell: 84 });
  assert.deepEqual(first.map(m => [m.kind, m.from, m.to, m.turn, m.mine, m.lost, m.lostBefore, m.lostAfter, m.by]), [['captured', 5, 0, 83, false, true, 3, 2, 'record']]);
  assert.equal(a.shown('4,-1'), 0);
  assert.deepEqual(a.read({ rows: keepRows(recsAt(82)), events: events(CONTEST, TAKEN), viewer: 5, now: 1500, bell: 84 }), [], 'the snapshot of turn 82 again');
  // …nor does a turn's change in between (the overviews read before the control record is laid on them), however long it takes
  const blank = new Map(OVERVIEW.map(r => [`${r.p},${r.q}`, { ...r }]));
  assert.deepEqual(a.read({ rows: keepRows(blank), events: events(CONTEST, TAKEN), viewer: 5, now: 2000, bell: 84 }), []);
  assert.deepEqual(a.read({ rows: keepRows(recsAt(82)), events: events(CONTEST, TAKEN), viewer: 5, now: 2100, bell: 84 }), []);
  assert.deepEqual(a.read({ rows: keepRows(recsAt(82)), events: events(CONTEST, TAKEN), viewer: 5, now: 2100 + CONTROL_GRACE_MS + 1, bell: 84 }), [], 'the old snapshot never takes the province back');
  assert.equal(a.shown('4,-1'), 0);
  assert.deepEqual(a.read({ rows: keepRows(recsAt(83)), events: events(CONTEST, TAKEN), viewer: 5, now: 3000, bell: 84 }), [], 'the control record catches up');
  assert.equal(a.shown('4,-1'), 0);
  // the control record first: the old holder stays shown for a moment, then the capture's record plays it
  const b = new KeepBook();
  b.read({ rows: keepRows(recsAt(82)), events: events(CONTEST), viewer: 0, now: 0, bell: 82 });
  assert.deepEqual(b.read({ rows: keepRows(recsAt(83)), events: events(CONTEST), viewer: 0, now: 1000, bell: 84 }), []);
  assert.equal(b.shown('4,-1'), 5, 'waiting for the capture record');
  const then = b.read({ rows: keepRows(recsAt(83)), events: events(CONTEST, TAKEN), viewer: 0, now: 2000, bell: 84 });
  assert.deepEqual(then.map(m => [m.kind, m.turn, m.by]), [['captured', 83, 'record']]);
  // the capture record never comes (the day's file could not be read): the control record's own change is played after the wait
  const c = new KeepBook();
  c.read({ rows: keepRows(recsAt(82)), events: events(CONTEST), viewer: 0, now: 0, bell: 82 });
  assert.deepEqual(c.read({ rows: keepRows(recsAt(83)), events: events(CONTEST), viewer: 0, now: 1000, bell: 84 }), []);
  assert.deepEqual(c.read({ rows: keepRows(recsAt(83)), events: events(CONTEST), viewer: 0, now: 1000 + CONTROL_GRACE_MS - 1, bell: 84 }), []);
  const late = c.read({ rows: keepRows(recsAt(83)), events: events(CONTEST), viewer: 0, now: 1000 + CONTROL_GRACE_MS, bell: 84 });
  assert.deepEqual(late.map(m => [m.kind, m.from, m.to, m.turn, m.by]), [['captured', 5, 0, null, 'control']]);
  // …and the record, read later still, is not a second capture
  assert.deepEqual(c.read({ rows: keepRows(recsAt(84)), events: events(CONTEST, TAKEN), viewer: 0, now: 20000, bell: 85 }), []);
  // a page without the days' files at all plays the control record's change at once
  const d = new KeepBook();
  d.read({ rows: keepRows(recsAt(82)), events: null, viewer: null, now: 0, bell: 82 });
  assert.deepEqual(d.read({ rows: keepRows(recsAt(83)), events: null, viewer: null, now: 1, bell: 83 }).map(m => [m.kind, m.mine, m.lost, m.by]), [['captured', false, false, 'control']]);
  assert.ok(KEEP_NEWS_TURNS >= 2, 'a turn is settled after it ends: its capture is still news then');
});

test('a holder the record did not say yet (the overview before the control record) is not a capture', () => {
  const book = new KeepBook(), bare = new Map(OVERVIEW.map(r => [`${r.p},${r.q}`, { ...r }]));
  assert.deepEqual(book.read({ rows: keepRows(bare), events: null, viewer: 0, now: 0 }), []);
  assert.deepEqual(book.read({ rows: keepRows(recsAt(82)), events: null, viewer: 0, now: 10 }), []);
  assert.equal(book.shown('4,-1'), 5);
});

test('the capture\'s timeline: the standard, the flood from the keep outward in about a second, the edge, the number', () => {
  assert.equal(captureAt(0).strike, 0);
  assert.equal(captureAt(CAPTURE.strike).strike, null, 'the old standard is down');
  assert.equal(captureAt(CAPTURE.raiseAt - 1).raise, null);
  assert.equal(captureAt(CAPTURE.raiseAt + CAPTURE.raise).raise, 1);
  // tile by tile: the keep's own tile first, the far corner last, all of it within about a second
  const maxD = 8, t0 = CAPTURE.floodAt;
  assert.equal(captureAt(t0).tile(0, maxD).in, 0);
  assert.ok(captureAt(t0 + 150).tile(0, maxD).in > 0.5 && captureAt(t0 + 150).tile(maxD, maxD).in === 0);
  for (let d = 1; d <= maxD; d++) assert.ok(captureAt(t0 + 500).tile(d - 1, maxD).in >= captureAt(t0 + 500).tile(d, maxD).in, `ring ${d} follows ring ${d - 1}`);
  assert.equal(captureAt(t0 + CAPTURE.flood).tile(maxD, maxD).in, 1);
  assert.ok(CAPTURE.flood >= 800 && CAPTURE.flood <= 1200, 'about a second');
  assert.equal(captureAt(t0 + CAPTURE.flood - 1).flooded, false);
  assert.equal(captureAt(t0 + CAPTURE.flood).flooded, true);
  // the edge is redrawn after the flood has passed; the number rises while the words stand
  assert.equal(captureAt(CAPTURE.edgeAt).edge, 0);
  assert.equal(captureAt(CAPTURE.edgeAt + CAPTURE.edge).edge, 1);
  assert.equal(captureAt(CAPTURE.numberAt - 1).number, null);
  assert.ok(captureAt(CAPTURE.numberAt + 100).number > 0);
  assert.equal(captureAt(captureMs() - 1).done, false);
  assert.equal(captureAt(captureMs()).done, true);
  // a loss drains first: its flood starts later by the drain
  assert.equal(captureAt(t0 + 100, { lost: true }).tile(0, maxD).in, 0);
  assert.ok(captureAt(t0 + CAPTURE.drain + 150, { lost: true }).tile(0, maxD).in > 0.5);
  assert.equal(captureAt(100, { lost: true }).drain > 0, true);
});

test('a province\'s geometry: its 61 tiles and an outer edge whose every piece knows the province beyond', () => {
  const g = provinceGeo(4, -1);
  assert.equal(g.tiles.length, 61);
  assert.ok(g.edges.length > 0 && g.edges.every(e => Number.isInteger(e.np) && Number.isInteger(e.nq) && !(e.np === 4 && e.nq === -1)));
  const beyond = new Set(g.edges.map(e => `${e.np},${e.nq}`));
  assert.equal(beyond.size, 6, 'six neighbours');
  assert.ok(beyond.has('3,-1') && beyond.has('4,-2') && beyond.has('4,0') && beyond.has('3,0'));
  assert.equal(provinceGeo(4, -1), g, 'kept');
});

test('the board says each change once on the effects bus and plays the capture for its whole length', () => {
  setLang('en');
  const said = [], off = bus.on('*', (e, type) => { if (String(type).startsWith('keep:')) said.push([type, e]); });
  try {
    const board = new KeepBoard();
    const feed = (turn, ...ev) => ({ events: events(...ev), viewer: 0, bell: turn });
    board.frame(recsAt(11), feed(11), { fx: 0 });
    board.frame(recsAt(12), feed(12, CONTEST), { fx: 1000 });
    assert.deepEqual(said, [['keep:contest', { p: 4, q: -1, held: 1, of: 72, by: 0, mine: true }]]);
    board.frame(recsAt(12), feed(12, CONTEST), { fx: 1100 });
    assert.equal(said.length, 1, 'the same records: nothing more');
    board.frame(recsAt(82), feed(82, CONTEST), { fx: 2000 });
    assert.deepEqual(said[1], ['keep:contest', { p: 4, q: -1, held: 71, of: 72, by: 0, mine: true }]);
    board.frame(recsAt(83), feed(84, CONTEST, TAKEN), { fx: 10000 });
    // (the keep's tile rides with the event since the integration: the effects place the capture's clip on it without a lookup)
    // (rewritten before the take, 2026-10-11: the event carries `donor` too, null where the record read does not name it)
    assert.deepEqual(said[2], ['keep:captured', { p: 4, q: -1, tile: 10, from: 5, to: 0, turn: 83, mine: true, lost: false, before: 2, after: 3, donor: null }]);
    assert.equal(said.length, 3, 'a capture is not also a broken hold');
    assert.deepEqual(board.want, { p: 4, q: -1, tile: 10 }, 'the camera is asked to come to the viewer\'s own capture');
    // while the flood runs the far wash still shows the old holder; then the new one
    assert.equal(board.farHolder('4,-1', 10000 + CAPTURE.floodAt + 10), 5);
    assert.equal(board.farHolder('4,-1', 10000 + CAPTURE.floodAt + CAPTURE.flood), 0);
    assert.ok(board.capturing('4,-1', 10000 + 500));
    assert.equal(board.capturing('4,-1', 10000 + captureMs()), null);
    assert.equal(board.live(), false, 'nothing moves once it is over');
    // reduced motion: the province is its new holder's at once and only the line that counts the provinces stands
    const calm = new KeepBoard();
    calm.frame(recsAt(82), feed(82, CONTEST), { fx: 0, still: true });
    calm.frame(recsAt(83), feed(84, CONTEST, TAKEN), { fx: 5000, still: true });
    const now = calm.capturing('4,-1', 5000);
    assert.deepEqual([now.at.strike, now.at.raise, now.at.edge, now.at.flooded, now.at.words > 0], [null, 1, 1, true, true]);
    assert.equal(calm.farHolder('4,-1', 5000), 0);
    assert.equal(holdText(12, 72), 'Holding the keep · 12 / 72 turns');
    assert.equal(countText(9, 10), 'Provinces held 9 → 10');
    assert.equal(gainText(), '+1 province');
  } finally { off(); setLang('ja'); }
});

test('the reach list: what lights, what stays dim, and the answer to a tap', () => {
  const said = [], off = bus.on('keep:tap', e => said.push(e));
  try {
    const board = new KeepBoard();
    board.frame(recsAt(82), { events: [], viewer: 0, bell: 82 }, { fx: 0 });
    assert.equal(board.setReach([{ p: 4, q: -1, tile: 10, arriveTurn: 86, holder: 5, defenders: 241, reachable: true, why: null }, { p: 3, q: -1, tile: 10, arriveTurn: null, holder: 5, defenders: 100, reachable: false, why: 'A heartland keep cannot be taken' }]), true);
    assert.equal(board.setReach([{ p: 4, q: -1, tile: 10, arriveTurn: 86, holder: 5, defenders: 241, reachable: true, why: null }, { p: 3, q: -1, tile: 10, arriveTurn: null, holder: 5, defenders: 100, reachable: false, why: 'A heartland keep cannot be taken' }]), false, 'the same list again changes nothing');
    assert.equal(board.reachOwn, true);
    assert.equal(board.lit.get('4,-1').reachable, true);
    assert.equal(board.tapped({ p: 4, q: -1 }, 100).reachable, true);
    assert.equal(board.note, null, 'a lit keep needs no answer: the tap chooses it');
    assert.equal(board.tapped({ p: 3, q: -1 }, 200).reachable, false);
    assert.deepEqual(board.note, { key: '3,-1', text: 'A heartland keep cannot be taken', at: 200 });
    assert.equal(board.tapped({ p: 4, q: 0 }, 300), null, 'a keep the list does not name');
    assert.deepEqual(said, [{ p: 4, q: -1, tile: 10, reachable: true, why: null }, { p: 3, q: -1, tile: 10, reachable: false, why: 'A heartland keep cannot be taken' }]);
    assert.equal(board.setReach(null), true);
    assert.equal(board.lit, null);
    // the keep under a point of a flat board: its tile, or its walls standing over the tile
    const P = board.place(board.rows.get('4,-1'), 1);
    assert.deepEqual(board.at(P.cx, P.cy, 1), { p: 4, q: -1, tile: 10 });
    assert.deepEqual(board.at(P.x, P.y - P.u, 1), { p: 4, q: -1, tile: 10 });
    assert.equal(board.at(P.cx + 4000, P.cy, 1), null);
  } finally { off(); }
});

test('the overviews of a new turn before the control record is laid on them again: nothing is known, so nothing changes', () => {
  // (seen on the local test chain, 2026-10-11: at each turn's change every contest was said to be broken, and a moment later to have begun)
  const book = new KeepBook(), bare = new Map(OVERVIEW.map(r => [`${r.p},${r.q}`, { ...r }]));
  book.read({ rows: keepRows(recsAt(13)), events: events(CONTEST), viewer: 0, now: 0, bell: 13 });
  assert.deepEqual(book.read({ rows: keepRows(bare), events: events(CONTEST), viewer: 0, now: 1000, bell: 14 }), []);
  assert.equal(book.shown('4,-1'), 5, 'the holder it had is still shown');
  assert.deepEqual(book.contests.get('4,-1'), { by: 0, held: 2, of: 72 }, 'the contest stands');
  assert.deepEqual(book.read({ rows: keepRows(recsAt(13)), events: events(CONTEST), viewer: 0, now: 1200, bell: 14 }), [], 'the same control record laid on again');
  assert.deepEqual(book.read({ rows: keepRows(recsAt(82)), events: events(CONTEST), viewer: 0, now: 1400, bell: 82 }).map(m => [m.kind, m.held, m.fresh]), [['contest', 71, false]]);
});
