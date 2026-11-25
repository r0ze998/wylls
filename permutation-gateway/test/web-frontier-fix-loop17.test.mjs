// fix-loop17 (loop-play17's cosmetic findings, page only):
//  LP17-5  the Train form charged a whole hundred for a part hundred (10 Spearmen cost what 100 cost) and no line said
//          so. One line under the cost; the rule is permutation-rules catalog.rs `train` (`div_ceil(100)`).
//  LP17-6  the toast of a tile claim refused for unpaid land upkeep (and, loop-play16's note, of a second claim in one
//          turn) offered "Try again": in that turn the press can only be refused again. No retry button for those two.
//  LP17-7  the join card said two deadlines 101 and 143 minutes away as "about 2 hours" both. Between an hour and a
//          half and two days a time left is said to ten minutes: "about 1 h 40 min", "about 2 h 20 min".
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spanFine, spanWords, deadlineLine, setTermsPace, LEFT_HOLD_MIN } from '../../permutation-server/web/frontier/seasonterms.mjs';
import { statusOf, renderStatus } from '../../permutation-server/web/frontier/hud/status.mjs';
import { trainCost } from '../../permutation-server/web/frontier/hud/rulebook.mjs';
import { setLang, L } from '../../permutation-server/web/lang.mjs';

const web = f => readFileSync(new URL(`../../permutation-server/web/${f}`, import.meta.url), 'utf8');
const repo = f => readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8');

// ------------------------------------------------------------------ LP17-5
test('LP17-5: the Train form says a part hundred costs a whole hundred, in both languages; the rule charges that way', () => {
  const src = web('frontier/screens/holding.mjs');
  const line = '<p class="muted training-hundred">${L`費用は100人ごとです。100人に満たない分も100人分かかります（10人でも100人分）。`}</p>';
  assert.equal(src.split(line).length - 1, 1, 'one line, in the Train form');
  assert.ok(src.indexOf(line) > src.indexOf('<p class="training-cost"') && src.indexOf('<p class="training-cost"') > src.indexOf('const trainForm = html`'), 'under the cost line of the Train form');
  // the page's quote: 1, 10, 96 and 100 cost the same; 101 costs two hundreds (hud/rulebook.mjs trainCost)
  for (const unit of [0, 1, 2]) {
    const hundred = trainCost(unit, 100);
    for (const n of [1, 10, 80, 96]) assert.deepEqual(trainCost(unit, n), hundred, `unit ${unit}: ${n} troops cost a hundred's price`);
    assert.deepEqual(trainCost(unit, 101), trainCost(unit, 200));
    assert.notDeepEqual(trainCost(unit, 101), hundred);
  }
  // the rule itself (code wins): both trainings round the count up to whole hundreds
  const rule = repo('permutation-rules/src/frontier/catalog.rs');
  assert.equal((rule.match(/let k = n\.div_ceil\(100\) as i64;/g) ?? []).length, 2, 'train and train_v2');
  setLang('en');
  try {
    assert.equal(L`費用は100人ごとです。100人に満たない分も100人分かかります（10人でも100人分）。`, 'The cost is per hundred: a part hundred costs a whole hundred (10 troops cost as much as 100).');
  } finally { setLang('ja'); }
});

// ------------------------------------------------------------------ LP17-6
test('LP17-6: a tile claim refused for unpaid upkeep or for the turn limit offers no "Try again"', () => {
  const src = web('frontier/controller.mjs');
  assert.match(src, /const territoryNoRetry = pc => pc === 29 \|\| pc === 43;/);
  assert.match(src, /if \(territoryRefusalText\(pc\)\) failed\(\{ \.\.\.ans, \.\.\.\(territoryNoRetry\(pc\) \? \{ retry: false \} : \{\}\), text: \(\) => territoryRefusalText\(pc\) \}\);/);
  // the toast: the page remembers the claim (canRetry), and still shows no retry button for a notice marked so
  const unpaid = { ok: false, code: 'TransactionFailed', programCode: 43, retry: false, text: () => L`土地の維持費（本拠地の食料）が払えていないので、新しいマスは取れません。本拠地に食料が戻ると、また取れます。払えないまま24ターンたつと、遠いマスから1ターンに1つずつ手放されます。` };
  for (const lang of ['ja', 'en']) {
    setLang(lang);
    try {
      const st = statusOf({ notice: unpaid, lastAct: { name: 'territory-tile' } }, { canRetry: true });
      assert.equal(st.state, 'refused');
      assert.equal(st.retry, false);
      const out = String(renderStatus(st));
      assert.doesNotMatch(out, /data-act="notice-retry"/);
      assert.match(out, lang === 'en' ? /Your land upkeep \(food from your first village\) is unpaid, so you cannot claim a new tile\./ : /土地の維持費（本拠地の食料）が払えていないので、新しいマスは取れません。/);
      // (the ore refusal, 21, keeps its button: the same notice without the mark)
      const ore = statusOf({ notice: { ...unpaid, programCode: 21, retry: undefined }, lastAct: { name: 'territory-tile' } }, { canRetry: true });
      assert.equal(ore.retry, true);
      assert.match(String(renderStatus(ore)), /data-act="notice-retry"/);
    } finally { setLang('ja'); }
  }
});

