// Original boundary draft and captured-land observations. No sealing, signing or send.
import { subjectOf } from './hud/subject.mjs';
import { hostParts, hostId, seasonAddresses } from './faddr.mjs';
import { parseU64, ringPosition, worldIdOf } from './map/wide.mjs';
import { encode, decode } from '../sdk/base58.mjs';
import { toHex } from '../sdk/bytes.mjs';
import { inspectionVersion, originalHostRef } from './fexpedition.mjs';
import { prepareOriginalOutboundPlain, traceWideDirections } from './fexpedition-seal.mjs';
import { RETREAT_CHOICES, retreatBps, tipOptions, departMargin } from './fmarch.mjs';
import { canonicalOutboundRoles } from './fexpedition-depart.mjs';
import { DIRECTIONS } from './fgeo.mjs';
import { outboundHitDirection, outboundMapGeometry } from './map/outboundroute.mjs';
import { loadOutboundRouteCaptures } from './fexpedition-route-read.mjs';
import { evaluateOutboundRoute } from './fexpedition-route.mjs';
import { readOutboundSnapshot } from './fexpedition-context.mjs';
import { evaluateOriginalOutboundReady } from './fexpedition-ready.mjs';

export const OUTBOUND_POP = 'expedition-compose';
export const OUTBOUND_CLOSED = Object.freeze({ dispatch_available: false, executable: false, admitted: false,
  sealed: false, seal_verified: false, public_dispatch_available: false, signed: false, enqueued: false, automatic_send: false, completion_proven: false });
const check = (ok, code) => { if (!ok) throw Object.assign(new Error(code), { code }); };
const stable = x => JSON.stringify(x, (_, v) => typeof v === 'bigint' ? v.toString() : v instanceof Uint8Array ? toHex(v) : v);
const publicAddress = x => {
  check(typeof x === 'string' && x.length >= 32 && x.length <= 44, 'DeploymentPinMissing');
  let b; try { b = decode(x); } catch { check(false, 'DeploymentPinMissing'); }
  check(b.length === 32 && b.some(x => x !== 0) && encode(b) === x, 'DeploymentPinMissing'); return x;
};
const snapshots = new WeakMap();
const routeReads = new WeakMap();
const contextReads = new WeakMap();
const cancelRouteRead = fs => { for (const reads of [routeReads, contextReads]) { reads.get(fs)?.abort(); reads.delete(fs); } };
// What each finished observation was read for (the draft's source and steps), kept beside it and never inside it:
// an arrival candidate is taken only from an observation still bound to the draft as it stands.
const observed = new WeakMap();
// (what an observation is of: this source, these steps, and the clock as the page had seen it when the read began)
const bindingOf = (source, directions, seen) => stable([source, directions, seen]);
const u32 = x => Number.isInteger(x) && x >= 0 && x <= 0xffffffff;
/** Report codes that leave the route itself sound: only the entered arrival turn is missing or outside the range. */
// (ArrivalAfterSeason too: fexpedition-route.mjs works the range out before it answers so, and a turn entered too far
// ahead must be able to come back to the earliest one)
const ARRIVAL_ONLY = Object.freeze(['ArrivalRequired', 'ArrivalTooEarly', 'ArrivalTooLate', 'ArrivalAfterSeason']);
// The draft's revision: moved by every rebuild and every clear. A press that waits on a read is the same press at
// its end only while this has not moved.
const revisions = new WeakMap();
const bump = fs => revisions.set(fs, (revisions.get(fs) ?? 0) + 1);
const empty = () => ({ directions: [], arriveBell: '', stance: 0, retreat: 'never', ratio: '', tip: 'standard',
  status: 'idle', source: null, trace: null, map: null, review: null, routeCheck: null, contextCheck: null, error: null, ...OUTBOUND_CLOSED });

