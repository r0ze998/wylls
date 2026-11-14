// Browser side of the UNSIGNED original-host Depart preparation (gateway POST /f/expedition/depart/prepare, keeper
// experimental_expedition_depart_prepare). Pure: the web SDK only, no wallet, signature, seal, key, transaction or
// send API. It builds the request from the boundary draft as it stands and its bound, coherent observation, asks the
// relay, and re-checks the whole answer itself: roles, inner bytes, digests and the unsigned message.
//
// What a prepared report is: unsigned bytes that match this draft's public facts at one observed slot. What it is
// not: an admitted, signed, sealed-and-valid or sendable departure. The commit and seal are opaque bytes the caller
// already holds in public form; none is made, derived or checked here, and without them this module refuses
// (DepartSealUnavailable). `seal_verified` and every other closed flag stay false.
import { OUTBOUND_POP, reconcileOutbound, inspectOutboundContext, outboundArrivalCandidate } from './fexpedition-compose.mjs';
import { canonicalOutboundRoles } from './fexpedition-depart.mjs';
import { withSeed, seedOf } from './faddr.mjs';
import { parseMessage, COMPUTE_BUDGET_PROGRAM } from '../sdk/solana-tx.mjs';
import { decode, encode } from '../sdk/base58.mjs';
import { fromBase64, toBase64, fromHex, toHex, utf8 } from '../sdk/bytes.mjs';
import { sha256 } from '../sdk/sha256.mjs';
import { servesDeploymentVersion } from './flocallanes.mjs';

export const DEPART_PREPARE_REQUEST_SCHEMA = 'frontier-experimental-expedition-depart-prepare-request-v1';
export const DEPART_PREPARE_REPORT_SCHEMA = 'frontier-experimental-expedition-depart-prepare-report-v1';
export const DEPART_PREPARE_PATH = '/f/expedition/depart/prepare';
export const DEPART_PREPARE_MAX_REQUEST_BYTES = 16 * 1024;
export const DEPART_PREPARE_MAX_REPORT_BYTES = 64 * 1024;
export const DEPART_PREPARE_TIMEOUT_MS = 30_000;
/** expedition_dispatch_ix::PROGRAM_VERSION (S1 | wide 0x4000 | host-only dispatch 0x0800). */
export const DEPART_PREPARE_PROGRAM_VERSION = '18436';
export const DEPART_SEAL_BYTES = 264;
/** fclient DEPART_HEAP_FRAME: the one fixed heap frame of a Depart (256 KiB); the real SBF program does not complete a
 * Depart in the default 32 KiB heap. Exactly this value, in exactly one place of the message. */
export const DEPART_HEAP_FRAME = 256 * 1024;
const DIGEST_DOMAIN = 'PSF-ORIGINAL-DEPART-DRAFT-v1';
const INNER_HEAD = [0xda, 0xff, 1, 6], OUTER_HEAD = [0xda, 0xff, 2, 0], INNER_BYTES = 369;
/** fclient original_expedition_depart_draft::NOT_PROVEN, carried by every report. */
export const DEPART_NOT_PROVEN = Object.freeze([
  'canonical deployed program, Season account and account ownership',
  'wallet signatures, authorization, Citizen ownership and host issuance',
  'current residency, capture/transit locks and free embedded transit slot',
  'arrival timing, land availability, economics, Resolve and readiness',
  'commit/seal binding to plaintext, ciphertext validity or decryptability',
  'public dispatch or executable instruction admission',
]);
/** The flags a report carries closed. This module never opens one and refuses a report that does. */
export const DEPART_PREPARE_CLOSED = Object.freeze(['ready', 'deployment_verified', 'admitted', 'signed', 'enqueued', 'relay_submission_available', 'automatic_send', 'seal_verified']);
const CLOSED_STATE = Object.freeze({ dispatch_available: false, executable: false, admitted: false, sealed: false, seal_verified: false, signed: false, enqueued: false, automatic_send: false, sendable: false });

