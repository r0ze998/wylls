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

test('LP13-10: a taken caravan\'s arrival turn is its arrive_ts turn on the map tag too (the chain delivers once now >= arrive_ts)', async () => {
  const MARKS = await import('../../permutation-server/web/frontier/map/s1marks.mjs');
  const { bellAt } = await import('../../permutation-server/web/frontier/clock.mjs');
  const { setLang } = await import('../../permutation-server/web/lang.mjs');
  const G = 1_800_000_000;
  // runs end at bell 59 (the first bell that STARTS after the arrival), the arrival itself is 4 minutes into bell 58
  const c = { ownerTag: 7n, seq: 3, faction: 0, holderTag: 9n, raided: true, arriveTs: G + 58 * 600 + 240, runs: [{ p: -1, q: 2, firstBell: 55, n: 4 }],
    src: { kind: 3, p: -1, q: 2, tile: 20 }, dst: { kind: 0, p: -1, q: 2, tile: 35 }, cargo: [0, 0, 0, 20, 0, 0, 0, 0] };
  assert.equal(MARKS.caravanArriveBell(c), 59, 'the runs end');
  const mk = MARKS.s1Marks({ caravans: { moving: [c], vaults: [] } }, { bell: 56, bellOfTs: ts => bellAt(G, ts) });
  assert.equal(mk.caravans[0].arriveBell, 58, 'main said 59 here while the rights card said 58');
  setLang('ja');
  assert.equal(String(MARKS.caravanTagText(mk.caravans[0].arriveBell, true)), '略奪された隊商 ターン 58 着');
  // without a clock the runs still give a turn (as before)
  assert.equal(MARKS.s1Marks({ caravans: { moving: [c], vaults: [] } }, { bell: 56 }).caravans[0].arriveBell, 59);
});

test('LP13-4: a host check\'s words are read when shown (a map note made from it follows a language switch)', async () => {
  const { marchCheck, dissolveCheck, exploreCheck } = await import('../../permutation-server/web/frontier/hud/subject.mjs');
  const { setLang } = await import('../../permutation-server/web/lang.mjs');
  setLang('ja');
  try {
    for (const c of [marchCheck({}, null), dissolveCheck({}, null), exploreCheck({}, null)]) {
      const ja = c.text;
      assert.match(ja, /[぀-ヿ一-鿿]/);
      setLang('en');
      assert.doesNotMatch(c.text, /[぀-ヿ一-鿿]/, `${c.code}: the same check object now says it in English`);
      assert.notEqual(c.text, ja);
      setLang('ja');
      assert.equal(c.text, ja);
    }
  } finally { setLang('ja'); }
});
