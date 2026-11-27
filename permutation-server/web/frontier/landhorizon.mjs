// Logistics horizon (Fuller World Game, first slice, display only): how many
// land tiles the first village's food can support, and for how many turns,
// from the program's own settle_upkeep (b) and natural_size. No population
// is invented; troop food upkeep is omitted because the live program does
// not charge it. Village 2+ food is never pooled into the first village's
// land payment (it only helps if it is sent there).
//
// Numbers: milli-food, bells, and the TERRITORY_V1 curve (territory-rules.mjs
// / frontier-abi world_index/territory.rs). Clock wording is applied by the
// page (formatHorizonTurns), not here.
import { cellUpkeep, naturalSize, unpaidEffect } from './territory-rules.mjs';
import { TERRITORY_V1 } from './flocalplay-territory.mjs';
import { L, fmtNum } from '../lang.mjs';
import { BELL_SECS } from './clock.mjs';
import { spanWords } from './seasonterms.mjs';

export const TURN_SECS = 600;
export const HOUR = 3600;
export const DECAY_AFTER_BELLS = TERRITORY_V1.decayAfterBells;
// (verify-pr272) The projection looks this many turns ahead at most (≈ 13.9 days of game time) and then says "more
// than" — 20,000 steps were up to ~9 ms a call, and a render asks up to three times.
export const MAX_STEPS = 2_000;

const big = v => BigInt(v ?? 0);
const toInt = (v, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
};

/** One turn's reserve while unpaid: ceil(rate × 600 / 3600) milli-food (settle_upkeep). */
export function turnReserve(rate) {
  const r = big(Math.max(0, toInt(rate)));
  return (r * BigInt(TURN_SECS) + BigInt(HOUR) - 1n) / BigInt(HOUR);
}

/**
 * Mirror of frontier-abi `settle_upkeep` (Q-LP17-1 (b)): what one settle
 * takes and whether it leaves the land unpaid. Mutates nothing; returns the
 * next clock (`paidTo`, `remainder`, `unpaidSince`) plus `take` / `paid`.
 */
export function settleUpkeep({
  rate, paidTo, nowTs, nowBell, remainder = 0, unpaidSince = null, available = 0,
} = {}) {
  const R = big(Math.max(0, toInt(rate)));
  const dt = big(Math.max(0, toInt(nowTs) - toInt(paidTo)));
  const owed = R * dt + big(Math.max(0, toInt(remainder)));
  const hour = BigInt(HOUR);
  const charge = owed / hour;
  const rem = owed % hour;
  const unpaid = unpaidSince != null && Number.isInteger(Number(unpaidSince));
  const reserve = unpaid ? turnReserve(rate) : 0n;
  const need = unpaid && reserve > charge ? reserve : charge;
  const have = big(Math.max(0, toInt(available)));
  const paidToOut = Math.max(toInt(paidTo), toInt(nowTs));
  if (need <= have) {
    return { charge: Number(charge), paid: true, take: Number(charge), remainder: Number(rem), unpaidSince: null, paidTo: paidToOut };
  }
  const take = charge < have ? charge : have;
  return {
    charge: Number(take),
    paid: false,
    take: Number(take),
    remainder: take === charge ? Number(rem) : 0,
    unpaidSince: unpaid ? toInt(unpaidSince) : toInt(nowBell),
    paidTo: paidToOut,
  };
}

/**
 * Accrue `productionMilliPerHour` for `dt` seconds onto the store, exactly as the program's Holding::settle does
 * (fland.mjs settleAccrual, fix-landhorizon Q-TG5-1 (a)): the carried sub-unit remainder `frac` (0..3599) is a
 * Euclidean remainder kept across settles, even at the cap; a growing store only grows while under the cap (a store
 * at or over it stays as it is); a shrinking one stops at 0.
 */
export function accrueFood(stockMilli, productionMilliPerHour, dtSecs, capMilli, frac = 0) {
  const H = BigInt(HOUR);
  const cap = big(Math.max(0, toInt(capMilli, 2_000 * 1000)));
  const stock = big(Math.max(0, toInt(stockMilli)));
  const rate = big(toInt(productionMilliPerHour));
  const dt = big(Math.max(0, toInt(dtSecs)));
  const f = big(Math.max(0, toInt(frac)));
  if (dt <= 0n) return { stockMilli: Number(stock), frac: Number(f) };
  const num = f + rate * dt;
  const rem = ((num % H) + H) % H;
  const next = stock + (num - rem) / H;
  let value = stock;
  if (rate >= 0n) { if (stock < cap) value = next < cap ? next : cap; } else value = next < 0n ? 0n : next;
  return { stockMilli: Number(value), frac: Number(rem) };
}

