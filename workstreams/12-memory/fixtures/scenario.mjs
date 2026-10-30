// Workstream 12: the deterministic fixture of the minimal demo.
//
// A (nation 1) asks B for 100 wood in a direct conversation; B accepts; the execution side reports B's caravan
// sent and settled DELIVERED at A. Later A needs wood again and three suppliers can sell it. The WORLD at the
// second request (prices, distances, stock, arrival) is identical across arms; only the history differs:
//
//   none     no history with anyone
//   kept     B promised and the chain shows the delivery
//   broken   B promised, later CLAIMED it had sent the wood, and no caravan exists
//
// plus two arms where the world, not memory, decides: `kept_but_cheaper_C` (C's price drops) and
// `kept_but_no_stock` (B's stock is below the quantity).
// Tags are short ASCII handles; a real run uses the citizens' tag hex (persona/names.mjs).
import { createMemory } from '../src/index.mjs';

export const A = { tag: 'A', nation: 1 };
export const B = { tag: 'B', nation: 1 };
export const C = { tag: 'C', nation: 2 };
export const D = { tag: 'D', nation: 1 };
export const dm = (...members) => ({ scope: 'parties', members });
export const PUBLIC = { scope: 'public' };

export const SECOND_BELL = 300;
export const REQUEST = Object.freeze({ resource: 'wood', qty: 100, need_by_bell: 340, failure_cost: 1200 });
export const LIMITS = Object.freeze({ budget: 1500 });

export const world = (over = {}) => [
  { id: 'offer-B', tag: 'B', price_per_unit: 10, distance: 2, stock: 500, arrive_bell: 320, ...(over.B ?? {}) },
  { id: 'offer-C', tag: 'C', price_per_unit: 9, distance: 2, stock: 400, arrive_bell: 322, ...(over.C ?? {}) },
  { id: 'offer-D', tag: 'D', price_per_unit: 9, distance: 6, stock: 300, arrive_bell: 330, ...(over.D ?? {}) },
];

/** The first exchange; returns the ids the tests and the demo print. */
export function firstExchange(m, { outcome }) {
  const req = m.say({ speaker: 'A', bell: 100, visibility: dm('A', 'B'), text: 'Could you send me 100 wood by bell 130?',
    act: { type: 'request', to: 'B', resource: 'wood', qty: 100, by_bell: 130 } });
  const acc = m.say({ speaker: 'B', bell: 101, visibility: dm('A', 'B'), text: 'Yes, I will send 100 wood before bell 130.',
    act: { type: 'accept', ref: req.id, qty: 100, by_bell: 130 } });
  const out = { request: req.id, accept: acc.id };
  if (outcome === 'kept') {
    out.sent = m.observe({ kind: 'caravan_sent', bell: 102, source: { chain: 'local', sig: 'sigSentB7', ix: 0 }, visibility: PUBLIC,
      data: { sender: 'B', seq: 7, recipient: 'A', cargo: { wood: 100 }, arrive_bell: 120 } }).id;
    out.settled = m.observe({ kind: 'caravan_settled', bell: 120, source: { chain: 'local', sig: 'sigSettleB7', ix: 0 }, visibility: PUBLIC,
      data: { sender: 'B', seq: 7, recipient: 'A', outcome: 0, cargo: { wood: 100 } } }).id;
    out.note = m.note({ owner: 'A', bell: 121, about: 'B', text: 'B delivered the wood it promised, on time.', basis: [acc.id, out.settled] }).id;
  } else if (outcome === 'broken') {
    out.claim = m.say({ speaker: 'B', bell: 125, visibility: dm('A', 'B'), text: 'The wood is already on its way, I sent it!',
      act: { type: 'claim_delivered', ref: acc.id } }).id;
  }
  return out;
}

export const ARMS = Object.freeze({
  none: { outcome: null, world: {} },
  kept: { outcome: 'kept', world: {} },
  broken: { outcome: 'broken', world: {} },
  kept_but_cheaper_C: { outcome: 'kept', world: { C: { price_per_unit: 7 } } },
  kept_but_no_stock: { outcome: 'kept', world: { B: { stock: 50 } } },
});

export async function runArm(name, { path = null, policy = null } = {}) {
  const arm = ARMS[name];
  const m = createMemory({ path });
  const ids = arm.outcome ? firstExchange(m, { outcome: arm.outcome }) : {};
  const res = await m.choosePartner({ viewer: A, bell: SECOND_BELL, request: REQUEST, candidates: world(arm.world), limits: LIMITS, policy });
  return { name, m, ids, res };
}
