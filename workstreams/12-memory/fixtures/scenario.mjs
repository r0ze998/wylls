// Workstream 12: the deterministic fixture of the demo (fixture v2).
//
// A (nation 1) asks B for 100 wood at A's storehouse (place kind 2, generation 1) in a direct conversation; B
// accepts and allocates its caravan B#7 to the promise. Workstream 4 reports the departure, the settle, the
// measured credit at the storehouse and who held the storehouse at the settle bell. Later A needs wood again and
// three suppliers can sell it. The WORLD at the second request (prices, distances, stock, arrival) is identical
// across arms; only the history (and when it was observed) differs:
//
//   none              no history with anyone
//   kept              the delivery is fully evidenced: allocated, settled, credited, owner attested
//   not_delivered     B says it sent the wood; 4's complete index of B's departures shows no caravan
//   claim_no_record   B says it sent the wood; 4 has reported nothing at all (unknown, not a failure)
//   record_delayed    the same delivery as `kept`, but 4's records are observed only at bell 310, after the
//                     decision at 300; `reassess` at 320 shows the decision would differ
// plus two arms where the world, not memory, decides: `kept_but_cheaper_C` and `kept_but_no_stock`.
// Tags are short ASCII handles; a real run uses the citizens' tag hex (persona/names.mjs).
import { createMemory } from '../src/index.mjs';

export const A = { tag: 'A', nation: 1 };
export const B = { tag: 'B', nation: 1 };
export const C = { tag: 'C', nation: 2 };
export const D = { tag: 'D', nation: 1 };
export const dm = (...members) => ({ scope: 'parties', members });
export const PUBLIC = { scope: 'public' };
export const PLACE_A = Object.freeze({ kind: 2, p: 3, q: 0, at: 40, gen: 1 });
export const PLACE_D = Object.freeze({ kind: 1, p: -2, q: 5, at: 1, gen: 1 });

export const SECOND_BELL = 300;
export const LATE_OBSERVED = 310;
export const REQUEST = Object.freeze({ resource: 'wood', qty: 100, need_by_bell: 340, failure_cost: 1200 });
export const LIMITS = Object.freeze({ budget: 1500 });

export const world = (over = {}) => [
  { id: 'offer-B', tag: 'B', price_per_unit: 10, distance: 2, stock: 500, arrive_bell: 320, ...(over.B ?? {}) },
  { id: 'offer-C', tag: 'C', price_per_unit: 9, distance: 2, stock: 400, arrive_bell: 322, ...(over.C ?? {}) },
  { id: 'offer-D', tag: 'D', price_per_unit: 9, distance: 6, stock: 300, arrive_bell: 330, ...(over.D ?? {}) },
];

/** A request and its acceptance (the commitment id is the accept's id). */
export function promise(m, { bell = 100, debtor = 'B', creditor = 'A', due = 130, qty = 100, resource = 'wood', place = PLACE_A, vis = dm(creditor, debtor), text = true } = {}) {
  const r = m.say({ speaker: creditor, bell, visibility: vis, text: text ? `Could you send me ${qty} ${resource} by bell ${due}?` : '',
    act: { type: 'request', to: debtor, resource, qty, by_bell: due, place } });
  const a = m.say({ speaker: debtor, bell: bell + 1, visibility: vis, text: text ? `Yes, I will send ${qty} ${resource} before bell ${due}.` : '',
    act: { type: 'accept', ref: r.id, qty, by_bell: due } });
  return { request: r.id, accept: a.id };
}

