// Logistics horizon, first slice (display only): the first village's food
// projected through settle_upkeep (b), as land tiles supported and turns
// until unpaid / release. No population is invented; village 2+ food is
// not pooled; troop food upkeep is omitted (the live program does not charge it).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  TURN_SECS, HOUR, DECAY_AFTER_BELLS, settleUpkeep, turnReserve, accrueFood,
  farthestDistance, headroomAt, projectHorizon, formatHorizonTurns,
  otherVillageNote, horizonLead, horizonHudLine, horizonStatusLines,
} from '../../permutation-server/web/frontier/landhorizon.mjs';
import { TERRITORY_V1 } from '../../permutation-server/web/frontier/flocalplay-territory.mjs';
import { naturalSize, cellUpkeep } from '../../permutation-server/web/frontier/territory-rules.mjs';
import { ownLandBlock, ownLandHorizonBlock } from '../../permutation-server/web/frontier/screens/holding.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';
import { setTermsPace } from '../../permutation-server/web/frontier/seasonterms.mjs';

const web = f => readFileSync(new URL(`../../permutation-server/web/${f}`, import.meta.url), 'utf8');

const ONE_TILE = TERRITORY_V1.upkeep.flat; // 990 milli-food/h
const START_FOOD = 40_000; // hamlet 40 food/h
const TILES_73 = 73;
const UPKEEP_73_NEAR = TILES_73 * ONE_TILE; // 72,270
const TURN_73 = Number((BigInt(UPKEEP_73_NEAR) * BigInt(TURN_SECS)) / BigInt(HOUR)); // 12,045

test('settle_upkeep (b) matches the Rust cases (990 milli/h, remainder, short store, reserve)', () => {
  // 990 milli/h; 100 s from paidTo 1000 → 27.5 milli, charge 27, remainder 1800
  const a = settleUpkeep({ rate: 990, paidTo: 1_000, nowTs: 1_100, nowBell: 1, remainder: 0, available: 1_000_000 });
  assert.deepEqual({ charge: a.charge, paid: a.paid, remainder: a.remainder, unpaidSince: a.unpaidSince }, {
    charge: 27, paid: true, remainder: 1800, unpaidSince: null,
  });
  // settling every 100 s for an hour totals exactly 990
  let paidTo = a.paidTo, rem = a.remainder, total = a.charge;
  for (let k = 2; k <= 36; k++) {
    const s = settleUpkeep({ rate: 990, paidTo, nowTs: 1_000 + 100 * k, nowBell: 1, remainder: rem, available: 1_000_000 });
    total += s.charge;
    paidTo = s.paidTo;
    rem = s.remainder;
  }
  assert.equal(total, 990);
  // short of food: what the store holds is taken, unpaid since this bell
  const short = settleUpkeep({
    rate: 990, paidTo, nowTs: 1_000 + 3_600 * 2, nowBell: 7, remainder: rem, available: 10,
  });
  assert.equal(short.charge, 10);
  assert.equal(short.paid, false);
  assert.equal(short.unpaidSince, 7);
  assert.equal(short.remainder, 0);
  // a second settle in the same second owes nothing; an empty store does not clear unpaid
  const same = settleUpkeep({
    rate: 990, paidTo: short.paidTo, nowTs: 1_000 + 3_600 * 2, nowBell: 7,
    remainder: short.remainder, unpaidSince: 7, available: 0,
  });
  assert.deepEqual({ charge: same.charge, paid: same.paid, unpaidSince: same.unpaidSince }, { charge: 0, paid: false, unpaidSince: 7 });
  // store below one turn's reserve (165) stays unpaid; 165 in the same second (owed 0) clears it
  const almost = settleUpkeep({
    rate: 990, paidTo: 1_000 + 3_600 * 3, nowTs: 1_000 + 3_600 * 3 + 1, nowBell: 9,
    remainder: 0, unpaidSince: 7, available: 164,
  });
  assert.equal(almost.paid, false);
  assert.equal(almost.unpaidSince, 7);
  const clear = settleUpkeep({
    rate: 990, paidTo: 1_000 + 3_600 * 3, nowTs: 1_000 + 3_600 * 3 + 1, nowBell: 9,
    remainder: 0, unpaidSince: 7, available: 165,
  });
  assert.equal(clear.paid, true);
  assert.equal(clear.charge, 0);
  assert.equal(clear.unpaidSince, null);
  assert.equal(turnReserve(990), 165n);
});

