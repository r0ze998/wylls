// Workstream 12: the journal records of the memory module and their validation (record v2).
//
// Four epistemic kinds are kept apart by TYPE, never by a flag a speaker can set:
//
//   utterance   someone SAID something (text is untrusted; `act` is a structured speech act from the social
//               protocol, not parsed out of the text). epistemic "said".
//   fact        an execution or chain record, or an index attestation, from workstream 4. epistemic "verified"
//               for what the record itself states, and nothing more (a settle record is not a credited amount).
//   note        the owner's own INTERPRETATION (code-made or model-written). epistemic "interpreted".
//               A note is never evidence for a relationship.
//   correction  the owner retracts or amends its own note; a `rollback` fact (not a correction) retracts a fact.
//   decision    which candidate an owner chose, on what input, citing which memory ids (audit and reassessment).
//
// Two times on every record (the split of the existing episodes, AC2-NOTES rule 2: `bell` / `created_bell`):
//   bell          when it HAPPENED (the chain bell of a settle, the bell an utterance was said)
//   created_bell  when it was OBSERVED, i.e. entered memory (>= bell; an utterance is heard when said)
// A delivery that happened on time but was observed late is on time; knowledge at a bell only includes what had
// been observed by then (see fold.mjs).
//
// Every record also carries: id, type, visibility, sources (provenance ids or chain references) and, where it
// can lapse, expires_bell. The journal is append-only; nothing is deleted.
//
// Reused from the AI-citizens code: canonical JSON and sha256 (citizens/memory/config.mjs) and the pinned
// sanitiser of citizens/mind/sanitize.mjs (not the memory/safe.mjs stand-in, which its own header says is no
// drop-in for untrusted text).
import { canonical, sha256hex } from '../../../permutation-gateway/citizens/memory/config.mjs';
import { safeText } from '../../../permutation-gateway/citizens/mind/sanitize.mjs';

export { canonical, sha256hex };

export const RECORD_VERSION = 2;
export const TYPES = Object.freeze(['utterance', 'fact', 'note', 'correction', 'decision']);
export const EPISTEMIC = Object.freeze({ utterance: 'said', fact: 'verified', note: 'interpreted', correction: 'interpreted', decision: 'interpreted' });

// Speech acts the social protocol can carry. Nothing here grants authority, moves funds, forms a contract or
// marks a delivery done: those exist only as facts from the execution side. `allocate` is a party SAYING which
// caravan (and how much of it) is meant for which commitment; the fold checks it against the facts.
export const ACTS = Object.freeze(['request', 'accept', 'decline', 'retract', 'claim_sent', 'claim_delivered', 'allocate', 'testimony']);
export const FACT_KINDS = Object.freeze([
  'caravan_sent', 'caravan_settled', 'caravan_credited', 'caravan_raided', // chain records and the measured credit
  'place_owner', 'coverage', 'lookup_failed', // index attestations
  'march_sent', 'rollback',
]);
export const RESOURCES = Object.freeze(['food', 'wood', 'stone', 'ore', 'horses', 'gold', 'science', 'influence']);
// caravan_settled outcomes, as frontier-abi `caravan_outcome` (DELIVERED 0, LOST 1)
export const OUTCOME = Object.freeze({ DELIVERED: 0, LOST: 1 });
// LogPlace kinds a caravan can be addressed to (fclient conquest.rs: 1 holding, 2 vault)
export const PLACE_KINDS = Object.freeze([1, 2]);

export const TEXT_LIMIT = 280;

export class RecordError extends Error {
  constructor(code, msg) { super(`${code}: ${msg}`); this.code = code; }
}
const fail = (code, msg) => { throw new RecordError(code, msg); };

const isTag = s => typeof s === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(s);
const isBell = n => Number.isInteger(n) && n >= 0 && n < 2 ** 32;
const isQty = n => Number.isInteger(n) && n > 0 && n < 2 ** 32;
const isI16 = n => Number.isInteger(n) && n >= -32768 && n < 32768;
const isU8 = n => Number.isInteger(n) && n >= 0 && n < 256;

/** A caravan id: the sender's tag and its per-sender seq (the chain record's `owner_tag`, `seq`). */
export function checkCaravan(c, what = 'caravan') {
  if (!c || !isTag(c.sender) || !Number.isInteger(c.seq) || c.seq < 0) fail(what, 'caravan id {sender, seq}');
  return { sender: c.sender, seq: c.seq };
}
export const caravanKey = c => `${c.sender}#${c.seq}`;

