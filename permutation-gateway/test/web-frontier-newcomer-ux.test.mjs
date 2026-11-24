// newcomer-ux (first-time player review, no guide): the small text fixes.
//  - the guide and the keep list said "hold the keep's tile 72 turns" and never how long that is (about 12 hours at the
//    natural clock, about 12 minutes at ×60): the time is said beside the count, from the clock (seasonterms turnsLine);
//  - after a capture the guide said "the nation holding the most provinces at the end of the season wins" in a world
//    that goes on, where the 領土 tab says war-period winners are not decided: the guide now says what the tab says;
//  - the first-build texts called the lumber camp 伐採所, the building itself is 伐採場;
//  - the map search said it finds "a nation's name", but it finds a nation only where the viewer sees one of its
//    villages (hud/search.mjs survey): the hint says so.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setLang } from '../../permutation-server/web/lang.mjs';
import * as T from '../../permutation-server/web/frontier/seasonterms.mjs';
import EN from '../../permutation-server/web/lang/en-frontier-play.mjs';

const src = f => readFileSync(new URL(`../../permutation-server/web/frontier/${f}`, import.meta.url), 'utf8');

test('turnsLine says how long N turns last as the player lives them', () => {
  setLang('ja');
  try {
    T.setTermsPace(() => 1);
    assert.equal(T.turnsLine(72), '約 12 時間');
    T.setTermsPace(() => 60);
    assert.equal(T.turnsLine(72), 'この世界の実時間で約 12 分');
    T.setTermsPace(() => null);
    assert.equal(T.turnsLine(72), 'ゲーム内で約 12 時間');
    T.setTermsPace(() => 1);
    assert.equal(T.turnsLine(0), '約 0 秒');
    setLang('en');
    T.setTermsPace(() => 60);
    assert.match(T.turnsLine(72), /^about 12 min.* of real time in this world$/);
  } finally { T.setTermsPace(() => 1); setLang('ja'); }
});

test('the hold step and the keep list say the 72 turns in time', () => {
  const g = src('screens/conquestguide.mjs'), k = src('hud/keephand.mjs');
  assert.ok(g.includes('ターン（${turnsLine(k.required)}）続けて保つと、州はあなたの国のものになります。'), 'guide, while holding');
  assert.ok(g.includes('ターン（${turnsLine(hold)}）続けて保つと、州はあなたの国のものになります。'), 'guide, before arriving');
  assert.ok(k.includes('ターン（${turnsLine(holdTurns(FS))}）続けて保つと、その州はあなたの国のものになります。'), 'keep list rule line');
  for (const key of ['{0}の砦のマスを、あなたの国が {1} / {2} ターン保っています。{3} ターン（{4}）続けて保つと、州はあなたの国のものになります。',
    '進軍が砦のマスに着いて勝つと、占拠のターンが数えられます。{0} ターン（{1}）続けて保つと、州はあなたの国のものになります。',
    '砦のマスを {0} ターン（{1}）続けて保つと、その州はあなたの国のものになります。行を選ぶと命令の紙が開きます（封をするまで何も送られません）。',
    'ゲーム内で約 {0}', 'この世界の実時間で約 {0}', '約 {0}']) assert.equal(typeof EN[key], 'string', key);
});

test('after a capture, a world that goes on is not told a season winner', () => {
  const g = src('screens/conquestguide.mjs');
  assert.ok(g.includes("const seasonLine = worldContinues(FS.season) ? L`この世界は続きます。戦期の勝敗と集計は未決定です。` : L`この試しの世界は決まったターンで新しい命令の受付を終えます。試しの世界の上限で、勝ち負けの決まりではありません。`;"));
  // (fix-loop13, LP13-1: seasons are abolished — no world is told "the most provinces at the season's end wins")
  assert.ok(!g.includes('支配する州が最も多い国が勝ちます'));
  assert.ok(g.includes('を奪いました。${seasonLine}` : seasonLine}'));
  assert.equal(typeof EN['第{0}ターンに、あなたの国（{1}）が州 {2},{3} を奪いました。{4}'], 'string');
  assert.equal(typeof EN['この世界は続きます。戦期の勝敗と集計は未決定です。'], 'string');
});

test('the lumber camp has one name; the search hint says what it finds', () => {
  for (const f of ['screens/onboarding.mjs', 'screens/holding.mjs']) assert.doesNotMatch(src(f), /伐採所/, f);
  assert.ok(src('hud/search.mjs').includes('州の座標（例：4,0）、見えている村の国の名前、領主の名前で探せます'));
  for (const key of ['農場は食料、伐採場は木材を増やします。最初の建物を一つ選び、村が育つ様子を見てみましょう。',
    '農場で食料を増やすか、伐採場で木材を増やすか。村の最初の仕事を選びましょう。',
    '州の座標（例：4,0）、見えている村の国の名前、領主の名前で探せます']) assert.equal(typeof EN[key], 'string', key);
});