// ------------------------------------------------------------------ LP17-7
test('LP17-7: two deadlines 101 and 143 minutes away no longer read the same', () => {
  setLang('ja');
  // (the coarse form, unchanged for every other line that uses it: both were 「2 時間」)
  assert.equal(spanWords(101 * 60), '2 時間');
  assert.equal(spanWords(143 * 60), '2 時間');
  assert.equal(spanFine(101 * 60), '1 時間 40 分');
  assert.equal(spanFine(143 * 60), '2 時間 20 分');
  assert.equal(spanFine(120 * 60), '2 時間', 'a whole hour has no minutes');
  assert.equal(spanFine(89 * 60), '89 分', 'under an hour and a half: minutes, as before');
  assert.equal(spanFine(90 * 60), '1 時間 30 分');
  assert.equal(spanFine(47 * 3600 + 58 * 60), '48 時間');
  assert.equal(spanFine(13 * 86400), '13 日', 'two days and more: days, as before');
  setLang('en');
  try {
    assert.equal(spanFine(101 * 60), '1 h 40 min');
    assert.equal(spanFine(143 * 60), '2 h 20 min');
    assert.equal(spanFine(120 * 60), '2 hours');
    // the join card's line at ×60: joining closes at turn 756, the test world's limit is turn 1,008 (loop-play17, turn 150)
    setTermsPace(() => 60);
    const FS = { season: { genesisTs: 0, endBell: 1008, joinCloseBell: 756 }, clock: { genesisTs: 0 }, chain: { now: () => 150 * 600 } };
    assert.equal(deadlineLine(FS), 'Joining is open until turn 756 (about 1 h 40 min left). This test world takes new orders until turn 1,008 (about 2 h 20 min left; a limit of test worlds). ');
    setLang('ja');
    assert.equal(deadlineLine(FS), '参加の受付は第756ターンまで（あと約 1 時間 40 分）。この試しの世界が新しい命令を受け付けるのは第1,008ターンまでです（あと約 2 時間 20 分。試しの世界の上限です）。');
  } finally { setLang('ja'); setTermsPace(() => 1); }
});

test('LP17-7: a named deadline holds its last-said tens against a jittering pace', () => {
  setLang('ja');
  const k = 'test:hold';
  assert.equal(spanFine(104 * 60, k), '1 時間 40 分');
  // the measured pace swings: 104 → 106 → 103 minutes left. Without the hold: 1:40 → 1:50 → 1:40
  assert.equal(spanFine(106 * 60), '1 時間 50 分');
  assert.equal(spanFine(106 * 60, k), '1 時間 40 分');
  assert.equal(spanFine(103 * 60, k), '1 時間 40 分');
  // the time really passes: the said value follows once it is LEFT_HOLD_MIN minutes off
  assert.equal(spanFine((100 - LEFT_HOLD_MIN + 0.5) * 60, k), '1 時間 40 分');
  assert.equal(spanFine((100 - LEFT_HOLD_MIN) * 60, k), '1 時間 30 分');
  assert.equal(spanFine(94 * 60, k), '1 時間 30 分', 'and does not go back up');
  // under an hour and a half the minutes take over, and the hold is dropped
  assert.equal(spanFine(80 * 60, k), '80 分');
  assert.equal(spanFine(85 * 60, k), '85 分');
});
