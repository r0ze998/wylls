// 国際供給網の試作のテスト。数え方と権限が書いたとおりに動くかの確認で、面白さの証拠ではない。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSupplyWorld, supplyDecisions, performSupply, advanceSupply, injectSupply, credits, jointStatus,
  personalStatus, nationStatus,
} from '../prototype/supply.mjs';
import { act } from '../prototype/model.mjs';
import { PERSONAL_GOALS } from '../prototype/scenario-supply.mjs';

function pick(w, me, idPrefix, labelPrefix) {
  const ds = supplyDecisions(w, me);
  const d = ds.find(x => x.id.startsWith(idPrefix));
  assert.ok(d, `${me} に「${idPrefix}」がない：${ds.map(x => x.id).join(', ')}`);
  const o = d.options.find(x => x.label.startsWith(labelPrefix));
  assert.ok(o, `${me}「${d.title}」に「${labelPrefix}」がない：${d.options.map(x => x.label).join(' / ')}`);
  const r = performSupply(w, me, o);
  assert.ok(r.ok, `${me}：${o.label}：${r.error}`);
  return r;
}

/** 作例の一巡：ナギ⇄トウ（鉱石と兵器）、リン⇄セナ（木材と兵器）、ナギ⇄リン（兵器と木材）、それぞれが使う。 */
function playChain(w) {
  pick(w, 'nagi', 'deals', 'トウ');
  pick(w, 'tou', 'offer-', '受ける');
  pick(w, 'rin', 'deals', 'セナ');
  pick(w, 'sena', 'offer-', '受ける');
  advanceSupply(w, 13);
  pick(w, 'nagi', 'deals', 'リン');
  pick(w, 'rin', 'offer-', '受ける');
  pick(w, 'tou', 'workshop', '工房を1基足す');
  advanceSupply(w, 6);
  pick(w, 'nagi', 'tier', '昇格を始める');
  pick(w, 'rin', 'train', '長槍兵100');
  advanceSupply(w, 2);
}

test('三国の採掘者・工房・中継役が、それぞれの得で組み、届いた物を使うと共同成果が達成される', () => {
  const w = createSupplyWorld();
  playChain(w);
  const st = jointStatus(w);
  assert.equal(st.met, true);
  assert.deepEqual(new Set(st.qualified), new Set(['nagi', 'tou', 'rin']));
  assert.equal(w.supply.joint.status, '達成');
  assert.equal(st.credits.nagi.per.wood.credit, 700, 'ナギ：リンから届いた木材700を、昇格に使った');
  assert.equal(st.credits.rin.per.arms.credit, 50, 'リン：セナとナギから届いた兵器50を、訓練に使った');
  assert.equal(st.credits.nagi.per.arms.credit, 0, 'ナギは兵器を受け取って別の人へ渡しただけ（通り抜けは数えない）');
});

test('共同成果・個人の評価・国の評価は別々に出る（共同成果を達成しても、個人や国の目標は別）', () => {
  const w = createSupplyWorld();
  playChain(w);
  advanceSupply(w, 40);
  assert.equal(w.supply.joint.status, '達成');
  assert.equal(personalStatus(w, 'nagi').done, true);
  assert.equal(personalStatus(w, 'tou').done, false, 'トウは鉱石が足りず、工房4基には届かない');
  assert.equal(nationStatus(w, 'A').done, false, 'A国の「兵器100を集める」は、ナギの取引とぶつかる');
});

test('届いただけでは数えない。使って初めて数える', () => {
  const w = createSupplyWorld();
  pick(w, 'nagi', 'deals', 'トウ');
  pick(w, 'tou', 'offer-', '受ける');
  advanceSupply(w, 13);
  pick(w, 'nagi', 'deals', 'リン');
  pick(w, 'rin', 'offer-', '受ける');
  advanceSupply(w, 6);
  assert.equal(w.stock.nagi.wood, 1000);
  assert.equal(credits(w).nagi.per.wood.credit, 0, '木材は届いたが、まだ使っていない');
  pick(w, 'nagi', 'tier', '昇格を始める');
  assert.equal(credits(w).nagi.per.wood.credit, 700);
});

