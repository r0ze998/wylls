// Workstream 07: the away summary's continuity (hud/returnsum.mjs, hud/awayread.mjs, app.mjs). These tests ask for
// the right behaviour; the defects they replace (C1–C6 of workstreams/07-player-experience/INTEGRATION.ja.md) were:
// "seen" moved the mark over a gap and over a first look's unread past, the page claimed a complete read, a taken
// caravan's later records were the sender's between two looks, duplicates and order were not mended, and the
// chronicle of another scope could feed the summary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LOGS } from '../../permutation-server/web/sdk/frontier/abi-v2-logs.mjs';
import { toBase64 } from '../../permutation-server/web/sdk/bytes.mjs';
import { decodeRecord } from '../../permutation-server/web/frontier/flog.mjs';
import * as RS from '../../permutation-server/web/frontier/hud/returnsum.mjs';
import * as RW from '../../permutation-server/web/frontier/hud/returnwords.mjs';
import * as RR from '../../permutation-server/web/frontier/hud/awayread.mjs';
import * as feed from '../../permutation-server/web/frontier/hud/feed.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';

// ---------------------------------------------------------------- records as the herald serves them
function body(name, bell, fields = {}) {
  const spec = LOGS.kinds.find(k => k.name === name);
  const parts = [...spec.key, ...spec.payload];
  const b = new Uint8Array(6 + parts.reduce((a, f) => a + f.len, 0) + 1), v = new DataView(b.buffer);
  b[0] = 1; b[1] = spec.kind; v.setUint32(2, bell, true);
  let o = 6;
  for (const f of parts) {
    const x = fields[f.name];
    if (x instanceof Uint8Array) b.set(x.subarray(0, f.len), o);
    else if (x !== undefined) {
      if (f.len === 8) v.setBigUint64(o, BigInt(x), true); else if (f.len === 4) v.setInt32(o, Number(x), true);
      else if (f.len === 2) v.setUint16(o, Number(x), true); else if (f.len === 1) b[o] = Number(x);
    }
    o += f.len;
  }
  return toBase64(b);
}
const cargo = arr => { const b = new Uint8Array(32), v = new DataView(b.buffer); arr.forEach((n, i) => v.setUint32(i * 4, n, true)); return b; };
const ME = 0x51n, RAIDER = 0x77n, OTHER = 0x91n;
const ev = (seq, name, bell, f) => ({ seq: String(seq), body_b64: body(name, bell, f) });
const rec = e => ({ seq: e.seq, record: decodeRecord(e.body_b64) });
const me = { tag: ME, faction: 2, holdings: [{ p: 0, q: 0, site: 0 }], hostOf: () => null };
const storage = () => { const m = new Map(); return { m, getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) }; };
const sum = (o) => RS.summarize({ season: '7', wallet: 'W', nowBell: 400, me, last: null, ...o });

// a history: my caravan 3 is sent, taken by RAIDER, then settles (for RAIDER); my caravan 4 settles for me;
// another's caravan 9 settles; a siege on my village
const H = [
  ev(101, 'CARAVAN_SENT', 300, { owner_tag: ME, seq: 3, faction: 2 }),
  ev(102, 'CARAVAN_SENT', 301, { owner_tag: ME, seq: 4, faction: 2 }),
  ev(103, 'RAID_OPENED', 305, { owner_tag: ME, seq: 3, p: 1, q: 0, bell: 305, raider_tag: RAIDER }),
  ev(104, 'CARAVAN_RAIDED', 310, { owner_tag: ME, seq: 3, p: 1, q: 0, bell: 305, choice: 0, by: 0, raider_tag: RAIDER, taken: cargo([0, 300, 0, 0, 0, 0, 0, 0]) }),
  ev(105, 'CARAVAN_SETTLED', 320, { owner_tag: ME, seq: 4, outcome: 0, cargo: cargo([400, 0, 0, 0, 0, 0, 0, 0]) }),
  ev(106, 'CARAVAN_SETTLED', 330, { owner_tag: ME, seq: 3, outcome: 0, cargo: cargo([0, 300, 0, 0, 0, 0, 0, 0]) }),
  ev(107, 'CARAVAN_SETTLED', 331, { owner_tag: OTHER, seq: 9, outcome: 0, cargo: cargo([5, 0, 0, 0, 0, 0, 0, 0]) }),
  ev(108, 'SIEGE_DECLARED', 340, { p: 0, q: 0, site: 0, attacker: 3, owner_faction: 2, owner_tag: ME, required: 44 }),
];
const R = H.map(rec);

