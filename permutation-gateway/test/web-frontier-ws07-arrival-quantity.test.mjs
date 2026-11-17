// ⑦'s caravan arrival display, end to end on the page's own path (Lane C, 2026-11-17). WRITTEN, NOT RUN.
// statussources.arrivalSettled (the provider's judgement) → statusview.arrivalView (the words) and returnwords.itemText
// (the away summary), for each quantity case of the existing contract: normal, not read, 0, fractions, u32 saturation,
// invalid. NOT claimed independent: statusview.mjs and returnwords.mjs load fi18n.mjs and lang.mjs, the subjects of
// refused tests. Whether and how this may run is the coordinator's decision, through the key-free guard only. No
// network, file write, key or page: plain objects in, words out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arrivalSettled, DST_HOLDING, DST_VAULT, S1_PROGRAM_VERSION } from '../../permutation-server/web/frontier/hud/statussources.mjs';
import { arrivalView } from '../../permutation-server/web/frontier/hud/statusview.mjs';
import { itemText } from '../../permutation-server/web/frontier/hud/returnwords.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';

const C = (...a) => [...a, 0, 0, 0, 0, 0, 0, 0, 0].slice(0, 8);
const U32 = 4294967295;
const rules = { programVersion: S1_PROGRAM_VERSION };
const settled = (dst, cargo, outcome = 0) => ({ outcome, dst: BigInt(dst), cargo });
const words = x => { const v = arrivalView(x); return [v.text, ...v.details].join('。'); };

test('normal: a village intake is a lower bound; a storehouse shows the record as the record', () => {
  setLang('ja');
  assert.match(words(arrivalSettled(settled(DST_HOLDING, C(400)), null, rules)), /^村に入った量：食料 400 以上/);
  const v = words(arrivalSettled(settled(DST_VAULT, C(400)), null, rules));
  assert.match(v, /^到着しましたが、入った量は確認できません（記録の積荷：食料 400）/);
  assert.doesNotMatch(v, /最大/);
});

test('0: never "なし", "最大 0" or "0 taken in"', () => {
  setLang('ja');
  assert.match(words(arrivalSettled(settled(DST_HOLDING, C(0)), null, rules)), /^村に入った量：0 以上/);
  const v = words(arrivalSettled(settled(DST_VAULT, C(0)), null, rules));
  assert.match(v, /（記録の積荷：0）/);
  const l = words(arrivalSettled(settled(DST_VAULT, C(0), 1), null, rules));
  assert.match(l, /^積荷は失われました（記録の積荷：0）/);
  const p = words({ state: 'verifiedPartial', basis: 'sentRecord', sent: C(0, 5), arrived: C(0, 4) });
  assert.match(p, /送付記録の数量：木材 5/);
  assert.match(words({ state: 'verifiedPartial', basis: 'sentRecord', sent: C(0), arrived: C(0) }), /送付記録の数量：0/);
  for (const t of [v, l]) assert.doesNotMatch(t, /なし|最大 0/);
});

test('fractions: the record drops what is under one; no upper bound is made from it', () => {
  setLang('ja');
  const v = words(arrivalSettled(settled(DST_VAULT, C(399)), null, rules));
  assert.match(v, /記録の数は 1 未満を切り捨て、大きすぎる値は上限で止まるため、入った量の上限も記録からは決まりません/);
  assert.doesNotMatch(v, /最大/);
  assert.match(words(arrivalSettled(settled(DST_HOLDING, C(399)), null, rules)), /資源ごとに 1 未満多く入っていることがあります/);
});

test('u32 saturation: shown as the record, still a lower bound for a village, never a maximum', () => {
  setLang('ja');
  assert.match(words(arrivalSettled(settled(DST_VAULT, C(U32)), null, rules)), /（記録の積荷：食料 [0-9,]+）/);
  assert.doesNotMatch(words(arrivalSettled(settled(DST_VAULT, C(U32)), null, rules)), /最大/);
  assert.match(words(arrivalSettled(settled(DST_HOLDING, C(U32)), null, rules)), /^村に入った量：食料 [0-9,]+ 以上/);
});

