// What the relay adds to the SDK's shape allowlist (sdk frontier/shapes.mjs)
// before it signs anything (contract §8.3, I-51):
//
// * the fee payer is one of the relay pool's keys, and the instruction is
//   for this relay's program and season;
// * Depart's tip is one of the three presets {tip_min, ⌈1.5 tip_min⌉, 2 tip_min}
//   (else 400 TipNotPreset), and it arrives before the season's end bell
//   (else 400 ArrivalBell; W6T-3);
// * the drain guard: simulated with signatures, the fee payer may lose at most
//   the fee plus the kind's allowance — Join: rent(Citizen); FileTicket: the
//   Holding-rent escrow shortfall `max(0, rent(1,280) − citizen.ticket_escrow)`;
//   Depart: `tip + march_fee + seal_bond`; S1's BuildVault: rent(Vault);
//   BuildStructure: rent(Tower);
//   SendCaravan: rent(Caravan) + `CARAVAN_FEE` (the fee the program
//   escrows from the payer is the player's choice: a larger one is refused
//   here); every other kind, RaidCaravan and DefaultRaid included (a take
//   reroutes the raided caravan itself, decision J2) and SeizeStructure and
//   CloseStructure: 0; S2's IssueTickets: rent(Issue) + rent(Lot); GiveLot:
//   rent(Lot) (a whole-lot gift or an add-to moves none; the drain guard
//   sees the real amount);
// * who is charged: a player shape its citizen, a settle shape its
//   requester's citizen (the requester signed the request and is, on chain,
//   that citizen's wallet or unexpired session key), else the client-address
//   bucket; never the citizen the settle names.
import { addressBucket } from '../guards.mjs';
import { baseFee, departEscrow, rent, seasonTipMin, tipPresets } from '../../client/src/frontier/fees.mjs';
import { layoutOf } from '../../client/src/frontier/codec.mjs';
import { DEPART_TAG, FILE_TICKET_TAG, JOIN_TAG, PLACE_HOME_TAG, FILE_OUTPOST_TAG, DECLARE_SIEGE_TAG, BUILD_VAULT_TAG, SEND_CARAVAN_TAG, BUILD_STRUCTURE_TAG, PROPOSE_TAG, ISSUE_TICKETS_TAG, GIVE_LOT_TAG } from '../../client/src/frontier/shapes.mjs';
import { CARAVAN_FEE } from '../../client/src/frontier/budgets.mjs';
import { isS1, profileForSeason } from '../../client/src/frontier/profile.mjs';
import { RouteError } from '../routes/errors.mjs';

export const CITIZEN_RENT = rent(layoutOf('Citizen').size);
export const HOLDING_RENT = rent(layoutOf('Holding').size);
/** S1: a vault's rent, and what one caravan (or loot) may cost the fee payer: its rent and the settle fee. */
export const VAULT_RENT = rent(layoutOf('Vault', 2).size);
export const CARAVAN_COST = rent(layoutOf('Caravan', 2).size) + CARAVAN_FEE;
/** S1 stage 1d: a watchtower's rent. */
export const STRUCTURE_RENT = rent(layoutOf('Structure', 2).size);
/** S1 stage 1e: a Nation's rent (paid once a season by its first Propose). */
export const NATION_RENT = rent(layoutOf('Nation', 2).size);
/** S2 stage 2a: a ticket Issue's and a Lot's rent. */
export const ISSUE_RENT = rent(layoutOf('Issue', 2).size);
export const LOT_RENT = rent(layoutOf('Lot', 2).size);

/** Refuse unless `shape` (classified) may be sponsored by this relay for this season. */
export function checkRelayShape(shape, { pool, addresses }) {
  if (!pool.has(shape.feePayer)) throw new RouteError(400, 'relay refused: the fee payer is not one of this relay\'s (GET /f/relay names one)', 'RelayRejected');
  if (shape.accounts.season !== addresses.season) throw new RouteError(400, 'relay refused: not this season\'s instruction', 'RelayRejected');
}

/** The Depart tip must be a preset; returns the tip (bigint). */
export function checkDepartTip(shape, season) {
  const tip = BigInt(shape.data.tip);
  const presets = tipPresets(seasonTipMin(season));
  if (!presets.includes(tip)) {
    throw new RouteError(400, `a sponsored Depart tips one of ${presets.join(', ')} lamports`, 'TipNotPreset', { presets: presets.map(String) });
  }
  return tip;
}

/**
 * W6T-3 (w6-s7 criterion 1; contract §5.11 Depart step 4, v1.12): a Depart
 * whose arrival bell is at or after the season's `end_bell` can never be
 * anchored, gathered, resolved or settled; the program refuses it
 * (`ArrivalBell`) from the release after 7dcacdf. The relay refuses it
 * before the simulation, so it costs the player no quota. A Season with
 * `END_BELL` 0 (no end recorded) is not judged.
 */
