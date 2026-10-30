// Workstream 07, claim 3 of the brief: when is the "what happened" empty, and
// which S1 events does it miss? Then the return summary of src/return-summary.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeRecord, KINDS as M1_KINDS } from '../../../permutation-server/web/frontier/flog.mjs';
import { LOGS } from '../../../permutation-server/web/sdk/frontier/abi-v2-logs.mjs';
import { toBase64 } from '../../../permutation-server/web/sdk/bytes.mjs';
import { snapshot, diffFeed } from '../../../permutation-server/web/frontier/hud/feed.mjs';
import { CHRONICLE_WINDOW, chronicleStart } from '../../../permutation-server/web/frontier/controller.mjs';
import { setLang } from '../../../permutation-server/web/lang.mjs';
import * as RS from '../src/return-summary.mjs';

const CONTROLLER = readFileSync(new URL('../../../permutation-server/web/frontier/controller.mjs', import.meta.url), 'utf8');
const SERVER_RS = readFileSync(new URL('../../../frontier-node/crates/herald/src/server.rs', import.meta.url), 'utf8');

/** A PS2 body of an S1 kind, from the v2 log table: ver ‖ kind ‖ bell u32 ‖ key ‖ payload ‖ no links. */
function body(name, bell, fields) {
  const spec = LOGS.kinds.find(k => k.name === name);
  const parts = [...spec.key, ...spec.payload];
  const len = 6 + parts.reduce((a, f) => a + f.len, 0) + 1;
  const b = new Uint8Array(len), v = new DataView(b.buffer);
  b[0] = 1; b[1] = spec.kind; v.setUint32(2, bell, true);
  let o = 6;
  for (const f of parts) {
    const x = fields[f.name];
    if (x instanceof Uint8Array) b.set(x.subarray(0, f.len), o);
    else if (x !== undefined) {
      if (f.len === 8) v.setBigUint64(o, BigInt(x), true);
      else if (f.len === 4) v.setInt32(o, Number(x), true);
      else if (f.len === 2) v.setUint16(o, Number(x), true);
      else if (f.len === 1) b[o] = Number(x);
    }
    o += f.len;
  }
  return toBase64(b);
}
const cargo = arr => { const b = new Uint8Array(32), v = new DataView(b.buffer); arr.forEach((n, i) => v.setUint32(i * 4, n, true)); return b; };
const ME = 0x1234n, OTHER = 0x9999n;
const rec = (seq, name, bell, fields) => ({ seq: String(seq), record: decodeRecord(body(name, bell, fields)) });
const me = { tag: ME, faction: 2, holdings: [{ p: 1, q: 0, site: 3 }], hostOf: () => null };
const EVENTS = [
  rec(101, 'CARAVAN_SENT', 300, { owner_tag: ME, seq: 4, faction: 2 }),
  rec(102, 'RAID_OPENED', 304, { owner_tag: ME, seq: 4, p: 2, q: 0, bell: 304, raider_tag: OTHER }),
  rec(103, 'CARAVAN_RAIDED', 306, { owner_tag: ME, seq: 4, p: 2, q: 0, bell: 304, choice: 0, by: 1, raider_tag: OTHER, taken: cargo([0, 300, 0, 0, 0, 120, 0, 0]) }),
  rec(104, 'VAULT_SEIZED', 310, { p: 2, q: 0, tile: 7, captor_tag: OTHER, prev_tag: ME }),
  rec(105, 'NATION_DECIDED', 320, { faction: 2, id: 1, passed: 1, kind: 1, target_faction: 4, value: 0, yes: 3, no: 1 }),
  rec(106, 'NATION_DECIDED', 320, { faction: 5, id: 1, passed: 1, kind: 1, target_faction: 2, value: 0, yes: 3, no: 0 }),
  rec(107, 'SIEGE_DECLARED', 330, { p: 1, q: 0, site: 3, attacker: 4, owner_faction: 2, owner_tag: ME, required: 40 }),
  rec(108, 'CARAVAN_SETTLED', 331, { owner_tag: OTHER, seq: 1, outcome: 0, cargo: cargo([5, 0, 0, 0, 0, 0, 0, 0]) }),
];

test('the S1 records are decoded by the page itself (flog.mjs with the v2 log table)', () => {
  assert.deepEqual(EVENTS.map(e => e.record.name), ['CARAVAN_SENT', 'RAID_OPENED', 'CARAVAN_RAIDED', 'VAULT_SEIZED', 'NATION_DECIDED', 'NATION_DECIDED', 'SIEGE_DECLARED', 'CARAVAN_SETTLED']);
  assert.equal(EVENTS[2].record.owner_tag, ME);
  assert.deepEqual(RS.cargoOf(EVENTS[2].record.taken), [0, 300, 0, 0, 0, 120, 0, 0]);
});