test('precision: below the cap "under one more"; at u32::MAX the excess is not bounded — for intake, partial and full', () => {
  setLang('ja');
  const NORMAL = /記録は 1 未満を切り捨てるので、資源ごとに 1 未満多く入っていることがあります/;
  const SATURATED = /記録は 1 未満を切り捨て、4,294,967,295 で止まります。そこに達した資源は、記録よりどれだけ多く入ったかわかりません/;
  const cases = c => [
    { state: 'verifiedIntake', intake: c, compare: 'sentUnknown' },
    { state: 'verifiedPartial', basis: 'sentRecord', sent: C(U32, 10), arrived: c },
    { state: 'verifiedFull', basis: 'sentRecord', sent: C(1), arrived: c },
  ];
  for (const x of cases(C(400, 5))) { const t = words(x); assert.match(t, NORMAL, x.state); assert.doesNotMatch(t, SATURATED, x.state); }
  for (const x of cases(C(U32, 5))) {
    const t = words(x);
    assert.match(t, SATURATED, x.state);
    assert.doesNotMatch(t, /1 未満多く/, `${x.state}: "under one more" is not said for a saturated record`);
    assert.match(t, /以上/, `${x.state}: still a lower bound`);
  }
  setLang('en');
  assert.match(words(cases(C(U32))[0]), /stop at 4,294,967,295; for a resource at that value, how much more went in is not known/);
  setLang('ja');
});

test('not read: no record, an unreadable outcome, another program: no amount is made up', () => {
  setLang('ja');
  assert.equal(arrivalView({ state: 'settledUnverified', why: 'vault' }).text, '到着しましたが、入った量は確認できません');
  assert.equal(arrivalView(arrivalSettled(settled(DST_HOLDING, C(400), 7), null, rules)).text, '決着しました。入った量はまだ確かめられていません');
  assert.equal(arrivalSettled(settled(DST_HOLDING, C(400)), null, { programVersion: 3 }).why, 'rulesUnknown');
});

test('invalid: a malformed record is not shown as an amount', () => {
  setLang('ja');
  for (const bad of [C(-1), C(Number.NaN), ['400', 0, 0, 0, 0, 0, 0, 0], [400]]) {
    assert.equal(arrivalView({ state: 'settledUnverified', why: 'vault', recorded: bad }).text, '到着しましたが、入った量は確認できません');
    assert.equal(arrivalView({ state: 'lost', recorded: bad }).text, '積荷は失われました');
    assert.equal(arrivalView({ state: 'verifiedIntake', intake: bad, compare: 'sentUnknown' }).ok, false);
  }
});

test('the away summary: an uncertain settlement is told by its outcome, never "arrival" when lost or unreadable', () => {
  setLang('ja');
  const it = facts => ({ kind: 'CARAVAN_SETTLED', tone: 'uncertain', bell: 300, facts: { cargo: C(400), ...facts } });
  assert.match(itemText(it({ delivered: true, lost: false })), /^あなたが送った隊商の到着が記録されました（ターン 300）/);
  const lost = itemText(it({ delivered: false, lost: true }));
  assert.match(lost, /^あなたが送った隊商の行き先がなくなり、積荷が失われたと記録されました（ターン 300）/);
  const unknown = itemText(it({ delivered: false, lost: false }));
  assert.match(unknown, /^あなたが送った隊商の決着が記録されました（ターン 300）。結果を記録から読めないため、着いたとも失われたとも言いません/);
  for (const t of [lost, unknown]) assert.doesNotMatch(t, /到着/);
});

test('English follows', () => {
  setLang('en');
  assert.match(words(arrivalSettled(settled(DST_VAULT, C(400)), null, rules)), /cargo on the record: /);
  assert.match(arrivalView({ state: 'lost', recorded: C(0) }).text, /^The cargo was lost \(cargo on the record: 0\)$/);
  const it = facts => ({ kind: 'CARAVAN_SETTLED', tone: 'uncertain', bell: 300, facts: { cargo: C(400), ...facts } });
  assert.match(itemText(it({ lost: true })), /logged as lost/);
  assert.match(itemText(it({})), /not said to have arrived or to be lost/);
  setLang('ja');
});
