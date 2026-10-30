// Workstream 07: the display contract of states workstreams 04 and 05 own (hud/statusview.mjs) and the slot that
// workstream 01's cooperation fills (hud/coopentry.mjs). The states' own rules are not here: these tests ask that the
// page says each state apart, says what it did not receive, and never fills it in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as SV from '../../permutation-server/web/frontier/hud/statusview.mjs';
import * as CO from '../../permutation-server/web/frontier/hud/coopentry.mjs';
import { renderS1Village } from '../../permutation-server/web/frontier/screens/s1.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';

const C = (...a) => [...a, 0, 0, 0, 0, 0, 0, 0, 0].slice(0, 8);
const jp = /[぀-ヿ一-鿿]/;

test('04 cancel: three stages said apart; a stage not received is "not received", never a stage', () => {
  setLang('ja');
  const a = SV.cancelView({ stage: 'stopNew' }), b = SV.cancelView({ stage: 'awaitSigned', signedPending: 2 }), c = SV.cancelView({ stage: 'cancelled', settled: [{ text: '木材 300 は着いています' }] });
  assert.deepEqual([a.symbol, b.symbol, c.symbol], ['‖', '⌛', '■']);
  assert.match(a.details.join(), /署名済みの要求はまだ止まっていません/, 'stopping new sends does not stop signed ones');
  assert.match(b.text, /署名済みの要求 2 件の確認を待っています/);
  assert.match(c.details.join(), /取消の前に成立した分は戻りません.*木材 300 は着いています/);
  const nosettled = SV.cancelView({ stage: 'cancelled' });
  assert.match(nosettled.details.join(), /まだ受け取っていません/, 'no "settled" is not "nothing settled"');
  assert.deepEqual(nosettled.errors, ['settled: missing']);
  assert.match(SV.cancelView({ stage: 'cancelled', settled: [] }).details.join(), /成立した分はありません/);
  const bad = SV.cancelView({ stage: 'done' });
  assert.deepEqual([bad.ok, bad.symbol, bad.errors], [false, '?', ['stage: done']]);
  assert.match(SV.cancelView({ stage: 'awaitSigned' }).text, /件数は受け取っていません/);
});

