// 共同の目的の精度の言い方（coop/fulfil-bounds.mjs jointPrecisionText）：underBy＝数えた到着の件数 k は「k 未満多いことがある」、
// k＝0 は「数えた到着がなく、ちょうど 0」で、「0 未満多い」と言わない（Lane C、2026-11-17）。
// WRITTEN, NOT RUN. A pure file: it imports only node:test, node:assert/strict and ../coop/fulfil-bounds.mjs (which imports
// nothing). Hand-made progress values only; no board, DOM, chain, file, network or key.
// underBy の数え方（記録 0 の到着も件数に入れる。④ QUANTITY-CONTRACT §3・§4）は goal.mjs coopView にあり、その回帰は
// 既存の test/coop.test.mjs（石材 2 件）と test/coop.e2e.test.mjs（fixture の木材 4 → 5 の訂正）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { jointPrecisionText } from '../coop/fulfil-bounds.mjs';

const JA = { wood: '木材', stone: '石材' };
const P = (wood, stone) => [{ resource: 'wood', underBy: wood }, { resource: 'stone', underBy: stone }];

test('どの資源も k > 0：これまでと同じ文', () => {
  assert.equal(jointPrecisionText(P(5, 2), JA), '整数単位。記録は到着1件ごとにミリ単位を切り捨てた値なので、本当の量は表示より 木材 5 未満・石材 2 未満 多いことがある（件数ぶん）');
});

test('k＝0 の資源は「ちょうど 0」で、「0 未満」と言わない', () => {
  const t = jointPrecisionText(P(2, 0), JA);
  assert.equal(t, '整数単位。記録は到着1件ごとにミリ単位を切り捨てた値なので、本当の量は表示より 木材 2 未満 多いことがある（件数ぶん）。石材は数えた到着がなく、数えた量はちょうど 0');
  assert.doesNotMatch(t, /0 未満/);
  const all = jointPrecisionText(P(0, 0), JA);
  assert.equal(all, '整数単位。木材・石材は数えた到着がなく、数えた量はちょうど 0');
  assert.doesNotMatch(all, /未満|切り捨て/);
});

test('記録 0 の到着も件数に入った値（k＝1、量 0）は「1 未満多いことがある」：0 と言わない', () => {
  const t = jointPrecisionText([{ resource: 'wood', underBy: 1 }], JA);
  assert.match(t, /木材 1 未満 多いことがある/);
  assert.doesNotMatch(t, /ちょうど 0/);
});

test('一覧が無い・空：落ちずに「整数単位」だけ', () => {
  assert.equal(jointPrecisionText(null, JA), '整数単位');
  assert.equal(jointPrecisionText(undefined, JA), '整数単位');
  assert.equal(jointPrecisionText([], JA), '整数単位');
});

// 訂正（2026-11-17、Lane C、試験前の静的レビューによる）：以前の期待は、件数の欠けた ore を「ちょうど 0」としていた。
// 欠けた・不正な件数は精度が分からないのであって、0 ではない（推し量らない）。
test('件数が欠けた・不正：「ちょうど 0」とも「未満」とも言わず、精度が分からない', () => {
  const UNKNOWN = /は数えた到着の件数が示されていないので、精度が分からない$/;
  assert.equal(jointPrecisionText([{ resource: 'ore' }], JA), '整数単位。oreは数えた到着の件数が示されていないので、精度が分からない');
  for (const underBy of [undefined, null, -1, 1.5, NaN, Infinity, -Infinity, '2', '0', true, 2 ** 53, {}, []]) {
    const t = jointPrecisionText([{ resource: 'wood', underBy }], JA);
    assert.match(t, UNKNOWN, String(underBy));
    assert.doesNotMatch(t, /ちょうど 0|未満/, String(underBy));
  }
});

test('要素が null・形が違う・資源名が無い：落ちず、0 と言わない', () => {
  for (const p of [null, undefined, 3, 'wood', [], { underBy: 2 }, { resource: '', underBy: 0 }, { resource: 7, underBy: 1 }]) {
    const t = jointPrecisionText([p], JA);
    assert.ok(typeof t === 'string' && t.startsWith('整数単位'), JSON.stringify(p));
  }
  assert.equal(jointPrecisionText([null], JA), '整数単位。（資源名なし）は数えた到着の件数が示されていないので、精度が分からない');
  assert.equal(jointPrecisionText([{ underBy: 2 }], JA), '整数単位。記録は到着1件ごとにミリ単位を切り捨てた値なので、本当の量は表示より （資源名なし） 2 未満 多いことがある（件数ぶん）');
  assert.doesNotMatch(jointPrecisionText([null, undefined, 3], JA), /ちょうど 0/);
});

test('三つが混ざる：正は未満、明示の 0 はちょうど 0、欠けは精度が分からない（並びは正・0・不明）', () => {
  const t = jointPrecisionText([{ resource: 'stone', underBy: null }, { resource: 'wood', underBy: 0 }, { resource: 'ore', underBy: 1 }], JA);
  assert.equal(t, '整数単位。記録は到着1件ごとにミリ単位を切り捨てた値なので、本当の量は表示より ore 1 未満 多いことがある（件数ぶん）。木材は数えた到着がなく、数えた量はちょうど 0。石材は数えた到着の件数が示されていないので、精度が分からない');
});

test('ja が無くても落ちない', () => {
  assert.equal(jointPrecisionText([{ resource: 'wood', underBy: 0 }]), '整数単位。woodは数えた到着がなく、数えた量はちょうど 0');
});
