// Local play only, DISPLAY ONLY (the read it serves is closed with the conquest routes): what the expedition card may say about a RESERVED siege (decision B of
// 2026-11-12: the player's signed step records a pending siege order; the turn's own processing applies it).
//
// The rules as the player approved them, and nothing more:
//   - a reservation becomes a siege only if its conditions hold when its turn is processed;
//   - if it does not, the deposit and the holding slot are returned, and the day's declaration count stays used;
//   - several reservations on one city: the first that meets the conditions when the turn is processed becomes the
//     siege; the others are "did not start" (returned as above);
//   - a reservation cannot be cancelled.
//
// NO ACCOUNT, RECEIPT OR LOG IS READ HERE. `siegeOrderRead` checks the relay's read-only answer (the relay reads and
// verifies the accounts: local-play-conquest-orders.mjs) against the narrow contract pinned below. Nothing in this
// file guesses a layout, a receipt or an address, and nothing here prepares, signs or sends.
//
// `siegeOrderModel` takes the page's OWN closed statement of facts (the shape this page asks the contract to be
// mappable onto; docs/integration/FABLE-CONQUEST-ORDER-B-CONTRACT-20261112.md) and gives the card's model, or refuses.
// A statement that contradicts itself or the approved rules is refused whole: the card then says the state could not
// be read. It never falls back to a success, and a capture is only ever the three capture facts together.

/**
 * The contract of the reservation read this page accepts: the local-play relay's read-only answer
 * (permutation-gateway/src/frontier/local-play-conquest-orders.mjs). What that read can bear out is narrow, and this
 * page accepts nothing wider from it: `ordered` and `not_applied` with its two owed parts, and NO statement of how a
 * reservation ended, of its source Holding, of a reason, or of the day's count. A started siege, a completed return
 * and a capture are not in this contract at all: an order of any other phase in an answer refuses the whole answer.
 * Pinning this opens nothing: the route exists only while the relay's conquest routes do, and the page asks it only
 * while its own conditions hold (flocalplay-conquest.mjs).
 */
export const SIEGE_ORDER_CONTRACT = Object.freeze({ schema: 'frontier-local-play-conquest-orders-v2', phases: Object.freeze(['ordered', 'not_applied']),
  cityStates: Object.freeze(['siege', 'capture_due', 'owned', 'slot_owed', 'other']) });

/**
 * The PRESENT state of this start's city, as the relay's read gives it (`siege` of the answer): positive facts of one
 * context of accounts, never history. → the card's model (frozen), `null` for "nothing stands there", or throws.
 *   siege        {site, progress, required, declaredBell}   this wallet's siege under way: its own numbers
 *   capture_due  {site, dueBell, declaredBell}              complete; the capture is due from that turn (no progress)
 *   owned        {site, slot, generation}                   this wallet's Citizen holds a Holding there NOW
 *   slot_owed    {site, slot}                               an entry of this wallet with only a slot owed back
 *   other        {site, what}                               another player's: siege | capture_due | slot_owed | holding
 * `owned` is a statement about the present. It is NOT the `captured` phase of `siegeOrderModel` (a past capture,
 * which keeps its three capture facts — receipt, Holding, slot — and is never produced by this read), and it does not
 * say how the Holding came to be this wallet's.
 */
export function cityStateModel(value) {
  const bad = () => { throw Object.assign(new Error('SiegeCityStateMalformed'), { code: 'SiegeCityStateMalformed' }); };
  if (value === null) return null;
  if (!object(value) || !SIEGE_ORDER_CONTRACT.cityStates.includes(value.state) || !Number.isInteger(value.site) || value.site < 0 || value.site > 11) bad();
  const int = (x, lo, hi) => Number.isInteger(x) && x >= lo && x <= hi, s = value;
  if (s.state === 'siege') {
    if (!exact(s, ['state', 'site', 'progress', 'required', 'declared_bell']) || !int(s.required, 1, 255) || !int(s.progress, 0, s.required - 1) || !u64(s.declared_bell)) bad();
    return Object.freeze({ state: 'siege', site: s.site, progress: s.progress, required: s.required, declaredBell: s.declared_bell });
  }
  if (s.state === 'capture_due') {
    if (!exact(s, ['state', 'site', 'due_bell', 'declared_bell']) || !u64(s.due_bell) || !u64(s.declared_bell) || BigInt(s.due_bell) <= BigInt(s.declared_bell)) bad();
    return Object.freeze({ state: 'capture_due', site: s.site, dueBell: s.due_bell, declaredBell: s.declared_bell });
  }
  if (s.state === 'owned') {
    if (!exact(s, ['state', 'site', 'slot', 'generation']) || !(s.slot === 2 || s.slot === 3) || !int(s.generation, 1, 254)) bad();
    return Object.freeze({ state: 'owned', site: s.site, slot: s.slot, generation: s.generation });
  }
  if (s.state === 'slot_owed') {
    if (!exact(s, ['state', 'site', 'slot']) || !(s.slot === 2 || s.slot === 3)) bad();
    return Object.freeze({ state: 'slot_owed', site: s.site, slot: s.slot });
  }
  if (!exact(s, ['state', 'site', 'what']) || !['siege', 'capture_due', 'slot_owed', 'holding'].includes(s.what)) bad();
  return Object.freeze({ state: 'other', site: s.site, what: s.what });
}

