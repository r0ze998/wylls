// ④との契約テスト：④の受領版（2e536b6b）のコードが書き出した Outcome の JSON（fixtures/ws04-outcomes-2e536b6b.json）と、
// ①の到着の分類を突き合わせる。④の進行中の HEAD とは別。本物のチェーンは使わない。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromWs04Outcome, toWs04Outcome, toWs04Terminal, toRes, WS04 } from '../coop/ws04.mjs';
import { arrivalOf, indexFeed, creditedOf } from '../coop/arrival.mjs';
import { COUNTABLE } from '../coop/goal.mjs';
import { RESOURCES } from '../coop/record.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIX = JSON.parse(fs.readFileSync(path.join(here, 'fixtures/ws04-outcomes-2e536b6b.json'), 'utf8'));
const out = name => FIX.find(c => c.case === name).outcome;
const need = { wood: 200, stone: 200 };
const HOME = { kind: 'holding', p: 3, q: 0, site: 2, gen: 1 };
const req = { id: 'r1', need, to: HOME };
const link = { responder: 'B', caravan: { ownerTag: '5', seq: 0 } };
const feed = indexFeed({ moving: [], ended: [] });
const settled = (kind, outcome, cargo) => ({ status: 'settled', settled: { outcome, dst: { kind, p: 3, q: 0, at: kind === 1 ? 2 : 40, gen: 1 }, cargo, signature: 's' } });

test('④の受領版の Outcome の JSON（④のコードが serde で書いた形）を、①が読める。形の違うものは断る', () => {
  assert.equal(WS04.head, '2e536b6b119d8eaa4e9f4d795e856b696249a664');
  assert.deepEqual(FIX.map(c => c.case), ['holding_rule_derived', 'vault_unverifiable', 'lost_known_zero', 'recorded_p1', 'not_shipped']);
  for (const c of FIX) {
    assert.deepEqual(Object.keys(c.outcome).sort(), ['cargo_logged', 'delivered', 'effects', 'note', 'verification']);
    fromWs04Outcome(c.outcome, need);
  }
  assert.throws(() => fromWs04Outcome({ ...out('vault_unverifiable'), delivered: [0, 1, 0, 0, 0, 0, 0, 0] }, need), /Unverifiable/);
  assert.throws(() => fromWs04Outcome({ ...out('lost_known_zero'), delivered: [0, 1, 0, 0, 0, 0, 0, 0] }, need), /KnownZero/);
  assert.throws(() => fromWs04Outcome({ ...out('holding_rule_derived'), delivered: [0, 1.5, 0, 0, 0, 0, 0, 0] }, need), /整数単位/);
  assert.throws(() => fromWs04Outcome({ ...out('holding_rule_derived'), verification: 'Verified' }, need), /知らない/);
});

test('村あて：①がチェーンの CARAVAN_SETTLED から作る到着は、④の RuleDerived の Outcome と同じ（delivered・verification・cargo_logged）', () => {
  const a = arrivalOf(req, link, feed, settled(1, 0, [0, 196, 0, 0, 0, 0, 0, 0]));
  assert.deepEqual(toWs04Outcome(a), out('holding_rule_derived'));
});

test('倉あて（credited なし）：①も④も delivered は分からない（null）・Unverifiable。cargo_logged は上限として残す', () => {
  const c = creditedOf({ dst: { kind: 2 }, cargo: [0, 200, 0, 0, 0, 0, 0, 0] });
  const w = out('vault_unverifiable');
  assert.equal(c.qty, w.delivered);
  assert.equal(c.verification, w.verification);
  assert.deepEqual(w.cargo_logged, [0, 200, 0, 0, 0, 0, 0, 0]);
});

test('LOST：①も④も delivered は 0（分からない null とは別）・KnownZero', () => {
  const a = arrivalOf(req, link, feed, settled(1, 1, [0, 200, 0, 0, 0, 0, 0, 0]));
  assert.deepEqual(toWs04Outcome(a), out('lost_known_zero'));
  assert.notEqual(a.delivered, null, '0 と分かっている');
});

test('Recorded（④の提案 P1、未適用）：①は作らないが、④から届けば数えてよい検証として読む。NotShipped は数えない', () => {
  const r = fromWs04Outcome(out('recorded_p1'), need);
  assert.deepEqual(r.delivered, { wood: 150, stone: 0 });
  assert.ok(COUNTABLE.includes(r.verification));
  const n = fromWs04Outcome(out('not_shipped'), need);
  assert.equal(n.delivered, null);
  assert.ok(!COUNTABLE.includes(n.verification));
  // ①の到着の分類は Recorded を出さない（credited がチェーンの記録にない）
  const a = arrivalOf(req, link, feed, settled(1, 0, [0, 1, 0, 0, 0, 0, 0, 0]));
  assert.notEqual(a.verification, 'Recorded');
});

test('単位：記録はミリ単位を1件ずつ切り捨てた整数。複数の到着の「切り捨ててから合計」は「合計してから切り捨て」より小さくなりうる（最大 k−1）', () => {
  // 隊商の CARGO はミリ単位（caravan.rs の CV::cargo、i64）。経路の塔の目減りで端数が出る：100.6 単位 = 100600 ミリ
  const milli = [100600, 100600, 100999];
  const logged = milli.map(m => Math.floor(m / 1000));   // cargo_log：1000 で割って切り捨て
  assert.deepEqual(logged, [100, 100, 100]);
  const sumOfFloors = logged.reduce((x, y) => x + y, 0);
  const floorOfSum = Math.floor(milli.reduce((x, y) => x + y, 0) / 1000);
  assert.equal(sumOfFloors, 300);
  assert.equal(floorOfSum, 302);
  assert.ok(floorOfSum - sumOfFloors <= milli.length - 1, '差は最大 k−1');
  // ①と④は、どちらも記録の整数（1件ずつ切り捨て）を足す。ミリ単位はチェーンの記録にないので、合計してから切り捨てた値は作れない
  const arrivals = logged.map(n => arrivalOf(req, link, feed, settled(1, 0, [0, n, 0, 0, 0, 0, 0, 0])));
  const oneSum = arrivals.reduce((s, a) => s + a.delivered.wood, 0);
  const fourSum = arrivals.map(a => toWs04Outcome(a).delivered[RESOURCES.indexOf('wood')]).reduce((x, y) => x + y, 0);
  assert.equal(oneSum, sumOfFloors);
  assert.equal(fourSum, sumOfFloors, '④の delivered も記録の整数（Res = 整数単位）');
});

test('状態の対応：①の到着の状態と、④の実行器の終わりの状態', () => {
  const t = (state, verification) => toWs04Terminal({ state, verification });
  assert.equal(t('delivered', 'RuleDerived'), 'Delivered(Fulfilled|Partial)');
  assert.equal(t('delivered', 'Unverifiable'), 'DeliveredUnverified');
  for (const s of ['lost', 'misdelivered', 'raided-taken', 'raided-burned']) assert.equal(t(s, 'KnownZero'), 'Failed');
  assert.equal(t('moving', null), 'InTransit');
  assert.equal(t('unknown', null), null);
  assert.deepEqual(toRes({ wood: 1, stone: 2 }), [0, 1, 2, 0, 0, 0, 0, 0]);
});
