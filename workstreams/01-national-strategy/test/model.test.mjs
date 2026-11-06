// 国の卓の試作のルールのテスト。node --test workstreams/01-national-strategy/test/
//
// これは試作のルールが「書いたとおりに動く」ことを確かめるだけで、遊びが面白いことの証拠ではない。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { choose, playToReady } from './helpers.mjs';
import {
  createWorld, act, advance, inject, needProgress, readiness, custody, decisionsFor, perform, inventory,
  pledgeTotals, cosignCount,
} from '../prototype/model.mjs';

const PLAYERS = ['kei', 'mira', 'sota'];
const nonWait = d => d.options.filter(o => o.enabled !== false && !o.wait);

test('最初から：提案は賛同3で採択され、賛同は何かを出す約束にならない', () => {
  const w = createWorld('start');
  assert.equal(w.goals.outpost.status, '提案中');
  choose(w, 'mira', 'cosign-', '賛同する');
  assert.equal(w.goals.outpost.status, '提案中');
  choose(w, 'sota', 'cosign-', '賛同する');
  assert.equal(w.goals.outpost.status, '準備中');
  assert.equal(Object.values(w.pledges).length, 0, '賛同だけでは申し出は生まれない');
});

test('3人が違う役割で参加して、期限までに拠点が成立する', () => {
  const w = createWorld('preparing');
  playToReady(w);
  const g = w.goals.outpost;
  assert.equal(g.status, '成立', w.log.map(l => `${l.turn} ${l.text}`).join('\n'));
  assert.ok(g.readyAt <= g.deadline);
  const roles = new Set(Object.values(w.pledges).filter(p => PLAYERS.includes(p.provider)).map(p => `${p.provider}:${p.need}`));
  assert.ok([...roles].some(r => r.startsWith('mira:arms')));
  assert.ok([...roles].some(r => r.startsWith('sota:food')));
  assert.ok([...roles].some(r => r.startsWith('kei:garrison')));
});

test('送信済みは到着済みに数えない。到着済みだけが進み具合になる', () => {
  const w = createWorld('start');
  act(w, 'mira', 'cosign', { goal: 'outpost' });
  act(w, 'sota', 'cosign', { goal: 'outpost' });
  const { pledge } = act(w, 'mira', 'pledge', { goal: 'outpost', need: 'stone', qty: 500 });
  const { shipment } = act(w, 'mira', 'dispatch', { pledge, qty: 500 });
  let pr = needProgress(w, 'outpost', 'stone');
  assert.equal(w.shipments[shipment].state, '送信済み');
  assert.equal(pr.arrived, 0);
  assert.equal(pr.inTransit, 500);
  assert.equal(pr.satisfied, false);
  advance(w, 1);
  assert.equal(w.shipments[shipment].state, '輸送中');
  assert.equal(needProgress(w, 'outpost', 'stone').arrived, 0);
  advance(w, w.shipments[shipment].eta - w.turn);
  pr = needProgress(w, 'outpost', 'stone');
  assert.equal(w.shipments[shipment].state, '到着済み');
  assert.equal(pr.arrived, 500);
  assert.equal(pr.satisfied, true);
  assert.equal(readiness(w, 'outpost').ready, false, '一つの必要がそろっても目標は成立しない');
});

test('送信が確定しなければ、荷は送り主の手元に戻り、進み具合にも数えない', () => {
  const w = createWorld('start');
  const { pledge } = act(w, 'mira', 'pledge', { goal: 'outpost', need: 'stone', qty: 300 });
  const before = w.stock.mira.stone;
  act(w, 'mira', 'dispatch', { pledge, qty: 300 });
  assert.equal(w.stock.mira.stone, before - 300);
  assert.ok(inject(w, 'txfail', {}).ok);
  assert.equal(w.stock.mira.stone, before);
  assert.equal(needProgress(w, 'outpost', 'stone').inTransit, 0);
  assert.equal(w.pledges[pledge].status, '申し出');
});