export function checkDepartArrival(shape, season) {
  const end = BigInt(season?.END_BELL ?? 0);
  const arrive = BigInt(shape.data.arrive_bell);
  if (end > 0n && arrive >= end) {
    throw new RouteError(400, `a Depart must arrive before the season's end bell ${end} (arrive_bell ${arrive})`, 'ArrivalBell', { endBell: Number(end) });
  }
}

/**
 * Lamports (bigint) the fee payer may move for `shape` beyond the fee:
 * `{season, citizen}` are the decoded Season and (FileTicket) Citizen.
 */
export function allowanceFor(shape, { season, citizen = null }) {
  switch (shape.tag) {
    case JOIN_TAG: return CITIZEN_RENT;
    case PLACE_HOME_TAG: return HOLDING_RENT;
    case FILE_TICKET_TAG: {
      const escrow = citizen ? BigInt(citizen.TICKET_ESCROW) : 0n;
      return escrow >= HOLDING_RENT ? 0n : HOLDING_RENT - escrow;
    }
    // Existing escrow can be backing another capture slot. Bound new sponsorship
    // to one holding rent; the simulated actual drain is what the quota charges.
    case FILE_OUTPOST_TAG: case DECLARE_SIEGE_TAG: return HOLDING_RENT;
    case DEPART_TAG:
      checkDepartArrival(shape, season);
      return departEscrow(season, checkDepartTip(shape, season));
    case BUILD_VAULT_TAG: return VAULT_RENT;
    case SEND_CARAVAN_TAG: return CARAVAN_COST;
    case BUILD_STRUCTURE_TAG: return STRUCTURE_RENT;
    case PROPOSE_TAG: return NATION_RENT;
    case ISSUE_TICKETS_TAG: return ISSUE_RENT + LOT_RENT;
    case GIVE_LOT_TAG: return LOT_RENT;
    default: return 0n;
  }
}

/** The fee payer's cost of the transaction itself (base fee per signature; sponsored shapes pay no priority fee). */
export const feeOf = shape => baseFee(shape.signers.length);

/**
 * The drain guard: refuse unless `pre − post ≤ fee + allowance`. Returns
 * the lamports moved beyond the fee (what the lamport quota is charged).
 */
export function drainGuard({ pre, post, fee, allowance }) {
  if (post === null || post === undefined) throw new RouteError(502, 'the simulation did not report the fee payer\'s balance', 'SimulationIncomplete');
  const delta = BigInt(pre) - BigInt(post);
  if (delta > BigInt(fee) + BigInt(allowance)) {
    throw new RouteError(400, `relay refused: the fee payer would lose ${delta} lamports, more than the fee and the ${allowance} this kind may move`, 'RelayRejected',
      { drain: { delta: String(delta), allowed: String(BigInt(fee) + BigInt(allowance)) } });
  }
  return delta > BigInt(fee) ? delta - BigInt(fee) : 0n;
}

/**
 * Sponsored lamports a key may move per game day: 24 Depart escrows at the
 * top preset + the Citizen's and the Holding's rent. In an S1 season a
 * caravan counts like a Depart (the 24 are shared; each the larger of the
 * two costs) and one vault's, one structure's and one Nation's rent are
 * added (a first Propose pays its faction's Nation). An S2 season adds one
 * Issue's and four Lots' rent.
 */
export function lamportsPerDay(season, departs = 24) {
  const top = tipPresets(seasonTipMin(season))[2];
  const profile = profileForSeason(season);
  const s1 = isS1(profile);
  const s2 = profile >= 4;
  const depart = departEscrow(season, top);
  const each = s1 && CARAVAN_COST > depart ? CARAVAN_COST : depart;
  return BigInt(departs) * each + CITIZEN_RENT + HOLDING_RENT + (s1 ? VAULT_RENT + STRUCTURE_RENT + NATION_RENT : 0n)
    + (s2 ? ISSUE_RENT + 4n * LOT_RENT : 0n);
}

/**
 * The quota key a shape is charged to: a player shape its citizen; a settle
 * shape the citizen its requester was verified against (`requesterCitizen`,
 * the Citizen address whose wallet or unexpired session key signed the
 * request), else the client-address bucket. A requester key alone never
 * opens a bucket of its own (integ-W2 review of W2-D: a fresh key per
 * request escaped the quota).
 */
export function quotaKeyOf(shape, { requesterCitizen = null, ip }) {
  if (shape.kind === 'player' && shape.accounts.citizen) return `citizen:${shape.accounts.citizen}`;
  return requesterCitizen ? `citizen:${requesterCitizen}` : `addr:${addressBucket(ip)}`;
}
