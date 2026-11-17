// Local play only, CLOSED BY DEFAULT: the one player-signed conquest step, DeclareSiege of the Free City in the wide
// province an original host stays in, from the expedition card's own observation.
//
//   the card's observation (the host STAYS: nothing pending) + this start's world capability (the Free City of that
//   province)  ──▶  the offer: site (the capability's), roster entry (the observation's)
//   1. prepare   POST /gw/f/local-play/conquest/prepare   the closed request → `{report, submit}`. The page checks the
//                report ITSELF, independently of the gateway: the twelve accounts are derived here from the request
//                (fconquest-identity.mjs, cross-checked with a Rust vector) and must be the message's, with the
//                wrapped DeclareSiege of this site and entry as its one game instruction. Nothing is signed.
//   2. send      the player's explicit press: the memory-only wallet signs THAT message; ONE submit.
//      then      POST /gw/f/local-play/conquest/status   as often as asked: the only reconciliation.
//
// CLOSED: `LOCAL_CONQUEST_PAGE_CONDITIONS` (the heap frame is unconfirmed on the real program) and the world
// capability (none exists for the present world, which has no Free City). While either is missing, `prepare` ends in
// `ConquestRouteClosed` / `ConquestWorldUnavailable` before anything is posted. The relay is closed the same way on
// its side. Nothing here opens either.
//
// The same gate, identity pin and observation binding as the return steps (flocalplay-return.mjs, whose run machinery
// this follows): asked again after every wait; an unknown outcome is asked about by its first signature, never signed
// or sent again; an observation a siege was sent on is used up until the card reads again.
//
// What "confirmed" means here: the chain confirmed the DeclareSiege transaction. A siege is DECLARED. Whether it
// holds, is won or lost, and whether the city is captured, are the turns' own processing; a capture is only ever a
// fact of a later read (the capture receipt, the new Holding at the canonical position, the Citizen's slot), which
// this file neither reads nor claims. Staying in a province is not owning it. Nothing is stored; no key leaves the wallet.
import { loopbackRelay } from './flocalplay-depart.mjs';
import { registerHostStep, claimHostStep, holdHostStep, hostStepInFlight, spendHostObservation, hostObservationSpent } from './flocalplay-hoststep.mjs';
import { LOCAL_PLAY_PROGRAM_VERSION } from './flocalplay.mjs';
import { inspectionRequest, requestDigest } from './fexpedition.mjs';
import { originalReturnModel } from './fexpedition-return.mjs';
import { canonicalDeclareSiegeRoles, declareSiegeInstruction, DECLARE_SIEGE_DISPATCH } from './fconquest-identity.mjs';
import { siegeOrderRead } from './fconquest-order.mjs';
import { parseU64 } from './map/wide.mjs';
import { parseMessage, parseTransaction, wireTransaction, COMPUTE_BUDGET_PROGRAM } from '../sdk/solana-tx.mjs';
import { decode, encode } from '../sdk/base58.mjs';
import { fromBase64, toBase64, toHex } from '../sdk/bytes.mjs';
import { sha256 } from '../sdk/sha256.mjs';

export const LOCAL_CONQUEST_REQUEST_SCHEMA = 'frontier-local-play-conquest-prepare-request-v1';
export const LOCAL_CONQUEST_REPORT_SCHEMA = 'frontier-local-play-conquest-prepare-report-v1';
export const LOCAL_CONQUEST_SUBMIT_SCHEMA = 'frontier-local-play-conquest-submit-v1';
export const LOCAL_CONQUEST_STATUS_SCHEMA = 'frontier-local-play-conquest-status-v1';
export const LOCAL_CONQUEST_WORLD_SCHEMA = 'frontier-local-play-conquest-world-v1';
export const LOCAL_CONQUEST_WORLD_PRESET = 'local-conquest-test-v1';
export const LOCAL_CONQUEST_PREPARE_PATH = '/gw/f/local-play/conquest/prepare';
export const LOCAL_CONQUEST_SUBMIT_PATH = '/gw/f/local-play/conquest/submit';
export const LOCAL_CONQUEST_STATUS_PATH = '/gw/f/local-play/conquest/status';
/** Read-only: this wallet's reservations in the province the host stands in (the relay reads and verifies the accounts). */
export const LOCAL_CONQUEST_ORDERS_PATH = '/gw/f/local-play/conquest/orders';
export const LOCAL_CONQUEST_ORDERS_REQUEST_SCHEMA = 'frontier-local-play-conquest-orders-request-v1';
const PATHS = [LOCAL_CONQUEST_PREPARE_PATH, LOCAL_CONQUEST_SUBMIT_PATH, LOCAL_CONQUEST_STATUS_PATH, LOCAL_CONQUEST_ORDERS_PATH];
export const LOCAL_CONQUEST_MAX_BYTES = 48 * 1024;
export const LOCAL_CONQUEST_TIMEOUT_MS = 35_000;
/**
 * What must ALL be true before this page prepares or signs a siege. Each is a fact to be established and then set
 * here by hand; none is inferred, and a test's explicit `conditions` says nothing about the real program.
 *   heapConfirmed   false: the 256 KiB frame of DECLARE_SIEGE_DISPATCH is a local decision until a real SBF execution
 *                   of the conquest lane accepts a wrapped DeclareSiege with it
 * The world is not a constant: `world()` must give this start's capability (the Free City of the province the host
 * stands in), naming this page's own program and Season. The relay holds its own conditions on its side.
 */
export const LOCAL_CONQUEST_PAGE_CONDITIONS = Object.freeze({ heapConfirmed: false });

