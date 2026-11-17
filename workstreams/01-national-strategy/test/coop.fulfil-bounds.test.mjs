// 依頼の充足の「数えた量」の言い方（coop/fulfil-bounds.mjs）：上限 0 は「ちょうど 0」で、「0 未満」と言わない（Lane C、2026-11-17）。
// WRITTEN, NOT RUN. A pure file: it imports only node:test, node:assert/strict and ../coop/fulfil-bounds.mjs (which imports
// nothing). Hand-made fulfilment values only (the five requests' values copied from test/fixtures/ws15-fold-e2e.json, not read);
// no board, DOM, chain, file, network or key. 判定（fulfilmentOf の status）は変えていない。
import test from 'node:test';
import assert from 'node:assert/strict';
import { fulfilBoundsText } from '../coop/fulfil-bounds.mjs';

const JA = { wood: '木材', stone: '石材' };
// これまでの文（coop-ui.mjs の needText と同じ並べ方）：上限が正のときは、この文と同じでなければならない
const needText = o => Object.entries(o ?? {}).map(([r, v]) => `${JA[r] ?? r} ${v}`).join('・') || '—';
const before = f => `数えた量の下限 ${needText(f.lower)}${f.upperExclusive ? `、上限 ${needText(f.upperExclusive)} 未満` : ''}`;

test('上限が正・上限が無い：これまでと同じ文（fixture の r1・r2・r4・r5）', () => {
  for (const f of [
    { status: 'fulfilled', lower: { wood: 200, stone: 200 }, upperExclusive: { wood: 202, stone: 202 } },
    { status: 'undetermined', lower: { wood: 9 }, upperExclusive: { wood: 11 } },
    { status: 'undetermined', lower: { wood: 0 }, upperExclusive: null },
    { status: 'not-reached', lower: { wood: 0 }, upperExclusive: { wood: 1 } },
  ]) assert.equal(fulfilBoundsText(f, JA), before(f), JSON.stringify(f));
  assert.equal(fulfilBoundsText({ lower: { wood: 9 }, upperExclusive: { wood: 11 } }, JA), '数えた量の下限 木材 9、上限 木材 11 未満');
  assert.equal(fulfilBoundsText({ lower: { wood: 0 }, upperExclusive: null }, JA), '数えた量の下限 木材 0');
});

test('上限 0（焼かれた隊商だけ、fixture の r3）：「ちょうど 0」。「0 未満」と言わない', () => {
  const t = fulfilBoundsText({ status: 'not-reached', lower: { stone: 0 }, upperExclusive: { stone: 0 } }, JA);
  assert.equal(t, '数えた量 石材 ちょうど 0（どの隊商も数えられないと決まった）');
  assert.doesNotMatch(t, /0 未満/);
  assert.doesNotMatch(t, /上限/);
});

test('資源ごとに分ける：上限 0 の資源はちょうど 0、正の資源は下限と上限（未満）', () => {
  const t = fulfilBoundsText({ lower: { wood: 0, stone: 5 }, upperExclusive: { wood: 0, stone: 6 } }, JA);
  assert.equal(t, '数えた量の下限 石材 5、上限 石材 6 未満、数えた量 木材 ちょうど 0（どの隊商も数えられないと決まった）');
  assert.doesNotMatch(t, /木材 0 未満/);
  const all = fulfilBoundsText({ lower: { wood: 0, stone: 0 }, upperExclusive: { wood: 0, stone: 0 } }, JA);
  assert.equal(all, '数えた量 木材 ちょうど 0・石材 ちょうど 0（どの隊商も数えられないと決まった）');
});

test('終わっていない隊商がある（上限なし）：0 でも「ちょうど 0」と言わない', () => {
  const t = fulfilBoundsText({ lower: { stone: 0 }, upperExclusive: null }, JA);
  assert.equal(t, '数えた量の下限 石材 0');
  assert.doesNotMatch(t, /ちょうど/);
});

test('欄が無い・知らない資源名：落ちずに言う', () => {
  assert.equal(fulfilBoundsText({ lower: {} }, JA), '数えた量の下限 —');
  assert.equal(fulfilBoundsText(null, JA), '数えた量の下限 —');
  assert.equal(fulfilBoundsText({ lower: { ore: 3 }, upperExclusive: { ore: 4 } }, JA), '数えた量の下限 ore 3、上限 ore 4 未満');
});