/** Resolve a currently observed, owned original resident, never an inferred village sequence. */
export function outboundSource(fs, { pin } = {}) {
  check(fs.mode === 'play' && !fs.sample && !fs.proto && !fs.wideSelect, 'OriginalHostRequired');
  check(fs.hand?.pop === OUTBOUND_POP && !fs.compose && !fs.report && !fs.practice && !fs.inspectOpen, 'OutboundClosed');
  check(fs.meStatus === 'ready' && fs.meAnswered === true && !!fs.citizen, 'ViewerNotReady');
  check(!fs.resident && !fs.citizen.residentAsset, 'WalletResidentRequired');
  check(!!pin?.addresses && /^[a-z0-9-]{1,32}$/.test(pin.cluster), 'DeploymentPinMissing');
  const program = publicAddress(pin.programId), season = publicAddress(pin.addresses.season);
  const seasonId = parseU64(String(pin.seasonId), 'SeasonPinMismatch').toString();
  const addresses = seasonAddresses(program, seasonId);
  check(addresses.season === season && String(fs.season?.seasonId) === seasonId, 'SeasonPinMismatch');
  if (fs.record) check(fs.record.programId === program && fs.record.cluster === pin.cluster
    && String(fs.record.season) === seasonId && fs.record.seasonAddress === season, 'SeasonPinMismatch');
  check(inspectionVersion(fs.season?.programVersion), 'DeploymentPinMissing');
  const ruleset = fs.season.rulesetHash instanceof Uint8Array ? toHex(fs.season.rulesetHash) : fs.season.rulesetHash;
  check(typeof ruleset === 'string' && /^[0-9a-f]{64}$/.test(ruleset), 'DeploymentPinMissing');
  const wallet = publicAddress(fs.wallet?.address), owner = addresses.of('Citizen', { wallet });
  check(pin.addresses.of('Citizen', { wallet }) === owner && fs.citizen.wallet instanceof Uint8Array
    && encode(fs.citizen.wallet) === wallet, 'CitizenPinMismatch');
  const sub = subjectOf(fs);
  check(sub?.kind === 'host', 'OriginalHostRequired');
  const h = sub.holding, r = sub.host, parts = hostParts(parseU64(r.id, 'BadHost'));
  check(parts && hostId(parts).toString() === r.id && fs.holdings?.[sub.holdingIndex] === h, 'HoldingChanged');
  check(['p', 'q', 'site', 'gen'].every(k => parts[k] === h[k]) && (h.state === 1 || h.state === 2), 'HoldingChanged');
  check(Number.isInteger(h.hostSeq) && h.hostSeq <= 0xffffffff && parts.seq < h.hostSeq, 'UnissuedHostSequence');
  check(String(h.seasonId) === seasonId && String(r.province.seasonId) === seasonId, 'SeasonPinMismatch');
  check(h.ownerCitizen instanceof Uint8Array && encode(h.ownerCitizen) === owner, 'CitizenPinMismatch');
  check(r.province.p === r.p && r.province.q === r.q, 'OriginalOriginRequired');
  const residents = [...(fs.provinces?.values?.() ?? [])].flatMap(e => e.province?.entries ?? [])
    .filter(e => e.state >= 1 && e.state <= 3 && String(e.id) === r.id);
  check(residents.length === 1 && residents[0] === r.entry, 'ResidentHostRequired');
  check(r.state === 1 && !r.pending && !r.inTransit && r.province.entries.includes(r.entry), 'ResidentHostRequired');
  check(Number.isInteger(r.p) && Number.isInteger(r.q) && ringPosition(BigInt(r.p), BigInt(r.q)).ring <= 128n, 'OriginalOriginRequired');
  const world = worldIdOf(season, program);
  return { program, season, seasonId, cluster: pin.cluster, wallet, payer: wallet, original_owner: owner, world,
    unit: r.unit, faction: r.entry.faction, holdingFlags: h.flags,
    host: originalHostRef(world, r.id), hostId: r.id, origin: { p: String(r.p), q: String(r.q), tile: r.tile },
    home: { p: String(h.p), q: String(h.q), site: h.site, gen: h.gen, seq: parts.seq },
    holding: addresses.of('Holding', h), issuance: h.hostSeq, programVersion: fs.season.programVersion, ruleset,
    // Raw observation, not time-derived stamina: unchanged polling must preserve the draft.
    resident: stable(r.entry), transit: stable(h.transit),
    transitSlot: Array.isArray(h.transit) && h.transit.length === 4 && h.transit.every(t => Number.isInteger(t.state) && t.state >= 0 && t.state <= 3)
      ? (h.transit.findIndex(t => t.state === 0) < 0 ? null : h.transit.findIndex(t => t.state === 0)) : null,
    seasonFacts: stable(['genesisTs', 'endBell', 'minRevealPriorityMilli', 'revealCuLimit', 'revealLoadedLimit', 'marchFee', 'sealBond',
      'drandGenesis', 'drandPeriod', 'seedMargin', 'revealWindow', 'windowFromBell', 'windowNext', 'quicknetPkHash',
      'status', 'minLead', 'maxLead', 'stances'].map(k => fs.season[k])),
    // The clock's SETTINGS are part of what the draft is bound to: another season schedule (`fs.clock`), or another
    // policy of the chain's clock (accelerated, declared), is another source, and the draft is dropped. What the
    // clock has been OBSERVED to say is not (outboundClockSeen): the turn, the last slot and its time, and the
    // measured rate move with every ordinary poll of the same host, owner and connection.
    clockConfig: stable({ clock: fs.clock ?? null, accelerated: fs.chain?.accelerated ?? null, declared: fs.chain?.declared ?? null }) };
}
/**
 * What the clock has been observed to say, as the page has it now: the turn, the last observed slot and its time,
 * and the measured rate. Not part of the draft's source. Everything OBSERVED or WORKED OUT for the draft (the route
 * read, the departure-conditions read, the review) is of the clock it was made under: when this moves FORWARD they
 * are dropped and the review is worked out again from the same source (reconcileOutbound), so a departure is read
 * and reviewed again before anything is signed; the steps and the fields the player entered are kept. A clock that
 * goes BACKWARD (an earlier turn, slot or time, or one that is no longer known) is not this draft's clock at all:
 * the draft is dropped, as for any other change of source.
 */
