// Workstream 12: the journal records of the memory module and their validation (record v4).
//
// v4 (continuing world): the world does not end. Time (`bell`) is the world clock that workstream 4 defines, not
// a season-relative bell; a memory belongs to a world {cluster, world_id}; the chain's current Season accounts are
// PARTITIONS of that world, registered by workstream 4. Chain identifiers that the program derives per Season (a
// citizen's tag, a caravan's {tag, seq}, a place's address) carry their `partition`, and only 4's attestations
// (`identity_alias`, `place_alias`) say that two of them are the same principal or the same place. v3 records stay
// readable and verifiable as they were written (fold.mjs `normalize`); nothing is re-signed or rewritten.
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
//   allocation  a party's SIGNED statement that (part of) a caravan is meant for a commitment. Authenticated by an
//               ed25519 signature over canonical bytes against the key registry the caller configures; the text
//               of a conversation can never allocate. Each signer numbers its operations (nonce): a resend is a
//               duplicate, a reused nonce with other content is refused, a higher nonce corrects or revokes.
//   decision    which candidate an owner chose, the full input it was shown, and the memory ids it cited.
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
import { createPublicKey, verify as verifySig } from 'node:crypto';
import { canonical, sha256hex } from '../../../permutation-gateway/citizens/memory/config.mjs';
import { safeText } from '../../../permutation-gateway/citizens/mind/sanitize.mjs';

export { canonical, sha256hex };

export const RECORD_VERSION = 4;
export const TYPES = Object.freeze(['utterance', 'fact', 'note', 'correction', 'allocation', 'decision']);
export const EPISTEMIC = Object.freeze({ utterance: 'said', fact: 'verified', note: 'interpreted', correction: 'interpreted', allocation: 'said', decision: 'interpreted' });

// Speech acts the social protocol can carry. Nothing here grants authority, moves funds, forms a contract or
// marks a delivery done: those exist only as facts from the execution side. Allocation is NOT an act: it is the
// signed `allocation` record below.
export const ACTS = Object.freeze(['request', 'accept', 'decline', 'retract', 'claim_sent', 'claim_delivered', 'testimony']);
export const FACT_KINDS = Object.freeze([
  'caravan_sent', 'caravan_settled', 'caravan_credited', 'caravan_raided', // chain records and 4's per-delivery credit
  'place_owner', 'coverage', 'lookup_failed', // index attestations
  'identity_alias', 'place_alias', // 4's continuity attestations across partitions
  'march_sent', 'rollback',
]);
export const RESOURCES = Object.freeze(['food', 'wood', 'stone', 'ore', 'horses', 'gold', 'science', 'influence']);
// caravan_settled outcomes, as frontier-abi `caravan_outcome` (DELIVERED 0, LOST 1)
export const OUTCOME = Object.freeze({ DELIVERED: 0, LOST: 1 });
// LogPlace kinds a caravan can be addressed to (fclient conquest.rs: 1 holding, 2 vault)
export const PLACE_KINDS = Object.freeze([1, 2]);
export const PLACE = Object.freeze({ HOLDING: 1, VAULT: 2 });

// Every instruction path that emits CARAVAN_SENT for a sender, read in permutation-frontier/src/proc/caravan.rs
// (send_caravan 0xB1 and the TAKE branch of settle_raid). Workstream 3 showed SendCaravan is also reachable by CPI
// from another program, and that frontier-node's verify collects top-level instructions only, so an index that
// reads top-level instructions alone does not cover the CPI path. A coverage attestation must name all three.
export const SEND_ROUTES = Object.freeze(['send_caravan/top_level', 'send_caravan/cpi', 'settle_raid/take']);
export const FINALITY = Object.freeze(['processed', 'confirmed', 'finalized']);
export const CREDIT_UNIT = 'whole_units';

export const TEXT_LIMIT = 280;

export class RecordError extends Error {
  constructor(code, msg) { super(`${code}: ${msg}`); this.code = code; }
}
const fail = (code, msg) => { throw new RecordError(code, msg); };