/** A destination with its generation (fclient `LogPlace`: kind, p, q, at = site or tile, gen). */
export function checkPlace(pl, what = 'place') {
  if (!pl || !PLACE_KINDS.includes(pl.kind) || !isI16(pl.p) || !isI16(pl.q) || !isU8(pl.at) || !isU8(pl.gen)) fail(what, 'place {kind, p, q, at, gen}');
  return { kind: pl.kind, p: pl.p, q: pl.q, at: pl.at, gen: pl.gen };
}
export const placeKey = pl => `${pl.kind}:${pl.p},${pl.q}:${pl.at}:${pl.gen}`;

/**
 * Visibility: who may see a record.
 *   {scope:'public'}                      everyone
 *   {scope:'nation', nation:<int>}        members of a nation (its council)
 *   {scope:'parties', members:[tag...]}   a direct conversation or a private execution record
 */
export function checkVisibility(v) {
  if (!v || typeof v !== 'object') fail('visibility', 'missing');
  if (v.scope === 'public') return { scope: 'public' };
  if (v.scope === 'nation') { if (!Number.isInteger(v.nation) || v.nation < 0) fail('visibility', 'nation'); return { scope: 'nation', nation: v.nation }; }
  if (v.scope === 'parties') {
    if (!Array.isArray(v.members) || !v.members.length || !v.members.every(isTag)) fail('visibility', 'members');
    return { scope: 'parties', members: [...new Set(v.members)].sort() };
  }
  return fail('visibility', `unknown scope ${v.scope}`);
}

/** May `viewer` ({tag, nation}) see a record of visibility `v`? */
export function visibleTo(v, viewer) {
  if (v.scope === 'public') return true;
  if (v.scope === 'nation') return viewer.nation === v.nation;
  return v.members.includes(viewer.tag);
}

const ACT_FIELDS = Object.freeze({
  request: ['type', 'to', 'resource', 'qty', 'by_bell', 'place'],
  accept: ['type', 'ref', 'qty', 'by_bell'],
  decline: ['type', 'ref'],
  retract: ['type', 'ref'],
  claim_sent: ['type', 'ref', 'caravan'],
  claim_delivered: ['type', 'ref', 'caravan'],
  allocate: ['type', 'ref', 'caravan', 'qty'],
  testimony: ['type', 'about', 'ref', 'says'],
});

function checkAct(act) {
  if (act === undefined || act === null) return null;
  if (typeof act !== 'object' || !ACTS.includes(act.type)) fail('act', `unknown act ${act?.type}`);
  for (const k of Object.keys(act)) if (!ACT_FIELDS[act.type].includes(k)) fail('act', `field ${k} not allowed in ${act.type}`);
  const ref = () => { if (typeof act.ref !== 'string' || !act.ref) fail('act', 'ref'); return act.ref; };
  switch (act.type) {
    case 'request':
      if (act.to !== null && act.to !== undefined && !isTag(act.to)) fail('act', 'to');
      if (!RESOURCES.includes(act.resource) || !isQty(act.qty) || !isBell(act.by_bell)) fail('act', 'request terms');
      // the target is the recipient's tag AND a place of a given generation: a delivery elsewhere is not this one
      return { type: 'request', to: act.to ?? null, resource: act.resource, qty: act.qty, by_bell: act.by_bell, place: checkPlace(act.place, 'act') };
    case 'accept':
      if (!isQty(act.qty) || !isBell(act.by_bell)) fail('act', 'accept terms');
      return { type: 'accept', ref: ref(), qty: act.qty, by_bell: act.by_bell };
    case 'claim_sent': case 'claim_delivered':
      return { type: act.type, ref: ref(), caravan: act.caravan === undefined || act.caravan === null ? null : checkCaravan(act.caravan, 'act') };
    case 'allocate':
      if (!isQty(act.qty)) fail('act', 'allocate qty');
      return { type: 'allocate', ref: ref(), caravan: checkCaravan(act.caravan, 'act'), qty: act.qty };
    case 'testimony':
      if (!isTag(act.about) || !['delivered', 'not_delivered'].includes(act.says)) fail('act', 'testimony');
      return { type: 'testimony', about: act.about, ref: ref(), says: act.says };
    default:
      return { type: act.type, ref: ref() };
  }
}