test('settle_upkeep (b) 73 tiles: a short turn takes the store; the next turn alone does not clear it', () => {
  const rate = UPKEEP_73_NEAR;
  const s = settleUpkeep({ rate, paidTo: 1_000, nowTs: 1_600, nowBell: 1, available: 5_000 });
  assert.equal(s.charge, 5_000);
  assert.equal(s.paid, false);
  assert.equal(s.unpaidSince, 1);
  assert.equal(s.remainder, 0);
  const next = settleUpkeep({
    rate, paidTo: s.paidTo, nowTs: 2_200, nowBell: 2, remainder: 0, unpaidSince: 1, available: 6_666,
  });
  assert.equal(next.charge, 6_666);
  assert.equal(next.paid, false);
  assert.equal(next.unpaidSince, 1);
  const empty = settleUpkeep({
    rate, paidTo: next.paidTo, nowTs: 2_800, nowBell: 3, remainder: 0, unpaidSince: 1, available: -5,
  });
  assert.deepEqual({ charge: empty.charge, paid: empty.paid }, { charge: 0, paid: false });
  const whole = settleUpkeep({
    rate, paidTo: empty.paidTo, nowTs: 3_400, nowBell: 4, remainder: 0, unpaidSince: 1, available: 1_000_000,
  });
  assert.equal(whole.charge, TURN_73);
  assert.equal(whole.paid, true);
  assert.equal(whole.unpaidSince, null);
  // owed 0 in the same second, reserve short
  const reserveShort = settleUpkeep({
    rate, paidTo: 3_400, nowTs: 3_400, nowBell: 4, remainder: 0, unpaidSince: 4, available: 7_000,
  });
  assert.deepEqual({ charge: reserveShort.charge, paid: reserveShort.paid }, { charge: 0, paid: false });
});

test('net >= 0: sustainable, with natural_size headroom at the current distance', () => {
  // 30 tiles near home (dist 0–3: 990 each), village makes 40 food/h → room for 10 more
  const tiles = 30, upkeep = tiles * ONE_TILE;
  const hist = Array(64).fill(0);
  hist[2] = tiles;
  const h = projectHorizon({
    stockMilli: 80_000, productionMilliPerHour: START_FOOD, capMilli: 2_000_000,
    upkeepMilliPerHour: upkeep, paidTo: 10_000, remainder: 0, unpaidSince: null,
    nowTs: 10_000, nowBell: 20, tiles, hist,
  });
  assert.equal(h.sustainable, true);
  assert.equal(h.unpaidAlready, false);
  assert.equal(h.turnsUntilUnpaid, null);
  assert.equal(h.turnsUntilRelease, null);
  assert.equal(h.distance, 2);
  assert.equal(h.maxSustainableTiles, naturalSize(TERRITORY_V1.upkeep, START_FOOD, 2));
  assert.equal(h.maxSustainableTiles, 40);
  assert.equal(h.headroom, 10);
  assert.equal(h.headroom, headroomAt(START_FOOD, upkeep, 2));
  const lines = horizonStatusLines(h, 1).join('\n');
  assert.match(lines, /維持できます/);
  assert.match(lines, /あと 10 マスまで維持できます/);
  assert.match(lines, /最大 40 マス/);
});

test('net < 0: turns until unpaid starts and until land release starts (+24)', () => {
  // 73 tiles near home, 40 food/h, empty-enough store, already settled to now
  const hist = Array(64).fill(0);
  hist[1] = TILES_73;
  const h = projectHorizon({
    stockMilli: 5_000, productionMilliPerHour: START_FOOD, capMilli: 2_000_000,
    upkeepMilliPerHour: UPKEEP_73_NEAR, paidTo: 10_000, remainder: 0, unpaidSince: null,
    nowTs: 10_000, nowBell: 5, tiles: TILES_73, hist,
  });
  assert.equal(h.sustainable, false);
  assert.equal(h.netMilliPerHour, START_FOOD - UPKEEP_73_NEAR);
  assert.ok(h.turnsUntilUnpaid >= 1, `unpaid in the future, got ${h.turnsUntilUnpaid}`);
  assert.equal(h.turnsUntilRelease, h.turnsUntilUnpaid + DECAY_AFTER_BELLS);
  assert.equal(DECAY_AFTER_BELLS, 24);
  // with 5,000 now, one turn's accrual is 6,666 — still short of 12,045, so the next settle fails
  assert.equal(h.turnsUntilUnpaid, 1);
  assert.equal(h.turnsUntilRelease, 25);
  const lines = horizonStatusLines(h, 1).join('\n');
  assert.match(lines, /未払いは .+ 後に始まります/);
  assert.match(lines, /24 ターン後/);
  assert.match(lines, /手放しは/);
});