const fail = code => { throw Object.assign(new Error(code), { code }); };
const check = (ok, code = 'BadDepartPreparationReport') => { if (!ok) fail(code); };
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const exact = (x, keys) => object(x) && Object.keys(x).length === keys.length && keys.every(k => Object.hasOwn(x, k));
const hex = (v, bytes) => typeof v === 'string' && v.length === 2 * bytes && /^[0-9a-f]*$/.test(v);
const uint = (v, max = 0xffffffffffffffffn) => typeof v === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(v) && BigInt(v) <= max;
const int64 = v => typeof v === 'string' && /^(0|-?[1-9][0-9]{0,19})$/.test(v) && BigInt(v) >= -(1n << 63n) && BigInt(v) < (1n << 63n);
const address = v => { try { const b = decode(v); return typeof v === 'string' && v.length <= 44 && b.length === 32 && b.some(x => x !== 0) && encode(b) === v; } catch { return false; } };
const stable = x => JSON.stringify(x, (_, v) => object(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
const copy = x => JSON.parse(JSON.stringify(x));
const freeze = x => { if (object(x) || Array.isArray(x)) { Object.values(x).forEach(freeze); Object.freeze(x); } return x; };
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const le32 = n => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; };
const le64 = n => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), true); return b; };
const join = parts => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0; for (const p of parts) { out.set(p, at); at += p.length; } return out; };
const ROLE = ['name', 'address', 'signer', 'writable'];
const SCOPE = ['schema', 'request_id', 'cluster', 'program', 'season', 'deployment', 'wallet', 'payer', 'host', 'standing',
  'transit_slot', 'arrive_bell', 'tip', 'public_commit', 'public_seal', 'min_slot'];

/** Whether `sealed` is a public commit and seal this request may carry: lengths, non-zero, the seal's first-byte syntax. Says nothing of their validity. */
export function publicSealOk(sealed) {
  if (!exact(sealed, ['commit', 'seal']) || !hex(sealed.commit, 32) || !hex(sealed.seal, DEPART_SEAL_BYTES)) return false;
  if (/^0*$/.test(sealed.commit) || /^0*$/.test(sealed.seal)) return false;
  const first = Number.parseInt(sealed.seal.slice(0, 2), 16);
  return (first & 0x80) !== 0 && (first & 0x40) === 0;
}

/** The canonical proposal of a request's scope: nine roles, the 369 inner bytes, the keeper's content digest. */
export function canonicalDepartProposal(scope) {
  const citizen = withSeed(scope.season, seedOf('Citizen', { wallet: scope.wallet }), scope.program);
  const roles = canonicalOutboundRoles({ program: scope.program, season: scope.season, wallet: scope.wallet, payer: scope.payer,
    original_owner: citizen, host: scope.host, origin: { p: scope.standing.p, q: scope.standing.q } }, { transitSlot: Number(scope.transit_slot) })
    .map(r => ({ name: r.name, address: r.address, signer: r.signer, writable: r.writable }));
  const bytes = join([Uint8Array.from(INNER_HEAD), fromHex(scope.host), Uint8Array.of(Number(scope.transit_slot)), le32(Number(scope.arrive_bell)), le64(scope.tip),
    fromHex(scope.public_commit), fromHex(scope.public_seal)]);
  check(bytes.length === INNER_BYTES && roles.length === 9, 'DepartDraftContract');
  const parts = [utf8(DIGEST_DOMAIN), decode(scope.program), decode(scope.season), le32(bytes.length), bytes, le32(roles.length)];
  for (const r of roles) { const name = utf8(r.name); parts.push(le32(name.length), name, decode(r.address), Uint8Array.of(+r.signer, +r.writable)); }
  return { bytes_hex: toHex(bytes), content_digest: toHex(sha256(join(parts))), roles };
}

