// Opt-in, UNSIGNED original-host Depart preparation through the keyless Rust CLI
// (frontier-node keeper `experimental_expedition_depart_prepare`, binary
// frontier-experimental-expedition-depart-prepare). Independent of the resident
// Return/Dissolve adapter (expedition-prepare.mjs): its own route, config keys,
// slots and limits. No relay pool, wallet, key store, cosigner, seal, commit,
// simulation or send path is used or reachable from here: the commit and seal of
// a request are opaque bytes that are already public, carried and never made,
// opened or checked (`seal_verified` is always false).
import { spawn as nodeSpawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { decode, encode } from '../../client/src/base58.mjs';
import { parseMessage, COMPUTE_BUDGET_PROGRAM } from '../../client/src/solana-tx.mjs';
import { canonicalOutboundRoles } from '../../../permutation-server/web/frontier/fexpedition-depart.mjs';
import { withSeed, seedOf } from '../../../permutation-server/web/frontier/faddr.mjs';
import { expeditionRpcUrlAllowed } from './expedition-preview.mjs';

export const DEPART_PREPARE_REQUEST_SCHEMA = 'frontier-experimental-expedition-depart-prepare-request-v1';
export const DEPART_PREPARE_REPORT_SCHEMA = 'frontier-experimental-expedition-depart-prepare-report-v1';
export const EXPEDITION_DEPART_PREPARE_ROUTE = 'POST /f/expedition/depart/prepare';
export const DEPART_PREPARE_MAX_REQUEST_BYTES = 16 * 1024;
export const DEPART_PREPARE_MAX_OUTPUT_BYTES = 64 * 1024;
export const DEPART_PREPARE_TIMEOUT_MS = 30_000;
export const DEPART_PREPARE_MAX_CONCURRENT = 2;
/** expedition_dispatch_ix::PROGRAM_VERSION: S1 (4) | wide 0x4000 | host-only dispatch 0x0800. */
export const DEPART_PREPARE_PROGRAM_VERSION = '18436';
/** experimental_expedition_depart_prepare::DIGEST_DOMAIN. */
export const DEPART_DIGEST_DOMAIN = 'PSF-ORIGINAL-DEPART-DRAFT-v1';
/** world_index::seal::WIDE_SEAL_LEN. */
export const DEPART_SEAL_BYTES = 264;
/** fclient DEPART_HEAP_FRAME: the one fixed heap frame of a Depart (256 KiB). Measured on the real SBF program, which
 * does not complete a Depart in the default 32 KiB heap. Not a setting: exactly this value, in exactly one place. */
export const DEPART_HEAP_FRAME = 256 * 1024;
/** wide_ix::ExpeditionDepart::LEN: a 4-byte head, then host 56, slot 1, arrive bell 4, tip 8, commit 32, seal 264. */
export const DEPART_INNER_BYTES = 369;
/** The inner command's head: TAG_DEPART, ENVELOPE_ESCAPE, ENVELOPE_VERSION, the ExpeditionDepart op. */
export const DEPART_INNER_HEAD = Object.freeze([0xda, 0xff, 1, 6]);
/** expedition_dispatch_ix::encode(Kind::Depart, …): TAG_DEPART, ENVELOPE_ESCAPE, VERSION 2, Kind::Depart 0. */
export const DEPART_OUTER_HEAD = Object.freeze([0xda, 0xff, 2, 0]);
/** fclient original_expedition_depart_draft::NOT_PROVEN, as every report carries it. */
export const DEPART_NOT_PROVEN = Object.freeze([
  'canonical deployed program, Season account and account ownership',
  'wallet signatures, authorization, Citizen ownership and host issuance',
  'current residency, capture/transit locks and free embedded transit slot',
  'arrival timing, land availability, economics, Resolve and readiness',
  'commit/seal binding to plaintext, ciphertext validity or decryptability',
  'public dispatch or executable instruction admission',
]);
/** Every flag a report carries closed. None of them is ever true here, prepared or not. */
export const DEPART_CLOSED = Object.freeze(['ready', 'deployment_verified', 'admitted', 'signed', 'enqueued', 'relay_submission_available', 'automatic_send', 'seal_verified']);

const ERRORS = Object.freeze({
  ExpeditionDepartPrepareDisabled: [503, 'unsigned departure preparation is not configured'],
  ExpeditionDepartPrepareInvalidRequest: [400, 'invalid unsigned departure preparation request'],
  ExpeditionDepartPrepareScopeMismatch: [409, 'preparation does not match the configured target'],
  ExpeditionDepartPrepareBusy: [429, 'unsigned departure preparation is busy'],
  ExpeditionDepartPrepareTimeout: [504, 'unsigned departure preparation timed out'],
  ExpeditionDepartPrepareAborted: [499, 'unsigned departure preparation was cancelled'],
  ExpeditionDepartPrepareUnavailable: [503, 'unsigned departure preparation is unavailable'],
  ExpeditionDepartPrepareInvalidReport: [502, 'unsigned departure preparation returned an invalid report'],
  ExpeditionDepartPrepareOutputTooLarge: [502, 'unsigned departure preparation exceeded its output limit'],
});
export class ExpeditionDepartPrepareError extends Error {
  constructor(code) {
    const known = Object.hasOwn(ERRORS, code) ? code : 'ExpeditionDepartPrepareUnavailable';
    super(ERRORS[known][1]); this.code = known; this.status = ERRORS[known][0];
  }
}
const fail = code => { throw new ExpeditionDepartPrepareError(code); };
const exact = (v, fields) => !!v && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).length === fields.length && fields.every(k => Object.hasOwn(v, k));
const hex = (v, bytes) => typeof v === 'string' && v.length === 2 * bytes && /^[0-9a-f]*$/.test(v);
/** Canonical unsigned decimal (no sign, no leading zero, at most 20 digits) not above `max`. */
const uint = (v, max = 0xffffffffffffffffn) => typeof v === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(v) && BigInt(v) <= max;
/** Canonical signed decimal of an i64 (`-0` refused). */
const int64 = v => typeof v === 'string' && /^(0|-?[1-9][0-9]{0,19})$/.test(v) && BigInt(v) >= -(1n << 63n) && BigInt(v) < (1n << 63n);
const eq = (a, b) => a === b || (!!a && !!b && typeof a === 'object' && typeof b === 'object'
  && Array.isArray(a) === Array.isArray(b) && Object.keys(a).length === Object.keys(b).length
  && Object.keys(a).every(k => Object.hasOwn(b, k) && eq(a[k], b[k])));