/** Workstream 4's facts of one caravan, each observed at `obs` (default: when it happened). */
export function caravanFacts(m, { sender = 'B', seq = 7, dst = PLACE_A, cargo = { wood: 100 }, depart = 102, settle = 120, eta = settle, credited = cargo, owner = 'A',
  obs = null, raided = false, lost = false, vis = PUBLIC, sigs = `${sender}${seq}` } = {}) {
  const o = b => (obs === null ? b : Math.max(obs, b));
  const ids = {};
  ids.sent = m.observe({ kind: 'caravan_sent', bell: depart, created_bell: o(depart), source: { sig: `sent-${sigs}`, ix: 0 }, visibility: vis,
    data: { caravan: { sender, seq }, dst, cargo, ...(eta === null ? {} : { eta_bell: eta }) } }).id;
  if (raided) {
    ids.raided = m.observe({ kind: 'caravan_raided', bell: settle - 5, created_bell: o(settle - 5), source: { sig: `raid-${sigs}`, ix: 0 }, visibility: vis,
      data: { caravan: { sender, seq }, raider: 'C', taken: cargo } }).id;
    return ids;
  }
  if (settle === null) return ids;
  ids.settled = m.observe({ kind: 'caravan_settled', bell: settle, created_bell: o(settle), source: { sig: `settle-${sigs}`, ix: 0 }, visibility: vis,
    data: { caravan: { sender, seq }, outcome: lost ? 1 : 0, dst, cargo_recorded: cargo } }).id;
  if (lost) return ids;
  if (credited) ids.credited = m.observe({ kind: 'caravan_credited', bell: settle, created_bell: o(settle), source: { sig: `credit-${sigs}`, ix: 0 }, visibility: vis,
    data: { caravan: { sender, seq }, place: dst, credited, basis: 'account_diff' } }).id;
  if (owner) ids.owner = m.observe({ kind: 'place_owner', bell: settle, created_bell: o(settle), source: { sig: `owner-${sigs}`, ix: 0 }, visibility: vis,
    data: { place: dst, owner, from_bell: 0, to_bell: null } }).id;
  return ids;
}

export const allocate = (m, { by = 'B', ref, sender = 'B', seq = 7, qty = 100, bell = 102, vis = dm('A', 'B') }) =>
  m.say({ speaker: by, bell, visibility: vis, act: { type: 'allocate', ref, caravan: { sender, seq }, qty } }).id;

export function firstExchange(m, { outcome }) {
  const ids = promise(m);
  if (outcome === 'kept' || outcome === 'record_delayed') {
    ids.allocate = allocate(m, { ref: ids.accept });
    Object.assign(ids, caravanFacts(m, { obs: outcome === 'record_delayed' ? LATE_OBSERVED : null }));
  }
  if (outcome === 'kept') ids.note = m.note({ owner: 'A', bell: 121, about: 'B', text: 'B delivered the wood it promised, on time.', basis: [ids.accept, ids.credited] }).id;
  if (outcome === 'not_delivered' || outcome === 'claim_no_record') {
    ids.claim = m.say({ speaker: 'B', bell: 125, visibility: dm('A', 'B'), text: 'The wood is already on its way, I sent it!', act: { type: 'claim_sent', ref: ids.accept } }).id;
  }
  if (outcome === 'not_delivered') {
    ids.coverage = m.observe({ kind: 'coverage', bell: 140, source: { chain: 'index', sig: 'cov-B-90-140', ix: 0 }, data: { sender: 'B', from_bell: 90, to_bell: 140, caravans: [] } }).id;
  }
  return ids;
}

export const ARMS = Object.freeze({
  none: { outcome: null, world: {} },
  kept: { outcome: 'kept', world: {} },
  not_delivered: { outcome: 'not_delivered', world: {} },
  claim_no_record: { outcome: 'claim_no_record', world: {} },
  record_delayed: { outcome: 'record_delayed', world: {}, reassess: 320 },
  kept_but_cheaper_C: { outcome: 'kept', world: { C: { price_per_unit: 7 } } },
  kept_but_no_stock: { outcome: 'kept', world: { B: { stock: 50 } } },
});

export async function runArm(name, { path = null, policy = null } = {}) {
  const arm = ARMS[name];
  const m = createMemory({ path });
  const ids = arm.outcome ? firstExchange(m, { outcome: arm.outcome }) : {};
  const res = await m.choosePartner({ viewer: A, bell: SECOND_BELL, request: REQUEST, candidates: world(arm.world), limits: LIMITS, policy });
  const reassessed = arm.reassess ? m.reassess(res.decision_id, arm.reassess) : null;
  return { name, m, ids, res, reassessed };
}
