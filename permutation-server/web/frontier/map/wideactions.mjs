// Unsigned protocol review only. Observations are not authenticated live
// accounts. Never pass this object to the legacy relay, wallet or marchbook.
import { wideHistoryIdentity } from './widehistory.mjs';
import { worldIdOf, WideError } from './wide.mjs';
import { fromHex, toHex } from '../../sdk/bytes.mjs';
const reviews = new WeakSet();
const check = (ok, code) => { if (!ok) throw new WideError(code, code); };
const identity = (v, world, host = false) => wideHistoryIdentity({ ...v, p:String(v?.p), q:String(v?.q) }, world, host);
export const WIDE_ACTION_BLOCKERS = Object.freeze({
  depart: 'WideDepartProductionDisabled',
  return: 'WideLiveAccountsUnverified',
});
/** Review a host observed in a pinned, parsed history page, not a live host.
 * WideReturn acts on the holding/roster, not one host. Its host identity is
 * context only; no host bytes are appended to the ABI's four-byte envelope.
 */
export function wideActionReview({ pins, page, event, destination = null }) {
  const world = worldIdOf(pins.seasonAddress, pins.programId);
  check(page?.world === world && page.captureVerification === 'unverified' && page.sourceCoverage === 'unknown', 'WorldMismatch');
  check(typeof page.snapshot === 'string' && /^[0-9a-f]{64}$/.test(page.snapshot), 'BadWideHistory');
  const row = page.rows.find(r => r.event === event);
  check(row?.format === 'PSW1' && row.host && row.holding, 'WideHostObservationRequired');
  const host = identity(row.host, world, true), holding = identity(row.holding, world, true), province = identity(row.province, world);
  check(holding.hostSequence === 0 && host.keyHex.slice(0,104) === holding.keyHex.slice(0,104), 'WideHoldingMismatch');
  check(row.body instanceof Uint8Array && row.body[0] === 0x82 && toHex(row.body.slice(6,62)) === host.keyHex && toHex(row.body.slice(62,112)) === province.keyHex, 'BadWideHistory');
  if (destination) {
    check(destination.wide && !destination.legacy, 'MixedLegacyWideUnsupported');
    check(destination.wide.world === world, 'WorldMismatch');
  }
  const review = Object.freeze({ kind:'wide-unsigned-review', world, snapshot:page.snapshot,
    indexedThrough:String(page.through), event:String(event), host:host.keyHex,
    holding:holding.keyHex, province:province.keyHex,
    captureVerification:'unverified', executable:false,
    depart:Object.freeze({enabled:false, code:WIDE_ACTION_BLOCKERS.depart}),
    return:Object.freeze({enabled:false, code:WIDE_ACTION_BLOCKERS.return,
      instructionDataHex:'dcff0102', scope:'holding-roster',
      requiredAccounts:Object.freeze(['payer (signer, writable)', 'season', 'standing province (writable)', 'standing roster (writable)', 'issuing holding (writable)', 'transit 0', 'transit 1', 'transit 2', 'transit 3', 'issuing province (when foreign)'])}),
  });
  reviews.add(review);
  return review;
}
/** Exact provisional WideDepart instruction data. Caller supplies already
 * prepared public commitment/seal; this neither seals nor signs anything.
 * Building bytes does NOT enable execution or authenticate the observation.
 */
export function wideDepartData(review, { transitSlot, arriveBell, tip, commit, seal }) {
  check(reviews.has(review) && review.executable === false, 'WideReviewRequired');
  check(Number.isInteger(transitSlot) && transitSlot >= 0 && transitSlot < 4, 'BadTransitSlot');
  check(Number.isInteger(arriveBell) && arriveBell >= 0 && arriveBell <= 0xffffffff, 'BadArrivalBell');
  check(typeof tip === 'bigint' && tip >= 0n && tip <= 0xffffffffffffffffn, 'BadTip');
  check(commit instanceof Uint8Array && commit.length === 32 && seal instanceof Uint8Array && seal.length === 264, 'BadWideSeal');
  check(/^[0-9a-f]{112}$/.test(review.host), 'BadWideHost');
  const data = new Uint8Array(366), v = new DataView(data.buffer);
  data[0] = 0xda; data.set(fromHex(review.host), 1); data[57] = transitSlot;
  v.setUint32(58, arriveBell, true); v.setBigUint64(62, tip, true);
  data.set(commit, 70); data.set(seal, 102);
  return data;
}