test('提供する人・持ち主・使う人が、荷の段階ごとにはっきりしている', () => {
  const w = createWorld('preparing');
  const stone = Object.values(w.shipments).find(s => s.resource === 'stone');
  let c = custody(w, stone.id);
  assert.deepEqual([c.provider, c.ownerNow, c.ownerAfter, c.user], ['mira', 'mira', 'kei', 'kei']);
  assert.equal(c.method, '贈る');
  assert.equal(c.transfersOwnership, true);
  advance(w, stone.eta - w.turn);
  c = custody(w, stone.id);
  assert.equal(c.ownerNow, 'kei', '着いたら受け取った人の物');
  // 拠点の倉：ソウタが自分の倉に置くなら、持ち主は最後までソウタ。使う人も倉の持ち主
  advance(w, 3);
  const food = Object.values(w.pledges).find(p => p.provider === 'sota' && p.need === 'food');
  c = custody(w, food.id);
  assert.deepEqual([c.provider, c.ownerAfter, c.user, c.method], ['sota', 'sota', 'sota', '自分の倉に置く']);
  // ハルが同じ倉へ出すなら「倉の持ち主に贈る」で、着いたらソウタの物
  const r = act(w, 'haru', 'pledge', { goal: 'outpost', need: 'food', qty: 100 });
  c = custody(w, r.pledge);
  assert.deepEqual([c.provider, c.ownerNow, c.ownerAfter, c.method], ['haru', 'haru', 'sota', '倉の持ち主に贈る']);
  // 「預ける（持ち主のまま他人が使う）」は使用権が要るので、S1 では断られる
  const x = act(w, 'mira', 'pledge', { goal: 'outpost', need: 'food', qty: 50, method: '預ける' });
  assert.equal(x.ok, false);
  assert.match(x.error, /使用権/);
});

test('提案者・調整役でも、他人の物は動かせない', () => {
  const w = createWorld('preparing');
  const p = Object.values(w.pledges).find(x => x.provider === 'sota' && x.need === 'food');
  const r = act(w, 'kei', 'dispatch', { pledge: p.id, qty: 100 });
  assert.equal(r.ok, false);
  assert.match(r.error, /持ち主/);
  const g = act(w, 'mira', 'garrison', { n: 10 });
  assert.equal(g.ok, false, '砦の持ち主でない人は砦に兵を置けない（S1 の FortGarrison）');
  const c = act(w, 'mira', 'pledge', { goal: 'outpost', need: 'garrison', qty: 50 });
  assert.equal(c.ok, false);
  assert.match(c.error, /砦の持ち主/);
});

test('試作では国の共有資産を作らない（範囲の限定）。物の総量は、工房・建設・訓練の出入りの他は保存される', () => {
  const w = createWorld('preparing');
  assert.equal(w.nation.stock, undefined);
  assert.equal(w.nation.treasury, undefined);
  const before = inventory(w, 'food').total;
  act(w, 'haru', 'pledge', { goal: 'outpost', need: 'food', qty: 100 });
  advance(w, 3);
  const p = Object.values(w.pledges).find(x => x.provider === 'haru');
  act(w, 'haru', 'dispatch', { pledge: p.id, qty: 100 });
  advance(w, 20);
  assert.equal(inventory(w, 'food').total, before, '食料は誰かの村・倉・荷車にあるか、失われたと記録される');
});

test('ターンを何度進めても、軍は自動で出発しない', () => {
  const w = createWorld('preparing');
  playToReady(w);
  assert.equal(w.goals.outpost.status, '成立');
  const marches = Object.values(w.marches).filter(m => m.kind !== 'garrison').length;
  const fort = Object.values(w.facilities).find(f => f.kind === '砦');
  const troops = fort.troops;
  advance(w, 200);
  assert.equal(Object.values(w.marches).filter(m => m.kind !== 'garrison').length, marches);
  assert.equal(fort.troops, troops);
  const d = decisionsFor(w, 'kei').find(x => x.id.startsWith('after-'));
  assert.ok(d, '成立のあとも、軍をどうするかは砦の持ち主の判断として出る');
  assert.match(d.why, /自動では出ない/);
});