/** Farthest distance bucket that holds a tile (`hist` is 64 × u16), or null. */
export function farthestDistance(hist) {
  if (!Array.isArray(hist)) return null;
  for (let i = hist.length - 1; i >= 0; i--) if (toInt(hist[i]) > 0) return i;
  return null;
}

/**
 * Extra tiles at `distance` whose upkeep still fits in `incomeMilliPerHour`
 * given the current upkeep (V1 has no per-rank term, so each added tile
 * costs the same). 0 when already over income; null if a tile is free.
 */
export function headroomAt(incomeMilliPerHour, currentUpkeepMilliPerHour, distance) {
  const cost = cellUpkeep(TERRITORY_V1.upkeep, 0, toInt(distance));
  if (cost == null || cost <= 0) return null;
  const room = toInt(incomeMilliPerHour) - toInt(currentUpkeepMilliPerHour);
  if (room < 0) return 0;
  return Math.floor(room / Number(cost));
}

/**
 * Project the first village's food against land upkeep, settle by settle
 * (keeper: once a turn). `productionMilliPerHour` is the village's own
 * food rate, not net of land. Returns turn counts and flags; no wording.
 *
 * `turnsUntilUnpaid`: 0 if already unpaid, or if a settle due now marks it;
 * otherwise the number of future turns until the first unpaid settle.
 * `turnsUntilRelease`: turns until the 24-turn grace ends (0 if already letting).
 */