test('REPRO: the page\'s first look is never news, whatever happened before it opened', () => {
  const FS = { marches: [], holdings: [{ p: 1, q: 0, site: 3, state: 2, tier: 1, queue: [] }], chronicle: EVENTS, nowBell: 340, chain: { now: () => 0 }, citizen: { faction: 2 } };
  assert.deepEqual(diffFeed(null, snapshot(FS)), [], 'hud/feed.mjs: "A first snapshot (prev null) is not news"');
});

test('REPRO: even between two looks, no S1 loss becomes a notification (a caravan raided, a storehouse seized, a siege on the village)', () => {
  const holdings = [{ p: 1, q: 0, site: 3, state: 2, tier: 1, queue: [] }];
  const before = snapshot({ marches: [], holdings, chronicle: [], nowBell: 300, chain: { now: () => 0 }, citizen: { faction: 2 } });
  const after = snapshot({ marches: [], holdings, chronicle: EVENTS, nowBell: 340, chain: { now: () => 0 }, citizen: { faction: 2 } }, 0, before);
  assert.deepEqual(diffFeed(before, after), []);
});

test('REPRO: the chronicle starts 500 events behind the head and keeps 400; the herald itself keeps them all', () => {
  assert.equal(CHRONICLE_WINDOW, 500);
  assert.equal(chronicleStart(10_000), 9_500);
  assert.match(CONTROLLER, /FS\.chronicle = \[\.\.\.\(FS\.chronicle \?\? \[\]\), \.\.\.records\]\.slice\(-400\)/);
  assert.match(SERVER_RS, /\.route\("\/h\/events", get\(events\)\)/);
  assert.match(SERVER_RS, /events_after\(after, EVENTS_PAGE\)/, 'a page from any `after`, from the index');
});

test('the summary lists the viewer\'s own losses first, from the records alone, with the amounts they carry', () => {
  setLang('ja');
  const s = RS.summarize({ records: EVENTS, read: { after: '100', complete: true }, marks: { v: 1, seasonId: '7', wallet: 'W', confirmedSeq: '100', confirmedBell: 299 }, last: { seasonId: '7', wallet: 'W' }, season: '7', wallet: 'W', nowBell: 340, me });
  assert.equal(s.mode, 'sinceConfirmed');
  assert.equal(s.gap, null);
  assert.deepEqual(s.items.map(i => i.kind), ['SIEGE_DECLARED', 'VAULT_SEIZED', 'CARAVAN_RAIDED', 'NATION_DECIDED', 'RAID_OPENED']);
  assert.ok(!s.items.some(i => i.kind === 'CARAVAN_SETTLED'), 'another\'s caravan is not the viewer\'s news');
  assert.equal(s.items.filter(i => i.kind === 'NATION_DECIDED').length, 1, 'another nation\'s vote is not');
  const raid = s.items.find(i => i.kind === 'CARAVAN_RAIDED');
  assert.match(RS.itemText(raid), /積荷ごと奪われました：木材 300・金 120（相手が決めず、期限で決着）/);
  assert.match(RS.headText(s), /あなたが確認したのは第299ターンまでです。第300〜331ターンの記録 8 件を読み込みました/);
});

test('the summary starts after what the player confirmed, not after what the page fetched', () => {
  const store = new Map(), storage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  assert.equal(RS.loadMarks(storage, '7', 'W'), null);
  // fetched up to 108 and shown, but not confirmed: the next look starts at the same place
  const first = RS.summarize({ records: EVENTS, read: { after: '100', complete: true }, marks: RS.loadMarks(storage, '7', 'W'), last: RS.loadLast(storage), season: '7', wallet: 'W', nowBell: 340, me });
  assert.equal(first.mode, 'firstOnDevice');
  assert.equal(RS.summarize({ records: EVENTS, read: { after: '100' }, marks: RS.loadMarks(storage, '7', 'W'), last: null, season: '7', wallet: 'W', nowBell: 340, me }).items.length, first.items.length);
  RS.confirm(storage, { seasonId: '7', wallet: 'W', toSeq: '105', toBell: 320, at: 1 });
  const next = RS.summarize({ records: EVENTS, read: { after: '100' }, marks: RS.loadMarks(storage, '7', 'W'), last: RS.loadLast(storage), season: '7', wallet: 'W', nowBell: 340, me });
  assert.deepEqual(next.items.map(i => i.kind), ['SIEGE_DECLARED'], 'only what came after the confirmed 105');
});