/** A herald whose `events(after)` serves H in pages of `size` (`fail`: the page numbers that fail). */
function herald(events, { size = 3, fail = new Set(), delay = 0 } = {}) {
  let calls = 0;
  return { get calls() { return calls; }, async events(after) {
    const n = calls++;
    if (delay) await new Promise(r => setTimeout(r, delay));
    if (fail.has(n)) return { ok: false, code: 'Down' };
    const rows = events.filter(e => BigInt(e.seq) > BigInt(after)).slice(0, size);
    return { ok: true, events: rows, next: rows.at(-1)?.seq ?? null, full: rows.length === size };
  } };
}

// ---------------------------------------------------------------- C1: a gap never moves the mark
test('C1: with a gap between the mark and what was read, "seen" is not offered and the mark does not move', () => {
  setLang('ja');
  const st = storage();
  RS.confirm(st, { seasonId: '7', wallet: 'W', confirm: { ok: true, toSeq: '100', toBell: 299, horizonBell: null, caravans: {} }, at: 1 });
  const s = sum({ records: R.slice(4), read: { after: '104', complete: true }, marks: RS.loadMarks(st, '7', 'W') });
  assert.deepEqual(s.gap, { afterSeq: '100', beforeSeq: '105' });
  assert.deepEqual(s.confirm, { ok: false, why: 'gap' });
  assert.equal(RS.confirm(st, { seasonId: '7', wallet: 'W', confirm: s.confirm, at: 2 }), null);
  assert.equal(RS.loadMarks(st, '7', 'W').confirmedSeq, '100', 'the mark stays before the gap');
  assert.match(RW.confirmText(s), /欠けた記録を読めるまで、確認の位置は進めません/);
  const toast = String(feed.renderToast({ id: 'away:x', kind: 'away', bell: 400, text: 't', away: { ok: false, summary: s } }));
  assert.doesNotMatch(toast, /data-act="away-seen"/, 'no "seen" button');
  assert.match(toast, /data-act="feed-dismiss"/, '× still closes it');
});

test('C1: the reader reads from the mark itself, so a mark older than the chronicle\'s window is no gap', async () => {
  const r = RR.createAwayReader({ events: herald(H, { size: 3 }).events });
  const got = await r.start({ scope: 's', from: '100' });
  assert.equal(got.complete, true);
  assert.deepEqual(got.records.map(x => x.seq), ['101', '102', '103', '104', '105', '106', '107', '108']);
  const s = sum({ records: got.records, read: got, marks: { confirmedSeq: '100', confirmedBell: 299, caravans: {} } });
  assert.equal(s.gap, null);
  assert.equal(s.confirm.ok, true);
  assert.equal(s.confirm.toSeq, '108');
});

// ---------------------------------------------------------------- C3: a read that stopped says so and confirms only what it read
test('C3: a page that fails stops the reading; the mark can move over what was read and no further', async () => {
  const h = herald(H, { size: 3, fail: new Set([1]) });
  const r = RR.createAwayReader({ events: h.events });
  const got = await r.start({ scope: 's', from: '100' });
  assert.deepEqual([got.failed, got.complete, got.records.map(x => x.seq)], [true, false, ['101', '102', '103']]);
  setLang('ja');
  const s = sum({ records: got.records, read: got, marks: { confirmedSeq: '100', confirmedBell: 299, caravans: {} } });
  assert.deepEqual([s.failed, s.incomplete, s.confirm.toSeq, s.confirm.partial], [true, true, '103', true]);
  assert.match(RW.headText(s), /読み込みが途中で失敗しました/);
  assert.match(RW.confirmText(s), /読めた第305ターンまで/);
  // the next reading continues from the last record read
  const rest = await r.more();
  assert.deepEqual(rest.records.map(x => x.seq), ['104', '105', '106', '107', '108']);
  assert.equal(rest.complete, true);
});

test('C3: the page limit is not a complete read', async () => {
  const r = RR.createAwayReader({ events: herald(H, { size: 2 }).events, pages: 2 });
  const got = await r.start({ scope: 's', from: '100' });
  assert.deepEqual([got.complete, got.failed, got.records.length], [false, false, 4]);
});