export function projectHorizon({
  stockMilli = 0,
  stockFrac = 0,
  productionMilliPerHour = 0,
  capMilli = 2_000 * 1000,
  upkeepMilliPerHour = 0,
  paidTo = null,
  remainder = 0,
  unpaidSince = null,
  nowTs = 0,
  nowBell = 0,
  tiles = 0,
  hist = null,
} = {}) {
  const tilesN = Math.max(0, toInt(tiles));
  const upkeep = Math.max(0, toInt(upkeepMilliPerHour));
  const production = toInt(productionMilliPerHour);
  const now = toInt(nowTs);
  const bell0 = toInt(nowBell);
  const cap = Math.max(0, toInt(capMilli, 2_000 * 1000));
  let stock = Math.max(0, toInt(stockMilli));
  const stock0 = stock; // (verify-pr272: the snapshot reports the store now, not where the projection stopped)
  // (fix-landhorizon, Q-TG5-1 (a)) the store's carried sub-unit remainder, as the program keeps it
  let frac = Math.max(0, Math.min(HOUR - 1, toInt(stockFrac)));
  let paid = paidTo == null ? now : toInt(paidTo);
  let rem = Math.max(0, toInt(remainder));
  let since = unpaidSince != null && Number.isInteger(Number(unpaidSince)) ? toInt(unpaidSince) : null;
  const net = production - upkeep;
  const distance = farthestDistance(hist) ?? (tilesN > 0 ? TERRITORY_V1.upkeep.freeDistance : null);
  const maxAtDistance = distance == null ? null : naturalSize(TERRITORY_V1.upkeep, Math.max(0, production), distance);
  const headroom = distance == null ? null : headroomAt(Math.max(0, production), upkeep, distance);

  const graceOf = (unpaidAt, atBell) => {
    const eff = unpaidEffect(
      { decayAfterBells: DECAY_AFTER_BELLS, decayEveryBells: 1, blockClaims: true, productionBps: 10_000 },
      unpaidAt,
      atBell,
    );
    return { turnsLeft: Math.max(0, DECAY_AFTER_BELLS - Math.max(0, atBell - unpaidAt)), letting: eff.cellsReleased > 0 && tilesN > 0 };
  };

  const snapshot = extra => ({
    tiles: tilesN,
    productionMilliPerHour: production,
    upkeepMilliPerHour: upkeep,
    netMilliPerHour: net,
    stockMilli: stock0,
    distance,
    maxSustainableTiles: maxAtDistance,
    headroom,
    ...extra,
  });

  if (tilesN <= 0 || upkeep <= 0) {
    return snapshot({
      sustainable: true,
      unpaidAlready: false,
      turnsUntilUnpaid: null,
      turnsUntilRelease: null,
      letting: false,
      turnsUntilPaid: null,
      paidAgain: false,
      graceTurnsLeft: null,
    });
  }

  const apply = (ts, bell) => {
    const s = settleUpkeep({
      rate: upkeep, paidTo: paid, nowTs: ts, nowBell: bell, remainder: rem, unpaidSince: since, available: stock,
    });
    stock = Math.max(0, stock - s.take);
    paid = s.paidTo;
    rem = s.remainder;
    since = s.unpaidSince;
    return s;
  };

  const wasUnpaid = since != null;
  const since0 = since;
  // A paid land: the first settle that leaves it unpaid. An unpaid one: the first settle that pays it (`paidAt`) and,
  // while production stays below upkeep, the next one that leaves it unpaid again (`againAt`, Q-TG5-2 (a)).
  let unpaidAt = null, paidAt = null, againAt = null;
  const record = (s, k) => {
    if (!wasUnpaid) { if (!s.paid && unpaidAt == null) unpaidAt = k; return; }
    if (paidAt == null) { if (s.paid) paidAt = k; return; }
    if (!s.paid && againAt == null) againAt = k;
  };

  // A settle already due (the store is already at `now`) runs first, with
  // no extra accrual — the store has already been settled to now.
  if (paid < now) record(apply(now, bell0), 0);

  const reserveN = Number(turnReserve(upkeep));
  for (let k = 1; k <= MAX_STEPS; k++) {
    if (since == null && net >= 0 && stock >= reserveN) {
      // Paid, and production covers upkeep: it will stay paid.
      break;
    }
    if (since != null && paidAt == null && (upkeep - production) * TURN_SECS >= 2 * HOUR
      && stock + Math.ceil((Math.max(0, production) * TURN_SECS) / HOUR) + 1 < reserveN) {
      // (verify-pr272) Unpaid, and a turn's production is at least 2 milli-food short of a turn's upkeep: every
      // settle now takes the store and the next turn holds less — it stays unpaid (the release follows `since`).
      break;
    }
    if (!wasUnpaid && unpaidAt != null) break; // unpaid has started; the release is 24 turns after it
    if (wasUnpaid && paidAt != null && (net >= 0 || againAt != null)) break;
    const grown = accrueFood(stock, production, TURN_SECS, cap, frac);
    stock = grown.stockMilli;
    frac = grown.frac;
    record(apply(now + k * TURN_SECS, bell0 + k), k);
  }

  // Unpaid now and no settle within the horizon pays it: the release follows unpaid_since.
  const unpaidNow = wasUnpaid && paidAt == null;
  const paidAgain = wasUnpaid && paidAt != null;
  const nextUnpaid = wasUnpaid ? againAt : unpaidAt;
  const release = unpaidNow
    ? { turnsUntilRelease: Math.max(0, since0 + DECAY_AFTER_BELLS - bell0), letting: graceOf(since0, bell0).letting }
    : nextUnpaid != null
      ? { turnsUntilRelease: nextUnpaid + DECAY_AFTER_BELLS, letting: false }
      : { turnsUntilRelease: null, letting: false };

  const sustainable = net >= 0 && !unpaidNow && nextUnpaid == null;
  // (verify-pr272) Paid (or paid again), short of food, but no unpaid settle within MAX_STEPS turns: "more than MAX_STEPS turns".
  const beyondTurns = !sustainable && !unpaidNow && nextUnpaid == null ? MAX_STEPS : null;
  return snapshot({
    sustainable,
    unpaidAlready: unpaidNow,
    // (Q-TG5-2 (a)) for a land a coming settle pays, the turns until it goes unpaid AGAIN (null: not within the horizon)
    turnsUntilUnpaid: unpaidNow ? 0 : nextUnpaid,
    turnsUntilRelease: release.turnsUntilRelease,
    letting: release.letting,
    turnsUntilPaid: wasUnpaid ? paidAt : null,
    paidAgain,
    // an unpaid land: turns left of its 24-turn grace now (0 = letting go); null for a paid one
    graceTurnsLeft: wasUnpaid ? Math.max(0, since0 + DECAY_AFTER_BELLS - bell0) : null,
    beyondTurns,
  });
}

