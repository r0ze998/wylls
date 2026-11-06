// 独立レビュー（2026-10-30、供給網）で再現された不具合と、数え方の穴が起きないことを確かめる。番号はレビューの番号。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSupplyWorld, supplyDecisions, performSupply, advanceSupply, injectSupply, credits, jointStatus } from '../prototype/supply.mjs';
import { act, advance } from '../prototype/model.mjs';
import { JOINT } from '../prototype/scenario-supply.mjs';

const offerTo = (w, me, from) => supplyDecisions(w, me).find(d => d.id.startsWith('offer-') && d.title.startsWith(w.members[from].name));
const accept = d => d.options.find(o => o.label === '受ける');

test('1：申し出た人が不在、または在庫がもう足りないとき、「受ける」は理由つきで閉じる', () => {
  const w = createSupplyWorld();
  act(w, 'tou', 'offerExchange', { to: 'kai', give: { res: 'arms', qty: 20 }, want: { res: 'ore', qty: 200 } });
  injectSupply(w, 'absent');
  const a = accept(offerTo(w, 'kai', 'tou'));
  assert.equal(a.enabled, false);
  assert.match(a.reason, /不在/);
  const w2 = createSupplyWorld();
  act(w2, 'tou', 'offerExchange', { to: 'kai', give: { res: 'arms', qty: 20 }, want: { res: 'ore', qty: 200 } });
  act(w2, 'tou', 'offerExchange', { to: 'sena', give: { res: 'arms', qty: 20 }, want: { res: 'ore', qty: 100 } });
  assert.ok(performSupply(w2, 'sena', accept(offerTo(w2, 'sena', 'tou'))).ok);
  const b = accept(offerTo(w2, 'kai', 'tou'));
  assert.equal(b.enabled, false);
  assert.match(b.reason, /もう足りない/);
});

test('2：期限の過ぎた申し出は断れる。時間が進むと「期限切れ」になり、見本の申し出がまた出る', () => {
  const w = createSupplyWorld();
  act(w, 'nagi', 'offerExchange', { to: 'tou', give: { res: 'ore', qty: 120 }, want: { res: 'arms', qty: 30 }, until: 3 });
  advance(w, 5);
  const d = offerTo(w, 'tou', 'nagi');
  assert.ok(performSupply(w, 'tou', d.options.find(o => o.label === '断る')).ok);
  const w2 = createSupplyWorld();
  act(w2, 'nagi', 'offerExchange', { to: 'tou', give: { res: 'ore', qty: 120 }, want: { res: 'arms', qty: 30 }, until: 3 });
  advanceSupply(w2, 5);
  assert.equal(Object.values(w2.offers)[0].status, '期限切れ');
  assert.ok(supplyDecisions(w2, 'nagi').find(x => x.id === 'deals').options.some(o => o.label.startsWith('トウ')));
});

test('3：不在の人の「抜ける」「国の頼み」は本人以外にできない。他国の頼み・二度目は断る', () => {
  const w = createSupplyWorld();
  act(w, 'nagi', 'offerExchange', { to: 'tou', give: { res: 'ore', qty: 120 }, want: { res: 'arms', qty: 30 } });
  injectSupply(w, 'absent');
  const before = JSON.stringify(w);
  assert.equal(performSupply(w, 'tou', { act: 'leaveSupply', enabled: true }).ok, false);
  assert.equal(performSupply(w, 'tou', { act: 'ackNation', args: { nation: 'B', follow: true }, enabled: true }).ok, false);
  assert.equal(JSON.stringify(w), before);
  const w2 = createSupplyWorld();
  assert.equal(performSupply(w2, 'tou', { act: 'ackNation', args: { nation: 'A', follow: true }, enabled: true }).ok, false);
  assert.ok(performSupply(w2, 'tou', { act: 'ackNation', args: { nation: 'B', follow: false }, enabled: true }).ok);
  assert.equal(performSupply(w2, 'tou', { act: 'ackNation', args: { nation: 'B', follow: true }, enabled: true }).ok, false);
  assert.ok(performSupply(w2, 'rin', { act: 'leaveSupply', enabled: true }).ok);
  assert.equal(performSupply(w2, 'rin', { act: 'leaveSupply', enabled: true }).ok, false);
});

test('4：「戻る」は、その人を戻す', () => {
  const w = createSupplyWorld();
  w.members.nagi.present = false;
  injectSupply(w, 'absent');
  const d = supplyDecisions(w, 'tou')[0];
  assert.ok(performSupply(w, 'tou', d.options[0]).ok);
  assert.equal(w.members.tou.present, true);
  assert.equal(w.members.nagi.present, false);
});

