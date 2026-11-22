// THE CLUSTER'S RENT, AS THE PAGE KNOWS IT (rent-live-rest). A rent deposit the page previews (the village ticket's
// escrow: one Holding's rent) is what the CLUSTER charges, and a cluster may charge another rate than the 5,080
// lamports per byte devnet and the local node charge today (the pre-SIMD-0194 6,960, a later SIMD-0437 step). So the
// page asks the cluster, through its own origin (the CSP lets it talk to nothing else):
//
//   POST /gw/f/devnet-play/act/context  {schema: 'frontier-play-rent-context-v1'}   (devnet play: the gateway's RPC)
//   POST /gw/f/local-play/act/context   {schema: 'frontier-play-rent-context-v1'}   (local play: the runner)
//     → {schema, holding_bytes: 1280, holding_rent: "<lamports>", lamports_per_byte: "<rate>" | null}
//
// ONE `getMinimumBalanceForRentExemption(1280)` on the gateway (a read; nothing is kept or sent): the very figure the
// program's FileTicket / FileOutpost moves for a Holding's rent. The answer is cached for RENT_FRESH_MS and asked again
// after RENT_RETRY_MS when it failed. Until a cluster has answered — and on a page with no such route (the sponsored
// demo) — the page shows the MODEL figure at 5,080 and SAYS it is a model (`rentSource(...) === 'model'`), never as the
// cluster's word. The other wallet-paid previews already ask the cluster per send: FileOutpost's (`holding_rent` of
// the outpost context) and the boundary departure's (`transit_rent` of the expedition context).
import { rentAt, rateOfMinimum, RENT_PER_BYTE } from '../sdk/frontier/fees.mjs';
import { ACCOUNTS } from './abi.mjs';

export const RENT_CONTEXT_SCHEMA = 'frontier-play-rent-context-v1';
/** layout Holding: the account a village ticket (FileTicket, FileOutpost) escrows one rent of. */
export const RENT_HOLDING_BYTES = ACCOUNTS.Holding.size;
/** A cluster's answer is used this long before it is asked again (the rate changes only by a feature gate). */
export const RENT_FRESH_MS = 10 * 60_000;
/** A failed or missing answer is asked again after this long (meanwhile the model figure, labelled). */
export const RENT_RETRY_MS = 60_000;
const U64 = /^(0|[1-9][0-9]{0,19})$/;

/** The model: 5,080 lamports per byte (fees.mjs RENT_PER_BYTE). Never the cluster's word. */
export const MODEL_RENT = Object.freeze({ source: 'model', perByte: RENT_PER_BYTE, holdingRent: rentAt(RENT_HOLDING_BYTES, RENT_PER_BYTE), at: 0, askedAt: 0, error: null });

/**
 * GATEWAY SIDE: the answer to `{schema: RENT_CONTEXT_SCHEMA}` from `ask(method, params)` (the route's own checked RPC
 * call, which throws its own unavailable error). One read; a malformed answer throws `bad()`'s error.
 */
export async function clusterRentAnswer(ask, bad) {
  const r = await ask('getMinimumBalanceForRentExemption', [RENT_HOLDING_BYTES, { commitment: 'confirmed' }]);
  const v = r?.result;
  if (!Number.isSafeInteger(v) || v <= 0) bad();
  const rate = rateOfMinimum(v, RENT_HOLDING_BYTES);
  return { schema: RENT_CONTEXT_SCHEMA, holding_bytes: RENT_HOLDING_BYTES, holding_rent: String(v), lamports_per_byte: rate === null ? null : String(rate) };
}

/**
 * PAGE SIDE: a gateway answer checked strictly → the cluster's rent `{source: 'cluster', perByte, holdingRent, at}`
 * (`perByte` null when the minimum is no whole multiple of 1,408: the holding figure is still the cluster's), or null.
 */
export function rentOfAnswer(v, now = Date.now()) {
  if (!v || typeof v !== 'object' || v.schema !== RENT_CONTEXT_SCHEMA || v.holding_bytes !== RENT_HOLDING_BYTES) return null;
  if (typeof v.holding_rent !== 'string' || !U64.test(v.holding_rent)) return null;
  const holdingRent = BigInt(v.holding_rent);
  if (holdingRent <= 0n || holdingRent >= 1n << 64n) return null;
  let perByte = null;
  if (v.lamports_per_byte !== null) {
    if (typeof v.lamports_per_byte !== 'string' || !U64.test(v.lamports_per_byte)) return null;
    perByte = BigInt(v.lamports_per_byte);
    // (the rate must state this very minimum: never two figures that disagree)
    if (rentAt(RENT_HOLDING_BYTES, perByte) !== holdingRent) return null;
  } else if (rateOfMinimum(holdingRent, RENT_HOLDING_BYTES) !== null) return null;
  return Object.freeze({ source: 'cluster', perByte, holdingRent, at: now, askedAt: now, error: null });
}

/** What the page uses now: the cluster's answer, else the model (labelled by its `source`). */
export const rentNow = r => (r?.source === 'cluster' ? r : MODEL_RENT);
/** One Holding's rent the page previews (the village ticket's escrow). */
export const holdingRentNow = r => rentNow(r).holdingRent;
/** 'cluster' | 'model' — the label the preview carries. */
export const rentSource = r => rentNow(r).source;

/**
 * Whether to ask the cluster now: never asked; the last ask failed RENT_RETRY_MS ago or more; or the cluster's answer
 * was read RENT_FRESH_MS ago or more.
 */
export function rentDue(r, now = Date.now()) {
  if (!r) return true;
  const since = now - (r.askedAt ?? 0);
  return r.source === 'cluster' && !r.error ? since >= RENT_FRESH_MS : since >= RENT_RETRY_MS;
}

/**
 * A failed ask: remembered (`error`, `askedAt`) so it is not asked again before RENT_RETRY_MS. A cluster answer read
 * before is kept (a rate changes only by a feature gate; the label still says when it was read), else the model.
 */
export function rentFailed(prev, code, now = Date.now()) {
  const base = prev?.source === 'cluster' ? prev : MODEL_RENT;
  return Object.freeze({ ...base, askedAt: now, error: String(code ?? 'Unavailable') });
}
