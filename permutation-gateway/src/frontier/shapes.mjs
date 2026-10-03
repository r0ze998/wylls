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
//   Depart: `tip + march_fee + seal_bond`; every other kind: 0;
// * who is charged: the citizen the signer was verified against (a player
//   shape's authority or a settle shape's requester is, on chain, that
//   citizen's wallet or unexpired session key), else a hashed client-address
//   bucket; never a citizen a shape merely names.
import { createHmac, randomBytes } from 'node:crypto';
import { addressBucket } from '../guards.mjs';
import { baseFee, departEscrow, rent, seasonTipMin, tipPresets } from '../../client/src/frontier/fees.mjs';
import { layoutOf } from '../../client/src/frontier/codec.mjs';
import { DEPART_TAG, FILE_TICKET_TAG, JOIN_TAG } from '../../client/src/frontier/shapes.mjs';
import { RouteError } from '../routes/errors.mjs';

export const CITIZEN_RENT = rent(layoutOf('Citizen').size);
export const HOLDING_RENT = rent(layoutOf('Holding').size);

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
    case FILE_TICKET_TAG: {
      const escrow = citizen ? BigInt(citizen.TICKET_ESCROW) : 0n;
      return escrow >= HOLDING_RENT ? 0n : HOLDING_RENT - escrow;
    }
    case DEPART_TAG:
      checkDepartArrival(shape, season);
      return departEscrow(season, checkDepartTip(shape, season));
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

/** Sponsored lamports a key may move per game day: 24 Depart escrows at the top preset + the Citizen's and the Holding's rent. */
export function lamportsPerDay(season, departs = 24) {
  const top = tipPresets(seasonTipMin(season))[2];
  return BigInt(departs) * departEscrow(season, top) + CITIZEN_RENT + HOLDING_RENT;
}

/**
 * PT-E: the address bucket never reaches the quota book, the state file or
 * the log as an address. The key is `addr:` + 16 hex of an HMAC-SHA256 of the
 * bucket under a random salt made when the process starts and kept in memory
 * only (so nothing on disk can be turned back into an address, and an
 * anonymous requester's bucket simply starts fresh after a restart).
 */
const ADDR_SALT = randomBytes(32);
export const addrKey = ip => `addr:${createHmac('sha256', ADDR_SALT).update(addressBucket(ip)).digest('hex').slice(0, 16)}`;

/**
 * The quota key a shape is charged to: `citizen:<address>` when `citizen` is
 * the Citizen the signing key was verified against on chain (a settle's
 * requester; a player shape's authority: its wallet, or its unexpired
 * session key; relay.mjs `verifiedCitizen`), else the hashed client-address
 * bucket (`addrKey`). A key alone never opens a bucket of its own (integ-W2
 * review of W2-D: a fresh key per request escaped the quota), and the
 * citizen a shape merely names is never trusted (PT-E: a made-up citizen
 * would put an entry in the state file for every junk request).
 */
export function quotaKeyOf(shape, { requesterCitizen = null, ip }) {
  return requesterCitizen ? `citizen:${requesterCitizen}` : addrKey(ip);
}
