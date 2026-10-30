// Workstream 07: the display contract connected on the S1 page (hud/statussources.mjs). A caravan's arrival comes
// from the S1 data the page already reads — the caravans feed, CARAVAN_SENT and CARAVAN_SETTLED —; 04's cancel and
// 05's costs come from the sources they register, and with none registered the village card is as it was.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LOGS } from '../../permutation-server/web/sdk/frontier/abi-v2-logs.mjs';
import { toBase64 } from '../../permutation-server/web/sdk/bytes.mjs';
import { decodeRecord } from '../../permutation-server/web/frontier/flog.mjs';
import * as SRC from '../../permutation-server/web/frontier/hud/statussources.mjs';
import * as RS from '../../permutation-server/web/frontier/hud/returnsum.mjs';
import * as RW from '../../permutation-server/web/frontier/hud/returnwords.mjs';
import * as SCR from '../../permutation-server/web/frontier/screens/s1.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';

// ---------------------------------------------------------------- an S1 village with a caravan on the road (as web-frontier-s1.test.mjs builds it)
const ALL = (1n << 61n) - 1n;
const store = units => ({ value: BigInt(units) * 1000n, rate: 0n, cap: 10n ** 12n, t0: 10n ** 12n, frac: 0n });
const holding = (p, q, site, tile) => ({ p, q, site, tile, gen: 1, state: 2, tier: 1, faction: 1, stores: Array.from({ length: 8 }, () => store(1000)), reserve: [300, 0, 0, 0, 0, 0, 0, 0], queue: [],
  ownerCitizen: new Uint8Array([5, 0, 0, 0, 0, 0, 0, 0, ...Array(24).fill(0)]) });
const prov = (p, q) => ({ p, q, layoutVersion: 2, passableMask: ALL, roughMask: 0n, roadMask: 0n, siteCount: 1, sites: [5], siteMirror: [{ state: 1, faction: 1 }], camp: { state: 1, tile: 7 }, keep: { tile: 8, holder: 1 }, resolvedNext: 10, structures: [], forts: [], caravans: [] });
const place = (kind, tile) => ({ kind, p: 0, q: 0, at: 2, gen: 1, tile });
const caravan = { ownerTag: '5', seq: 2, faction: 1, src: place(1, 30), dst: place(2, 40), steps: 7, cargo: [400, 0, 0, 0, 0, 0, 0, 0], arriveTs: 1790000000,
  runs: [{ p: 0, q: 0, firstBell: 290, n: 2 }], raided: false, path: [0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], provinces: [[0, 0]] };
const world = nowBell => ({ mode: 'play', nowBell, chain: { now: () => 1000 }, citizen: { faction: 1, vaults: 0, towers: 0, palisades: 0, forts: 0, caravans: 4, voted: [0, 0, 0, 0] },
  holdings: [holding(0, 0, 0, 30)], activeHolding: 0, provinces: new Map([['0,0', { province: prov(0, 0) }]]),
  s1: { caravans: { moving: [caravan], vaults: [{ p: 0, q: 0, tile: 40, ownerTag: '5', faction: 1, gen: 1 }] }, structures: { structures: [], sightings: [] }, nations: null } });
const card = fs => String(SCR.renderS1Village(fs));