const idOf = (type, body) => sha256hex('wylls-memory12/v2', type, canonical(body)).slice(0, 16);

/**
 * An utterance. `speaker` must be the authenticated signer (the caller, i.e. the social layer, vouches for it).
 * The text is sanitised as UNTRUSTED and is never parsed for acts, budgets or permissions.
 */
export function utterance({ speaker, bell, channel = 'dm', visibility, text = '', act = null }) {
  if (!isTag(speaker)) fail('utterance', 'speaker');
  if (!isBell(bell)) fail('utterance', 'bell');
  const body = { v: RECORD_VERSION, type: 'utterance', speaker, bell, created_bell: bell, channel: String(channel), visibility: checkVisibility(visibility),
    text: safeText(text, { kind: 'untrusted', limit: TEXT_LIMIT }), act: checkAct(act) };
  return { id: idOf('utterance', body), ...body, epistemic: EPISTEMIC.utterance, sources: [] };
}

/**
 * A fact from workstream 4. `bell` = when it happened on chain, `created_bell` = when 4 delivered it (default
 * `bell`). `source` = {chain, sig, ix} identifies the record (an index attestation uses its own reference); the
 * id is derived from it alone, so the same record delivered twice has the same id (dedupe), and the same key with
 * a different body is a collision.
 */
export function fact({ kind, bell, created_bell = bell, source, visibility = { scope: 'public' }, data }) {
  if (!FACT_KINDS.includes(kind)) fail('fact', `kind ${kind}`);
  if (!isBell(bell) || !isBell(created_bell) || created_bell < bell) fail('fact', 'bell / created_bell (observed before it happened)');
  if (!source || typeof source.sig !== 'string' || !source.sig || !Number.isInteger(source.ix)) fail('fact', 'source');
  const d = checkFactData(kind, data, bell);
  const key = { chain: String(source.chain ?? 'local'), sig: source.sig, ix: source.ix };
  const body = { v: RECORD_VERSION, type: 'fact', kind, bell, created_bell, visibility: checkVisibility(visibility), data: d, source: key };
  // body_sha excludes created_bell: the same chain record observed again later is a duplicate, not a collision
  const { created_bell: _obs, ...stable } = body;
  return { id: idOf('fact', { kind, ...key }), ...body, epistemic: EPISTEMIC.fact, sources: [`${key.chain}:${key.sig}#${key.ix}`], body_sha: sha256hex(canonical(stable)).slice(0, 16) };
}

function cargoOf(c) {
  if (!c || typeof c !== 'object') fail('fact', 'cargo');
  const out = {};
  for (const [k, v] of Object.entries(c)) {
    if (!RESOURCES.includes(k) || !Number.isInteger(v) || v < 0) fail('fact', `cargo ${k}`);
    if (v > 0) out[k] = v;
  }
  return out;
}

