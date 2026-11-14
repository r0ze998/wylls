// LOCAL-PLAY ONLY, CLOSED BY DEFAULT: unsigned preparation of the one player-signed conquest step, DeclareSiege of the
// Free City an original host stays at in wide land, through a keyless one-shot CLI (frontier-node; not built yet).
// docs/integration/FABLE-CONQUEST-CONNECTION-20261111.md is the contract.
//
// The inner command and its twelve accounts are the ABI's own (frontier-abi world_index/wide_ix.rs: `DA FF 01 05
// site entry`, DECLARE_SIEGE). The OUTER dispatch is a pin (`CONQUEST_DISPATCH_PINS`): its kind and tag are the
// published contract's, its heap frame a recorded local decision. A pin alone serves nothing: the routes are built
// only when every opening condition of local-play-conquest.mjs holds.
//
// No relay pool, wallet, key store, cosigner, simulation or send path is used. Nothing here signs or submits.
import { spawn as nodeSpawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { decode, encode } from '../../client/src/base58.mjs';
import { parseMessage, COMPUTE_BUDGET_PROGRAM } from '../../client/src/solana-tx.mjs';
import { expeditionRequest, expeditionRequestDigest, expeditionRpcUrlAllowed } from './expedition-preview.mjs';
import { canonicalDeclareSiegeRoles, DECLARE_SIEGE_SHAPE, DECLARE_SIEGE_DISPATCH } from '../../../permutation-server/web/frontier/fconquest-identity.mjs';
import { servesDeploymentVersion } from './local-lane-versions.mjs';

export const CONQUEST_PREPARE_REQUEST_SCHEMA = 'frontier-local-play-conquest-prepare-request-v1';
export const CONQUEST_PREPARE_REPORT_SCHEMA = 'frontier-local-play-conquest-prepare-report-v1';
export const CONQUEST_PREPARE_MAX_REQUEST_BYTES = 16 * 1024;
export const CONQUEST_PREPARE_MAX_OUTPUT_BYTES = 32 * 1024;
export const CONQUEST_PREPARE_TIMEOUT_MS = 30_000;
export const CONQUEST_PREPARE_MAX_CONCURRENT = 2;
/** The player-signed conquest actions. The five crank steps are the keeper's and are never prepared for a player. */
export const CONQUEST_ACTIONS = Object.freeze(['DeclareSiege']);
/**
 * The outer dispatch of each action: `{tag, kind, heap}`.
 *   tag, kind  PUBLISHED: docs/integration/CLAUDE-CONQUEST-DISPATCH-KINDS-20261111.md (kind 12, tag 0xDA, the inner
 *              command's own class tag), and frontier-abi expedition_dispatch_ix under `conquest-dispatch-experimental`.
 *   heap       a LOCAL DECISION, not published: 256 KiB, the frame Depart and the resident steps needed through the same
 *              wrapper on the real program (fclient CONQUEST_DECLARE_HEAP_FRAME). Unconfirmed until the conquest
 *              lane's first real SBF execution.
 * A pin opens nothing by itself: local-play-conquest.mjs CONQUEST_OPEN_CONDITIONS.
 */
// (fconquest-identity.mjs holds the one definition, shared with the page)
export const CONQUEST_DISPATCH_PINS = Object.freeze({ DeclareSiege: DECLARE_SIEGE_DISPATCH });
/** DECLARE_SIEGE (wide_ix.rs): name, signer, writable, in order (fconquest-identity.mjs). */
export const DECLARE_SIEGE_ROLES = DECLARE_SIEGE_SHAPE;
const VERSION = '18436';

const ERRORS = Object.freeze({
  ConquestPrepareDisabled: [503, 'unsigned conquest preparation is not configured'],
  ConquestPrepareInvalidRequest: [400, 'invalid unsigned conquest preparation request'],
  ConquestPrepareScopeMismatch: [409, 'preparation does not match the configured target'],
  ConquestPrepareBusy: [429, 'unsigned conquest preparation is busy'],
  ConquestPrepareTimeout: [504, 'unsigned conquest preparation timed out'],
  ConquestPrepareAborted: [499, 'unsigned conquest preparation was cancelled'],
  ConquestPrepareUnavailable: [503, 'unsigned conquest preparation is unavailable'],
  ConquestPrepareInvalidReport: [502, 'unsigned conquest preparation returned an invalid report'],
  ConquestPrepareOutputTooLarge: [502, 'unsigned conquest preparation exceeded its output limit'],
});
export class ConquestPrepareError extends Error {
  constructor(code) {
    const known = Object.hasOwn(ERRORS, code) ? code : 'ConquestPrepareUnavailable';
    super(ERRORS[known][1]); this.code = known; this.status = ERRORS[known][0];
  }
}
const fail = code => { throw new ConquestPrepareError(code); };
const exact = (v, fields) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === fields.length && fields.every(k => Object.hasOwn(v, k));
const hex = (v, n) => typeof v === 'string' && v.length === n && /^[0-9a-f]+$/.test(v);
const uint = v => typeof v === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(v) && BigInt(v) <= 0xffffffffffffffffn;
const byte = v => Number.isInteger(v) && v >= 0 && v <= 255;
const eq = (a, b) => a === b || (!!a && !!b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b)
  && Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(k => Object.hasOwn(b, k) && eq(a[k], b[k])));
