// Local closed proposals for an original host observed resident in wide land.
// No public command, transaction, signature, sealer or send conversion exists.
import { inspectionReport, requestDigest, REQUEST_SCHEMA } from './fexpedition.mjs';
import { canonicalExpeditionAccounts, canonicalExpeditionRoles } from './fexpedition-identity.mjs';
import { parseU64 } from './map/wide.mjs';
import { decode, encode } from '../sdk/base58.mjs';
import { fromHex, toHex, utf8 } from '../sdk/bytes.mjs';
import { sha256 } from '../sdk/sha256.mjs';

const SCHEMA = 'frontier-original-resident-proposal-v1';
const DOMAIN = 'PSF-ORIGINAL-RESIDENT-DRAFT-v1';
const CLOSED = Object.freeze({ dispatch_available: false, public_dispatch_available: false,
  executable: false, admitted: false, signed: false, enqueued: false,
  automatic_send: false, completion_proven: false, history_verified: false,
  authority_verified: false, snapshot_content_verified: false });
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const exact = (x, names) => object(x) && Object.keys(x).length === names.length && names.every(k => Object.hasOwn(x, k));
const check = (ok, code = 'ReturnObservationState') => { if (!ok) throw Object.assign(new Error(code), { code }); };
const freeze = x => { if (object(x) || Array.isArray(x)) { Object.values(x).forEach(freeze); Object.freeze(x); } return x; };
const copy = x => JSON.parse(JSON.stringify(x));
const u32 = x => { const n = parseU64(x, 'ReturnObservationState'); check(n <= 0xffffffffn); return n; };
function publicBytes(s) {
  check(typeof s === 'string' && s.length >= 32 && s.length <= 44, 'ReturnScope');
  const b = decode(s); check(b.length === 32 && b.some(x => x !== 0) && encode(b) === s, 'ReturnScope'); return b;
}
function requestOf(r) {
  check(exact(r, ['schema', 'operation', 'cluster', 'program', 'season', 'deployment', 'host',
    'original_owner', 'standing', 'min_slot', 'wallet', 'payer']), 'ReturnScope');
  check(r.schema === REQUEST_SCHEMA && r.operation === 'inspect' && /^[a-z0-9-]{1,32}$/.test(r.cluster), 'ReturnScope');
  check(exact(r.deployment, ['program_version', 'ruleset_hash'])
    && /^[0-9a-f]{64}$/.test(r.deployment.ruleset_hash), 'ReturnScope');
  const version = parseU64(r.deployment.program_version, 'ReturnScope');
  check(version <= 65535n && (version & 0x4000n) !== 0n, 'ReturnScope');
  check(exact(r.standing, ['p', 'q']), 'ReturnScope');
  parseU64(r.min_slot, 'ReturnScope');
  if (r.wallet !== null) publicBytes(r.wallet);
  if (r.payer !== null) publicBytes(r.payer);
  canonicalExpeditionAccounts(r); // world, original full host, wide standing and public addresses
  return copy(r);
}
const le32 = n => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; };
function contentDigest(request, standingKey, bytes, roles) {
  const parts = [utf8(DOMAIN), publicBytes(request.program), publicBytes(request.season), fromHex(standingKey),
    le32(bytes.length), bytes, le32(roles.length)];
  for (const role of roles) {
    const name = utf8(role.name);
    parts.push(le32(name.length), name, publicBytes(role.address), Uint8Array.of(Number(role.signer), Number(role.writable)));
  }
  return toHex(sha256(...parts));
}
function proposal(report, request, action, standingKey) {
  // Only called after inspectionReport and state/next consistency checks.
  // No caller-supplied wire bytes or action are accepted by the public API.
  const roles = canonicalExpeditionRoles(request, action), bytes = new Uint8Array(60);
  bytes.set(action === 'Dissolve' ? [0xda, 0xff, 1, 7] : [0xdc, 0xff, 1, 12]);
  bytes.set(fromHex(request.host), 4);
  return { schema: SCHEMA, kind: 'closed-original-resident-proposal', action,
    program: request.program, season: request.season, host: request.host,
    standing: { ...request.standing, key: standingKey }, roles,
    byte_length: bytes.length, bytes_hex: toHex(bytes), content_digest: contentDigest(request, standingKey, bytes, roles),
    binding: { request: copy(request), request_digest: requestDigest(request), context_slot: report.source.context_slot,
      snapshot_digest: report.source.digest, clock: copy(report.facts.clock) },
    observation_only: true, ...CLOSED };
}

