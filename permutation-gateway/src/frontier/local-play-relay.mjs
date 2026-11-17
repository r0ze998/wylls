// LOCAL-PLAY ONLY: the temporary loopback relay of the isolated
// `localnet-expedition-sbf` chain (itest `localnet-expedition-play`). It
// connects the browser's original-host Depart to that chain in two steps and
// holds no key:
//
//   POST /f/local-play/depart/prepare  the existing unsigned Depart preparation
//        (expedition-depart-prepare.mjs: the canonical request, the keyless Rust
//        CLI, the independent report inspection) with the acting wallet as payer;
//        the prepared message is remembered for one submit.
//   POST /f/local-play/depart/submit   the wallet-signed transaction of exactly
//        that message: one Ed25519 signature by the pinned wallet, verified here,
//        then `sendTransaction` to the loopback runner only. One use per message,
//        before its last valid block height.
//   POST /f/local-play/depart/status   the runner's status of a signature this
//        relay submitted.
//   GET  /f/local-play/info            the public pins.
//
// It refuses to exist unless every pin is the local-play one: `localPlay: true`,
// RPC `http://127.0.0.1:PORT` (41000–41999, never 41970), the dedicated program
// [0x45; 32] at version 0x4804 with the S1 ruleset, the program's Season PDA of
// id 11, one public player wallet (that also pays). The general gateway, its
// relay pool, cosigner and public clusters are untouched; none of the
// preparation's closed flags is changed (the report goes out as the CLI wrote and
// the inspector accepted it).
import { createHash, createPublicKey, verify as edVerify } from 'node:crypto';
import { decode, encode } from '../../client/src/base58.mjs';
import { seasonPda } from '../../../permutation-server/web/frontier/faddr.mjs';
import { createExpeditionDepartPrepare, ExpeditionDepartPrepareError, DEPART_PREPARE_PROGRAM_VERSION } from './expedition-depart-prepare.mjs';

export const LOCAL_PLAY_PROGRAM = encode(new Uint8Array(32).fill(0x45));
export const LOCAL_PLAY_SEASON_ID = 11;
export const LOCAL_PLAY_RULESET_HASH = '234c0dc225e5ce323687756b913f78e330757abb969df290745eae1e9aae422d';
export const LOCAL_PLAY_REFUSED_PORT = 41970;
export const LOCAL_PLAY_CLUSTER = 'localnet';
export const SUBMIT_SCHEMA = 'frontier-local-play-depart-submit-v1';
export const STATUS_SCHEMA = 'frontier-local-play-depart-status-v1';
export const ROUTES = Object.freeze({
  info: 'GET /f/local-play/info',
  prepare: 'POST /f/local-play/depart/prepare',
  submit: 'POST /f/local-play/depart/submit',
  status: 'POST /f/local-play/depart/status',
});
const MAX_PENDING = 8;

const ERRORS = Object.freeze({
  LocalPlayInvalidRequest: [400, 'invalid local-play request'],
  LocalPlayScopeMismatch: [409, 'not the local-play wallet, program, Season or ruleset'],
  LocalPlayUnknownMessage: [404, 'no prepared message with this digest'],
  LocalPlayMessageUsed: [409, 'this prepared message was already submitted'],
  LocalPlayMessageExpired: [410, 'the prepared message is past its last valid block height'],
  LocalPlayBadTransaction: [400, 'the transaction is not exactly the prepared message signed once by the wallet'],
  LocalPlayBadSignature: [400, 'the wallet signature does not verify'],
  LocalPlayUnknownSignature: [404, 'not a signature this relay submitted'],
  LocalPlayBusy: [429, 'too many prepared messages are waiting'],
  LocalPlayRpcUnavailable: [503, 'the local-play runner did not answer'],
  LocalPlaySendRefused: [502, 'the local-play runner refused the transaction'],
});
export class LocalPlayError extends Error {
  constructor(code, detail) {
    const known = Object.hasOwn(ERRORS, code) ? code : 'LocalPlayInvalidRequest';
    super(ERRORS[known][1]); this.code = known; this.status = ERRORS[known][0];
    if (detail !== undefined) this.detail = detail;
  }
}
const fail = (code, detail) => { throw new LocalPlayError(code, detail); };
const exact = (v, fields) => v !== null && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).length === fields.length && fields.every(k => Object.hasOwn(v, k));
const address = v => {
  try { const b = decode(v); return typeof v === 'string' && b.length === 32 && b.some(x => x !== 0) && encode(b) === v; }
  catch { return false; }
};
const sha = b => createHash('sha256').update(b).digest('hex');