test('物流の遅延：3人とも「待つ」以外に選べることがあり、その結果が書いてある', () => {
  const w = createWorld('preparing');
  advance(w, 3);
  choose(w, 'sota', 'send-', '400 を送る');
  const sotaShip = Object.values(w.shipments).find(s => s.owner === 'sota');
  const r = inject(w, 'delay', { shipment: sotaShip.id, turns: 40 });
  assert.ok(r.ok);
  assert.equal(w.shipments[r.shipment].owner, 'sota');
  advance(w, 1);
  for (const me of PLAYERS) {
    const ds = decisionsFor(w, me);
    const choices = ds.flatMap(nonWait);
    assert.ok(choices.length > 0, `${me} に待つ以外の選択がない`);
    for (const o of choices) assert.ok(o.consequence && o.consequence.length > 4, `${me}：${o.label} に結果の説明がない`);
  }
  const kei = decisionsFor(w, 'kei').find(d => d.id.startsWith('risk-'));
  assert.ok(kei, '調整役に「期限にそろわない」が出る');
  assert.match(kei.why, /食料/);
  assert.ok(decisionsFor(w, 'sota').some(d => d.id.startsWith('delay-')), '荷の持ち主にも遅れが知らされる');
  // 選び直し：調整役がハルに頼み、ハルが受けて送れば、遅れた荷を待たずに期限に間に合う
  choose(w, 'kei', 'risk-', 'ハルに頼む');
  choose(w, 'haru', 'req-', '受ける');
  choose(w, 'haru', 'send-', '');
  const pr = needProgress(w, 'outpost', 'food');
  assert.ok(pr.onTime >= 400, `ハルの食料で間に合う見込み：${JSON.stringify(pr)}`);
});

test('参加者の退出：ミラが抜けても、輸送中の荷は届き、残りの人に次の選択がある', () => {
  const w = createWorld('preparing');
  const arms = Object.values(w.shipments).find(s => s.resource === 'arms');
  assert.ok(inject(w, 'withdraw', { member: 'mira' }).ok);
  assert.ok(Object.values(w.pledges).filter(p => p.provider === 'mira').every(p => p.status === '取り下げ' || p.status === '発送済み'));
  advance(w, arms.eta - w.turn);
  assert.equal(w.shipments[arms.id].state, '到着済み', '抜けても、送った荷は行き先に届く');
  assert.equal(custody(w, arms.id).ownerNow, 'kei');
  for (const me of ['kei', 'sota']) assert.ok(decisionsFor(w, me).flatMap(nonWait).length > 0, `${me} に待つ以外の選択がない`);
  assert.ok(decisionsFor(w, 'mira').flatMap(nonWait).length > 0, '抜けた人も、また手伝うかを選べる');
  const risk = decisionsFor(w, 'kei').find(d => d.id.startsWith('risk-'));
  assert.ok(risk && /兵器/.test(risk.why), '兵器の不足（10）が調整役に見える');
  choose(w, 'kei', 'risk-', 'ハルに頼む');
  choose(w, 'haru', 'req-', '受ける');
  assert.equal(Object.values(w.pledges).find(p => p.provider === 'haru' && p.need === 'arms').status, '申し出');
});

test('代替施設への切り替え：工房を失ったミラは、鉱石をハルへ贈り、ハルが自分の工房で作って送る', () => {
  const w = createWorld('preparing');
  inject(w, 'facility', { facility: 'ws-mira' });
  const lost = decisionsFor(w, 'mira').find(d => d.id.startsWith('lost-'));
  assert.ok(lost, '工房を失った判断が出る');
  assert.ok(lost.options.some(o => o.label.includes('借りて') && o.enabled === false && /使用権/.test(o.reason)), '他人の工房を借りる道は、使用権がないので閉じていると明示される');
  choose(w, 'mira', 'lost-', '鉱石 ');
  choose(w, 'mira', 'lost-', 'ハルに兵器づくりを頼む');
  const ore = Object.values(w.shipments).find(s => s.resource === 'ore');
  assert.deepEqual([custody(w, ore.id).ownerNow, custody(w, ore.id).ownerAfter], ['mira', 'haru']);
  choose(w, 'haru', 'req-', '受ける');
  const hp = Object.values(w.pledges).find(p => p.provider === 'haru' && p.need === 'arms');
  advance(w, ore.eta - w.turn + 1);
  assert.equal(custody(w, ore.id).ownerNow, 'haru');
  for (let i = 0; i < 30 && hp.status === '準備中'; i++) advance(w, 1);
  assert.equal(hp.status, '申し出', 'ハルの工房で必要な兵器がそろう');
  choose(w, 'haru', 'send-', '');
  const s = Object.values(w.shipments).find(x => x.pledge === hp.id);
  assert.deepEqual([custody(w, s.id).provider, custody(w, s.id).ownerAfter], ['haru', 'kei'], '作ったのも送るのもハル。着いたらケイの物');
});