test('往復と回し合いは数えない（送った量や回数では稼げない）', () => {
  const w = createSupplyWorld();
  assert.ok(act(w, 'tou', 'gift', { to: 'nagi', resource: 'wood', qty: 700 }).ok);
  advanceSupply(w, 13);
  assert.ok(act(w, 'nagi', 'gift', { to: 'tou', resource: 'wood', qty: 700 }).ok);
  advanceSupply(w, 13);
  assert.ok(act(w, 'tou', 'gift', { to: 'nagi', resource: 'wood', qty: 700 }).ok);
  advanceSupply(w, 13);
  pick(w, 'nagi', 'tier', '昇格を始める');
  const c = credits(w);
  assert.equal(c.nagi.per.wood.received, 1400);
  assert.equal(c.nagi.per.wood.sent, 700);
  assert.equal(c.nagi.per.wood.credit, 700, '正味で受け取った700までしか数えない（1400ではない）');
  assert.equal(c.tou.per.wood.credit, 0, 'トウは送り返された木材を使っていない');
});

test('④で確かめられていない到着は、共同成果に数えない。確かめられたら数える', () => {
  const w = createSupplyWorld();
  pick(w, 'rin', 'deals', 'セナ');
  pick(w, 'sena', 'offer-', '受ける');
  advanceSupply(w, 13);
  const s = Object.values(w.shipments).find(x => x.owner === 'sena' && x.resource === 'arms');
  assert.equal(s.state, '到着済み');
  assert.ok(injectSupply(w, 'unverified', { shipment: s.id }).ok);
  w.stock.rin.arms += 30;   // 試験のため、リンが別に兵器30を持っていたとする（他人から届いた物ではない）
  pick(w, 'rin', 'train', '長槍兵100');
  assert.equal(credits(w).rin.per.arms.credit, 0, '未検証の兵器20は、使っても数えない');
  assert.equal(credits(w).rin.per.arms.unverified, 20);
  assert.ok(injectSupply(w, 'verify').ok);
  assert.equal(credits(w).rin.per.arms.credit, 20);
});

test('同じ人が動かす複数の村は、共同成果の人数で1人と数える（複数アカウント）', () => {
  const w = createSupplyWorld();
  w.members.rin.controller = 'p-nagi';
  playChain(w);
  const st = jointStatus(w);
  assert.equal(st.people, 2);
  assert.equal(st.met, false);
});

test('②の範囲：素材と生産済みの兵器の交換だけ。素材どうし・兵器どうしは断る', () => {
  const w = createSupplyWorld();
  for (const [give, want] of [[{ res: 'ore', qty: 100 }, { res: 'wood', qty: 100 }], [{ res: 'arms', qty: 1 }, { res: 'arms', qty: 1 }]]) {
    const before = JSON.stringify(w);
    const r = act(w, 'nagi', 'offerExchange', { to: 'tou', give, want });
    assert.equal(r.ok, false);
    assert.match(r.error, /未実装の契約/);
    assert.equal(JSON.stringify(w), before);
  }
  const closed = supplyDecisions(w, 'nagi').find(d => d.id === 'deals').options.filter(o => o.enabled === false && !o.act);
  assert.ok(closed.some(o => /貸出/.test(o.reason)), '工房を借りる（加工の貸出）は閉じていると理由つきで出る');
  assert.ok(closed.some(o => /素材どうし/.test(o.reason)));
});

test('交換は両方の同意で、受けた時点で両方から引く。片方が足りなければ何も変わらない', () => {
  const w = createSupplyWorld();
  const { offer } = act(w, 'rin', 'offerExchange', { to: 'tou', give: { res: 'food', qty: 200 }, want: { res: 'arms', qty: 20 } });
  w.stock.tou.arms = 10;
  const before = JSON.stringify(w);
  assert.equal(act(w, 'tou', 'answerExchange', { offer, accept: true }).ok, false);
  assert.equal(JSON.stringify(w), before);
  w.stock.tou.arms = 30;
  assert.ok(act(w, 'tou', 'answerExchange', { offer, accept: true }).ok);
  assert.equal(w.stock.rin.food, 600);
  assert.equal(w.stock.tou.arms, 10);
  assert.equal(act(w, 'nagi', 'answerExchange', { offer, accept: true }).ok, false, '自分あてでない申し出は受けられない');
});