export function outboundClockSeen(fs) {
  const last = fs.chain?.last ?? null, rate = fs.chain?.rate ?? null, bell = fs.nowBell ?? null;
  // Checked before it is written down or compared: a value that is not a clock reading is refused even when it
  // has not changed. Not yet observed (no turn, no `last`, no rate) is a reading of its own, and a legitimate one.
  check(bell === null || (Number.isInteger(bell) && bell >= 0 && bell <= 0xffffffff), 'OutboundClockInvalid');
  check(rate === null || (typeof rate === 'number' && Number.isFinite(rate) && rate > 0), 'OutboundClockInvalid');
  let slot = null, unix = null;
  if (last !== null) {
    check(typeof last === 'object', 'OutboundClockInvalid');
    const sl = last.slot, un = last.unix;
    // the slot: a whole, non-negative u64 (a number only while it is a safe integer; a text only in its canonical form)
    if (typeof sl === 'number') check(Number.isSafeInteger(sl) && sl >= 0, 'OutboundClockInvalid');
    else if (typeof sl === 'bigint') check(sl >= 0n && sl <= 0xffffffffffffffffn, 'OutboundClockInvalid');
    else check(typeof sl === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(sl) && BigInt(sl) <= 0xffffffffffffffffn, 'OutboundClockInvalid');
    slot = BigInt(sl).toString();
    // its time: a finite, non-negative number (seconds; it may carry a fraction), or a whole non-negative one as a BigInt
    if (typeof un === 'bigint') { check(un >= 0n && un <= BigInt(Number.MAX_SAFE_INTEGER), 'OutboundClockInvalid'); unix = Number(un); }
    else { check(typeof un === 'number' && Number.isFinite(un) && un >= 0, 'OutboundClockInvalid'); unix = un; }
  }
  return stable({ nowBell: bell, slot, unix, rate });
}
/** outboundClockSeen, or null when the page's clock is not a clock reading (a guard that compares: never equal to a reading). */
const clockSeenNow = fs => { try { return outboundClockSeen(fs); } catch { return null; } };
/** 'same' | 'forward' | 'backward' of two outboundClockSeen texts (both already checked; the rate has no direction: another rate is forward). */
function clockMove(before, next) {
  if (before === next) return 'same';
  const a = JSON.parse(before), b = JSON.parse(next);
  for (const k of ['nowBell', 'slot', 'unix']) {
    if (a[k] === null) continue;                       // (not observed before: observed now is forward)
    if (b[k] === null) return 'backward';              // (observed before, not any more)
    if (k === 'slot' ? BigInt(b[k]) < BigInt(a[k]) : b[k] < a[k]) return 'backward';
  }
  return 'forward';
}
const identities = (fs, ctx) => [fs.wallet, fs.resident, fs.session, fs.session?.publicKey, fs.chain, ctx.source, ctx.relay,
  fs.mode, fs.selected?.p, fs.selected?.q, fs.selected?.idx, fs.hand?.host, fs.activeHolding ?? 0];