test('a caravan\'s arrival in its states: overdue is not arrived, settled-unverified shows no amount as taken in, verified part, verified all, lost', () => {
  setLang('ja');
  const o = SV.arrivalView({ state: 'overdue', bell: 292 });
  assert.deepEqual([o.key, o.symbol], ['arrival:overdue', '…']);
  assert.match(o.text, /到着予定のターン 292 を過ぎました。まだ決着していません/);
  assert.doesNotMatch([o.text, ...o.details].join(), /着きました|入りました/, 'past the turn is not arrived');
  const v = SV.arrivalView({ state: 'settledUnverified', why: 'vault', recorded: C(400) });
  assert.deepEqual([v.key, v.symbol], ['arrival:settledUnverified:vault', '?']);
  assert.match(v.text, /決着しました。入った量はまだ確かめられていません/);
  assert.match(v.details.join(), /倉庫は上限を超えた分を切り捨てます。決着の記録には元の積荷（食料 400）が載る/);
  assert.match(SV.arrivalView({ state: 'settledUnverified', why: 'rulesUnknown', recorded: C(352) }).details.join(), /このシーズンのプログラムの版では、入った量の確かめ方を確認していません/);
  const k = SV.arrivalView({ state: 'verifiedIntake', intake: C(352), compare: 'sentUnknown' });
  assert.deepEqual([k.key, k.symbol], ['arrival:verifiedIntake:sentUnknown', '○']);
  assert.match([k.text, ...k.details].join(), /村に入った量：食料 352.*送付記録を読めていないため、送った量の全部か一部かは比べられません.*数量は記録の単位です/);
  assert.equal(SV.arrivalView({ state: 'verifiedIntake', intake: C(1) }).ok, false, 'an intake says why it is not compared');
  assert.equal(SV.arrivalView({ state: 'settledUnverified' }).ok, false, 'an unverified arrival says why');
  const p = SV.arrivalView({ state: 'verifiedPartial', basis: 'sentRecord', sent: C(400), arrived: C(100) });
  assert.deepEqual([p.key, p.symbol], ['arrival:verifiedPartial', '◐']);
  assert.match(p.text, /送付記録の数量に対して一部が入りました：食料 100/);
  assert.match(p.details.join(), /送付記録の数量：食料 400.*差の理由は、記録で確かめるまで決めません/);
  assert.equal(SV.arrivalView({ state: 'verifiedPartial', basis: 'sentRecord', arrived: C(100) }).ok, false, 'a partial arrival needs what was sent');
  assert.equal(SV.arrivalView({ state: 'verifiedFull', sent: C(1), arrived: C(1) }).ok, false, 'full or partial only with its basis named');
  const f = SV.arrivalView({ state: 'verifiedFull', basis: 'sentRecord', sent: C(400), arrived: C(400), wornBps: 250 });
  assert.equal(f.symbol, '●');
  assert.match([f.text, ...f.details].join(), /送付記録の数量に対して全量が入りました：食料 400.*比べた基準は送付記録の数量です.*最初に積んだ量と経路の損失は、この記録からは確定しません.*経路の減少率 2\.5% が記されています/);
  const l = SV.arrivalView({ state: 'lost', recorded: C(400) });
  assert.deepEqual([l.symbol, l.tone], ['✕', 'loss']);
  assert.match([l.text, ...l.details].join(), /積荷は失われました：食料 400.*確定/);
  for (const old of ['unverified', 'partial', 'full']) assert.equal(SV.arrivalView({ state: old, arrived: C(1), sent: C(1) }).ok, false, `the v2 state "${old}" is gone`);
  assert.equal(SV.arrivalView({}).ok, false);
});

test('05 cost: reserved, committed, unsettled, released said apart; only "committed" is paid', () => {
  setLang('ja');
  const v = SV.COST_PHASES.map(phase => SV.costView({ phase, amounts: C(0, 50) }));
  assert.deepEqual(v.map(x => x.symbol), ['◇', '◆', '◇?', '↺']);
  assert.match(v[0].details.join(), /まだ支払っていません/);
  assert.match(v[1].details.join(), /支払いが確定しました/);
  assert.match(SV.costView({ phase: 'unsettled' }).text, /額はまだ決まっていません/);
  assert.equal(SV.costView({ phase: 'reserved' }).ok, false, 'a reservation with no amount was not received');
  assert.equal(SV.costView({ phase: 'paid' }).ok, false);
});

test('05 spendable: the stores less the costs; whether committed costs already left the stores must be said', () => {
  const have = C(100, 100);
  assert.deepEqual(SV.spendable(have, [{ phase: 'reserved', amounts: C(30) }]).errors, ['committedInHave: missing']);
  const r = SV.spendable(have, [{ phase: 'reserved', amounts: C(30) }, { phase: 'committed', amounts: C(10) }, { phase: 'released', amounts: C(50) }], { committedInHave: true });
  assert.deepEqual([r.free.slice(0, 2), r.uncertain], [[70, 100], false]);
  const r2 = SV.spendable(have, [{ phase: 'committed', amounts: C(10) }], { committedInHave: false });
  assert.deepEqual(r2.free.slice(0, 1), [90]);
  const r3 = SV.spendable(have, [{ phase: 'unsettled', amounts: C(0, 40) }, { phase: 'unsettled' }], { committedInHave: true });
  assert.deepEqual([r3.free.slice(0, 2), r3.uncertain], [[100, 60], true], 'an unsettled cost is held back at its most, and said uncertain');
});

