// The reserved siege on the expedition card (decision B, 2026-11-12): the card's model of one order
// (fconquest-order.mjs) and its lines (hud/hand.mjs siegeOrderView / localConquestView). Display only.
//
// EVERYTHING HERE IS WRITTEN BY HAND. No state of a reserved siege can be read today: the program, ABI and receipts
// of B are being written by their owner and no contract is pinned. These tests say what the card WOULD show for a
// given statement of facts, and that it shows nothing of an order while the contract is unpublished. They say
// nothing about the real program. No wallet, no relay, no chain; runs under the no-key guard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as O from '../../permutation-server/web/frontier/fconquest-order.mjs';
import * as hand from '../../permutation-server/web/frontier/hud/hand.mjs';
import { setLang, missingKeys } from '../../permutation-server/web/lang.mjs';

const facts = (more = {}) => ({ phase: 'ordered', site: 3, standing: { p: '129', q: '0' }, order_bell: '41', decided_bell: null, reason: null, lapsed: null, source: null, stake: 'held', slot: 'held', capture: null, day: null, ...more });
const CAPTURE = { receipt: true, holding: true, slot: true };
const GOOD = {
  ordered: facts(),
  started: facts({ phase: 'started', decided_bell: '41' }),
  // (the program stores no cause for a reservation that did not start: `reason: null` is the ordinary statement)
  notAppliedOwed: facts({ phase: 'not_applied', lapsed: false, decided_bell: '41' }),
  notAppliedHalf: facts({ phase: 'not_applied', lapsed: false, decided_bell: '41', stake: 'returned' }),
  notAppliedDebt: facts({ phase: 'not_applied', lapsed: false, decided_bell: '41', slot: 'released' }),
  notAppliedSettled: facts({ phase: 'not_applied', lapsed: false, decided_bell: '41', stake: 'returned', slot: 'released', day: { used: 1, limit: 2 } }),
  captured: facts({ phase: 'captured', decided_bell: '47', stake: 'returned', slot: 'used', capture: CAPTURE }),
  lost: facts({ phase: 'lost', decided_bell: '45', stake: 'burnt', slot: 'released' }),
  unresolved: facts({ phase: 'unresolved', decided_bell: '90', stake: 'returned', slot: 'held' }),
};
/** A reservation that lapsed with the season (known only from a verified state difference or a full digest replay; never from the receipt, which carries no readable lapse mark), and one whose way of ending the statement has no basis for. */
const LAPSED = facts({ phase: 'not_applied', lapsed: true });
const UNKNOWN_END = facts({ phase: 'not_applied', lapsed: null });
const idle = { status: 'idle', busy: false, host: null, digest: null, site: null, entry: null, standing: null, lastValidBlockHeight: null, requestId: null, signature: null, code: null, error: null, sent: false, chain: null, slot: null };
const WORLD = { schema: 'frontier-local-play-conquest-world-v1', program: 'P', season: 'S', world_preset: 'local-conquest-test-v1', free_city: { p: '129', q: '0', site: 3, tile: 43 } };
const FS = { localPlay: { conquestWorld: WORLD } };
const card = (order, returning = { phase: 'resident' }, state = idle) => String(hand.localConquestView(FS, returning, { state, spent: false, other: false, order }));
const WON = /占領しました|captured the Free City/;

