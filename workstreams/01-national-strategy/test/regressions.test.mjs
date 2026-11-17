// 独立レビュー（2026-10-29）で再現された不具合が、もう起きないことを確かめる。
// 番号はレビューの番号。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, act, advance, inject, needProgress, inventory } from '../prototype/model.mjs';
import { start } from '../prototype/serve.mjs';

const pledgeOf = (w, who, need) => Object.values(w.pledges).find(p => p.provider === who && p.need === need);
const unchanged = (w, f) => { const before = JSON.stringify(w); const r = f(); assert.equal(r.ok, false); assert.equal(JSON.stringify(w), before); return r; };

/** 拠点の倉の食料だけが条件の目標に絞り（他は任意にする）、ソウタに食料400を送らせる。 */
function foodOnly(w) {
  for (const n of w.goals.outpost.needs) if (n.id !== 'food') n.optional = true;
  advance(w, 3);
  const p = pledgeOf(w, 'sota', 'food');
  return w.shipments[act(w, 'sota', 'dispatch', { pledge: p.id, qty: 400 }).shipment];
}

test('1：期限を過ぎてそろっても成立にはならない', () => {
  const w = createWorld('preparing');
  const food = foodOnly(w);
  inject(w, 'delay', { shipment: food.id, turns: w.goals.outpost.deadline + 1 - food.eta });
  advance(w, 60);
  assert.equal(food.state, '到着済み', '荷は期限の後に着く');
  assert.equal(w.goals.outpost.status, '期限切れ');
});

test('2：送信の失敗は、取り下げた申し出も再確認待ちの申し出も生き返らせない', () => {
  const w = createWorld('preparing');
  advance(w, 3);
  const p = pledgeOf(w, 'sota', 'food');
  act(w, 'sota', 'dispatch', { pledge: p.id, qty: 100 });
  act(w, 'sota', 'withdraw', { pledge: p.id });
  inject(w, 'txfail', {});
  assert.equal(p.status, '取り下げ');
  const w2 = createWorld('preparing');
  advance(w2, 3);
  const p2 = pledgeOf(w2, 'sota', 'food');
  act(w2, 'sota', 'dispatch', { pledge: p2.id, qty: 100 });
  act(w2, 'kei', 'amend', { goal: 'outpost', deadline: 60 });
  inject(w2, 'txfail', {});
  assert.equal(p2.status, '再確認待ち');
  assert.equal(needProgress(w2, 'outpost', 'food').pledged, 0);
});

test('3：贈る先が正しくなければ、在庫は減らない', () => {
  const w = createWorld('preparing');
  unchanged(w, () => act(w, 'kei', 'gift', { to: 'kei', resource: 'food', qty: 10 }));
  unchanged(w, () => act(w, 'kei', 'gift', { to: 'mira', resource: 'gems', qty: 10 }));
});

test('4：追加で送る操作は、通らないときに何も変えない', () => {
  const w = createWorld('preparing');
  act(w, 'kei', 'amend', { goal: 'outpost', deadline: 60 });
  unchanged(w, () => act(w, 'mira', 'pledgeMore', { goal: 'outpost', need: 'arms', qty: 5 }));
  unchanged(w, () => act(w, 'haru', 'pledgeMore', { goal: 'outpost', need: 'arms', qty: 500 }));
});

test('5：再確認待ちの砦・守備兵の申し出は数えない', () => {
  const w = createWorld('preparing');
  act(w, 'kei', 'amend', { goal: 'outpost', deadline: 60 });
  assert.equal(needProgress(w, 'outpost', 'garrison').pledged, 0);
  assert.equal(needProgress(w, 'outpost', 'fort').pledged, 0);
});

test('6：持ち主の行動は、合わない申し出や再確認待ちの申し出を「発送済み」にしない', () => {
  const w = createWorld('preparing');
  const g = pledgeOf(w, 'kei', 'garrison');
  unchanged(w, () => act(w, 'kei', 'build', { kind: '倉', at: 'v:kei', pledge: g.id }));
  act(w, 'kei', 'amend', { goal: 'outpost', deadline: 60 });
  const r = act(w, 'kei', 'train', { n: 10 });
  assert.ok(r.ok);
  assert.equal(g.status, '再確認待ち');
});

test('7：着いた荷を、遅らせたり襲ったりできない', () => {
  const w = createWorld('preparing');
  const stone = Object.values(w.shipments).find(s => s.resource === 'stone');
  advance(w, stone.eta - w.turn);
  const total = inventory(w, 'stone').total;
  unchanged(w, () => inject(w, 'raid', { shipment: stone.id }));
  unchanged(w, () => inject(w, 'delay', { shipment: stone.id, turns: 5 }));
  assert.equal(inventory(w, 'stone').total, total);
});

test('8：数でない値や負の値は断る', () => {
  const w = createWorld('start');
  unchanged(w, () => act(w, 'mira', 'pledge', { goal: 'outpost', need: 'stone', qty: 10, cap: 'x' }));
  unchanged(w, () => act(w, 'kei', 'pledge', { goal: 'outpost', need: 'garrison', qty: -5 }));
  act(w, 'mira', 'cosign', { goal: 'outpost' }); act(w, 'sota', 'cosign', { goal: 'outpost' });
  unchanged(w, () => act(w, 'kei', 'amend', { goal: 'outpost', deadline: -3 }));
  unchanged(w, () => act(w, 'kei', 'amend', { goal: 'outpost', qty: { food: -10 } }));
});

test('9：知らない目標や必要への依頼は、例外ではなく断りになる', () => {
  const w = createWorld('preparing');
  unchanged(w, () => act(w, 'kei', 'request', { to: 'haru', goal: 'nope', need: 'food' }));
  unchanged(w, () => act(w, 'kei', 'request', { to: 'haru', goal: 'outpost', need: 'nope' }));
});

test('10：成立・期限切れの目標を中止に書き換えない', () => {
  const w = createWorld('preparing');
  advance(w, 60);
  unchanged(w, () => act(w, 'kei', 'closeGoal', { goal: 'outpost' }));
});

test('11：壊れた URL でもサーバーは止まらない', async () => {
  const s = await start(0);
  const base = `http://127.0.0.1:${s.address().port}`;
  try {
    assert.equal((await fetch(`${base}/%E0`)).status, 400);
    assert.equal((await fetch(`${base}/`)).status, 200);
    assert.equal((await fetch(`${base}/..%2f..%2fpackage.json`)).status, 404);
  } finally {
    s.close();
  }
});

test('追加：成立したあとは、残りの申し出は終わり、送れない', () => {
  const w = createWorld('preparing');
  foodOnly(w);
  const p = pledgeOf(w, 'mira', 'arms');
  advance(w, w.goals.outpost.deadline - w.turn);
  assert.equal(w.goals.outpost.status, '成立');
  unchanged(w, () => act(w, 'mira', 'dispatch', { pledge: p.id, qty: 1 }));
});