test('another wallet, a new season and storage that refuses are each said, never mixed', () => {
  const store = new Map(), storage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  RS.confirm(storage, { seasonId: '7', wallet: 'W', toSeq: '105', toBell: 320, at: 1 });
  const other = RS.summarize({ records: EVENTS, read: {}, marks: RS.loadMarks(storage, '7', 'V'), last: RS.loadLast(storage), season: '7', wallet: 'V', nowBell: 340, me });
  assert.equal(other.mode, 'otherWallet');
  const season = RS.summarize({ records: EVENTS, read: {}, marks: RS.loadMarks(storage, '8', 'W'), last: RS.loadLast(storage), season: '8', wallet: 'W', nowBell: 340, me });
  assert.equal(season.mode, 'newSeason');
  assert.match(RS.headText(season), /前のシーズンの出来事は含みません/);
  const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
  assert.equal(RS.loadMarks(broken, '7', 'W'), null);
  assert.equal(RS.confirm(broken, { seasonId: '7', wallet: 'W', toSeq: '1', toBell: 1, at: 1 }), null, 'a refused write is reported, not assumed');
});

test('a gap in the history is named and not filled in; a first look on a device covers a stated window only', () => {
  const s = RS.summarize({ records: EVENTS.slice(4), read: { after: '104', complete: false }, marks: { v: 1, seasonId: '7', wallet: 'W', confirmedSeq: '100', confirmedBell: 299 }, last: null, season: '7', wallet: 'W', nowBell: 340, me });
  assert.deepEqual(s.gap, { afterSeq: '100', beforeSeq: '105' });
  assert.equal(s.incomplete, true);
  assert.ok(!s.items.some(i => i.kind === 'CARAVAN_RAIDED'), 'the raid is in the gap: not told, not guessed');
  assert.match(RS.headText(s), /欠けた分の出来事は推測しません/);
  const first = RS.summarize({ records: EVENTS, read: {}, marks: null, last: null, season: '7', wallet: 'W', nowBell: 300 + RS.FIRST_LOOK_BELLS + 5, me });
  assert.ok(first.items.every(i => i.bell >= 305), 'only the stated window');
  assert.match(RS.headText(first), /初めてか、別の端末か、ブラウザの記録が消えた場合/);
});

test('English words for the prototype', () => {
  setLang('en');
  try {
    const s = RS.summarize({ records: EVENTS, read: {}, marks: { v: 1, seasonId: '7', wallet: 'W', confirmedSeq: '100', confirmedBell: 299 }, last: null, season: '7', wallet: 'W', nowBell: 340, me });
    assert.match(RS.itemText(s.items[0], 'en'), /declared a siege of your village/);
    assert.doesNotMatch(RS.headText(s, 'en'), /[぀-ヿ]/);
  } finally { setLang('ja'); }
});

test('a decided vote is worded by its kind as nation.rs numbers them (1 stance, 2 expulsion, 3 readmission)', () => {
  setLang('ja');
  const of = (kind, extra = {}) => RS.itemOf({ seq: '9', record: decodeRecord(body('NATION_DECIDED', 9, { faction: 2, id: 1, passed: 1, kind, target_faction: 4, value: 1, yes: 3, no: 1, ...extra })) }, me);
  assert.match(RS.itemText(of(1)), /への方針を「通行」に/);
  assert.match(RS.itemText(of(2)), /村の追放/);
  assert.match(RS.itemText(of(2, { target_tag: ME })), /あなたの村の追放/);
  assert.match(RS.itemText(of(3)), /村を国に戻すこと/);
});

test('a march\'s result is read as the log numbers it (1 Stays … 5 Destroyed … 8 BadSeal), a loss only when it is one', () => {
  setLang('ja');
  const host = { p: 1, q: 0, site: 3 };
  const mine = { ...me, hostOf: () => host };
  // (an M1 kind: its fields from flog.mjs's own table, the bytes decoded by the page)
  const m1 = (kind, bell, f) => { const spec = M1_KINDS[kind], parts = [...spec.key, ...spec.payload]; const b = new Uint8Array(6 + parts.reduce((a, [, n]) => a + n, 0) + 1), v = new DataView(b.buffer);
    b[0] = 1; b[1] = kind; v.setUint32(2, bell, true); let o = 6;
    for (const [name, n] of parts) { const x = f[name]; if (x !== undefined) { if (n === 8) v.setBigUint64(o, BigInt(x), true); else if (n === 4) v.setUint32(o, Number(x), true); else if (n === 1) b[o] = Number(x); } o += n; }
    return b; };
  const of = outcome => RS.itemOf({ seq: '9', record: decodeRecord(m1(34, 9, { host_id: 77n, outcome, troops: 120_000 })) }, mine);
  const stays = of(1), destroyed = of(5), routed = of(7), bad = of(8);
  assert.deepEqual([stays.facts.outcome, stays.tone], ['Stays', 'result']);
  assert.deepEqual([destroyed.facts.outcome, destroyed.tone], ['Destroyed', 'loss']);
  assert.deepEqual([routed.facts.outcome, bad.facts.outcome], ['Routed', 'BadSeal']);
  assert.match(RS.itemText(stays), /着いた場所に残りました（残る兵 120）/);
});