/** A whole request, checked and rebuilt (the keeper's parse_request, mirrored): only the canonical proposal survives. */
export function departPreparationRequestOf(value) {
  const bad = () => fail('BadDepartPreparationRequest');
  if (!exact(value, [...SCOPE, 'proposal']) || value.schema !== DEPART_PREPARE_REQUEST_SCHEMA
      || typeof value.request_id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value.request_id)
      || typeof value.cluster !== 'string' || !/^[a-z0-9-]{1,32}$/.test(value.cluster)
      || !exact(value.deployment, ['program_version', 'ruleset_hash']) || !servesDeploymentVersion(value.deployment.program_version) || !hex(value.deployment.ruleset_hash, 32)
      || !['program', 'season', 'wallet', 'payer'].every(k => address(value[k])) || value.program === value.season
      || !exact(value.standing, ['p', 'q']) || !int64(value.standing.p) || !int64(value.standing.q)
      || !hex(value.host, 56) || !uint(value.transit_slot, 3n) || !uint(value.arrive_bell, 0xffffffffn) || !uint(value.tip) || !uint(value.min_slot)
      || !publicSealOk({ commit: value.public_commit, seal: value.public_seal })
      || !exact(value.proposal, ['bytes_hex', 'content_digest', 'roles']) || !Array.isArray(value.proposal.roles) || value.proposal.roles.length !== 9) bad();
  const scope = { ...Object.fromEntries(SCOPE.map(k => [k, value[k]])), deployment: { ...value.deployment }, standing: { ...value.standing } };
  let canonical; try { canonical = canonicalDepartProposal(scope); } catch { bad(); }
  if (value.proposal.bytes_hex !== canonical.bytes_hex || value.proposal.content_digest !== canonical.content_digest
      || value.proposal.roles.some((r, i) => !exact(r, ROLE) || ROLE.some(k => r[k] !== canonical.roles[i][k]))) bad();
  const request = { ...scope, proposal: canonical };
  if (utf8(JSON.stringify(request)).length > DEPART_PREPARE_MAX_REQUEST_BYTES) bad();
  return freeze(request);
}

let sequence = 0;
/**
 * The request for the boundary draft AS IT STANDS (`fs.expeditionCompose`), never from raw input:
 *  - the card is open on a reviewed draft with canonical roles and an observed free transit slot;
 *  - its departure-conditions observation is finished, still bound to this draft's source and steps
 *    (outboundArrivalCandidate's binding), coherent, content-consistent, and says both the host/village conditions
 *    and the route hold at that slot: `min_slot` is that observation's slot;
 *  - the Season is the host-only dispatch revision;
 *  - `sealed` = `{commit, seal}`: lowercase hex of a commit and seal that are ALREADY PUBLIC. Absent or malformed:
 *    DepartSealUnavailable. Nothing here makes one.
 * Throws with a code; returns a frozen canonical request.
 */
export function departPreparationRequest(fs, { sealed = null, requestId = `${Date.now()}_${++sequence}` } = {}) {
  const s = fs.expeditionCompose;
  check(fs.hand?.pop === OUTBOUND_POP && !!s?.source && s.status === 'review' && !!s.review, 'DepartDraftUnavailable');
  let bound = null; try { bound = outboundArrivalCandidate(fs); } catch { /* no bound observation */ }
  const c = s.contextCheck;
  check(bound?.from === 'context' && c?.status === 'read' && c.coherent === true && c.contentConsistent === true, 'DepartObservationUnavailable');
  check(c.ready?.ok === true && c.report?.ok === true, 'DepartObservationNotReady');
  const r = s.review, src = s.source;
  check(Array.isArray(r.roles) && r.roles.length === 9 && Number.isInteger(r.transitSlot) && r.transitSlot === src.transitSlot, 'DepartRolesUnavailable');
  check(servesDeploymentVersion(String(src.programVersion)), 'ExperimentalPreparationUnavailable');
  // The explicit wallet path only: the acting wallet is also the fee payer. The relay prepares for its ONE configured
  // public fee payer, so this request is served only when that payer is this wallet; any other wallet is answered
  // ExpeditionDepartPrepareScopeMismatch by the relay. No other payer is named or substituted here.
  check(src.payer === src.wallet, 'DepartPayerUnavailable');
  check(Number.isInteger(r.arriveBell) && String(r.arriveBell) === s.arriveBell && uint(String(r.tip?.lamports ?? '')) && uint(String(c.contextSlot ?? '')), 'DepartDraftUnavailable');
  check(publicSealOk(sealed), 'DepartSealUnavailable');
  check(typeof requestId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(requestId), 'BadDepartPreparationRequest');
  const scope = { schema: DEPART_PREPARE_REQUEST_SCHEMA, request_id: requestId, cluster: src.cluster, program: src.program, season: src.season,
    deployment: { program_version: String(src.programVersion), ruleset_hash: src.ruleset }, wallet: src.wallet, payer: src.payer, host: src.host,
    standing: { p: src.origin.p, q: src.origin.q }, transit_slot: String(r.transitSlot), arrive_bell: String(r.arriveBell), tip: String(r.tip.lamports),
    public_commit: sealed.commit, public_seal: sealed.seal, min_slot: String(c.contextSlot) };
  let request;
  try { request = departPreparationRequestOf({ ...scope, proposal: canonicalDepartProposal(scope) }); } catch { fail('DepartDraftUnavailable'); }
  // The draft's own reviewed roles are the ones the request carries.
  check(stable(request.proposal.roles) === stable(r.roles.map(x => ({ name: x.name, address: x.address, signer: x.signer, writable: x.writable }))), 'DepartRolesUnavailable');
  return request;
}

