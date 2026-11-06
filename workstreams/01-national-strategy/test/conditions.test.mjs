// 成立条件・所有権・賛同と同意の区別・護衛の帰還のテスト（2026-10-30 の見直し）。
// ルールが書いたとおりに動くかの確認で、面白さや人の理解の証拠ではない。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createWorld, act, advance, inject, needProgress, readiness, custody, decisionsFor, inventory,
  addGoal, allocations, cosignCount,
} from '../prototype/model.mjs';
import { ESCORT_TURNS } from '../prototype/scenario.mjs';
import { choose, playToReady } from './helpers.mjs';

const pledgeOf = (w, who, need, goal = 'outpost') => Object.values(w.pledges).find(p => p.provider === who && p.need === need && p.goal === goal);
const siteVault = w => Object.values(w.facilities).find(f => f.kind === '倉' && f.at === 'site');

// ------------------------------------------------------------------ 成立は期限の時点で

test('条件が早くそろっても、成立の判定は期限のターン', () => {
  const w = createWorld('preparing');
  playToReady(w, { stopWhenReady: true });
  assert.equal(readiness(w, 'outpost').ready, true);
  assert.ok(w.turn < w.goals.outpost.deadline);
  assert.equal(w.goals.outpost.status, '準備中');
  advance(w, w.goals.outpost.deadline - w.turn);
  assert.equal(w.goals.outpost.status, '成立');
  assert.equal(w.goals.outpost.readyAt, w.goals.outpost.deadline);
});

test('そろった後に倉を奪われると、期限の時点で条件が崩れていて成立しない', () => {
  const w = createWorld('preparing');
  playToReady(w, { stopWhenReady: true });
  assert.ok(inject(w, 'vaultLost', {}).ok);
  const v = siteVault(w);
  assert.equal(v.owner, 'enemy');
  assert.equal(v.contents.food, 400, '中身は倉に残り、奪った人の物になる（S1：goods stay in the vault）');
  const food = Object.values(w.shipments).find(x => x.resource === 'food' && x.state === '到着済み');
  assert.equal(custody(w, food.id).ownerNow, 'enemy', '着いた後に倉ごと奪われた荷は、奪った人の物と表示する');
  assert.equal(needProgress(w, 'outpost', 'food').available, 0);
  assert.equal(needProgress(w, 'outpost', 'food').arrived, 400, '届いた累計は残るが、条件には使わない');
  advance(w, w.goals.outpost.deadline - w.turn);
  assert.equal(w.goals.outpost.status, '期限切れ');
  assert.ok(w.goals.outpost.outcome.missing.includes('food'));
});

test('そろった後に倉の持ち主が食料を出すと（消費）、条件が崩れる。戻せばまたそろう', () => {
  const w = createWorld('preparing');
  playToReady(w, { stopWhenReady: true });
  const v = siteVault(w);
  assert.ok(act(w, 'sota', 'sendFromVault', { facility: v.id, resource: 'food', qty: 200, to: 'kei' }).ok);
  assert.equal(needProgress(w, 'outpost', 'food').available, 200);
  assert.equal(readiness(w, 'outpost').ready, false);
  assert.ok(act(w, 'kei', 'sendFromVault', { facility: v.id, resource: 'food', qty: 10, to: 'kei' }).ok === false, '倉の持ち主でない人は倉から出せない');
  const p = pledgeOf(w, 'sota', 'food');
  // 期限までに戻せないので、調整役が期限を延ばし、ソウタが追加で送る
  assert.ok(act(w, 'kei', 'amend', { goal: 'outpost', deadline: w.turn + 20 }).ok);
  assert.equal(p.status, '発送済み', '全部送り終えた申し出は、方針変更でも再確認の対象にならない');
  const r = act(w, 'sota', 'pledgeMore', { goal: 'outpost', need: 'food', qty: 200 });
  assert.ok(r.ok, r.error);
  assert.equal(w.shipments[r.shipment].pledge, p.id);
  advance(w, w.shipments[r.shipment].eta - w.turn);
  assert.equal(w.goals.outpost.status, '準備中');
  assert.equal(needProgress(w, 'outpost', 'food').available, 400);
});

test('そろった後に砦を失うと、砦と守備兵の条件が崩れる', () => {
  const w = createWorld('preparing');
  playToReady(w, { stopWhenReady: true });
  assert.ok(inject(w, 'fortLost', {}).ok);
  const r = readiness(w, 'outpost');
  assert.ok(r.missing.includes('fort') && r.missing.includes('garrison'));
  advance(w, w.goals.outpost.deadline - w.turn);
  assert.equal(w.goals.outpost.status, '期限切れ');
});