/**
 * (verify-pr272, seen live at ×60) The page reads the first village and the land record separately, so one can be a
 * keeper pass newer than the other. A keeper settle pays the village in the same transaction, which leaves the food's
 * checkpoint (`foodT0`, chain seconds) equal to the land's `paidTo`:
 *   foodT0 < paidTo — the food read predates the last land settle: its charge is not in the food yet, so it is charged
 *                     again from foodT0 (returns that clock; else the projection was a whole charge too late);
 *   foodT0 > paidTo — the land read predates it (or the player acted since: the two look the same), so
 *                     `consistent` is false and holdHorizon keeps the last consistent answer (else a whole charge was
 *                     taken twice: 9 turns early on a 46-tile land, flickering with the right answer every few seconds).
 */
export function alignLandClock(paidTo, foodT0) {
  const p = paidTo == null ? null : toInt(paidTo), t = Number(foodT0);
  if (p == null || !Number.isFinite(t)) return { paidTo: p, consistent: true };
  if (t < p) return { paidTo: Math.trunc(t), consistent: true };
  return { paidTo: p, consistent: t === p };
}

let held = null;
/**
 * The projection to show: `h` when the two reads agree (remembered with `key` — the land and the food rate it was
 * made for — and `bell`); otherwise the remembered one counted down by the turns since, while `key` is unchanged
 * (a new tile, a new rate or an unpaid flip shows `h` at once).
 */
export function holdHorizon(h, { consistent = true, key = '', bell = 0 } = {}) {
  if (!h) return h;
  if (consistent) { held = { key, bell: toInt(bell), h }; return h; }
  if (!held || held.key !== key) return h;
  const d = Math.max(0, toInt(bell) - held.bell);
  const down = v => (v == null ? v : Math.max(0, v - d));
  const o = held.h;
  return {
    ...h,
    sustainable: o.sustainable, unpaidAlready: o.unpaidAlready, letting: o.letting, beyondTurns: o.beyondTurns, paidAgain: o.paidAgain,
    graceTurnsLeft: down(o.graceTurnsLeft),
    turnsUntilUnpaid: down(o.turnsUntilUnpaid), turnsUntilRelease: down(o.turnsUntilRelease), turnsUntilPaid: down(o.turnsUntilPaid),
  };
}

/**
 * Time wording for `turns` at clock `rate` (1 = natural 10 min/turn, 60 =
 * a ×60 TEST world, null = a fast clock whose pace is not known yet).
 * Natural clock: game time = real time, said once. Faster: both.
 */
export function formatHorizonTurns(turns, rate) {
  const n = Math.max(0, toInt(turns));
  const game = spanWords(n * BELL_SECS);
  const r = rate == null ? null : Number(rate);
  if (r == null) return L`${fmtNum(n)} ターン（ゲーム内で約 ${game}）`;
  if (r > 1) return L`${fmtNum(n)} ターン（ゲーム内で約 ${game}、この世界では実時間で約 ${spanWords((n * BELL_SECS) / r)}）`;
  return L`${fmtNum(n)} ターン（約 ${game}）`;
}

/**
 * The 2nd-village logistics cue, or null when the player has only one
 * village. `otherFoodMilli` / `otherProdMilliPerHour` are the sum of
 * villages that are not the land-paying first home. Caravans are not
 * promised when `caravansOff` is true.
 */
export function otherVillageNote({ villageCount = 1, otherFoodMilli = 0, otherProdMilliPerHour = 0, caravansOff = false } = {}) {
  if (toInt(villageCount) < 2) return null;
  const surplus = toInt(otherFoodMilli) > 0 || toInt(otherProdMilliPerHour) > 0;
  if (caravansOff) {
    return surplus
      ? L`2村目以降の食料は、ここに含めていません。本拠地に送らない限り、土地の維持費には使えません。この世界では隊商を送れません。`
      : L`2村目以降の食料は、本拠地に送らない限り、土地の維持費には使えません。この世界では隊商を送れません。`;
  }
  return surplus
    ? L`2村目以降の食料は、ここに含めていません。本拠地に送らない限り、土地の維持費には使えません。`
    : L`2村目以降の食料は、本拠地に送らない限り、土地の維持費には使えません。`;
}

/** The village-card lead (plain wording; Fuller's definition lives in the glossary). */
export const horizonLead = () => L`この食料で土地を何マス、何ターン先まで支えられるか`;

/**
 * (fix-landhorizon, Q-TG5-2 (a)) An unpaid land that a coming settle pays while production stays below upkeep:
 * `{now: true}` when the settle due now pays it, `{now: false, paidIn}` for a later one. null otherwise, and when the
 * 24-turn grace would end first (the already-unpaid sentence, with its release, says that case). A settle that pays
 * on the very bell the grace ends releases nothing: the program settles first and may_decay needs unpaid_since
 * (verify-pr285), so that case is "paid in P", not "let go in P".
 */