test('the read contract is NARROW: only "ordered" and "not_applied" with nothing beyond a table record; no bare statement is ever read as an answer', () => {
  assert.deepEqual(O.SIEGE_ORDER_CONTRACT, { schema: 'frontier-local-play-conquest-orders-v2', phases: ['ordered', 'not_applied'], cityStates: ['siege', 'capture_due', 'owned', 'slot_owed', 'other'] });
  assert.ok(Object.isFrozen(O.SIEGE_ORDER_CONTRACT) && Object.isFrozen(O.SIEGE_ORDER_CONTRACT.phases));
  const expect = { program: 'P', season: 'S', wallet: 'W', standing: { p: '129', q: '0' } };
  // a statement of facts by itself, of any phase, is not an answer of the relay: nothing is read from it
  for (const v of [undefined, null, {}, GOOD.captured, GOOD.ordered, { schema: 'frontier-local-play-conquest-state-v1', phase: 'captured' }, 'captured', [GOOD.captured]]) {
    assert.deepEqual(O.siegeOrderRead(v, expect), { ok: false, code: 'SiegeOrderAnswerMalformed' });
    assert.equal(O.siegeOrderRead(v).ok, false, 'and without what was asked, nothing either');
  }
  // an answer in the contract's shape: a started siege, a capture, a loss or an unresolved one is BEYOND the evidence, and refuses the whole answer
  const answer = (orders, siege = null) => ({ schema: 'frontier-local-play-conquest-orders-v2', context_slot: '5', program: 'P', season: 'S', wallet: 'W', standing: { p: '129', q: '0' }, table_address: '1'.repeat(32).replace(/1/g, '2'), table: 'present', orders, siege });
  // the earlier schema, and an answer without the city's state, are not this contract's
  assert.equal(O.siegeOrderRead({ ...answer([]), schema: 'frontier-local-play-conquest-orders-v1' }, expect).ok, false);
  assert.equal(O.siegeOrderRead((({ siege, ...rest }) => rest)(answer([])), expect).ok, false);
  assert.equal(O.siegeOrderRead(answer([{ seq: 0, facts: GOOD.ordered }]), expect).ok, true);
  for (const k of ['started', 'captured', 'lost', 'unresolved', 'notAppliedOwed', 'notAppliedSettled'])
    assert.deepEqual(O.siegeOrderRead(answer([{ seq: 0, facts: GOOD.ordered }, { seq: 1, facts: GOOD[k] }]), expect), { ok: false, code: 'SiegeOrderAnswerBeyondEvidence' }, k);
  assert.equal(O.siegeOrderRead(answer([{ seq: 0, facts: UNKNOWN_END }]), expect).ok, true, 'not applied, with nothing said of how it ended');
  const src = readFileSync(new URL('../../permutation-server/web/frontier/hud/hand.mjs', import.meta.url), 'utf8');
  assert.ok(!src.includes("order: null });"), 'the live block takes its order from the read module');
  assert.ok(!src.includes('siegeOrderRead') && !/from '[^']*fconquest-order\.mjs'/.test(src), 'the card module neither reads nor builds an order: it imports nothing of it');
  const mod = readFileSync(new URL('../../permutation-server/web/frontier/fconquest-order.mjs', import.meta.url), 'utf8');
  for (const banned of ['fetch', 'localStorage', 'sessionStorage', 'indexedDB', 'console.', 'XMLHttpRequest', 'WebSocket', 'solana-tx', 'base58']) assert.ok(!mod.includes(banned), banned);
});

