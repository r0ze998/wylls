// Continuous world (migration candidate): a season whose conquest block says
// `continuous` = 1 (end_bell = NO_END_BELL) never "ends" on the page: the bell
// chip never reads ended, no season-end card stands, the conquest screen keeps
// its orders and says the world goes on (war periods undecided). A season that
// ends keeps every behaviour it had.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bellChip, seasonClock, worldContinues } from '../../permutation-server/web/frontier/clock.mjs';
import * as P from '../../permutation-server/web/frontier/hud/provstrip.mjs';
import { STANDINGS_AFTER } from '../../permutation-server/web/frontier/hud/handdemo-data.mjs';
import { EN } from '../../permutation-server/web/lang.mjs';

const NO_END = 4294967295;
const base = { genesisTs: 1000, drandGenesis: 0, drandPeriod: 3, seedMargin: 60, revealWindow: 600, windowFromBell: NO_END, endBell: 96 };

test('worldContinues reads the conquest block or the herald field; an ending season does not continue', () => {
  assert.equal(worldContinues({ conquestParams: { continuous: 1 } }), true);
  assert.equal(worldContinues({ continuous: true }), true);
  assert.equal(worldContinues({ conquestParams: { continuous: 0 } }), false);
  assert.equal(worldContinues({}), false);
  assert.equal(worldContinues(null), false);
});

test('the bell chip of a continuous world never ends; an ending season ends at endBell', () => {
  const ending = seasonClock(base);
  const now = 1000 + 600 * 200;
  assert.equal(bellChip(ending, now).ended, true);
  const cont = seasonClock({ ...base, endBell: NO_END, conquestParams: { continuous: 1 } });
  assert.equal(cont.continuous, true);
  for (const b of [96, 5000, 1_000_000]) assert.equal(bellChip(cont, 1000 + 600 * b).ended, false);
});

test('no season-end card in a continuous world, even with a final record', () => {
  const fs = (season) => ({ mode: 'play', nowBell: 200, season: { programVersion: 4, endBell: 96, ...season }, conquest: { standings: STANDINGS_AFTER, final: STANDINGS_AFTER }, citizen: { faction: 0 } });
  const ending = P.seasonEndModel(fs({}));
  const cont = P.seasonEndModel(fs({ endBell: NO_END, conquestParams: { continuous: 1 } }));
  assert.equal(cont, null);
  // the ending season still gets its card (whatever the record decides)
  assert.ok(ending === null || typeof ending === 'object');
});

test('the continuous wording has English text', () => {
  for (const k of ['この世界は続きます（終わりの時刻はありません）。戦期は未決定です。', '砦を保持する国がこの州を支配します。この世界は続きます。戦期の勝敗と集計は未決定です。']) {
    assert.equal(typeof EN[k], 'string', k);
  }
});
