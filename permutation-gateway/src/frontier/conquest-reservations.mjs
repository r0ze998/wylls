// PREPARED, NOT CONNECTED. The reservation region of the wide conquest table (decision B), read for the card.
//
// PROVISIONAL LAYOUT: taken from docs/integration/CLAUDE-CONQUEST-RESERVATION-SPEC-20261112.md §4.1 and the ABI source
// as read on 2026-11-12 (frontier-abi/src/world_index/conquest.rs `Reservation::write`). The owner's contract is not
// final. Checked so far: the ABI codec's own vectors (CLAUDE-CONQUEST-RESERVATION-VECTORS-20261112.json, synthetic;
// frontier-conquest-reservation-vectors.test.mjs). NOT checked: a table read from a chain. Therefore:
//   - nothing imports this module: no route, no relay, no page reads a table through it;
//   - `RESERVATION_LAYOUT_CHECKED` says exactly which of the two has been done; it opens nothing by itself;
//   - it reads bytes it is handed and nothing else: no RPC, no key, no send.
//
// What a table record can and cannot say (this bounds what the card may show from it):
//   PENDING                          → the order waits for its turn
//   NOT_APPLIED, done bits           → did not take effect; which of resources / slot-and-rent is still owed
//   a record that is GONE            → nothing by itself: it applied (a site entry appeared) or its return completed
//                                      (its settlement). A missing record is never read as "returned".
//   HOW a NOT_APPLIED one ended      → not in the record, and NOT readable from the refund receipt or the PSWR log either
//                                      (the outcome is only committed inside a digest): null unless the caller has
//                                      a verified state difference, or a full replay of the settlement's digest from account snapshots
//   whether the source Holding is there → not in the record (its own account says)
import { encode } from '../../../permutation-server/web/sdk/base58.mjs';

export const RESERVATION_LAYOUT_CHECKED = Object.freeze({ abiCodecVector: true, chainTable: false });
export const CONQUEST_TABLE_SIZE = 2688;
export const RESERVATION_REGION_OFFSET = 1664;
export const RESERVATION_RECORD_SIZE = 128;
export const RESERVATION_RECORDS = 8;
export const NEXT_SEQ_OFFSET = 120;
export const RES_PENDING = 1, RES_NOT_APPLIED = 2;
export const RES_RESOURCES_RETURNED = 1, RES_SLOT_RENT_RELEASED = 2;

const fail = code => { throw Object.assign(new Error(code), { code }); };
const check = (ok, code) => { if (!ok) fail(code); };

/**
 * The reservation records of one conquest table account's bytes, in record order (free records omitted), or throws a
 * code. Checked here: the size; each record all-zero (free) or well-formed (status, done bits for its status, zero
 * padding, site < 12, faction < 6, slot 2 or 3, bell > 0, a Citizen); seq below the table's counter and unique; one
 * (Citizen, slot) among the records that still hold their slot. NOT checked here (the program's, on its own reads):
 * the table's header and site entries, the host reference's world and generation, the actor tag, the province flag.
 * → [{index, status: 'pending' | 'not_applied', site, entry, slot, faction, resourcesReturned, slotRentReleased,
 *     bell, seq, citizen, goldMilli, armsMilli}] (frozen; u64 amounts as decimal strings).
 */
export function decodeReservationRegion(bytes) {
  check(bytes instanceof Uint8Array && bytes.length === CONQUEST_TABLE_SIZE, 'ReservationTableSize');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const next = view.getUint32(NEXT_SEQ_OFFSET, true);
  check(bytes.subarray(124, 128).every(x => x === 0), 'ReservationTableReserved');
  const out = [], seqs = new Set(), slots = new Set();
  for (let i = 0; i < RESERVATION_RECORDS; i++) {
    const o = RESERVATION_REGION_OFFSET + i * RESERVATION_RECORD_SIZE, r = bytes.subarray(o, o + RESERVATION_RECORD_SIZE);
    if (r.every(x => x === 0)) continue;
    const [status, site, entry, slot, faction, done] = r;
    check(r[6] === 0 && r[7] === 0, 'ReservationRecordReserved');
    check(status === RES_PENDING || status === RES_NOT_APPLIED, 'ReservationRecordStatus');
    // (PENDING carries no done bit; NOT_APPLIED carries at most one: with both, the program frees the record)
    check(status === RES_PENDING ? done === 0 : (done & ~3) === 0 && done !== 3, 'ReservationRecordDone');
    const bell = view.getUint32(o + 8, true), seq = view.getUint32(o + 12, true), citizen = r.subarray(16, 48);
    check(site < 12 && faction < 6 && (slot === 2 || slot === 3) && bell > 0 && citizen.some(x => x !== 0), 'ReservationRecordField');
    check(seq < next && !seqs.has(seq), 'ReservationRecordSeq');
    seqs.add(seq);
    const who = encode(citizen), resourcesReturned = (done & RES_RESOURCES_RETURNED) !== 0, slotRentReleased = (done & RES_SLOT_RENT_RELEASED) !== 0;
    if (status === RES_PENDING || !slotRentReleased) { const k = `${who}:${slot}`; check(!slots.has(k), 'ReservationRecordSlot'); slots.add(k); }
    out.push(Object.freeze({ index: i, status: status === RES_PENDING ? 'pending' : 'not_applied', site, entry, slot, faction, resourcesReturned, slotRentReleased,
      bell, seq, citizen: who, goldMilli: view.getBigUint64(o + 112, true).toString(), armsMilli: view.getBigUint64(o + 120, true).toString() }));
  }
  return Object.freeze(out);
}

/**
 * The page's closed statement of facts (fconquest-order.mjs `siegeOrderModel`) for ONE record, of the province the
 * table belongs to. Only what the record says: how a NOT_APPLIED one ended and whether its source Holding is there
 * are given by the caller from their own authenticated reads, or left null (not known) — never guessed here.
 *   `more`: {lapsed: true | false | null, source: 'present' | 'absent' | null}; for a PENDING record both must be null.
 */
export function reservationFacts(record, standing, { lapsed = null, source = null } = {}) {
  check(record !== null && typeof record === 'object' && ['pending', 'not_applied'].includes(record.status), 'ReservationFactsRecord');
  check(standing !== null && typeof standing === 'object' && typeof standing.p === 'string' && typeof standing.q === 'string', 'ReservationFactsStanding');
  check([null, true, false].includes(lapsed) && [null, 'present', 'absent'].includes(source), 'ReservationFactsMore');
  const base = { site: record.site, standing: { p: standing.p, q: standing.q }, order_bell: String(record.bell), reason: null, capture: null, day: null };
  if (record.status === 'pending') {
    check(lapsed === null && source === null, 'ReservationFactsMore');
    return { phase: 'ordered', ...base, decided_bell: null, lapsed: null, source: null, stake: 'held', slot: 'held' };
  }
  // (a deposit already returned went to a Holding that was there: "absent" can only stand beside a deposit still owed)
  check(!(source === 'absent' && record.resourcesReturned), 'ReservationFactsMore');
  return { phase: 'not_applied', ...base, decided_bell: lapsed === false ? String(record.bell) : null, lapsed, source,
    stake: record.resourcesReturned ? 'returned' : 'held', slot: record.slotRentReleased ? 'released' : 'held' };
}