test('条件の変更：トウが断って条件を変えて返す。成立済みの交換は変わらない', () => {
  const w = createSupplyWorld();
  pick(w, 'rin', 'deals', 'トウ');
  pick(w, 'nagi', 'deals', 'トウ');
  pick(w, 'tou', 'offer-', '受ける');   // 先に来たリンの申し出（兵器20）を受ける
  const legs = Object.values(w.shipments).map(s => [s.id, s.qty, s.eta]);
  assert.ok(injectSupply(w, 'terms').ok);
  assert.deepEqual(Object.values(w.shipments).map(s => [s.id, s.qty, s.eta]), legs);
  const counter = Object.values(w.offers).find(o => o.from === 'tou' && o.to === 'nagi');
  assert.ok(counter, 'ナギに条件を変えた申し出が返る');
  assert.deepEqual([counter.give.qty, counter.want.qty], [10, 60], '手元に残った兵器10だけを、元の1.5倍の割合（鉱石60）で');
  assert.ok(supplyDecisions(w, 'nagi').some(d => d.id.startsWith('offer-')), 'ナギは受けるか断るかを選び直せる');
});

test('途中で退出：リンが抜けても成立済みの荷車は届き、他の人には別の相手が残る', () => {
  const w = createSupplyWorld();
  pick(w, 'rin', 'deals', 'セナ');
  pick(w, 'sena', 'offer-', '受ける');
  pick(w, 'nagi', 'deals', 'トウ');
  assert.ok(injectSupply(w, 'leave').ok);
  advanceSupply(w, 13);
  assert.ok(Object.values(w.shipments).filter(s => s.owner === 'sena' || s.owner === 'rin').every(s => s.state === '到着済み'));
  const nagiDeals = supplyDecisions(w, 'nagi').find(d => d.id === 'deals');
  assert.ok(!nagiDeals || !nagiDeals.options.some(o => o.label.startsWith('リン')), '抜けた人への申し出は出ない');
  assert.ok(supplyDecisions(w, 'tou').some(d => d.id.startsWith('offer-')), 'トウにはナギの申し出が残る');
});

test('施設を失う：トウの工房が奪われると、工房の目標は止まり、リンは別の工房（セナ）と組める', () => {
  const w = createSupplyWorld();
  assert.ok(injectSupply(w, 'facility').ok);
  assert.match(personalStatus(w, 'tou').progress, /奪われた/);
  assert.ok(!supplyDecisions(w, 'tou').some(d => d.id === 'workshop'));
  assert.ok(supplyDecisions(w, 'rin').find(d => d.id === 'deals').options.some(o => o.label.startsWith('セナ') && o.enabled !== false), 'リンは別の工房（セナ）と組める');
});

test('一人が遅れる：届くまで共同成果は達成されない', () => {
  const w = createSupplyWorld();
  pick(w, 'nagi', 'deals', 'トウ');
  pick(w, 'tou', 'offer-', '受ける');
  assert.ok(injectSupply(w, 'delay').ok);
  advanceSupply(w, 13);
  assert.ok(Object.values(w.shipments).some(s => s.state === '輸送中'), '遅れた荷車はまだ着いていない');
});

test('国の頼みに応じると、本人の判断として自分の申し出を取り下げる。在庫は動かない', () => {
  const w = createSupplyWorld();
  w.stock.nagi.arms = 30;
  pick(w, 'nagi', 'deals', 'リン');
  const stock = JSON.stringify(w.stock);
  const d = supplyDecisions(w, 'nagi').find(x => x.id === 'nation-A');
  assert.ok(d);
  assert.match(d.why, /国はあなたの物を動かせない/);
  pick(w, 'nagi', 'nation-A', '国の目標を優先する');
  assert.equal(Object.values(w.offers).find(o => o.from === 'nagi' && o.to === 'rin').status, '取り下げ');
  assert.equal(JSON.stringify(w.stock), stock);
});