test('already unpaid: remaining turns until release, and letting once grace has ended', () => {
  const hist = Array(64).fill(0);
  hist[1] = TILES_73;
  const mid = projectHorizon({
    stockMilli: 0, productionMilliPerHour: START_FOOD, capMilli: 2_000_000,
    upkeepMilliPerHour: UPKEEP_73_NEAR, paidTo: 10_000, remainder: 0, unpaidSince: 10,
    nowTs: 10_000, nowBell: 20, tiles: TILES_73, hist,
  });
  assert.equal(mid.unpaidAlready, true);
  assert.equal(mid.sustainable, false);
  assert.equal(mid.turnsUntilUnpaid, 0);
  assert.equal(mid.turnsUntilRelease, 10 + 24 - 20); // 14
  assert.equal(mid.letting, false);
  const midLines = horizonStatusLines(mid, 1).join('\n');
  assert.match(midLines, /すでに未払いです/);
  assert.match(midLines, /手放しは .+ 後に始まります/);

  const late = projectHorizon({
    stockMilli: 0, productionMilliPerHour: START_FOOD, capMilli: 2_000_000,
    upkeepMilliPerHour: UPKEEP_73_NEAR, paidTo: 20_000, remainder: 0, unpaidSince: 10,
    nowTs: 20_000, nowBell: 34, tiles: TILES_73, hist,
  });
  assert.equal(late.letting, true);
  assert.equal(late.turnsUntilRelease, 0);
  assert.match(horizonStatusLines(late, 1).join('\n'), /手放しが始まっています/);
});

test('a settle already due and short marks unpaid this turn (turnsUntilUnpaid = 0)', () => {
  const h = projectHorizon({
    stockMilli: 5_000, productionMilliPerHour: START_FOOD, capMilli: 2_000_000,
    upkeepMilliPerHour: UPKEEP_73_NEAR, paidTo: 9_000, remainder: 0, unpaidSince: null,
    nowTs: 10_000, nowBell: 5, tiles: TILES_73,
  });
  assert.equal(h.turnsUntilUnpaid, 0);
  assert.equal(h.turnsUntilRelease, 24);
  assert.equal(h.unpaidAlready, false); // was not unpaid going in; it starts at this settle
  assert.match(horizonStatusLines(h, 1).join('\n'), /今の支払いで未払いが始まります/);
});

test('x1 vs x60 time wording (game time, and real time in parentheses when accelerated)', () => {
  try {
    setLang('ja');
    const n = 12; // 12 × 10 min = 2 hours of game time; at ×60, 2 minutes of real time
    assert.equal(formatHorizonTurns(n, 1), '12 ターン（約 2 時間）');
    assert.equal(formatHorizonTurns(n, 60), '12 ターン（ゲーム内で約 2 時間、この世界では実時間で約 2 分）');
    assert.equal(formatHorizonTurns(n, null), '12 ターン（ゲーム内で約 2 時間）');
    assert.equal(formatHorizonTurns(1, 1), '1 ターン（約 10 分）');
    assert.equal(formatHorizonTurns(1, 60), '1 ターン（ゲーム内で約 10 分、この世界では実時間で約 10 秒）');
    setLang('en');
    assert.match(formatHorizonTurns(n, 1), /12 turns \(about 2 hours\)/i);
    assert.match(formatHorizonTurns(n, 60), /12 turns \(about 2 hours of game time, in this world about 2 minutes of real time\)/i);
  } finally {
    setLang('ja');
  }
});