const BLOCKHASH = ['hash', 'latest_context_slot', 'validity_context_slot', 'height_min_context_slot', 'block_height', 'last_valid_block_height', 'remaining_block_heights', 'valid', 'commitment', 'coherent', 'authority_verified'];
const budgetData = (tag, value, size) => join([Uint8Array.of(tag), size === 8 ? le64(value) : le32(value)]);

/**
 * The relay's answer, believed in nothing: every closed flag closed, the echo this request, the source at or after
 * the observed slot with this arrival turn inside the program's window, the blockhash observation consistent, and
 * the unsigned message parsed and compared instruction by instruction, account by account, with what this request
 * alone determines. Returns a frozen copy, or throws with a code.
 */
export function departPreparationReport(value, request) {
  check(exact(value, ['schema', 'status', 'request', 'source', 'blockhash', 'prepared', 'blocker', 'not_proven', 'host_only', ...DEPART_PREPARE_CLOSED])
    && value.schema === DEPART_PREPARE_REPORT_SCHEMA && ['prepared', 'blocked'].includes(value.status) && value.host_only === true
    && Array.isArray(value.not_proven) && same(value.not_proven, DEPART_NOT_PROVEN));
  check(DEPART_PREPARE_CLOSED.every(k => value[k] === false), 'UnsafeDepartPreparationReport');
  if (value.request !== null || value.status === 'prepared') check(object(value.request) && stable(value.request) === stable(request), 'DepartPreparationRequestMismatch');
  if (value.status === 'blocked') {
    check(value.source === null && value.blockhash === null && value.prepared === null && exact(value.blocker, ['code'])
      && typeof value.blocker.code === 'string' && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(value.blocker.code));
    return freeze(copy(value));
  }
  check(value.blocker === null);
  const s = value.source, b = value.blockhash, p = value.prepared, roles = request.proposal.roles;
  check(exact(s, ['context_slot', 'unix_timestamp', 'current_bell', 'arrive_bell', 'transit_slot_free', 'coherent', 'authority_verified'])
    && uint(s.context_slot) && int64(s.unix_timestamp) && uint(s.current_bell, 0xffffffffn)
    && s.transit_slot_free === true && s.coherent === true && s.authority_verified === false, 'BadDepartPreparationSource');
  check(BigInt(s.context_slot) >= BigInt(request.min_slot), 'DepartPreparationSourceStale');
  check(s.arrive_bell === request.arrive_bell && BigInt(s.arrive_bell) >= BigInt(s.current_bell) + 2n && BigInt(s.arrive_bell) <= BigInt(s.current_bell) + 72n, 'DepartPreparationArrival');
  check(exact(b, BLOCKHASH) && address(b.hash)
    && ['latest_context_slot', 'validity_context_slot', 'height_min_context_slot', 'block_height', 'last_valid_block_height', 'remaining_block_heights'].every(k => uint(b[k]))
    && b.valid === true && b.commitment === 'confirmed' && b.coherent === false && b.authority_verified === false, 'BadDepartPreparationBlockhash');
  check(BigInt(b.latest_context_slot) >= BigInt(s.context_slot) && BigInt(b.validity_context_slot) >= BigInt(b.latest_context_slot)
    && b.height_min_context_slot === b.validity_context_slot, 'DepartPreparationBlockhashContext');
  check(BigInt(b.remaining_block_heights) >= 2n && BigInt(b.last_valid_block_height) - BigInt(b.block_height) === BigInt(b.remaining_block_heights), 'DepartPreparationBlockhashExpired');
  check(exact(p, ['program', 'season', 'program_version', 'action', 'fee_payer', 'budget', 'roles', 'instruction_hex', 'message_b64', 'message_digest', 'signers', 'shape', 'proposal_digest'])
    && p.program === request.program && p.season === request.season && p.program_version === request.deployment.program_version && p.action === 'Depart'
    && p.fee_payer === request.payer && p.proposal_digest === request.proposal.content_digest && stable(p.roles) === stable(roles), 'DepartPreparationScopeMismatch');
  const budget = p.budget;
  check(exact(budget, ['cu_limit', 'cu_price', 'loaded_limit', 'heap']) && Number.isInteger(budget.cu_limit) && budget.cu_limit > 0 && budget.cu_limit <= 1_400_000
    && budget.cu_price === '0' && Number.isInteger(budget.loaded_limit) && budget.loaded_limit > 0 && budget.loaded_limit <= 67_108_864 && budget.heap === DEPART_HEAP_FRAME, 'DepartPreparationBudgetMismatch');
  const instruction = join([Uint8Array.from(OUTER_HEAD), fromHex(request.proposal.bytes_hex)]);
  check(p.instruction_hex === toHex(instruction), 'DepartPreparationInstructionMismatch');
  check(typeof p.message_b64 === 'string' && p.message_b64.length <= 1644 && hex(p.message_digest, 32));
  let bytes; try { bytes = fromBase64(p.message_b64); } catch { check(false, 'DepartPreparationMessageDigest'); }
  check(toBase64(bytes) === p.message_b64 && toHex(sha256(bytes)) === p.message_digest, 'DepartPreparationMessageDigest');
  let m; try { m = parseMessage(bytes); } catch { check(false, 'DepartPreparationMessageMismatch'); }
  const signers = [request.payer]; if (request.wallet !== request.payer) signers.push(request.wallet);
  check(m.recentBlockhash === b.hash && m.accountKeys[0] === request.payer && m.instructions.length === 5, 'DepartPreparationMessageMismatch');
  check(Array.isArray(p.signers) && same(p.signers, signers) && same(m.signers, signers), 'DepartPreparationSignerMismatch');
  // Exactly five instructions, in this order: compute limit, zero price, loaded-data limit, the one fixed heap frame,
  // the dispatch.
  [[2, budget.cu_limit, 4], [3, 0, 8], [4, budget.loaded_limit, 4], [1, DEPART_HEAP_FRAME, 4]].forEach(([tag, n, size], i) => {
    const ix = m.instructions[i];
    check(ix.programId === COMPUTE_BUDGET_PROGRAM && ix.keys.length === 0 && same([...ix.data], [...budgetData(tag, n, size)]), 'DepartPreparationBudgetMismatch');
  });
  const union = new Map();
  for (const role of roles) { const old = union.get(role.address); union.set(role.address, { signer: role.signer || !!old?.signer, writable: role.writable || !!old?.writable }); }
  check(!union.has(request.program) && !union.has(COMPUTE_BUDGET_PROGRAM), 'DepartPreparationRolesMismatch');
  const game = m.instructions[4];
  check(game.programId === request.program && toHex(game.data) === toHex(instruction), 'DepartPreparationInstructionMismatch');
  check(game.keys.length === roles.length && game.keys.every((key, i) => key.pubkey === roles[i].address
    && key.isSigner === union.get(key.pubkey).signer && key.isWritable === union.get(key.pubkey).writable), 'DepartPreparationRolesMismatch');
  const n = m.accountKeys.length, h = m.header;
  check(n === union.size + 2 && new Set(m.accountKeys).size === n && m.accountKeys.every(key => union.has(key) || key === request.program || key === COMPUTE_BUDGET_PROGRAM), 'DepartPreparationExtraAccount');
  for (let i = 0; i < n; i++) {
    const want = union.get(m.accountKeys[i]) ?? { signer: false, writable: false };
    check((i < h.numRequiredSignatures) === want.signer
      && (i < h.numRequiredSignatures ? i < h.numRequiredSignatures - h.numReadonlySignedAccounts : i < n - h.numReadonlyUnsignedAccounts) === want.writable, 'DepartPreparationRolesMismatch');
  }
  const shape = { bytes: bytes.length + 1 + 64 * m.signers.length, locks: n, writes: n - h.numReadonlySignedAccounts - h.numReadonlyUnsignedAccounts, sigs: m.signers.length };
  check(shape.bytes <= 1232 && shape.locks <= 32 && shape.writes <= 16 && stable(p.shape) === stable(shape), 'DepartPreparationShapeMismatch');
  return freeze(copy(value));
}

