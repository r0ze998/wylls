// fix-loop13 (loop-play13 LP13-3): a contest's line on a keep right under the top bar slides out from under the HUD.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLabelPass, LABEL_PASS } from '../../permutation-server/web/frontier/map/labelpass.mjs';
import { CONTEST_TAG_REACH } from '../../permutation-server/web/frontier/map/keeps.mjs';

// 1280×800 as in the loop-play13 shot 024: the top bar (0–62) and, under it, the provinces-held strip (56–556 × 66–102)
const NOGO = [{ x: 0, y: 0, w: 1280, h: 62 }, { x: 56, y: 66, w: 500, h: 36 }];
const tag = { x: 160, y: -12, w: 300, h: 23 };   // 「エンバーがあなたの国の砦を保持中 · 53 / 72 ターン」 over a keep at (310, 20)

test('LP13-3: with the default reach the line stays cut under the top bar; with the contest reach it stands clear of the HUD', () => {
  const bounds = { w: 1280, h: 800 };
  const before = createLabelPass({ nogo: NOGO, bounds }).place(310, 20, tag, { keep: true, reach: LABEL_PASS.reach });
  assert.deepEqual(before, { dx: 0, dy: 0 }, 'main: nowhere within 96 px, so it stays under the top bar');
  const after = createLabelPass({ nogo: NOGO, bounds }).place(310, 20, tag, { keep: true, reach: CONTEST_TAG_REACH });
  const top = tag.y + after.dy;
  assert.ok(top >= 0, 'not cut by the top of the picture');
  const box = { x: tag.x + after.dx, y: top, w: tag.w, h: tag.h };
  for (const r of NOGO) assert.ok(!(box.x < r.x + r.w && r.x < box.x + box.w && box.y < r.y + r.h && r.y < box.y + box.h), `clear of ${JSON.stringify(r)}`);
});
