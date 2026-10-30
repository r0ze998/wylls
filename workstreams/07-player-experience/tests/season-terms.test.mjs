// Workstream 07, claim 5 and brief item 4: times read from the season.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { seasonTimes, turnText, deadlineText, whyWrongStatus, s1Terms, spanText } from '../src/season-terms.mjs';

const WEB = new URL('../../../permutation-server/web/frontier/', import.meta.url);
const read = p => readFileSync(new URL(p, WEB), 'utf8');
const PRESETS_V2 = readFileSync(new URL('../../../frontier-abi/src/v2/presets.rs', import.meta.url), 'utf8');

test('the S1 presets\' end and join close are what the times read (S1_LOCAL_14D: 2,016 and 1,512 turns)', () => {
  assert.match(PRESETS_V2, /join_close_bell: 1_512/);
  const t = seasonTimes({ genesisTs: 0, endBell: 2016, joinCloseBell: 1512 }, { now: () => 600 * 100, rate: 1 });
  assert.deepEqual([t.season.gameDays, t.join.closeBell, t.join.closed, t.nowBell], [14, 1512, false, 100]);
  assert.match(deadlineText(t), /参加の受付は第1,512ターンまで（あと約 10 日）。シーズンは第2,016ターンで終わります（あと約 13 日）。/);
});

test('on a faster local clock a turn is said in game time and in the real time it takes', () => {
  const t = seasonTimes({ genesisTs: 0, endBell: 96, joinCloseBell: 72 }, { now: () => 0, rate: 10 });
  assert.equal(t.turn.realSecs, 60);
  assert.equal(turnText(t), '1ターンはゲーム内の10 分です。この世界では時計が 10 倍で進むため、実時間では約 60 秒です。');
  assert.match(turnText(t, 'en'), /10 minutes of game time — in this world, 60 seconds of real time/);
  assert.equal(turnText(seasonTimes({ genesisTs: 0, endBell: 96 }, { now: () => 0, rate: 1 })), '1ターンは10 分です。');
});

test('WrongStatus is said with its cause when the cause is the clock, and left to the page otherwise', () => {
  const closed = seasonTimes({ genesisTs: 0, endBell: 2016, joinCloseBell: 1512 }, { now: () => 600 * 1600, rate: 1 });
  assert.equal(whyWrongStatus(closed, 'join'), '参加の受付は第1,512ターンで締め切られました。');
  assert.equal(whyWrongStatus(closed, 'build'), null);
  const ended = seasonTimes({ genesisTs: 0, endBell: 2016, joinCloseBell: 1512 }, { now: () => 600 * 2020, rate: 1 });
  assert.match(whyWrongStatus(ended, 'build'), /シーズンは第2,016ターンで終わった/);
});

test('the S1 terms carry the rules\' numbers, and no sentence of them types a turn length', () => {
  const t = seasonTimes({ genesisTs: 0, endBell: 2016, joinCloseBell: 1512 }, { now: () => 0, rate: 40 });
  const terms = s1Terms(t);
  assert.deepEqual(terms.map(x => x.key), ['turn', 'caravan', 'tower', 'palisade', 'fort', 'arms', 'stance']);
  assert.match(terms.find(x => x.key === 'tower').ja, /1 分ごとに 1% 減ります（最大 30%）/);
  assert.equal(spanText(15), '15 秒');
});