test('a taken caravan is the raider\'s from then on (its records keep the sender\'s tag): its later arrival is not the sender\'s, a burned one delivers nothing', () => {
  setLang('ja');
  const R = (seq, name, bell, f) => rec(seq, name, bell, f);
  const taken = [R(201, 'CARAVAN_RAIDED', 400, { owner_tag: ME, seq: 7, p: 1, q: 0, bell: 400, choice: 0, by: 0, raider_tag: OTHER, taken: cargo([0, 50, 0, 0, 0, 0, 0, 0]) }),
    R(202, 'CARAVAN_SETTLED', 405, { owner_tag: ME, seq: 7, outcome: 0, cargo: cargo([0, 50, 0, 0, 0, 0, 0, 0]) })];
  const mine = RS.summarize({ records: taken, read: { after: '200' }, marks: { v: 1, seasonId: '7', wallet: 'W', confirmedSeq: '200', confirmedBell: 399 }, last: null, season: '7', wallet: 'W', nowBell: 410, me });
  assert.deepEqual(mine.items.map(i => [i.kind, i.tone]), [['CARAVAN_RAIDED', 'loss']], 'the sender lost it; its arrival at the raider\'s is not the sender\'s');
  const theirs = RS.summarize({ records: taken, read: { after: '200' }, marks: { v: 1, seasonId: '7', wallet: 'W', confirmedSeq: '200', confirmedBell: 399 }, last: null, season: '7', wallet: 'W', nowBell: 410, me: { ...me, tag: OTHER } });
  assert.deepEqual(theirs.items.map(i => [i.kind, i.tone]).sort(), [['CARAVAN_RAIDED', 'gain'], ['CARAVAN_SETTLED', 'result']]);
  // taken back by the sender: a gain for the sender, a loss for the one who held it
  const back = [...taken.slice(0, 1), R(203, 'CARAVAN_RAIDED', 402, { owner_tag: ME, seq: 7, p: 1, q: 0, bell: 402, choice: 0, by: 0, raider_tag: ME, taken: cargo([0, 50, 0, 0, 0, 0, 0, 0]) })];
  const s2 = RS.summarize({ records: back, read: { after: '200' }, marks: { v: 1, seasonId: '7', wallet: 'W', confirmedSeq: '201', confirmedBell: 400 }, last: null, season: '7', wallet: 'W', nowBell: 410, me });
  assert.deepEqual(s2.items.map(i => i.tone), ['gain']);
  const s3 = RS.summarize({ records: back, read: { after: '200' }, marks: { v: 1, seasonId: '7', wallet: 'W', confirmedSeq: '201', confirmedBell: 400 }, last: null, season: '7', wallet: 'W', nowBell: 410, me: { ...me, tag: OTHER } });
  assert.deepEqual(s3.items.map(i => i.tone), ['loss']);
  const burned = [R(211, 'CARAVAN_RAIDED', 400, { owner_tag: ME, seq: 8, p: 1, q: 0, bell: 400, choice: 1, by: 0, raider_tag: OTHER }), R(212, 'CARAVAN_SETTLED', 405, { owner_tag: ME, seq: 8, outcome: 0 })];
  const s4 = RS.summarize({ records: burned, read: { after: '210' }, marks: { v: 1, seasonId: '7', wallet: 'W', confirmedSeq: '210', confirmedBell: 399 }, last: null, season: '7', wallet: 'W', nowBell: 410, me });
  assert.deepEqual(s4.items.map(i => i.kind), ['CARAVAN_RAIDED']);
});

test('a siege\'s required turns are said as turns of holding, not a fixed fall time; a proposed readmission is not an expulsion', () => {
  setLang('ja');
  const siege = RS.itemOf(rec(1, 'SIEGE_DECLARED', 9, { p: 1, q: 0, site: 3, attacker: 4, owner_faction: 2, owner_tag: ME, required: 40 }), me);
  assert.match(RS.itemText(siege), /包囲側がマスを保つターンが 40 要ります（夜番の時間と、守り手がいるターンは数えません）/);
  const re = RS.itemOf(rec(2, 'NATION_PROPOSED', 9, { faction: 2, id: 1, kind: 3, target_tag: ME, close_bell: 200 }), me);
  assert.match(RS.itemText(re), /あなたの村を国に戻すこと/);
});