test('the city\'s PRESENT state: each state from its exact facts; "owned" is a fact of now, not the `captured` phase; malformed states are refused', () => {
  const M = O.cityStateModel, bad = v => assert.throws(() => M(v), { code: 'SiegeCityStateMalformed' }, JSON.stringify(v));
  assert.equal(M(null), null);
  // a siege says ITS OWN progress of ITS OWN requirement (not a fixed 36)
  assert.deepEqual(M({ state: 'siege', site: 1, progress: 0, required: 36, declared_bell: '19' }), { state: 'siege', site: 1, progress: 0, required: 36, declaredBell: '19' });
  assert.deepEqual(M({ state: 'siege', site: 1, progress: 4, required: 5, declared_bell: '19' }), { state: 'siege', site: 1, progress: 4, required: 5, declaredBell: '19' });
  // a capture due has no progress: the turn it is due from, and the declaration's
  assert.deepEqual(M({ state: 'capture_due', site: 1, due_bell: '55', declared_bell: '19' }), { state: 'capture_due', site: 1, dueBell: '55', declaredBell: '19' });
  assert.deepEqual(M({ state: 'owned', site: 1, slot: 2, generation: 1 }), { state: 'owned', site: 1, slot: 2, generation: 1 });
  assert.deepEqual(M({ state: 'slot_owed', site: 1, slot: 3 }), { state: 'slot_owed', site: 1, slot: 3 });
  for (const what of ['siege', 'capture_due', 'slot_owed', 'holding']) assert.deepEqual(M({ state: 'other', site: 11, what }), { state: 'other', site: 11, what });
  assert.ok(Object.isFrozen(M({ state: 'owned', site: 1, slot: 2, generation: 1 })));
  // no state is called "captured", "won" or "returned": those are past events this read cannot bear out
  assert.ok(!O.SIEGE_ORDER_CONTRACT.cityStates.some(s => /captur|won|return|lost/.test(s) && s !== 'capture_due'));
  for (const v of [undefined, {}, 'owned', [], { state: 'captured', site: 1 }, { state: 'won', site: 1 }, { state: 'returned', site: 1 }, { state: 'owned', site: 12, slot: 2, generation: 1 }, { state: 'owned', site: -1, slot: 2, generation: 1 },
    { state: 'owned', site: '1', slot: 2, generation: 1 }, { state: 'owned', site: 1, slot: 1, generation: 1 }, { state: 'owned', site: 1, slot: 4, generation: 1 }, { state: 'owned', site: 1, slot: 2, generation: 0 },
    { state: 'owned', site: 1, slot: 2, generation: 255 }, { state: 'owned', site: 1, slot: 2 }, { state: 'owned', site: 1, slot: 2, generation: 1, receipt: true },
    { state: 'siege', site: 1, progress: 36, required: 36, declared_bell: '19' }, { state: 'siege', site: 1, progress: 37, required: 36, declared_bell: '19' }, { state: 'siege', site: 1, progress: -1, required: 36, declared_bell: '19' },
    { state: 'siege', site: 1, progress: 0, required: 0, declared_bell: '19' }, { state: 'siege', site: 1, progress: 0, required: 36, declared_bell: 19 }, { state: 'siege', site: 1, progress: 0, required: 36 },
    { state: 'capture_due', site: 1, due_bell: '19', declared_bell: '19' }, { state: 'capture_due', site: 1, due_bell: '18', declared_bell: '19' }, { state: 'capture_due', site: 1, due_bell: '55', declared_bell: '19', progress: 36 },
    { state: 'slot_owed', site: 1, slot: 1 }, { state: 'slot_owed', site: 1 }, { state: 'other', site: 1, what: 'captured' }, { state: 'other', site: 1 }, { state: 'other', site: 1, what: 'siege', progress: 3 }]) bad(v);
  // the lines: present facts only
  setLang('ja');
  try {
    const view = v => String(hand.cityStateView(M(v)));
    assert.equal(String(hand.cityStateView(null)), '');
    let c = view({ state: 'siege', site: 1, progress: 7, required: 36, declared_bell: '19' });
    assert.match(c, /data-siege-city="siege"/); assert.match(c, /あなたの包囲が進行中です：7 \/ 36 ターン（宣言はターン 19・場所 1）。都市はまだあなたのものではありません。/);
    assert.match(view({ state: 'siege', site: 1, progress: 2, required: 5, declared_bell: '19' }), /2 \/ 5 ターン/);
    c = view({ state: 'capture_due', site: 1, due_bell: '55', declared_bell: '19' });
    assert.match(c, /占領の精算待ちです（ターン 55 以降・宣言はターン 19・場所 1）。都市はまだあなたのものではありません。/); assert.doesNotMatch(c, /\d+ \/ \d+ ターン/, 'a capture due shows no progress');
    c = view({ state: 'owned', site: 1, slot: 2, generation: 1 });
    assert.match(c, /data-siege-city="owned"/); assert.match(c, /この都市はいま、あなたが所有しています（場所 1・拠点の枠 2）。いま所有しているという事実だけを表示しています。/);
    // "yours now" is not "captured": no word of a capture, a victory or a return in any state's line
    const all = [{ state: 'siege', site: 1, progress: 7, required: 36, declared_bell: '19' }, { state: 'capture_due', site: 1, due_bell: '55', declared_bell: '19' }, { state: 'owned', site: 1, slot: 2, generation: 1 },
      { state: 'slot_owed', site: 1, slot: 2 }, ...['siege', 'capture_due', 'slot_owed', 'holding'].map(what => ({ state: 'other', site: 1, what }))];
    for (const v of all) { const t = view(v); assert.doesNotMatch(t, /占領しました|勝ちました|勝利|奪いました|戻りました|失敗しました|成功/, JSON.stringify(v)); assert.doesNotMatch(t, /data-act=|<button/); }
    assert.match(view({ state: 'slot_owed', site: 1, slot: 2 }), /あなたの包囲は、いまは進行していません。拠点の使用枠 2 は解放待ちです（場所 1）。/);
    // another player's: said by its kind, neutrally, with none of their numbers; never "your"
    for (const [what, re] of [['siege', /別のプレイヤーの包囲が進行中です/], ['capture_due', /別のプレイヤーの包囲が占領の精算待ちです/], ['holding', /いま、別のプレイヤーが所有しています/], ['slot_owed', /別のプレイヤーの包囲に関する記録があります/]]) {
      const t = view({ state: 'other', site: 1, what }); assert.match(t, re); assert.doesNotMatch(t, /あなたの|ターン \d|\d+ \/ \d+/, what);
    }
    setLang('en');
    assert.match(view({ state: 'siege', site: 1, progress: 7, required: 36, declared_bell: '19' }), /Your siege is under way: 7 of 36 turns \(declared at turn 19; site 1\)\. The city is not yours yet\./);
    assert.match(view({ state: 'owned', site: 1, slot: 2, generation: 1 }), /You hold this city now \(site 1; holding slot 2\)\. Only the fact that you hold it now is shown\./);
    for (const v of all) { const t = view(v); assert.doesNotMatch(t, /captured|you won|victory|returned|succeeded|failed/i, JSON.stringify(v)); }
    assert.deepEqual(missingKeys().filter(k => /この都市|あなたの包囲|別のプレイヤー/.test(k)), []);
  } finally { setLang('ja'); }
  // the history rule stays: the `captured` PHASE of an order still needs its three capture facts, and the read never produces it
  assert.equal(O.siegeOrderModel({ ...GOOD.captured, capture: { receipt: false, holding: true, slot: true } }).ok, false);
  assert.ok(!O.SIEGE_ORDER_CONTRACT.phases.includes('captured'));
});

