// 個人の「自分が届けた確定の到着の量」（coop/fulfil-bounds.mjs lowerBoundText）：数えた量は下限なので「以上」と言う（Lane C、2026-11-17）。
// WRITTEN, NOT RUN. A pure file: it imports only node:test, node:assert/strict and ../coop/fulfil-bounds.mjs (which imports
// nothing). Hand-made values only; no board, DOM, chain, file, network or key. goal.mjs の myVerified（データ）は変えていない。
import test from 'node:test';
import assert from 'node:assert/strict';
import { lowerBoundText } from '../coop/fulfil-bounds.mjs';

const JA = { wood: '木材', stone: '石材' };

test('下限は「以上」で言う（④ QUANTITY-CONTRACT §3：［b, b＋1））', () => {
  assert.equal(lowerBoundText({ wood: 196 }, JA), '木材 196 以上');
  assert.equal(lowerBoundText({ wood: 200, stone: 50 }, JA), '木材 200 以上・石材 50 以上');
  assert.equal(lowerBoundText({ wood: 0 }, JA), '木材 0 以上', '0 も「0 以上」：0 個とは言わない');
});

test('これまでの画面の試験（:has-text("木材 196")）が読む文字列を含む', () => {
  assert.ok(lowerBoundText({ wood: 196 }, JA).includes('木材 196'));
});

test('一覧が無い・空：これまでと同じ「—」', () => {
  for (const o of [undefined, null, {}, [], 'wood', 3]) assert.equal(lowerBoundText(o, JA), '—', JSON.stringify(o));
});

test('0 以上の安全な整数でない値は推し量らず「量が分からない」', () => {
  for (const v of [undefined, null, -1, 1.5, NaN, Infinity, '196', true, 2 ** 53]) {
    const t = lowerBoundText({ wood: v }, JA);
    assert.equal(t, '木材 量が分からない', String(v));
    assert.doesNotMatch(t, /以上/);
  }
});

test('知らない資源名・ja が無い：名前はそのまま', () => {
  assert.equal(lowerBoundText({ ore: 3 }, JA), 'ore 3 以上');
  assert.equal(lowerBoundText({ wood: 3 }), 'wood 3 以上');
});