// A tag or principal: a chain citizen tag (16 hex digits) or a wallet address (base58, up to 44 characters; workstream
// 13 names counterparties by wallet because the citizen tag is derived per Season account). 64 leaves room for both.
const isTag = s => typeof s === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(s);
export const isPartition = s => typeof s === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(s);
const isBell = n => Number.isInteger(n) && n >= 0 && n < 2 ** 32;
const isQty = n => Number.isInteger(n) && n > 0 && n < 2 ** 32;
const isI16 = n => Number.isInteger(n) && n >= -32768 && n < 32768;
const isU8 = n => Number.isInteger(n) && n >= 0 && n < 256;

/**
 * A caravan id: the partition, the sender's tag IN that partition and its per-sender seq (the chain record's
 * `owner_tag`, `seq`; the program derives the tag from the citizen address, which it derives under the Season
 * account, so the same wallet has another tag in another partition).
 */
export function checkCaravan(c, what = 'caravan') {
  // seq is the program's u32 per sender
  if (!c || !isPartition(c.partition) || !isTag(c.sender) || !Number.isInteger(c.seq) || c.seq < 0 || c.seq >= 2 ** 32) fail(what, 'caravan id {partition, sender, seq u32}');
  return { partition: c.partition, sender: c.sender, seq: c.seq };
}
export const caravanKey = c => `${c.partition ?? '-'}/${c.sender}#${c.seq}`;

/** A destination with its partition and generation (fclient `LogPlace`: kind, p, q, at = site or tile, gen). */
export function checkPlace(pl, what = 'place') {
  if (!pl || !isPartition(pl.partition) || !PLACE_KINDS.includes(pl.kind) || !isI16(pl.p) || !isI16(pl.q) || !isU8(pl.at) || !isU8(pl.gen)) {
    fail(what, 'place {partition, kind, p, q, at, gen}');
  }
  return { partition: pl.partition, kind: pl.kind, p: pl.p, q: pl.q, at: pl.at, gen: pl.gen };
}
export const placeKey = pl => `${pl.partition ?? '-'}/${pl.kind}:${pl.p},${pl.q}:${pl.at}:${pl.gen}`;

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
    case 'testimony':
      if (!isTag(act.about) || !['delivered', 'not_delivered'].includes(act.says)) fail('act', 'testimony');
      return { type: 'testimony', about: act.about, ref: ref(), says: act.says };
    default:
      return { type: act.type, ref: ref() };
  }
}

const idOf = (type, body) => sha256hex('wylls-memory12/v4', type, canonical(body)).slice(0, 16);

/**
 * The world a memory belongs to: {cluster, world_id}, both defined by workstream 4. No season and no end: a war
 * period or a Season account is not part of the world's identity. (v3 named {cluster, program, season}; such records
 * are read through the partition registry, fold.mjs `normalize`.)
 */