test('the model: each phase from a consistent statement; settled only when nothing waits on a settlement', () => {
  const m = Object.fromEntries(Object.entries(GOOD).map(([k, f]) => [k, O.siegeOrderModel(f)]));
  for (const [k, v] of Object.entries(m)) assert.equal(v.ok, true, k);
  assert.deepEqual(m.ordered, { ok: true, phase: 'ordered', site: 3, standing: { p: '129', q: '0' }, orderBell: '41', decidedBell: null, reason: null, lapsed: null, source: null, stake: 'held', slot: 'held', settled: false, day: null });
  assert.deepEqual([m.started.settled, m.notAppliedOwed.settled, m.notAppliedHalf.settled, m.notAppliedDebt.settled, m.notAppliedSettled.settled, m.captured.settled, m.lost.settled, m.unresolved.settled],
    [false, false, false, false, true, true, true, false]);
  // not_applied with NO reason is valid in every return state; the slot and rent released with the deposit still owed is NOT settled
  for (const k of ['notAppliedOwed', 'notAppliedHalf', 'notAppliedDebt', 'notAppliedSettled']) assert.deepEqual([m[k].phase, m[k].reason], ['not_applied', null], k);
  assert.deepEqual([m.notAppliedDebt.stake, m.notAppliedDebt.slot, m.notAppliedDebt.settled], ['held', 'released', false]);
  assert.deepEqual(m.notAppliedSettled.day, { used: 1, limit: 2 });
  // a capture whose deposit is still held is a capture, but NOT settled (what a capture does with the deposit is the contract's to say)
  const heldCapture = O.siegeOrderModel({ ...GOOD.captured, stake: 'held' });
  assert.deepEqual([heldCapture.ok, heldCapture.phase, heldCapture.settled], [true, 'captured', false]);
  assert.ok(Object.isFrozen(m.ordered) && Object.isFrozen(m.ordered.standing));
  // a DERIVED reason is optional, only on not_applied; one this page has no words for is kept as its code
  assert.equal(O.siegeOrderModel({ ...GOOD.notAppliedOwed, reason: 'HostGone' }).reason, 'HostGone');
  assert.equal(O.siegeOrderModel({ ...GOOD.notAppliedOwed, reason: 'SomeNewReason' }).reason, 'SomeNewReason');
});