export const SIEGE_ORDER_PHASES = Object.freeze(['ordered', 'started', 'not_applied', 'captured', 'lost', 'unresolved']);
/**
 * The program stores NO reason for a reservation that did not start. A reason is therefore optional and, when given,
 * is one DERIVED from authenticated state by whoever built the statement: the card says so and never states it as the
 * recorded cause. These are the derived reasons this page has words for; another well-formed code is shown as itself.
 */
export const SIEGE_ORDER_REASONS = Object.freeze(['HostGone', 'HostNotOnTile', 'HostNotLeading', 'CityNotFree', 'AnotherOrderApplied', 'NoHoldingSlot', 'TooLate']);

import { parseWideInt } from './map/wide.mjs';

const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const exact = (x, keys) => object(x) && Object.keys(x).length === keys.length && keys.every(k => Object.hasOwn(x, k));
const u64 = x => typeof x === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(x) && BigInt(x) <= 0xffff_ffff_ffff_ffffn;
// (a wide coordinate as the existing codec reads it: a canonical signed decimal within ±2^62; (-129, 0) is as good as (129, 0))
const coord = x => { try { parseWideInt(x); return true; } catch { return false; } };
const code = x => typeof x === 'string' && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(x);
const no = c => Object.freeze({ ok: false, code: c });

/**
 * The relay's answer to the reservation read, believed in nothing: `expect` is what THIS page asked about
 * (`{program, season, wallet, standing: {p, q}}`), and the answer must echo exactly that. Every order's facts go
 * through `siegeOrderModel`, and must be of the contract's phases with nothing said beyond what a table record says.
 * → `{ok: true, contextSlot, tableAddress, table: 'present' | 'absent', orders: [{seq, model}], city}` (frozen; `city`
 * is `cityStateModel` of the answer's `siege`), or
 * `{ok: false, code}`. One bad order refuses the whole answer: nothing partial is shown.
 */
export function siegeOrderRead(value, expect) {
  try {
    if (!exact(value, ['schema', 'context_slot', 'program', 'season', 'wallet', 'standing', 'table_address', 'table', 'orders', 'siege']) || value.schema !== SIEGE_ORDER_CONTRACT.schema) return no('SiegeOrderAnswerMalformed');
    if (!object(expect) || !exact(expect.standing, ['p', 'q']) || value.program !== expect.program || value.season !== expect.season || value.wallet !== expect.wallet
        || !exact(value.standing, ['p', 'q']) || value.standing.p !== expect.standing.p || value.standing.q !== expect.standing.q) return no('SiegeOrderAnswerScope');
    if (!u64(value.context_slot) || typeof value.table_address !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value.table_address) || !['present', 'absent'].includes(value.table)
        || !Array.isArray(value.orders) || value.orders.length > 8 || (value.table === 'absent' && value.orders.length !== 0)) return no('SiegeOrderAnswerMalformed');
    const orders = [];
    let last = -1;
    for (const o of value.orders) {
      if (!exact(o, ['seq', 'facts']) || !Number.isInteger(o.seq) || o.seq <= last || o.seq > 0xffff_ffff) return no('SiegeOrderAnswerMalformed');
      last = o.seq;
      const model = siegeOrderModel(o.facts);
      if (model.ok !== true) return no(model.code);
      // (only what a table record bears out: no other phase, nothing of how it ended, of its source, of a reason, of the day)
      if (!SIEGE_ORDER_CONTRACT.phases.includes(model.phase) || model.lapsed !== null || model.source !== null || model.reason !== null || model.day !== null) return no('SiegeOrderAnswerBeyondEvidence');
      if (model.standing.p !== expect.standing.p || model.standing.q !== expect.standing.q) return no('SiegeOrderAnswerScope');
      orders.push(Object.freeze({ seq: o.seq, model }));
    }
    // (the city's present state: a malformed one refuses the whole answer, like a bad order. An entry needs a table:
    //  a siege, a capture due or a slot owed — this wallet's or another's — cannot stand with no table observed)
    let city; try { city = cityStateModel(value.siege); } catch { return no('SiegeCityStateMalformed'); }
    if (city !== null && value.table === 'absent' && !(city.state === 'owned' || (city.state === 'other' && city.what === 'holding'))) return no('SiegeCityStateMalformed');
    return Object.freeze({ ok: true, contextSlot: value.context_slot, tableAddress: value.table_address, table: value.table, orders: Object.freeze(orders), city });
  } catch { return no('SiegeOrderAnswerMalformed'); }
}