/** One bounded, abortable POST to the relay's departure-preparation route. No other path, no retry, no credentials. */
export async function readDepartPreparation(request, { relay, signal, isCurrent = () => true, fetch: fetcher = (...a) => globalThis.fetch(...a), timeoutMs = DEPART_PREPARE_TIMEOUT_MS } = {}) {
  check(typeof relay === 'string' && !!relay, 'NoRelay');
  check(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= DEPART_PREPARE_TIMEOUT_MS, 'BadDepartPreparationTimeout');
  const abort = new AbortController(); let timedOut = false, reader = null, completed = false;
  const cancel = () => abort.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  const alive = () => { if (timedOut) fail('DepartPreparationTimeout'); if (signal?.aborted || abort.signal.aborted || !isCurrent()) fail('DepartPreparationSuperseded'); };
  let rejectDeadline; const deadline = new Promise((_, reject) => { rejectDeadline = reject; });
  deadline.catch(() => {});
  const timer = setTimeout(() => { timedOut = true; abort.abort(); rejectDeadline(Object.assign(new Error('DepartPreparationTimeout'), { code: 'DepartPreparationTimeout' })); }, timeoutMs);
  try {
    alive();
    const response = await Promise.race([fetcher(`${relay.replace(/\/+$/, '')}${DEPART_PREPARE_PATH}`, {
      method: 'POST', cache: 'no-store', credentials: 'omit', signal: abort.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) }), deadline]);
    alive();
    check(!!response?.body?.getReader);
    reader = response.body.getReader();
    const length = response.headers?.get?.('content-length');
    check(length === null || length === undefined || (/^\d+$/.test(length) && Number(length) <= DEPART_PREPARE_MAX_REPORT_BYTES), 'DepartPreparationReportTooLarge');
    const chunks = []; let size = 0;
    for (;;) {
      const part = await Promise.race([reader.read(), deadline]); alive();
      if (part.done) break;
      size += part.value.byteLength; check(size <= DEPART_PREPARE_MAX_REPORT_BYTES, 'DepartPreparationReportTooLarge'); chunks.push(part.value);
    }
    let body; try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(join(chunks))); } catch { fail('BadDepartPreparationReport'); }
    if (!response.ok) fail(typeof body?.code === 'string' && /^[A-Za-z0-9]{1,80}$/.test(body.code) ? body.code : `HTTP${response.status}`);
    completed = true; return body;
  } catch (e) { if (timedOut) fail('DepartPreparationTimeout'); throw e; }
  finally {
    clearTimeout(timer); signal?.removeEventListener('abort', cancel);
    if (!completed) { abort.abort(); if (reader) reader.cancel().catch(() => {}); }
    try { reader?.releaseLock(); } catch { /* still reading: cancelled above */ }
  }
}