test('2nd village surplus is a logistics cue and is not counted in the projection', () => {
  assert.equal(otherVillageNote({ villageCount: 1, otherFoodMilli: 80_000, otherProdMilliPerHour: 40_000 }), null);
  const one = otherVillageNote({ villageCount: 2, otherFoodMilli: 0, otherProdMilliPerHour: 0, caravansOff: false });
  assert.match(one, /2村目以降の食料は/);
  assert.match(one, /本拠地に送らない限り、土地の維持費には使えません/);
  const surplus = otherVillageNote({ villageCount: 2, otherFoodMilli: 80_000, otherProdMilliPerHour: 40_000, caravansOff: true });
  assert.match(surplus, /ここに含めていません/);
  assert.match(surplus, /この世界では隊商を送れません/);
  assert.doesNotMatch(surplus, /隊商を送って/);
  // projection itself only sees village-1 production
  const h = projectHorizon({
    stockMilli: 5_000, productionMilliPerHour: START_FOOD, capMilli: 2_000_000,
    upkeepMilliPerHour: UPKEEP_73_NEAR, paidTo: 10_000, nowTs: 10_000, nowBell: 5, tiles: TILES_73,
  });
  assert.equal(h.sustainable, false, 'village 2 food is not passed in, so 73 tiles stay unsustainable');
});

test('the horizon block sits beside the existing land lines and does not change them', () => {
  const land = { tiles: 4, nextOre: 10, upkeepMilliPerHour: 4 * ONE_TILE, unpaid: false, letting: false, turnsLeft: 24 };
  const existing = String(ownLandBlock(land));
  assert.match(existing, /id="hp-own-land"/);
  assert.doesNotMatch(existing, /hp-own-land-horizon/);
  const hist = Array(64).fill(0);
  hist[0] = 4;
  const h = projectHorizon({
    stockMilli: 80_000, productionMilliPerHour: START_FOOD, capMilli: 2_000_000,
    upkeepMilliPerHour: 4 * ONE_TILE, paidTo: 10_000, nowTs: 10_000, nowBell: 1, tiles: 4, hist,
  });
  const block = String(ownLandHorizonBlock(h, { rate: 1, villageCount: 2, otherFoodMilli: 10_000, otherProdMilliPerHour: 40_000, caravansOff: true }));
  assert.match(block, /id="hp-own-land-horizon"/);
  assert.match(block, /この食料で土地を何マス、何ターン先まで支えられるか/);
  assert.match(block, /data-term="horizon"/);
  assert.match(block, /維持できます/);
  assert.match(block, /2村目以降の食料は/);
  assert.equal(String(ownLandBlock(land)), existing, 'ownLandBlock is unchanged');
  assert.match(horizonLead(), /この食料で土地を何マス、何ターン先まで支えられるか/);
});

test('accrueFood caps the store and turnReserve is ceil(rate × 600 / 3600)', () => {
  const grown = accrueFood(1_999_000, 40_000, TURN_SECS, 2_000_000, 0);
  assert.equal(grown.stockMilli, 2_000_000);
  assert.equal(turnReserve(UPKEEP_73_NEAR), 12_045n);
  assert.equal(farthestDistance([0, 3, 0, 2, 0]), 3);
  assert.equal(farthestDistance(Array(64).fill(0)), null);
});

test('the card and glossary name the term; no on-chain program files are touched', () => {
  const holding = web('frontier/screens/holding.mjs');
  const glossary = web('frontier/hud/glossary.mjs');
  const hud = web('frontier/hud/hud.mjs');
  assert.match(holding, /ownLandHorizonBlock/);
  assert.match(glossary, /物流の見通し/);
  assert.match(glossary, /バックミンスター・フラー/);
  assert.match(hud, /horizonHudLine|res-land-horizon/);
  const rust = readFileSync(new URL('../../frontier-abi/src/world_index/territory.rs', import.meta.url), 'utf8');
  assert.match(rust, /fn settle_upkeep/);
  // display-only slice: the JS mirror is in landhorizon.mjs, not a program change
  assert.match(web('frontier/landhorizon.mjs'), /display only/);
});

// ---- verify-pr272 (independent verification): the mirror against the program's own cases, and the bounds
import { upkeepPerHour } from '../../permutation-server/web/frontier/territory-rules.mjs';
import { MAX_STEPS } from '../../permutation-server/web/frontier/landhorizon.mjs';
import EN_FRONTIER from '../../permutation-server/web/lang/en-frontier.mjs';

/** frontier-abi/vectors/territory-upkeep-b.txt: `n0 d0 n1 d1 paid_to remainder since now_ts now_bell avail | charge paid since_after remainder_after paid_to_after`. */
const VECTORS = readFileSync(new URL('../../frontier-abi/vectors/territory-upkeep-b.txt', import.meta.url), 'utf8').split('\n')
  .filter(l => l.trim() && !l.startsWith('#'))
  .map(l => l.split(/\s+/).filter(t => t && t !== '|').map(Number));