export function checkWorld(w, what = 'world') {
  if (!w || typeof w.cluster !== 'string' || !w.cluster || typeof w.world_id !== 'string' || !w.world_id || Object.keys(w).length !== 2) {
    fail(what, 'world {cluster, world_id}');
  }
  return { cluster: w.cluster, world_id: w.world_id };
}

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
      { const caravan = checkCaravan(d.caravan, 'fact'), dst = checkPlace(d.dst, 'fact');
        if (dst.partition !== caravan.partition) fail('fact', 'caravan_sent: a caravan is addressed within its own partition');
        return { caravan, dst, cargo: cargoOf(d.cargo), eta_bell: d.eta_bell ?? null }; }
    case 'caravan_settled': // CARAVAN_SETTLED: outcome and the cargo AS RECORDED (not the amount credited)
      if (!Object.values(OUTCOME).includes(d.outcome)) fail('fact', 'caravan_settled outcome');
      return { caravan: checkCaravan(d.caravan, 'fact'), outcome: d.outcome, dst: checkPlace(d.dst, 'fact'), cargo_recorded: cargoOf(d.cargo_recorded ?? {}) };
    case 'caravan_credited':
      // The amount THIS delivery added, from 4's execution record of the settle instruction. A balance before /
      // after difference mixes concurrent deliveries, production and upkeep, so it is refused (`account_diff`).
      // For a holding the memory derives the credit itself by a pinned rule (fold.mjs CREDIT_RULES); a vault's
      // addition depends on its stock and cap at that instant and needs this record.
      if (d.basis !== 'exec_record') fail('fact', `caravan_credited basis ${d.basis} (only exec_record; a balance difference is not a per-delivery credit)`);
      if (d.unit !== CREDIT_UNIT) fail('fact', `caravan_credited unit ${d.unit}`);
      if (!d.exec || typeof d.exec.sig !== 'string' || !d.exec.sig || !Number.isInteger(d.exec.ix)) fail('fact', 'caravan_credited exec {sig, ix} of the settle instruction');
      return { caravan: checkCaravan(d.caravan, 'fact'), place: checkPlace(d.place, 'fact'), credited: cargoOf(d.credited), unit: d.unit, basis: d.basis,
        exec: { sig: d.exec.sig, ix: d.exec.ix } };
    case 'caravan_raided':
      if (!isTag(d.raider)) fail('fact', 'caravan_raided raider');
      return { caravan: checkCaravan(d.caravan, 'fact'), raider: d.raider, taken: cargoOf(d.taken ?? {}) };
    case 'place_owner': // which PRINCIPAL held a place of a given generation over [from_bell, to_bell]; to_bell null = through `bell`
      if (!isTag(d.owner) || !isBell(d.from_bell) || (d.to_bell !== null && d.to_bell !== undefined && (!isBell(d.to_bell) || d.to_bell < d.from_bell))) fail('fact', 'place_owner');
      return { place: checkPlace(d.place, 'fact'), owner: d.owner, from_bell: d.from_bell, to_bell: d.to_bell ?? null };
    case 'coverage':
      // 4 attests: in `world`, every CARAVAN_SENT of `sender` with a departure bell in [from_bell, to_bell], over the
      // listed `routes`, read from a gapless slot range at the stated finality, is exactly `caravans`. Whether it is
      // SUFFICIENT to prove "not sent" is decided by the fold (fold.mjs coverageSufficiency), not here.
      // `sender` is the tag in `partition`; the window is in world bells; a window may be covered by attestations
      // from several partitions (the fold joins them through identity_alias).
      if (!isPartition(d.partition) || !isTag(d.sender) || !isBell(d.from_bell) || !isBell(d.to_bell) || d.to_bell < d.from_bell || d.to_bell > bell || !Array.isArray(d.caravans)) fail('fact', 'coverage');
      if (!Array.isArray(d.routes) || !d.routes.every(r => typeof r === 'string')) fail('fact', 'coverage routes');
      if (!FINALITY.includes(d.finality)) fail('fact', 'coverage finality');
      if (!d.completeness || typeof d.completeness.gapless !== 'boolean' || !Number.isInteger(d.completeness.from_slot) || !Number.isInteger(d.completeness.to_slot)
        || d.completeness.to_slot < d.completeness.from_slot) fail('fact', 'coverage completeness {gapless, from_slot, to_slot}');
      { const caravans = d.caravans.map(c => checkCaravan(c, 'fact'));
        if (caravans.some(c => c.partition !== d.partition || c.sender !== d.sender)) fail('fact', 'coverage lists only the sender\'s caravans of its partition');
        return { world: checkWorld(d.world, 'fact'), partition: d.partition, sender: d.sender, from_bell: d.from_bell, to_bell: d.to_bell, routes: [...new Set(d.routes)].sort(),
          finality: d.finality, completeness: { gapless: d.completeness.gapless, from_slot: d.completeness.from_slot, to_slot: d.completeness.to_slot }, caravans }; }
    case 'lookup_failed': // 4 tried and could not answer: unknown, not "absent"
      if (!['coverage', 'caravan', 'place_owner', 'credit'].includes(d.query) || !d.reason) fail('fact', 'lookup_failed');
      return { query: d.query, partition: isPartition(d.partition) ? d.partition : null, sender: isTag(d.sender) ? d.sender : null,
        caravan: d.caravan ? checkCaravan(d.caravan, 'fact') : null, reason: safeText(d.reason, { kind: 'trusted', limit: 120 }) };
    case 'identity_alias': // 4 attests: in `partition`, chain tag `tag` is the citizen of world principal `principal`
      if (!isPartition(d.partition) || !isTag(d.tag) || !isTag(d.principal)) fail('fact', 'identity_alias {partition, tag, principal}');
      return { partition: d.partition, tag: d.tag, principal: d.principal };
    case 'place_alias': // 4 attests: place `a` (one partition) and place `b` (another) are the same place of the world
      { const a = checkPlace(d.a, 'fact'), b = checkPlace(d.b, 'fact');
        if (a.partition === b.partition) fail('fact', 'place_alias joins places of two partitions');
        return { a, b }; }
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