test('wide coordinates are signed: negative, zero and the bound are provinces; non-canonical or out-of-range are not', () => {
  const at = (p, q) => O.siegeOrderModel(facts({ standing: { p, q } }));
  const BOUND = (1n << 62n).toString();
  for (const [p, q] of [['129', '0'], ['-129', '0'], ['0', '-129'], ['-64', '-65'], ['0', '0'], [BOUND, `-${BOUND}`], [`-${BOUND}`, BOUND]]) {
    const m = at(p, q); assert.equal(m.ok, true, `${p},${q}`); assert.deepEqual(m.standing, { p, q });
  }
  const OVER = ((1n << 62n) + 1n).toString();
  for (const [p, q] of [[OVER, '0'], ['0', `-${OVER}`], ['-0', '0'], ['+129', '0'], ['0129', '0'], [' 129', '0'], ['1e3', '0'], ['', '0'], [129, '0'], ['129', 0], [-129n, '0'], [null, '0'], ['129', undefined], ['18446744073709551615', '0']])
    assert.deepEqual(at(p, q), { ok: false, code: 'SiegeOrderFactsMalformed' }, `${String(p)},${String(q)}`);
  // the card shows a negative province's order like any other
  assert.match(String(hand.siegeOrderView(O.siegeOrderModel(facts({ standing: { p: '-129', q: '0' } })))), /data-siege-order="ordered"/);
});

test('refused whole: a statement that is malformed, contradicts itself, or contradicts the approved rules', () => {
  const bad = (f, code = 'SiegeOrderFactsInconsistent') => assert.deepEqual(O.siegeOrderModel(f), { ok: false, code }, JSON.stringify(f));
  for (const v of [null, undefined, [], 'ordered', {}, { ...GOOD.ordered, extra: 1 }, (({ day, ...rest }) => rest)(GOOD.ordered)]) bad(v, 'SiegeOrderFactsMalformed');
  for (const more of [{ phase: 'won' }, { phase: 'cancelled' }, { site: 12 }, { site: -1 }, { site: '3' }, { standing: { p: '129' } }, { order_bell: 41 }, { order_bell: '041' }, { order_bell: '-1' },
    { order_bell: '18446744073709551616' }, { decided_bell: 41 }, { reason: 'no good' }, { stake: 'lost' }, { slot: 'free' }, { capture: { receipt: true } }, { day: { used: 1 } }])
    bad(facts(more), 'SiegeOrderFactsMalformed');
  // approved rule: an order that did not start never loses its deposit and never uses the slot
  bad({ ...GOOD.notAppliedOwed, stake: 'burnt' });
  bad({ ...GOOD.notAppliedOwed, slot: 'used' });
  for (const k of ['captured', 'lost', 'unresolved']) bad({ ...GOOD[k], reason: 'HostGone' });
  // `lapsed` and `source` are facts of a not-applied order only; malformed values are refused
  for (const k of ['ordered', 'started', 'captured', 'lost', 'unresolved']) for (const more of [{ lapsed: false }, { lapsed: true }, { source: 'present' }, { source: 'absent' }]) bad({ ...GOOD[k], ...more });
  for (const more of [{ lapsed: 'yes' }, { lapsed: 0 }, { lapsed: undefined }, { source: 'gone' }, { source: false }]) bad({ ...GOOD.notAppliedOwed, ...more }, 'SiegeOrderFactsMalformed');
  // no turn decided a lapse or an ending that is not known; a turn's own failure is decided at that turn
  bad({ ...GOOD.notAppliedOwed, lapsed: true }); bad({ ...GOOD.notAppliedOwed, lapsed: null }); bad({ ...GOOD.notAppliedOwed, decided_bell: null });
  // a derived reason belongs to a turn's processing only: never on a lapse, never without a basis
  bad({ ...LAPSED, reason: 'TooLate' }); bad({ ...UNKNOWN_END, reason: 'HostGone' });
  // nothing is returned to a Holding that is not there
  bad({ ...GOOD.notAppliedOwed, source: 'absent', stake: 'returned' }); bad({ ...LAPSED, source: 'absent', stake: 'returned', slot: 'released' });
  // an order applies, or fails to, at exactly its own turn; nothing is decided before it; nothing is decided while ordered
  bad({ ...GOOD.started, decided_bell: '42' });
  bad({ ...GOOD.notAppliedOwed, decided_bell: '40' });
  bad({ ...GOOD.lost, decided_bell: '40' });
  bad({ ...GOOD.ordered, decided_bell: '41' });
  bad({ ...GOOD.started, decided_bell: null });
  // held while reserved or under way: nothing returned, burnt or used yet; no reason; no capture
  for (const more of [{ stake: 'returned' }, { stake: 'burnt' }, { slot: 'released' }, { slot: 'used' }, { reason: 'HostGone' }, { capture: CAPTURE }]) { bad({ ...GOOD.ordered, ...more }); bad({ ...GOOD.started, ...more }); }
  // a capture is the three facts together and the used slot: nothing less, and no other phase carries them
  for (const k of ['receipt', 'holding', 'slot']) { bad({ ...GOOD.captured, capture: { ...CAPTURE, [k]: false } }); bad({ ...GOOD.captured, capture: { ...CAPTURE, [k]: 1 } }); }
  bad({ ...GOOD.captured, slot: 'held' }); bad({ ...GOOD.captured, slot: 'released' }); bad({ ...GOOD.captured, capture: null });
  bad({ ...GOOD.lost, capture: CAPTURE }); bad({ ...GOOD.lost, slot: 'used' }); bad({ ...GOOD.unresolved, slot: 'used' }); bad({ ...GOOD.unresolved, stake: 'burnt' });
  // the day's count: this order used one
  for (const day of [{ used: 0, limit: 2 }, { used: 3, limit: 2 }, { used: 1, limit: 0 }, { used: 1.5, limit: 2 }, { used: '1', limit: 2 }]) bad(facts({ day }));
});