//
// (fix-lp28-paid-again, owner r0ze 2026-11-28 00:14 Q-LP28-1 (b)) also when production now covers upkeep (`sustainable`):
// `{sustainable: true}` then. Before, that case said only "supported indefinitely" while the chain still said unpaid and
// claims were blocked (loop-play28 BREAK-3: a Farm took production 52 → 64 food/h over 54.45, unpaid on bells 360–361,
// paid on 362). The "While you wait" panel (hud/waitpanel.mjs) reads the same answer.
export function paidAgainCase(h) {
  if (!h?.paidAgain || h.turnsUntilPaid == null) return null;
  const paidIn = h.turnsUntilPaid;
  if (paidIn > 0 && h.graceTurnsLeft != null && h.graceTurnsLeft < paidIn) return null;
  return { now: paidIn === 0, paidIn, sustainable: !!h.sustainable };
}

/** Compact HUD / popover line, or '' when there is nothing to say. */
export function horizonHudLine(h, rate) {
  if (!h || !(h.tiles > 0) || !(h.upkeepMilliPerHour > 0)) return '';
  const pa = paidAgainCase(h);
  // (Q-LP28-1 (b)) unpaid now, a coming payment pays it, and production covers upkeep from then on
  if (pa?.sustainable && pa.now) return L`今の支払いで払われます。その後は、この食料の生産でずっと維持できます。`;
  if (pa?.sustainable) return L`土地は未払いです。${formatHorizonTurns(pa.paidIn, rate)} 後の支払いで払われます。その後は、この食料の生産でずっと維持できます。`;
  // (a sustainable land that is paid only after its grace ends falls to the release line below, as when production is short)
  if (h.sustainable && !h.paidAgain) return L`いまの土地は、この食料の生産で維持できます。`;
  if (pa?.now && h.turnsUntilUnpaid != null) {
    return L`今の支払いで払われます。また未払いまで ${formatHorizonTurns(h.turnsUntilUnpaid, rate)}。手放しまで ${formatHorizonTurns(h.turnsUntilRelease, rate)}。`;
  }
  if (pa?.now) return L`今の支払いで払われます。また未払いまで ${formatHorizonTurns(h.beyondTurns ?? MAX_STEPS, rate)} 以上。`;
  if (pa && h.turnsUntilUnpaid != null) {
    return L`土地は未払いです。${formatHorizonTurns(pa.paidIn, rate)} 後の支払いで払われます。また未払いまで ${formatHorizonTurns(h.turnsUntilUnpaid, rate)}。手放しまで ${formatHorizonTurns(h.turnsUntilRelease, rate)}。`;
  }
  if (pa) return L`土地は未払いです。${formatHorizonTurns(pa.paidIn, rate)} 後の支払いで払われます。また未払いまで ${formatHorizonTurns(h.beyondTurns ?? MAX_STEPS, rate)} 以上。`;
  if (h.paidAgain && h.graceTurnsLeft != null && !h.unpaidAlready) {
    return h.graceTurnsLeft === 0 ? L`土地は未払いで、手放しが始まっています。` : L`土地は未払いです。手放しまで ${formatHorizonTurns(h.graceTurnsLeft, rate)}。`;
  }
  if (h.unpaidAlready && h.letting) return L`土地は未払いで、手放しが始まっています。`;
  if (h.unpaidAlready) return L`土地は未払いです。手放しまで ${formatHorizonTurns(h.turnsUntilRelease, rate)}。`;
  if (h.turnsUntilUnpaid === 0) return L`今の支払いで未払いが始まります。`;
  if (h.turnsUntilUnpaid != null) {
    return L`未払いまで ${formatHorizonTurns(h.turnsUntilUnpaid, rate)}。手放しまで ${formatHorizonTurns(h.turnsUntilRelease, rate)}。`;
  }
  if (h.beyondTurns != null) return L`未払いまで ${formatHorizonTurns(h.beyondTurns, rate)} 以上。`;
  return '';
}