test('材料（ケイの村への石材・兵器）は進み具合だけで、成立の条件にはしない', () => {
  const w = createWorld('preparing');
  playToReady(w, { stopWhenReady: true });
  assert.ok(w.stock.kei.stone < 500, '石材は砦に使われて手元から減っている');
  assert.equal(readiness(w, 'outpost').ready, true, '材料を使ったことで条件は崩れない');
});

// ------------------------------------------------------------------ 同じ物を二つの目標で数えない

const SECOND = {
  id: 'second', title: '拠点に予備の食料をためる', purpose: 'テスト用', site: 'site', proposer: 'mira', deadlineIn: 48, requiresStance: {},
  needs: [{ id: 'food', kind: 'deliver', resource: 'food', qty: 400, to: { kind: 'vault-at', at: 'site' }, use: 'テスト', usedBy: 'vault-owner' },
    { id: 'garrison', kind: 'garrison', qty: 300, use: 'テスト' }],
};

test('同じ倉の食料400を、二つの目標で400ずつには数えない（古い目標が先）', () => {
  const w = createWorld('preparing');
  addGoal(w, SECOND, 'mira');
  act(w, 'kei', 'cosign', { goal: 'second' });
  act(w, 'sota', 'cosign', { goal: 'second' });
  assert.equal(w.goals.second.status, '準備中');
  playToReady(w, { stopWhenReady: true });
  const a = allocations(w);
  assert.equal(a['outpost|food'], 400);
  assert.equal(a['second|food'], 0);
  assert.equal(needProgress(w, 'second', 'food').satisfied, false);
  assert.equal(a['outpost|garrison'], 300);
  assert.equal(a['second|garrison'], 0, '同じ砦の兵も二重に数えない');
});

// ------------------------------------------------------------------ 所有権（S1 の根拠に合わせた所）

test('送った後に行き先の倉が奪われると、荷は奪った人に届かず失われる（S1：世代が変わった倉）', () => {
  const w = createWorld('preparing');
  advance(w, 3);
  const r = act(w, 'sota', 'dispatch', { pledge: pledgeOf(w, 'sota', 'food').id, qty: 400 });
  inject(w, 'vaultLost', {});
  const s = w.shipments[r.shipment];
  advance(w, s.eta - w.turn);
  assert.equal(s.state, '失われた');
  assert.equal(siteVault(w).contents.food ?? 0, 0);
  assert.equal(custody(w, s.id).ownerNow, null);
  assert.equal(inventory(w, 'food').gone, 400);
});

test('倉の上限を超えて届いた分は失われ、到着済みにも数えない（S1：VAULT_CAP）', () => {
  const w = createWorld('preparing');
  advance(w, 3);
  const v = siteVault(w);
  v.contents.wood = 4800;
  const total = inventory(w, 'food').total;
  const r = act(w, 'sota', 'dispatch', { pledge: pledgeOf(w, 'sota', 'food').id, qty: 400 });
  const s = w.shipments[r.shipment];
  advance(w, s.eta - w.turn);
  assert.equal(v.contents.food, 200);
  assert.equal(s.overflow, 200);
  assert.equal(needProgress(w, 'outpost', 'food').arrived, 200);
  assert.equal(inventory(w, 'food').total, total);
});

test('方針変更と再確認は、発送済みの荷を取り消さず、行き先も変えない', () => {
  const w = createWorld('preparing');
  const before = Object.values(w.shipments).map(s => ({ id: s.id, to: JSON.stringify(s.to), eta: s.eta, owner: s.owner, qty: s.qty }));
  act(w, 'kei', 'amend', { goal: 'outpost', deadline: 70, purpose: '別の目的', qty: { food: 250 } });
  const p = pledgeOf(w, 'mira', 'arms');
  assert.equal(p.status, '再確認待ち');
  act(w, 'mira', 'reconfirm', { pledge: p.id, keep: false });
  for (const b of before) {
    const s = w.shipments[b.id];
    assert.deepEqual({ id: s.id, to: JSON.stringify(s.to), eta: s.eta, owner: s.owner, qty: s.qty }, b);
    assert.notEqual(s.state, '失われた');
  }
  advance(w, 12);
  assert.ok(Object.values(w.shipments).filter(s => s.owner === 'mira').every(s => s.state === '到着済み' && s.arrivedOwner === 'kei'));
});

// ------------------------------------------------------------------ 賛同は同意でも権限でもない

test('賛同しても、何も出す約束にならず、他人の物を動かす権限も生まれない', () => {
  const w = createWorld('preparing');
  inject(w, 'rival', {});
  const p = pledgeOf(w, 'sota', 'food');
  for (const who of ['yuki', 'mira', 'kei']) {
    assert.equal(act(w, who, 'dispatch', { pledge: p.id, qty: 1 }).ok, false);
    assert.equal(act(w, who, 'withdraw', { pledge: p.id }).ok, false);
  }
  assert.equal(Object.values(w.pledges).filter(x => x.provider === 'yuki').length, 0, '台本の仲間の賛同から申し出は生まれない');
  assert.equal(act(w, 'ai:mira', 'dispatch', { pledge: p.id, qty: 1 }).ok, false, 'AI の代理は試作にない（模擬もしない）');
});

