// ⑦ the way back: reading the away records, telling a failed or unfinished reading, saving the seen mark, resuming
// (Lane C, 2026-11-17). WRITTEN, NOT RUN. NOT claimed independent: returnwords.mjs loads fi18n.mjs and lang.mjs (the
// subjects of refused tests); whether and how this may run is the coordinator's decision, through the key-free guard
// only. Storage is an in-memory fake (a Map) with failures per key; the herald is a fake `events` function. No network,
// file, key, page or world.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as RS from '../../permutation-server/web/frontier/hud/returnsum.mjs';
import * as RW from '../../permutation-server/web/frontier/hud/returnwords.mjs';
import * as RR from '../../permutation-server/web/frontier/hud/awayread.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';

/** A device store; `fail`: keys whose setItem throws; `drop`: keys whose setItem is ignored. */
const store = ({ fail = [], drop = [] } = {}) => {
  const m = new Map();
  return { m, getItem: k => m.get(k) ?? null, setItem: (k, v) => { if (fail.includes(k)) throw new Error('quota'); if (!drop.includes(k)) m.set(k, v); } };
};
const OK = (toSeq, toBell = 300) => ({ ok: true, toSeq, toBell, horizonBell: null, caravans: {} });
const head = over => ({ mode: 'sinceConfirmed', since: { bell: 200 }, horizonBell: null, windowFrom: null, gap: null, failed: false, incomplete: false, bad: 0,
  read: { n: 0, fromBell: null, toBell: null }, confirm: { ok: false, why: 'nothing' }, ...over });

test('reading: nothing read is "no new records" only when the reading was whole', () => {
  setLang('ja');
  assert.match(RW.headText(head({})), /新しい記録はありません。/);
  assert.equal(RW.confirmText(head({})), '新しく確認する記録はありません');
  for (const over of [{ failed: true, incomplete: true }, { incomplete: true }, { gap: { afterSeq: '1', beforeSeq: '5' }, confirm: { ok: false, why: 'gap' } }]) {
    const t = RW.headText(head(over));
    assert.match(t, /新しい記録があるかどうかは、まだわかりません。/, JSON.stringify(over));
    assert.doesNotMatch(t, /新しい記録はありません|読めた分だけを出しています/, JSON.stringify(over));
  }
  assert.match(RW.headText(head({ failed: true, incomplete: true })), /記録の読み込みに失敗しました。/);
  assert.equal(RW.confirmText(head({ failed: true, incomplete: true })), 'まだ記録を読めていないため、確認の位置は進めません');
  assert.match(RW.confirmText(head({ gap: { afterSeq: '1', beforeSeq: '5' }, confirm: { ok: false, why: 'gap' } })), /欠けた記録を読めるまで/);
  // unchanged: something read and then a failure
  const part = head({ failed: true, incomplete: true, read: { n: 2, fromBell: 301, toBell: 305 } });
  assert.match(RW.headText(part), /第301〜305ターンの記録 2 件を読みました。.*記録の読み込みが途中で失敗しました。読めた分だけを出しています。/);
});

test('reading: undecodable records are counted and told, never guessed', () => {
  setLang('ja');
  // (a reading with only undecodable records in range, whole: not "no new records", and not "nothing new" to confirm)
  const badOnly = RW.headText(head({ bad: 2 }));
  assert.match(badOnly, /中身を読めた新しい記録はありません。.*読めない記録が 2 件ありました。/);
  assert.doesNotMatch(badOnly.replace('中身を読めた新しい記録はありません。', ''), /新しい記録はありません/, 'never the bare "no new records"');
  assert.equal(RW.confirmText(head({ bad: 2 })), '読めない記録のほかに、新しく確認する記録はありません');
  assert.equal(RW.confirmText(head({ bad: 2, failed: true, incomplete: true })), 'まだ記録を読めていないため、確認の位置は進めません');
  assert.match(RW.headText(head({ bad: 3 })), /読めない記録が 3 件ありました。その中身は推測しません。/);
  assert.doesNotMatch(RW.headText(head({ bad: 0 })), /読めない記録/);
  const s = RS.summarize({ records: [], read: { after: '100', complete: true, failed: false, bad: 2 }, marks: { confirmedSeq: '100', confirmedBell: 299, caravans: {} }, last: null, season: '7', wallet: 'W', nowBell: 400, me: {} });
  assert.equal(s.bad, 2);
  assert.equal(RS.summarize({ records: [], read: { after: '100', complete: true, bad: -1 }, marks: null, last: null, season: '7', wallet: 'W', nowBell: 400, me: {} }).bad, 0);
});