test('5：抜けた人は、申し出ることも受けることもできない', () => {
  const w = createSupplyWorld();
  performSupply(w, 'nagi', { act: 'leaveSupply', enabled: true });
  assert.equal(act(w, 'nagi', 'offerExchange', { to: 'tou', give: { res: 'ore', qty: 10 }, want: { res: 'arms', qty: 1 } }).ok, false);
  assert.equal(act(w, 'tou', 'offerExchange', { to: 'nagi', give: { res: 'arms', qty: 1 }, want: { res: 'ore', qty: 10 } }).ok, false);
});

test('6：期限を過ぎてから条件を満たしても、達成とは記録しない', () => {
  const w = createSupplyWorld();
  // 期限の後まで、供給網の記録を通さずに時間を進め、その間に三国の交換と消費を済ませる
  advance(w, JOINT.deadline + 1);
  const x = act(w, 'nagi', 'offerExchange', { to: 'tou', give: { res: 'ore', qty: 120 }, want: { res: 'arms', qty: 30 } });
  act(w, 'tou', 'answerExchange', { offer: x.offer, accept: true });
  const y = act(w, 'rin', 'offerExchange', { to: 'sena', give: { res: 'wood', qty: 100 }, want: { res: 'arms', qty: 20 } });
  act(w, 'sena', 'answerExchange', { offer: y.offer, accept: true });
  advance(w, 13);
  const z = act(w, 'nagi', 'offerExchange', { to: 'rin', give: { res: 'arms', qty: 30 }, want: { res: 'wood', qty: 700 } });
  act(w, 'rin', 'answerExchange', { offer: z.offer, accept: true });
  act(w, 'tou', 'addWorkshop');
  advance(w, 6);
  act(w, 'nagi', 'tierUp');
  act(w, 'rin', 'trainPikemen', { n: 100 });
  assert.equal(jointStatus(w).met, true, '条件そのものは満たしている');
  advanceSupply(w, 1);
  assert.equal(w.supply.joint.status, '期限切れ');
});

test('7：申し出の期限は整数で、今より後', () => {
  const w = createSupplyWorld();
  for (const until of ['never', 0, -1, 1.5]) {
    assert.equal(act(w, 'nagi', 'offerExchange', { to: 'tou', give: { res: 'ore', qty: 10 }, want: { res: 'arms', qty: 1 }, until }).ok, false, String(until));
  }
});

test('A：3人が別々の資源を回し合い、自分の在庫で使っても、共同成果にはならない（自分の物から先に使う）', () => {
  const w = createSupplyWorld();
  act(w, 'nagi', 'gift', { to: 'tou', resource: 'stone', qty: 50 });
  act(w, 'tou', 'gift', { to: 'rin', resource: 'wood', qty: 50 });
  act(w, 'rin', 'gift', { to: 'nagi', resource: 'food', qty: 50 });
  advanceSupply(w, 13);
  act(w, 'nagi', 'train', { n: 50 });
  act(w, 'tou', 'build', { kind: '倉', at: 'v:tou' });
  act(w, 'rin', 'build', { kind: '倉', at: 'v:rin' });
  advanceSupply(w, 1);
  const c = credits(w);
  assert.equal(c.nagi.total + c.tou.total + c.rin.total, 0);
  assert.equal(jointStatus(w).met, false);
});

test('B：受け取る前の消費は数えない', () => {
  const w = createSupplyWorld();
  act(w, 'rin', 'train', { n: 60 });
  act(w, 'nagi', 'gift', { to: 'rin', resource: 'food', qty: 60 });
  advanceSupply(w, 6);
  assert.equal(credits(w).rin.per.food.credit, 0);
});

test('C：兵器1を挟んだ素材の入れ替えでも、自分の物で足りる分は数えない', () => {
  const w = createSupplyWorld();
  const x = act(w, 'sena', 'offerExchange', { to: 'kai', give: { res: 'arms', qty: 1 }, want: { res: 'ore', qty: 500 } });
  act(w, 'kai', 'answerExchange', { offer: x.offer, accept: true });
  advanceSupply(w, 19);
  const y = act(w, 'kai', 'offerExchange', { to: 'sena', give: { res: 'arms', qty: 1 }, want: { res: 'food', qty: 250 } });
  act(w, 'sena', 'answerExchange', { offer: y.offer, accept: true });
  advanceSupply(w, 19);
  act(w, 'kai', 'train', { n: 250 });   // カイの食料は自分の300で足りる
  assert.equal(credits(w).kai.per.food.credit, 0);
});

test('受け取った物は、自分の物で足りなかった分だけ数える（作例のナギ：自分の木材300を先に使い、残り700）', () => {
  const w = createSupplyWorld();
  act(w, 'rin', 'gift', { to: 'nagi', resource: 'wood', qty: 700 });
  advanceSupply(w, 6);
  act(w, 'nagi', 'tierUp');
  const p = credits(w).nagi.per.wood;
  assert.deepEqual([p.used, p.ownUsed, p.credit], [1000, 300, 700]);
});
