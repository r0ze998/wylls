// Optional read-only transport for the separate keyless expedition inspector.
// This module never starts the relay, opens a key store or builds a transaction.
import { spawn as nodeSpawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { decode as fromBase58, encode as toBase58 } from '../../client/src/base58.mjs';
import { canonicalExpeditionAccounts, canonicalExpeditionRoles } from '../../../permutation-server/web/frontier/fexpedition-identity.mjs';
import { OUTBOUND_SNAPSHOT_REQUEST_SCHEMA, outboundSnapshotRequest, outboundSnapshotReport } from './outbound-snapshot.mjs';

export const EXPEDITION_REQUEST_SCHEMA = 'frontier-original-expedition-request-v1';
export const EXPEDITION_REPORT_SCHEMA = 'frontier-original-expedition-preview-v1';
export const EXPEDITION_PREVIEW_ROUTE = 'POST /f/expedition/preview';
export const EXPEDITION_MAX_REQUEST_BYTES = 8 * 1024;
export const EXPEDITION_MAX_OUTPUT_BYTES = 64 * 1024;
export const EXPEDITION_TIMEOUT_MS = 25_000;
export const EXPEDITION_MAX_CONCURRENT = 2;

const ERRORS = Object.freeze({
  ExpeditionPreviewDisabled: [503, 'expedition inspection is not configured'],
  ExpeditionPreviewInvalidRequest: [400, 'invalid expedition inspection request'],
  ExpeditionPreviewScopeMismatch: [409, 'expedition inspection does not match the served deployment'],
  ExpeditionPreviewBusy: [429, 'expedition inspection is busy; try again later'],
  ExpeditionPreviewTimeout: [504, 'expedition inspection timed out'],
  ExpeditionPreviewAborted: [499, 'expedition inspection was cancelled'],
  ExpeditionPreviewUnavailable: [503, 'expedition inspection is unavailable'],
  ExpeditionPreviewInvalidReport: [502, 'expedition inspection returned an invalid report'],
  ExpeditionPreviewOutputTooLarge: [502, 'expedition inspection exceeded its output limit'],
});
export class ExpeditionPreviewError extends Error {
  constructor(code) {
    const [status, message] = ERRORS[code] ?? ERRORS.ExpeditionPreviewUnavailable;
    super(message);
    this.code = Object.hasOwn(ERRORS, code) ? code : 'ExpeditionPreviewUnavailable';
    this.status = status;
  }
}
const fail = code => { throw new ExpeditionPreviewError(code); };
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const exact = (v, names) => isObject(v) && Object.keys(v).length === names.length && names.every(k => Object.hasOwn(v, k));
const hex = (v, length) => typeof v === 'string' && v.length === length && /^[0-9a-f]+$/.test(v);
const address = v => {
  if (typeof v !== 'string' || v.length < 32 || v.length > 44) return false;
  try { const bytes = fromBase58(v); return bytes.length === 32 && bytes.some(b => b !== 0) && toBase58(bytes) === v; } catch { return false; }
};
const integer = (v, min = 0n, max = 0xffff_ffff_ffff_ffffn) => {
  if (typeof v !== 'string' || v.length > 20 || !/^(?:0|[1-9][0-9]*|-[1-9][0-9]*)$/.test(v)) return false;
  const n = BigInt(v);
  return n >= min && n <= max;
};
const signed = v => integer(v, -0x8000_0000_0000_0000n, 0x7fff_ffff_ffff_ffffn);
const version = v => integer(v, 0n, 0xffffn) && (BigInt(v) & 0x4000n) !== 0n;
const cluster = v => typeof v === 'string' && /^[a-z0-9-]{1,32}$/.test(v);

/** Identical URL policy to the Rust one-shot CLI: explicit loopback HTTP only. */
export function expeditionRpcUrlAllowed(url) {
  if (typeof url !== 'string' || Buffer.byteLength(url) > 2048) return false;
  const match = /^http:\/\/(?:127\.0\.0\.1|\[::1\]):([0-9]{1,5})(\/[A-Za-z0-9/_.~-]*)?$/.exec(url);
  return !!match && Number(match[1]) > 0 && Number(match[1]) <= 65535;
}

/** No defaults, discovery or fallback to the relay RPC. Partial setup fails closed. */
export function expeditionPreviewConfigProblems(cfg) {
  const fields = ['expeditionPreviewBin', 'expeditionPreviewRpc', 'expeditionPreviewProgramVersion', 'expeditionPreviewRulesetHash'];
  if (fields.every(k => cfg[k] === null || cfg[k] === undefined)) return [];
  const problems = [];
  if (typeof cfg.expeditionPreviewBin !== 'string' || cfg.expeditionPreviewBin.length > 4096
      || cfg.expeditionPreviewBin.includes('\0') || !path.isAbsolute(cfg.expeditionPreviewBin)) problems.push('expedition preview requires an absolute executable path');
  if (!expeditionRpcUrlAllowed(cfg.expeditionPreviewRpc)) problems.push('expedition preview requires an explicit loopback HTTP RPC URL');
  if (!version(cfg.expeditionPreviewProgramVersion)) problems.push('expedition preview requires a canonical wide program version');
  if (!hex(cfg.expeditionPreviewRulesetHash, 64)) problems.push('expedition preview requires a lowercase ruleset hash');
  if (!cluster(cfg.cluster)) problems.push('expedition preview requires a canonical cluster label');
  if (!address(cfg.programId)) problems.push('expedition preview requires a canonical program address');
  return problems;
}

const REQUEST_FIELDS = ['schema', 'operation', 'cluster', 'program', 'season', 'deployment', 'host', 'original_owner', 'standing', 'min_slot', 'wallet', 'payer'];
/** Shape/bounds only. The Rust planner checks the full host, world and account identities. */
export function expeditionRequest(value) {
  if (!exact(value, REQUEST_FIELDS) || value.schema !== EXPEDITION_REQUEST_SCHEMA || value.operation !== 'inspect'
      || !cluster(value.cluster) || !address(value.program) || !address(value.season)
      || !exact(value.deployment, ['program_version', 'ruleset_hash']) || !version(value.deployment.program_version)
      || !hex(value.deployment.ruleset_hash, 64) || !hex(value.host, 112) || !address(value.original_owner)
      || !exact(value.standing, ['p', 'q']) || !signed(value.standing.p) || !signed(value.standing.q)
      || !integer(value.min_slot) || !(value.wallet === null || address(value.wallet)) || !(value.payer === null || address(value.payer))) {
    fail('ExpeditionPreviewInvalidRequest');
  }
  // Copy only the closed contract, independent of caller mutation and key order.
  return Object.freeze({ schema: value.schema, operation: value.operation, cluster: value.cluster,
    program: value.program, season: value.season,
    deployment: Object.freeze({ program_version: value.deployment.program_version, ruleset_hash: value.deployment.ruleset_hash }),
    host: value.host, original_owner: value.original_owner,
    standing: Object.freeze({ p: value.standing.p, q: value.standing.q }), min_slot: value.min_slot, wallet: value.wallet, payer: value.payer });
}

export function expeditionRequestDigest(r) {
  const fields = [r.operation, r.cluster, r.program, r.season, r.deployment.program_version, r.deployment.ruleset_hash,
    r.host, r.original_owner, r.standing.p, r.standing.q, r.min_slot, r.wallet ?? '', r.payer ?? ''];
  return createHash('sha256').update(`${EXPEDITION_REQUEST_SCHEMA}\n${fields.join('\n')}\n`).digest('hex');
}

const CLOSED = ['dispatch_available', 'admitted', 'signed', 'enqueued', 'automatic_send', 'completion_proven', 'history_verified'];
const closed = v => CLOSED.every(k => v[k] === false);
const nullable = (v, check) => v === null || check(v);
const byte = v => Number.isInteger(v) && v >= 0 && v <= 255;
const u32 = v => integer(v, 0n, 0xffff_ffffn);
const NEXT = new Set(['OriginalDepartureResolution', 'OriginalDepartureSettlement', 'RevealOrGatherEvidence',
  'OriginDestroyedSettlementOrCleanupEvidence', 'DestinationResolveOrSettlementEvidence', 'OwnerDissolve', 'ResolveVoluntaryLeave', 'ReturnOriginalReserve']);
const DENIALS = new Set(['OriginalHostDispatchUnavailable', 'SourceProvenanceUnverified', 'HistoryUnverified', 'ExecutionEvidenceUnverified',
  'SignerAbsent', 'SliceDoesNotEnqueue', 'WalletAuthorizationAndPlayerPrologueUnverified', 'SnapshotCurrencyUnknown', 'NoCoherentSnapshot',
  'FeedWritesPaused', 'KindNotAllowed', 'AlreadyPending', 'CareUnresolved']);
// Deliberately closed: neither an arbitrary executable error nor RPC text is HTTP output.
const BLOCKERS = new Set([
  'Usage', 'ExplicitRpcRequired', 'LoopbackHttpRpcRequired', 'RpcPortOutOfRange', 'RpcPathInvalid', 'RuntimeUnavailable', 'OutputTooLarge',
  'InputRead', 'ObjectRequired', 'ExactFieldsRequired', 'StringRequired', 'CanonicalDecimalRequired', 'IntegerOutOfRange',
  'PublicAddressRequired', 'CanonicalHexRequired', 'RequestTooLarge', 'InvalidJson', 'Schema', 'Operation', 'ClusterLabel',
  'WideVersionRequired', 'ScopeAlias', 'HostReference', 'CoordinateOutOfRange', 'ReadSet', 'PreviewTimeout',
  'SnapshotRequestMismatch', 'SnapshotKeySetMismatch', 'SnapshotUnexpectedRent', 'SnapshotDataTooLarge', 'SnapshotCoherenceMismatch',
  'SnapshotUnsupported', 'SnapshotTooManyKeys', 'SnapshotDuplicateKey', 'SnapshotRpc', 'SnapshotMalformed', 'SnapshotPartial',
  'SnapshotStale', 'SnapshotBadClock', 'SnapshotBadRent', 'HostMustBeOriginal', 'StandingMustBeWide', 'OriginalOwnerRequired',
  'MissingReads', 'ExecutableAccount', 'OriginalAccount', 'SourceGeneration', 'SourceNotLive', 'HostNotIssued', 'OwnerChanged',
  'CitizenBinding', 'InvalidTransitOccupancy', 'OrdinaryTransitOpen', 'DuplicateTransit', 'OwnedBridgeRequired', 'BridgePair',
  'BridgeOwner', 'BridgeDestination', 'OrphanBridge', 'ResidentMissingHistoryRequired', 'LeavePayloadUnsupported', 'ResidentBusy',
  'ResolveBehind', 'ClockMissing', 'ClockBeforeGenesis', 'PendingBellInFuture', 'Read', 'Season', 'SeasonStatus',
  'SeasonDependsOnClock', 'SeasonNotStarted', 'DeploymentUnpinned', 'ProgramVersion', 'RulesetHash', 'World', 'Absent', 'ForeignOwner',
  'Unreadable', 'NotCanonical', 'TimingNeedsClock', 'Overflow', 'CapturePending', 'BadEntry', 'EntryUnpaired', 'RosterUnpaired',
  'ReserveOverflow', 'SeasonEnded', 'ChainOverflow', 'UnsupportedPlannerBlock',
]);
const BLOCKER_FIELDS = new Set([...REQUEST_FIELDS, 'request', 'program_version', 'ruleset_hash', 'p', 'q', 'selection', 'rpc_url']);
const DRAFT_BLOCKERS = new Set(['NoResidentDraftAtThisStage', 'PayerProposalRequired', 'WalletProposalRequired', 'WalletCitizenMismatch', 'DraftAccountContract']);

function validFacts(f, r, source) {
  if (!exact(f, ['key', 'kind', 'host', 'standing_key', 'original_owner', 'accounts', 'next_prerequisite', 'observed',
    'min_slot', 'context_slot', 'clock', 'coherent', 'provenance_verified', 'history_verified', 'dispatch_available', 'tag', 'instruction',
    'admitted', 'signed', 'enqueued', 'automatic_send', 'completion_proven', 'denials']) || !closed(f)
      || f.provenance_verified !== false || f.tag !== null || f.instruction !== null || f.kind !== 'original-expedition-review'
      || f.host !== r.host || f.original_owner !== r.original_owner || f.min_slot !== r.min_slot || f.context_slot !== source.context_slot
      || f.coherent !== true || !NEXT.has(f.next_prerequisite)) return false;
  let canonical;
  try { canonical = canonicalExpeditionAccounts(r); } catch { return false; }
  const standingKey = canonical.standing_key;
  if (f.standing_key !== standingKey || f.key !== `original-expedition-review:${r.host}:${standingKey}:${r.original_owner}`) return false;
  if (!exact(f.accounts, ['original_holding', 'original_home', 'wide_standing', 'wide_roster', 'owned_bridges'])
      || !['original_holding', 'original_home', 'wide_standing', 'wide_roster'].every(k => address(f.accounts[k]))
      || !Array.isArray(f.accounts.owned_bridges) || f.accounts.owned_bridges.length !== 4 || !f.accounts.owned_bridges.every(address)) return false;
  if (!['original_holding', 'original_home', 'wide_standing', 'wide_roster'].every(k => f.accounts[k] === canonical.accounts[k])
      || f.accounts.owned_bridges.some((v, i) => v !== canonical.accounts.owned_bridges[i])) return false;
  if (!exact(f.clock, ['slot', 'unix_timestamp', 'bell', 'status_promoted_by_clock']) || f.clock.slot !== source.context_slot
      || !signed(f.clock.unix_timestamp) || !u32(f.clock.bell) || typeof f.clock.status_promoted_by_clock !== 'boolean') return false;
  if (!Array.isArray(f.denials) || f.denials.length > DENIALS.size || !f.denials.every(d => DENIALS.has(d))) return false;
  const o = f.observed;
  if (o?.kind === 'owned-bridge-v2') return exact(o, ['kind', 'slot', 'state', 'depart_bell', 'arrive_bell', 'destination_bound'])
    && byte(o.slot) && o.slot < 4 && ['Free', 'Departed', 'Settled', 'DestroyedAtOrigin', 'Gathered'].includes(o.state)
    && u32(o.depart_bell) && u32(o.arrive_bell) && typeof o.destination_bound === 'boolean';
  return exact(o, ['kind', 'entry', 'state', 'unit', 'troops_milli', 'pending_bell', 'resolved_next', 'return_units', 'reserve_after'])
    && o.kind === 'original-host-wide-resident' && byte(o.entry) && o.entry < 56 && byte(o.state) && byte(o.unit) && o.unit < 8
    && ['troops_milli', 'pending_bell', 'resolved_next'].every(k => u32(o[k]))
    && nullable(o.return_units, u32) && nullable(o.reserve_after, u32);
}

function validDraft(d, r, facts) {
  if (!exact(d, ['kind', 'action', 'roles', 'dispatch_available', 'admitted']) || d.kind !== 'closed-resident-role-draft'
      || d.dispatch_available !== false || d.admitted !== false || !Array.isArray(d.roles)) return false;
  const dissolve = d.action === 'Dissolve';
  if (!(dissolve ? facts.next_prerequisite === 'OwnerDissolve' && r.wallet !== null : d.action === 'Return' && facts.next_prerequisite === 'ReturnOriginalReserve') || !r.payer) return false;
  let roles;
  try { roles = canonicalExpeditionRoles(r, d.action); } catch { return false; }
  return d.roles.length === roles.length && d.roles.every((v, i) => exact(v, ['name', 'address', 'signer', 'writable'])
    && ['name', 'address', 'signer', 'writable'].every(k => v[k] === roles[i][k]));
}

/** Validate the closed report and bind it to this exact selection before publication. */
export function expeditionReport(value, request) {
  const invalid = () => fail('ExpeditionPreviewInvalidReport');
  if (!exact(value, ['schema', 'status', 'stage', 'request_digest', 'scope', 'source', 'blocker', 'facts', 'draft', 'draft_blocker', ...CLOSED])
      || value.schema !== EXPEDITION_REPORT_SCHEMA || !closed(value)
      || !['preview', 'blocked'].includes(value.status) || !['request', 'arguments', 'runtime', 'snapshot', 'plan', 'output'].includes(value.stage)) invalid();
  const s = value.source;
  if (!exact(s, ['kind', 'read_calls', 'coherent', 'single_response', 'context_slot', 'digest', 'authority_verified', 'freshness', 'complete_world_view'])
      || s.kind !== 'single_snapshot_source' || !['0', '1'].includes(s.read_calls) || typeof s.coherent !== 'boolean' || typeof s.single_response !== 'boolean'
      || !nullable(s.context_slot, integer) || !nullable(s.digest, v => hex(v, 64)) || s.authority_verified !== false
      || s.freshness !== 'unknown' || s.complete_world_view !== false) invalid();
  if (s.coherent && (!s.single_response || s.read_calls !== '1' || s.context_slot === null || s.digest === null
      || BigInt(s.context_slot) < BigInt(request.min_slot))) invalid();
  if (!s.coherent && (s.single_response || s.context_slot !== null || s.digest !== null)) invalid();
  if (value.stage === 'plan' && !s.coherent) invalid();
  if (['snapshot', 'plan'].includes(value.stage) ? s.read_calls !== '1' : s.read_calls !== '0' || s.coherent) invalid();
  if (value.scope === null || value.request_digest === null) {
    if (value.scope !== null || value.request_digest !== null || value.status !== 'blocked'
        || !['request', 'arguments', 'runtime', 'output'].includes(value.stage) || s.read_calls !== '0' || s.coherent) invalid();
  } else {
    if (!['snapshot', 'plan'].includes(value.stage)) invalid();
    let scope;
    try { scope = expeditionRequest(value.scope); } catch { invalid(); }
    if (expeditionRequestDigest(scope) !== expeditionRequestDigest(request) || value.request_digest !== expeditionRequestDigest(request)) invalid();
  }
  if (value.blocker !== null && (!(exact(value.blocker, ['code']) || exact(value.blocker, ['code', 'field']))
      || !BLOCKERS.has(value.blocker.code) || (value.blocker.field !== undefined && !BLOCKER_FIELDS.has(value.blocker.field)))) invalid();
  if (!nullable(value.draft_blocker, v => DRAFT_BLOCKERS.has(v))) invalid();
  if (value.status === 'blocked') {
    if (!value.blocker || value.facts !== null || value.draft !== null || value.draft_blocker !== null) invalid();
  } else if (value.stage !== 'plan' || value.scope === null || value.blocker !== null || !s.coherent
      || !validFacts(value.facts, request, s) || (value.draft === null && value.draft_blocker === null)
      || (value.draft !== null && (!validDraft(value.draft, request, value.facts) || value.draft_blocker !== null))) invalid();
  return value;
}

/** Constructing this optional adapter does not spawn or read anything. No queue. */
export function createExpeditionPreview({ cfg, season, spawn = nodeSpawn, setTimer = setTimeout, clearTimer = clearTimeout }) {
  if (!cfg.expeditionPreviewBin && expeditionPreviewConfigProblems(cfg).length === 0) return null;
  if (expeditionPreviewConfigProblems(cfg).length || !address(season)) fail('ExpeditionPreviewDisabled');
  const pins = Object.freeze({ cluster: cfg.cluster, program: cfg.programId, season,
    program_version: cfg.expeditionPreviewProgramVersion, ruleset_hash: cfg.expeditionPreviewRulesetHash });
  const binary = cfg.expeditionPreviewBin, rpc = cfg.expeditionPreviewRpc;
  const active = new Set();
  let closedAdapter = false;
  return Object.freeze({
    async inspect(input, { signal } = {}) {
      if (closedAdapter) fail('ExpeditionPreviewUnavailable');
      if (signal?.aborted) fail(signal.reason === 'ExpeditionPreviewTimeout' ? 'ExpeditionPreviewTimeout' : 'ExpeditionPreviewAborted');
      const outbound = input?.schema === OUTBOUND_SNAPSHOT_REQUEST_SCHEMA;
      let request;
      try { request = outbound ? outboundSnapshotRequest(input) : expeditionRequest(input); }
      catch { fail('ExpeditionPreviewInvalidRequest'); }
      if (request.cluster !== pins.cluster || request.program !== pins.program || request.season !== pins.season
          || request.deployment.program_version !== pins.program_version || request.deployment.ruleset_hash !== pins.ruleset_hash) fail('ExpeditionPreviewScopeMismatch');
      const payload = JSON.stringify(request);
      if (Buffer.byteLength(payload) > EXPEDITION_MAX_REQUEST_BYTES) fail('ExpeditionPreviewInvalidRequest');
      if (active.size >= EXPEDITION_MAX_CONCURRENT) fail('ExpeditionPreviewBusy');
      return new Promise((resolve, reject) => {
        let child, timer, finished = false, outputBytes = 0;
        const chunks = [];
        const finish = (error, report) => {
          if (finished) return;
          finished = true;
          clearTimer(timer);
          signal?.removeEventListener('abort', abort);
          if (error) reject(error); else resolve(report);
        };
        const stop = code => {
          finish(new ExpeditionPreviewError(code));
          try { child?.kill('SIGKILL'); } catch { /* Never forward OS errors or executable paths. */ }
        };
        const abort = () => stop(signal?.reason === 'ExpeditionPreviewTimeout' ? 'ExpeditionPreviewTimeout' : 'ExpeditionPreviewAborted');
        // Hold the concurrency slot until close, even after a timeout/abort.
        // A child that ignores termination cannot cause replacement-spawn storms.
        const token = { stop };
        active.add(token);
        try {
          child = spawn(binary, [...(outbound ? ['--outbound-snapshot'] : []), '--rpc-url', rpc], { shell: false, cwd: '/', env: {}, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
          child.once('error', () => stop('ExpeditionPreviewUnavailable'));
          child.once('close', (exitCode, exitSignal) => {
            active.delete(token);
            if (finished) return;
            if (exitSignal || ![0, 2].includes(exitCode)) return finish(new ExpeditionPreviewError('ExpeditionPreviewUnavailable'));
            try {
              const report = (outbound ? outboundSnapshotReport : expeditionReport)(JSON.parse(Buffer.concat(chunks).toString('utf8')), request);
              if ((exitCode === 0) !== (report.status === (outbound ? 'snapshot' : 'preview'))) fail('ExpeditionPreviewInvalidReport');
              finish(null, report);
            } catch { finish(new ExpeditionPreviewError('ExpeditionPreviewInvalidReport')); }
          });
          const data = (chunk, keep) => {
            if (finished) return;
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            outputBytes += bytes.length;
            if (outputBytes > EXPEDITION_MAX_OUTPUT_BYTES) return stop('ExpeditionPreviewOutputTooLarge');
            if (keep) chunks.push(bytes);
          };
          child.stdout.on('data', chunk => data(chunk, true));
          child.stderr.on('data', chunk => data(chunk, false));
          child.stdin.on('error', () => stop('ExpeditionPreviewUnavailable'));
          child.stdout.on('error', () => stop('ExpeditionPreviewUnavailable'));
          child.stderr.on('error', () => stop('ExpeditionPreviewUnavailable'));
          signal?.addEventListener('abort', abort, { once: true });
          timer = setTimer(() => stop('ExpeditionPreviewTimeout'), EXPEDITION_TIMEOUT_MS);
          if (signal?.aborted) return abort();
          child.stdin.end(payload);
        } catch {
          if (!child) active.delete(token);
          stop('ExpeditionPreviewUnavailable');
        }
      });
    },
    close() { closedAdapter = true; for (const child of active) child.stop('ExpeditionPreviewAborted'); },
  });
}
