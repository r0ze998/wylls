// fix wide-herald-lag (TEST-ONLY wide world, loop-play4 B-10): the herald's standings now count the grown map's rim
// (ring 128) and the wide land's keeps (ring 129+), which the dense control record (rings 0..=127) never holds. The page's
// 「支配する州」 strip must then show the standings' figures — never the control record's smaller heartland-only count
// (its keeps add up to less than the standings' sum, so `controlCounts` declines it) — and the figures stay counts only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../../permutation-server/web/frontier/hud/provstrip.mjs';

const SEASON = { programVersion: 3, layoutVersion: 2, endBell: 2016, bellSecs: 600, conquestParams: { keepBells: 72 } };
// (the standings record as the page holds it: herald.mjs's reading of /h/standings/latest.json, as hud/handdemo-data.mjs)
const standings = (bell, counts) => ({ metric: 'province-bells', bell, rows: counts.map((n, faction) => ({ faction, provinces: n, provinceBells: String(n * bell) })) });
/** The heartland keeps a control record of turn `bell` lays on the board: `held[f]` keeps for nation f. */
function heartland(bell, held) {
  const keeps = new Map();
  let i = 0;
  held.forEach((n, f) => { for (let k = 0; k < n; k++, i++) keeps.set(`${i},2`, { p: i, q: 2, tile: 10, holder: f, heartland: false, asOfBell: bell }); });
  return keeps;
}
const fs = (sd, control, keeps) => ({ mode: 'play', season: SEASON, citizen: { faction: 3 }, nowBell: 200, conquest: { status: 'ready', standings: sd, final: null, control, keeps } });

test('the strip counts the rim and wide keeps the standings hold, not the heartland-only control record', () => {
  // turn 190: each nation's two heartland keeps, plus rim/wide keeps the standings count (7 rim + wide for nation 0, …)
  const sd = standings(190, [9, 8, 7, 2, 7, 7]);
  const m = P.stripModel(fs(sd, { bell: 195 }, heartland(195, [2, 2, 2, 2, 2, 2])));
  assert.deepEqual(m.rows.map(r => r.provinces), [9, 8, 7, 2, 7, 7], 'the standings figures, though the control record is newer');
  assert.equal(m.bell, 190);
  assert.equal(m.total, 40);
  assert.deepEqual(m.rows.map(r => r.mine), [false, false, false, true, false, false]);
  assert.deepEqual(m.rows.map(r => r.lead), [true, false, false, false, false, false]);
  // a capture on the rim moves the next standings record: the strip's beat follows it
  const next = P.stripModel(fs(standings(196, [10, 7, 7, 2, 7, 7]), { bell: 196 }, heartland(196, [2, 2, 2, 2, 2, 2])));
  assert.deepEqual(P.changedCounts(m, next), [{ faction: 0, from: 9, to: 10 }, { faction: 1, from: 8, to: 7 }]);
  // the control record accounts for every province only in a heartland-only world: then it is used as before
  assert.deepEqual(P.controlCounts({ control: { bell: 195 }, keeps: heartland(195, [2, 2, 2, 2, 2, 2]) }, 40), null);
  assert.deepEqual(P.controlCounts({ control: { bell: 195 }, keeps: heartland(195, [2, 2, 2, 2, 2, 2]) }, 12), { bell: 195, counts: [2, 2, 2, 2, 2, 2] });
  // counts only: the model names no province
  assert.doesNotMatch(JSON.stringify(m), /"p"|"q"/);
});