test('軍事に参加しない人にも目標がある（ナギ・トウの目標は軍事でなく、ナギは昇格で達成できる）', () => {
  assert.equal(PERSONAL_GOALS.nagi.military, false);
  assert.equal(PERSONAL_GOALS.tou.military, false);
  const w = createSupplyWorld();
  playChain(w);
  advanceSupply(w, 40);
  assert.equal(personalStatus(w, 'nagi').done, true);
  assert.equal(Object.values(w.marches).length, 0, '軍は一度も出ていない');
});

test('協力しない選択（自給）にも結果が書いてある', () => {
  const w = createSupplyWorld();
  for (const me of ['nagi', 'tou', 'rin']) {
    const d = supplyDecisions(w, me).find(x => x.id === 'deals');
    const self = d.options.find(o => o.label.startsWith('今は組まない'));
    assert.ok(self && self.consequence.length > 8, me);
  }
});

test('期限までに達成されなければ「期限切れ」として一区切りになる', () => {
  const w = createSupplyWorld();
  advanceSupply(w, 100);
  assert.equal(w.supply.joint.status, '期限切れ');
});

test('時間順の記録：ターン19 と最終の数（15章 15-2 の表と同じ）', () => {
  const w = createSupplyWorld();
  playChain(w);   // ターン21 で終わる
  // ターン19 の記録（共同成果の一区切り）
  assert.equal(w.supply.joint.achievedAt, 19);
  assert.deepEqual(w.supply.joint.qualified, ['nagi', 'tou', 'rin']);
  const at21 = credits(w);
  assert.equal(at21.tou.per.ore.credit, 78, 'ターン21：トウの鉱石は 70（ターン19）＋ 4×2');
  assert.equal(nationStatus(w, 'A').progress, 'A国の村の兵器 21／100');
  advanceSupply(w, 38);   // ターン59
  const end = credits(w);
  assert.equal(end.nagi.total, 700);
  assert.equal(end.tou.per.ore.credit, 120, '受け取った鉱石120を使い切る');
  assert.equal(end.tou.per.ore.ownUsed, 40, '自分の鉱石40は、受け取る前と工房の建設で先に使った');
  assert.equal(end.rin.total, 50);
  assert.equal(end.sena.total, 0, 'セナは木材100を受け取ったが、自分の木材で足りたので数えない');
  assert.equal(end.sena.per.wood.received, 100);
  assert.equal(nationStatus(w, 'A').progress, 'A国の村の兵器 50／100', 'A国の数は時点で変わる');
  assert.equal(w.members.nagi.tier, '町');
  assert.deepEqual(w.stock.tou, { food: 410, wood: 1770, stone: 280, ore: 0, arms: 50, gold: 200 });
});

test('時間順の記録：ターン19 のトウは 70（受け取る前に自分の鉱石を工房で使っていた）', () => {
  const w = createSupplyWorld();
  pick(w, 'nagi', 'deals', 'トウ');
  pick(w, 'tou', 'offer-', '受ける');
  pick(w, 'rin', 'deals', 'セナ');
  pick(w, 'sena', 'offer-', '受ける');
  advanceSupply(w, 13);
  assert.equal(w.stock.tou.ore, 134, '自分の40のうち26を工房で使い、120が着いた');
  pick(w, 'nagi', 'deals', 'リン');
  pick(w, 'rin', 'offer-', '受ける');
  pick(w, 'tou', 'workshop', '工房を1基足す');
  assert.equal(credits(w).tou.per.ore.credit, 46, '建設の鉱石60のうち、自分の14を先に使い、46');
  advanceSupply(w, 6);
  assert.equal(credits(w).tou.per.ore.credit, 70);
});