/** `http://127.0.0.1:PORT` exactly, PORT in 41000–41999 and not 41970; the port or null. */
export function localPlayPort(url) {
  const m = typeof url === 'string' ? /^http:\/\/127\.0\.0\.1:([1-9][0-9]{4})$/.exec(url) : null;
  const port = m ? Number(m[1]) : NaN;
  return port >= 41_000 && port <= 41_999 && port !== LOCAL_PLAY_REFUSED_PORT ? port : null;
}

const CONFIG = ['localPlay', 'rpc', 'program', 'season', 'wallet', 'rulesetHash', 'prepareBin', 'cuLimit', 'loadedLimit'];
/** What is wrong with a local-play relay configuration (empty when it may run). */
// (`testRpcOk`: ONLY for a relay built by a TEST ENTRY on the test port range, through that relay's own `test`
// form. When it is given, the runner's RPC must satisfy IT and the ordinary range is not accepted: a test relay
// never points at a launcher's world, and an ordinary relay never at a test runner. No command line, launcher or
// request passes it.)
export function localPlayRelayConfigProblems(cfg, { testRpcOk = null } = {}) {
  const out = [];
  if (!exact(cfg, CONFIG)) return ['local-play relay configuration must have exactly ' + CONFIG.join(', ')];
  if (cfg.localPlay !== true) out.push('localPlay must be explicitly true');
  if (testRpcOk !== null) { if (typeof testRpcOk !== 'function' || testRpcOk(cfg.rpc) !== true || localPlayPort(cfg.rpc) !== null) out.push('rpc must be the test runner\'s (the test port range only)'); }
  else if (localPlayPort(cfg.rpc) === null) out.push('rpc must be http://127.0.0.1:PORT (41000-41999, never 41970)');
  if (cfg.program !== LOCAL_PLAY_PROGRAM) out.push('program must be the dedicated local-play program [0x45; 32]');
  if (cfg.season !== seasonPda(LOCAL_PLAY_PROGRAM, LOCAL_PLAY_SEASON_ID)[0]) out.push('season must be the program\'s Season PDA of id 11');
  if (!address(cfg.wallet) || cfg.wallet === cfg.program || cfg.wallet === cfg.season) out.push('wallet must be one public player wallet');
  if (cfg.rulesetHash !== LOCAL_PLAY_RULESET_HASH) out.push('rulesetHash must be the S1 ruleset (RULESET_HASH_V3)');
  if (typeof cfg.prepareBin !== 'string' || !cfg.prepareBin.startsWith('/') || cfg.prepareBin.includes('\0')) out.push('prepareBin must be an absolute path');
  return out;
}

/** A Solana compact-u16 at `at`; `[value, next]` (minimal encoding only). */
function shortvec(b, at) {
  let n = 0;
  for (let i = 0; i < 3; i++) {
    if (at + i >= b.length) fail('LocalPlayBadTransaction');
    const x = b[at + i];
    n |= (x & 0x7f) << (7 * i);
    if ((x & 0x80) === 0) {
      if (i > 0 && x === 0) fail('LocalPlayBadTransaction');
      return [n, at + i + 1];
    }
  }
  return fail('LocalPlayBadTransaction');
}

/** `{signature (64), message}` of a wire transaction carrying exactly one signature. */
export function singleSigned(wire) {
  const [n, at] = shortvec(wire, 0);
  if (n !== 1 || wire.length < at + 64 + 3) fail('LocalPlayBadTransaction');
  return { signature: wire.subarray(at, at + 64), message: wire.subarray(at + 64) };
}

const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');
const edKey = raw => createPublicKey({ key: Buffer.concat([SPKI_ED25519, Buffer.from(raw)]), format: 'der', type: 'spki' });

