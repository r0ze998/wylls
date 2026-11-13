// Read-only inspection of an ORIGINAL host at an explicitly supplied wide
// coordinate. No movement, signing, session, relay-payer or history API belongs
// here. A proposal in the report never authorizes an action or proves return.
import { clearPreparation } from './fexpedition-prepare.mjs';
import { subjectOf } from './hud/subject.mjs';
import { hostParts, hostId, seasonAddresses } from './faddr.mjs';
import { parseWideInt, parseU64, ringPosition, worldIdOf } from './map/wide.mjs';
import { decode as fromB58, encode as toB58 } from '../sdk/base58.mjs';
import { fromHex, toHex, utf8 } from '../sdk/bytes.mjs';
import { sha256 } from '../sdk/sha256.mjs';
import { canonicalExpeditionAccounts, canonicalExpeditionRoles } from './fexpedition-identity.mjs';

export const EXPEDITION_POP = 'expedition-inspect';
export const REQUEST_SCHEMA = 'frontier-original-expedition-request-v1';
export const REPORT_SCHEMA = 'frontier-original-expedition-preview-v1';
export const REPORT_MAX = 64 * 1024;
export const INSPECTION_TIMEOUT_MS = 30_000;
/** frontier-abi wide_ix::WIDE_EXPERIMENTAL_VERSION_BIT (not the NFT bit). */
export const WIDE_VERSION_BIT = 0x4000;
export const inspectionVersion = v => Number.isInteger(v) && v >= 0 && v <= 65535 && (v & WIDE_VERSION_BIT) !== 0;
const CLOSED = ['dispatch_available', 'admitted', 'signed', 'enqueued', 'automatic_send', 'completion_proven', 'history_verified'];
const fail = (code, message = code) => { throw Object.assign(new Error(message), { code }); };
const check = (ok, code) => { if (!ok) fail(code); };
const object = x => !!x && typeof x === 'object' && !Array.isArray(x);
const exact = (x, names) => object(x) && Object.keys(x).length === names.length && names.every(k => Object.hasOwn(x, k));
const hex64 = x => typeof x === 'string' && /^[0-9a-f]{64}$/.test(x);
const address = x => {
  check(typeof x === 'string' && x.length >= 32 && x.length <= 44, 'BadAddress');
  let b; try { b = fromB58(x); } catch { fail('BadAddress'); }
  check(b.length === 32 && b.some(x => x !== 0) && toB58(b) === x, 'BadAddress');
  return x;
};
const digestOf = x => x instanceof Uint8Array && x.length === 32 ? toHex(x) : hex64(x) ? x : fail('DeploymentPinMissing');
const freeze = x => { if (object(x) || Array.isArray(x)) { for (const v of Object.values(x)) freeze(v); Object.freeze(x); } return x; };
const stable = x => JSON.stringify(x, (_, v) => object(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);

/** Canonical 56-byte full host reference, using public world/host data only. */
export function originalHostRef(world, id) {
  check(hex64(world) && world !== '0'.repeat(64), 'BadWorld');
  const n = parseU64(id, 'BadHost');
  const h = hostParts(n);
  check(!!h && hostId(h) === n, 'BadHost');
  const rp = ringPosition(BigInt(h.p), BigInt(h.q));
  const b = new Uint8Array(56), dv = new DataView(b.buffer);
  b[0] = 1; b.set(fromHex(world), 1);
  dv.setBigUint64(33, rp.ring, false); b[41] = rp.wedge; dv.setBigUint64(42, rp.pos, false);
  b[50] = h.site; b[51] = h.gen; dv.setUint32(52, h.seq, true);
  return toHex(b);
}

/** Freshly resolve the selected ORIGINAL host. Never accept a DOM host or target. */
export function inspectionRequest(fs, { pin } = {}) {
  check(fs.mode === 'play' && !fs.sample && !fs.proto && !fs.wideSelect, 'OriginalHostRequired');
  check(fs.hand?.pop === EXPEDITION_POP && !fs.compose && !fs.report && !fs.practice && !fs.inspectOpen, 'InspectionClosed');
  check(fs.meStatus === 'ready' && fs.meAnswered === true && !!fs.citizen, 'ViewerNotReady');
  check(!fs.resident && !fs.citizen.residentAsset, 'WalletResidentRequired');
  check(!!pin?.addresses && /^[a-z0-9-]{1,32}$/.test(pin.cluster), 'DeploymentPinMissing');
  const program = address(pin.programId), season = address(pin.addresses.season);
  const seasonId = parseU64(String(pin.seasonId), 'BadSeason').toString();
  const derived = seasonAddresses(program, seasonId);
  check(derived.season === season, 'SeasonPinMismatch');
  if (fs.record) check(fs.record.programId === program && fs.record.cluster === pin.cluster
    && String(fs.record.season) === seasonId && fs.record.seasonAddress === season, 'SeasonPinMismatch');
  check(String(fs.season?.seasonId) === seasonId, 'SeasonPinMismatch');
  const version = fs.season?.programVersion;
  check(inspectionVersion(version), 'DeploymentPinMissing');
  const ruleset = digestOf(fs.season?.rulesetHash);
  const wallet = address(fs.wallet?.address);
  const citizen = derived.of('Citizen', { wallet });
  check(pin.addresses.of('Citizen', { wallet }) === citizen, 'CitizenPinMismatch');
  check(fs.citizen.wallet instanceof Uint8Array && toB58(fs.citizen.wallet) === wallet, 'CitizenPinMismatch');
  const sub = subjectOf(fs);
  check(sub?.kind === 'host' || sub?.kind === 'village', 'OriginalHostRequired');
  const h = sub.holding;
  let id;
  if (sub.kind === 'host') id = sub.host.id;
  else {
    const seq = parseU64(fs.expeditionPreview?.sequence, 'BadHostSequence');
    // Holding.HOST_SEQ is the next u32 sequence to issue, reset on capture.
    // Zero is a valid first host. This identifies a request, not a live host.
    check(seq <= 0xffffffffn && Number.isInteger(h.hostSeq) && h.hostSeq >= 0 && h.hostSeq <= 0xffffffff && seq < BigInt(h.hostSeq), 'UnissuedHostSequence');
    check(Number.isInteger(h.gen) && h.gen >= 0 && h.gen <= 255, 'HoldingChanged');
    id = hostId({ p: h.p, q: h.q, site: h.site, gen: h.gen, seq: Number(seq) }).toString();
  }
  const parts = hostParts(parseU64(id, 'BadHost'));
  check(parts && hostId(parts).toString() === id, 'BadHost');
  // The selected host can be from another owned village on the same tile.
  // Its freshly resolved issuer is authoritative for this query, not the rail.
  check(fs.holdings?.[sub.holdingIndex] === h, 'HoldingChanged');
  check(parts.p === h.p && parts.q === h.q && parts.site === h.site && parts.gen === h.gen, 'HoldingChanged');
  check(h.state === 1 || h.state === 2, 'HoldingChanged');
  check(String(h.seasonId) === seasonId && (sub.kind !== 'host' || String(sub.host.province.seasonId) === seasonId), 'SeasonPinMismatch');
  check(h.ownerCitizen instanceof Uint8Array && toB58(h.ownerCitizen) === citizen, 'CitizenPinMismatch');
  const p = fs.expeditionPreview?.p, q = fs.expeditionPreview?.q;
  check(ringPosition(parseWideInt(p), parseWideInt(q)).ring > 128n, 'WideCoordinateRequired');
  return freeze({ schema: REQUEST_SCHEMA, operation: 'inspect', cluster: pin.cluster, program, season,
    deployment: { program_version: String(version), ruleset_hash: ruleset },
    host: originalHostRef(worldIdOf(season, program), id), original_owner: citizen,
    standing: { p, q }, min_slot: '0', wallet, payer: wallet });
}

export function requestDigest(r) {
  return toHex(sha256(utf8(`${REQUEST_SCHEMA}\n${[r.operation, r.cluster, r.program, r.season, r.deployment.program_version,
    r.deployment.ruleset_hash, r.host, r.original_owner, r.standing.p, r.standing.q, r.min_slot, r.wallet ?? '', r.payer ?? ''].join('\n')}\n`)));
}

/** Refuse reports that change the request or imply admission/completion. */
export function inspectionReport(value, request) {
  check(exact(value, ['schema', 'status', 'stage', 'request_digest', 'scope', 'source', 'blocker', 'facts', 'draft', 'draft_blocker', ...CLOSED]) && JSON.stringify(value).length <= REPORT_MAX, 'BadInspectionReport');
  check(value.schema === REPORT_SCHEMA && ['preview', 'blocked'].includes(value.status), 'BadInspectionReport');
  check(CLOSED.every(k => value[k] === false), 'UnsafeInspectionReport');
  check(stable(value.scope) === stable(request) && value.request_digest === requestDigest(request), 'InspectionScopeMismatch');
  const s = value.source;
  check(exact(s, ['kind', 'read_calls', 'coherent', 'single_response', 'context_slot', 'digest', 'authority_verified', 'freshness', 'complete_world_view']) && s.kind === 'single_snapshot_source' && ['0', '1'].includes(s.read_calls)
    && typeof s.coherent === 'boolean' && typeof s.single_response === 'boolean' && s.authority_verified === false
    && s.freshness === 'unknown' && s.complete_world_view === false, 'BadInspectionSource');
  if (s.context_slot !== null) parseU64(s.context_slot, 'BadInspectionSource');
  check(s.digest === null || hex64(s.digest), 'BadInspectionSource');
  check(s.coherent ? s.single_response && s.read_calls === '1' && s.context_slot !== null && s.digest !== null
    && BigInt(s.context_slot) >= parseU64(request.min_slot) : !s.single_response && s.context_slot === null && s.digest === null, 'BadInspectionSource');
  check(['request', 'arguments', 'runtime', 'snapshot', 'plan', 'output'].includes(value.stage) && (value.stage !== 'plan' || s.coherent), 'BadInspectionReport');
  check(value.blocker === null || ((exact(value.blocker, ['code']) || exact(value.blocker, ['code', 'field']))
    && /^[A-Za-z][A-Za-z0-9]{0,119}$/.test(value.blocker.code) && (value.blocker.field === undefined || /^[a-z_]{1,40}$/.test(value.blocker.field))), 'BadInspectionReport');
  check(value.draft_blocker === null || ['NoResidentDraftAtThisStage', 'PayerProposalRequired', 'WalletProposalRequired', 'WalletCitizenMismatch', 'DraftAccountContract'].includes(value.draft_blocker), 'BadInspectionReport');
  if (value.status === 'blocked') {
    check(value.blocker !== null && value.facts === null && value.draft === null && value.draft_blocker === null, 'BadInspectionReport');
  } else {
    check(value.stage === 'plan' && s.coherent && value.blocker === null, 'BadInspectionReport');
    inspectionFacts(value.facts, request, s);
    check((value.draft === null) !== (value.draft_blocker === null), 'BadInspectionDraft');
  }
  const d = value.draft;
  if (d !== null) {
    check(exact(d, ['kind', 'action', 'roles', 'dispatch_available', 'admitted']) && d.kind === 'closed-resident-role-draft' && ['Dissolve', 'Return'].includes(d.action)
      && d.dispatch_available === false && d.admitted === false && Array.isArray(d.roles) && d.roles.length <= 16, 'BadInspectionDraft');
    check(value.facts.next_prerequisite === (d.action === 'Dissolve' ? 'OwnerDissolve' : 'ReturnOriginalReserve'), 'BadInspectionDraft');
    check(stable(d.roles) === stable(canonicalExpeditionRoles(request, d.action)), 'BadInspectionDraft');
  }
  return freeze(JSON.parse(JSON.stringify(value)));
}

const NEXT = ['OriginalDepartureResolution', 'OriginalDepartureSettlement', 'RevealOrGatherEvidence', 'OriginDestroyedSettlementOrCleanupEvidence', 'DestinationResolveOrSettlementEvidence', 'OwnerDissolve', 'ResolveVoluntaryLeave', 'ReturnOriginalReserve'];
const DENIALS = ['OriginalHostDispatchUnavailable', 'SourceProvenanceUnverified', 'HistoryUnverified', 'ExecutionEvidenceUnverified', 'SignerAbsent', 'SliceDoesNotEnqueue', 'WalletAuthorizationAndPlayerPrologueUnverified', 'SnapshotCurrencyUnknown', 'NoCoherentSnapshot'];
function inspectionFacts(f, request, source) {
  check(exact(f, ['key', 'kind', 'host', 'standing_key', 'original_owner', 'accounts', 'next_prerequisite', 'observed',
    'min_slot', 'context_slot', 'clock', 'coherent', 'provenance_verified', 'history_verified', 'dispatch_available', 'tag', 'instruction',
    'admitted', 'signed', 'enqueued', 'automatic_send', 'completion_proven', 'denials']), 'BadInspectionFacts');
  check(CLOSED.every(k => f[k] === false) && f.provenance_verified === false && f.tag === null && f.instruction === null
    && f.kind === 'original-expedition-review' && f.host === request.host && f.original_owner === request.original_owner
    && f.min_slot === request.min_slot && f.context_slot === source.context_slot && f.coherent === true && NEXT.includes(f.next_prerequisite), 'BadInspectionFacts');
  const canonical = canonicalExpeditionAccounts(request);
  check(f.standing_key === canonical.standing_key && stable(f.accounts) === stable(canonical.accounts)
    && f.key === `original-expedition-review:${request.host}:${canonical.standing_key}:${request.original_owner}`, 'BadInspectionFacts');
  check(Array.isArray(f.denials) && f.denials.length <= DENIALS.length && f.denials.every(x => DENIALS.includes(x))
    && DENIALS.slice(0, 6).every(x => f.denials.includes(x)) && f.denials.includes('SnapshotCurrencyUnknown'), 'BadInspectionFacts');
  const u32 = x => parseU64(x, 'BadInspectionFacts') <= 0xffffffffn;
  check(exact(f.clock, ['slot', 'unix_timestamp', 'bell', 'status_promoted_by_clock']) && u32(f.clock.bell)
    && typeof f.clock.status_promoted_by_clock === 'boolean', 'BadInspectionFacts');
  check(f.clock.slot === source.context_slot, 'BadInspectionFacts');
  parseU64(f.clock.slot, 'BadInspectionFacts');
  check(parseWideInt(f.clock.unix_timestamp, { bound: 1n << 63n, code: 'BadInspectionFacts' }) < (1n << 63n), 'BadInspectionFacts');
  const o = f.observed, byte = x => Number.isInteger(x) && x >= 0 && x <= 255;
  if (o?.kind === 'owned-bridge-v2') {
    check(exact(o, ['kind', 'slot', 'state', 'depart_bell', 'arrive_bell', 'destination_bound']) && byte(o.slot) && o.slot < 4
      && ['Free', 'Departed', 'Settled', 'DestroyedAtOrigin', 'Gathered'].includes(o.state) && u32(o.depart_bell) && u32(o.arrive_bell)
      && typeof o.destination_bound === 'boolean', 'BadInspectionFacts');
  } else {
    check(exact(o, ['kind', 'entry', 'state', 'unit', 'troops_milli', 'pending_bell', 'resolved_next', 'return_units', 'reserve_after'])
      && o.kind === 'original-host-wide-resident' && byte(o.entry) && byte(o.state) && byte(o.unit) && o.unit < 8
      && ['troops_milli', 'pending_bell', 'resolved_next'].every(k => u32(o[k]))
      && (o.return_units === null || u32(o.return_units)) && (o.reserve_after === null || u32(o.reserve_after)), 'BadInspectionFacts');
  }
}

const runs = new WeakMap();
const runOf = fs => { if (!runs.has(fs)) runs.set(fs, { generation: 0, abort: null, capture: null }); return runs.get(fs); };
/** Invalidate BEFORE changing any viewer, source, selection, input or open card. */
export function clearInspection(fs, { keepInputs = false } = {}) {
  clearPreparation(fs);
  const run = runOf(fs); ++run.generation; run.abort?.abort(); run.abort = null; run.capture = null;
  const old = fs.expeditionPreview;
  fs.expeditionPreview = { p: keepInputs ? old?.p ?? '' : '', q: keepInputs ? old?.q ?? '' : '', sequence: keepInputs ? old?.sequence ?? '' : '', status: 'idle', request: null, report: null, error: null };
}
export function inspectionInput(fs, name, value) {
  if (!['expedition-p', 'expedition-q', 'expedition-sequence'].includes(name)) return false;
  clearInspection(fs, { keepInputs: true });
  fs.expeditionPreview[name.slice('expedition-'.length)] = String(value);
  return true;
}
const identities = (fs, ctx) => [fs.wallet, fs.resident, fs.session, fs.session?.publicKey, ctx.source, ctx.relay,
  fs.mode, fs.selected?.p, fs.selected?.q, fs.selected?.idx, fs.hand?.host, fs.activeHolding ?? 0, fs.expeditionPreview?.sequence];
const capture = (fs, ctx) => ({ request: inspectionRequest(fs, ctx), identities: identities(fs, ctx) });
const current = (fs, ctx, expected) => {
  try { const now = capture(fs, ctx); return stable(now.request) === stable(expected.request) && now.identities.every((x, i) => x === expected.identities[i]); }
  catch { return false; }
};
/** Called on render as well as lifecycle transitions so stale finished reports disappear. */
export function reconcileInspection(fs, context) {
  const run = runOf(fs);
  if (run.capture && !current(fs, context, run.capture)) { clearInspection(fs, { keepInputs: fs.hand?.pop === EXPEDITION_POP }); return false; }
  return true;
}

/** One bounded, abortable read. No relay-info, action admission or transaction path. */
export async function readInspection(request, { relay, signal, isCurrent = () => true, fetch: fetcher = (...a) => globalThis.fetch(...a), timeoutMs = INSPECTION_TIMEOUT_MS, path = '/f/expedition/preview' } = {}) {
  check(['/f/expedition/preview', '/f/expedition/prepare'].includes(path), 'BadInspectionPath');
  check(typeof relay === 'string' && !!relay, 'NoRelay');
  check(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= INSPECTION_TIMEOUT_MS, 'BadInspectionTimeout');
  const abort = new AbortController(); let timedOut = false, reader = null, completed = false;
  const cancel = () => abort.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  const alive = () => { if (timedOut) fail('InspectionTimeout'); if (signal?.aborted || abort.signal.aborted || !isCurrent()) fail('InspectionSuperseded'); };
  let rejectDeadline;
  const deadline = new Promise((_, reject) => { rejectDeadline = reject; });
  const timer = setTimeout(() => { timedOut = true; abort.abort(); rejectDeadline(Object.assign(new Error('InspectionTimeout'), { code: 'InspectionTimeout' })); }, timeoutMs);
  try {
    alive();
    const response = await Promise.race([fetcher(`${relay.replace(/\/+$/, '')}${path}`, {
      method: 'POST', cache: 'no-store', signal: abort.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request),
    }), deadline]);
    alive();
    check(!!response.body?.getReader, 'BadInspectionReport');
    reader = response.body.getReader();
    const length = response.headers?.get?.('content-length');
    check(length === null || length === undefined || (/^\d+$/.test(length) && Number(length) <= REPORT_MAX), 'InspectionReportTooLarge');
    const chunks = []; let size = 0;
    for (;;) {
      const part = await Promise.race([reader.read(), deadline]); alive();
      if (part.done) break;
      size += part.value.byteLength; check(size <= REPORT_MAX, 'InspectionReportTooLarge'); chunks.push(part.value);
    }
    const bytes = new Uint8Array(size); let at = 0;
    for (const c of chunks) { bytes.set(c, at); at += c.byteLength; }
    let body; try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { fail('BadInspectionReport'); }
    if (!response.ok) fail(typeof body?.code === 'string' && /^[A-Za-z0-9]{1,80}$/.test(body.code) ? body.code : `HTTP${response.status}`);
    completed = true; return body;
  } catch (e) { if (timedOut) fail('InspectionTimeout'); throw e; }
  finally {
    clearTimeout(timer); signal?.removeEventListener('abort', cancel);
    if (!completed) { abort.abort(); if (reader) reader.cancel().catch(() => {}); }
    reader?.releaseLock();
  }
}