function checkFactData(kind, d, bell) {
  if (!d || typeof d !== 'object') fail('fact', 'data');
  switch (kind) {
    case 'caravan_sent': // CARAVAN_SENT: the record of departure (not a delivery)
      if (d.eta_bell !== undefined && (!isBell(d.eta_bell) || d.eta_bell < bell)) fail('fact', 'caravan_sent eta');
      return { caravan: checkCaravan(d.caravan, 'fact'), dst: checkPlace(d.dst, 'fact'), cargo: cargoOf(d.cargo), eta_bell: d.eta_bell ?? null };
    case 'caravan_settled': // CARAVAN_SETTLED: outcome and the cargo AS RECORDED (not the amount credited)
      if (!Object.values(OUTCOME).includes(d.outcome)) fail('fact', 'caravan_settled outcome');
      return { caravan: checkCaravan(d.caravan, 'fact'), outcome: d.outcome, dst: checkPlace(d.dst, 'fact'), cargo_recorded: cargoOf(d.cargo_recorded ?? {}) };
    case 'caravan_credited': // the measured change of the destination's stock caused by that settle (4 reads it)
      if (!['account_diff'].includes(d.basis)) fail('fact', 'caravan_credited basis');
      return { caravan: checkCaravan(d.caravan, 'fact'), place: checkPlace(d.place, 'fact'), credited: cargoOf(d.credited), basis: d.basis };
    case 'caravan_raided':
      if (!isTag(d.raider)) fail('fact', 'caravan_raided raider');
      return { caravan: checkCaravan(d.caravan, 'fact'), raider: d.raider, taken: cargoOf(d.taken ?? {}) };
    case 'place_owner': // who held a place of a given generation over [from_bell, to_bell]; to_bell null = through `bell`
      if (!isTag(d.owner) || !isBell(d.from_bell) || (d.to_bell !== null && d.to_bell !== undefined && (!isBell(d.to_bell) || d.to_bell < d.from_bell))) fail('fact', 'place_owner');
      return { place: checkPlace(d.place, 'fact'), owner: d.owner, from_bell: d.from_bell, to_bell: d.to_bell ?? null };
    case 'coverage': // 4's index is complete for this sender's caravan departures over [from_bell, to_bell]: exactly these
      if (!isTag(d.sender) || !isBell(d.from_bell) || !isBell(d.to_bell) || d.to_bell < d.from_bell || d.to_bell > bell || !Array.isArray(d.caravans)) fail('fact', 'coverage');
      return { sender: d.sender, from_bell: d.from_bell, to_bell: d.to_bell, caravans: d.caravans.map(c => checkCaravan(c, 'fact')) };
    case 'lookup_failed': // 4 tried and could not answer: unknown, not "absent"
      if (!['coverage', 'caravan', 'place_owner', 'credit'].includes(d.query) || !d.reason) fail('fact', 'lookup_failed');
      return { query: d.query, sender: isTag(d.sender) ? d.sender : null, caravan: d.caravan ? checkCaravan(d.caravan, 'fact') : null,
        reason: safeText(d.reason, { kind: 'trusted', limit: 120 }) };
    case 'march_sent':
      if (!isTag(d.owner)) fail('fact', 'march_sent');
      return { owner: d.owner, host_id: String(d.host_id ?? ''), dest: d.dest ? { p: d.dest.p | 0, q: d.dest.q | 0 } : null, arrive_bell: d.arrive_bell ?? null };
    case 'rollback':
      if (typeof d.fact !== 'string' || !d.reason) fail('fact', 'rollback');
      return { fact: d.fact, reason: safeText(d.reason, { kind: 'trusted', limit: 120 }) };
    default: return fail('fact', kind);
  }
}

/** The owner's own interpretation. `basis` = record ids it rests on. Never counted as evidence. */
export function note({ owner, bell, about = null, text, basis = [], by = 'code', expires_bell = null }) {
  if (!isTag(owner) || !isBell(bell)) fail('note', 'owner/bell');
  if (!['code', 'model'].includes(by)) fail('note', 'by');
  const body = { v: RECORD_VERSION, type: 'note', owner, bell, created_bell: bell, about: about && isTag(about) ? about : null,
    text: safeText(text, { kind: by === 'model' ? 'untrusted' : 'trusted', limit: TEXT_LIMIT }), by,
    visibility: { scope: 'parties', members: [owner] }, expires_bell: isBell(expires_bell) ? expires_bell : null };
  return { id: idOf('note', body), ...body, epistemic: EPISTEMIC.note, sources: [...basis].map(String) };
}

/** The owner retracts or amends one of ITS OWN notes (checked by the store). */
export function correction({ owner, bell, target, reason, replacement = null }) {
  if (!isTag(owner) || !isBell(bell) || typeof target !== 'string') fail('correction', 'fields');
  const body = { v: RECORD_VERSION, type: 'correction', owner, bell, created_bell: bell, target, reason: safeText(reason, { kind: 'untrusted', limit: 120 }),
    replacement, visibility: { scope: 'parties', members: [owner] } };
  return { id: idOf('correction', body), ...body, epistemic: EPISTEMIC.correction, sources: [target] };
}

/**
 * Which candidate an owner chose and on what input. It keeps the request, the candidates and the limits so that
 * the decision can be reassessed when later-observed evidence changes what was true at that bell. Owner-private.
 */
export function decision({ owner, nation, bell, request, candidates, limits, chosen, policy, cited = [], contributions = {} }) {
  if (!isTag(owner) || !isBell(bell)) fail('decision', 'fields');
  const body = { v: RECORD_VERSION, type: 'decision', owner, nation: nation ?? null, bell, created_bell: bell, request, candidates, limits, chosen,
    policy: String(policy), cited: [...cited], contributions, visibility: { scope: 'parties', members: [owner] } };
  return { id: idOf('decision', body), ...body, epistemic: EPISTEMIC.decision, sources: [...cited] };
}
