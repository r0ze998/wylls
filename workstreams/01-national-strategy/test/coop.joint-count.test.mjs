// 共同の目的の counted の集計（coop/joint-count.mjs addCounted）：抜き出す前の goal.mjs の loop と同じ算術（Lane C、2026-11-17）。
// WRITTEN, NOT RUN. A pure file: it imports only node:test, node:assert/strict and ../coop/joint-count.mjs (which imports
// nothing). Hand-made counted values only (the fixture's five counted arrivals copied from test/fixtures/ws15-fold-e2e.json,
// not read); no board, chain, DOM, file, network or key.
// これは足し算だけの回帰。どの到着を数えるか（重複・counted が null を除く guard）と、coopView・画面は確かめていない。
import test from 'node:test';
import assert from 'node:assert/strict';
import { addCounted } from '../coop/joint-count.mjs';

const RES = ['food', 'wood', 'stone', 'ore', 'arms', 'gold', 'science', 'influence'];
const blank = () => Object.fromEntries(RES.map(r => [r, 0]));   // goal.mjs の blank() と同じ形（8 資源を 0 で）
// 抜き出す前の goal.mjs の一行（71764e61〜6e812809）をそのまま写したもの
const before = (perResource, records, counted) => { for (const [r, v] of Object.entries(counted)) { perResource[r] += v; records[r] = (records[r] ?? 0) + 1; } };

const run = (f, list) => { const p = blank(), k = {}; for (const c of list) f(p, k, c); return { p, k }; };
const FIXTURE_COUNTED = [{ wood: 119, stone: 80 }, { wood: 81, stone: 120 }, { wood: 5 }, { wood: 4 }, { wood: 0 }];

test('fixture の数えた到着 5 件：下限の和 木材 209・石材 200、件数 木材 5・石材 2（記録 0 の到着も 1 件）', () => {
  const { p, k } = run(addCounted, FIXTURE_COUNTED);
  assert.equal(p.wood, 209);
  assert.equal(p.stone, 200);
  assert.deepEqual(k, { wood: 5, stone: 2 });
});

test('記録 0 だけの到着：量は 0 のまま、件数は増える（［0, 1）、④ QUANTITY-CONTRACT §3・§4）', () => {
  const { p, k } = run(addCounted, [{ stone: 0 }, { wood: 100, stone: 0 }]);
  assert.equal(p.stone, 0);
  assert.equal(k.stone, 2);
  assert.equal(p.wood, 100);
  assert.equal(k.wood, 1);
});

test('抜き出す前の一行と同じ結果（いくつかの並び）', () => {
  for (const list of [FIXTURE_COUNTED, [], [{}], [{ wood: 0 }], [{ gold: 3, wood: 1 }, { gold: 0 }], [{ wood: 200, stone: 200 }, { wood: 200, stone: 200 }]]) {
    assert.deepEqual(run(addCounted, list), run(before, list), JSON.stringify(list));
  }
});

test('その場で書き換え、何も返さない。counted が空なら何も変えない', () => {
  const p = blank(), k = { wood: 3 };
  assert.equal(addCounted(p, k, {}), undefined);
  assert.deepEqual(p, blank());
  assert.deepEqual(k, { wood: 3 });
  addCounted(p, k, { wood: 2 });
  assert.equal(p.wood, 2);
  assert.equal(k.wood, 4, '前からある件数に足す');
});

test('算術は変えていない：perResource に無い資源の足し算は、抜き出す前と同じく NaN（coopView は blank() で 8 資源を用意する）', () => {
  const a = { p: {}, k: {} }, b = { p: {}, k: {} };
  addCounted(a.p, a.k, { wood: 5 });
  before(b.p, b.k, { wood: 5 });
  assert.ok(Number.isNaN(a.p.wood));
  assert.deepEqual(a.k, b.k);
  assert.ok(Number.isNaN(b.p.wood));
});