const address = v => {
  try { const b = decode(v); return typeof v === 'string' && v.length <= 44 && b.length === 32 && b.some(x => x !== 0) && encode(b) === v; }
  catch { return false; }
};
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const le32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const copy = v => JSON.parse(JSON.stringify(v));
function freeze(v) { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); } return v; }

const SCOPE = ['schema', 'request_id', 'cluster', 'program', 'season', 'deployment', 'wallet', 'payer', 'host', 'standing',
  'transit_slot', 'arrive_bell', 'tip', 'public_commit', 'public_seal', 'min_slot'];
const FIELDS = [...SCOPE, 'proposal'];
const ROLE = ['name', 'address', 'signer', 'writable'];

/**
 * The canonical proposal of a departure, rebuilt from its public facts alone: the nine ordered roles
 * (web/frontier/fexpedition-depart.mjs canonicalOutboundRoles, which mirrors fclient's Draft::for_wallet), the 369
 * inner bytes of wide_ix::ExpeditionDepart and the keeper's content digest over program, Season, bytes and roles.
 * `scope` holds the request's fields other than `proposal`, already checked for shape. Throws when no canonical
 * draft exists for these facts.
 */
export function canonicalDepartProposal(scope) {
  const citizen = withSeed(scope.season, seedOf('Citizen', { wallet: scope.wallet }), scope.program);
  const frozen = canonicalOutboundRoles({ program: scope.program, season: scope.season, wallet: scope.wallet, payer: scope.payer,
    original_owner: citizen, host: scope.host, origin: { p: scope.standing.p, q: scope.standing.q } }, { transitSlot: Number(scope.transit_slot) });
  const roles = frozen.map(r => ({ name: r.name, address: r.address, signer: r.signer, writable: r.writable }));
  const tail = Buffer.alloc(1 + 4 + 8);
  tail[0] = Number(scope.transit_slot); tail.writeUInt32LE(Number(scope.arrive_bell), 1); tail.writeBigUInt64LE(BigInt(scope.tip), 5);
  const bytes = Buffer.concat([Buffer.from(DEPART_INNER_HEAD), Buffer.from(scope.host, 'hex'), tail,
    Buffer.from(scope.public_commit, 'hex'), Buffer.from(scope.public_seal, 'hex')]);
  if (bytes.length !== DEPART_INNER_BYTES || roles.length !== 9) throw new Error('DepartDraftContract');
  const h = createHash('sha256').update(DEPART_DIGEST_DOMAIN).update(decode(scope.program)).update(decode(scope.season))
    .update(le32(bytes.length)).update(bytes).update(le32(roles.length));
  for (const role of roles) {
    const name = Buffer.from(role.name);
    h.update(le32(name.length)).update(name).update(decode(role.address)).update(Buffer.from([+role.signer, +role.writable]));
  }
  return { bytes_hex: bytes.toString('hex'), content_digest: h.digest('hex'), roles };
}