test('the lines: each phase says only its facts; returned only when returned; a capture only from the captured phase', () => {
  setLang('ja');
  try {
    const view = f => String(hand.siegeOrderView(O.siegeOrderModel(f)));
    assert.equal(String(hand.siegeOrderView(null)), ''); assert.equal(String(hand.siegeOrderView(undefined)), '');
    let c = view(GOOD.ordered);
    assert.match(c, /data-siege-order="ordered"/); assert.match(c, /ターン 41 の処理を待っています（場所 3）/); assert.match(c, /まだ包囲は始まっていません。取り消しはできません。/);
    assert.doesNotMatch(c, /戻りました|返却の処理待ち|包囲が始まりました/); assert.doesNotMatch(c, WON);
    c = view(GOOD.started);
    assert.match(c, /包囲が始まりました（ターン 41・場所 3）/); assert.match(c, /都市はまだあなたのものではありません/); assert.doesNotMatch(c, /戻りました|返却の処理待ち/); assert.doesNotMatch(c, WON);
    // did not start: the day's count stays used; what is owed back is "waiting" until the fact says returned
    const GENERAL = /包囲は始まりませんでした（ターン 41・場所 3）。予約したターンの処理のときに条件を満たさなかったか、先の予約が包囲になりました。今日の宣言回数は1回使われたままです。/;
    const CAUSES = /軍勢がもういません|マスにいません|先頭ではありません|もう自由都市ではありません|別の予約が包囲になりました|使用枠が空いていません|包囲が終わりません|理由/;
    c = view(GOOD.notAppliedOwed);
    assert.match(c, /data-siege-order="not_applied"/); assert.match(c, /data-siege-settled="no"/); assert.match(c, GENERAL); assert.doesNotMatch(c, CAUSES);
    assert.match(c, /預けた資源：返却待ちです。返却の債務として残っており、精算はまだ完了していません。/); assert.match(c, /使用枠と預り金：解放待ちです。/); assert.doesNotMatch(c, /戻りました|戻りません|解放済み/);
    c = view(GOOD.notAppliedHalf);
    assert.match(c, GENERAL); assert.match(c, /預けた資源：戻りました。/); assert.match(c, /使用枠と預り金：解放待ちです。/); assert.match(c, /data-siege-settled="no"/); assert.doesNotMatch(c, CAUSES);
    // CASE 1 — the slot and rent are released, the resources are still owed: both said, and NOT a finished settlement
    c = view(GOOD.notAppliedDebt);
    assert.match(c, GENERAL); assert.match(c, /data-siege-settled="no"/); assert.match(c, /使用枠と預り金：解放済みです。/);
    assert.match(c, /預けた資源：返却待ちです。返却の債務として残っており、精算はまだ完了していません。/); assert.doesNotMatch(c, /預けた資源：戻りました|戻りません/); assert.doesNotMatch(c, CAUSES);
    // CASE 2 — everything is back: settled; the day's count is still used
    c = view(GOOD.notAppliedSettled);
    assert.match(c, GENERAL); assert.match(c, /data-siege-settled="yes"/); assert.match(c, /預けた資源：戻りました。/); assert.match(c, /使用枠と預り金：解放済みです。/); assert.match(c, /今日の宣言回数：1 \/ 2/);
    assert.doesNotMatch(c, /戻りません|返却待ち|解放待ち|債務/); assert.doesNotMatch(c, CAUSES);
    // a derived reason is a separate line that says it is derived; the head stays the general sentence
    c = view({ ...GOOD.notAppliedOwed, reason: 'HostGone' });
    assert.match(c, GENERAL); assert.match(c, /data-siege-reason="derived"/); assert.match(c, /状態から導出した理由（記録された理由ではありません）：軍勢がもういません/);
    assert.match(view({ ...GOOD.notAppliedOwed, reason: 'SomeNewReason' }), /記録された理由ではありません）：SomeNewReason/);
    // TERMINAL: lapsed with the season — said as that, with no turn and no cause; without a basis, nothing of how it ended
    const BY_TURN = /予約したターンの処理のときに|先の予約が包囲になりました|ターン 41/, BY_END = /シーズンの終了または中断により、予約は成立しませんでした。/;
    const NOTE = /返却と解放は、精算の処理が行われたときに反映されます。自動で行われるとは限りません。/;
    c = view(LAPSED);
    assert.match(c, /包囲は始まりませんでした（場所 3）。シーズンの終了または中断により、予約は成立しませんでした。今日の宣言回数は1回使われたままです。/); assert.doesNotMatch(c, BY_TURN); assert.doesNotMatch(c, CAUSES);
    assert.match(c, /data-siege-settled="no"/); assert.match(c, /預けた資源：返却待ちです。返却の債務として/); assert.match(c, NOTE);
    c = view(UNKNOWN_END);
    assert.match(c, /包囲は始まりませんでした（場所 3）。予約は成立しませんでした。今日の宣言回数は1回使われたままです。/); assert.doesNotMatch(c, BY_TURN); assert.doesNotMatch(c, BY_END); assert.doesNotMatch(c, CAUSES); assert.match(c, NOTE);
    // SOURCE HOLDING ABSENT: the deposit stays owed; said so, with no promise of when or where; never "returned", never settled
    const ABSENT = /預けた資源：返却待ちです。返却先の拠点がもうありません。返却の債務として残っており、精算は完了していません。いつ、どこへ戻るかはまだ決まっていません。/;
    for (const f of [{ ...GOOD.notAppliedDebt, source: 'absent' }, { ...LAPSED, source: 'absent', slot: 'released' }, { ...UNKNOWN_END, source: 'absent' }]) {
      c = view(f); assert.match(c, ABSENT); assert.match(c, /data-siege-settled="no"/); assert.match(c, NOTE); assert.doesNotMatch(c, /預けた資源：戻りました|戻りません/); assert.doesNotMatch(c, WON);
    }
    assert.match(view({ ...LAPSED, source: 'absent', slot: 'released' }), /使用枠と預り金：解放済みです。/);
    // a Holding that is there, or not known: the ordinary owed line, not the "no longer exists" one
    for (const source of ['present', null]) { c = view({ ...GOOD.notAppliedDebt, source }); assert.doesNotMatch(c, /拠点がもうありません/); assert.match(c, /返却の債務として残っており、精算はまだ完了していません。/); }
    // nothing promises an automatic return: the note stands while anything is owed, and goes when all is back
    for (const k of ['notAppliedOwed', 'notAppliedHalf', 'notAppliedDebt']) assert.match(view(GOOD[k]), NOTE, k);
    assert.doesNotMatch(view(GOOD.notAppliedSettled), NOTE); assert.doesNotMatch(view({ ...LAPSED, stake: 'returned', slot: 'released' }), NOTE);
    for (const f of [...Object.values(GOOD), LAPSED, UNKNOWN_END]) assert.doesNotMatch(view(f), /必ず|自動で戻|automatically returned/);
    // every phase but `captured` says no capture
    for (const k of Object.keys(GOOD).filter(k => k !== 'captured')) assert.doesNotMatch(view(GOOD[k]), WON, k);
    c = view(GOOD.captured);
    assert.match(c, /自由都市を占領しました（場所 3・ターン 47）/); assert.match(c, /占領の記録、新しい拠点、使用枠を確認しました/); assert.match(c, /使用枠：新しい拠点が使っています。/);
    c = view(GOOD.lost); assert.match(c, /包囲は失敗しました/); assert.match(c, /都市は占領していません/); assert.match(c, /預けた資源：戻りません。/);
    c = view(GOOD.unresolved); assert.match(c, /決着しないまま終わりました/); assert.match(c, /預けた資源：戻りました。/); assert.match(c, /使用枠：返却の処理待ちです。/);
    // unreadable: neither started nor not started, and never a capture — also for a "capture" that lacks a fact
    for (const o of [O.siegeOrderModel({ ...GOOD.captured, capture: { ...CAPTURE, holding: false } }), O.siegeOrderModel({ ...GOOD.notAppliedOwed, stake: 'burnt' }), O.siegeOrderRead(GOOD.captured), { ok: false }]) {
      c = String(hand.siegeOrderView(o));
      assert.match(c, /data-siege-order="unreadable"/); assert.match(c, /読み取れませんでした。成立したとも、しなかったとも表示しません。/); assert.doesNotMatch(c, WON); assert.doesNotMatch(c, /戻りました|始まりました|始まりませんでした/);
    }
    // English: every string has its translation, with the three rules in plain words
    setLang('en');
    assert.match(view(GOOD.notAppliedSettled), /The siege did not start \(turn 41; site 3\)\. Its conditions were not met when the reserved turn was processed, or an earlier reservation became the siege\. It still counts as one of today&#39;s declarations\./);
    assert.match(view(GOOD.notAppliedSettled), /<p class="pop-line" data-siege-return="stake">Deposit: returned\.<\/p><p class="pop-line" data-siege-return="slot">Holding slot and rent: released\.<\/p>/);
    assert.match(view(GOOD.notAppliedDebt), /data-siege-return="stake">Deposit: waiting to be returned\. It is still owed to you; the settlement is not complete\.<\/p><p class="pop-line" data-siege-return="slot">Holding slot and rent: released\.<\/p>/);
    assert.doesNotMatch(view(GOOD.notAppliedDebt), /reason|host|leads|no longer/i);
    assert.match(view(GOOD.ordered), /It cannot be cancelled\./);
    for (const f of [...Object.values(GOOD), LAPSED, UNKNOWN_END, { ...LAPSED, source: 'absent' }]) view(f);
    assert.match(view(LAPSED), /The siege did not start \(site 3\)\. The reservation did not take effect because the season ended or was interrupted\./);
    assert.match(view({ ...UNKNOWN_END, source: 'absent' }), /The holding it came from no longer exists\. It is still owed to you and the settlement is not complete\. When and where it will be returned is not decided yet\./);
    assert.match(view(UNKNOWN_END), /Returns and releases take effect when a settlement is run\. It may not run automatically\./);
    for (const reason of O.SIEGE_ORDER_REASONS) assert.doesNotMatch(view({ ...GOOD.notAppliedOwed, reason }), new RegExp(`not a recorded reason\\): ${reason}<`), reason);
    String(hand.siegeOrderView({ ok: false, code: 'X' })); card(null);
    assert.deepEqual(missingKeys().filter(k => /包囲|予約|預けた資源|使用枠|宣言回数|軍勢が|都市はもう|シーズンの終わり|導出|返却|精算|シーズンの終了/.test(k)), []);
  } finally { setLang('ja'); }
});

test('on the card: the order stands with the block; a host that no longer stays is offered nothing but still told; no order, no order lines', () => {
  setLang('ja');
  try {
    const PREP = /data-act="local-conquest-prepare"/;
    let c = card(null); assert.match(c, PREP); assert.doesNotMatch(c, /data-siege-order/);
    c = card(O.siegeOrderModel(GOOD.ordered)); assert.match(c, PREP); assert.match(c, /data-siege-order="ordered"/); assert.match(c, /予約は取り消せません。/);
    // not staying (e.g. the host is gone): no rules, no button, the order's own lines only
    c = card(O.siegeOrderModel(GOOD.notAppliedOwed), { phase: 'return-pending' });
    assert.match(c, /data-local-conquest="order-only"/); assert.match(c, /data-siege-order="not_applied"/); assert.doesNotMatch(c, PREP); assert.doesNotMatch(c, /data-act=/);
    assert.equal(card(null, { phase: 'return-pending' }), '');
    assert.equal(String(hand.localConquestView({ localPlay: null }, { phase: 'resident' }, { state: idle, spent: false, other: false, order: O.siegeOrderModel(GOOD.captured) })), '', 'the ordinary page: nothing');
    // the order's lines carry no control of their own
    for (const f of Object.values(GOOD)) assert.doesNotMatch(String(hand.siegeOrderView(O.siegeOrderModel(f))), /data-act=|<button/);
  } finally { setLang('ja'); }
});
