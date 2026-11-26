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

/** Accrue `productionMilliPerHour` for `dt` seconds onto stock, with a sub-hour remainder, capped. */
export function accrueFood(stockMilli, productionMilliPerHour, dtSecs, capMilli, frac = 0) {
  const cap = big(Math.max(0, toInt(capMilli, 2_000 * 1000)));
  let stock = big(Math.max(0, toInt(stockMilli)));
  const prod = big(toInt(productionMilliPerHour));
  const dt = big(Math.max(0, toInt(dtSecs)));
  const total = stock * BigInt(HOUR) + prod * dt + big(Math.max(0, toInt(frac)));
  stock = total / BigInt(HOUR);
  const nextFrac = total % BigInt(HOUR);
  if (stock > cap) return { stockMilli: Number(cap), frac: 0 };
  if (stock < 0n) return { stockMilli: 0, frac: 0 };
  return { stockMilli: Number(stock), frac: Number(nextFrac) };
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
  let frac = 0;
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

  let turnsUntilUnpaid = since != null ? 0 : null;
  let turnsUntilPaid = null;
  const wasUnpaid = since != null;

  // A settle already due (the store is already at `now`) runs first, with
  // no extra accrual — storesAt has already brought the stock to now.
  if (paid < now) {
    const s = apply(now, bell0);
    if (!s.paid && turnsUntilUnpaid == null) turnsUntilUnpaid = 0;
    if (wasUnpaid && s.paid && turnsUntilPaid == null) turnsUntilPaid = 0;
  }

  let t = now;
  let bell = bell0;
  for (let k = 1; k <= MAX_STEPS; k++) {
    if (since == null && turnsUntilUnpaid == null && net >= 0 && stock >= Number(turnReserve(upkeep))) {
      // Paid, and production covers upkeep: it will stay paid.
      break;
    }
    if (since != null && turnsUntilPaid == null && (upkeep - production) * TURN_SECS >= 2 * HOUR
      && stock + Math.ceil((Math.max(0, production) * TURN_SECS) / HOUR) + 1 < Number(turnReserve(upkeep))) {
      // (verify-pr272) Unpaid, and a turn's production is at least 2 milli-food short of a turn's upkeep: every
      // settle now takes the store and the next turn holds less — it stays unpaid (the release follows `since`).
      break;
    }
    if (wasUnpaid && since == null && turnsUntilPaid != null) break;
    if (!wasUnpaid && since != null && turnsUntilUnpaid != null) {
      // Unpaid has started; we only need the release offset from that bell.
      break;
    }
    const t2 = t + TURN_SECS;
    const grown = accrueFood(stock, production, TURN_SECS, cap, frac);
    stock = grown.stockMilli;
    frac = grown.frac;
    t = t2;
    bell = bell0 + k;
    const s = apply(t2, bell);
    if (!s.paid && turnsUntilUnpaid == null) turnsUntilUnpaid = k;
    if (wasUnpaid && s.paid && turnsUntilPaid == null) turnsUntilPaid = k;
  }

  const unpaidAlready = wasUnpaid && (turnsUntilPaid == null || turnsUntilPaid > 0);
  // If it began unpaid and we never saw a paying settle, it is still unpaid.
  const stillUnpaid = since != null;
  const unpaidAt = stillUnpaid ? since : null;
  const release = stillUnpaid && unpaidAt != null
    ? { turnsUntilRelease: Math.max(0, unpaidAt + DECAY_AFTER_BELLS - bell0), letting: graceOf(unpaidAt, bell0).letting }
    : turnsUntilUnpaid != null
      ? { turnsUntilRelease: turnsUntilUnpaid + DECAY_AFTER_BELLS, letting: false }
      : { turnsUntilRelease: null, letting: false };

  const sustainable = net >= 0 && !stillUnpaid;
  // (verify-pr272) Paid, short of food, but no unpaid settle within MAX_STEPS turns: "more than MAX_STEPS turns".
  const beyondTurns = !sustainable && !stillUnpaid && turnsUntilUnpaid == null ? MAX_STEPS : null;
  return snapshot({
    sustainable,
    unpaidAlready: stillUnpaid && wasUnpaid,
    turnsUntilUnpaid: stillUnpaid && wasUnpaid ? 0 : turnsUntilUnpaid,
    turnsUntilRelease: release.turnsUntilRelease,
    letting: release.letting,
    turnsUntilPaid: wasUnpaid && !stillUnpaid ? (turnsUntilPaid ?? 0) : (wasUnpaid ? turnsUntilPaid : null),
    beyondTurns,
  });
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

/** Compact HUD / popover line, or '' when there is nothing to say. */
export function horizonHudLine(h, rate) {
  if (!h || !(h.tiles > 0) || !(h.upkeepMilliPerHour > 0)) return '';
  if (h.sustainable) return L`いまの土地は、この食料の生産で維持できます。`;
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
  if (h.sustainable) {
    const room = h.headroom, max = h.tiles + (room ?? 0);
    if (room > 0) {
      return [L`いまの土地は、この食料の生産で維持できます。いまの距離なら、あと ${fmtNum(room)} マスまで維持できます（最大 ${fmtNum(max)} マス）。`];
    }
    if (room === 0) {
      return [L`いまの土地は、この食料の生産で維持できます。いまの距離なら、これ以上マスを増やしても維持できません。`];
    }
    return [L`いまの土地は、この食料の生産で維持できます。`];
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
