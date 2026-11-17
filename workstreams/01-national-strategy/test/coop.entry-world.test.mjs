// （2026-11-17、書いただけ・未実行）⑦の村カードから来た届け先は、その村の世界（program・シーズン）がこの板のいまの世界と
// 同じときだけ入れる。違う・分からないときは入れずに理由を言う。読み直しの古い答えは新しい表示を上書きしない。
// 画面（coop-ui.mjs）はブラウザで動くので、ここでは文として固定する（ブラウザの試験は鍵の都合で別）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const ui = readFileSync(new URL('../coop/coop-ui.mjs', import.meta.url), 'utf8');

test('the entry fills the destination only for this board\'s present world', () => {
  assert.match(ui, /const sameWorld = qs\.get\('program'\) === cfg\.season\.programId && qs\.get\('season'\) === String\(cfg\.season\.seasonId\);/);
  assert.match(ui, /if \(to && \/\^-\?\\d\+,-\?\\d\+,\\d\+,\\d\+\$\/\.test\(to\) && sameWorld\) \[\$\('toP'\)\.value/);
  // another world, or a world not named: not filled, and why (the broken-format case keeps its own words)
  assert.match(ui, /入口の村が、どの世界（シーズン・プログラム）の村か分からないため、届け先に入れていない/);
  assert.match(ui, /入口の村は別の世界（シーズン \$\{qs\.get\('season'\)\.slice\(0, 20\)\}）の村のため、届け先に入れていない/);
  assert.match(ui, /入口から渡された届け先（\?to=\$\{to\.slice\(0, 40\)\}）が読めない。届け先の村を入れてください/);
});

test('a refresh answer older than the one shown, or asked for another viewer, is not applied', () => {
  const r = ui.slice(ui.indexOf('async function refresh()'), ui.indexOf('document.addEventListener(\'click\''));
  assert.match(r, /const seq = \+\+refreshSeq, viewerAt = signer\?\.address \?\? null;/);
  assert.match(r, /if \(seq <= appliedSeq \|\| \(signer\?\.address \?\? null\) !== viewerAt\) return;\n\s+appliedSeq = seq;\n\s+\[view, feed\] = \[v2, f2\];/);
  assert.ok(r.indexOf('appliedSeq = seq;') < r.indexOf('renderJoint();'), 'rendered only after it is applied');
});
