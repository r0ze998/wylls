// Opt-in, unsigned resident message preparation through the keyless Rust CLI.
// No relay pool, wallet, key store, cosigner, simulation or send path is used.
import { spawn as nodeSpawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { decode, encode } from '../../client/src/base58.mjs';
import { parseMessage, COMPUTE_BUDGET_PROGRAM } from '../../client/src/solana-tx.mjs';
import { canonicalExpeditionAccounts, canonicalExpeditionRoles } from '../../../permutation-server/web/frontier/fexpedition-identity.mjs';
import { expeditionRequest, expeditionRequestDigest, expeditionRpcUrlAllowed } from './expedition-preview.mjs';

export const PREPARE_REQUEST_SCHEMA = 'frontier-experimental-expedition-prepare-request-v1';
export const PREPARE_REPORT_SCHEMA = 'frontier-experimental-expedition-prepare-report-v1';
export const EXPEDITION_PREPARE_ROUTE = 'POST /f/expedition/prepare';
export const PREPARE_MAX_REQUEST_BYTES = 16 * 1024;
export const PREPARE_MAX_OUTPUT_BYTES = 32 * 1024;
export const PREPARE_TIMEOUT_MS = 30_000;
export const PREPARE_MAX_CONCURRENT = 2;
const VERSION = '18436';
const ERRORS = Object.freeze({
  ExpeditionPrepareDisabled: [503, 'unsigned expedition preparation is not configured'],
  ExpeditionPrepareInvalidRequest: [400, 'invalid unsigned expedition preparation request'],
  ExpeditionPrepareScopeMismatch: [409, 'preparation does not match the configured target'],
  ExpeditionPrepareBusy: [429, 'unsigned expedition preparation is busy'],
  ExpeditionPrepareTimeout: [504, 'unsigned expedition preparation timed out'],
  ExpeditionPrepareAborted: [499, 'unsigned expedition preparation was cancelled'],
  ExpeditionPrepareUnavailable: [503, 'unsigned expedition preparation is unavailable'],
  ExpeditionPrepareInvalidReport: [502, 'unsigned expedition preparation returned an invalid report'],
  ExpeditionPrepareOutputTooLarge: [502, 'unsigned expedition preparation exceeded its output limit'],
});
export class ExpeditionPrepareError extends Error {
  constructor(code) {
    const known = Object.hasOwn(ERRORS, code) ? code : 'ExpeditionPrepareUnavailable';
    super(ERRORS[known][1]); this.code = known; this.status = ERRORS[known][0];
  }
}
const fail = code => { throw new ExpeditionPrepareError(code); };
const exact = (v, fields) => v && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).length === fields.length && fields.every(k => Object.hasOwn(v, k));
const hex = (v, n) => typeof v === 'string' && v.length === n && /^[0-9a-f]+$/.test(v);
const uint = v => typeof v === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(v) && BigInt(v) <= 0xffffffffffffffffn;
const eq = (a, b) => a === b || (!!a && !!b && typeof a === 'object' && typeof b === 'object'
  && Array.isArray(a) === Array.isArray(b) && Object.keys(a).length === Object.keys(b).length
  && Object.keys(a).every(k => Object.hasOwn(b, k) && eq(a[k], b[k])));
const address = v => {
  try { const b = decode(v); return typeof v === 'string' && b.length === 32 && b.some(x => x !== 0) && encode(b) === v; }
  catch { return false; }
};
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const le32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const copy = v => JSON.parse(JSON.stringify(v));
function freeze(v) { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); } return v; }

/** Rebuild public identities, privileges and private inner bytes from scope. */
export function canonicalResidentProposal(source, action) {
  const roles = canonicalExpeditionRoles(source, action);
  const standing = canonicalExpeditionAccounts(source).standing_key;
  const bytes = Buffer.concat([Buffer.from(action === 'Dissolve' ? [0xda, 0xff, 1, 7] : [0xdc, 0xff, 1, 12]), Buffer.from(source.host, 'hex')]);
  const h = createHash('sha256').update('PSF-ORIGINAL-RESIDENT-DRAFT-v1')
    .update(decode(source.program)).update(decode(source.season)).update(Buffer.from(standing, 'hex'))
    .update(le32(bytes.length)).update(bytes).update(le32(roles.length));
  for (const role of roles) {
    const name = Buffer.from(role.name);
    h.update(le32(name.length)).update(name).update(decode(role.address)).update(Buffer.from([+role.signer, +role.writable]));
  }
  return { bytes_hex: bytes.toString('hex'), content_digest: h.digest('hex'), roles };
}

