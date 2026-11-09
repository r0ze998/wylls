// Preparatory geometry only. No planner, sealing worker, signer or transport.
import { subjectOf } from './hud/subject.mjs';
import { hostParts, hostId, seasonAddresses } from './faddr.mjs';
import { parseU64, ringPosition, worldIdOf } from './map/wide.mjs';
import { encode, decode } from '../sdk/base58.mjs';
import { toHex } from '../sdk/bytes.mjs';
import { inspectionVersion, originalHostRef } from './fexpedition.mjs';
import { prepareOriginalOutboundPlain, traceWideDirections } from './fexpedition-seal.mjs';
import { RETREAT_CHOICES, retreatBps, tipOptions } from './fmarch.mjs';
import { canonicalOutboundRoles } from './fexpedition-depart.mjs';
import { DIRECTIONS } from './fgeo.mjs';
import { outboundHitDirection, outboundMapGeometry } from './map/outboundroute.mjs';

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
const empty = () => ({ directions: [], arriveBell: '', stance: 0, retreat: 'never', ratio: '', tip: 'standard',
  status: 'idle', source: null, trace: null, map: null, review: null, error: null, ...OUTBOUND_CLOSED });

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
  return { program, season, cluster: pin.cluster, wallet, payer: wallet, original_owner: owner, world,
    host: originalHostRef(world, r.id), hostId: r.id, origin: { p: String(r.p), q: String(r.q), tile: r.tile },
    home: { p: String(h.p), q: String(h.q), site: h.site, gen: h.gen, seq: parts.seq },
    holding: addresses.of('Holding', h), issuance: h.hostSeq, programVersion: fs.season.programVersion, ruleset,
    // Raw observation, not time-derived stamina: unchanged polling must preserve the draft.
    resident: stable(r.entry), transit: stable(h.transit),
    transitSlot: Array.isArray(h.transit) && h.transit.length === 4 && h.transit.every(t => Number.isInteger(t.state) && t.state >= 0 && t.state <= 3)
      ? (h.transit.findIndex(t => t.state === 0) < 0 ? null : h.transit.findIndex(t => t.state === 0)) : null,
    seasonFacts: stable(['genesisTs', 'endBell', 'minRevealPriorityMilli', 'revealCuLimit', 'revealLoadedLimit', 'marchFee', 'sealBond',
      'drandGenesis', 'drandPeriod', 'seedMargin', 'revealWindow', 'windowFromBell', 'windowNext', 'quicknetPkHash'].map(k => fs.season[k])),
    clockFacts: stable({ nowBell: fs.nowBell ?? null, clock: fs.clock ?? null,
      rate: fs.chain?.rate ?? null, accelerated: fs.chain?.accelerated ?? null, declared: fs.chain?.declared ?? null, last: fs.chain?.last ? { slot: fs.chain.last.slot, unix: fs.chain.last.unix } : null }) };
}
const identities = (fs, ctx) => [fs.wallet, fs.resident, fs.session, fs.session?.publicKey, fs.chain, ctx.source, ctx.relay,
  fs.mode, fs.selected?.p, fs.selected?.q, fs.selected?.idx, fs.hand?.host, fs.activeHolding ?? 0];
const capture = (fs, ctx) => ({ source: outboundSource(fs, ctx), identities: identities(fs, ctx) });
export function clearOutbound(fs) { snapshots.delete(fs); fs.expeditionCompose = empty(); }
export function reconcileOutbound(fs, ctx) {
  const before = snapshots.get(fs); if (!before) return true;
  try {
    const next = capture(fs, ctx);
    if (stable(next.source) === stable(before.source) && next.identities.every((x, i) => x === before.identities[i])) return true;
  } catch { /* The selected source disappeared or its pins changed. */ }
  clearOutbound(fs); fs.expeditionCompose.error = 'SourceChanged'; return false;
}
function rebuild(fs, ctx) {
  const s = fs.expeditionCompose;
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
/** Relative local coordinates only: at most 32 steps, never narrow world coordinates. */
export function outboundSketch(directions) {
  const points = [{ q: 0, r: 0 }];
  for (const d of directions) { const prev = points.at(-1), [q, r] = DIRECTIONS[d]; points.push({ q: prev.q + q, r: prev.r + r }); }
  return points;
}