const capture = (fs, ctx) => ({ source: outboundSource(fs, ctx), identities: identities(fs, ctx), seen: outboundClockSeen(fs) });
export function clearOutbound(fs) { cancelRouteRead(fs); snapshots.delete(fs); bump(fs); fs.expeditionCompose = empty(); }
export function reconcileOutbound(fs, ctx) {
  const before = snapshots.get(fs); if (!before) return true;
  try {
    const next = capture(fs, ctx);
    if (stable(next.source) === stable(before.source) && next.identities.every((x, i) => x === before.identities[i])) {
      // The same host, owner, wallet, session, connection, season and clock settings. Only the clock has run on
      // (an ordinary poll): the draft stands, with its steps and fields; what was observed and reviewed under the
      // earlier clock does not. `rebuild` cancels any read under way, drops both observations, moves the draft's
      // revision (a press that was waiting is no longer this draft's) and works the review out again.
      const move = clockMove(before.seen, next.seen);
      if (move === 'same') return true;
      if (move === 'forward') { rebuild(fs, ctx); return true; }
      // (backward: not this draft's clock; fail closed below)
    }
  } catch { /* The selected source disappeared or its pins changed. */ }
  clearOutbound(fs); fs.expeditionCompose.error = 'SourceChanged'; return false;
}
function rebuild(fs, ctx) {
  cancelRouteRead(fs); bump(fs);
  const s = fs.expeditionCompose;
  s.routeCheck = null;
  s.contextCheck = null;
  s.review = null; s.trace = null; s.map = null; s.error = null; s.status = 'preparing';
  try {
    const snap = capture(fs, ctx); snapshots.set(fs, snap); s.source = snap.source;
    s.map = outboundMapGeometry(s.source, s.directions);
    if (!s.directions.length) { s.error = 'ChooseSteps'; return; }
    s.trace = traceWideDirections({ world: s.source.world, origin: s.source.origin, directions: s.directions });
    check(ringPosition(BigInt(s.trace.endpoint.p), BigInt(s.trace.endpoint.q)).ring > 128n, 'WideDestinationRequired');
    check(typeof s.arriveBell === 'string' && /^(0|[1-9][0-9]{0,9})$/.test(s.arriveBell)
      && BigInt(s.arriveBell) <= 0xffffffffn, 'ArrivalRequired');
    if (s.retreat === 'custom') check(/^(0|[1-9][0-9]?)(\.[0-9]{1,4})?$/.test(s.ratio), 'Retreat');
    const retreat = retreatBps(s.retreat, s.ratio); check(retreat !== null, 'Retreat');
    const tips = tipOptions(fs.season), tip = tips.find(x => x.id === s.tip); check(!!tip, 'Tip');
    const plain = prepareOriginalOutboundPlain({ program: s.source.program, season: s.source.season,
      host: s.source.host, origin: s.source.origin, directions: s.directions,
      arriveBell: Number(s.arriveBell), stance: s.stance, retreatBps: retreat });
    let roles = null;
    try { if (s.source.transitSlot !== null) roles = canonicalOutboundRoles(s.source, { transitSlot: s.source.transitSlot }); } catch { /* Roles remain unavailable, never fabricated. */ }
    s.review = Object.freeze({ ...plain, tip: Object.freeze({ id: tip.id, lamports: tip.lamports.toString() }),
      roles, transitSlot: roles ? s.source.transitSlot : null, blockers: Object.freeze(['RouteLandUnverified', 'ArrivalTravelUnverified', 'CoherentClockMissing',
        'SourceObservationUnverified', ...(roles ? ['TransitSlotObservationUnverified'] : ['CanonicalRolesUnavailable']), 'PublicDispatchClosed']), ...OUTBOUND_CLOSED });
    s.status = 'review';
  } catch (e) { s.error = e.code ?? 'OutboundUnavailable'; }
}
export function openOutbound(fs, ctx) { clearOutbound(fs); rebuild(fs, ctx); }
export function editOutbound(fs, ctx, action, value) {
  if (fs.hand?.pop !== OUTBOUND_POP || !reconcileOutbound(fs, ctx)) return false;
  const s = fs.expeditionCompose;
  if (!s?.source) return false;
  if (action === 'step') {
    if (!/^[0-5]$/.test(String(value))) return false;
    if (s.directions.length >= 32) { s.error = 'PathTooLong'; return false; }
    const directions = [...s.directions, Number(value)];
    // Refuse a fifth entered province without replacing the last sound geometric route.
    try { traceWideDirections({ world: s.source.world, origin: s.source.origin, directions }); }
    catch (e) { s.review = null; s.error = e.code ?? 'RouteGeometry'; return false; }
    s.directions = directions;
  } else if (action === 'undo') s.directions = s.directions.slice(0, -1);
  else if (action === 'reset') s.directions = [];
  else if (action === 'arriveBell') s.arriveBell = String(value);
  else if (action === 'stance' && /^[0-3]$/.test(String(value))) s.stance = Number(value);
  else if (action === 'retreat' && RETREAT_CHOICES.some(x => x.id === value)) s.retreat = value;
  else if (action === 'ratio') s.ratio = String(value);
  else if (action === 'tip' && ['standard', 'decisive', 'maximum'].includes(value)) s.tip = value;
  else return false;
  rebuild(fs, ctx); return true;
}
/** The real canvas owns every tap while this card is open, including refusals.
 * It must not change the selected source, pick another host or fall into March. */