/**
 * A request as the CLI will accept it (parse_request), checked here first and rebuilt: nothing the caller sent
 * about roles, inner bytes or digest is passed on, only the canonical ones it had to match.
 */
export function expeditionDepartPrepareRequest(value) {
  const bad = () => fail('ExpeditionDepartPrepareInvalidRequest');
  if (!exact(value, FIELDS) || value.schema !== DEPART_PREPARE_REQUEST_SCHEMA
      || typeof value.request_id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value.request_id)
      || typeof value.cluster !== 'string' || !/^[a-z0-9-]{1,32}$/.test(value.cluster)
      || !exact(value.deployment, ['program_version', 'ruleset_hash']) || !uint(value.deployment.program_version, 0xffffn) || !hex(value.deployment.ruleset_hash, 32)
      || !['program', 'season', 'wallet', 'payer'].every(k => address(value[k])) || value.program === value.season
      || !exact(value.standing, ['p', 'q']) || !int64(value.standing.p) || !int64(value.standing.q)
      || !hex(value.host, 56) || !uint(value.transit_slot, 0xffn) || !uint(value.arrive_bell, 0xffffffffn) || !uint(value.tip)
      || !hex(value.public_commit, 32) || !hex(value.public_seal, DEPART_SEAL_BYTES) || !uint(value.min_slot)
      || !exact(value.proposal, ['bytes_hex', 'content_digest', 'roles']) || typeof value.proposal.bytes_hex !== 'string'
      || typeof value.proposal.content_digest !== 'string' || !Array.isArray(value.proposal.roles) || value.proposal.roles.length !== 9) bad();
  // (the CLI's own refusals after the shape: VersionUnsupported, TransitSlotInvalid, SealAbsent, SealSyntax)
  const first = Number.parseInt(value.public_seal.slice(0, 2), 16);
  if (value.deployment.program_version !== DEPART_PREPARE_PROGRAM_VERSION || Number(value.transit_slot) >= 4
      || /^0*$/.test(value.public_commit) || /^0*$/.test(value.public_seal) || (first & 0x80) === 0 || (first & 0x40) !== 0) bad();
  const scope = { schema: DEPART_PREPARE_REQUEST_SCHEMA, request_id: value.request_id, cluster: value.cluster, program: value.program, season: value.season,
    deployment: { program_version: value.deployment.program_version, ruleset_hash: value.deployment.ruleset_hash },
    wallet: value.wallet, payer: value.payer, host: value.host, standing: { p: value.standing.p, q: value.standing.q },
    transit_slot: value.transit_slot, arrive_bell: value.arrive_bell, tip: value.tip,
    public_commit: value.public_commit, public_seal: value.public_seal, min_slot: value.min_slot };
  let canonical;
  try { canonical = canonicalDepartProposal(scope); } catch { bad(); }
  if (value.proposal.bytes_hex !== canonical.bytes_hex || value.proposal.content_digest !== canonical.content_digest
      || value.proposal.roles.some((r, i) => !exact(r, ROLE) || ROLE.some(k => r[k] !== canonical.roles[i][k]))) bad();
  const request = { ...scope, proposal: canonical };
  if (Buffer.byteLength(JSON.stringify(request)) > DEPART_PREPARE_MAX_REQUEST_BYTES) bad();
  return freeze(request);
}