// (2026-11-16: the model holds ids only — step ids, the phase, and `detail` (an id: the phase, the bridge's next
//  prerequisite, 'unavailable' or 'no-proposal'); the card (hud/hand.mjs returnWords) says them with L`…`, so each
//  sentence is a dictionary key the scanner sees and follows the shown language. It held Japanese as data before.)
const STEPS = ['dissolve', 'resolve-leave', 'return-reserve'];
const steps = statuses => STEPS.map((id, i) => ({ id, status: statuses[i] }));
/** The bridge's next prerequisite → the observed state it needs. */
const BRIDGE = {
  OriginalDepartureResolution: 'Departed',
  OriginalDepartureSettlement: 'Departed',
  RevealOrGatherEvidence: 'Settled',
  OriginDestroyedSettlementOrCleanupEvidence: 'DestroyedAtOrigin',
  DestinationResolveOrSettlementEvidence: 'Gathered',
};

/**
 * Build presentation and, only at a reported resident action stage, exact
 * private draft bytes from a freshly scope-matched inspection report.
 * currentRequest must come from the current selection (inspectionRequest),
 * never from report.scope alone. The caller must discard the result when that
 * selection/request or its chosen snapshot changes. No freshness is inferred.
 * This function revalidates the report; passing a proposal, raw draft, unknown
 * state or stale scope cannot bypass inspectionReport or state consistency.
 * All returned values are immutable JSON data. They cannot be converted here
 * to an instruction or transaction, and never mark return as completed.
 */
export function originalReturnModel(value, currentRequest) {
  const request = requestOf(currentRequest), report = inspectionReport(value, request);
  const out = { phase: 'unavailable', detail: 'unavailable', code: null,
    steps: steps(['waiting', 'waiting', 'waiting']), proposal: null, returnUnits: null, reserveAfter: null,
    binding: { request_digest: requestDigest(request), context_slot: report.source.context_slot,
      snapshot_digest: report.source.digest }, observation_only: true, ...CLOSED };
  if (report.status === 'blocked') { out.code = report.blocker.code; return freeze(out); }
  const f = report.facts, o = f.observed, next = f.next_prerequisite;
  if (o.kind === 'owned-bridge-v2') {
    const stage = BRIDGE[next];
    check(stage && o.state === stage && report.draft === null);
    const departed = u32(o.depart_bell), arrive = u32(o.arrive_bell);
    check(departed <= 0xffffffffn - 72n && arrive >= departed + 2n && arrive <= departed + 72n);
    Object.assign(out, { phase: 'expedition-pending', detail: next, code: next });
    return freeze(out);
  }
  check(o.kind === 'original-host-wide-resident' && o.entry < 56);
  const bell = u32(f.clock.bell), pending = u32(o.pending_bell), resolved = u32(o.resolved_next), troops = u32(o.troops_milli);
  let action = null;
  if (next === 'OwnerDissolve') {
    check(o.state === 1 && resolved + 1n >= bell && o.return_units === null && o.reserve_after === null);
    action = 'Dissolve';
    Object.assign(out, { phase: 'resident', detail: 'resident',
      steps: steps(['proposal', 'waiting', 'waiting']) });
  } else if (next === 'ResolveVoluntaryLeave') {
    check([1, 3].includes(o.state) && pending <= bell && (o.state === 1 || resolved <= pending)
      && o.return_units === null && o.reserve_after === null && report.draft === null);
    Object.assign(out, { phase: 'leave-pending', detail: 'leave-pending',
      steps: steps(['observed', 'waiting', 'waiting']) });
  } else if (next === 'ReturnOriginalReserve') {
    check(o.state === 3 && pending <= bell && resolved > pending && o.return_units !== null && o.reserve_after !== null);
    const units = u32(o.return_units), reserve = u32(o.reserve_after);
    check(units === troops / 1000n && reserve >= units);
    action = 'Return';
    Object.assign(out, { phase: 'return-pending', detail: 'return-pending',
      steps: steps(['observed', 'observed', 'proposal']), returnUnits: units.toString(), reserveAfter: reserve.toString() });
  } else check(false);
  if (action && report.draft !== null) {
    check(report.draft.action === action);
    out.proposal = proposal(report, request, action, f.standing_key);
  } else if (action) {
    out.code = report.draft_blocker;
    out.detail = 'no-proposal';
    out.steps = out.steps.map(s => ({ ...s, status: s.status === 'proposal' ? 'waiting' : s.status }));
  }
  return freeze(out);
}