// ------------------------------------------------------------------ the run: one at a time, only for the draft it began with
const runs = new WeakMap();
const runOf = fs => { if (!runs.has(fs)) runs.set(fs, { generation: 0, abort: null, capture: null, state: null }); return runs.get(fs); };
const idle = () => ({ status: 'idle', error: null, request: null, report: null, ...CLOSED_STATE });
/** What a run is bound to: the draft object and its reviewed revision, its bound observation, the viewer and the connection. */
const captureOf = (fs, ctx) => { const s = fs.expeditionCompose; return { draft: s, review: s?.review ?? null, observation: s?.contextCheck ?? null, arriveBell: s?.arriveBell,
  wallet: fs.wallet, session: fs.session, sessionKey: fs.session?.publicKey, source: ctx.source, relay: ctx.relay, host: fs.hand?.host }; };
const sameCapture = (a, b) => Object.keys(a).every(k => a[k] === b[k]);
/** `observation: false` while the run's own fresh read is replacing the observation (everything else must hold). */
function current(fs, ctx, snap, observation = true) {
  try {
    if (fs.hand?.pop !== OUTBOUND_POP || !reconcileOutbound(fs, ctx)) return false;
    const now = captureOf(fs, ctx);
    return observation ? sameCapture(now, snap) : sameCapture({ ...now, observation: null }, { ...snap, observation: null });
  } catch { return false; }
}
/** Drop any run and its result (call when the card closes; a changed draft is dropped by itself on the next read). */
export function clearDepartPreparation(fs) { const run = runOf(fs); ++run.generation; run.abort?.abort(); run.abort = null; run.capture = null; run.state = null; }
/**
 * The preparation shown for the draft as it stands, or the idle state: a result whose draft, revision, observation,
 * wallet, session, source or relay has changed since is dropped here, never shown.
 */
export function departPreparationOf(fs, ctx) {
  const run = runOf(fs);
  if (!run.state) return idle();
  if (run.capture && !current(fs, ctx, run.capture, run.state.status !== 'reading')) { clearDepartPreparation(fs); return idle(); }
  return run.state;
}