const address = v => { try { const b = decode(v); return typeof v === 'string' && b.length === 32 && b.some(x => x !== 0) && encode(b) === v; } catch { return false; } };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const copy = v => JSON.parse(JSON.stringify(v));
function freeze(v) { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); } return v; }

/** A dispatch pin as it must be given: `{tag, kind, heap}`. Kinds 0–11 are the existing ones and are refused. */
export function conquestDispatchPin(pin) {
  if (!exact(pin, ['tag', 'kind', 'heap']) || !byte(pin.tag) || !Number.isInteger(pin.kind) || pin.kind < 12 || pin.kind > 255 || !(pin.heap === null || pin.heap === 256 * 1024)) return null;
  return Object.freeze({ tag: pin.tag, kind: pin.kind, heap: pin.heap });
}

/** The closed request: the existing original-host inspection request, the observation it was read at, and the site and roster entry. */
export function conquestPrepareRequest(value) {
  const bad = () => fail('ConquestPrepareInvalidRequest');
  if (!exact(value, ['schema', 'request_id', 'action', 'source_request', 'source_context_slot', 'source_snapshot_digest', 'target'])
      || value.schema !== CONQUEST_PREPARE_REQUEST_SCHEMA || typeof value.request_id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value.request_id)
      || !CONQUEST_ACTIONS.includes(value.action) || !uint(value.source_context_slot) || !hex(value.source_snapshot_digest, 64)
      || !exact(value.target, ['site', 'entry']) || !Number.isInteger(value.target.site) || value.target.site < 0 || value.target.site > 11
      || !Number.isInteger(value.target.entry) || value.target.entry < 0 || value.target.entry > 55) bad();
  let source; try { source = expeditionRequest(value.source_request); } catch { bad(); }
  // (the twelve accounts must be nameable from this request alone: this wallet's own Citizen and host, this province, this site)
  try { canonicalDeclareSiegeRoles(source, value.target.site); } catch { bad(); }
  // (the player acts and pays: one wallet, named twice)
  if (!servesDeploymentVersion(source.deployment.program_version) || !address(source.wallet) || source.payer !== source.wallet
      || BigInt(value.source_context_slot) < BigInt(source.min_slot)) bad();
  const request = { schema: CONQUEST_PREPARE_REQUEST_SCHEMA, request_id: value.request_id, action: value.action, source_request: source,
    source_context_slot: value.source_context_slot, source_snapshot_digest: value.source_snapshot_digest, target: { site: value.target.site, entry: value.target.entry } };
  if (Buffer.byteLength(JSON.stringify(request)) > CONQUEST_PREPARE_MAX_REQUEST_BYTES) bad();
  return freeze(request);
}

