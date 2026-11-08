// Workstream 12: the deterministic fixture of the demo (fixture v2).
//
// A (nation 1) asks B for 100 wood at A's storehouse (a vault: place kind 2, generation 1) in a direct
// conversation; B accepts and SIGNS an allocation of its caravan B#7 to the promise. Workstream 4 reports the
// departure, the settle, its execution record of what the settle added to the vault, and who held the vault at the
// settle bell. (A vault's credit is not derivable from the log, so the execution record is required.) Later A needs wood again and
// three suppliers can sell it. The WORLD at the second request (prices, distances, stock, arrival) is identical
// across arms; only the history (and when it was observed) differs:
//
//   none              no history with anyone
//   kept              the delivery is fully evidenced: allocated, settled, credited, owner attested
//   not_sent          B says it sent the wood; 4's sufficient index of B's departures shows no caravan
//   claim_no_record   B says it sent the wood; 4 has reported nothing at all (unknown, not a failure)
//   record_delayed    the same delivery as `kept`, but 4's records are observed only at bell 310, after the
//                     decision at 300; `reassess` at 320 shows the decision would differ
// plus two arms where the world, not memory, decides: `kept_but_cheaper_C` and `kept_but_no_stock`.
// Principals are short ASCII handles ('A', 'B', ...). As on chain, a principal's caravans carry a per-partition tag
// (here `B_p1`, `B_p2`) and only workstream 4's identity_alias says whose it is; places carry their partition.
// Partition p1 stands for the current Season account, p2 for the next one; the world itself does not end.
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { createMemory } from '../src/index.mjs';
import { allocationBytes, SEND_ROUTES } from '../src/records.mjs';

// The one continuing world of the fixture, 4's (fixture) partition registry, and deterministic TEST-ONLY ed25519
// keys (seed = a constant per principal). These are fixture keys for a local test, not keys of any real account.
export const WORLD = Object.freeze({ cluster: 'localnet-fixture', world_id: 'wylls-fixture-world' });
export const PROGRAM = 'FrontierFixtureProgram111111111111111111111';
export const PARTITIONS = Object.freeze({ p1: Object.freeze({ program: PROGRAM, season: 1 }), p2: Object.freeze({ program: PROGRAM, season: 2 }) });
export const LEGACY = Object.freeze({ partition: 'p1' });
/** The v3 world of the legacy journals (fixtures/legacy-v3), which 4's registry maps to partition p1. */
export const WORLD_V3 = Object.freeze({ cluster: 'localnet-fixture', program: PROGRAM, season: 1 });
const seedOf = tag => Buffer.alloc(32, tag.charCodeAt(0));
const privOf = tag => createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seedOf(tag)]), format: 'der', type: 'pkcs8' });
const pubHex = tag => createPublicKey(privOf(tag)).export({ format: 'der', type: 'spki' }).subarray(12).toString('hex');
// Lazy: a key is derived only when a signed allocation is actually verified against it, so a test that signs
// nothing derives nothing (tools/test-nokey.sh runs such tests with key operations disabled).
const lazyKeys = principals => {
  const o = {};
  for (const t of principals) { let v; Object.defineProperty(o, t, { enumerable: true, get: () => (v ??= pubHex(t)) }); }
  return Object.freeze(o);
};
export const KEYS = lazyKeys(['A', 'B', 'C', 'D', 'E']);
/** Test-only keys for any principals (e.g. wallet-style addresses), same derivation as KEYS. */
export const keysFor = principals => lazyKeys(principals);
export const newMemory = (opts = {}) => createMemory({ world: WORLD, partitions: PARTITIONS, legacy: LEGACY, keys: KEYS, ...opts });

/** The tag a principal has in a partition (the program derives it per Season account), and a caravan id. */
export const tagIn = (principal, partition) => `${principal}_${partition}`;
export const cv = (seq, principal = 'B', partition = 'p1') => ({ partition, sender: tagIn(principal, partition), seq });
/** 4's attestation that a partition's tag is a principal (deduplicated by its source). */
export const alias = (m, principal, partition = 'p1', bell = 0, created = bell) =>
  m.observe({ kind: 'identity_alias', bell, created_bell: created, source: { chain: 'index', sig: `alias-${partition}-${principal}`, ix: 0 },
    data: { partition, tag: tagIn(principal, partition), principal } });

/** Sign an allocation operation as `by` (test keys). */
export function signedAllocation({ by, op = 'set', commitment, caravan, qty = op === 'set' ? 100 : 0, nonce, bell, created_bell = bell, visibility, world: w = WORLD, signAs = by }) {
  const body = { world: w, by, op, commitment, caravan, qty, nonce, bell, visibility };
  const sig = sign(null, allocationBytes({ ...body, visibility: { ...visibility, ...(visibility.members ? { members: [...new Set(visibility.members)].sort() } : {}) } }), privOf(signAs)).toString('hex');
  return { ...body, created_bell, sig };
}

const nonces = new WeakMap();
const nextNonce = (m, by) => { const n = nonces.get(m) ?? new Map(); nonces.set(m, n); const v = (n.get(by) ?? 0) + 1; n.set(by, v); return v; };

/** A full coverage attestation (sufficient by construction); `over` breaks one condition at a time in tests. */
export const coverage = (m, { sender = 'B', partition = 'p1', from = 90, to = 140, caravans = [], bell = to, created = bell, sig = `cov-${partition}-${sender}-${from}-${to}`, over = {}, withAlias = true } = {}) => {
  if (withAlias) alias(m, sender, partition);
  return m.observe({ kind: 'coverage', bell, created_bell: created, source: { chain: 'index', sig, ix: 0 },
    data: { world: WORLD, partition, sender: tagIn(sender, partition), from_bell: from, to_bell: to, routes: [...SEND_ROUTES], finality: 'finalized',
      completeness: { gapless: true, from_slot: from * 1500, to_slot: to * 1500 + 1499 }, caravans, ...over } });
};

