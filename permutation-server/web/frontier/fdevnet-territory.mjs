// DEVNET PLAY (devnet-territory-dev; owner NWP-2, 2026-11-24 19:28: the new world only once territory is playable on
// devnet — "the devnet page can send claims") — the single-tile claim (WideClaimTile 0xDA op 7, flocalplay-territory.mjs)
// on a devnet TERRITORY world, wallet-paid, two presses as the outpost and wide village cards:
//   1. preview: the gateway's word for this cluster (POST /gw/f/devnet-play/act/context, TERRITORY_CONTEXT_SCHEMA): the
//      rent of the province's territory record (672 bytes) and of the player's summary (320 bytes) — each created from
//      the claimer's wallet when absent (owner TQ-12 (a), 21:51: the claimer pays) —, the claimer's tiles (the ore price
//      of the next tile: 10 + 2 % per tile owned, owner TQ-3), whether the province is there; nothing signed;
//   2. send: within TILE_PREVIEW_MS, the same wallet, target and tile: ONE wallet-signed claim through the devnet lane.
// Upkeep (food from the first home), decay and the conquest transfer are keeper A's `territory` role; the page never sends
// them. Pure helpers only: no read, no send, no DOM.
import { claimCostV1, TERRITORY_V1 } from './flocalplay-territory.mjs';

export const TERRITORY_CONTEXT_SCHEMA = 'frontier-devnet-play-territory-context-v1';
/** One signature's base fee (lamports): the claim's only signer is the wallet (fee payer AND actor). */
export const TILE_FEE = 5000n;
/** How long a preview may be sent from (as the wide village card's). */
export const TILE_PREVIEW_MS = 120_000;

const lamports = v => typeof v === 'string' && /^(0|[1-9][0-9]{0,15})$/.test(v);

/** The gateway's territory context `ctx` for `wallet`, checked (false when any field is missing or of another wallet). */
export function tileContextOk(ctx, wallet) {
  return !!ctx && typeof ctx === 'object' && ctx.wallet === wallet && lamports(ctx.province_rent) && lamports(ctx.player_rent)
    && typeof ctx.province_present === 'boolean' && typeof ctx.player_present === 'boolean' && typeof ctx.wide_province_present === 'boolean'
    && Number.isSafeInteger(ctx.tiles) && ctx.tiles >= 0 && typeof ctx.unpaid === 'boolean';
}

/**
 * What one tile costs, from a checked context: `{ore, deposit, fee, total, provinceNew, playerNew}` — ore from the first
 * home's store (whole units), lamports (BigInt) from the wallet: the records the claim creates, and the fee.
 */
export function tileClaimCost(ctx) {
  const provinceNew = !ctx.province_present, playerNew = !ctx.player_present;
  const provinceDeposit = provinceNew ? BigInt(ctx.province_rent) : 0n, playerDeposit = playerNew ? BigInt(ctx.player_rent) : 0n;
  const deposit = provinceDeposit + playerDeposit;
  return Object.freeze({ ore: claimCostV1(ctx.tiles), deposit, provinceDeposit, playerDeposit, fee: TILE_FEE, total: deposit + TILE_FEE, provinceNew, playerNew });
}

/** Why a checked context refuses the claim before anything is signed (null when it may go on). */
export function tileContextRefusal(ctx, { ore = null } = {}) {
  if (!ctx.wide_province_present) return 'LocalActProvinceAbsent';
  // (owner T-5: unpaid upkeep stops new claims; the program answers NotEligible)
  if (ctx.unpaid) return 'TileUnpaid';
  if (ore !== null && Number.isFinite(ore) && ore < claimCostV1(ctx.tiles)) return 'TileOre';
  return null;
}

/** The preview `pv` may be sent now for `{wallet, target, tile}` (same wallet, province and tile, not stale). */
export function tilePreviewFresh(pv, { wallet, target, tile, now = Date.now() }) {
  return !!pv && pv.step === 'preview' && pv.wallet === wallet && pv.target?.p === String(target.p) && pv.target?.q === String(target.q)
    && pv.tile === tile && now - pv.at <= TILE_PREVIEW_MS;
}

/** The decided per-tile upkeep (milli-food per hour) at distance `dist`, for the preview's line. */
export const tileUpkeepMilli = dist => TERRITORY_V1.upkeep.flat + TERRITORY_V1.upkeep.perDistance * Math.max(0, dist - TERRITORY_V1.upkeep.freeDistance);

/**
 * (territory-card, owner Q-PDT-1 (a)) The viewer's own land for the village card on a devnet territory world: the
 * gateway's read-only word (POST /gw/f/devnet-play/act/context, LAND_SUMMARY_SCHEMA, `{schema, wallet}`) — ONE read of
 * the wallet's own territory summary, nothing signed, nothing kept. A gateway older than this answers LocalActInvalid:
 * the card then shows no land line, as before.
 */
export const LAND_SUMMARY_SCHEMA = 'frontier-devnet-play-territory-summary-v1';
const u32ok = v => Number.isSafeInteger(v) && v >= 0 && v <= 0xffffffff;
/** The gateway's land summary `ctx` for `wallet`, checked (false when any field is missing or of another wallet). */
export function landSummaryOk(ctx, wallet) {
  return !!ctx && typeof ctx === 'object' && ctx.schema === LAND_SUMMARY_SCHEMA && ctx.wallet === wallet && typeof ctx.player_present === 'boolean'
    && u32ok(ctx.tiles) && typeof ctx.excess_sum === 'string' && /^(0|[1-9][0-9]{0,15})$/.test(ctx.excess_sum) && typeof ctx.unpaid === 'boolean'
    && (ctx.unpaid ? u32ok(ctx.unpaid_since) : ctx.unpaid_since === null) && (ctx.player_present || (ctx.tiles === 0 && ctx.excess_sum === '0' && !ctx.unpaid));
}
/** A checked land summary as the record view `ownLandView` reads (null: no record yet). */
export function landOfSummary(ctx) {
  if (!ctx.player_present) return null;
  const u = TERRITORY_V1.upkeep;
  return Object.freeze({ tiles: ctx.tiles, unpaid: ctx.unpaid, unpaidSince: ctx.unpaid ? ctx.unpaid_since : null, excessSum: Number(ctx.excess_sum),
    upkeepMilliPerHour: ctx.tiles * u.flat + u.perDistance * Number(ctx.excess_sum) });
}