export function tapOutbound(fs, ctx, hit) {
  if (fs.hand?.pop !== OUTBOUND_POP) return { handled: false, changed: false, code: null };
  if (!reconcileOutbound(fs, ctx) || !fs.expeditionCompose?.source) return { handled: true, changed: false, code: 'SourceChanged' };
  const s = fs.expeditionCompose;
  try {
    const direction = outboundHitDirection(s.source, s.directions, hit);
    if (direction === null) return { handled: true, changed: false, code: 'EndpointSelected' };
    const changed = editOutbound(fs, ctx, 'step', direction);
    return { handled: true, changed, code: changed ? null : s.error ?? 'RouteGeometry' };
  } catch (e) {
    s.error = e.code ?? 'MapTileRequired';
    return { handled: true, changed: false, code: s.error };
  }
}
/** Revalidate before exposing cached presentation, including clock/source swaps. */
export function readOutboundMap(fs, ctx) {
  if (fs.hand?.pop !== OUTBOUND_POP || !reconcileOutbound(fs, ctx)) return null;
  return fs.expeditionCompose?.map ?? null;
}

/** Read actual captured account bytes for this draft, without changing world
 * state or promoting an observation into an executable route. Every edit,
 * source change, close and repeated request cancels the old result. */
export async function inspectOutboundRoute(fs, { context, changed = () => {}, load = loadOutboundRouteCaptures, evaluate = evaluateOutboundRoute } = {}) {
  const ctx = context();
  if (fs.hand?.pop !== OUTBOUND_POP || !reconcileOutbound(fs, ctx)) return;
  const s = fs.expeditionCompose;
  if (!s?.source || !s.directions.length) return;
  cancelRouteRead(fs);
  s.contextCheck = null;
  const controller = new AbortController(); routeReads.set(fs, controller);
  const source = s.source, directions = [...s.directions], seenAtStart = outboundClockSeen(fs);
  const season = fs.season;
  s.routeCheck = { status: 'loading' }; changed();
  let timer;
  const current = () => {
    // (the reconcile FIRST: it is what notices that the clock has moved or the source has changed, and it aborts
    // this read when it has. Only then is this read asked whether it is still the draft's, under the clock it began)
    if (!reconcileOutbound(fs, context())) { changed(); return false; }
    if (routeReads.get(fs) !== controller || fs.expeditionCompose !== s || controller.signal.aborted) return false;
    return clockSeenNow(fs) === seenAtStart;
  };
  try {
    const data = await Promise.race([
      load(ctx.source, source, directions, controller.signal),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('RouteReadTimeout'), { code: 'RouteReadTimeout' })), 12_000); }),
    ]);
    if (!current()) return;
    const now = fs.chain?.now?.();
    check(typeof now === 'number' && Number.isFinite(now) && Number.isSafeInteger(Math.floor(now)) && now >= 0, 'RouteClockUnavailable');
    const departTs = Math.floor(now) + departMargin(fs.chain?.rate);
    const report = evaluate({ source, directions, lands: data.lands, season, departTs,
      arriveBell: /^(0|[1-9][0-9]{0,9})$/.test(s.arriveBell) ? Number(s.arriveBell) : null });
    s.routeCheck = { status: 'read', report, captures: data.captures, unavailable: data.unavailable,
      departTs, snapshot: data.snapshot, observationOnly: true, coherentSnapshotVerified: false, provenanceVerified: false, ...OUTBOUND_CLOSED };
    observed.set(s.routeCheck, bindingOf(source, directions, seenAtStart));
  } catch (e) {
    if (!current()) return;
    s.routeCheck = { status: 'error', code: e.code ?? 'RouteReadUnavailable' };
  } finally {
    clearTimeout(timer);
    if (routeReads.get(fs) === controller) { routeReads.delete(fs); controller.abort(); changed(); }
  }
}