test('saving: the mark decides; a failure of the device\'s "last used" alone is not a failure', () => {
  setLang('ja');
  const key = RS.storeKey('7', 'W');
  const aux = store({ fail: ['ws07-return:last'] });
  const r = RS.confirm(aux, { seasonId: '7', wallet: 'W', confirm: OK('108'), at: 1 });
  assert.deepEqual([r.moved, r.lastSaved, r.marks.confirmedSeq], [true, false, '108'], 'the mark moved; only the auxiliary write failed');
  assert.equal(RS.loadMarks(aux, '7', 'W').confirmedSeq, '108');
  assert.match(RW.confirmedText(r), /^第300ターンまでを確認済みにしました（この端末で最後に使ったウォレットの記録だけは保存できませんでした）$/);
  // the mark itself not saved: null, nothing written (as before)
  const main = store({ fail: [key] });
  assert.equal(RS.confirm(main, { seasonId: '7', wallet: 'W', confirm: OK('108'), at: 1 }), null);
  assert.equal(RS.loadMarks(main, '7', 'W'), null);
  assert.equal(main.m.has('ws07-return:last'), false, 'the auxiliary is not written when the mark was not');
  assert.equal(RW.confirmedText(null), '確認の位置を保存できませんでした。次に開いたときも同じ範囲が出ます');
  // a store that ignores writes: the read-back says not saved
  assert.equal(RS.confirm(store({ drop: [key] }), { seasonId: '7', wallet: 'W', confirm: OK('108'), at: 1 }), null);
  // a write that threw but reached the store: the read-back decides
  const odd = store(); const set = odd.setItem; odd.setItem = (k, v) => { set(k, v); if (k === key) throw new Error('reported late'); };
  assert.equal(RS.confirm(odd, { seasonId: '7', wallet: 'W', confirm: OK('108'), at: 1 }).moved, true);
  // unchanged: both writes fine
  const fine = store();
  assert.deepEqual(Object.keys(RS.confirm(fine, { seasonId: '7', wallet: 'W', confirm: OK('108'), at: 1 })).sort(), ['marks', 'moved']);
});

test('saving: a double press, another tab ahead, a mark beyond the head', () => {
  const st = store();
  assert.equal(RS.confirm(st, { seasonId: '7', wallet: 'W', confirm: OK('108'), at: 1 }).moved, true);
  assert.equal(RS.confirm(st, { seasonId: '7', wallet: 'W', confirm: OK('108'), at: 2 }).moved, false, 'twice is harmless');
  // another tab writes a further mark between this write and its read-back
  const race = store(); const key = RS.storeKey('7', 'W'); const set = race.setItem;
  race.setItem = (k, v) => { set(k, v); if (k === key) set(k, JSON.stringify({ ...JSON.parse(v), confirmedSeq: '120', confirmedBell: 320 })); };
  const r = RS.confirm(race, { seasonId: '7', wallet: 'W', confirm: OK('108'), at: 1 });
  assert.deepEqual([r.moved, r.marks.confirmedSeq], [false, '120'], 'already confirmed further, not a failure');
  // replacing a mark beyond the head whose write fails: not "already confirmed"
  const ahead = store(); ahead.setItem(key, JSON.stringify({ v: 2, seasonId: '7', wallet: 'W', confirmedSeq: '9000', confirmedBell: 900, caravans: {} }));
  ahead.setItem = () => { throw new Error('quota'); };
  assert.equal(RS.confirm(ahead, { seasonId: '7', wallet: 'W', confirm: { ...OK('108'), reset: true }, at: 1 }), null);
});