export function expeditionPrepareRequest(value) {
  const bad = () => fail('ExpeditionPrepareInvalidRequest');
  if (!exact(value, ['schema', 'request_id', 'action', 'source_request', 'source_context_slot', 'source_snapshot_digest', 'proposal'])
      || value.schema !== PREPARE_REQUEST_SCHEMA || typeof value.request_id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value.request_id)
      || !['Dissolve', 'Return'].includes(value.action) || !uint(value.source_context_slot) || !hex(value.source_snapshot_digest, 64)) bad();
  let source, canonical;
  try { source = expeditionRequest(value.source_request); canonical = canonicalResidentProposal(source, value.action); }
  catch { bad(); }
  if (source.deployment.program_version !== VERSION || !address(source.payer)
      || BigInt(value.source_context_slot) < BigInt(source.min_slot)
      || !exact(value.proposal, ['bytes_hex', 'content_digest', 'roles']) || !Array.isArray(value.proposal.roles)
      || value.proposal.roles.length !== canonical.roles.length
      || value.proposal.bytes_hex !== canonical.bytes_hex || value.proposal.content_digest !== canonical.content_digest
      || value.proposal.roles.some((r, i) => !exact(r, ['name', 'address', 'signer', 'writable'])
        || ['name', 'address', 'signer', 'writable'].some(k => r[k] !== canonical.roles[i][k]))) bad();
  const request = { schema: PREPARE_REQUEST_SCHEMA, request_id: value.request_id, action: value.action,
    source_request: source, source_context_slot: value.source_context_slot, source_snapshot_digest: value.source_snapshot_digest,
    proposal: canonical };
  if (Buffer.byteLength(JSON.stringify(request)) > PREPARE_MAX_REQUEST_BYTES) bad();
  return freeze(request);
}

const CONFIG = ['expeditionPrepareBin', 'expeditionPrepareRpc', 'expeditionPrepareFeePayer', 'expeditionPrepareRulesetHash', 'expeditionPrepareCuLimit', 'expeditionPrepareLoadedLimit'];
const positive = (v, max) => (typeof v === 'number' || typeof v === 'string') && /^(0|[1-9][0-9]*)$/.test(String(v)) && Number.isSafeInteger(Number(v)) && Number(v) > 0 && Number(v) <= max;
export function expeditionPrepareConfigProblems(cfg) {
  if (CONFIG.every(k => cfg[k] === null || cfg[k] === undefined)) return [];
  const out = [];
  if (typeof cfg.expeditionPrepareBin !== 'string' || cfg.expeditionPrepareBin.length > 4096 || cfg.expeditionPrepareBin.includes('\0') || !path.isAbsolute(cfg.expeditionPrepareBin)) out.push('expedition prepare requires an absolute executable path');
  if (!expeditionRpcUrlAllowed(cfg.expeditionPrepareRpc)) out.push('expedition prepare requires an explicit loopback HTTP RPC URL');
  if (!address(cfg.expeditionPrepareFeePayer)) out.push('expedition prepare requires a public fee payer');
  if (!hex(cfg.expeditionPrepareRulesetHash, 64)) out.push('expedition prepare requires a lowercase ruleset hash');
  if (!positive(cfg.expeditionPrepareCuLimit, 1_400_000) || !positive(cfg.expeditionPrepareLoadedLimit, 64 * 1024 * 1024)) out.push('expedition prepare requires explicit bounded CU and loaded-data limits');
  if (!address(cfg.programId) || typeof cfg.cluster !== 'string' || !/^[a-z0-9-]{1,32}$/.test(cfg.cluster)) out.push('expedition prepare requires a canonical target');
  return out;
}
const CLOSED = ['ready', 'deployment_verified', 'admitted', 'signed', 'enqueued', 'relay_submission_available', 'automatic_send'];
const BLOCKERS = new Set(['RequestInvalid', 'SourceUnavailable', 'SourceBlocked', 'ActionUnavailable', 'ProposalMismatch', 'BlockhashUnavailable', 'PreflightFailed', 'OutputTooLarge']);
function budgetData(tag, value, size) { const b = Buffer.alloc(size + 1); b[0] = tag; size === 8 ? b.writeBigUInt64LE(BigInt(value), 1) : b.writeUInt32LE(value, 1); return b; }