const fail = code => { throw Object.assign(new Error(code), { code }); };
const check = (ok, code) => { if (!ok) fail(code); };
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const exact = (x, keys) => object(x) && Object.keys(x).length === keys.length && keys.every(k => Object.hasOwn(x, k));
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const address = v => { try { const b = decode(v); return typeof v === 'string' && v.length <= 44 && b.length === 32 && encode(b) === v; } catch { return false; } };
const hex64 = x => typeof x === 'string' && /^[0-9a-f]{64}$/.test(x);
const uint = x => parseU64(x, 'BadConquestReport');
const codeOf = (e, fallback) => (typeof e?.code === 'string' && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(e.code) ? e.code : fallback);
const stable = x => JSON.stringify(x, (_, v) => object(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
const copy = x => JSON.parse(JSON.stringify(x));
const CLOSED = ['ready', 'deployment_verified', 'admitted', 'signed', 'enqueued', 'relay_submission_available', 'automatic_send'];
const BLOCKERS = ['RequestInvalid', 'SourceUnavailable', 'SourceBlocked', 'TargetNotFreeCity', 'HostNotOnTarget', 'SiegeUnavailable', 'DispatchKindUnavailable', 'BlockhashUnavailable', 'PreflightFailed', 'OutputTooLarge'];

/**
 * Whether the card's observation offers a siege, and of what: the host STAYS in the wide province (the return model's
 * `resident` phase: nothing pending), and this start's world capability names a Free City in THAT province, of this
 * page's own program and Season. The site is the capability's; the roster entry is the observation's.
 * → `{ok: true, site, entry, tile, standing: {p, q}}` or `{ok: false, code}`. Staying is not owning: nothing here says
 * the province or the city is the player's.
 */
export function localConquestOffer(fs, ctx, world) {
  const no = code => ({ ok: false, code });
  try {
    const state = fs?.expeditionPreview, i = fs?.localPlay;
    if (!object(state) || !object(state.report) || !object(state.request) || !object(i)) return no('ConquestObservationMissing');
    const selected = inspectionRequest(fs, ctx);
    if (stable(selected) !== stable(state.request)) return no('ConquestSelectionChanged');
    const model = originalReturnModel(state.report, selected);
    if (model.phase !== 'resident' || model.proposal?.action !== 'Dissolve') return no('ConquestHostNotStaying');
    const observed = state.report.facts?.observed;
    if (observed?.kind !== 'original-host-wide-resident' || !Number.isInteger(observed.entry) || observed.entry < 0 || observed.entry > 55) return no('ConquestHostNotStaying');
    if (!exact(world, ['schema', 'program', 'season', 'world_preset', 'free_city']) || world.schema !== LOCAL_CONQUEST_WORLD_SCHEMA || world.world_preset !== LOCAL_CONQUEST_WORLD_PRESET) return no('ConquestWorldUnavailable');
    if (world.program !== i.programId || world.season !== i.seasonAddress || world.program !== selected.program || world.season !== selected.season) return no('ConquestWorldMismatch');
    const f = world.free_city;
    if (!exact(f, ['p', 'q', 'site', 'tile']) || typeof f.p !== 'string' || typeof f.q !== 'string' || !Number.isInteger(f.site) || f.site < 0 || f.site > 11
        || !Number.isInteger(f.tile) || f.tile < 0 || f.tile > 60) return no('ConquestWorldUnavailable');
    // (the city must be in the province the host stands in: another province's city is not this host's to besiege)
    if (f.p !== selected.standing.p || f.q !== selected.standing.q) return no('ConquestNoFreeCityHere');
    canonicalDeclareSiegeRoles(selected, f.site);   // (the twelve accounts must be nameable for this wallet and host)
    return { ok: true, site: f.site, entry: observed.entry, tile: f.tile, standing: { p: selected.standing.p, q: selected.standing.q } };
  } catch (e) { return no(codeOf(e, 'ConquestOfferUnavailable')); }
}

let sequence = 0;
/** The closed preparation request, rebuilt from the selected validated observation and the offer; never from caller bytes. */
export function conquestPreparationRequest(report, sourceRequest, offer, requestId = `cq_${Date.now()}_${++sequence}`) {
  check(typeof requestId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(requestId), 'BadConquestRequest');
  check(sourceRequest?.deployment?.program_version === String(LOCAL_PLAY_PROGRAM_VERSION) && address(sourceRequest.wallet) && sourceRequest.payer === sourceRequest.wallet, 'BadConquestRequest');
  check(offer?.ok === true && hex64(report?.source?.digest) && typeof report.source.context_slot === 'string', 'BadConquestRequest');
  return Object.freeze({ schema: LOCAL_CONQUEST_REQUEST_SCHEMA, request_id: requestId, action: 'DeclareSiege', source_request: copy(sourceRequest),
    source_context_slot: report.source.context_slot, source_snapshot_digest: report.source.digest, target: Object.freeze({ site: offer.site, entry: offer.entry }) });
}

/**
 * The page's OWN check of the relay's unsigned report for `request`, independent of the gateway's: the echo, every
 * closed flag, the source and blockhash, and the message itself — the budget instructions, then ONE game instruction
 * whose data is the wrapped DeclareSiege of this request's site and entry and whose twelve accounts are the ones this
 * page derives from the request (fconquest-identity.mjs), in order, with their privileges. A report cannot move the
 * signature to another site, province, roster, conquest table, escrow or village. → the report (frozen) or throws.
 */
export function conquestPreparationReport(value, request) {
  const need = (ok, code = 'BadConquestReport') => check(ok, code);
  need(exact(value, ['schema', 'status', 'request', 'source', 'blockhash', 'prepared', 'blocker', 'host_only', ...CLOSED])
    && value.schema === LOCAL_CONQUEST_REPORT_SCHEMA && ['prepared', 'blocked'].includes(value.status) && value.host_only === true && CLOSED.every(k => value[k] === false));
  need(stable(value.request) === stable(request), 'ConquestRequestMismatch');
  const s = value.source, b = value.blockhash, p = value.prepared, r = request.source_request, pin = DECLARE_SIEGE_DISPATCH;
  if (s !== null) {
    need(exact(s, ['request_digest', 'context_slot', 'digest', 'coherent', 'authority_verified']) && s.request_digest === requestDigest(r) && hex64(s.digest) && s.coherent === true && s.authority_verified === false);
    need(uint(s.context_slot) >= uint(request.source_context_slot), 'ConquestSourceStale');
  }
  if (value.status === 'blocked') {
    need(p === null && b === null && exact(value.blocker, ['code']) && BLOCKERS.includes(value.blocker.code));
    return Object.freeze(copy(value));
  }
  need(s !== null && value.blocker === null && exact(b, ['hash', 'latest_context_slot', 'validity_context_slot', 'height_min_context_slot', 'block_height', 'last_valid_block_height', 'remaining_block_heights', 'valid', 'commitment', 'coherent', 'authority_verified'])
    && address(b.hash) && b.valid === true && b.commitment === 'confirmed' && b.coherent === false && b.authority_verified === false);
  need(uint(b.latest_context_slot) >= uint(s.context_slot) && uint(b.validity_context_slot) >= uint(b.latest_context_slot) && b.height_min_context_slot === b.validity_context_slot, 'ConquestBlockhashContext');
  const left = uint(b.last_valid_block_height) - uint(b.block_height);
  need(left >= 2n && uint(b.remaining_block_heights) === left, 'ConquestBlockhashExpired');
  need(exact(p, ['program', 'season', 'program_version', 'action', 'fee_payer', 'dispatch', 'budget', 'roles', 'instruction_hex', 'message_b64', 'message_digest', 'signers', 'shape']));
  const wallet = r.wallet;
  need(p.program === r.program && p.season === r.season && p.program_version === String(LOCAL_PLAY_PROGRAM_VERSION) && p.action === 'DeclareSiege' && request.action === 'DeclareSiege'
    && p.fee_payer === wallet && r.payer === wallet && exact(p.dispatch, ['tag', 'kind']) && p.dispatch.tag === pin.tag && p.dispatch.kind === pin.kind, 'ConquestScopeMismatch');
  const budget = p.budget;
  need(exact(budget, ['cu_limit', 'cu_price', 'loaded_limit', 'heap']) && Number.isInteger(budget.cu_limit) && budget.cu_limit > 0 && budget.cu_limit <= 1_400_000 && budget.cu_price === '0'
    && Number.isInteger(budget.loaded_limit) && budget.loaded_limit > 0 && budget.loaded_limit <= 67_108_864 && budget.heap === pin.heap, 'ConquestBudgetMismatch');
  // the twelve accounts, derived HERE from the request: nothing of them is taken from the report
  const roles = canonicalDeclareSiegeRoles(r, request.target.site);
  need(Array.isArray(p.roles) && p.roles.length === roles.length && p.roles.every((x, i) => exact(x, ['name', 'address', 'signer', 'writable'])
    && x.name === roles[i].name && x.address === roles[i].address && x.signer === roles[i].signer && x.writable === roles[i].writable), 'ConquestRolesMismatch');
  const data = declareSiegeInstruction(request.target.site, request.target.entry);
  need(p.instruction_hex === toHex(data), 'ConquestInstructionMismatch');
  need(typeof p.message_b64 === 'string' && p.message_b64.length <= 1644 && hex64(p.message_digest));
  const bytes = fromBase64(p.message_b64);
  need(toBase64(bytes) === p.message_b64 && toHex(sha256(bytes)) === p.message_digest, 'ConquestMessageDigest');
  const m = parseMessage(bytes), prefix = [[2, budget.cu_limit, 5], [3, 0, 9], [4, budget.loaded_limit, 5], ...(pin.heap === null ? [] : [[1, pin.heap, 5]])];
  need(m.recentBlockhash === b.hash && m.accountKeys[0] === wallet && m.instructions.length === prefix.length + 1, 'ConquestMessageMismatch');
  prefix.forEach(([op, n, len], i) => {
    const ix = m.instructions[i], d = ix.data;
    need(ix.programId === COMPUTE_BUDGET_PROGRAM && ix.keys.length === 0 && d.length === len && d[0] === op && new DataView(d.buffer, d.byteOffset, d.byteLength).getUint32(1, true) === n
      && (op !== 3 || d.slice(5).every(x => x === 0)), 'ConquestBudgetMismatch');
  });
  const union = new Map();
  for (const role of roles) { const old = union.get(role.address); union.set(role.address, { signer: role.signer || !!old?.signer, writable: role.writable || !!old?.writable }); }
  need(!union.has(r.program) && !union.has(COMPUTE_BUDGET_PROGRAM), 'ConquestRolesMismatch');
  const ix = m.instructions[prefix.length];
  need(ix.programId === r.program && toHex(ix.data) === toHex(data) && ix.keys.length === roles.length
    && ix.keys.every((key, i) => key.pubkey === roles[i].address && key.isSigner === union.get(key.pubkey).signer && key.isWritable === union.get(key.pubkey).writable), 'ConquestRolesMismatch');
  need(m.accountKeys.length === union.size + 2 && m.accountKeys.every(key => union.has(key) || key === r.program || key === COMPUTE_BUDGET_PROGRAM), 'ConquestExtraAccount');
  const h = m.header, n = m.accountKeys.length;
  for (let i = 0; i < n; i++) {
    const want = union.get(m.accountKeys[i]) ?? { signer: false, writable: false };
    need((i < h.numRequiredSignatures) === want.signer && (i < h.numRequiredSignatures ? i < h.numRequiredSignatures - h.numReadonlySignedAccounts : i < n - h.numReadonlyUnsignedAccounts) === want.writable, 'ConquestRolesMismatch');
  }
  need(same(p.signers, [wallet]) && same(m.signers, [wallet]), 'ConquestSignerMismatch');
  const shape = { bytes: bytes.length + 1 + 64, locks: n, writes: n - h.numReadonlySignedAccounts - h.numReadonlyUnsignedAccounts, sigs: 1 };
  need(shape.bytes <= 1232 && stable(p.shape) === stable(shape), 'ConquestShapeMismatch');
  return Object.freeze(copy(value));
}

/**
 * The relay's `prepare` answer `{report, submit}` for `request`, believed in nothing. → `{message, digest,
 * lastValidBlockHeight}` (frozen), or throws a code (a blocked report: its blocker's code).
 */
export function localConquestPrepared(value, request) {
  check(object(value) && Object.keys(value).length === 2 && Object.hasOwn(value, 'report') && Object.hasOwn(value, 'submit') && object(value.report), 'BadLocalConquestPrepared');
  const report = conquestPreparationReport(value.report, request);
  // (a blocked report comes with no submit note: its own blocker is what the player is told)
  if (report.status !== 'prepared') { check(value.submit === null, 'BadLocalConquestPrepared'); fail(codeOf(report.blocker, 'LocalConquestBlocked')); }
  const p = report.prepared, s = value.submit, wallet = request.source_request.wallet;
  check(object(s), 'BadLocalConquestPrepared');
  check(Object.keys(s).length === 5 && s.route === 'POST /f/local-play/conquest/submit' && s.schema === LOCAL_CONQUEST_SUBMIT_SCHEMA && s.message_digest === p.message_digest
    && s.last_valid_block_height === report.blockhash.last_valid_block_height && s.signer === wallet, 'LocalConquestSubmitMismatch');
  return Object.freeze({ message: fromBase64(p.message_b64), digest: p.message_digest, lastValidBlockHeight: report.blockhash.last_valid_block_height });
}

/** One bounded POST of JSON to one of the three loopback conquest routes; never a retry, never credentials. A refusal throws its code with `refused`. */
export async function postLocalConquest(origin, path, body, { fetch: fetcher = (...a) => globalThis.fetch(...a), timeoutMs = LOCAL_CONQUEST_TIMEOUT_MS } = {}) {
  check(loopbackRelay(origin, null) === origin && PATHS.includes(path), 'LocalConquestRelay');
  const text = JSON.stringify(body);
  check(text.length <= LOCAL_CONQUEST_MAX_BYTES, 'LocalConquestRequestTooLarge');
  const timer = new AbortController(), t = setTimeout(() => timer.abort(), timeoutMs);
  try {
    const res = await fetcher(`${origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: text, signal: timer.signal, credentials: 'omit', redirect: 'error', cache: 'no-store' });
    const raw = await res.text();
    check(raw.length <= LOCAL_CONQUEST_MAX_BYTES, 'LocalConquestAnswerTooLarge');
    let value; try { value = JSON.parse(raw); } catch { fail('LocalConquestAnswerMalformed'); }
    if (!res.ok) throw Object.assign(new Error('the local-play relay refused'), { code: codeOf(object(value) ? value : null, 'LocalConquestRelayRefused'), refused: true });
    return value;
  } finally { clearTimeout(t); }
}

// ------------------------------------------------------------------ the run (memory only)
const runs = new WeakMap();
const idle = () => Object.freeze({ status: 'idle', busy: false, host: null, digest: null, site: null, entry: null, standing: null, lastValidBlockHeight: null,
  requestId: null, signature: null, code: null, error: null, sent: false, chain: null, slot: null });
const runOf = fs => { let r = runs.get(fs); if (!r) { r = { state: idle(), busy: false, held: null, sent: null, spent: null, owner: null, scope: null }; runs.set(fs, r); } return r; };
const OPEN = ['unknown', 'submitted'];
/** The siege step's state for the card: `{status, busy, host, digest, site, entry, standing, lastValidBlockHeight, requestId, signature, code, error, sent, chain, slot}`. */
export const localConquestOf = fs => runOf(fs).state;
// (one step at a time for the observed host, across the step modules: flocalplay-hoststep.mjs)
registerHostStep('conquest', fs => { const r = runOf(fs); return { busy: r.busy, open: OPEN.includes(r.state.status), prepared: r.held !== null,
  discard() { if (!r.busy && r.held !== null) { r.held = null; r.state = idle(); } } }; });
/**
 * The siege step's state AS IT CONCERNS THE CARD NOW: `{state, foreign}`. A step belongs to the host it was prepared
 * for and to the identity it was prepared under (program, Season, cluster, wallet address; the page's wallet and
 * session objects). On the card of another host, or after any of those changed, its lines are not shown: the state
 * given is idle. `foreign` is true when such a step — not this card's — is still running or its outcome is not
 * settled: the card then says so and offers nothing to prepare (the step itself is asked about on its own card).
 * A press refused before anything was captured (the closed route, the gate) is shown only while the page's identity,
 * wallet, session and observation are the very objects of that press.
 */
export function localConquestShown(fs) {
  const r = runOf(fs), s = r.state;
  if (s.status === 'idle') return { state: s, foreign: false };
  let mine = false;
  try {
    const o = r.owner, i = fs?.localPlay;
    mine = o === null
      ? r.scope !== null && fs?.localPlay === r.scope.identity && fs?.wallet === r.scope.wallet && fs?.session === r.scope.session && fs?.expeditionPreview === r.scope.preview
      : object(i) && i.programId === o.pin.programId && i.seasonAddress === o.pin.seasonAddress && String(i.seasonId) === o.pin.seasonId && i.cluster === o.pin.cluster && i.address === o.pin.address
        && fs.wallet === o.wallet && fs.session === o.session && fs?.expeditionPreview?.request?.host === o.host;
  } catch { mine = false; }
  return mine ? { state: s, foreign: false } : { state: idle(), foreign: r.busy || OPEN.includes(s.status) };
}
/** Whether the read shows `world`'s city to be HELD (by this wallet or by another player): a held city is not besieged. */
const cityHeld = (fs, world) => { const c = localConquestCityFor(fs, world); return c !== null && (c.state === 'owned' || (c.state === 'other' && c.what === 'holding')); };
/** Whether the card's present observation was already used to send a step, this one or another of the same host (it must be read again first). */
export const localConquestSpent = fs => hostObservationSpent(fs, fs?.expeditionPreview?.report);
/** Forget a settled step's lines. One in flight, or whose outcome is not settled, is not forgotten. A used observation stays used. */
export function clearLocalConquest(fs) {
  const r = runOf(fs);
  if (r.busy || OPEN.includes(r.state.status)) return false;
  r.state = idle(); r.held = null; r.sent = null; r.owner = null; r.scope = null;
  return true;
}

const rulesetOf = fs => { const x = fs?.season?.rulesetHash, h = x instanceof Uint8Array && x.length === 32 ? toHex(x) : x; return typeof h === 'string' && /^[0-9a-f]{64}$/.test(h) && h !== '0'.repeat(64) ? h : null; };
/** The identity and the observation a siege is prepared under, taken once. */
function capture(fs, ctx, signer) {
  const i = fs?.localPlay;
  check(object(i) && address(i.programId) && address(i.seasonAddress) && address(i.address) && i.cluster === 'localnet', 'LocalConquestIdentity');
  check(!!signer && signer.destroyed === false && signer.address === i.address, 'LocalConquestSigner');
  const ruleset = rulesetOf(fs);
  check(fs.season?.programVersion === LOCAL_PLAY_PROGRAM_VERSION && ruleset !== null, 'LocalConquestDeployment');
  const state = fs.expeditionPreview;
  check(object(state) && object(state.report) && object(state.request), 'ConquestObservationMissing');
  const selected = inspectionRequest(fs, ctx);
  check(stable(selected) === stable(state.request), 'ConquestSelectionChanged');
  // (the request the card observed is this identity's own: this wallet acts and pays, on this program and Season)
  check(selected.wallet === i.address && selected.payer === i.address && selected.program === i.programId && selected.season === i.seasonAddress && selected.cluster === i.cluster
    && selected.deployment.program_version === String(LOCAL_PLAY_PROGRAM_VERSION) && selected.deployment.ruleset_hash === ruleset, 'LocalConquestIdentity');
  return { pin: Object.freeze({ programId: i.programId, seasonAddress: i.seasonAddress, seasonId: String(i.seasonId), cluster: i.cluster, address: i.address, signer, ruleset }),
    snap: { state, report: state.report, request: state.request, source: ctx.source, relay: ctx.relay, wallet: fs.wallet, session: fs.session }, selected };
}
/** Whether the page is still the one captured: the same identity, signer, card observation, selection, and the same offer under the same world. */
function holds(fs, ctx, signer, { pin, snap }, world, offer) {
  try {
    const i = fs?.localPlay;
    if (!(object(i) && i.programId === pin.programId && i.seasonAddress === pin.seasonAddress && String(i.seasonId) === pin.seasonId && i.cluster === pin.cluster && i.address === pin.address
      && signer === pin.signer && signer.destroyed === false && signer.address === pin.address && fs.season?.programVersion === LOCAL_PLAY_PROGRAM_VERSION && rulesetOf(fs) === pin.ruleset
      && fs.expeditionPreview === snap.state && snap.state.report === snap.report && snap.state.request === snap.request
      && ctx.source === snap.source && ctx.relay === snap.relay && fs.wallet === snap.wallet && fs.session === snap.session
      && stable(inspectionRequest(fs, ctx)) === stable(snap.request))) return false;
    // (the world capability is asked again too: another city, or none, is another siege or no siege)
    return stable(localConquestOffer(fs, ctx, world())) === stable(offer);
  } catch { return false; }
}

/**
 * Press 1: prepare the siege the card's observation and this start's world offer. Nothing is signed or sent.
 * → the state: `prepared` (with the site, the roster entry and the message digest), or `error`. `deps`: `allowed()`,
 * `context()`, `signer()`, `world()` → this start's world capability or null, `post`, `changed()`, `requestId`;
 * `conditions` is for tests only (the module's own are used otherwise, and they are not all established).
 */
export async function prepareLocalConquest(fs, { allowed, context, signer, world = () => null, conditions = LOCAL_CONQUEST_PAGE_CONDITIONS, post = postLocalConquest, changed = () => {}, requestId } = {}) {
  const r = runOf(fs);
  if (r.busy || OPEN.includes(r.state.status)) return r.state;
  r.busy = true; r.held = null;
  // (whose step this is, for `localConquestShown`: until the identity and host are captured, the page as it is at this press)
  r.owner = null; r.scope = { identity: fs?.localPlay ?? null, wallet: fs?.wallet, session: fs?.session, preview: fs?.expeditionPreview ?? null };
  let base = {};
  const put = (status, more = {}) => { base = { ...base, ...more }; r.state = Object.freeze({ ...idle(), ...base, status, busy: r.busy }); try { changed(); } catch { /* the page's repaint is not this run's */ } return r.state; };
  const end = (status, more) => { r.busy = false; return put(status, more); };
  try {
    // CLOSED unless every page condition is established: nothing is read from the relay before this
    check(Object.values(conditions).every(ok => ok === true) && Object.keys(conditions).length > 0, 'ConquestRouteClosed');
    // (no other step of this host in flight or unsettled; another step's merely prepared message is discarded)
    claimHostStep(fs, 'conquest');
    const a = allowed(); if (!a?.ok) fail(a?.code ?? 'LocalConquestNotAllowed');
    const origin = a.relay, ctx = context(), cap = capture(fs, ctx, signer());
    r.owner = { pin: cap.pin, host: cap.selected.host, wallet: fs.wallet, session: fs.session };
    check(!hostObservationSpent(fs, fs.expeditionPreview.report), 'ConquestObservationSpent');
    const offer = localConquestOffer(fs, ctx, world());
    check(offer.ok, offer.code);
    // (a city the reservation read has shown to be HELD is not besieged: nothing is asked of the relay for it)
    check(!cityHeld(fs, world()), 'ConquestCityHeld');
    const request = requestId === undefined ? conquestPreparationRequest(cap.snap.report, cap.selected, offer) : conquestPreparationRequest(cap.snap.report, cap.selected, offer, requestId);
    const still = () => { const g = allowed(); check(g?.ok && g.relay === origin, g?.code ?? 'LocalConquestNotAllowed'); check(holds(fs, context(), signer(), cap, world, offer), 'LocalConquestChanged');
      check(hostStepInFlight(fs, 'conquest') === null, 'HostStepInFlight'); check(!hostObservationSpent(fs, fs.expeditionPreview.report), 'ConquestObservationSpent'); };
    put('preparing', { host: cap.selected.host, requestId: request.request_id, site: offer.site, entry: offer.entry, standing: offer.standing });
    still();
    const prepared = localConquestPrepared(await post(origin, LOCAL_CONQUEST_PREPARE_PATH, request), request);
    still();
    r.held = { cap, origin, request, prepared, world, offer };
    return end('prepared', { digest: prepared.digest, lastValidBlockHeight: prepared.lastValidBlockHeight });
  } catch (e) {
    return end('error', { error: codeOf(e, 'LocalConquestFailed') });
  }
}

/**
 * Press 2, the player's explicit send: only after `prepared`, and only what was prepared. The memory-only wallet signs
 * that very message; the signature is verified here; the gate, the identity, the observation and the offer are asked
 * again after connect, after the signature and in the same turn as the POST; then ONE submit. `deps`: `allowed()`,
 * `context()`, `signer()`, `post`, `changed()`.
 */
export async function sendLocalConquest(fs, { allowed, context, signer, post = postLocalConquest, changed = () => {} } = {}) {
  const r = runOf(fs);
  if (r.busy || OPEN.includes(r.state.status)) return r.state;
  const held = r.held;
  if (r.state.status !== 'prepared' || !held) return r.state;
  r.busy = true; r.sent = null; r.held = null;   // (a prepared message is offered once: whatever happens next, it is not offered again)
  const { cap, origin, prepared, world, offer } = held, wallet = cap.pin.address, w = cap.pin.signer;
  let base = { ...r.state };
  const put = (status, more = {}) => { base = { ...base, ...more }; r.state = Object.freeze({ ...base, status, busy: r.busy }); try { changed(); } catch { /* not this run's */ } return r.state; };
  const end = (status, more) => { r.busy = false; return put(status, more); };
  const still = () => { const g = allowed(); check(g?.ok && g.relay === origin, g?.code ?? 'LocalConquestNotAllowed'); check(holds(fs, context(), signer(), cap, world, offer), 'LocalConquestChanged');
    holdHostStep(fs, 'conquest'); check(!hostObservationSpent(fs, fs.expeditionPreview.report), 'ConquestObservationSpent');
    // (a message prepared BEFORE the read showed the city held is not signed: asked again at every step up to the POST)
    check(!cityHeld(fs, world()), 'ConquestCityHeld'); };
  try {
    still();
    put('signing'); still();
    const account = (await w.wallet.features['standard:connect'].connect()).accounts.find(x => x.address === wallet);
    check(!!account, 'LocalConquestSigner');
    still();
    const [out] = await w.wallet.features['solana:signTransaction'].signTransaction({ account, transaction: wireTransaction(prepared.message, []) });
    still();
    let tx; try { tx = parseTransaction(Uint8Array.from(out?.signedTransaction ?? [])); } catch { fail('LocalConquestSignedMalformed'); }
    check(same([...tx.message], [...prepared.message]) && same(tx.signers, [wallet]) && tx.signatures.length === 1 && tx.signatures[0].some(x => x !== 0), 'LocalConquestSignedOtherMessage');
    let ok = false;
    try { const key = await globalThis.crypto.subtle.importKey('raw', decode(wallet), 'Ed25519', false, ['verify']); ok = await globalThis.crypto.subtle.verify('Ed25519', key, tx.signatures[0], tx.message); } catch { ok = false; }
    check(ok === true, 'LocalConquestSignatureInvalid');
    const signature = encode(tx.signatures[0]), wire = wireTransaction(tx.message, [tx.signatures[0]]);
    put('submitting', { signature });
    // (the repaint above is the page's own code: asked again in this same turn of the loop as the POST)
    still();
    r.sent = Object.freeze({ origin, signature, pin: cap.pin });
    spendHostObservation(fs, cap.snap.report);   // (the observation this siege is sent on is used up for every step, whatever the outcome)
    base = { ...base, sent: true }; r.state = Object.freeze({ ...r.state, sent: true });
    let answer;
    try {
      const v = await post(origin, LOCAL_CONQUEST_SUBMIT_PATH, { schema: LOCAL_CONQUEST_SUBMIT_SCHEMA, message_digest: prepared.digest, transaction_b64: toBase64(wire) });
      check(object(v) && ['submitted', 'unknown'].includes(v.status) && v.signature === signature, 'BadLocalConquestSubmitted');
      answer = v.status;
    } catch (e) {
      // no answer, a refusal or one that cannot be believed: asked about by its signature; never sent again
      return end('unknown', { error: codeOf(e, 'LocalConquestOutcomeUnknown') });
    }
    end(answer);
    // (the first look at the outcome. Whatever goes wrong in it — also a gate or an accessor that throws — the step
    //  stays what the submit made it: `submitted` or `unknown`. It is never turned into a settled `error` here)
    try { return await reconcileLocalConquest(fs, { allowed, post, changed }); }
    catch (e) { r.busy = false; r.state = Object.freeze({ ...r.state, busy: false, error: codeOf(e, 'LocalConquestStatusUnavailable') }); return r.state; }
  } catch (e) {
    // AFTER the POST began (`r.sent` is set and the observation is spent) nothing may leave the step looking settled:
    // an exception from there on is an outcome that is not known. Before it, nothing was sent: `error`.
    if (r.sent !== null && base.sent === true) return end(OPEN.includes(r.state.status) ? r.state.status : 'unknown', { error: codeOf(e, 'LocalConquestOutcomeUnknown') });
    return end('error', { error: codeOf(e, 'LocalConquestFailed') });
  }
}

/**
 * Ask what became of a siege whose outcome is not settled: its FIRST signature goes to the status route, and only
 * there. confirmed | finalized → `confirmed` (the DeclareSiege transaction; nothing about the siege's result);
 * failed → `failed` with the chain's own error; pending | processed, no answer, a refusal (also "not a signature this
 * relay submitted", which proves nothing) → the state stays as it was.
 */
export async function reconcileLocalConquest(fs, { allowed, post = postLocalConquest, changed = () => {} } = {}) {
  const r = runOf(fs);
  if (r.busy || !r.sent || !OPEN.includes(r.state.status)) return r.state;
  const before = r.state;
  r.busy = true;
  const put = (status, more = {}) => { r.state = Object.freeze({ ...before, ...more, status, busy: r.busy }); try { changed(); } catch { /* not this run's */ } return r.state; };
  const end = (status, more) => { r.busy = false; return put(status, more); };
  // (the gate and the identity are the page's own code: if either throws, `busy` is released and the step stays as it
  //  was — unsettled. It must never stay busy for good, and never become a settled state by an exception)
  try {
    const a = allowed();
    if (!a?.ok || a.relay !== r.sent.origin) return end(before.status, { error: a?.code ?? 'LocalConquestRelay' });
    // (the status of a signature is only believed for the identity that sent it)
    const i = fs?.localPlay, p = r.sent.pin;
    if (!object(i) || i.programId !== p.programId || i.seasonAddress !== p.seasonAddress || String(i.seasonId) !== p.seasonId || i.address !== p.address) return end(before.status, { error: 'LocalConquestIdentityChanged' });
  } catch (e) { return end(before.status, { error: codeOf(e, 'LocalConquestGateFailed') }); }
  put(before.status);
  let s;
  try {
    const v = await post(r.sent.origin, LOCAL_CONQUEST_STATUS_PATH, { schema: LOCAL_CONQUEST_STATUS_SCHEMA, signature: r.sent.signature });
    check(object(v) && v.signature === r.sent.signature && ['pending', 'processed', 'confirmed', 'finalized', 'failed', 'expired_unlanded'].includes(v.status), 'BadLocalConquestStatus');
    check((v.status === 'failed') === (v.err !== null && v.err !== undefined), 'BadLocalConquestStatus');
    // "did not land": believed only for THIS step — the relay's last valid height is the one held since prepare, and
    // the slot it read the absence at is a real one past that height. Any other shape is not a settlement.
    if (v.status === 'expired_unlanded') check(typeof before.lastValidBlockHeight === 'string' && v.last_valid_block_height === before.lastValidBlockHeight
      && Number.isSafeInteger(v.context_slot) && BigInt(v.context_slot) > BigInt(before.lastValidBlockHeight), 'BadLocalConquestStatus');
    // (the values are taken HERE, inside the try: nothing of the answer is read after it, so an answer that
    //  throws when read is a status that could not be had — the step stays as it was, and `busy` is released)
    s = { status: v.status, err: v.err ?? null, slot: v.status === 'expired_unlanded' ? v.context_slot : v.slot };
  } catch (e) { return end(before.status, { error: codeOf(e, 'LocalConquestStatusUnavailable') }); }
  const slot = Number.isSafeInteger(s.slot) ? s.slot : null;
  // (terminal: the transaction is not in the chain and can no longer enter it. Nothing was resent; the observation it
  //  was sent on stays used, so a new step needs a new reading)
  if (s.status === 'expired_unlanded') return end('expired', { error: null, code: null, chain: 'expired_unlanded', slot });
  if (s.status === 'failed') { let err = 'Failed'; try { err = (typeof s.err === 'string' ? s.err : JSON.stringify(s.err)).slice(0, 200); } catch { /* kept */ } return end('failed', { code: err, error: null, chain: 'failed', slot }); }
  if (s.status === 'confirmed' || s.status === 'finalized') return end('confirmed', { error: null, code: null, chain: s.status, slot });
  return end(before.status, { error: null, chain: s.status, slot });
}

// ------------------------------------------------------------------ the reservation read (read-only, memory only)
// What became of a reservation is never claimed by the signed step: it is only ever a fact of this read, and this read
// says only what the relay's verified table read bears out — a reservation still waiting, or one that did not take
// effect with what is still owed. A record that is gone says nothing (it applied, or its return completed): no order
// is shown for it, and nothing is inferred. Closed like the signed step: under the module's own conditions nothing is
// asked of the relay. Never polled; one bounded POST per explicit press; nothing stored.
const reads = new WeakMap();
const NO_READ = Object.freeze({ status: 'idle', busy: false, error: null, contextSlot: null, table: null, standing: null, orders: Object.freeze([]), city: null });
/**
 * The reservation read's state for the card: `{status: idle | reading | read | error, busy, error, contextSlot, table,
 * orders: [{seq, model}]}`. A read belongs to the card observation it was made under: after another observation it is
 * no longer shown (idle), so an old answer never stands beside a new reading.
 */
export function localConquestOrdersOf(fs) {
  const r = reads.get(fs);
  if (!r) return NO_READ;
  if (r.busy) return r.state;
  // A finished answer (or error) is shown only while the page is STILL the one it was read for: the same identity
  // (program, Season, cluster, wallet address), the same live memory-only wallet, the same wallet and session
  // objects of the page, and the same card observation. After any of them changes it is not shown again (idle).
  const c = r.cap, i = fs?.localPlay;
  // (a press refused BEFORE anything was captured — the closed route, the gate, a missing observation — has no
  //  identity to compare: its error, and only an error, is shown while the page's own identity, wallet, session and
  //  card observation are the very objects they were at that press. It carries no answer, so nothing old can return)
  if (c === null) { const s = r.scope; return r.state.status === 'error' && s !== null && fs?.localPlay === s.identity && fs?.wallet === s.wallet && fs?.session === s.session && fs?.expeditionPreview === s.preview ? r.state : NO_READ; }
  const still = c !== null && object(i) && i.programId === c.pin.programId && i.seasonAddress === c.pin.seasonAddress && String(i.seasonId) === c.pin.seasonId && i.cluster === c.pin.cluster
    && i.address === c.pin.address && c.pin.signer.destroyed === false && c.pin.signer.address === c.pin.address && fs.wallet === c.snap.wallet && fs.session === c.snap.session
    && fs.expeditionPreview === c.snap.state && c.snap.state.report === c.snap.report && c.snap.state.request === c.snap.request;
  return still ? r.state : NO_READ;
}
/**
 * The read's state AS IT CONCERNS `world`'s Free City, for the card. A finished read is about ONE province (the one
 * the observed host stood in when it was asked). For a city of another province — or no city — it is not evidence of
 * anything: it is given as idle, so the card neither shows its orders nor says "no reservation for this city" on the
 * strength of another province's records. Reading, and errors, are passed through (they claim nothing of any city).
 */
export function localConquestReadFor(fs, world) {
  const s = localConquestOrdersOf(fs), city = world?.free_city;
  if (s.status !== 'read') return s;
  return typeof city?.p === 'string' && typeof city?.q === 'string' && s.standing !== null && s.standing.p === city.p && s.standing.q === city.q ? s : NO_READ;
}
/**
 * The PRESENT state of `world`'s city from the read (fconquest-order.mjs `cityStateModel`): this wallet's siege with
 * its own progress, a capture due, a slot owed, another player's, or a Holding this wallet holds now — or null. Only
 * from a read of the city's own province, and only when the state names the city's own site: a state of another
 * site or province is not this city's. Null is "nothing to show", never "nothing happened".
 */
export function localConquestCityFor(fs, world) {
  const s = localConquestReadFor(fs, world), site = world?.free_city?.site;
  return s.status === 'read' && Number.isInteger(site) && s.city !== null && s.city.site === site ? s.city : null;
}
/**
 * The one order the card shows for `world`'s Free City: the latest (highest seq) of the read's orders on that site,
 * or null — also when nothing was read, the read failed, or no record names that site. Null is "nothing to show",
 * never "no reservation": the card says so in words.
 */
export function localConquestOrderFor(fs, world) {
  const s = localConquestReadFor(fs, world), city = world?.free_city, site = city?.site;
  if (s.status !== 'read' || !Number.isInteger(site)) return null;
  // (the city is a site OF A PROVINCE: an order of the same site number in another province is not this city's)
  const mine = s.orders.filter(o => o.model.site === site && o.model.standing.p === city.p && o.model.standing.q === city.q);
  return mine.length ? mine[mine.length - 1].model : null;
}
/**
 * The player's explicit press: read this wallet's reservations in the province the observed host stands in. Nothing
 * is signed. `deps`: `allowed()`, `context()`, `signer()` (the identity's own wallet must still be the page's: the
 * read is asked for its address only), `post`, `changed()`; `conditions` is for tests only.
 * → the state: `read` (also with no orders), or `error` with a code. An answer that does not echo what was asked, or
 * that says more than a table record can, is an error: nothing of it is shown.
 */
export async function readLocalConquestOrders(fs, { allowed, context, signer, conditions = LOCAL_CONQUEST_PAGE_CONDITIONS, post = postLocalConquest, changed = () => {} } = {}) {
  let r = reads.get(fs); if (!r) { r = { state: NO_READ, busy: false, cap: null, scope: null }; reads.set(fs, r); }
  if (r.busy) return r.state;
  // (an earlier answer is dropped at once: nothing of it stands while or after this read. The page as it is at this
  //  press is remembered by identity only, for showing a refusal that happens before anything is captured)
  r.busy = true; r.cap = null; r.state = NO_READ;
  r.scope = { identity: fs?.localPlay ?? null, wallet: fs?.wallet, session: fs?.session, preview: fs?.expeditionPreview ?? null };
  const put = (status, more = {}) => { r.state = Object.freeze({ ...NO_READ, ...more, status, busy: r.busy }); try { changed(); } catch { /* the page's repaint is not this read's */ } return r.state; };
  const end = (status, more) => { r.busy = false; return put(status, more); };
  try {
    // CLOSED unless every page condition is established: nothing is asked of the relay before this
    check(Object.values(conditions).every(ok => ok === true) && Object.keys(conditions).length > 0, 'ConquestRouteClosed');
    const a = allowed(); if (!a?.ok) fail(a?.code ?? 'LocalConquestNotAllowed');
    const origin = a.relay, cap = capture(fs, context(), signer());
    r.cap = cap;   // (the identity and observation this read belongs to: `localConquestOrdersOf` shows it only under them)
    put('reading');
    const request = { schema: LOCAL_CONQUEST_ORDERS_REQUEST_SCHEMA, source_request: copy(cap.selected) };
    const value = await post(origin, LOCAL_CONQUEST_ORDERS_PATH, request);
    // (asked again after the wait: the same gate and relay, identity, wallet, card observation and selection)
    const g = allowed(), i = fs?.localPlay, w = signer();
    check(g?.ok && g.relay === origin, g?.code ?? 'LocalConquestNotAllowed');
    check(object(i) && i.programId === cap.pin.programId && i.seasonAddress === cap.pin.seasonAddress && String(i.seasonId) === cap.pin.seasonId && i.cluster === cap.pin.cluster
      && i.address === cap.pin.address && w === cap.pin.signer && w.destroyed === false && fs.wallet === cap.snap.wallet && fs.session === cap.snap.session
      && fs.expeditionPreview === cap.snap.state && cap.snap.state.report === cap.snap.report && stable(inspectionRequest(fs, context())) === stable(cap.snap.request), 'LocalConquestChanged');
    const got = siegeOrderRead(value, { program: cap.pin.programId, season: cap.pin.seasonAddress, wallet: cap.pin.address, standing: cap.selected.standing });
    check(got.ok === true, got.code ?? 'SiegeOrderAnswerMalformed');
    // (the province this answer is about: the one asked, echoed by the answer and checked above)
    return end('read', { contextSlot: got.contextSlot, table: got.table, standing: Object.freeze({ p: cap.selected.standing.p, q: cap.selected.standing.q }), orders: got.orders, city: got.city });
  } catch (e) {
    return end('error', { error: codeOf(e, 'LocalConquestOrdersFailed') });
  }
}