const CLOSED = ['ready', 'deployment_verified', 'admitted', 'signed', 'enqueued', 'relay_submission_available', 'automatic_send'];
const BLOCKERS = new Set(['RequestInvalid', 'SourceUnavailable', 'SourceBlocked', 'TargetNotFreeCity', 'HostNotOnTarget', 'SiegeUnavailable', 'DispatchKindUnavailable', 'BlockhashUnavailable', 'PreflightFailed', 'OutputTooLarge']);
function budgetData(tag, value, size) { const b = Buffer.alloc(size + 1); b[0] = tag; size === 8 ? b.writeBigUInt64LE(BigInt(value), 1) : b.writeUInt32LE(value, 1); return b; }
/** The game instruction's data for `request` under `pin`: the outer wrapper, then the ABI's own DeclareSiege bytes. */
export const declareSiegeData = (request, pin) => Buffer.from([pin.tag, 0xff, 2, pin.kind, 0xda, 0xff, 1, 5, request.target.site, request.target.entry]);

/**
 * Independently inspect the CLI's report for `request`. `pins`: `{fee_payer, cu_limit, loaded_limit, dispatch}`.
 * Every one of the twelve accounts is rebuilt here from the request (fconquest-identity.mjs) and must equal the
 * report's, name, address and privilege: a report cannot move the signature to another site, province, roster,
 * conquest table, escrow or village.
 */
export function conquestPrepareReport(v, request, pins) {
  const check = yes => { if (!yes) fail('ConquestPrepareInvalidReport'); };
  check(exact(v, ['schema', 'status', 'request', 'source', 'blockhash', 'prepared', 'blocker', 'host_only', ...CLOSED])
    && v.schema === CONQUEST_PREPARE_REPORT_SCHEMA && ['prepared', 'blocked'].includes(v.status) && v.host_only === true && CLOSED.every(k => v[k] === false));
  let echoed; try { echoed = conquestPrepareRequest(v.request); } catch { check(false); }
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
  const p = v.prepared, source = request.source_request, pin = pins.dispatch, wallet = source.wallet;
  check(exact(p, ['program', 'season', 'program_version', 'action', 'fee_payer', 'dispatch', 'budget', 'roles', 'instruction_hex', 'message_b64', 'message_digest', 'signers', 'shape'])
    && p.program === source.program && p.season === source.season && p.program_version === source.deployment.program_version && p.action === request.action
    && p.fee_payer === pins.fee_payer && p.fee_payer === wallet && exact(p.dispatch, ['tag', 'kind']) && p.dispatch.tag === pin.tag && p.dispatch.kind === pin.kind
    && exact(p.budget, ['cu_limit', 'cu_price', 'loaded_limit', 'heap']) && p.budget.cu_limit === pins.cu_limit
    && p.budget.loaded_limit === pins.loaded_limit && p.budget.cu_price === '0' && p.budget.heap === pin.heap);
  // the twelve roles of DECLARE_SIEGE, rebuilt from the request: nothing of them is taken from the report
  let canonical; try { canonical = canonicalDeclareSiegeRoles(source, request.target.site); } catch { check(false); }
  check(Array.isArray(p.roles) && p.roles.length === canonical.length && p.roles.every((r, i) => exact(r, ['name', 'address', 'signer', 'writable'])
    && r.name === canonical[i].name && r.address === canonical[i].address && r.signer === canonical[i].signer && r.writable === canonical[i].writable));
  check(!canonical.some(r => r.address === source.program || r.address === COMPUTE_BUDGET_PROGRAM));
  const instruction = declareSiegeData(request, pin);
  check(p.instruction_hex === instruction.toString('hex') && typeof p.message_b64 === 'string' && p.message_b64.length <= 1644);
  const message = Buffer.from(p.message_b64, 'base64');
  check(message.toString('base64') === p.message_b64 && digest(message) === p.message_digest);
  let parsed; try { parsed = parseMessage(message); } catch { check(false); }
  const prefix = [budgetData(2, pins.cu_limit, 4), budgetData(3, 0, 8), budgetData(4, pins.loaded_limit, 4), ...(pin.heap === null ? [] : [budgetData(1, pin.heap, 4)])];
  check(eq(p.signers, [wallet]) && eq(parsed.signers, [wallet]) && parsed.accountKeys[0] === wallet && parsed.recentBlockhash === b.hash && parsed.instructions.length === prefix.length + 1);
  const expected = new Map();
  for (const role of p.roles) {
    const old = expected.get(role.address) ?? { signer: false, writable: false };
    expected.set(role.address, { signer: old.signer || role.signer, writable: old.writable || role.writable });
  }
  expected.set(source.program, { signer: false, writable: false }); expected.set(COMPUTE_BUDGET_PROGRAM, { signer: false, writable: false });
  const n = parsed.header.numRequiredSignatures, roSig = parsed.header.numReadonlySignedAccounts, ro = parsed.header.numReadonlyUnsignedAccounts;
  check(n === 1 && expected.size === parsed.accountKeys.length && parsed.accountKeys.every((key, i) => {
    const role = expected.get(key); return role && role.signer === (i < n) && role.writable === (i < n ? i < n - roSig : i < parsed.accountKeys.length - ro);
  }));
  prefix.forEach((data, i) => check(parsed.instructions[i].programId === COMPUTE_BUDGET_PROGRAM && parsed.instructions[i].keys.length === 0 && Buffer.from(parsed.instructions[i].data).equals(data)));
  const game = parsed.instructions[prefix.length];
  check(game.programId === source.program && Buffer.from(game.data).equals(instruction) && game.keys.length === p.roles.length
    && game.keys.every((key, i) => key.pubkey === p.roles[i].address && key.isSigner === expected.get(key.pubkey).signer && key.isWritable === expected.get(key.pubkey).writable));
  const shape = { bytes: message.length + 1 + 64 * n, locks: expected.size, writes: [...expected.values()].filter(r => r.writable).length, sigs: n };
  check(exact(p.shape, Object.keys(shape)) && Object.keys(shape).every(k => p.shape[k] === shape[k]) && shape.bytes <= 1232 && shape.locks <= 32 && shape.writes <= 16);
  return freeze(copy(v));
}

