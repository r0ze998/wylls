// Host-only unsigned review. No wallet, signature, transaction or send API.
import { inspectionRequest, requestDigest, readInspection } from './fexpedition.mjs';
import { originalReturnModel } from './fexpedition-return.mjs';
import { parseU64 } from './map/wide.mjs';
import { parseMessage, COMPUTE_BUDGET_PROGRAM } from '../sdk/solana-tx.mjs';
import { decode, encode } from '../sdk/base58.mjs';
import { fromBase64, toBase64, toHex } from '../sdk/bytes.mjs';
import { sha256 } from '../sdk/sha256.mjs';

export const PREPARE_REQUEST_SCHEMA = 'frontier-experimental-expedition-prepare-request-v1';
export const PREPARE_REPORT_SCHEMA = 'frontier-experimental-expedition-prepare-report-v1';
const CLOSED = ['ready', 'deployment_verified', 'admitted', 'signed', 'enqueued', 'relay_submission_available', 'automatic_send'];
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const exact = (x, keys) => object(x) && Object.keys(x).length === keys.length && keys.every(k => Object.hasOwn(x, k));
const stable = x => JSON.stringify(x, (_, v) => object(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
const check = (ok, code = 'BadPreparationReport') => { if (!ok) throw Object.assign(new Error(code), { code }); };
const hex = x => typeof x === 'string' && /^[0-9a-f]{64}$/.test(x);
const copy = x => JSON.parse(JSON.stringify(x));
const freeze = x => { if (object(x) || Array.isArray(x)) { Object.values(x).forEach(freeze); Object.freeze(x); } return x; };
const uint = x => parseU64(x, 'BadPreparationReport');
function address(s) { check(typeof s === 'string'); const b = decode(s); check(b.length === 32 && b.some(x => x !== 0) && encode(b) === s); return s; }
let sequence = 0;

/** Rebuild the proposal from the selected validated observation, never raw draft input. */
export function preparationRequest(report, sourceRequest, requestId = `${Date.now()}_${++sequence}`) {
  check(typeof requestId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(requestId), 'BadPreparationRequest');
  check(sourceRequest?.deployment?.program_version === '18436', 'ExperimentalPreparationUnavailable');
  const p = originalReturnModel(report, sourceRequest).proposal;
  check(p && sourceRequest.payer !== null, 'PreparationProposalUnavailable');
  return freeze({ schema: PREPARE_REQUEST_SCHEMA, request_id: requestId, action: p.action,
    source_request: copy(sourceRequest), source_context_slot: p.binding.context_slot,
    source_snapshot_digest: p.binding.snapshot_digest,
    proposal: { bytes_hex: p.bytes_hex, content_digest: p.content_digest, roles: copy(p.roles) } });
}

/** Strictly check public unsigned bytes against this request, not the report's claims. */
export function preparationReport(value, request) {
  check(exact(value, ['schema', 'status', 'request', 'source', 'blockhash', 'prepared', 'blocker', 'host_only', ...CLOSED]));
  check(value.schema === PREPARE_REPORT_SCHEMA && ['prepared', 'blocked'].includes(value.status)
    && value.host_only === true && CLOSED.every(k => value[k] === false));
  check(stable(value.request) === stable(request), 'PreparationRequestMismatch');
  const s = value.source, b = value.blockhash, p = value.prepared;
  if (s !== null) {
    check(exact(s, ['request_digest', 'context_slot', 'digest', 'coherent', 'authority_verified'])
      && s.request_digest === requestDigest(request.source_request) && hex(s.digest)
      && s.coherent === true && s.authority_verified === false);
    check(uint(s.context_slot) >= uint(request.source_context_slot), 'PreparationSourceStale');
  }
  if (b !== null) {
    check(s !== null && exact(b, ['hash', 'latest_context_slot', 'validity_context_slot', 'height_min_context_slot',
      'block_height', 'last_valid_block_height', 'remaining_block_heights', 'valid', 'commitment', 'coherent', 'authority_verified'])
      && b.valid === true && b.commitment === 'confirmed' && b.coherent === false && b.authority_verified === false);
    address(b.hash);
    check(uint(b.latest_context_slot) >= uint(s.context_slot) && uint(b.validity_context_slot) >= uint(b.latest_context_slot)
      && b.height_min_context_slot === b.validity_context_slot, 'PreparationBlockhashContext');
    const left = uint(b.last_valid_block_height) - uint(b.block_height);
    check(left >= 2n && uint(b.remaining_block_heights) === left, 'PreparationBlockhashExpired');
  }
  if (value.status === 'blocked') {
    check(p === null && exact(value.blocker, ['code']) && /^[A-Za-z][A-Za-z0-9]{0,119}$/.test(value.blocker.code));
    return freeze(copy(value));
  }
  check(s !== null && b !== null && value.blocker === null && exact(p, ['program', 'season', 'program_version', 'action',
    'fee_payer', 'budget', 'roles', 'instruction_hex', 'message_b64', 'message_digest', 'signers', 'shape', 'proposal_digest']));
  const r = request.source_request, roles = request.proposal.roles;
  check(p.program === r.program && p.season === r.season && p.program_version === '18436'
    && p.action === request.action && p.fee_payer === r.payer && p.proposal_digest === request.proposal.content_digest
    && stable(p.roles) === stable(roles), 'PreparationScopeMismatch');
  const budget = p.budget;
  check(exact(budget, ['cu_limit', 'cu_price', 'loaded_limit', 'heap']) && Number.isInteger(budget.cu_limit)
    && budget.cu_limit > 0 && budget.cu_limit <= 1_400_000 && budget.cu_price === '0'
    && Number.isInteger(budget.loaded_limit) && budget.loaded_limit > 0 && budget.loaded_limit <= 67_108_864
    && budget.heap === 256 * 1024, 'PreparationBudgetMismatch');
  const expectedHex = (request.action === 'Dissolve' ? 'daff0204' : 'dcff0205') + request.proposal.bytes_hex;
  check(p.instruction_hex === expectedHex, 'PreparationInstructionMismatch');
  check(typeof p.message_b64 === 'string' && p.message_b64.length <= 1644 && hex(p.message_digest));
  const bytes = fromBase64(p.message_b64);
  check(toBase64(bytes) === p.message_b64 && toHex(sha256(bytes)) === p.message_digest, 'PreparationMessageDigest');
  const m = parseMessage(bytes);
  check(m.recentBlockhash === b.hash && m.accountKeys[0] === r.payer && m.instructions.length === 5, 'PreparationMessageMismatch');
  for (const [i, op, n] of [[0, 2, budget.cu_limit], [1, 3, 0], [2, 4, budget.loaded_limit], [3, 1, 256 * 1024]]) {
    const ix = m.instructions[i], data = ix.data;
    check(ix.programId === COMPUTE_BUDGET_PROGRAM && ix.keys.length === 0 && data.length === (op === 3 ? 9 : 5)
      && data[0] === op && new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(1, true) === n
      && (op !== 3 || data.slice(5).every(x => x === 0)), 'PreparationBudgetMismatch');
  }
  const union = new Map();
  for (const role of roles) { const old = union.get(role.address); union.set(role.address, {
    signer: role.signer || !!old?.signer, writable: role.writable || !!old?.writable }); }
  check(!union.has(r.program) && !union.has(COMPUTE_BUDGET_PROGRAM));
  const ix = m.instructions[4];
  check(ix.programId === r.program && toHex(ix.data) === expectedHex && ix.keys.length === roles.length
    && ix.keys.every((key, i) => key.pubkey === roles[i].address && key.isSigner === union.get(key.pubkey).signer
      && key.isWritable === union.get(key.pubkey).writable), 'PreparationRolesMismatch');
  check(m.accountKeys.length === union.size + 2 && m.accountKeys.every(key => union.has(key) || key === r.program || key === COMPUTE_BUDGET_PROGRAM), 'PreparationExtraAccount');
  // Programs must remain readonly nonsigners, including when account ordering differs from the JS compiler.
  const h = m.header, n = m.accountKeys.length;
  for (let i = 0; i < n; i++) {
    const expected = union.get(m.accountKeys[i]) ?? { signer: false, writable: false };
    check((i < h.numRequiredSignatures) === expected.signer
      && (i < h.numRequiredSignatures ? i < h.numRequiredSignatures - h.numReadonlySignedAccounts : i < n - h.numReadonlyUnsignedAccounts) === expected.writable, 'PreparationRolesMismatch');
  }
  check(stable(p.signers) === stable(m.signers) && m.signers[0] === r.payer, 'PreparationSignerMismatch');
  const shape = { bytes: bytes.length + 1 + 64 * m.signers.length, locks: n,
    writes: n - h.numReadonlySignedAccounts - h.numReadonlyUnsignedAccounts, sigs: m.signers.length };
  check(shape.bytes <= 1232 && stable(p.shape) === stable(shape), 'PreparationShapeMismatch');
  return freeze(copy(value));
}

const runs = new WeakMap();
const runOf = fs => { if (!runs.has(fs)) runs.set(fs, { generation: 0 }); return runs.get(fs); };
export function clearPreparation(fs) {
  const run = runOf(fs); ++run.generation; run.abort?.abort(); run.abort = null; run.capture = null;
  if (fs.expeditionPreview) fs.expeditionPreview.preparation = null;
}
function current(fs, ctx, snap) {
  try { return fs.expeditionPreview === snap.state && snap.state.report === snap.report && snap.state.request === snap.request
    && ctx.source === snap.source && ctx.relay === snap.relay && fs.wallet === snap.wallet && fs.session === snap.session
    && stable(inspectionRequest(fs, ctx)) === stable(snap.request); } catch { return false; }
}
export function reconcilePreparation(fs, ctx) {
  const run = runOf(fs);
  if (run.capture && !current(fs, ctx, run.capture)) { clearPreparation(fs); return false; } return true;
}
export async function prepareExpedition(fs, { context, read = readInspection, changed = () => {} } = {}) {
  clearPreparation(fs);
  const run = runOf(fs), generation = run.generation, state = fs.expeditionPreview;
  let request, snap;
  try {
    const ctx = context(), selected = inspectionRequest(fs, ctx);
    check(state?.report && stable(selected) === stable(state.request), 'PreparationSelectionChanged');
    request = preparationRequest(state.report, selected);
    snap = { state, report: state.report, request: state.request, source: ctx.source, relay: ctx.relay, wallet: fs.wallet, session: fs.session };
  } catch (e) { if (state) state.preparation = { status: 'error', error: e.code ?? 'PreparationUnavailable', report: null }; changed(); return; }
  run.capture = snap; run.abort = new AbortController();
  const isCurrent = () => generation === run.generation && current(fs, context(), snap);
  state.preparation = { status: 'loading', error: null, report: null }; changed();
  try {
    const value = await read(request, { relay: snap.relay, path: '/f/expedition/prepare', signal: run.abort.signal, isCurrent });
    if (!isCurrent()) { if (generation === run.generation) clearPreparation(fs); return; }
    const report = preparationReport(value, request);
    if (isCurrent()) state.preparation = { status: report.status, error: null, report };
  } catch (e) {
    if (!isCurrent()) { if (generation === run.generation) clearPreparation(fs); return; }
    state.preparation = { status: 'error', error: e.code ?? 'PreparationUnavailable', report: null };
  } finally { if (generation === run.generation) { run.abort = null; changed(); } }
}