export const A = { tag: 'A', nation: 1 };
export const B = { tag: 'B', nation: 1 };
export const C = { tag: 'C', nation: 2 };
export const D = { tag: 'D', nation: 1 };
export const dm = (...members) => ({ scope: 'parties', members });
export const PUBLIC = { scope: 'public' };
export const PLACE_A = Object.freeze({ partition: 'p1', kind: 2, p: 3, q: 0, at: 40, gen: 1 });
export const PLACE_D = Object.freeze({ partition: 'p1', kind: 1, p: -2, q: 5, at: 1, gen: 1 });

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
  obs = null, raided = false, lost = false, vis = PUBLIC, sigs = `${dst.partition}${sender}${seq}`, withAlias = true } = {}) {
  const o = b => (obs === null ? b : Math.max(obs, b));
  const ids = {};
  const caravan = cv(seq, sender, dst.partition);
  if (withAlias) ids.alias = alias(m, sender, dst.partition, depart, o(depart)).id;
  ids.sent = m.observe({ kind: 'caravan_sent', bell: depart, created_bell: o(depart), source: { sig: `sent-${sigs}`, ix: 0 }, visibility: vis,
    data: { caravan, dst, cargo, ...(eta === null ? {} : { eta_bell: eta }) } }).id;
  if (raided) {
    ids.raided = m.observe({ kind: 'caravan_raided', bell: settle - 5, created_bell: o(settle - 5), source: { sig: `raid-${sigs}`, ix: 0 }, visibility: vis,
      data: { caravan, raider: tagIn('C', dst.partition), taken: cargo } }).id;
    return ids;
  }
  if (settle === null) return ids;
  ids.settled = m.observe({ kind: 'caravan_settled', bell: settle, created_bell: o(settle), source: { sig: `settle-${sigs}`, ix: 0 }, visibility: vis,
    data: { caravan, outcome: lost ? 1 : 0, dst, cargo_recorded: cargo } }).id;
  if (lost) return ids;
  // 4's execution record of what this settle added (required for a vault; optional for a holding, where it must
  // equal the rule-derived credit)
  if (credited) ids.credited = m.observe({ kind: 'caravan_credited', bell: settle, created_bell: o(settle), source: { sig: `credit-${sigs}`, ix: 0 }, visibility: vis,
    data: { caravan, place: dst, credited, unit: 'whole_units', basis: 'exec_record', exec: { sig: `settle-${sigs}`, ix: 0 } } }).id;
  if (owner) ids.owner = m.observe({ kind: 'place_owner', bell: settle, created_bell: o(settle), source: { sig: `owner-${sigs}`, ix: 0 }, visibility: vis,
    data: { place: dst, owner, from_bell: 0, to_bell: null } }).id;
  return ids;
}

/** A signed allocation by a party (nonce counted per signer and memory). Returns the append result. */
export const allocateOp = (m, { by = 'B', ref, sender = 'B', seq = 7, partition = 'p1', qty = 100, bell = 102, created_bell = bell, vis = dm('A', 'B'), op = 'set', nonce = null, signAs = by }) =>
  m.allocate(signedAllocation({ by, op, commitment: ref, caravan: cv(seq, sender, partition), qty: op === 'set' ? qty : 0, nonce: nonce ?? nextNonce(m, by), bell, created_bell, visibility: vis, signAs }));
export const allocate = (m, opts) => allocateOp(m, opts).id;

export function firstExchange(m, { outcome }) {
  const ids = promise(m);
  if (outcome === 'kept' || outcome === 'record_delayed') {
    ids.allocate = allocate(m, { ref: ids.accept });
    Object.assign(ids, caravanFacts(m, { obs: outcome === 'record_delayed' ? LATE_OBSERVED : null }));
  }
  if (outcome === 'kept') ids.note = m.note({ owner: 'A', bell: 121, about: 'B', text: 'B delivered the wood it promised, on time.', basis: [ids.accept, ids.credited] }).id;
  if (outcome === 'not_sent' || outcome === 'claim_no_record') {
    ids.claim = m.say({ speaker: 'B', bell: 125, visibility: dm('A', 'B'), text: 'The wood is already on its way, I sent it!', act: { type: 'claim_sent', ref: ids.accept } }).id;
  }
  if (outcome === 'not_sent') {
    ids.coverage = coverage(m).id;
  }
  return ids;
}

export const ARMS = Object.freeze({
  none: { outcome: null, world: {} },
  kept: { outcome: 'kept', world: {} },
  not_sent: { outcome: 'not_sent', world: {} },
  claim_no_record: { outcome: 'claim_no_record', world: {} },
  record_delayed: { outcome: 'record_delayed', world: {}, reassess: 320 },
  kept_but_cheaper_C: { outcome: 'kept', world: { C: { price_per_unit: 7 } } },
  kept_but_no_stock: { outcome: 'kept', world: { B: { stock: 50 } } },
});

export async function runArm(name, { path = null, policy = null } = {}) {
  const arm = ARMS[name];
  const m = newMemory({ path });
  const ids = arm.outcome ? firstExchange(m, { outcome: arm.outcome }) : {};
  const res = await m.choosePartner({ viewer: A, bell: SECOND_BELL, request: REQUEST, candidates: world(arm.world), limits: LIMITS, policy });
  const reassessed = arm.reassess ? m.reassess(res.decision_id, arm.reassess) : null;
  return { name, m, ids, res, reassessed };
}