const CONFIG = ['conquestPrepareBin', 'conquestPrepareRpc', 'conquestPrepareFeePayer', 'conquestPrepareRulesetHash', 'conquestPrepareCuLimit', 'conquestPrepareLoadedLimit'];
const positive = (v, max) => (typeof v === 'number' || typeof v === 'string') && /^(0|[1-9][0-9]*)$/.test(String(v)) && Number.isSafeInteger(Number(v)) && Number(v) > 0 && Number(v) <= max;
export function conquestPrepareConfigProblems(cfg) {
  const out = [];
  if (typeof cfg.conquestPrepareBin !== 'string' || cfg.conquestPrepareBin.length > 4096 || cfg.conquestPrepareBin.includes('\0') || !path.isAbsolute(cfg.conquestPrepareBin)) out.push('conquest prepare requires an absolute executable path');
  if (!expeditionRpcUrlAllowed(cfg.conquestPrepareRpc)) out.push('conquest prepare requires an explicit loopback HTTP RPC URL');
  if (!address(cfg.conquestPrepareFeePayer)) out.push('conquest prepare requires a public fee payer');
  if (!hex(cfg.conquestPrepareRulesetHash, 64)) out.push('conquest prepare requires a lowercase ruleset hash');
  if (!positive(cfg.conquestPrepareCuLimit, 1_400_000) || !positive(cfg.conquestPrepareLoadedLimit, 64 * 1024 * 1024)) out.push('conquest prepare requires explicit bounded CU and loaded-data limits');
  if (!address(cfg.programId) || cfg.cluster !== 'localnet') out.push('conquest prepare is for the localnet target only');
  return out;
}

/**
 * The adapter. No default, no discovery: every setting and the dispatch pin of each action are required, else it
 * throws `ConquestPrepareDisabled`. No work at construction. Slots stay occupied until the child really closes.
 */