/** Repeated requests supersede earlier ones even when abort is ignored. */
export async function inspectExpedition(fs, { context, read = readInspection, changed = () => {} } = {}) {
  clearInspection(fs, { keepInputs: true });
  const run = runOf(fs), generation = run.generation;
  let snap;
  try { snap = capture(fs, context()); } catch (e) {
    fs.expeditionPreview.status = 'error'; fs.expeditionPreview.error = e.code ?? 'InspectionUnavailable'; changed(); return;
  }
  run.capture = snap; run.abort = new AbortController();
  const isCurrent = () => generation === run.generation && current(fs, context(), snap);
  fs.expeditionPreview.status = 'loading'; changed();
  try {
    const answer = await read(snap.request, { relay: context().relay, signal: run.abort.signal, isCurrent });
    if (!isCurrent()) { if (generation === run.generation) { clearInspection(fs, { keepInputs: true }); changed(); } return; }
    const report = inspectionReport(answer, snap.request);
    if (!isCurrent()) return;
    fs.expeditionPreview.request = snap.request;
    fs.expeditionPreview.report = report; fs.expeditionPreview.status = report.status;
  } catch (e) {
    if (!isCurrent()) { if (generation === run.generation) { clearInspection(fs, { keepInputs: true }); changed(); } return; }
    fs.expeditionPreview.status = 'error'; fs.expeditionPreview.error = e.code ?? 'InspectionUnavailable';
  } finally { if (generation === run.generation) { run.abort = null; changed(); } }
}