// ---------------------------------------------------------------- C2: a first look's past is not marked as seen
test('C2: a first look marks its window\'s first turn as the horizon; a later look says nothing before it was seen here', () => {
  setLang('ja');
  const st = storage();
  const first = sum({ records: R, read: { after: '100', complete: true }, marks: null, nowBell: 310 + RS.FIRST_LOOK_BELLS });
  assert.equal(first.mode, 'firstOnDevice');
  assert.equal(first.horizonBell, 310);
  assert.ok(first.items.every(i => i.bell >= 310));
  const saved = RS.confirm(st, { seasonId: '7', wallet: 'W', confirm: first.confirm, at: 1 });
  assert.equal(saved.moved, true);
  assert.equal(saved.marks.horizonBell, 310);
  const later = sum({ records: [], read: { after: '108', complete: true }, marks: RS.loadMarks(st, '7', 'W') });
  assert.equal(later.mode, 'sinceConfirmed');
  assert.match(RW.headText(later), /この端末では第310ターンより前の出来事は見ていません/);
  assert.deepEqual(later.confirm, { ok: false, why: 'nothing' });
});

test('C2: a first look that could not reach its window\'s first turn says from which turn it read', () => {
  setLang('ja');
  const s = sum({ records: R.slice(5), read: { after: '105', complete: true }, marks: null, nowBell: 400 });
  assert.equal(s.windowFrom, 330);
  assert.equal(s.horizonBell, 330, 'the horizon is where the reading began, not the window\'s first turn');
  assert.match(RW.headText(s), /読めたのは第330ターンからです/);
});

// ---------------------------------------------------------------- C4: the holder and the sender are kept apart
test('C4: a caravan taken from the viewer arrives for the taker, not for its sender; the taker\'s arrival is the taker\'s', () => {
  const s = sum({ records: R, read: { after: '100', complete: true }, marks: { confirmedSeq: '100', confirmedBell: 299, caravans: {} } });
  const kinds = s.items.map(i => [i.kind, i.seq, i.tone]);
  assert.deepEqual(kinds.filter(k => k[0] === 'CARAVAN_SETTLED'), [['CARAVAN_SETTLED', '105', 'result']], 'only caravan 4 arrived for the viewer');
  const raid = s.items.find(i => i.kind === 'CARAVAN_RAIDED');
  assert.deepEqual([raid.tone, raid.facts.sender, raid.facts.holder], ['loss', 'me', 'me']);
  // the same records seen by the raider: a gain, then its arrival
  const raider = { ...me, tag: RAIDER };
  const t = RS.summarize({ records: R, read: { after: '100', complete: true }, marks: { confirmedSeq: '100', confirmedBell: 299, caravans: {} }, season: '7', wallet: 'X', nowBell: 400, me: raider, last: null });
  const arr = t.items.find(i => i.kind === 'CARAVAN_SETTLED');
  assert.deepEqual([arr.seq, arr.tone, arr.facts.sender, arr.facts.holder], ['106', 'result', 'other', 'me']);
});

test('C4: between two looks the book is carried on, so a later arrival of a taken caravan is not the sender\'s', () => {
  const s = sum({ records: R.slice(0, 4), read: { after: '100', complete: true }, marks: { confirmedSeq: '100', confirmedBell: 299, caravans: {} } });
  const { items } = RS.itemsSince(R.slice(4), me, s.book);
  assert.deepEqual(items.map(i => [i.kind, i.seq]), [['CARAVAN_SETTLED', '105'], ['SIEGE_DECLARED', '108']]);
});

test('C4: the book is kept with the mark, so the next look knows a caravan taken before it', () => {
  const st = storage();
  const s = sum({ records: R.slice(0, 4), read: { after: '100', complete: true }, marks: { confirmedSeq: '100', confirmedBell: 299, caravans: {} } });
  RS.confirm(st, { seasonId: '7', wallet: 'W', confirm: s.confirm, at: 1 });
  const marks = RS.loadMarks(st, '7', 'W');
  assert.equal(marks.caravans[`${ME}:3`], String(RAIDER));
  const next = sum({ records: R.slice(4), read: { after: '104', complete: true }, marks });
  assert.ok(!next.items.some(i => i.kind === 'CARAVAN_SETTLED' && i.seq === '106'));
});

test('C4: with neither the send nor the take read, the holder is unknown and the item says so (never the sender\'s arrival)', () => {
  setLang('ja');
  const s = sum({ records: [R[5]], read: { after: '105', complete: true }, marks: { confirmedSeq: '105', confirmedBell: 320, caravans: {} } });
  const i = s.items.find(x => x.kind === 'CARAVAN_SETTLED');
  assert.deepEqual([i.tone, i.facts.sender, i.facts.holder], ['uncertain', 'me', 'unknown']);
  assert.match(RW.itemText(i), /途中で奪われていたなら、受け取ったのは奪った側です/);
  assert.doesNotMatch(RW.itemText(i), /^隊商が着きました/);
});

