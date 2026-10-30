// Workstream 12: the journal records of the memory module and their validation.
//
// Four epistemic kinds are kept apart by TYPE, never by a flag a speaker can set:
//
//   utterance   someone SAID something (text is untrusted; `act` is a structured speech act from the social
//               protocol, not parsed out of the text). epistemic "said".
//   fact        an execution or chain record (workstream 4) CONFIRMED something. epistemic "verified".
//               Only the fact source may write it; a speaker cannot.
//   note        the owner's own INTERPRETATION (code-made or model-written). epistemic "interpreted".
//               A note is never evidence for a relationship.
//   correction  the owner retracts or amends its own note; a `rollback` fact (not a correction) retracts a fact.
//   decision    which candidate an owner chose and which memory ids the choice cited (audit only).
//
// Every record carries: id, type, bell (game time it became known), visibility, sources (provenance ids or
// chain references) and, where it can lapse, expires_bell. The journal is append-only; nothing is deleted.
//
// Reused from the AI-citizens memory (permutation-gateway/citizens/memory): canonical JSON, sha256 and the
// pinned sanitiser of mind/sanitize.mjs (not the memory/safe.mjs stand-in, which its own header says is no drop-in
// for untrusted text), so ids and text rules match the existing citizens.
import { canonical, sha256hex } from '../../../permutation-gateway/citizens/memory/config.mjs';
import { safeText } from '../../../permutation-gateway/citizens/mind/sanitize.mjs';

export { canonical, sha256hex };

export const RECORD_VERSION = 1;
export const TYPES = Object.freeze(['utterance', 'fact', 'note', 'correction', 'decision']);
export const EPISTEMIC = Object.freeze({ utterance: 'said', fact: 'verified', note: 'interpreted', correction: 'interpreted', decision: 'interpreted' });

// Speech acts the social protocol can carry. Nothing here grants authority, moves funds, forms a contract or
// marks a delivery done: those exist only as facts from the execution side.
export const ACTS = Object.freeze(['request', 'accept', 'decline', 'claim_delivered', 'testimony', 'retract']);
export const FACT_KINDS = Object.freeze(['caravan_sent', 'caravan_settled', 'caravan_raided', 'march_sent', 'rollback']);
export const RESOURCES = Object.freeze(['food', 'wood', 'stone', 'ore', 'horses', 'gold', 'science', 'influence']);
// caravan_settled outcomes, as frontier-abi `caravan_outcome` (DELIVERED 0, LOST 1)
export const OUTCOME = Object.freeze({ DELIVERED: 0, LOST: 1 });

export const TEXT_LIMIT = 280;

export class RecordError extends Error {
  constructor(code, msg) { super(`${code}: ${msg}`); this.code = code; }
}
const fail = (code, msg) => { throw new RecordError(code, msg); };

const isTag = s => typeof s === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(s);
const isBell = n => Number.isInteger(n) && n >= 0 && n < 2 ** 32;
const isQty = n => Number.isInteger(n) && n > 0 && n < 2 ** 32;

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

function checkAct(act) {
  if (act === undefined || act === null) return null;
  if (typeof act !== 'object' || !ACTS.includes(act.type)) fail('act', `unknown act ${act?.type}`);
  const allowed = { request: ['type', 'to', 'resource', 'qty', 'by_bell'], accept: ['type', 'ref', 'qty', 'by_bell'], decline: ['type', 'ref'],
    claim_delivered: ['type', 'ref'], testimony: ['type', 'about', 'ref', 'says'], retract: ['type', 'ref'] }[act.type];
  for (const k of Object.keys(act)) if (!allowed.includes(k)) fail('act', `field ${k} not allowed in ${act.type}`);
  switch (act.type) {
    case 'request':
      if (act.to !== null && act.to !== undefined && !isTag(act.to)) fail('act', 'to');
      if (!RESOURCES.includes(act.resource) || !isQty(act.qty) || !isBell(act.by_bell)) fail('act', 'request terms');
      return { type: 'request', to: act.to ?? null, resource: act.resource, qty: act.qty, by_bell: act.by_bell };
    case 'accept':
      if (typeof act.ref !== 'string' || !isQty(act.qty) || !isBell(act.by_bell)) fail('act', 'accept terms');
      return { type: 'accept', ref: act.ref, qty: act.qty, by_bell: act.by_bell };
    case 'testimony':
      if (!isTag(act.about) || typeof act.ref !== 'string' || !['delivered', 'not_delivered'].includes(act.says)) fail('act', 'testimony');
      return { type: 'testimony', about: act.about, ref: act.ref, says: act.says };
    default:
      if (typeof act.ref !== 'string') fail('act', 'ref');
      return { type: act.type, ref: act.ref };
  }
}

const idOf = (type, body) => sha256hex('wylls-memory12/v1', type, canonical(body)).slice(0, 16);