export function createConquestPrepare({ cfg, season, dispatch = CONQUEST_DISPATCH_PINS, spawn = nodeSpawn, setTimer = setTimeout, clearTimer = clearTimeout }) {
  if (!cfg || CONFIG.some(k => cfg[k] === null || cfg[k] === undefined) || conquestPrepareConfigProblems(cfg).length || !address(season)) fail('ConquestPrepareDisabled');
  const pinOf = {};
  for (const action of CONQUEST_ACTIONS) { const pin = conquestDispatchPin(dispatch?.[action]); if (!pin) fail('ConquestPrepareDisabled'); pinOf[action] = pin; }
  const pins = Object.freeze({ cluster: cfg.cluster, program: cfg.programId, season, fee_payer: cfg.conquestPrepareFeePayer, ruleset_hash: cfg.conquestPrepareRulesetHash,
    cu_limit: Number(cfg.conquestPrepareCuLimit), loaded_limit: Number(cfg.conquestPrepareLoadedLimit) });
  const binary = cfg.conquestPrepareBin;
  const args = ['--rpc-url', cfg.conquestPrepareRpc, '--program', pins.program, '--season', pins.season, '--fee-payer', pins.fee_payer,
    '--ruleset-hash', pins.ruleset_hash, '--cu-limit', String(pins.cu_limit), '--loaded-limit', String(pins.loaded_limit)];
  const active = new Set(); let closed = false;
  return Object.freeze({
    async prepare(input, { signal } = {}) {
      if (closed) fail('ConquestPrepareUnavailable');
      if (signal?.aborted) fail('ConquestPrepareAborted');
      const request = conquestPrepareRequest(input), source = request.source_request;
      if (source.cluster !== pins.cluster || source.program !== pins.program || source.season !== pins.season || source.payer !== pins.fee_payer
          || source.deployment.ruleset_hash !== pins.ruleset_hash) fail('ConquestPrepareScopeMismatch');
      if (active.size >= CONQUEST_PREPARE_MAX_CONCURRENT) fail('ConquestPrepareBusy');
      const reportPins = { ...pins, dispatch: pinOf[request.action] };
      return new Promise((resolve, reject) => {
        let child, timer, finished = false, size = 0; const chunks = [];
        const finish = (error, report) => { if (finished) return; finished = true; clearTimer(timer); signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(report); };
        const stop = code => { finish(new ConquestPrepareError(code)); try { child?.kill('SIGKILL'); } catch { /* never forward OS errors or paths */ } };
        const abort = () => stop('ConquestPrepareAborted');
        const token = { stop }; active.add(token);
        try {
          child = spawn(binary, [...args], { shell: false, cwd: '/', env: {}, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
          child.once('error', () => stop('ConquestPrepareUnavailable'));
          child.once('close', (code, sig) => {
            active.delete(token); if (finished) return;
            if (sig || ![0, 2].includes(code)) return finish(new ConquestPrepareError('ConquestPrepareUnavailable'));
            try {
              const report = conquestPrepareReport(JSON.parse(Buffer.concat(chunks).toString('utf8')), request, reportPins);
              if ((code === 0) !== (report.status === 'prepared')) fail('ConquestPrepareInvalidReport');
              finish(null, report);
            } catch { finish(new ConquestPrepareError('ConquestPrepareInvalidReport')); }
          });
          const data = (chunk, keep) => { if (finished) return; const bytes = Buffer.from(chunk); size += bytes.length;
            if (size > CONQUEST_PREPARE_MAX_OUTPUT_BYTES) return stop('ConquestPrepareOutputTooLarge'); if (keep) chunks.push(bytes); };
          child.stdout.on('data', x => data(x, true)); child.stderr.on('data', x => data(x, false));
          for (const stream of [child.stdin, child.stdout, child.stderr]) stream.on('error', () => stop('ConquestPrepareUnavailable'));
          signal?.addEventListener('abort', abort, { once: true }); timer = setTimer(() => stop('ConquestPrepareTimeout'), CONQUEST_PREPARE_TIMEOUT_MS);
          if (signal?.aborted) return abort(); child.stdin.end(JSON.stringify(request));
        } catch { if (!child) active.delete(token); stop('ConquestPrepareUnavailable'); }
      });
    },
    close() { closed = true; for (const child of active) child.stop('ConquestPrepareAborted'); },
  });
}