const CONFIG = ['expeditionDepartPrepareBin', 'expeditionDepartPrepareRpc', 'expeditionDepartPrepareFeePayer', 'expeditionDepartPrepareRulesetHash', 'expeditionDepartPrepareCuLimit', 'expeditionDepartPrepareLoadedLimit'];
const unset = cfg => CONFIG.every(k => cfg[k] === null || cfg[k] === undefined);
const positive = (v, max) => (typeof v === 'number' || typeof v === 'string') && /^(0|[1-9][0-9]*)$/.test(String(v)) && Number.isSafeInteger(Number(v)) && Number(v) > 0 && Number(v) <= max;
/** What is wrong with the departure preparation's own configuration; none when it is not configured at all. */
export function expeditionDepartPrepareConfigProblems(cfg) {
  if (unset(cfg)) return [];
  const out = [];
  if (typeof cfg.expeditionDepartPrepareBin !== 'string' || cfg.expeditionDepartPrepareBin.length > 4096 || cfg.expeditionDepartPrepareBin.includes('\0') || !path.isAbsolute(cfg.expeditionDepartPrepareBin)) out.push('expedition depart prepare requires an absolute executable path');
  if (!expeditionRpcUrlAllowed(cfg.expeditionDepartPrepareRpc)) out.push('expedition depart prepare requires an explicit loopback HTTP RPC URL');
  if (!address(cfg.expeditionDepartPrepareFeePayer)) out.push('expedition depart prepare requires a public fee payer');
  if (!hex(cfg.expeditionDepartPrepareRulesetHash, 32)) out.push('expedition depart prepare requires a lowercase ruleset hash');
  if (!positive(cfg.expeditionDepartPrepareCuLimit, 1_400_000) || !positive(cfg.expeditionDepartPrepareLoadedLimit, 64 * 1024 * 1024)) out.push('expedition depart prepare requires explicit bounded CU and loaded-data limits');
  if (!address(cfg.programId) || typeof cfg.cluster !== 'string' || !/^[a-z0-9-]{1,32}$/.test(cfg.cluster)) out.push('expedition depart prepare requires a canonical target');
  return out;
}

function budgetData(tag, value, size) { const b = Buffer.alloc(size + 1); b[0] = tag; size === 8 ? b.writeBigUInt64LE(BigInt(value), 1) : b.writeUInt32LE(value, 1); return b; }
const BLOCKER = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
const BLOCKHASH = ['hash', 'latest_context_slot', 'validity_context_slot', 'height_min_context_slot', 'block_height', 'last_valid_block_height', 'remaining_block_heights', 'valid', 'commitment', 'coherent', 'authority_verified'];

/**
 * The CLI's report, inspected independently: nothing it claims is believed. The unsigned message is parsed and
 * every instruction, budget, account privilege, the fee payer, the blockhash and each digest is compared with what
 * this module derives from the request and the configured pins. A report with any closed flag open is refused.
 * `pins`: `{fee_payer, cu_limit, loaded_limit}` of the configuration.
 */