/** Status paragraphs for the village card (no cue, no lead). */
export function horizonStatusLines(h, rate) {
  if (!h || !(h.tiles > 0) || !(h.upkeepMilliPerHour > 0)) return [];
  const pa = paidAgainCase(h);
  if (pa?.sustainable) {
    // (Q-LP28-1 (b)) the #285 "paid again" sentence, then production supports the land; the distance room as below
    const room = h.headroom, max = h.tiles + (room ?? 0);
    const lead = pa.now
      ? L`今の支払いで土地の維持費が払われ、未払いは終わります。その後は、いまの土地をこの食料の生産でずっと維持できます。`
      : L`すでに未払いです。このままなら、${formatHorizonTurns(pa.paidIn, rate)} 後の支払いで払われ、その後は、いまの土地をこの食料の生産でずっと維持できます。`;
    if (room > 0) return [lead, L`いまの距離なら、あと ${fmtNum(room)} マスまで維持できます（最大 ${fmtNum(max)} マス）。`];
    if (room === 0) return [lead, L`いまの距離なら、これ以上マスを増やしても維持できません。`];
    return [lead];
  }
  if (h.sustainable && !h.paidAgain) {
    const room = h.headroom, max = h.tiles + (room ?? 0);
    if (room > 0) {
      return [L`いまの土地は、この食料の生産で維持できます。いまの距離なら、あと ${fmtNum(room)} マスまで維持できます（最大 ${fmtNum(max)} マス）。`];
    }
    if (room === 0) {
      return [L`いまの土地は、この食料の生産で維持できます。いまの距離なら、これ以上マスを増やしても維持できません。`];
    }
    return [L`いまの土地は、この食料の生産で維持できます。`];
  }
  if (pa?.now && h.turnsUntilUnpaid != null) {
    return [L`今の支払いで土地の維持費が払われ、未払いは終わります。このままなら、未払いはまた ${formatHorizonTurns(h.turnsUntilUnpaid, rate)} 後に始まります。土地の手放しは、その 24 ターン後（${formatHorizonTurns(h.turnsUntilRelease, rate)} 後）に始まります。`];
  }
  if (pa?.now) {
    return [L`今の支払いで土地の維持費が払われ、未払いは終わります。食料の生産は土地の維持費より少ないですが、蔵の食料で ${formatHorizonTurns(h.beyondTurns ?? MAX_STEPS, rate)} 以上は払えます。`];
  }
  if (pa && h.turnsUntilUnpaid != null) {
    return [L`すでに未払いです。このままなら、${formatHorizonTurns(pa.paidIn, rate)} 後の支払いで払われます。未払いはまた ${formatHorizonTurns(h.turnsUntilUnpaid, rate)} 後に始まります。土地の手放しは、その 24 ターン後（${formatHorizonTurns(h.turnsUntilRelease, rate)} 後）に始まります。`];
  }
  if (pa) {
    return [L`すでに未払いです。このままなら、${formatHorizonTurns(pa.paidIn, rate)} 後の支払いで払われ、その後は蔵の食料で ${formatHorizonTurns(h.beyondTurns ?? MAX_STEPS, rate)} 以上は払えます。`];
  }
  if (h.paidAgain && h.graceTurnsLeft != null && !h.unpaidAlready) {
    // paid later than the 24-turn grace ends: the release comes first (what follows it is not projected)
    return h.graceTurnsLeft === 0
      ? [L`すでに未払いです。いちばん遠いマスの手放しが始まっています。`]
      : [L`すでに未払いです。このままなら、土地の手放しは ${formatHorizonTurns(h.graceTurnsLeft, rate)} 後に始まります。`];
  }
  if (h.unpaidAlready && h.letting) {
    return [L`すでに未払いです。いちばん遠いマスの手放しが始まっています。`];
  }
  if (h.unpaidAlready) {
    return [L`すでに未払いです。このままなら、土地の手放しは ${formatHorizonTurns(h.turnsUntilRelease, rate)} 後に始まります。`];
  }
  if (h.turnsUntilUnpaid === 0) {
    return [L`今の支払いで未払いが始まります。土地の手放しは、その 24 ターン後（${formatHorizonTurns(h.turnsUntilRelease ?? 24, rate)} 後）に始まります。`];
  }
  if (h.turnsUntilUnpaid != null) {
    return [L`このままなら、未払いは ${formatHorizonTurns(h.turnsUntilUnpaid, rate)} 後に始まります。土地の手放しは、その 24 ターン後（${formatHorizonTurns(h.turnsUntilRelease, rate)} 後）に始まります。`];
  }
  if (h.beyondTurns != null) {
    return [L`食料の生産は土地の維持費より少ないですが、蔵の食料で ${formatHorizonTurns(h.beyondTurns, rate)} 以上は払えます。`];
  }
  return [];
}