test('判断する人が3に届かない小さな国では採択されないが、申し出・発送・見直しはできる', () => {
  const w = createWorld('start');
  w.members.mira.controller = 'p-kei';
  w.members.sota.controller = 'p-kei';
  w.members.haru.controller = 'p-kei';
  act(w, 'mira', 'cosign', { goal: 'outpost' });
  act(w, 'sota', 'cosign', { goal: 'outpost' });
  act(w, 'haru', 'cosign', { goal: 'outpost' });
  assert.deepEqual([cosignCount(w, w.goals.outpost).villages, cosignCount(w, w.goals.outpost).controllers], [4, 1]);
  assert.equal(w.goals.outpost.status, '提案中');
  const r = act(w, 'mira', 'pledge', { goal: 'outpost', need: 'stone', qty: 100 });
  assert.ok(r.ok);
  assert.ok(act(w, 'mira', 'dispatch', { pledge: r.pledge, qty: 100 }).ok);
  assert.ok(decisionsFor(w, 'kei').some(d => d.id.startsWith('risk-')), '採択前でも調整役は不足を見られる');
});

test('同じ村は二度賛同できない。同じ人が動かす複数の村は、判断する人1と数える', () => {
  const w = createWorld('start');
  act(w, 'mira', 'cosign', { goal: 'outpost' });
  assert.equal(act(w, 'mira', 'cosign', { goal: 'outpost' }).ok, false);
  w.members.sota.controller = 'p-mira';
  act(w, 'sota', 'cosign', { goal: 'outpost' });
  assert.equal(w.goals.outpost.status, '提案中', 'ケイ・ミラ・ソウタ（ミラと同じ人）＝判断する人2');
  act(w, 'haru', 'cosign', { goal: 'outpost' });
  assert.equal(w.goals.outpost.status, '準備中');
});

test('採択の後に賛同者が抜けても、採択は自動で取り消されず、調整役に知らせる。申し出と荷はそのまま', () => {
  const w = createWorld('preparing');
  const shipments = JSON.stringify(w.shipments);
  act(w, 'sota', 'uncosign', { goal: 'outpost' });
  assert.equal(w.goals.outpost.status, '準備中');
  assert.equal(pledgeOf(w, 'sota', 'food').status, '申し出', '賛同の取り消しは申し出の取り下げではない');
  assert.equal(JSON.stringify(w.shipments), shipments);
  const d = decisionsFor(w, 'kei').find(x => x.id.startsWith('below-'));
  assert.ok(d, '調整役に「賛同が採択の数を下回った」が出る');
  choose(w, 'kei', 'below-', 'このまま続ける');
  assert.ok(!decisionsFor(w, 'kei').some(x => x.id.startsWith('below-')));
});

test('調整役が抜けて賛同者がいなくなると調整役は空になり、誰かが名乗り出るまで方針は変えられない', () => {
  const w = createWorld('preparing');
  act(w, 'mira', 'uncosign', { goal: 'outpost' });
  act(w, 'sota', 'uncosign', { goal: 'outpost' });
  act(w, 'kei', 'leaveGoal', { goal: 'outpost' });
  assert.equal(w.goals.outpost.coordinator, null);
  assert.equal(act(w, 'kei', 'amend', { goal: 'outpost', deadline: 80 }).ok, false);
  choose(w, 'haru', 'volunteer-', '調整役に名乗り出る');
  assert.equal(w.goals.outpost.coordinator, 'haru');
  assert.ok(act(w, 'haru', 'amend', { goal: 'outpost', deadline: 80 }).ok);
  assert.equal(act(w, 'haru', 'dispatch', { pledge: pledgeOf(w, 'sota', 'food').id, qty: 1 }).ok, false, '調整役になっても他人の物は動かせない');
});

// ------------------------------------------------------------------ 護衛は戻る

test('護衛は待ち構える期間が過ぎると村へ戻り、戻った後は襲撃から守らない', () => {
  const w = createWorld('preparing');
  advance(w, 3);
  act(w, 'kei', 'pledge', { goal: 'outpost', need: 'escort' });
  const reserve = w.reserve.kei;
  choose(w, 'kei', 'escort-', '兵40');
  assert.equal(w.reserve.kei, reserve - 40);
  advance(w, 2 + ESCORT_TURNS + 2);
  assert.equal(w.reserve.kei, reserve, '護衛の兵が予備に戻った');
  act(w, 'sota', 'dispatch', { pledge: pledgeOf(w, 'sota', 'food').id, qty: 400 });
  advance(w, 1);
  assert.equal(inject(w, 'raid', {}).defended, false);
});