// ------------------------------------------------------------------ allocation (signed)

// v2 (record v4) signs the world {cluster, world_id} and a partitioned caravan; v1 (record v3) signed a world with a
// season. Each record is verified with the domain of the version it was written in, never re-signed.
export const ALLOCATION_DOMAIN = 'wylls-memory12-allocation/v2';
export const ALLOCATION_DOMAINS = Object.freeze({ 3: 'wylls-memory12-allocation/v1', 4: ALLOCATION_DOMAIN });

/** The exact bytes a signer signs: domain (by record version), world and the operation, as canonical JSON. */
export function allocationBytes({ v = RECORD_VERSION, world, by, op, commitment, caravan, qty, nonce, bell, visibility }) {
  const domain = ALLOCATION_DOMAINS[v];
  if (!domain) throw new RecordError('allocation', `no signing domain for record v${v}`);
  return Buffer.from(canonical({ domain, world, by, op, commitment, caravan, qty, nonce, bell, visibility }), 'utf8');
}

/**
 * A signed allocation operation. op 'set' says "qty of `caravan` is for `commitment`"; op 'revoke' withdraws the
 * signer's allocation of that caravan to that commitment. `nonce` is the signer's own counter (one operation per
 * nonce); `bell` is when it was signed, `created_bell` when it reached memory. The signature is checked against the
 * key registry by `verifyAllocation` (the store refuses an allocation that fails it).
 */
export function allocation({ world, by, op, commitment, caravan, qty = 0, nonce, bell, created_bell = bell, visibility, sig }) {
  if (!isTag(by) || !['set', 'revoke'].includes(op) || typeof commitment !== 'string' || !commitment) fail('allocation', 'by / op / commitment');
  // a nonce beyond 2^53 would round onto another one and defeat the reuse check
  if (!Number.isSafeInteger(nonce) || nonce < 0 || !isBell(bell) || !isBell(created_bell) || created_bell < bell) fail('allocation', 'nonce / bell');
  if (op === 'set' ? !isQty(qty) : qty !== 0) fail('allocation', 'qty (positive for set, 0 for revoke)');
  if (typeof sig !== 'string' || !/^[0-9a-f]{128}$/.test(sig)) fail('allocation', 'sig (ed25519, 64 bytes hex)');
  // visibility is signed too: an allocation names a commitment, so it is shown to whom the signer chose (normally the
  // parties of a private promise) and nobody can widen it
  const signed = { world: checkWorld(world, 'allocation'), by, op, commitment, caravan: checkCaravan(caravan, 'allocation'), qty, nonce, bell,
    visibility: checkVisibility(visibility) };
  const body = { v: RECORD_VERSION, type: 'allocation', ...signed, created_bell, sig };
  // the id covers the signed content only: the same operation received again (another created_bell) is a duplicate
  return { id: idOf('allocation', signed), ...body, epistemic: EPISTEMIC.allocation, sources: [], nonce_key: `${by}#${nonce}`,
    body_sha: sha256hex(canonical(signed)).slice(0, 16) };
}

/** Verify an allocation's signature with the signer's registered ed25519 public key (32 bytes hex). */
export function verifyAllocation(rec, keys) {
  const hex = keys?.[rec.by];
  if (!hex) return 'auth_unknown_signer';
  try {
    const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(hex, 'hex')]);
    const pub = createPublicKey({ key: spki, format: 'der', type: 'spki' });
    return verifySig(null, allocationBytes(rec), pub, Buffer.from(rec.sig, 'hex')) ? null : 'auth_bad_signature';
  } catch { return 'auth_bad_key'; }
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
export function decision({ owner, nation, bell, request, candidates, limits, input, chosen, policy, cited = [], contributions = {} }) {
  if (!isTag(owner) || !isBell(bell)) fail('decision', 'fields');
  // `input` is the exact decision input the policy was shown: what was visible at the time, kept as it was
  const body = { v: RECORD_VERSION, type: 'decision', owner, nation: nation ?? null, bell, created_bell: bell, request, candidates, limits,
    input, input_sha256: sha256hex(canonical(input)), chosen, policy: String(policy), cited: [...cited], contributions,
    visibility: { scope: 'parties', members: [owner] } };
  return { id: idOf('decision', body), ...body, epistemic: EPISTEMIC.decision, sources: [...cited] };
}