/** Independently inspect CLI output. No browser/CLI supplied instruction is trusted. */
export function expeditionPrepareReport(v, request, pins) {
  const check = yes => { if (!yes) fail('ExpeditionPrepareInvalidReport'); };
  check(exact(v, ['schema', 'status', 'request', 'source', 'blockhash', 'prepared', 'blocker', 'host_only', ...CLOSED])
    && v.schema === PREPARE_REPORT_SCHEMA && ['prepared', 'blocked'].includes(v.status) && v.host_only === true && CLOSED.every(k => v[k] === false));
  let echoed; try { echoed = expeditionPrepareRequest(v.request); } catch { check(false); }
  check(eq(echoed, request));
  if (v.source !== null) check(exact(v.source, ['request_digest', 'context_slot', 'digest', 'coherent', 'authority_verified'])
    && v.source.request_digest === expeditionRequestDigest(request.source_request) && uint(v.source.context_slot)
    && BigInt(v.source.context_slot) >= BigInt(request.source_context_slot) && hex(v.source.digest, 64)
    && v.source.coherent === true && v.source.authority_verified === false);
  if (v.status === 'blocked') {
    check(v.prepared === null && v.blockhash === null && exact(v.blocker, ['code']) && BLOCKERS.has(v.blocker.code));
    return freeze(copy(v));
  }
  check(v.source !== null && v.blocker === null);
  const b = v.blockhash;
  check(exact(b, ['hash', 'latest_context_slot', 'validity_context_slot', 'height_min_context_slot', 'block_height', 'last_valid_block_height', 'remaining_block_heights', 'valid', 'commitment', 'coherent', 'authority_verified'])
    && address(b.hash) && ['latest_context_slot', 'validity_context_slot', 'height_min_context_slot', 'block_height', 'last_valid_block_height', 'remaining_block_heights'].every(k => uint(b[k]))
    && b.valid === true && b.commitment === 'confirmed' && b.coherent === false && b.authority_verified === false
    && BigInt(b.latest_context_slot) >= BigInt(v.source.context_slot) && BigInt(b.validity_context_slot) >= BigInt(b.latest_context_slot)
    && b.height_min_context_slot === b.validity_context_slot && BigInt(b.remaining_block_heights) >= 2n
    && BigInt(b.last_valid_block_height) - BigInt(b.block_height) === BigInt(b.remaining_block_heights));
  const p = v.prepared, source = request.source_request;
  check(exact(p, ['program', 'season', 'program_version', 'action', 'fee_payer', 'budget', 'roles', 'instruction_hex', 'message_b64', 'message_digest', 'signers', 'shape', 'proposal_digest'])
    && p.program === source.program && p.season === source.season && p.program_version === VERSION && p.action === request.action
    && p.fee_payer === pins.fee_payer && p.fee_payer === source.payer && p.proposal_digest === request.proposal.content_digest
    && exact(p.budget, ['cu_limit', 'cu_price', 'loaded_limit', 'heap']) && p.budget.cu_limit === pins.cu_limit
    && p.budget.loaded_limit === pins.loaded_limit && p.budget.cu_price === '0' && p.budget.heap === 256 * 1024
    && eq(p.roles, request.proposal.roles));
  const instruction = Buffer.concat([Buffer.from([request.action === 'Dissolve' ? 0xda : 0xdc, 0xff, 2, request.action === 'Dissolve' ? 4 : 5]), Buffer.from(request.proposal.bytes_hex, 'hex')]);
  check(p.instruction_hex === instruction.toString('hex') && typeof p.message_b64 === 'string' && p.message_b64.length <= 1644);
  const message = Buffer.from(p.message_b64, 'base64');
  check(message.toString('base64') === p.message_b64 && digest(message) === p.message_digest);
  let parsed; try { parsed = parseMessage(message); } catch { check(false); }
  const signers = [source.payer]; if (request.action === 'Dissolve' && source.wallet !== source.payer) signers.push(source.wallet);
  check(eq(p.signers, signers) && eq(parsed.signers, signers) && parsed.accountKeys[0] === source.payer && parsed.recentBlockhash === b.hash && parsed.instructions.length === 5);
  const expected = new Map();
  for (const role of request.proposal.roles) {
    const old = expected.get(role.address) ?? { signer: false, writable: false };
    expected.set(role.address, { signer: old.signer || role.signer, writable: old.writable || role.writable });
  }
  check(!expected.has(source.program) && !expected.has(COMPUTE_BUDGET_PROGRAM));
  expected.set(source.program, { signer: false, writable: false }); expected.set(COMPUTE_BUDGET_PROGRAM, { signer: false, writable: false });
  const n = parsed.header.numRequiredSignatures, roSig = parsed.header.numReadonlySignedAccounts, ro = parsed.header.numReadonlyUnsignedAccounts;
  check(expected.size === parsed.accountKeys.length && parsed.accountKeys.every((key, i) => {
    const role = expected.get(key); return role && role.signer === (i < n) && role.writable === (i < n ? i < n - roSig : i < parsed.accountKeys.length - ro);
  }));
  const prefix = [budgetData(2, pins.cu_limit, 4), budgetData(3, 0, 8), budgetData(4, pins.loaded_limit, 4), budgetData(1, 256 * 1024, 4)];
  prefix.forEach((data, i) => check(parsed.instructions[i].programId === COMPUTE_BUDGET_PROGRAM && parsed.instructions[i].keys.length === 0 && Buffer.from(parsed.instructions[i].data).equals(data)));
  const game = parsed.instructions[4];
  check(game.programId === source.program && Buffer.from(game.data).equals(instruction) && game.keys.length === request.proposal.roles.length
    && game.keys.every((key, i) => key.pubkey === request.proposal.roles[i].address && key.isSigner === request.proposal.roles[i].signer && key.isWritable === request.proposal.roles[i].writable));
  const shape = { bytes: message.length + 1 + 64 * n, locks: expected.size, writes: [...expected.values()].filter(r => r.writable).length, sigs: n };
  check(exact(p.shape, Object.keys(shape)) && Object.keys(shape).every(k => p.shape[k] === shape[k]) && shape.bytes <= 1232 && shape.locks <= 32 && shape.writes <= 16);
  return freeze(copy(v));
}