/** Read source, terrain and Clock together through the existing optional
 * keyless inspector. This does not enable a signer, seal or public command. */
export async function inspectOutboundContext(fs, { context, read, changed = () => {}, snapshot = readOutboundSnapshot, judge = evaluateOriginalOutboundReady, evaluate = evaluateOutboundRoute } = {}) {
  const ctx = context();
  if (fs.hand?.pop !== OUTBOUND_POP || !reconcileOutbound(fs, ctx)) return;
  const s = fs.expeditionCompose;
  if (!s?.source || !s.directions.length) return;
  cancelRouteRead(fs); s.routeCheck = null;
  const controller = new AbortController(); contextReads.set(fs, controller);
  const source = s.source, directions = [...s.directions], seenAtStart = outboundClockSeen(fs);
  s.contextCheck = { status: 'loading' }; changed();
  const current = () => {
    // (the reconcile FIRST, as in the route read above)
    if (!reconcileOutbound(fs, context())) { changed(); return false; }
    if (contextReads.get(fs) !== controller || fs.expeditionCompose !== s || controller.signal.aborted) return false;
    return clockSeenNow(fs) === seenAtStart;
  };
  try {
    const observedSlot = fs.chain?.last?.slot ?? 0;
    check(typeof observedSlot !== 'number' || (Number.isSafeInteger(observedSlot) && observedSlot >= 0), 'RouteClockUnavailable');
    const minSlot = parseU64(String(observedSlot)).toString();
    const data = await snapshot(source, directions, { relay: ctx.relay, signal: controller.signal, isCurrent: current, minSlot, read });
    if (!current()) return;
    if (data.status === 'blocked') { s.contextCheck = { status: 'error', code: data.code }; return; }
    const departTs = data.clock.unixTimestamp + BigInt(Math.ceil(departMargin(fs.chain?.rate)));
    const arriveBell = /^(0|[1-9][0-9]{0,9})$/.test(s.arriveBell) ? Number(s.arriveBell) : null;
    const tip = tipOptions(data.season).find(x => x.id === s.tip)?.lamports;
    const ready = judge({ ...data, holding: data.holdingBytes, arriveBell, tip });
    const report = evaluate({ source: data.source, directions, lands: data.lands, season: data.season, departTs, arriveBell });
    s.contextCheck = { status: 'read', ready, report, contextSlot: data.contextSlot, digest: data.digest,
      departTs: departTs.toString(), coherent: data.coherent, contentConsistent: data.contentConsistent,
      observationOnly: true, authorityVerified: false, freshness: 'unknown', ...OUTBOUND_CLOSED };
    observed.set(s.contextCheck, bindingOf(source, directions, seenAtStart));
  } catch (e) {
    if (!current()) return;
    s.contextCheck = { status: 'error', code: e.code ?? 'OutboundSnapshotUnavailable' };
  } finally {
    if (contextReads.get(fs) === controller) { contextReads.delete(fs); controller.abort(); changed(); }
  }
}
/**
 * The earliest arrival turn of the observation shown on the card: `{arriveBell, min, max, from}` (`from`: 'context'
 * for the departure-conditions read, else 'route'). Throws with a code when there is none to offer:
 *   ArrivalCandidateUnavailable  no finished observation, or its route cannot be walked or timed
 *   ArrivalCandidateStale        the observation is not of this draft's source and steps as they stand
 *   ArrivalCandidateInvalid      the observed range is not two turn numbers
 *   ArrivalWindowEmpty           the observed range holds no turn
 * A candidate is a number for the draft's own arrival field. It is not an admitted, sealed or sent departure, and
 * the observation it comes from says nothing of the present.
 */