/**
 * Prepare, unsigned, the departure of the boundary draft:
 *  1. read the departure conditions again now (inspectOutboundContext: source, village, terrain and clock together);
 *  2. build the request from that fresh observation and the draft as it then stands (departPreparationRequest);
 *  3. ask the relay once and re-check the answer whole (departPreparationReport);
 *  4. keep the result only if the draft, its revision, that observation, the wallet, the session, the source and
 *     the relay are still the ones this run began with. A later call supersedes an earlier one.
 * The state never says more than `prepared`: unsigned bytes for these public facts. Nothing is signed or sent.
 * → the state kept (also `departPreparationOf`), or null when this run was superseded.
 */
export async function prepareOutboundDeparture(fs, { context, sealed = null, read = readDepartPreparation, changed = () => {}, inspect = inspectOutboundContext, requestId, ...seams } = {}) {
  clearDepartPreparation(fs);
  const run = runOf(fs), generation = run.generation;
  // This run's own abort handle: `run.abort` may be another run's by the time this one looks again.
  const controller = new AbortController();
  const mine = () => generation === run.generation;
  // `changed` is caller code: it may close the card or start another run before it returns. Every state this run
  // publishes is therefore followed by the question "is it still this run's?", and only then is anything started,
  // kept or returned. A run that is no longer the current one starts no read, cancels nothing and returns null.
  const put = (state, snap) => {
    const kept = Object.freeze({ ...idle(), ...state });
    run.capture = snap; run.state = kept;
    changed();
    return mine() && run.state === kept ? kept : null;
  };
  // A final state is this run's only while the draft it is about still stands: a callback that edits the draft or
  // closes the card without clearing this module is caught here, the state dropped and nothing returned.
  // (`verify: false` only for the refusal "there is no card or draft", which has no draft to stand.)
  const end = (state, snap, verify = true) => {
    if (!mine()) return null;
    if (run.abort === controller) run.abort = null;
    const kept = put(state, snap);
    if (!kept) return null;
    if (verify && !current(fs, context(), snap)) { if (mine() && run.state === kept) clearDepartPreparation(fs); return null; }
    return kept;
  };
  const drop = () => { if (mine()) { clearDepartPreparation(fs); changed(); } return null; };
  const first = context();
  // Refuse early what no fresh read could mend: no card, no draft, no public seal.
  if (fs.hand?.pop !== OUTBOUND_POP || !reconcileOutbound(fs, first) || !fs.expeditionCompose?.source) return end({ status: 'error', error: 'DepartDraftUnavailable' }, captureOf(fs, first), false);
  if (!publicSealOk(sealed)) return end({ status: 'error', error: 'DepartSealUnavailable' }, captureOf(fs, first));
  const began = captureOf(fs, first), draft = fs.expeditionCompose, review = draft.review, arriveBell = draft.arriveBell;
  // The fresh read replaces the observation; everything else must stay what the run began with.
  const unchanged = () => mine() && fs.expeditionCompose === draft && draft.review === review && draft.arriveBell === arriveBell && current(fs, context(), began, false);
  run.abort = controller;
  if (!put({ status: 'reading' }, began)) return null;
  if (!unchanged()) return drop();
  await inspect(fs, { context, changed, ...seams });
  if (!mine()) return null;
  if (!unchanged()) return drop();
  const snap = captureOf(fs, context());
  let request;
  try { request = departPreparationRequest(fs, { sealed, ...(requestId ? { requestId } : {}) }); }
  catch (e) { return end({ status: 'error', error: e.code ?? 'DepartPreparationUnavailable' }, snap); }
  const isCurrent = () => mine() && current(fs, context(), snap);
  if (!put({ status: 'loading', request }, snap)) return null;
  if (!isCurrent()) return drop();
  try {
    const answer = await read(request, { relay: snap.relay, signal: controller.signal, isCurrent });
    if (!mine()) return null;
    if (!isCurrent()) return drop();
    const report = departPreparationReport(answer, request);
    return end({ status: report.status, request, report, error: report.status === 'blocked' ? report.blocker.code : null }, snap);
  } catch (e) {
    if (!mine()) return null;
    if (!isCurrent()) return drop();
    return end({ status: 'error', request, error: e.code ?? 'DepartPreparationUnavailable' }, snap);
  }
}