test('a caravan past its arrival turn and not settled yet: "overdue, not settled" under its row — never "arrived"', () => {
  setLang('ja');
  const before = card(world(291));
  assert.match(before, /ターン 292 に到着/);
  assert.doesNotMatch(before, /data-key="arrival:/);
  const after = card(world(300));
  assert.match(after, /role="status" data-key="arrival:overdue"[\s\S]*到着予定のターン 292 を過ぎました。まだ決着していません/);
  assert.doesNotMatch(after, /到着済み|着きました|入りました/, 'past the turn is not arrived');
  assert.deepEqual([SRC.arrivalOnRoad({ arriveBell: 292 }, 291), SRC.arrivalOnRoad({ arriveBell: 292 }, 292), SRC.arrivalOnRoad({ arriveBell: null }, 999)], [null, { state: 'overdue', bell: 292 }, null]);
});

test('04\'s own arrival, when 04 registers it, replaces the page\'s', () => {
  const off = SRC.registerStatusSource('caravanArrival', () => ({ state: 'settledUnverified', why: 'dstUnknown' }));
  try { assert.match(card(world(300)), /data-key="arrival:settledUnverified:dstUnknown"/); } finally { off(); }
  assert.match(card(world(300)), /data-key="arrival:overdue"/);
});

test('with nothing registered the village card shows no cancel, no costs and no manual line', () => {
  const html = card(world(300));
  assert.doesNotMatch(html, /data-key="cancel:|data-key="cost:|data-key="manual"|使える量/);
});

test('04\'s cancel shows under the caravan its source names; 05\'s costs and manual play over the caravans', () => {
  setLang('ja');
  const off1 = SRC.registerStatusSource('caravanCancel', (fs, c) => (c.seq === 2 ? { stage: 'awaitSigned', signedPending: 1 } : null));
  const off2 = SRC.registerStatusSource('villageCosts', () => ({ costs: [{ phase: 'reserved', amounts: [100, 0, 0, 0, 0, 0, 0, 0] }, { phase: 'unsettled' }], committedInHave: true }));
  const off3 = SRC.registerStatusSource('manualPlay', () => ({ signedPending: 2 }));
  try {
    const html = card(world(300));
    assert.match(html, /data-key="cancel:awaitSigned"[\s\S]*署名済みの要求 1 件の確認を待っています/);
    assert.match(html, /data-key="cost:reserved"[\s\S]*予約：食料 100/);
    assert.match(html, /data-key="cost:unsettled"/);
    assert.match(html, /使える量（未確定の費用を最大で引いた見込み）：食料 900/, 'the stores less the reservation, said as an estimate while a cost is unsettled');
    assert.match(html, /data-key="manual"[\s\S]*すでに署名した操作 2 件は止まらずに進みます/);
    assert.ok(html.indexOf('data-key="manual"') < html.indexOf('道中の隊商'), 'over the caravans');
  } finally { off1(); off2(); off3(); }
  // 05 must say whether committed costs already left the stores: without it the card says it cannot tell
  const off = SRC.registerStatusSource('villageCosts', () => ({ costs: [{ phase: 'committed', amounts: [10, 0, 0, 0, 0, 0, 0, 0] }] }));
  try { assert.match(card(world(300)), /使える量を出せません：committedInHave: missing/); } finally { off(); }
  // a source that throws says nothing
  const bad = SRC.registerStatusSource('caravanCancel', () => { throw new Error('x'); });
  try { assert.doesNotMatch(card(world(300)), /data-key="cancel:/); } finally { bad(); }
  assert.throws(() => SRC.registerStatusSource('somethingElse', () => null), TypeError);
});

// ---------------------------------------------------------------- partial and full arrivals, from the records
function body(name, bell, fields = {}) {
  const spec = LOGS.kinds.find(k => k.name === name), parts = [...spec.key, ...spec.payload];
  const b = new Uint8Array(6 + parts.reduce((a, f) => a + f.len, 0) + 1), v = new DataView(b.buffer);
  b[0] = 1; b[1] = spec.kind; v.setUint32(2, bell, true);
  let o = 6;
  for (const f of parts) { const x = fields[f.name]; if (x instanceof Uint8Array) b.set(x.subarray(0, f.len), o); else if (x !== undefined) { if (f.len === 8) v.setBigUint64(o, BigInt(x), true); else if (f.len === 4) v.setInt32(o, Number(x), true); else if (f.len === 2) v.setUint16(o, Number(x), true); else if (f.len === 1) b[o] = Number(x); } o += f.len; }
  return toBase64(b);
}
const cargo = arr => { const b = new Uint8Array(32), v = new DataView(b.buffer); arr.forEach((n, i) => v.setUint32(i * 4, n, true)); return b; };
const rec = (seq, name, bell, f) => ({ seq: String(seq), record: decodeRecord(body(name, bell, f)) });
const me = { tag: 5n, faction: 1, holdings: [{ p: 0, q: 0, site: 0 }], hostOf: () => null };
const S1_RULES = { programVersion: 4 };
const sum = records => RS.summarize({ records, read: { after: '100', complete: true }, marks: { confirmedSeq: '100', confirmedBell: 280, caravans: {} }, last: null, season: '7', wallet: 'W', nowBell: 320, me, rules: S1_RULES });

// (a place as the log writes it: kind 1 a village, 2 a storehouse, then P, Q, site, generation, tile — caravan.rs Place::log)
const at = (kind, gen = 1) => BigInt(kind) | (BigInt(gen) << 48n);
const sent = (seq, cargo400, worn = 0, dst = at(1)) => rec(seq, 'CARAVAN_SENT', 285, { owner_tag: 5, seq: 2, faction: 1, dst, cargo: cargo(cargo400), worn_bps: worn });
const settled = (seq, dst, amounts, outcome = 0) => rec(seq, 'CARAVAN_SETTLED', 292, { owner_tag: 5, seq: 2, outcome, dst, cargo: cargo(amounts) });
const arrivalOf = records => sum(records).items.find(i => i.kind === 'CARAVAN_SETTLED')?.facts.arrival;
// (the send read in an earlier look: the mark keeps who holds the caravan, not what it was sent with)
const heldSince = records => heldSum(records).items.find(i => i.kind === 'CARAVAN_SETTLED')?.facts.arrival;
heldSince.item = records => heldSum(records).items.find(i => i.kind === 'CARAVAN_SETTLED');
const heldSum = records => RS.summarize({ records, read: { after: '100', complete: true }, marks: { confirmedSeq: '100', confirmedBell: 280, caravans: { '5:2': '5' } }, last: null, season: '7', wallet: 'W', nowBell: 320, me, rules: S1_RULES });
const F400 = [400, 0, 0, 0, 0, 0, 0, 0], F352 = [352, 0, 0, 0, 0, 0, 0, 0];

test('to a village (Holding::credit adds the record\'s cargo whole): the intake is known; "full" and "partial" are against the SEND RECORD\'s amount, said so', () => {
  setLang('ja');
  const full = arrivalOf([sent(101, F400, 120), settled(102, at(1), F400)]);
  assert.deepEqual(full, { state: 'verifiedFull', basis: 'sentRecord', sent: F400, arrived: F400, wornBps: 120 });
  const fullText = RW.itemText(sum([sent(101, F400, 120), settled(102, at(1), F400)]).items.find(i => i.kind === 'CARAVAN_SETTLED'));
  assert.match(fullText, /送付記録の数量に対して全量が入りました：食料 400/);
  assert.match(fullText, /比べた基準は送付記録の数量です。送付記録の数量は経路の減少を引いたあとの量で、最初に積んだ量と経路の損失は、この記録からは確定しません/);
  assert.match(fullText, /送付記録には経路の減少率 1\.2% が記されています/);
  assert.match(fullText, /数量は記録の単位です（1 未満は切り捨て）/);
  assert.doesNotMatch(fullText, /(?<!送付記録の数量に対して)全量が入りました|全部入りました|無損失/, 'never "all arrived" without its basis');
  const part = arrivalOf([sent(101, F400), settled(102, at(1), F352)]);
  assert.deepEqual(part, { state: 'verifiedPartial', basis: 'sentRecord', sent: F400, arrived: F352, wornBps: 0 });
  assert.match(RW.itemText(sum([sent(101, F400), settled(102, at(1), F352)]).items.find(i => i.kind === 'CARAVAN_SETTLED')), /送付記録の数量に対して一部が入りました：食料 352。送付記録の数量：食料 400/);
});

test('the intake known and the comparison possible are two judgements: no send read → intake only; a send to another place or generation → intake only', () => {
  setLang('ja');
  assert.deepEqual(heldSince([settled(102, at(1), F352)]), { state: 'verifiedIntake', intake: F352, compare: 'sentUnknown' });
  assert.match(RW.itemText(heldSince.item([settled(102, at(1), F352)])), /村に入った量：食料 352。送付記録を読めていないため、送った量の全部か一部かは比べられません/);
  // the village's generation changed between the send and the settlement (another village on that site): not compared
  assert.deepEqual(arrivalOf([sent(101, F400, 0, at(1, 1)), settled(102, at(1, 2), F400)]), { state: 'verifiedIntake', intake: F400, compare: 'dstChanged' });
  // neither the send nor a mark that holds it: who holds it is unknown, so no arrival is told as the viewer's at all
  assert.equal(arrivalOf([settled(102, at(1), F352)]), undefined);
  assert.equal(sum([settled(102, at(1), F352)]).items.find(i => i.kind === 'CARAVAN_SETTLED').tone, 'uncertain');
});

test('under another program version, or an outcome not read, the intake is not read from the record', () => {
  const other = RS.summarize({ records: [sent(101, F400), settled(102, at(1), F400)], read: { after: '100', complete: true }, marks: { confirmedSeq: '100', confirmedBell: 280, caravans: {} }, last: null, season: '7', wallet: 'W', nowBell: 320, me, rules: { programVersion: 3 } });
  assert.deepEqual(other.items.find(i => i.kind === 'CARAVAN_SETTLED').facts.arrival, { state: 'settledUnverified', why: 'rulesUnknown', recorded: F400 });
  assert.deepEqual(SRC.arrivalSettled({ outcome: 7, dst: at(1), cargo: F400 }, null, S1_RULES), { state: 'settledUnverified', why: 'outcomeUnknown', recorded: F400 });
  assert.equal(SRC.S1_PROGRAM_VERSION, 4);
});

test('to a storehouse (settle_caravan cuts at the vault\'s cap, the record keeps the whole cargo): never verified, even when the send matches', () => {
  setLang('ja');
  assert.deepEqual(arrivalOf([sent(101, F400, 0, at(2)), settled(102, at(2), F400)]), { state: 'settledUnverified', why: 'vault', recorded: F400 });
  const t = RW.itemText(sum([sent(101, F400, 0, at(2)), settled(102, at(2), F400)]).items.find(i => i.kind === 'CARAVAN_SETTLED'));
  assert.match(t, /^隊商（ターン 292）：決着しました。入った量はまだ確かめられていません。倉庫は上限を超えた分を切り捨てます/);
  assert.equal(t.split('決着しました').length - 1, 1, 'said once, not twice');
  assert.doesNotMatch(t, /全量|一部が入りました|村に入った量/);
  assert.deepEqual(heldSince([settled(102, 0n, F400)]), { state: 'settledUnverified', why: 'dstUnknown', recorded: F400 });
});

test('a lost cargo is final; between two looks the sends read before are carried on', () => {
  assert.deepEqual(arrivalOf([sent(101, F400), settled(102, at(1), F400, 1)]), { state: 'lost', recorded: F400 });
  const first = sum([sent(101, F400)]);
  const { items } = RS.itemsSince([settled(102, at(1), F352)], me, first.book, first.sent, S1_RULES);
  assert.equal(items[0].facts.arrival.state, 'verifiedPartial');
  assert.deepEqual([SRC.dstKind(1n), SRC.dstKind(0x2a0000000000002n), SRC.dstKind(undefined)], [1, 2, null]);
});

// ---------------------------------------------------------------- the original sender is never told "all arrived" for a caravan it no longer holds
const raided = (seq, choice, raider) => rec(seq, 'CARAVAN_RAIDED', 290, { owner_tag: 5, seq: 2, p: 0, q: 0, bell: 289, choice, by: 0, raider_tag: raider, taken: cargo(F400) });
test('burned: the caravan walks on empty and is logged delivered with no cargo — the sender is told the burn, never an arrival', () => {
  setLang('ja');
  const s = sum([sent(101, F400), raided(102, 1, 0x77), settled(103, at(1), [0, 0, 0, 0, 0, 0, 0, 0])]);
  assert.equal(s.items.filter(i => i.kind === 'CARAVAN_SETTLED').length, 0, 'no arrival item for the sender');
  assert.match(RW.itemText(s.items.find(i => i.kind === 'CARAVAN_RAIDED')), /積荷は焼かれました/);
  assert.doesNotMatch(s.items.map(RW.itemText).join('\n'), /全量|一部が入りました|村に入った量/);
});

test('taken: the caravan is the raider\'s; the sender is told the take, never an arrival; the raider\'s arrival names another place than the send, so it is not compared with it', () => {
  setLang('ja');
  const recs = [sent(101, F400), raided(102, 0, 0x77), rec(103, 'CARAVAN_SETTLED', 292, { owner_tag: 5, seq: 2, outcome: 0, dst: at(1, 3), cargo: cargo(F400) })];
  const sender = sum(recs);
  assert.equal(sender.items.filter(i => i.kind === 'CARAVAN_SETTLED').length, 0);
  assert.doesNotMatch(sender.items.map(RW.itemText).join('\n'), /全量|一部が入りました|村に入った量/);
  const raider = RS.summarize({ records: recs, read: { after: '100', complete: true }, marks: { confirmedSeq: '100', confirmedBell: 280, caravans: {} }, last: null, season: '7', wallet: 'R', nowBell: 320, me: { ...me, tag: 0x77n }, rules: S1_RULES });
  assert.deepEqual(raider.items.find(i => i.kind === 'CARAVAN_SETTLED').facts.arrival, { state: 'verifiedIntake', intake: F400, compare: 'dstChanged' });
});

test('English words for the connected states', () => {
  setLang('en');
  const off = SRC.registerStatusSource('villageCosts', () => ({ costs: [{ phase: 'reserved', amounts: [100, 0, 0, 0, 0, 0, 0, 0] }], committedInHave: true }));
  try {
    const html = card(world(300)).replace(/<[^>]+>/g, ' ');
    assert.match(html, /Its arrival turn 292 has passed\. Its journey is not concluded yet/);
    assert.match(html, /Usable \(after reservations\): Food 900/);
  } finally { off(); setLang('ja'); }
});