export function outboundArrivalCandidate(fs) {
  const s = fs.expeditionCompose;
  check(fs.hand?.pop === OUTBOUND_POP && !!s?.source, 'ArrivalCandidateUnavailable');
  const from = s.contextCheck?.status === 'read' ? 'context' : s.routeCheck?.status === 'read' ? 'route' : null;
  check(from !== null, 'ArrivalCandidateUnavailable');
  const seen = from === 'context' ? s.contextCheck : s.routeCheck;
  check(observed.get(seen) === bindingOf(s.source, s.directions, outboundClockSeen(fs)), 'ArrivalCandidateStale');
  const r = seen.report;
  check(!!r && typeof r === 'object' && (r.code === null || r.code === undefined || ARRIVAL_ONLY.includes(r.code)), 'ArrivalCandidateUnavailable');
  check(r.min !== null && r.min !== undefined && r.max !== null && r.max !== undefined, 'ArrivalCandidateUnavailable');
  check(u32(r.min) && u32(r.max), 'ArrivalCandidateInvalid');
  check(r.min <= r.max, 'ArrivalWindowEmpty');
  return Object.freeze({ arriveBell: String(r.min), min: r.min, max: r.max, from });
}

/**
 * One press: put the earliest observed arrival turn into the draft (the same `arriveBell` edit the field makes, so
 * every earlier observation is dropped) and read again the observation it came from, now with that turn. Nothing is
 * sealed, signed or sent; the manual field stays. The answer says how far the press got, about the LOCAL draft only:
 *   {ok: true,  state: 'entered-and-reread', arriveBell, from}   the field holds the turn and the same draft has its
 *                                                                 new observation (which may itself refuse the route)
 *   {ok: false, entered: false, code}                             nothing was entered (code: SourceChanged or an
 *                                                                 ArrivalCandidate… / ArrivalWindowEmpty refusal)
 *   {ok: false, entered, code: 'ArrivalRereadSuperseded', …}      the card was closed, edited or re-sourced while the
 *                                                                 read was under way: this press finished nothing
 *   {ok: false, entered: true, code: 'ArrivalRereadFailed', reason, …}   the field holds the turn; the read failed
 * `ok` never means a departure, an arrival or an admitted order.
 */
export async function useEarliestOutboundArrival(fs, { context, read, changed = () => {}, load, evaluate, snapshot, judge } = {}) {
  const ctx = context();
  if (fs.hand?.pop !== OUTBOUND_POP || !reconcileOutbound(fs, ctx)) { changed(); return { ok: false, entered: false, code: 'SourceChanged' }; }
  let pick;
  try { pick = outboundArrivalCandidate(fs); } catch (e) { return { ok: false, entered: false, code: e.code ?? 'ArrivalCandidateUnavailable' }; }
  if (!editOutbound(fs, ctx, 'arriveBell', pick.arriveBell)) { changed(); return { ok: false, entered: false, code: 'SourceChanged' }; }
  const s = fs.expeditionCompose, revision = revisions.get(fs), bound = bindingOf(s.source, s.directions, outboundClockSeen(fs));
  const { arriveBell, from } = pick;
  changed();
  if (from === 'context') await inspectOutboundContext(fs, { context, read, changed, snapshot, judge, evaluate });
  else await inspectOutboundRoute(fs, { context, changed, load, evaluate });
  // The read is over. Is this still the draft, the revision and the turn of the press?
  const mine = fs.expeditionCompose === s;
  if (fs.hand?.pop !== OUTBOUND_POP || !mine || revisions.get(fs) !== revision || s.arriveBell !== arriveBell) {
    return { ok: false, entered: mine && fs.hand?.pop === OUTBOUND_POP && s.arriveBell === arriveBell, code: 'ArrivalRereadSuperseded', arriveBell, from };
  }
  const again = from === 'context' ? s.contextCheck : s.routeCheck;
  if (again?.status !== 'read' || observed.get(again) !== bound) return { ok: false, entered: true, code: 'ArrivalRereadFailed', reason: again?.code ?? null, arriveBell, from };
  return { ok: true, state: 'entered-and-reread', arriveBell, from };
}

/** Relative local coordinates only: at most 32 steps, never narrow world coordinates. */
export function outboundSketch(directions) {
  const points = [{ q: 0, r: 0 }];
  for (const d of directions) { const prev = points.at(-1), [q, r] = DIRECTIONS[d]; points.push({ q: prev.q + q, r: prev.r + r }); }
  return points;
}