/** No work at construction. Slots remain occupied until process close. */
export function createExpeditionPrepare({ cfg, season, spawn = nodeSpawn, setTimer = setTimeout, clearTimer = clearTimeout }) {
  if (CONFIG.every(k => cfg[k] === null || cfg[k] === undefined)) return null;
  if (expeditionPrepareConfigProblems(cfg).length || !address(season)) fail('ExpeditionPrepareDisabled');
  const pins = Object.freeze({ cluster: cfg.cluster, program: cfg.programId, season, fee_payer: cfg.expeditionPrepareFeePayer,
    ruleset_hash: cfg.expeditionPrepareRulesetHash, cu_limit: Number(cfg.expeditionPrepareCuLimit), loaded_limit: Number(cfg.expeditionPrepareLoadedLimit) });
  const binary = cfg.expeditionPrepareBin;
  const args = ['--rpc-url', cfg.expeditionPrepareRpc, '--program', pins.program, '--season', pins.season, '--fee-payer', pins.fee_payer,
    '--ruleset-hash', pins.ruleset_hash, '--cu-limit', String(pins.cu_limit), '--loaded-limit', String(pins.loaded_limit)];
  const active = new Set(); let closed = false;
  return Object.freeze({
    async prepare(input, { signal } = {}) {
      if (closed) fail('ExpeditionPrepareUnavailable');
      if (signal?.aborted) fail('ExpeditionPrepareAborted');
      const request = expeditionPrepareRequest(input), source = request.source_request;
      if (source.cluster !== pins.cluster || source.program !== pins.program || source.season !== pins.season || source.payer !== pins.fee_payer
          || source.deployment.ruleset_hash !== pins.ruleset_hash) fail('ExpeditionPrepareScopeMismatch');
      if (active.size >= PREPARE_MAX_CONCURRENT) fail('ExpeditionPrepareBusy');
      return new Promise((resolve, reject) => {
        let child, timer, finished = false, size = 0; const chunks = [];
        const finish = (error, report) => { if (finished) return; finished = true; clearTimer(timer); signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(report); };
        const stop = code => { finish(new ExpeditionPrepareError(code)); try { child?.kill('SIGKILL'); } catch {} };
        const abort = () => stop(signal?.reason === 'ExpeditionPrepareTimeout' ? 'ExpeditionPrepareTimeout' : 'ExpeditionPrepareAborted');
        const token = { stop }; active.add(token);
        try {
          child = spawn(binary, [...args], { shell: false, cwd: '/', env: {}, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
          child.once('error', () => stop('ExpeditionPrepareUnavailable'));
          child.once('close', (code, signal) => {
            active.delete(token); if (finished) return;
            if (signal || ![0, 2].includes(code)) return finish(new ExpeditionPrepareError('ExpeditionPrepareUnavailable'));
            try {
              const report = expeditionPrepareReport(JSON.parse(Buffer.concat(chunks).toString('utf8')), request, pins);
              if ((code === 0) !== (report.status === 'prepared')) fail('ExpeditionPrepareInvalidReport');
              finish(null, report);
            } catch { finish(new ExpeditionPrepareError('ExpeditionPrepareInvalidReport')); }
          });
          const data = (chunk, keep) => { if (finished) return; const bytes = Buffer.from(chunk); size += bytes.length;
            if (size > PREPARE_MAX_OUTPUT_BYTES) return stop('ExpeditionPrepareOutputTooLarge'); if (keep) chunks.push(bytes); };
          child.stdout.on('data', b => data(b, true)); child.stderr.on('data', b => data(b, false));
          for (const stream of [child.stdin, child.stdout, child.stderr]) stream.on('error', () => stop('ExpeditionPrepareUnavailable'));
          signal?.addEventListener('abort', abort, { once: true }); timer = setTimer(() => stop('ExpeditionPrepareTimeout'), PREPARE_TIMEOUT_MS);
          if (signal?.aborted) return abort(); child.stdin.end(JSON.stringify(request));
        } catch { if (!child) active.delete(token); stop('ExpeditionPrepareUnavailable'); }
      });
    },
    close() { closed = true; for (const child of active) child.stop('ExpeditionPrepareAborted'); },
  });
}