export const RPC_TIMEOUT_MS = 10_000;
export const RPC_MAX_RESPONSE_BYTES = 256 * 1024;
/**
 * A JSON-RPC call to `url` (the relay's only network use): no redirect is
 * followed (a loopback POST is never forwarded elsewhere), a timeout, and a
 * bounded response read.
 */
export async function fetchRpc(url, method, params, { timeoutMs = RPC_TIMEOUT_MS, maxBytes = RPC_MAX_RESPONSE_BYTES } = {}) {
  let res;
  try {
    res = await fetch(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  } catch { fail('LocalPlayRpcUnavailable'); }
  if (res.status !== 200 || Number(res.headers.get('content-length') ?? 0) > maxBytes) { await res.body?.cancel().catch(() => {}); fail('LocalPlayRpcUnavailable'); }
  const chunks = []; let size = 0;
  try {
    for await (const c of res.body) {
      size += c.length;
      if (size > maxBytes) { await res.body.cancel().catch(() => {}); fail('LocalPlayRpcUnavailable'); }
      chunks.push(c);
    }
  } catch (e) { if (e instanceof LocalPlayError) throw e; fail('LocalPlayRpcUnavailable'); }
  let v;
  try { v = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail('LocalPlayRpcUnavailable'); }
  if (v?.error) return { error: v.error };
  return { result: v?.result };
}

/**
 * How long an unsubmitted prepared message stays submittable (wall clock: it
 * only ever closes a ticket, never reopens one), and how many tickets the
 * replay barrier may hold.
 */
export const OPEN_TTL_MS = 120_000;
export const MAX_HISTORY = 256;
/** A JSON-RPC getBlockHeight answer as a non-negative safe integer, or null. */
const heightOf = h => (h && !h.error && Number.isSafeInteger(h.result) && h.result >= 0 ? BigInt(h.result) : null);

/**
 * The relay. `prepare` (optional) replaces the CLI adapter and `rpc` the JSON-RPC
 * client (tests); in service both are built from `cfg`.
 *
 * `flow` (optional; local-play-resident.mjs) serves ANOTHER prepared message kind
 * through this same machinery — its own routes and schemas, and where in its
 * request the pinned scope stands — with its own adapter (`prepare` is then
 * required) and its own replay barrier. Every check below is the same for it:
 * the pinned wallet as acting wallet AND payer, one signer, the exact prepared
 * message, one send, status by signature only. Without `flow` this is the
 * Depart relay exactly as before.
 */
/**
 * `runnerInstance` (optional, 64 lowercase hex): the instance id of the ONE runner this relay serves, as the launcher
 * was told it by that runner's own metadata line. It is what lets `status` settle a sent transaction as "did not
 * land": only an answer that carries this very id in the SAME status response is about the chain the transaction was
 * sent to. Without it (today: no runner states one) nothing is ever settled that way — a not-found stays `pending`.
 */
export function createLocalPlayRelay({ cfg, prepare = null, rpc = (m, p) => fetchRpc(cfg.rpc, m, p), now = () => Date.now(), flow = null, runnerInstance = null }) {
  if (runnerInstance !== null && (typeof runnerInstance !== 'string' || !/^[0-9a-f]{64}$/.test(runnerInstance) || /^0{64}$/.test(runnerInstance))) throw new Error('local-play relay refused: bad runner instance');
  if (flow !== null && (!prepare || !exact(flow, ['routes', 'submitSchema', 'statusSchema', 'scopeOf']) || typeof flow.scopeOf !== 'function'
      || !exact(flow.routes, ['prepare', 'submit', 'status']) || [flow.submitSchema, flow.statusSchema].some(s => typeof s !== 'string' || s === SUBMIT_SCHEMA || s === STATUS_SCHEMA)
      || Object.values(flow.routes).some(r => typeof r !== 'string' || Object.values(ROUTES).includes(r)))) throw new Error('local-play relay refused: bad flow');
  const routes = flow ? flow.routes : ROUTES, submitSchema = flow ? flow.submitSchema : SUBMIT_SCHEMA, statusSchema = flow ? flow.statusSchema : STATUS_SCHEMA;
  const scopeOf = flow ? flow.scopeOf : body => body;
  const problems = localPlayRelayConfigProblems(cfg);
  if (problems.length) throw new Error('local-play relay refused: ' + problems.join('; '));
  const adapter = prepare ?? createExpeditionDepartPrepare({
    cfg: { cluster: LOCAL_PLAY_CLUSTER, programId: cfg.program, expeditionDepartPrepareBin: cfg.prepareBin, expeditionDepartPrepareRpc: cfg.rpc,
      expeditionDepartPrepareFeePayer: cfg.wallet, expeditionDepartPrepareRulesetHash: cfg.rulesetHash,
      expeditionDepartPrepareCuLimit: cfg.cuLimit, expeditionDepartPrepareLoadedLimit: cfg.loadedLimit },
    season: cfg.season,
  });
  const walletKey = edKey(decode(cfg.wallet));
  /**
   * The replay barrier: message_digest → {message, lastValid, state:
   * open|reserved|used|expired, at, signature?}. A digest stays here — refused for
   * re-preparation and re-submission, its signature answerable by `status` —
   * until the runner's ACTUAL block height is past its last valid block height
   * (`retire`); time alone never removes it. When it holds MAX_HISTORY tickets
   * that cannot yet be retired, new preparations are refused (fail-closed).
   */
  const pending = new Map();
  let preparing = 0; // preparations between their reservation and their insertion
  const expireOpen = () => {
    const t = now();
    for (const e of pending.values()) if (e.state === 'open' && t - e.at > OPEN_TTL_MS) e.state = 'expired';
  };
  /**
   * Drop tickets that were NEVER SUBMITTED (`expired`: no signature, nothing sent) once the chain has really passed
   * their last valid height. A ticket that was sent — `used`, or settled `expired_unlanded` — is never dropped: it
   * is the record that bars its bytes for good and that `status` answers from. Those stay for the relay's lifetime
   * (one world), bounded by MAX_HISTORY: when the barrier is full of them, new preparations are refused (fail-closed).
   */
  const retire = async () => {
    if (![...pending.values()].some(e => e.state === 'expired')) return;
    let h;
    try { h = heightOf(await rpc('getBlockHeight', [{ commitment: 'confirmed' }])); } catch { return; }
    if (h === null) return;
    for (const [d, e] of pending) if (e.state === 'expired' && h > e.lastValid) pending.delete(d);
  };
  const openCount = () => [...pending.values()].filter(e => e.state === 'open').length;
  const info = Object.freeze({ localPlay: true, cluster: LOCAL_PLAY_CLUSTER, program: cfg.program, season: cfg.season,
    programVersion: DEPART_PREPARE_PROGRAM_VERSION, rulesetHash: cfg.rulesetHash, wallet: cfg.wallet, routes: ROUTES,
    keys: 'none: the browser signs; this relay verifies and forwards to the loopback runner only' });

  return Object.freeze({
    info: () => info,

    /** The existing Depart preparation, pinned to the local-play wallet as acting wallet AND payer. */
    async prepare(body, { signal } = {}) {
      if (!body || typeof body !== 'object' || Array.isArray(body)) fail('LocalPlayInvalidRequest');
      const scope = scopeOf(body);
      if (!scope || typeof scope !== 'object' || Array.isArray(scope)) fail('LocalPlayInvalidRequest');
      if (scope.cluster !== LOCAL_PLAY_CLUSTER || scope.program !== cfg.program || scope.season !== cfg.season
          || scope.wallet !== cfg.wallet || scope.payer !== cfg.wallet
          || scope.deployment?.program_version !== DEPART_PREPARE_PROGRAM_VERSION || scope.deployment?.ruleset_hash !== cfg.rulesetHash) fail('LocalPlayScopeMismatch');
      expireOpen();
      if (pending.size + preparing >= MAX_HISTORY) await retire();
      // Reserve a slot synchronously (open tickets and barrier capacity) before
      // the adapter's await; release it whatever happens.
      if (openCount() + preparing >= MAX_PENDING || pending.size + preparing >= MAX_HISTORY) fail('LocalPlayBusy');
      preparing++;
      let report;
      try {
        report = await adapter.prepare(body, { signal });
      } finally {
        preparing--;
      }
      if (report.status !== 'prepared') return { report, submit: null };
      const p = report.prepared;
      if (p.fee_payer !== cfg.wallet || p.signers.length !== 1 || p.signers[0] !== cfg.wallet) fail('LocalPlayScopeMismatch');
      // Invariant: a digest, once known, is never reopened or reset. The same
      // message prepared again keeps its first ticket (open, reserved or used).
      const known = pending.get(p.message_digest);
      if (known && known.state !== 'open') fail('LocalPlayMessageUsed');
      if (!known) {
        expireOpen();
        if (openCount() >= MAX_PENDING || pending.size >= MAX_HISTORY) fail('LocalPlayBusy');
        pending.set(p.message_digest, { message: Buffer.from(p.message_b64, 'base64'), lastValid: BigInt(report.blockhash.last_valid_block_height), state: 'open', at: now() });
      }
      return { report, submit: { route: routes.submit, schema: submitSchema, message_digest: p.message_digest,
        last_valid_block_height: report.blockhash.last_valid_block_height, signer: cfg.wallet } };
    },

    /** Exactly the prepared message, signed once by the wallet, sent once to the loopback runner. */
    async submit(body) {
      if (!exact(body, ['schema', 'message_digest', 'transaction_b64']) || body.schema !== submitSchema
          || typeof body.message_digest !== 'string' || !/^[0-9a-f]{64}$/.test(body.message_digest)
          || typeof body.transaction_b64 !== 'string' || body.transaction_b64.length > 1700) fail('LocalPlayInvalidRequest');
      expireOpen();
      const entry = pending.get(body.message_digest);
      if (!entry) fail('LocalPlayUnknownMessage');
      // Everything up to the reservation is synchronous: no await can interleave
      // a second submit between the check and the reservation.
      if (entry.state === 'expired') fail('LocalPlayMessageExpired');
      if (entry.state !== 'open') fail('LocalPlayMessageUsed');
      const wire = Buffer.from(body.transaction_b64, 'base64');
      if (wire.toString('base64') !== body.transaction_b64 || wire.length > 1232) fail('LocalPlayBadTransaction');
      const { signature, message } = singleSigned(wire);
      if (sha(message) !== body.message_digest || !Buffer.from(message).equals(entry.message)) fail('LocalPlayBadTransaction');
      if (!edVerify(null, message, walletKey, signature)) fail('LocalPlayBadSignature');
      entry.state = 'reserved';
      // Before anything is sent: the reservation is given back on any failure
      // to read a valid height (nothing has been sent), consumed on expiry.
      let height = null;
      try { height = heightOf(await rpc('getBlockHeight', [{ commitment: 'confirmed' }])); } catch { height = null; }
      if (height === null) { entry.state = 'open'; fail('LocalPlayRpcUnavailable'); }
      if (height > entry.lastValid) { entry.state = 'expired'; fail('LocalPlayMessageExpired'); }
      // From here the message is consumed, whatever happens: one send at most.
      // The signature is known from the wire, so it is recorded before sending
      // and `status` can look it up for as long as the ticket is in the barrier.
      const sig = encode(signature);
      // (the height just read is the slot this message is sent at: kept for `status`, which never settles an absence
      //  read at a lower slot — a chain that went backwards is another chain)
      entry.state = 'used'; entry.signature = sig; entry.sentSlot = height;
      let sent;
      try {
        sent = await rpc('sendTransaction', [body.transaction_b64, { encoding: 'base64', preflightCommitment: 'confirmed' }]);
      } catch {
        // timeout / network error after the send began: the outcome is unknown
        return { status: 'unknown', signature: sig, status_route: routes.status };
      }
      if (sent?.error) fail('LocalPlaySendRefused', { code: sent.error.code, message: String(sent.error.message ?? '').slice(0, 300), signature: sig });
      if (sent?.result !== sig) return { status: 'unknown', signature: sig, status_route: routes.status };
      return { status: 'submitted', signature: sig, status_route: routes.status };
    },

    /** The runner's status of a signature this relay submitted (still in the barrier). */
    async status(body) {
      if (!exact(body, ['schema', 'signature']) || body.schema !== statusSchema || typeof body.signature !== 'string') fail('LocalPlayInvalidRequest');
      const entry = [...pending.values()].find(e => e.signature === body.signature);
      if (!entry) fail('LocalPlayUnknownSignature');
      // (a ticket already settled as "did not land" answers from its own record: nothing is asked again)
      if (entry.state === 'expired_unlanded') return { signature: body.signature, status: 'expired_unlanded', context_slot: entry.settledSlot, last_valid_block_height: String(entry.lastValid) };
      let r; try { r = await rpc('getSignatureStatuses', [[body.signature], { searchTransactionHistory: true }]); } catch { fail('LocalPlayRpcUnavailable'); }
      if (!r || r.error) fail('LocalPlayRpcUnavailable');
      // STRICT: the well-formed answer only — a context slot, and exactly one entry for the one signature asked. A
      // missing or malformed answer is "the runner did not answer", never "not found".
      const ctx = r.result?.context, value = r.result?.value, slot = ctx?.slot;
      if (!Number.isSafeInteger(slot) || slot < 0 || !Array.isArray(value) || value.length !== 1) fail('LocalPlayRpcUnavailable');
      // With a pinned runner, ANY status must come from that very instance, stated in this same response: another id,
      // or none, is not the chain this relay sent to.
      if (runnerInstance !== null && ctx.instance !== runnerInstance) fail('LocalPlayRpcUnavailable');
      const s = value[0];
      if (s === null) {
        // Not found, at this slot. It settles as "did not land" only when the runner is the pinned one (checked above,
        // in this response), the ticket was sent by this relay, and the slot is past the message's last valid height
        // and not below the slot it was sent at. Otherwise it is still pending. Nothing is ever resent.
        const settled = runnerInstance !== null && entry.state === 'used' && typeof entry.sentSlot === 'bigint' && BigInt(slot) > entry.lastValid && BigInt(slot) >= entry.sentSlot;
        if (settled) { entry.state = 'expired_unlanded'; entry.settledSlot = slot; }
        return { signature: body.signature, status: settled ? 'expired_unlanded' : 'pending', context_slot: slot, last_valid_block_height: String(entry.lastValid) };
      }
      // FOUND — and nothing is filled in for it: the entry must itself carry `err` (null, or the chain's error), a slot
      // that is a real one not after the context it was read at, and one of the three confirmation levels. An object
      // lacking any of these (e.g. only `{confirmationStatus: "confirmed"}`) is a malformed answer, not a success.
      if (typeof s !== 'object' || Array.isArray(s) || !Object.hasOwn(s, 'err') || !Object.hasOwn(s, 'slot') || !Object.hasOwn(s, 'confirmationStatus')
          || !Number.isSafeInteger(s.slot) || s.slot < 0 || s.slot > slot || !['processed', 'confirmed', 'finalized'].includes(s.confirmationStatus)
          || !(s.err === null || typeof s.err === 'string' || (typeof s.err === 'object' && !Array.isArray(s.err)))) fail('LocalPlayRpcUnavailable');
      return { signature: body.signature, status: s.err !== null ? 'failed' : s.confirmationStatus, err: s.err, slot: s.slot, context_slot: slot };
    },

    /** Counts only (tests, shutdown): no digest, message or signature. */
    stats() { expireOpen(); return { pending: pending.size, open: openCount(), preparing }; },

    close() { adapter?.close?.(); },
  });
}

/** The HTTP answer of a thrown error (no stack, no secret). */
export function errorAnswer(e) {
  if (e instanceof LocalPlayError) return { status: e.status, body: { error: e.message, code: e.code, ...(e.detail ? { detail: e.detail } : {}) } };
  if (e instanceof ExpeditionDepartPrepareError) return { status: e.status, body: { error: e.message, code: e.code } };
  return { status: 500, body: { error: 'local-play relay error', code: 'LocalPlayUnavailable' } };
}