test('方針の対立（構えの投票）：可決すると目標の前提が変わり、調整役と参加者が選び直す', () => {
  const w = createWorld('preparing');
  const { vote } = inject(w, 'stance', {});
  choose(w, 'mira', 'vote-', '賛成');
  choose(w, 'kei', 'vote-', '反対');
  advance(w, 6);
  assert.equal(w.votes[vote].status, '可決', '賛成3（ユキ・リオ・ミラ）＞反対1、定足数3');
  assert.equal(w.nation.stance.north, 'pass');
  const g = w.goals.outpost;
  assert.ok(g.conflict);
  const c = decisionsFor(w, 'kei').find(d => d.id.startsWith('conflict-'));
  assert.ok(c && nonWait(c).length >= 2);
  assert.ok(decisionsFor(w, 'sota').some(d => d.id.startsWith('conflict-m-')), '参加者にも前提の変化が知らされる');
  choose(w, 'kei', 'conflict-', '目的を「交易の中継拠点」に変える');
  assert.equal(g.version, 2);
  const waiting = Object.values(w.pledges).filter(p => p.status === '再確認待ち');
  assert.ok(waiting.length > 0, '未発送の申し出は再確認待ちになる');
  assert.equal(needProgress(w, 'outpost', 'food').pledged, 0, '再確認待ちは数えない');
  choose(w, 'sota', 'reconfirm-', '続ける');
  assert.equal(needProgress(w, 'outpost', 'food').pledged, 400);
});

test('方針の対立（構えの投票）：賛成が定足数に届かなければ否決で、前提は変わらない', () => {
  const w = createWorld('preparing');
  const { vote } = inject(w, 'stance', {});
  choose(w, 'kei', 'vote-', '反対');
  advance(w, 6);
  assert.equal(w.votes[vote].status, '否決');
  assert.equal(w.nation.stance.north, 'war');
  assert.equal(w.goals.outpost.conflict, null);
});

test('方針の対立（競合する目標）：兵器の持ち主が行き先を決め、申し出の合計が手元を超えると準備中になる', () => {
  const w = createWorld('preparing');
  inject(w, 'rival', {});
  assert.equal(w.goals.eastsiege.status, '提案中', '3村の賛同でも、同じ運営者が動かす台本なので採択されない');
  assert.deepEqual([cosignCount(w, w.goals.eastsiege).villages, cosignCount(w, w.goals.eastsiege).controllers], [3, 1]);
  const d = decisionsFor(w, 'mira').find(x => x.id === 'need-eastsiege-arms');
  assert.ok(d, 'ミラに東の砦攻めへの申し出の判断が出る');
  const r = act(w, 'mira', 'pledge', { goal: 'eastsiege', need: 'arms', qty: 60 });
  assert.ok(r.ok);
  assert.equal(w.pledges[r.pledge].status, '準備中', '手元を超える分は作るまで準備中');
  assert.ok(pledgeTotals(w, 'mira').arms > w.stock.mira.arms);
});

test('所有者の不在：ソウタの物は誰も動かせず、調整役は代わりの道を選べる', () => {
  const w = createWorld('preparing');
  advance(w, 3);
  inject(w, 'absent', { member: 'sota' });
  const p = Object.values(w.pledges).find(x => x.provider === 'sota' && x.need === 'food');
  assert.equal(act(w, 'sota', 'dispatch', { pledge: p.id, qty: 400 }).ok, false);
  assert.equal(act(w, 'kei', 'dispatch', { pledge: p.id, qty: 400 }).ok, false);
  const pr = needProgress(w, 'outpost', 'food');
  assert.equal(pr.pledgedAbsent, 400, '不在の人の申し出は、見込みに数えず別に見せる');
  const risk = decisionsFor(w, 'kei').find(d => d.id.startsWith('risk-'));
  assert.ok(risk && /食料/.test(risk.why));
  assert.ok(nonWait(risk).length >= 2);
});