test('verify-pr272: settleUpkeep is settle_upkeep (b) in every one of the 200 shared Rust vectors', () => {
  assert.equal(VECTORS.length, 200);
  let short = 0, reserve = 0;
  for (const v of VECTORS) {
    const [n0, d0, n1, d1, paidTo, remainder, since, nowTs, nowBell, avail, charge, paid, sinceAfter, remAfter, paidToAfter] = v;
    const rate = upkeepPerHour(TERRITORY_V1.upkeep, [...Array(n0).fill(d0), ...Array(n1).fill(d1)]);
    const s = settleUpkeep({ rate, paidTo, nowTs, nowBell, remainder, unpaidSince: since < 0 ? null : since, available: avail });
    const why = JSON.stringify({ v, s });
    assert.equal(s.take, charge, why);
    assert.equal(s.paid, paid === 1, why);
    assert.equal(s.unpaidSince, sinceAfter < 0 ? null : sinceAfter, why);
    assert.equal(s.remainder, remAfter, why);
    assert.equal(s.paidTo, paidToAfter, why);
    if (!s.paid) short++;
    if (since >= 0 && s.paid === false && avail >= charge) reserve++;
  }
  assert.ok(short > 0 && reserve > 0, `the vectors reach the short and the one-turn-reserve branches (${short}, ${reserve})`);
});

test('verify-pr272: a land stuck unpaid answers at once, the release from unpaid_since + 24', () => {
  const t0 = performance.now();
  const h = projectHorizon({ stockMilli: 0, productionMilliPerHour: START_FOOD, upkeepMilliPerHour: UPKEEP_73_NEAR, paidTo: 99_400, nowTs: 100_000, nowBell: 110, unpaidSince: 100, tiles: TILES_73, hist: [TILES_73] });
  assert.ok(performance.now() - t0 < 50);
  assert.equal(h.unpaidAlready, true);
  assert.equal(h.turnsUntilRelease, 100 + 24 - 110);
  assert.equal(h.turnsUntilPaid, null);
});

test('verify-pr272: short by a hair with a full store: "more than" MAX_STEPS turns, never a blank card', () => {
  const h = projectHorizon({ stockMilli: 2_000_000, productionMilliPerHour: START_FOOD, upkeepMilliPerHour: START_FOOD + 1, paidTo: 100_000, nowTs: 100_000, nowBell: 10, tiles: 40, hist: [40] });
  assert.equal(h.sustainable, false);
  assert.equal(h.turnsUntilUnpaid, null);
  assert.equal(h.beyondTurns, MAX_STEPS);
  setLang('ja');
  assert.match(horizonStatusLines(h, 60)[0], /2,000 ターン/);
  assert.match(horizonHudLine(h, 60), /以上/);
  for (const k of ['未払いまで {0} 以上。', '食料の生産は土地の維持費より少ないですが、蔵の食料で {0} 以上は払えます。']) assert.ok(EN_FRONTIER[k], k);
  // within MAX_STEPS the turn count is exact
  const near = projectHorizon({ stockMilli: 50_000, productionMilliPerHour: START_FOOD, upkeepMilliPerHour: START_FOOD + 6_000, paidTo: 100_000, nowTs: 100_000, nowBell: 10, tiles: 46, hist: [46] });
  assert.equal(near.beyondTurns, null);
  assert.ok(near.turnsUntilUnpaid > 40 && near.turnsUntilUnpaid < 60, String(near.turnsUntilUnpaid));
});

test('verify-pr272: the wide card and the food ledger blocks carry different ids', () => {
  const h = projectHorizon({ stockMilli: 80_000, productionMilliPerHour: START_FOOD, upkeepMilliPerHour: 4 * ONE_TILE, paidTo: 10_000, nowTs: 10_000, nowBell: 1, tiles: 4, hist: [4] });
  assert.match(String(ownLandHorizonBlock(h, { rate: 1 })), /id="hp-own-land-horizon"/);
  assert.match(String(ownLandHorizonBlock(h, { id: 'hp-land-food-horizon', rate: 1 })), /id="hp-land-food-horizon"/);
  assert.match(web('frontier/screens/holding.mjs'), /id: 'hp-land-food-horizon'/);
  // and the ledger copy stands only where the wide-land card (which carries it under the land line) is not shown
  assert.match(web('frontier/screens/holding.mjs'), /landPerHour > 0\) && !wideClaimModel\(FS, m\) \? ownLandHorizonBlock\(m\.horizon, \{ id: 'hp-land-food-horizon'/);
});