export function expeditionDepartPrepareReport(v, request, pins) {
  const check = yes => { if (!yes) fail('ExpeditionDepartPrepareInvalidReport'); };
  check(exact(v, ['schema', 'status', 'request', 'source', 'blockhash', 'prepared', 'blocker', 'not_proven', 'host_only', ...DEPART_CLOSED])
    && v.schema === DEPART_PREPARE_REPORT_SCHEMA && ['prepared', 'blocked'].includes(v.status) && v.host_only === true
    && DEPART_CLOSED.every(k => v[k] === false)
    && Array.isArray(v.not_proven) && v.not_proven.length === DEPART_NOT_PROVEN.length && v.not_proven.every((x, i) => x === DEPART_NOT_PROVEN[i]));
  // (a refusal before the request was understood echoes none; any echo must be this request)
  if (v.request !== null || v.status === 'prepared') {
    let echoed; try { echoed = expeditionDepartPrepareRequest(v.request); } catch { check(false); }
    check(eq(echoed, request));
  }
  if (v.status === 'blocked') {
    check(v.source === null && v.blockhash === null && v.prepared === null && exact(v.blocker, ['code'])
      && typeof v.blocker.code === 'string' && BLOCKER.test(v.blocker.code));
    return freeze(copy(v));
  }
  check(v.blocker === null);
  const s = v.source;
  check(exact(s, ['context_slot', 'unix_timestamp', 'current_bell', 'arrive_bell', 'transit_slot_free', 'coherent', 'authority_verified'])
    && uint(s.context_slot) && BigInt(s.context_slot) >= BigInt(request.min_slot) && int64(s.unix_timestamp)
    && uint(s.current_bell, 0xffffffffn) && s.arrive_bell === request.arrive_bell
    && BigInt(s.arrive_bell) >= BigInt(s.current_bell) + 2n && BigInt(s.arrive_bell) <= BigInt(s.current_bell) + 72n
    && s.transit_slot_free === true && s.coherent === true && s.authority_verified === false);
  const b = v.blockhash;
  check(exact(b, BLOCKHASH) && address(b.hash)
    && ['latest_context_slot', 'validity_context_slot', 'height_min_context_slot', 'block_height', 'last_valid_block_height', 'remaining_block_heights'].every(k => uint(b[k]))
    && b.valid === true && b.commitment === 'confirmed' && b.coherent === false && b.authority_verified === false
    && BigInt(b.latest_context_slot) >= BigInt(s.context_slot) && BigInt(b.validity_context_slot) >= BigInt(b.latest_context_slot)
    && b.height_min_context_slot === b.validity_context_slot && BigInt(b.remaining_block_heights) >= 2n
    && BigInt(b.last_valid_block_height) - BigInt(b.block_height) === BigInt(b.remaining_block_heights));
  const p = v.prepared, roles = request.proposal.roles;
  check(exact(p, ['program', 'season', 'program_version', 'action', 'fee_payer', 'budget', 'roles', 'instruction_hex', 'message_b64', 'message_digest', 'signers', 'shape', 'proposal_digest'])
    && p.program === request.program && p.season === request.season && p.program_version === DEPART_PREPARE_PROGRAM_VERSION && p.action === 'Depart'
    && p.fee_payer === pins.fee_payer && p.fee_payer === request.payer && p.proposal_digest === request.proposal.content_digest
    && exact(p.budget, ['cu_limit', 'cu_price', 'loaded_limit', 'heap']) && p.budget.cu_limit === pins.cu_limit
    && p.budget.loaded_limit === pins.loaded_limit && p.budget.cu_price === '0' && p.budget.heap === DEPART_HEAP_FRAME
    && eq(p.roles, roles));
  // The game instruction: the dispatch head, then exactly the canonical inner bytes of this request.
  const instruction = Buffer.concat([Buffer.from(DEPART_OUTER_HEAD), Buffer.from(request.proposal.bytes_hex, 'hex')]);
  check(p.instruction_hex === instruction.toString('hex') && typeof p.message_b64 === 'string' && p.message_b64.length <= 1644 && hex(p.message_digest, 32));
  const message = Buffer.from(p.message_b64, 'base64');
  check(message.toString('base64') === p.message_b64 && sha(message) === p.message_digest);
  let parsed; try { parsed = parseMessage(message); } catch { check(false); }
  // The payer pays and signs first; the acting wallet signs too when it is another key. Nobody else.
  const signers = [request.payer]; if (request.wallet !== request.payer) signers.push(request.wallet);
  check(eq(p.signers, signers) && eq(parsed.signers, signers) && parsed.accountKeys[0] === request.payer
    && parsed.recentBlockhash === b.hash && parsed.instructions.length === 5);
  const expected = new Map();
  for (const role of roles) {
    const old = expected.get(role.address) ?? { signer: false, writable: false };
    expected.set(role.address, { signer: old.signer || role.signer, writable: old.writable || role.writable });
  }
  check(!expected.has(request.program) && !expected.has(COMPUTE_BUDGET_PROGRAM));
  expected.set(request.program, { signer: false, writable: false }); expected.set(COMPUTE_BUDGET_PROGRAM, { signer: false, writable: false });
  const n = parsed.header.numRequiredSignatures, roSig = parsed.header.numReadonlySignedAccounts, ro = parsed.header.numReadonlyUnsignedAccounts;
  check(expected.size === parsed.accountKeys.length && new Set(parsed.accountKeys).size === parsed.accountKeys.length && parsed.accountKeys.every((key, i) => {
    const role = expected.get(key); return !!role && role.signer === (i < n) && role.writable === (i < n ? i < n - roSig : i < parsed.accountKeys.length - ro);
  }));
  // Exactly five instructions, in this order: compute limit, zero price, loaded-data limit, the one heap frame, the
  // dispatch. No other instruction, no second heap frame, no other size.
  const prefix = [budgetData(2, pins.cu_limit, 4), budgetData(3, 0, 8), budgetData(4, pins.loaded_limit, 4), budgetData(1, DEPART_HEAP_FRAME, 4)];
  prefix.forEach((data, i) => check(parsed.instructions[i].programId === COMPUTE_BUDGET_PROGRAM && parsed.instructions[i].keys.length === 0 && Buffer.from(parsed.instructions[i].data).equals(data)));
  const game = parsed.instructions[4];
  check(game.programId === request.program && Buffer.from(game.data).equals(instruction) && game.keys.length === roles.length
    && game.keys.every((key, i) => key.pubkey === roles[i].address && key.isSigner === expected.get(roles[i].address).signer && key.isWritable === expected.get(roles[i].address).writable));
  const shape = { bytes: message.length + 1 + 64 * n, locks: expected.size, writes: [...expected.values()].filter(r => r.writable).length, sigs: n };
  check(exact(p.shape, Object.keys(shape)) && Object.keys(shape).every(k => p.shape[k] === shape[k]) && shape.bytes <= 1232 && shape.locks <= 32 && shape.writes <= 16);
  return freeze(copy(v));
}