test('worlds: a mark of another world is not used; a mark without a world reads as before', () => {
  const st = store();
  RS.confirm(st, { seasonId: '7', wallet: 'W', confirm: OK('108'), at: 1, world: 'local|P1|S7' });
  assert.equal(RS.loadMarks(st, '7', 'W', 'local|P1|S7').confirmedSeq, '108');
  assert.equal(RS.loadMarks(st, '7', 'W', 'devnet|P2|S7'), null, 'the same season number and wallet in another world');
  assert.equal(RS.loadMarks(st, '7', 'W').confirmedSeq, '108', 'no world asked: as before');
  assert.deepEqual(RS.loadLast(st), { seasonId: '7', wallet: 'W', world: 'local|P1|S7' });
  const legacy = store(); legacy.setItem(RS.storeKey('7', 'W'), JSON.stringify({ v: 2, seasonId: '7', wallet: 'W', confirmedSeq: '50', confirmedBell: 150, caravans: {} }));
  assert.equal(RS.loadMarks(legacy, '7', 'W', 'devnet|P2|S7').confirmedSeq, '50', 'a mark written before worlds were recorded');
  const s = RS.summarize({ records: [], read: { after: '0', complete: true }, marks: null, last: RS.loadLast(st), season: '7', wallet: 'W', nowBell: 400, me: {}, world: 'devnet|P2|S7' });
  assert.equal(s.mode, 'newSeason', 'another world on this device is told as another record');
  assert.equal(RS.summarize({ records: [], read: { after: '0', complete: true }, marks: null, last: RS.loadLast(st), season: '7', wallet: 'W', nowBell: 400, me: {}, world: 'local|P1|S7' }).mode, 'firstOnDevice');
});

test('resuming: a reading of an old scope that answers late is stale and carries nothing', async () => {
  let release;
  const slow = new Promise(r => { release = r; });
  // (an empty page answers as herald.mjs `events` does: `next` is the cursor it was asked from, a string — that client
  //  refuses a page whose `next` is not the newest seq, so a `next: null` page never reaches the reader)
  const events = async after => (after === '100' ? slow : { ok: true, events: [], next: after, full: false });
  const reader = RR.createAwayReader({ events });
  const first = reader.start({ scope: 'A', from: '100' });
  const second = reader.start({ scope: 'B', from: '0' });
  release({ ok: true, events: [], next: '100', full: false });
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual([a.stale, a.records.length, a.next], [true, 0, null]);
  assert.deepEqual([b.stale, b.complete, b.failed, b.next, reader.scope], [false, true, false, '0', 'B']);
  // the late answer of scope A moved nothing: reading on continues from B's own cursor
  const more = await reader.more();
  assert.deepEqual([more.stale, more.after, more.complete], [false, '0', true]);
});

test('English follows', () => {
  setLang('en');
  assert.match(RW.headText(head({ failed: true, incomplete: true, bad: 1 })), /Whether there are new records is not known yet\. .*Reading the records failed\. .*1 records could not be read/);
  assert.equal(RW.confirmText(head({ incomplete: true })), 'No records have been read yet, so the seen mark does not move');
  assert.match(RW.headText(head({ bad: 1 })), /No new records whose contents could be read\./);
  assert.equal(RW.confirmText(head({ bad: 1 })), 'Apart from the records that could not be read, nothing new to mark as seen');
  assert.match(RW.confirmedText({ moved: true, lastSaved: false, marks: { confirmedBell: 300 } }), /only this device's note of the wallet used last could not be saved/);
  setLang('ja');
});