test('05 manual: back to manual play, and the orders already signed go on', () => {
  setLang('ja');
  assert.match(SV.manualView({ signedPending: 3 }).details.join(), /すでに署名した操作 3 件は止まらずに進みます/);
  assert.match(SV.manualView({}).details.join(), /止まりません（件数は受け取っていません）/);
  assert.deepEqual(SV.manualView({}).errors, ['signedPending: missing']);
});

test('a status line says its state with a symbol and words (role=status), and has English words', () => {
  setLang('ja');
  const out = String(SV.renderStatus(SV.arrivalView({ state: 'settledUnverified', why: 'vault' })));
  assert.match(out, /role="status"/);
  assert.match(out, /aria-hidden="true">\?<\/span> <strong>決着しました。入った量はまだ確かめられていません/);
  setLang('en');
  const all = [SV.cancelView({ stage: 'stopNew' }), SV.cancelView({ stage: 'awaitSigned', signedPending: 1 }), SV.cancelView({ stage: 'cancelled', settled: [] }), SV.arrivalView({ state: 'overdue', bell: 3 }),
    ...SV.UNVERIFIED_WHY.map(why => SV.arrivalView({ state: 'settledUnverified', why, recorded: C(2) })), SV.arrivalView({ state: 'lost', recorded: C(2) }),
    SV.arrivalView({ state: 'verifiedPartial', basis: 'sentRecord', sent: C(4), arrived: C(1), wornBps: 100 }), SV.arrivalView({ state: 'verifiedFull', basis: 'sentRecord', sent: C(4), arrived: C(4) }), ...SV.COMPARE_WHY.map(compare => SV.arrivalView({ state: 'verifiedIntake', intake: C(2), compare })), ...SV.COST_PHASES.map(phase => SV.costView({ phase, amounts: C(1) })), SV.costView({ phase: 'unsettled' }),
    SV.manualView({ signedPending: 2 }), SV.manualView({}), SV.manualView({ signedPending: 0 }), SV.cancelView({})];
  for (const v of all) assert.doesNotMatch([v.text, ...v.details].join(' '), jp, `${v.key}: ${v.text}`);
  setLang('ja');
});

test('01 cooperation: with nothing registered the S1 village card is as it was; a registered entry adds one button', () => {
  setLang('ja');
  assert.equal(CO.renderCoopSlot({}), '');
  assert.equal(CO.openCoop({}, 'x'), false);
  let opened = 0, avail = false;
  const off = CO.registerCoopEntry({ id: 'n1', title: () => '国と協力する', state: () => (avail ? { available: true } : { available: false, why: '国の卓が開くのはターン 700 から' }), open: () => { opened++; } });
  const closed = String(CO.renderCoopSlot({}));
  assert.match(closed, /data-act="coop-open"[^>]*data-id="n1"[^>]*disabled/);
  assert.match(closed, /国の卓が開くのはターン 700 から/);
  assert.equal(CO.openCoop({}, 'n1'), false, 'not while it says it is not available');
  avail = true;
  assert.doesNotMatch(String(CO.renderCoopSlot({})), /disabled/);
  assert.equal(CO.openCoop({}, 'other'), false);
  assert.equal(CO.openCoop({}, 'n1'), true);
  assert.equal(opened, 1);
  off();
  assert.equal(CO.renderCoopSlot({}), '');
  assert.throws(() => CO.registerCoopEntry({ id: 'x' }), TypeError);
  CO.registerCoopEntry({ id: 'n2', title: () => 'x', state: () => { throw new Error('boom'); }, open: () => {} });
  assert.match(String(CO.renderCoopSlot({})), /理由を受け取れていません/);
  CO.registerCoopEntry({ id: 'n3', title: () => 'x', state: () => ({ available: true }), open: () => {} })();
});

test('the slot sits in the S1 village card under the nation\'s council', () => {
  const src = renderS1Village.toString();
  assert.match(src, /fold\('s1-nation'[\s\S]*renderCoopSlot\(FS\)\}<\/section>/);
});