test('other people\'s caravans and other nations\' votes are not the viewer\'s news', () => {
  const s = sum({ records: R, read: { after: '100', complete: true }, marks: { confirmedSeq: '100', confirmedBell: 299, caravans: {} } });
  assert.ok(!s.items.some(i => i.seq === '107'));
});

// ---------------------------------------------------------------- C5: duplicates, order, overlapping pages
test('C5: records read twice or out of order give the same summary as a clean read', () => {
  const clean = sum({ records: R, read: { after: '100', complete: true }, marks: { confirmedSeq: '100', confirmedBell: 299, caravans: {} } });
  const messy = sum({ records: [...R.slice(4), ...R, R[2]].reverse(), read: { after: '100', complete: true }, marks: { confirmedSeq: '100', confirmedBell: 299, caravans: {} } });
  assert.deepEqual(messy.items, clean.items);
  assert.deepEqual([messy.read.dups, messy.read.reordered], [5, true]);
  assert.equal(messy.confirm.toSeq, '108');
  const n = RS.normalizeRecords([{ seq: 'x', record: {} }, { seq: '2', record: { name: 'A' } }, { seq: '1', record: { name: 'B' } }]);
  assert.deepEqual([n.records.map(x => x.seq), n.bad], [['1', '2'], 1]);
});

test('C5: overlapping pages from the herald are read once', async () => {
  let n = 0;
  const events = async after => { n++; const rows = H.filter(e => BigInt(e.seq) > BigInt(after) - 2n).slice(0, 4); return { ok: true, events: [...rows].reverse(), next: null, full: rows.length === 4 }; };
  const got = await RR.createAwayReader({ events }).start({ scope: 's', from: '100' });
  assert.deepEqual(got.records.map(x => x.seq), ['101', '102', '103', '104', '105', '106', '107', '108']);
  assert.ok(n < 10);
});

// ---------------------------------------------------------------- C6: wallet, season, device, reload
test('C6: another wallet and another season never read this one\'s mark or book', () => {
  const st = storage();
  RS.confirm(st, { seasonId: '7', wallet: 'W', confirm: { ok: true, toSeq: '104', toBell: 310, horizonBell: null, caravans: { [`${ME}:3`]: String(RAIDER) } }, at: 1 });
  assert.equal(RS.loadMarks(st, '7', 'V'), null);
  assert.equal(RS.loadMarks(st, '8', 'W'), null);
  const v = RS.summarize({ records: R, read: { after: '0' }, marks: RS.loadMarks(st, '7', 'V'), last: RS.loadLast(st), season: '7', wallet: 'V', nowBell: 400, me });
  assert.equal(v.mode, 'otherWallet');
  const w8 = RS.summarize({ records: R, read: { after: '0' }, marks: RS.loadMarks(st, '8', 'W'), last: RS.loadLast(st), season: '8', wallet: 'W', nowBell: 400, me });
  assert.equal(w8.mode, 'newSeason');
  assert.deepEqual([...w8.book.keys()].filter(k => k === `${ME}:3`).length, 0, 'the book starts empty in another season');
  assert.notEqual(RR.awayScope({ herald: 'g', seasonId: '7', wallet: 'W' }), RR.awayScope({ herald: 'g', seasonId: '7', wallet: 'V' }));
});

test('C6: a reading started for one scope and overtaken by another is stale and gives nothing', async () => {
  const r = RR.createAwayReader({ events: herald(H, { size: 8, delay: 20 }).events });
  const a = r.start({ scope: 'season7|W', from: '100' });
  const b = r.start({ scope: 'season7|V', from: '104' });
  const [ra, rb] = await Promise.all([a, b]);
  assert.deepEqual([ra.stale, ra.records.length], [true, 0]);
  assert.deepEqual([rb.stale, rb.scope, rb.records.map(x => x.seq)], [false, 'season7|V', ['105', '106', '107', '108']]);
  r.reset();
  assert.equal((await r.more()).stale, true);
});