test('調整役の不在：賛同した人が引き継げる。引き継いでも持ち主は変わらない', () => {
  const w = createWorld('preparing');
  inject(w, 'absent', { member: 'kei' });
  choose(w, 'mira', 'takeover-', '調整役を引き継ぐ');
  assert.equal(w.goals.outpost.coordinator, 'mira');
  const fortPledge = Object.values(w.pledges).find(p => p.need === 'fort');
  assert.equal(fortPledge.provider, 'kei');
  assert.equal(act(w, 'mira', 'build', { kind: '砦', at: 'site', pledge: fortPledge.id }).ok, false, 'ミラは自分の材料が足りず、ケイの材料は使えない');
});

test('期限切れのあと：届いた物は受け取った人の物で、返すかはその人が選ぶ', () => {
  const w = createWorld('preparing');
  advance(w, 60);
  assert.equal(w.goals.outpost.status, '期限切れ');
  assert.ok(w.goals.outpost.outcome.missing.length > 0);
  const d = decisionsFor(w, 'kei').find(x => x.id.startsWith('return-'));
  assert.ok(d, 'ケイに「受け取った物をどうするか」が出る');
  assert.ok(d.options.some(o => o.label === '自分の守りに使う' && o.enabled !== false), '返さないことも選べる');
  const back = d.options.find(o => o.label === '送り主に返す');
  const r = perform(w, 'kei', back);
  assert.ok(r.ok);
  assert.equal(custody(w, r.shipment).ownerAfter, 'mira');
  assert.ok(!decisionsFor(w, 'kei').some(x => x.id === d.id && x.title === d.title), '返した荷について、もう一度は聞かれない');
});

test('自給と短い参加も成り立つ：何も出さない人にも結果が書かれ、偵察一回だけで見張りを満たせる', () => {
  const w = createWorld('preparing');
  const d = decisionsFor(w, 'haru').find(x => x.id === 'need-outpost-watch');
  const self = d.options.find(o => o.label.startsWith('自給'));
  assert.match(self.consequence, /ただ乗り/);
  choose(w, 'haru', 'need-outpost-watch', '偵察を一度出す');
  choose(w, 'haru', 'watch-', '偵察を出す');
  advance(w, 25);
  assert.equal(needProgress(w, 'outpost', 'watch').satisfied, true);
});

test('護衛は封：卓の記録には件数だけが出て、襲撃から荷を守る', () => {
  const w = createWorld('preparing');
  advance(w, 3);
  choose(w, 'sota', 'send-', '400 を送る');
  const r = act(w, 'kei', 'pledge', { goal: 'outpost', need: 'escort' });
  assert.ok(r.ok);
  assert.ok(w.log.at(-1).text.includes('中身は封'));
  assert.ok(!w.log.at(-1).text.includes('ケイ'), '護衛の申し出の記録に名前を出さない');
  choose(w, 'kei', 'escort-', '兵40');
  advance(w, 3);
  assert.equal(inject(w, 'raid', {}).defended, true);
  const w2 = createWorld('preparing');
  advance(w2, 3);
  choose(w2, 'sota', 'send-', '400 を送る');
  advance(w2, 1);
  assert.equal(inject(w2, 'raid', {}).defended, false);
  const pr = needProgress(w2, 'outpost', 'food');
  assert.equal(pr.lost, 400);
  assert.equal(pr.arrived, 0);
});

test('失敗した行動は世界を変えない', () => {
  const w = createWorld('preparing');
  const snap = JSON.stringify(w);
  assert.equal(act(w, 'kei', 'build', { kind: '砦', at: 'site' }).ok, false);
  assert.equal(act(w, 'mira', 'dispatch', { pledge: 'nope', qty: 1 }).ok, false);
  assert.equal(act(w, 'mira', 'amend', { goal: 'outpost', deadline: 99 }).ok, false);
  assert.equal(JSON.stringify(w), snap);
});