/**
 * The adapter, or null when it is not configured (the default). Nothing runs at construction. One child per
 * request: the configured absolute binary, no shell, an empty environment, the request on its stdin and the report
 * from its stdout (stderr is not opened). A slot stays taken until the child has closed, so a killed child still
 * counts until it is gone. `close()` refuses new work and kills every child.
 */
export function createExpeditionDepartPrepare({ cfg, season, spawn = nodeSpawn, setTimer = setTimeout, clearTimer = clearTimeout }) {
  if (unset(cfg)) return null;
  if (expeditionDepartPrepareConfigProblems(cfg).length || !address(season)) fail('ExpeditionDepartPrepareDisabled');
  const pins = Object.freeze({ cluster: cfg.cluster, program: cfg.programId, season, fee_payer: cfg.expeditionDepartPrepareFeePayer,
    ruleset_hash: cfg.expeditionDepartPrepareRulesetHash, cu_limit: Number(cfg.expeditionDepartPrepareCuLimit), loaded_limit: Number(cfg.expeditionDepartPrepareLoadedLimit) });
  const binary = cfg.expeditionDepartPrepareBin;
  const args = ['--rpc-url', cfg.expeditionDepartPrepareRpc, '--program', pins.program, '--season', pins.season, '--fee-payer', pins.fee_payer,
    '--ruleset-hash', pins.ruleset_hash, '--cu-limit', String(pins.cu_limit), '--loaded-limit', String(pins.loaded_limit)];
  const active = new Set(); let closed = false;
  return Object.freeze({
    async prepare(input, { signal } = {}) {
      if (closed) fail('ExpeditionDepartPrepareUnavailable');
      if (signal?.aborted) fail('ExpeditionDepartPrepareAborted');
      const request = expeditionDepartPrepareRequest(input);
      if (request.cluster !== pins.cluster || request.program !== pins.program || request.season !== pins.season || request.payer !== pins.fee_payer
          || request.deployment.ruleset_hash !== pins.ruleset_hash) fail('ExpeditionDepartPrepareScopeMismatch');
      if (active.size >= DEPART_PREPARE_MAX_CONCURRENT) fail('ExpeditionDepartPrepareBusy');
      return new Promise((resolve, reject) => {
        let child, timer, finished = false, size = 0; const chunks = [];
        const finish = (error, report) => { if (finished) return; finished = true; clearTimer(timer); signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(report); };
        const stop = code => { finish(new ExpeditionDepartPrepareError(code)); try { child?.kill('SIGKILL'); } catch { /* already gone */ } };
        const abort = () => stop(signal?.reason === 'ExpeditionDepartPrepareTimeout' ? 'ExpeditionDepartPrepareTimeout' : 'ExpeditionDepartPrepareAborted');
        const token = { stop }; active.add(token);
        try {
          child = spawn(binary, [...args], { shell: false, cwd: '/', env: {}, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
          // (a child that never started closes nothing: its slot is given back here)
          child.once('error', () => { if (child.pid === undefined) active.delete(token); stop('ExpeditionDepartPrepareUnavailable'); });
          child.once('close', (code, killedBy) => {
            active.delete(token); if (finished) return;
            if (killedBy || ![0, 2].includes(code)) return finish(new ExpeditionDepartPrepareError('ExpeditionDepartPrepareUnavailable'));
            try {
              const report = expeditionDepartPrepareReport(JSON.parse(Buffer.concat(chunks).toString('utf8')), request, pins);
              if ((code === 0) !== (report.status === 'prepared')) fail('ExpeditionDepartPrepareInvalidReport');
              finish(null, report);
            } catch { finish(new ExpeditionDepartPrepareError('ExpeditionDepartPrepareInvalidReport')); }
          });
          child.stdout.on('data', chunk => { if (finished) return; const bytes = Buffer.from(chunk); size += bytes.length;
            if (size > DEPART_PREPARE_MAX_OUTPUT_BYTES) return stop('ExpeditionDepartPrepareOutputTooLarge'); chunks.push(bytes); });
          for (const stream of [child.stdin, child.stdout]) stream.on('error', () => stop('ExpeditionDepartPrepareUnavailable'));
          signal?.addEventListener('abort', abort, { once: true }); timer = setTimer(() => stop('ExpeditionDepartPrepareTimeout'), DEPART_PREPARE_TIMEOUT_MS);
          if (signal?.aborted) return abort();
          child.stdin.end(JSON.stringify(request));
        } catch { if (!child) active.delete(token); stop('ExpeditionDepartPrepareUnavailable'); }
      });
    },
    /** How many children have not closed yet (for the tests and the shutdown). */
    get active() { return active.size; },
    close() { closed = true; for (const job of [...active]) job.stop('ExpeditionDepartPrepareAborted'); },
  });
}