test('C6: a mark beyond the season\'s head (a reset world, an old device) is not used, and "seen" replaces it', () => {
  setLang('ja');
  const st = storage();
  RS.confirm(st, { seasonId: '7', wallet: 'W', confirm: { ok: true, toSeq: '9000', toBell: 900, horizonBell: null, caravans: {} }, at: 1 });
  const s = sum({ records: R, read: { after: '100', complete: true }, marks: RS.loadMarks(st, '7', 'W'), headSeq: '108' });
  assert.equal(s.mode, 'markAhead');
  assert.match(RW.headText(s), /いまのシーズンの記録より先を指していたため使いません/);
  const saved = RS.confirm(st, { seasonId: '7', wallet: 'W', confirm: s.confirm, at: 2 });
  assert.equal(saved.marks.confirmedSeq, '108');
});

test('another device (no mark here) is a first look, and says it cannot tell a first visit from another device', () => {
  setLang('ja');
  const s = sum({ records: R, read: { after: '100', complete: true }, marks: RS.loadMarks(storage(), '7', 'W') });
  assert.equal(s.mode, 'firstOnDevice');
  assert.match(RW.headText(s), /初めてか、別の端末か、ブラウザの記録が消えた場合/);
});

test('a reload without "seen" shows the same summary; "seen" twice is harmless; the mark never moves back', () => {
  const st = storage();
  const marks = { confirmedSeq: '100', confirmedBell: 299, caravans: {} };
  RS.confirm(st, { seasonId: '7', wallet: 'W', confirm: { ok: true, ...marks, toSeq: '100', toBell: 299 }, at: 0 });
  const one = sum({ records: R, read: { after: '100', complete: true }, marks: RS.loadMarks(st, '7', 'W') });
  const two = sum({ records: R, read: { after: '100', complete: true }, marks: RS.loadMarks(st, '7', 'W') });
  assert.deepEqual(two.items, one.items, 'reading again without "seen" starts from the same mark');
  assert.equal(RS.confirm(st, { seasonId: '7', wallet: 'W', confirm: one.confirm, at: 1 }).moved, true);
  assert.equal(RS.confirm(st, { seasonId: '7', wallet: 'W', confirm: one.confirm, at: 2 }).moved, false);
  const older = sum({ records: R.slice(0, 2), read: { after: '100', complete: false }, marks: { confirmedSeq: '100', confirmedBell: 299, caravans: {} } });
  const back = RS.confirm(st, { seasonId: '7', wallet: 'W', confirm: older.confirm, at: 3 });
  assert.deepEqual([back.moved, back.marks.confirmedSeq], [false, '108'], 'another tab\'s older summary does not pull the mark back');
});

test('storage that refuses or silently drops a write: "seen" reports it and the mark stays', () => {
  setLang('ja');
  const c = { ok: true, toSeq: '108', toBell: 340, horizonBell: null, caravans: {} };
  const throws = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
  assert.equal(RS.confirm(throws, { seasonId: '7', wallet: 'W', confirm: c, at: 1 }), null);
  assert.equal(RS.loadMarks(throws, '7', 'W'), null);
  const drops = { getItem: () => null, setItem: () => {} };
  assert.equal(RS.confirm(drops, { seasonId: '7', wallet: 'W', confirm: c, at: 1 }), null, 'a write that does not read back is not a saved mark');
  assert.match(RW.confirmedText(null), /保存できませんでした。次に開いたときも同じ範囲が出ます/);
});

test('a version 1 mark (before the horizon and the book) still reads', () => {
  const st = storage();
  st.setItem(RS.storeKey('7', 'W'), JSON.stringify({ v: 1, seasonId: '7', wallet: 'W', confirmedSeq: '100', confirmedBell: 299, confirmedAt: 1 }));
  const m = RS.loadMarks(st, '7', 'W');
  assert.deepEqual([m.confirmedSeq, m.horizonBell, m.caravans], ['100', null, {}]);
});

// ---------------------------------------------------------------- the page's wiring
test('the page reads the away summary from its own reader, per scope, and "seen" passes the summary\'s confirm', () => {
  const app = readFileSync(new URL('../../permutation-server/web/frontier/app.mjs', import.meta.url), 'utf8');
  const block = app.slice(app.indexOf('const awayReader'), app.indexOf('onLangChange(() => { reword();'));
  assert.doesNotMatch(block, /FS\.chronicle/, 'not the chronicle\'s window');
  assert.match(block, /awayReader\.start\(\{ scope: sc, from \}\)/);
  assert.match(block, /x\.scope === sc/, 'another scope\'s notices go');
  const seen = app.slice(app.indexOf("'away-seen': d =>"), app.indexOf("'feed-filter'"));
  assert.match(seen, /confirm: x\.away\.summary\.confirm/);
  assert.match(seen, /x\.scope !== awayScopeNow\(\)/);
});