/**
 * An utterance. `speaker` must be the authenticated signer (the caller, i.e. the social layer, vouches for it).
 * The text is sanitised as UNTRUSTED and is never parsed for acts, budgets or permissions.
 */
export function utterance({ speaker, bell, channel = 'dm', visibility, text = '', act = null }) {
  if (!isTag(speaker)) fail('utterance', 'speaker');
  if (!isBell(bell)) fail('utterance', 'bell');
  const body = { v: RECORD_VERSION, type: 'utterance', speaker, bell, channel: String(channel), visibility: checkVisibility(visibility),
    text: safeText(text, { kind: 'untrusted', limit: TEXT_LIMIT }), act: checkAct(act) };
  return { id: idOf('utterance', body), ...body, epistemic: EPISTEMIC.utterance, sources: [] };
}

/**
 * A fact from the execution side (workstream 4). `source` = {chain, sig, ix} identifies the record; the id is
 * derived from it alone, so the same record delivered twice has the same id (dedupe), and the same key with a
 * different body is a collision.
 */
export function fact({ kind, bell, source, visibility = { scope: 'public' }, data }) {
  if (!FACT_KINDS.includes(kind)) fail('fact', `kind ${kind}`);
  if (!isBell(bell)) fail('fact', 'bell');
  if (!source || typeof source.sig !== 'string' || !source.sig || !Number.isInteger(source.ix)) fail('fact', 'source');
  const d = checkFactData(kind, data);
  const key = { chain: String(source.chain ?? 'local'), sig: source.sig, ix: source.ix };
  const body = { v: RECORD_VERSION, type: 'fact', kind, bell, visibility: checkVisibility(visibility), data: d, source: key };
  return { id: idOf('fact', { kind, ...key }), ...body, epistemic: EPISTEMIC.fact, sources: [`${key.chain}:${key.sig}#${key.ix}`], body_sha: sha256hex(canonical(body)).slice(0, 16) };
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

function checkFactData(kind, d) {
  if (!d || typeof d !== 'object') fail('fact', 'data');
  switch (kind) {
    case 'caravan_sent':
      if (!isTag(d.sender) || !Number.isInteger(d.seq) || !isTag(d.recipient)) fail('fact', 'caravan_sent');
      return { sender: d.sender, seq: d.seq, recipient: d.recipient, cargo: cargoOf(d.cargo), arrive_bell: isBell(d.arrive_bell) ? d.arrive_bell : null };
    case 'caravan_settled':
      if (!isTag(d.sender) || !Number.isInteger(d.seq) || !isTag(d.recipient) || !Object.values(OUTCOME).includes(d.outcome)) fail('fact', 'caravan_settled');
      return { sender: d.sender, seq: d.seq, recipient: d.recipient, outcome: d.outcome, cargo: cargoOf(d.cargo) };
    case 'caravan_raided':
      if (!isTag(d.sender) || !Number.isInteger(d.seq) || !isTag(d.raider)) fail('fact', 'caravan_raided');
      return { sender: d.sender, seq: d.seq, raider: d.raider, taken: cargoOf(d.taken ?? {}) };
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
  const body = { v: RECORD_VERSION, type: 'note', owner, bell, about: about && isTag(about) ? about : null,
    text: safeText(text, { kind: by === 'model' ? 'untrusted' : 'trusted', limit: TEXT_LIMIT }), by,
    visibility: { scope: 'parties', members: [owner] }, expires_bell: isBell(expires_bell) ? expires_bell : null };
  return { id: idOf('note', body), ...body, epistemic: EPISTEMIC.note, sources: [...basis].map(String) };
}

/** The owner retracts or amends one of ITS OWN notes (checked by the store). */
export function correction({ owner, bell, target, reason, replacement = null }) {
  if (!isTag(owner) || !isBell(bell) || typeof target !== 'string') fail('correction', 'fields');
  const body = { v: RECORD_VERSION, type: 'correction', owner, bell, target, reason: safeText(reason, { kind: 'untrusted', limit: 120 }),
    replacement, visibility: { scope: 'parties', members: [owner] } };
  return { id: idOf('correction', body), ...body, epistemic: EPISTEMIC.correction, sources: [target] };
}

/** Which candidate an owner chose and the memory ids the choice cited. Owner-private. */
export function decision({ owner, bell, request, chosen, policy, cited = [], contributions = {} }) {
  if (!isTag(owner) || !isBell(bell)) fail('decision', 'fields');
  const body = { v: RECORD_VERSION, type: 'decision', owner, bell, request, chosen, policy: String(policy), cited: [...cited], contributions,
    visibility: { scope: 'parties', members: [owner] } };
  return { id: idOf('decision', body), ...body, epistemic: EPISTEMIC.decision, sources: [...cited] };
}