/**
 * The card's model of one siege order from the page's closed statement of facts:
 *   {phase, site, standing: {p, q}, order_bell, decided_bell, reason, lapsed, source, stake, slot, capture, day}
 *   phase         ordered | started | not_applied | captured | lost | unresolved
 *   order_bell    the turn the order is for (decimal string)
 *   decided_bell  null while ordered; otherwise the turn whose processing decided the phase (never before order_bell;
 *                 an order applies at exactly its own turn, so started / not_applied carry order_bell itself) — and
 *                 null for a not_applied that no turn decided (`lapsed` true) or whose way of ending is not known
 *                 (`lapsed` null)
 *   reason        null (the usual case: none is stored), or only for not_applied a DERIVED reason code
 *   lapsed        only for not_applied. false: its own turn was processed and it did not apply. true: it could never be
 *                 applied any more because the season ended or was interrupted — ONLY on
 *                 a verified state difference, or a full replay of the settlement's digest from account snapshots: the refund
 *                 receipt and the PSWR log commit the outcome inside a digest and carry no readable lapse mark. null: the
 *                 statement has NO basis for either (a record alone does not say) — then nothing is said of how
 *   source        only for not_applied: whether the Holding the deposit came from still exists — 'present' | 'absent'
 *                 | null (not known). 'absent' is only ever a deposit still owed: nothing is returned to a missing Holding
 *   stake         held | returned | burnt      slot   held | released | used
 *   capture       only for captured: {receipt, holding, slot}, all true (the capture receipt, the new Holding at the
 *                 canonical position, the Citizen's slot)
 *   day           null | {used, limit}: the day's declaration count after this order
 * → `{ok: true, phase, site, standing, orderBell, decidedBell, reason, lapsed, source, stake, slot, settled, day}` (frozen) or
 * `{ok: false, code}`. `settled`: neither the deposit nor the slot is still waiting on a settlement (not_applied: deposit returned AND
 * slot released; captured with the deposit still held is NOT settled — what a capture does with the deposit is the
 * contract's to say, and is checked against it when it is pinned).
 */
export function siegeOrderModel(facts) {
  const bad = no('SiegeOrderFactsInconsistent');
  try {
    if (!exact(facts, ['phase', 'site', 'standing', 'order_bell', 'decided_bell', 'reason', 'lapsed', 'source', 'stake', 'slot', 'capture', 'day'])) return no('SiegeOrderFactsMalformed');
    const { phase, site, standing, order_bell: ob, decided_bell: db, reason, lapsed, source, stake, slot, capture, day } = facts;
    if (!SIEGE_ORDER_PHASES.includes(phase) || !Number.isInteger(site) || site < 0 || site > 11 || !exact(standing, ['p', 'q']) || !coord(standing.p) || !coord(standing.q)
        || !u64(ob) || !(db === null || u64(db)) || !(reason === null || code(reason)) || ![null, true, false].includes(lapsed) || ![null, 'present', 'absent'].includes(source) || !['held', 'returned', 'burnt'].includes(stake) || !['held', 'released', 'used'].includes(slot)
        || !(capture === null || exact(capture, ['receipt', 'holding', 'slot'])) || !(day === null || exact(day, ['used', 'limit']))) return no('SiegeOrderFactsMalformed');
    if (day !== null && !(Number.isInteger(day.used) && Number.isInteger(day.limit) && day.limit >= 1 && day.used >= 1 && day.used <= day.limit)) return bad;   // (this order itself used one)
    const failed = phase === 'not_applied';
    if (!failed && (lapsed !== null || source !== null)) return bad;
    // (no turn decided an order still waiting, one that lapsed with the season, or one whose way of ending is not known)
    if ((phase === 'ordered' || (failed && lapsed !== false)) !== (db === null)) return bad;
    if (db !== null && BigInt(db) < BigInt(ob)) return bad;
    if ((phase === 'started' || (failed && lapsed === false)) && db !== ob) return bad;   // (an order applies, or fails to, at exactly its own turn)
    // (none is stored: not_applied with no reason is the ordinary, valid statement; a derived reason is one of a turn's processing)
    if (reason !== null && !(failed && lapsed === false)) return bad;
    // (nothing is ever returned to a Holding that is not there: its deposit is still owed)
    if (source === 'absent' && stake !== 'held') return bad;
    if ((phase === 'captured') !== (capture !== null)) return bad;
    // what each phase may say of the deposit and the slot
    if ((phase === 'ordered' || phase === 'started') && !(stake === 'held' && slot === 'held')) return bad;
    // (approved rule: an order that did not start loses nothing but the day's count; its deposit is never burnt, its slot never used)
    if (phase === 'not_applied' && !(stake !== 'burnt' && slot !== 'used')) return bad;
    // (a capture is the three facts together, and the slot is the one the new Holding uses)
    if (phase === 'captured' && !(capture.receipt === true && capture.holding === true && capture.slot === true && slot === 'used')) return bad;
    if ((phase === 'lost' || phase === 'unresolved') && slot === 'used') return bad;
    if (phase === 'unresolved' && stake === 'burnt') return bad;
    const settled = phase === 'ordered' || phase === 'started' ? false : stake !== 'held' && slot !== 'held';
    return Object.freeze({ ok: true, phase, site, standing: Object.freeze({ p: standing.p, q: standing.q }), orderBell: ob, decidedBell: db, reason, lapsed, source, stake, slot, settled,
      day: day === null ? null : Object.freeze({ used: day.used, limit: day.limit }) });
  } catch { return bad; }
}
