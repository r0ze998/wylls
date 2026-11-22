// The board's English against the texts of the modules that name a key API through record.mjs (so this file is
// local-only, like the other coop tests; coop.lang.test.mjs is the part CI runs): states, outcomes, resource names,
// ④'s classes, the goal and the judges.
import test from 'node:test';
import assert from 'node:assert/strict';
import { toEnglish, JA, needsEnglish } from '../coop/tr.mjs';
import { STATE_JA } from '../coop/arrival.mjs';
import { OUTCOME_JA } from '../coop/history.mjs';
import { RESOURCE_JA } from '../coop/record.mjs';
import { deliveredText, FULFILMENT_JA } from '../coop/ws04.mjs';
import { GOALS, JUDGES } from '../coop/goal.mjs';

test('the tables of states and the board\'s goal and judges are all said in English', () => {
  for (const t of [STATE_JA, OUTCOME_JA, RESOURCE_JA, FULFILMENT_JA]) for (const v of Object.values(t)) assert.ok(!JA.test(toEnglish(v)), v);
  for (const g of Object.values(GOALS)) for (const v of [g.title, g.what]) assert.ok(!JA.test(toEnglish(v)), v);
  for (const j of Object.values(JUDGES)) for (const v of [j.label, j.means]) assert.ok(!JA.test(toEnglish(v)), v);
});

test('texts made by ④\'s classes and the judges come out in English', () => {
  const clean = s => { const en = toEnglish(s); assert.ok(!JA.test(en) && !needsEnglish(en), `${s} → ${en}`); return en; };
  assert.equal(clean(deliveredText({ state: 'delivered', delivered: { wood: 196, stone: 0 }, verification: 'RuleDerived' }, RESOURCE_JA).text), 'Arrived: Wood 196 or more · Stone 0 or more');
  assert.equal(clean(deliveredText({ state: 'moving' }, RESOURCE_JA, { wood: 200 }).text), 'On the way: Wood 200');
  assert.equal(clean(deliveredText({ state: 'moving' }, RESOURCE_JA).text), 'On the way');
  clean(deliveredText({ state: 'lost', verification: 'KnownZero', delivered: { wood: 0 } }, RESOURCE_JA).text);
  clean(deliveredText({ state: 'delivered', delivered: null, verification: 'Unverifiable', cargoLogged: { wood: 200 } }, RESOURCE_JA).text);
  clean(deliveredText({ state: 'misdirected', held: 'DestinationMismatch' }, RESOURCE_JA).text);
  for (const j of Object.values(JUDGES)) {
    for (const c of [{ perResource: { wood: 196 }, goal: GOALS['crossing-storehouse-v1'], unverified: [], nations: new Set(), vaultSeenAfter: null },
      { perResource: { wood: 200, stone: 200 }, goal: GOALS['crossing-storehouse-v1'], unverified: ['依頼した人の国が未検証', '届けた人 abcd… の国が未検証'], nations: new Set(), vaultSeenAfter: false },
      { perResource: { wood: 200, stone: 200 }, goal: GOALS['crossing-storehouse-v1'], unverified: [], nations: new Set([1]), vaultSeenAfter: true }]) {
      let v; try { v = j.judge(c); } catch { continue; }
      if (v?.why) clean(`${j.label}：${v.why}`);
    }
  }
});

test('the resource names are the ones coop.lang.test.mjs uses', () => {
  assert.deepEqual({ ...RESOURCE_JA }, { food: '食料', wood: '木材', stone: '石材', ore: '鉱石', arms: '兵器', gold: '金' });
});
