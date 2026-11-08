// Strict transport/structural validation only. All game outcomes belong to the Rust host.
// Protocol v4: the village economy and the march on ONE holding, one revision, one simulated clock; ring-129
// provinces opened by the real WideOpenProvince over LOCAL synthetic land records; and (v4) a march to a chosen,
// session-opened province along a host-quoted route (`depart_route REV DIRS`), next to the recorded fixed march.
import { checkEvidence, villageAccountKeys, landChangedKeys, gatedEqual } from './local-evidence.mjs';
import { verifyReceiptChains, chainHeaderFromAccounts, provinceKeyHex, ReceiptError, KIND } from './local-receipts.mjs';
import { walkDirections, provincesEntered } from './local-route.mjs';
import { parseWideInt, ringOfWide } from '../../../permutation-server/web/frontier/map/wide.mjs';
export const PROTOCOL = 'wylls-local-march-v4';
export const SESSION = 'integrated-economy-march-same-holding';
export const MAX_COMMAND_BYTES = 128, MAX_REPLY_BYTES = 1048576;
export const HOST_REL_PATH = Object.freeze(['.local','wide-march-demo','target','debug','examples','local_march_demo']);
export const PHASES = Object.freeze(['ready','departed','travelling','revealed','resolved','settled','returned']);
export const STEPS = Object.freeze(['depart','settle_departure','post_reveal','resolve_arrival','settle_transit','dissolve_return']);
export const ECONOMY = Object.freeze(['harvest','build_farm','train']);
export const COMMANDS = Object.freeze([...STEPS, ...ECONOMY]);
/** The longest chosen path a route quote or a chosen departure accepts (the legacy march limit). */
export const MAX_ROUTE_DIRS = 32;
/** A valid chosen-path string: 1..=32 directions, each 0..5. */
export const routeDirsOk = s => typeof s === 'string' && s.length >= 1 && s.length <= MAX_ROUTE_DIRS && /^[0-5]+$/.test(s);
/** Fixed session constants the host must report exactly (protocol document); the browser never chooses them. */
export const FIXED = Object.freeze({ perInstantBudget: 8, farmItem: 0, trainUnit: 0, trainCount: 10, finalBell: 25, destinationPreparedThroughBell: 19, maxRouteDirs: MAX_ROUTE_DIRS });
/** The persistent image bound of the demo (land_bootstrap.rs MAX_TOTAL_IMAGES): every image is in evidence.accounts. */
export const MAX_ACCOUNTS = 96;
/** The program owner of every account the browser reads (the local runtime's PROGRAM). */
export const PROGRAM_OWNER_HEX = '12'.repeat(32);
/** The LOCAL land records' fixed facts (land_bootstrap.rs pins): the one ring, the demo budget, the original
 * exported province count of the record, and the exact evidence tokens the host must report. */
export const LAND = Object.freeze({
  ring: 129, budget: 4, provincesCreatedAtInstall: 3,
  provenance: Object.freeze({
    ringSeed: 'LOCAL_SYNTHETIC_RING_SEED', rules: 'PROTOTYPE_CANDIDATE_RULES_V1', funds: 'LOCAL_FIXTURE_FUNDS',
    golden: 'GOLDEN_REOPEN_STATIC_FIELDS_MATCH', opened: 'REAL_HANDLER_OUTPUT_AT_SUPPLIED_TIME',
    resolveHistory: 'NO_RESOLVE_HISTORY', auth: 'MOCK_PAYER_SIGNER_FLAG_NO_SIGNATURE', budget: 'DEMO_BUDGET_4_EXTRA_PROVINCES',
  }),
});
export const FIXTURE_PROVINCES = Object.freeze(['129,0', '129,-1']);
/** v4 `map.provinces[i].history` tokens. */
export const HISTORY = Object.freeze({ FIXTURE: 'FIXTURE_EXPORT', NONE: 'NONE', PREPARED: 'PREPARED_FOR_SELECTED_MARCH' });
/** v4 march binding constants (LOCAL-CHOSEN-MARCH-20261108.md, chosen_march.rs, order_material.rs, destination_stage.rs). */
export const MARCH = Object.freeze({
  arriveBell: 20, accountsMax: 16, trailMax: 24, pathProvincesMax: 3, provincesEnteredMax: 4, finalCursor: 24,
  orderRecorded: 'RECORDED_FIXTURE_ORDER', orderRebuilt: 'REBUILT_FROM_PUBLIC_MATERIAL_T20',
  orderLabels: Object.freeze(['PUBLIC_SEAL_MATERIAL_NO_SECRECY', 'REUSED_PUBLIC_IBE_HEADER_T20', 'PUBLIC_BEACON_SIGNATURES_T20_S20',
    'ARRIVAL_BELL_20_ONLY', 'NO_KEY_NO_SIGNATURE_NO_ENCAPSULATION', 'PLAINTEXT_VALIDATED_ROUTE_NOT_WALKED']),
  preparationProvenance: 'REAL_RESOLVE_OVER_SYNTHETIC_NON_ARRIVAL_PAIRS',
  preparationLabels: Object.freeze(['SYNTHETIC_NON_ARRIVAL_BEACON_PAIRS', 'REAL_WIDE_RESOLVE_AT_SUPPLIED_TIME', 'CLOCK_NOT_MOVED',
    'LOCAL_FIXTURE_BEACON_LOG', 'NO_KEY_NO_SIGNATURE_NO_NEW_CRYPTO']),
  recordedTrail: Object.freeze(['RECORDED_FIXTURE_ORDER', 'REAL_DEPART']),
});
/** The per-destination planned-account roles a binding may name (destination_stage.rs `arrival_plan`). */
const ROLE_RE = /^(arrival_anchor|arrival_cache|archive|beacon_log|inputs_2[0-3]|day|roster|slot_[0-5]_[0-3]|cache_2[1-3]|anchor_2[1-3])$/;
/** Every exact chosen-march trail the host can produce, by the number of phase segments completed. */
const CHOSEN_TRAILS = (() => {
  const depart = ['RECORDED_ORDER_REPRODUCED', 'REBUILT_FROM_PUBLIC_MATERIAL_T20', 'REAL_DEPART', 'REVEAL_REHEARSED_ON_DROPPED_COPY'];
  const reveal = ['BEACON_LOG_LOCAL_FIXTURE_STAGED_FOR_REVEAL', 'BEACON_LOG_EXISTING_RECORD'].map(b => ['DESTINATION_PREPARED_THROUGH_BELL_19', 'REAL_POSTANCHOR_PUBLIC_SIG_T20', b, 'REAL_REVEAL']);
  const arrival = [['REAL_POSTSEED_PUBLIC_SIG_S20', 'REAL_GATHER', 'REAL_ARRIVAL_RESOLVE']];
  const settle = [['REAL_SETTLE_TRANSIT'], ['CAMP_CITIZEN_LISTED', 'REAL_SETTLE_TRANSIT']];
  const P = ['PAIRS_21_23_SYNTHETIC_STAGED_PER_DISPATCH', 'PAIRS_21_23_EXISTING_IDENTICAL_RECORDS'];
  const dissolve = P.flatMap(a => [[a, 'REAL_DISSOLVE', 'REAL_RETURN'], [a, 'REAL_DISSOLVE', P.find(b => b !== a), 'REAL_RETURN']]);
  const out = [[depart]];
  for (const seg of [reveal, arrival, settle, dissolve]) out.push(out.at(-1).flatMap(prefix => seg.map(s => [...prefix, s])));
  return out.map(level => new Set(level.map(parts => JSON.stringify(parts.flat()))));
})();
const TRAIL_LEVEL = Object.freeze({ departed: 0, travelling: 0, revealed: 1, resolved: 2, settled: 3, returned: 4 });
/** The chosen destination's RESOLVED_NEXT after each command (null: unchanged). */
const CHOSEN_CURSOR = Object.freeze({ post_reveal: 20, resolve_arrival: 21, dissolve_return: 24 });
const COUNTER = Object.freeze({ harvest: 'harvests', build_farm: 'farmBuilds', train: 'trains' });
const INSTRUCTION = Object.freeze({ harvest: 'Harvest', build_farm: 'BuildFarm', train: 'Train' });
export class LocalModelError extends Error { constructor(code, message = code) { super(message); this.code = code; } }
const check = (ok, code = 'BadReply') => { if (!ok) throw new LocalModelError(code); };
const obj = x => x && typeof x === 'object' && !Array.isArray(x);
const keys = (x, list) => check(obj(x) && Object.keys(x).sort().join('|') === [...list].sort().join('|'));
const nat = (x, max = Number.MAX_SAFE_INTEGER) => check(Number.isSafeInteger(x) && x >= 0 && x <= max);
const hex = (s, n = null) => check(typeof s === 'string' && s.length <= MAX_REPLY_BYTES && s.length % 2 === 0 && /^[0-9a-f]*$/.test(s) && (n === null || s.length === n));
const dec = s => { check(typeof s === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(s)); check(BigInt(s) <= 0xffffffffffffffffn); };
/** A signed 64-bit canonical decimal (store values, rates, times), as the host writes it. */
const sdec = s => { check(typeof s === 'string' && /^(0|-?[1-9][0-9]{0,18})$/.test(s)); const v = BigInt(s); check(v >= -(1n << 63n) && v < (1n << 63n)); };
const coord = x => { check(obj(x)); parseWideInt(x.p); parseWideInt(x.q); };
const tile = n => { nat(n, 60); };
const array = (a, n) => check(Array.isArray(a) && a.length === n);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const pq = x => `${x.p},${x.q}`;
export const allowedFor = (phase, usedThisInstant, opened = 0) => {
  const step = STEPS[PHASES.indexOf(phase)];
  return [...(step ? [step] : []), ...(phase === 'ready' && opened > 0 ? ['depart_route'] : []), ...(usedThisInstant < FIXED.perInstantBudget ? ECONOMY : []), ...(opened < LAND.budget ? ['open_province'] : []), 'reset'];
};
/** A canonical decimal coordinate string within ±2^62 (parseWideInt), kept as a string end to end. */
const coordText = s => { check(typeof s === 'string', 'BadCommand'); try { parseWideInt(s); } catch { throw new LocalModelError('BadCommand'); } return s; };
const revOk = n => check(Number.isSafeInteger(n) && n >= 0 && n <= 1000000, 'BadCommand');
export function commandFromBody(route, body) {
  check(route === 'action' || route === 'reset' || route === 'open' || route === 'depart_route', 'BadCommand');
  check(obj(body), 'BadCommand');
  if (route === 'open') {
    // the only inputs: the shown revision and a canonical coordinate; ring, budget and duplicates are the host's
    check(Object.keys(body).sort().join('|') === 'expectedRevision|p|q', 'BadCommand');
    revOk(body.expectedRevision);
    return { kind: 'open_province', rev: body.expectedRevision, p: coordText(body.p), q: coordText(body.q) };
  }
  if (route === 'depart_route') {
    // the only inputs: the shown revision and the quoted directions; the host re-quotes them and decides everything
    check(Object.keys(body).sort().join('|') === 'dirs|expectedRevision' && routeDirsOk(body.dirs), 'BadCommand');
    revOk(body.expectedRevision);
    return { kind: 'depart_route', rev: body.expectedRevision, dirs: body.dirs };
  }
  keys(body, route === 'action' ? ['expectedRevision','action'] : ['expectedRevision']); nat(body.expectedRevision, 1000000);
  const kind = route === 'reset' ? 'reset' : body.action;
  check(route === 'reset' ? kind === 'reset' : COMMANDS.includes(kind), 'BadCommand');
  return { kind, rev: body.expectedRevision };
}
/** The body of a non-mutating route quote: `{dirs}`, a bounded directions string chosen by the player. */
export function commandFromQuoteBody(body) {
  check(obj(body) && Object.keys(body).length === 1 && routeDirsOk(body.dirs), 'BadCommand');
  return { kind: 'quote_route', dirs: body.dirs };
}
export function commandLine(cmd) {
  if (cmd.kind === 'get') return 'get';
  if (cmd.kind === 'quote_route') { check(routeDirsOk(cmd.dirs), 'BadCommand'); return `quote_route ${cmd.dirs}`; }
  if (cmd.kind === 'open_province') { nat(cmd.rev,1000000); return `open_province ${cmd.rev} ${coordText(cmd.p)} ${coordText(cmd.q)}`; }
  if (cmd.kind === 'depart_route') { nat(cmd.rev,1000000); check(routeDirsOk(cmd.dirs), 'BadCommand'); return `depart_route ${cmd.rev} ${cmd.dirs}`; }
  check([...COMMANDS,'reset'].includes(cmd.kind),'BadCommand'); nat(cmd.rev,1000000); return `${cmd.kind} ${cmd.rev}`;
}
export function parseReplyLine(line) { check(typeof line === 'string' && line.length <= MAX_REPLY_BYTES && /^[\x20-\x7e]+$/.test(line)); let v; try { v = JSON.parse(line); } catch { throw new LocalModelError('BadJSON'); } return parseReplyObject(v); }
function parseVillage(v) {
  keys(v, ['tier','flags','lastOwnerAction','stores','production','queue','reserve']);
  nat(v.tier, 3); nat(v.flags, 255); sdec(v.lastOwnerAction);
  array(v.stores, 8); for (const s of v.stores) { keys(s, ['value','rate','cap','t0']); sdec(s.value); sdec(s.rate); sdec(s.cap); sdec(s.t0); }
  array(v.production, 8); for (const p of v.production) sdec(p);
  array(v.queue, 4); for (const q of v.queue) { keys(q, ['doneAt','kind','arg','delta']); sdec(q.doneAt); nat(q.kind, 4); nat(q.arg, 255); sdec(q.delta); }
  array(v.reserve, 8); for (const n of v.reserve) nat(n, 0xffffffff);
}
/** The LOCAL land records' summary. Every number is re-read from the named accounts by checkEvidence. */
function parseLand(l) {
  keys(l, ['ring','budget','opened','provincesCreated','ringSeedKeyHex','rulesConfigKeyHex','fundKeysHex','provenance']);
  check(l.ring === LAND.ring && l.budget === LAND.budget);
  nat(l.opened, LAND.budget); nat(l.provincesCreated, 0xffffffff);
  hex(l.ringSeedKeyHex, 64); hex(l.rulesConfigKeyHex, 64);
  array(l.fundKeysHex, 6); for (const k of l.fundKeysHex) hex(k, 64);
  check(new Set([l.ringSeedKeyHex, l.rulesConfigKeyHex, ...l.fundKeysHex]).size === 8);
  keys(l.provenance, Object.keys(LAND.provenance));
  for (const [k, v] of Object.entries(LAND.provenance)) check(l.provenance[k] === v);
}
/** v4 `marchBinding`: null exactly while ready; otherwise the bound march, every field cross-checked against the
 * map, the provinces' returned masks and an independent re-walk of its directions from the host's origin tile. */
function parseBinding(r, byKey) {
  const b = r.marchBinding;
  if (r.phase === 'ready') { check(b === null); return; }
  keys(b, ['kind','directions','arriveBell','departedMilli','destination','steps','provincesEntered','pathProvinces','order','preparation','accounts','trail']);
  check(b.kind === 'recorded' || b.kind === 'chosen');
  check(routeDirsOk(b.directions) && b.arriveBell === MARCH.arriveBell);
  nat(b.departedMilli, 0xffffffff); check(b.departedMilli > 0);
  // destination: one of the host's provinces, by coordinate, account key and source
  keys(b.destination, ['p','q','tile','accountKeyHex','source']); coord(b.destination); tile(b.destination.tile); hex(b.destination.accountKeyHex, 64);
  const dest = r.map.provinces.find(p => pq(p) === pq(b.destination));
  check(dest && dest.accountKeyHex === b.destination.accountKeyHex && dest.source === b.destination.source);
  // steps: exactly the walk of the directions from the origin tile, every step on returned, passable land
  check(Array.isArray(b.steps) && b.steps.length === b.directions.length);
  for (const s of b.steps) { keys(s, ['p','q','tile']); coord(s); tile(s.tile); }
  const walk = walkDirections({ p: r.map.origin.p, q: r.map.origin.q, tile: r.host.originTile }, b.directions);
  check(walk.offWorld === null && same(walk.steps, b.steps), 'BadBindingRoute');
  for (const s of b.steps) {
    const k = byKey.get(pq(s));
    check(k && (BigInt(k.passableMask) >> BigInt(s.tile)) & 1n, 'BadBindingRoute');
  }
  const last = b.steps.at(-1);
  check(last.p === b.destination.p && last.q === b.destination.q && last.tile === b.destination.tile, 'BadBindingRoute');
  // provinces entered (verify_route's list) and the Reveal's path provinces (entered without the destination)
  check(Array.isArray(b.provincesEntered) && b.provincesEntered.length <= MARCH.provincesEnteredMax);
  for (const e of b.provincesEntered) { keys(e, ['p','q']); coord(e); }
  check(same(b.provincesEntered, provincesEntered(b.steps)), 'BadBindingRoute');
  const path = b.provincesEntered.filter(e => pq(e) !== pq(b.destination));
  check(path.length === b.provincesEntered.length - 1 && Array.isArray(b.pathProvinces) && b.pathProvinces.length === path.length && path.length <= MARCH.pathProvincesMax, 'BadBindingRoute');
  b.pathProvinces.forEach((x, i) => {
    keys(x, ['p','q','accountKeyHex']); coord(x); hex(x.accountKeyHex, 64);
    check(pq(x) === pq(path[i]) && byKey.get(pq(x))?.accountKeyHex === x.accountKeyHex, 'BadBindingRoute');
  });
  // order: the host's commit and root (the transit record's root is checked by checkEvidence) and its labels
  keys(b.order, ['source','commitHex','rootHex','labels']); hex(b.order.commitHex, 64); hex(b.order.rootHex, 64);
  check(Array.isArray(b.order.labels) && b.order.labels.every(l => typeof l === 'string'));
  // accounts: per-destination planned accounts the march created or wrote, each present once
  check(Array.isArray(b.accounts) && b.accounts.length <= MARCH.accountsMax);
  const present = new Set(r.evidence.accounts.map(a => a.keyHex)), named = new Set();
  for (const a of b.accounts) {
    keys(a, ['role','keyHex']); check(typeof a.role === 'string' && ROLE_RE.test(a.role)); hex(a.keyHex, 64);
    check(present.has(a.keyHex) && !named.has(a.keyHex), 'BadBindingAccounts'); named.add(a.keyHex);
  }
  check(Array.isArray(b.trail) && b.trail.length <= MARCH.trailMax && b.trail.every(t => typeof t === 'string' && /^[A-Z0-9_]{1,64}$/.test(t)));
  if (b.kind === 'recorded') {
    // the recorded order to the recorded destination along the recorded route
    check(pq(b.destination) === pq(r.map.destination) && b.destination.tile === r.host.destinationTile && b.destination.source === 'fixture', 'BadBinding');
    check(same(b.steps, r.map.route.slice(1)) && r.map.route[0].tile === r.host.originTile, 'BadBinding');
    check(b.order.source === MARCH.orderRecorded && b.order.labels.length === 0 && b.preparation === null && b.accounts.length === 0, 'BadBinding');
    check(same(b.trail, MARCH.recordedTrail), 'BadBinding');
    return;
  }
  // chosen: a session-opened destination, the order rebuilt from public material, the phase's exact trail
  check(b.destination.source === 'opened' && dest.source === 'opened', 'BadBinding');
  check(b.order.source === MARCH.orderRebuilt && same(b.order.labels, MARCH.orderLabels), 'BadBinding');
  check(CHOSEN_TRAILS[TRAIL_LEVEL[r.phase]].has(JSON.stringify(b.trail)), 'BadBindingTrail');
  const prepared = TRAIL_LEVEL[r.phase] >= 1;
  if (!prepared) { check(b.preparation === null, 'BadPreparation'); return; }
  const p = b.preparation;
  keys(p, ['fromBell','toBell','resolvedNext','scoreNextBell','atUnix','resolves','region','pairsAliased','provenance','labels']);
  nat(p.fromBell, 0xffffffff); nat(p.scoreNextBell, 0xffffffff); nat(p.resolves, 64); nat(p.region, 255); nat(p.pairsAliased, 64); dec(p.atUnix);
  check(p.fromBell === dest.openedBell && p.fromBell >= 1 && p.toBell === MARCH.arriveBell - 1 && p.resolvedNext === MARCH.arriveBell, 'BadPreparation');
  check(p.resolves === p.toBell - p.fromBell + 1 && p.pairsAliased <= p.resolves && p.region === dest.region, 'BadPreparation');
  check(BigInt(p.atUnix) <= BigInt(r.clock.unix) && p.provenance === MARCH.preparationProvenance && same(p.labels, MARCH.preparationLabels), 'BadPreparation');
}
export function parseReplyObject(r) {
  keys(r,['protocol','mode','auth','beacon','session','status','error','refusalCode','command','revision','phase','allowed','clock','horizon','economy','village','land','map','host','holding','combat','returned','marchBinding','evidence','routeQuote']);
  check(r.protocol === PROTOCOL && r.mode === 'local-only' && r.auth === 'MOCK_AUTH_NO_SIGNATURE' && r.beacon === 'PUBLIC_FIXTURES_REAL_VERIFICATION' && r.session === SESSION);
  check(['ok','refused','fault'].includes(r.status)); check(r.status === 'ok' ? r.error === null : typeof r.error === 'string' && /^[A-Za-z0-9_:-]{1,128}$/.test(r.error));
  if (r.refusalCode !== null) { nat(r.refusalCode, 0xffffffff); check(r.status === 'refused' && (r.error === 'HANDLER_REFUSED' || r.error === 'ROUTE_REHEARSAL_REFUSED')); }
  check(['get','reset','quote_route','open_province','depart_route',...COMMANDS].includes(r.command)); nat(r.revision,1000000); check(PHASES.includes(r.phase));
  parseLand(r.land);
  keys(r.economy,['perInstantBudget','usedThisInstant','harvests','farmBuilds','trains','farmItem','trainUnit','trainCount']);
  check(r.economy.perInstantBudget === FIXED.perInstantBudget && r.economy.farmItem === FIXED.farmItem && r.economy.trainUnit === FIXED.trainUnit && r.economy.trainCount === FIXED.trainCount);
  nat(r.economy.usedThisInstant, FIXED.perInstantBudget); nat(r.economy.harvests, 1000000); nat(r.economy.farmBuilds, 1000000); nat(r.economy.trains, 1000000);
  check(Array.isArray(r.allowed) && new Set(r.allowed).size === r.allowed.length && [...r.allowed].sort().join('|') === allowedFor(r.phase, r.economy.usedThisInstant, r.land.opened).sort().join('|'));
  keys(r.clock,['unix','bell']); dec(r.clock.unix); nat(r.clock.bell);
  keys(r.horizon,['model','finalBell','destinationPreparedThroughBell','originResolvedNext','destinationResolvedNext','selectedDestinationResolvedNext']);
  check(r.horizon.model === 'PHASE_STEPS_ONLY' && r.horizon.finalBell === FIXED.finalBell && r.horizon.destinationPreparedThroughBell === FIXED.destinationPreparedThroughBell);
  nat(r.horizon.originResolvedNext, 0xffffffff); nat(r.horizon.destinationResolvedNext, 0xffffffff); check(r.clock.bell <= r.horizon.finalBell);
  if (r.horizon.selectedDestinationResolvedNext !== null) nat(r.horizon.selectedDestinationResolvedNext, 0xffffffff);
  parseVillage(r.village);
  keys(r.map,['worldHex','origin','destination','route','provinces']); hex(r.map.worldHex,64); coord(r.map.origin); coord(r.map.destination);
  check(r.map.origin.p === '129' && r.map.origin.q === '0' && r.map.destination.p === '129' && r.map.destination.q === '-1');
  // The two exported fixtures first, then every province opened this session (ring 129 only, at most the budget).
  check(Array.isArray(r.map.provinces) && r.map.provinces.length >= 2 && r.map.provinces.length <= 2 + LAND.budget); const ps = new Set();
  const mb = r.marchBinding;
  check(mb === null || obj(mb));
  const chosenKey = mb?.kind === 'chosen' && obj(mb.destination) ? mb.destination.accountKeyHex : null;
  r.map.provinces.forEach((p, i) => {
    keys(p,['p','q','accountKeyHex','passableMask','source','openedBell','resolvedNext','wedge','region','history']); coord(p); hex(p.accountKeyHex,64); dec(p.passableMask);
    nat(p.openedBell, 0xffffffff); nat(p.resolvedNext, 0xffffffff); nat(p.wedge, 5); nat(p.region, 255);
    const key = `${p.p},${p.q}`; check(!ps.has(key)); ps.add(key);
    if (i < 2) check(p.source === 'fixture' && key === FIXTURE_PROVINCES[i] && p.history === HISTORY.FIXTURE);
    else {
      check(p.source === 'opened' && !FIXTURE_PROVINCES.includes(key));
      check(ringOfWide(BigInt(p.p), BigInt(p.q)) === BigInt(LAND.ring));
      check(p.openedBell <= r.clock.bell);
      if (p.history === HISTORY.NONE) check(p.resolvedNext === p.openedBell); // no resolve history (NO_RESOLVE_HISTORY)
      else {
        // only the chosen march's destination, once prepared, and never back below the preparation's cursor
        check(p.history === HISTORY.PREPARED && p.accountKeyHex === chosenKey && obj(mb.preparation), 'BadHistory');
        check(p.resolvedNext >= MARCH.arriveBell, 'BadHistory');
      }
    }
  });
  check(r.map.provinces.length - 2 === r.land.opened);
  check(r.land.provincesCreated === LAND.provincesCreatedAtInstall + r.land.opened);
  check(Array.isArray(r.map.route) && r.map.route.length > 0 && r.map.route.length <= 128);
  for (const t of r.map.route) { keys(t,['p','q','tile']); coord(t); tile(t.tile); check(ps.has(`${t.p},${t.q}`)); }
  keys(r.host,['refHex','originTile','destinationTile','initialMilli','currentMilli','transitState','fate']); hex(r.host.refHex,112); tile(r.host.originTile); tile(r.host.destinationTile); nat(r.host.initialMilli); nat(r.host.currentMilli); check(['absent','departed','settled','closed'].includes(r.host.transitState)); if (r.host.fate !== null) nat(r.host.fate,255);
  // map.route / host.destinationTile are the RECORDED fixture route and tile; a chosen march's are its binding's
  const first = r.map.route[0], last = r.map.route.at(-1); check(first.p === r.map.origin.p && first.q === r.map.origin.q && first.tile === r.host.originTile && last.p === r.map.destination.p && last.q === r.map.destination.q && last.tile === r.host.destinationTile);
  keys(r.holding,['accountKeyHex','tile','reserveUnits','escrowLamports','poolOwedLamports','openTransits']); hex(r.holding.accountKeyHex,64); tile(r.holding.tile); nat(r.holding.reserveUnits); dec(r.holding.escrowLamports); dec(r.holding.poolOwedLamports); nat(r.holding.openTransits,255);
  check(r.village.reserve[FIXED.trainUnit] === r.holding.reserveUnits);
  keys(r.combat,['engagements','arrivalSurvivorMilli','enemyFixture']); nat(r.combat.engagements); if(r.combat.arrivalSurvivorMilli !== null) nat(r.combat.arrivalSurvivorMilli);
  // no enemy fixture is staged at a chosen (opened) destination
  check(r.combat.enemyFixture === (mb?.kind !== 'chosen'));
  keys(r.returned,['creditedUnits','creditedMilli']); nat(r.returned.creditedUnits); nat(r.returned.creditedMilli);
  keys(r.evidence,['instructions','recordsHex','accounts']); check(Array.isArray(r.evidence.instructions) && r.evidence.instructions.length <= 128); for(const s of r.evidence.instructions) check(typeof s === 'string' && /^[\x20-\x7e]{1,128}$/.test(s));
  check(Array.isArray(r.evidence.recordsHex) && r.evidence.recordsHex.length <= 256); for(const s of r.evidence.recordsHex) hex(s);
  // the whole persistent map, within the demo's 96-image bound
  check(Array.isArray(r.evidence.accounts) && r.evidence.accounts.length > 0 && r.evidence.accounts.length <= MAX_ACCOUNTS); const seen = new Set();
  for(const a of r.evidence.accounts) { keys(a,['keyHex','ownerHex','lamports','dataHex']); hex(a.keyHex,64); hex(a.ownerHex,64); dec(a.lamports); hex(a.dataHex); check(!seen.has(a.keyHex)); seen.add(a.keyHex); }
  check(seen.has(r.holding.accountKeyHex) && r.map.provinces.every(p => seen.has(p.accountKeyHex)));
  // the selected cursor: null with no binding, else the bound destination's (bytes re-read by checkEvidence)
  const byKey = new Map(r.map.provinces.map(p => [pq(p), p]));
  if (mb === null) check(r.horizon.selectedDestinationResolvedNext === null);
  parseBinding(r, byKey);
  if (mb !== null) check(r.horizon.selectedDestinationResolvedNext === byKey.get(pq(mb.destination)).resolvedNext);
  if(r.command === 'get' || r.command === 'reset' || r.command === 'quote_route' || r.status !== 'ok') check(r.evidence.recordsHex.length === 0 && r.evidence.instructions.length === 0);
  // WideOpenProvince runs alone and logs nothing (no receipt kind is allocated for it)
  if(r.command === 'open_province' && r.status === 'ok') check(same(r.evidence.instructions, ['WideOpenProvince']) && r.evidence.recordsHex.length === 0);
  // A route quote carries the host's validation: on a successful quote_route, and (v4) on a depart_route refused as
  // unreachable, where it is the host's read-only quote of the refused directions (never a re-routed march).
  const quoteExpected = (r.command === 'quote_route' && r.status === 'ok') || (r.command === 'depart_route' && r.status === 'refused' && r.error === 'ROUTE_UNREACHABLE');
  check((r.routeQuote !== null) === quoteExpected);
  if (r.routeQuote !== null) { parseRouteQuote(r.routeQuote, ps); if (r.command === 'depart_route') check(r.routeQuote.reachable === false); }
  try { checkEvidence(r); } catch { throw new LocalModelError('EvidenceMismatch'); }
  return r;
}
/** The host's read-only route validation. Every number is the host's; the browser only checks its shape and
 * internal honesty (reachable iff an end and no refusal; a reachable route has every step known and passable). */
export function parseRouteQuote(rq, provinceKeys) {
  keys(rq, ['start','reachable','reason','blockedStep','steps','end','provincesEntered']);
  const place = x => { keys(x, ['p','q','tile']); coord(x); tile(x.tile); };
  place(rq.start); check(provinceKeys.has(`${rq.start.p},${rq.start.q}`));
  check(typeof rq.reachable === 'boolean');
  check(rq.reason === null || (typeof rq.reason === 'string' && /^[A-Z_]{1,24}$/.test(rq.reason)));
  check(rq.blockedStep === null || (Number.isSafeInteger(rq.blockedStep) && rq.blockedStep >= 0 && rq.blockedStep <= MAX_ROUTE_DIRS));
  check(Array.isArray(rq.steps) && rq.steps.length <= MAX_ROUTE_DIRS);
  for (const s of rq.steps) { keys(s, ['p','q','tile','known','passable']); coord(s); tile(s.tile); check(typeof s.known === 'boolean'); check(s.passable === null || typeof s.passable === 'boolean'); check(s.known === provinceKeys.has(`${s.p},${s.q}`)); check(s.known || s.passable === null); }
  if (rq.end !== null) place(rq.end);
  check(Array.isArray(rq.provincesEntered) && rq.provincesEntered.length <= 4);
  for (const p of rq.provincesEntered) { keys(p, ['p','q']); coord(p); check(provinceKeys.has(`${p.p},${p.q}`)); }
  // internal honesty: reachable iff there is an end and no refusal reason
  check(rq.reachable === (rq.reason === null) && rq.reachable === (rq.end !== null));
  // a reachable route never crosses unknown or impassable land
  if (rq.reachable) check(rq.steps.every(s => s.known && s.passable === true));
}
const stable = r => JSON.stringify({ phase:r.phase, allowed:[...r.allowed].sort(), clock:r.clock, horizon:r.horizon, economy:r.economy, village:r.village, land:r.land, map:r.map, host:r.host, holding:r.holding, combat:r.combat, returned:r.returned, marchBinding:r.marchBinding, accounts:r.evidence.accounts });
export function validateState(reply) { parseReplyObject(reply); check(reply.status !== 'fault','HostFault'); return reply; }
export const replyObject = r => r;
/** A route quote is non-mutating: the reply carries the quote and leaves revision and all state identical to `prev`. */
export function checkQuote(prev, next) {
  validateState(next);
  check(next.command === 'quote_route' && next.status === 'ok' && next.routeQuote !== null, 'BadQuote');
  check(next.revision === prev.revision && stable(next) === stable(prev), 'BadQuote');
  return next.routeQuote;
}
const freshEconomy = e => e.usedThisInstant === 0 && e.harvests === 0 && e.farmBuilds === 0 && e.trains === 0;
const accountOf = (r, k) => r.evidence.accounts.find(a => a.keyHex === k) ?? null;
const accountJson = (r, k) => JSON.stringify(accountOf(r, k));
const landKeys = r => [r.land.ringSeedKeyHex, r.land.rulesConfigKeyHex, ...r.land.fundKeysHex];
/** An opening: same phase and instant, nothing of the village or the march moved, exactly the asked ring-129
 * province added (opened now, no resolve history), the land count and the ring seed's count up by one, and the
 * account set changed only by the new province, the ring seed record and one wedge fund paying the province's rent. */
function checkOpen(prev, cmd, next) {
  check(next.phase === prev.phase && same(next.clock, prev.clock), 'BadOpen');
  for (const k of ['economy','village','host','holding','combat','returned','horizon','marchBinding']) check(same(next[k], prev[k]), 'BadOpen');
  for (const k of ['worldHex','origin','destination','route']) check(same(next.map[k], prev.map[k]), 'BadOpen');
  const key = p => `${p.p},${p.q}`;
  const before = new Map(prev.map.provinces.map(p => [key(p), p]));
  check(next.map.provinces.length === prev.map.provinces.length + 1, 'BadOpen');
  const added = next.map.provinces.filter(p => !before.has(key(p)));
  check(added.length === 1, 'BadOpen');
  for (const p of next.map.provinces) if (before.has(key(p))) check(same(p, before.get(key(p))), 'BadOpen');
  const n = added[0];
  check(n.p === cmd.p && n.q === cmd.q && n.source === 'opened' && n.openedBell === next.clock.bell && n.history === HISTORY.NONE, 'BadOpen');
  const { ringSeedKeyHex, rulesConfigKeyHex, fundKeysHex, provenance } = prev.land;
  check(same({ ringSeedKeyHex, rulesConfigKeyHex, fundKeysHex, provenance }, { ringSeedKeyHex: next.land.ringSeedKeyHex, rulesConfigKeyHex: next.land.rulesConfigKeyHex, fundKeysHex: next.land.fundKeysHex, provenance: next.land.provenance }), 'BadOpen');
  check(next.land.opened === prev.land.opened + 1 && next.land.provincesCreated === prev.land.provincesCreated + 1, 'BadOpen');
  // accounts: one new (the province), the ring seed record and exactly one fund changed, all else byte-identical
  const changed = landChangedKeys(prev, next);
  check(changed.added.length === 1 && changed.added[0] === n.accountKeyHex && changed.removed.length === 0, 'BadOpen');
  check(changed.modified.includes(ringSeedKeyHex), 'BadOpen');
  const funds = changed.modified.filter(k => fundKeysHex.includes(k));
  check(funds.length === 1 && changed.modified.length === 2, 'BadOpen');
  const lam = (r, k) => BigInt(r.evidence.accounts.find(a => a.keyHex === k).lamports);
  check(lam(prev, funds[0]) - lam(next, funds[0]) === lam(next, n.accountKeyHex), 'BadOpen');
  check(lam(prev, ringSeedKeyHex) === lam(next, ringSeedKeyHex), 'BadOpen');
}
/** A phase step (or a departure) may change the map only where real handlers do:
 *  - a fixture province's resolve cursor, forward only (bytes free: real Resolve, Depart and settlements write
 *    them), EXCEPT the recorded destination while a CHOSEN march is bound, which stays byte-identical;
 *  - the chosen destination's cursor to exactly the phase's value (6 → 20 at post_reveal, → 21 at resolve_arrival,
 *    → 24 at dissolve_return) and its history NONE → PREPARED once, at post_reveal, with every GATED byte range,
 *    its key, owner, lamports and size unchanged;
 *  - nothing else: every other province summary and every other opened province's whole account stay exact. */
function checkMapCursors(prev, next, cmd) {
  for (const k of ['worldHex','origin','destination','route']) check(same(next.map[k], prev.map[k]), 'IdentityChanged');
  check(next.map.provinces.length === prev.map.provinces.length, 'IdentityChanged');
  const nb = next.marchBinding, chosen = nb?.kind === 'chosen' ? nb : null;
  const selKey = chosen ? chosen.destination.accountKeyHex : null;
  next.map.provinces.forEach((p, i) => {
    const b = prev.map.provinces[i];
    check(same({ ...p, resolvedNext: 0, history: '' }, { ...b, resolvedNext: 0, history: '' }), 'IdentityChanged');
    if (p.source === 'fixture') {
      check(p.history === b.history, 'IdentityChanged');
      if (chosen && i === 1) check(p.resolvedNext === b.resolvedNext && accountJson(next, p.accountKeyHex) === accountJson(prev, p.accountKeyHex), 'FixtureDestinationChanged');
      else check(p.resolvedNext >= b.resolvedNext, 'CursorRegressed');
    } else if (p.accountKeyHex === selKey) {
      const want = cmd.kind in CHOSEN_CURSOR ? CHOSEN_CURSOR[cmd.kind] : b.resolvedNext;
      if (p.resolvedNext < b.resolvedNext) check(false, 'CursorRegressed');
      check(p.resolvedNext === want, 'BadCursor');
      check(cmd.kind === 'post_reveal' ? b.history === HISTORY.NONE && p.history === HISTORY.PREPARED : p.history === b.history, 'BadHistory');
      const a0 = accountOf(prev, p.accountKeyHex), a1 = accountOf(next, p.accountKeyHex);
      check(a0.ownerHex === a1.ownerHex && a0.lamports === a1.lamports && gatedEqual(a0.dataHex, a1.dataHex), 'GatedChanged');
      if (want === b.resolvedNext && cmd.kind !== 'settle_transit') check(a0.dataHex === a1.dataHex, 'IdentityChanged'); // a step that resolves nothing there writes nothing there
    } else check(p.resolvedNext === b.resolvedNext && p.history === b.history && accountJson(next, p.accountKeyHex) === accountJson(prev, p.accountKeyHex), 'IdentityChanged');
  });
  check(next.horizon.originResolvedNext >= prev.horizon.originResolvedNext && next.horizon.destinationResolvedNext >= prev.horizon.destinationResolvedNext, 'CursorRegressed');
}
/** An economy command may change the village accounts (the holding and its owner citizen) and nothing else. */
function onlyVillageChanged(prev, next) {
  const village = new Set(villageAccountKeys(prev));
  check(same([...villageAccountKeys(next)].sort(), [...village].sort()), 'BadEconomy');
  const before = new Map(prev.evidence.accounts.map(a => [a.keyHex, a]));
  check(next.evidence.accounts.length === prev.evidence.accounts.length, 'BadEconomy');
  for (const a of next.evidence.accounts) {
    const b = before.get(a.keyHex); check(b !== undefined, 'BadEconomy');
    check(a.ownerHex === b.ownerHex && a.lamports === b.lamports && a.dataHex.length === b.dataHex.length, 'BadEconomy');
    if (!village.has(a.keyHex)) check(a.dataHex === b.dataHex, 'BadEconomy');
  }
}
/** The binding of a departure or a phase step. `depart` binds the recorded march, `depart_route` the chosen one with
 * exactly the sent directions; afterwards only `preparation` (null → object at a chosen post_reveal), `accounts`
 * (append only) and `trail` (append only) may change. */
function checkBindingStep(prev, cmd, next) {
  const a = prev.marchBinding, b = next.marchBinding;
  if (cmd.kind === 'depart' || cmd.kind === 'depart_route') {
    check(a === null && b !== null, 'BadBinding');
    check(b.kind === (cmd.kind === 'depart' ? 'recorded' : 'chosen'), 'BadBinding');
    if (cmd.kind === 'depart_route') check(b.directions === cmd.dirs && b.accounts.length === 0 && b.preparation === null, 'BadBinding');
    check(b.departedMilli === prev.host.currentMilli, 'BadBinding'); // the standing troops before the departure
    return;
  }
  check(a !== null && b !== null, 'BadBinding');
  for (const k of ['kind','directions','arriveBell','departedMilli','destination','steps','provincesEntered','pathProvinces','order']) check(same(a[k], b[k]), 'BadBinding');
  if (b.kind === 'chosen' && cmd.kind === 'post_reveal') check(a.preparation === null && b.preparation !== null, 'BadPreparation');
  else check(same(a.preparation, b.preparation), 'BadPreparation');
  check(b.accounts.length >= a.accounts.length && same(b.accounts.slice(0, a.accounts.length), a.accounts), 'BadBindingAccounts');
  check(b.trail.length >= a.trail.length && same(b.trail.slice(0, a.trail.length), a.trail), 'BadBindingTrail');
}
/** Departures and phase steps never remove an account (a closed transit is an emptied image); only a chosen
 * post_reveal / resolve_arrival may add accounts, each named in the new binding's `accounts`. Land records stay
 * byte-identical. */
function checkAccountSet(prev, cmd, next) {
  const a = new Set(prev.evidence.accounts.map(x => x.keyHex)), b = new Set(next.evidence.accounts.map(x => x.keyHex));
  check([...a].every(k => b.has(k)), 'AccountRemoved');
  const added = [...b].filter(k => !a.has(k));
  if (added.length) {
    const named = new Set((next.marchBinding?.accounts ?? []).map(x => x.keyHex));
    check(next.marchBinding?.kind === 'chosen' && (cmd.kind === 'post_reveal' || cmd.kind === 'resolve_arrival') && added.every(k => named.has(k)), 'AccountAdded');
  }
  for (const k of landKeys(prev)) check(accountJson(next, k) === accountJson(prev, k), 'LandChanged');
}
/** The exact receipts of one committed command: kinds, handler names, and the province each is attributed to. */
function receiptPlan(prev, cmd, next) {
  const world = next.map.worldHex, origin = provinceKeyHex(world, next.map.origin.p, next.map.origin.q);
  const mb = next.marchBinding ?? prev.marchBinding;
  const dest = mb ? provinceKeyHex(world, mb.destination.p, mb.destination.q) : null;
  const R = KIND.RESOLVE, resolves = (n, bell0, at) => Array.from({ length: Math.max(0, n) }, (_, i) => ({ kind: R, bell: bell0 + i, province: at }));
  const host = (kind, at) => ({ kind, province: at, host: true });
  let plan, instructions, nonChain = [];
  switch (cmd.kind) {
    case 'harvest': case 'build_farm': case 'train':
      plan = [{ kind: KIND.ECONOMY, province: origin }]; instructions = [INSTRUCTION[cmd.kind]]; break;
    case 'depart': case 'depart_route':
      plan = [host(KIND.DEPARTED, origin)]; instructions = ['Depart']; break;
    case 'settle_departure': {
      const n = next.horizon.originResolvedNext - prev.horizon.originResolvedNext;
      plan = [...resolves(n, prev.horizon.originResolvedNext, origin), host(KIND.DEPARTURE_SETTLED, origin)];
      instructions = [...Array(Math.max(0, n)).fill('Resolve'), 'SettleDeparture']; break;
    }
    case 'post_reveal': {
      const n = mb.kind === 'chosen' ? MARCH.arriveBell - prev.horizon.selectedDestinationResolvedNext : 0;
      plan = [...resolves(n, prev.horizon.selectedDestinationResolvedNext, dest), host(KIND.REVEALED, dest)];
      instructions = [...Array(Math.max(0, n)).fill('Resolve'), 'PostAnchor', 'Reveal']; nonChain = [KIND.REVEALED]; break;
    }
    case 'resolve_arrival':
      plan = [{ kind: KIND.GATHERED, province: dest }, ...resolves(1, MARCH.arriveBell, dest)];
      instructions = ['PostSeed', 'Gather', 'Resolve']; nonChain = [KIND.GATHERED]; break;
    case 'settle_transit':
      plan = [{ ...host(KIND.TRANSIT_SETTLED, dest), sealedDest: dest }]; instructions = ['SettleTransit']; break;
    case 'dissolve_return':
      plan = [...resolves(1, 21, dest), host(KIND.DISSOLVE, dest), ...resolves(2, 22, dest), host(KIND.RETURN, dest)];
      instructions = ['Resolve', 'Dissolve', 'Resolve', 'Resolve', 'Return']; break;
    case 'open_province': plan = []; instructions = ['WideOpenProvince']; break;
    default: check(false, 'BadTransition');
  }
  return { plan, instructions, nonChain };
}
/** Recomputes every wide event chain the command could touch, from the previous reply's header bytes through the
 * emitted receipts to the new reply's header bytes: the holding (by its host's holding reference, bound to the
 * holding bytes) and EVERY province the host holds (by its full key, bound to its bytes); a province opened by this
 * command starts from the fresh header. Every link must belong to one of those chains (no unverified identity is
 * permitted); only the command's own non-chain kinds may appear; each receipt is of the planned kind, bell and
 * province, and host-keyed ones of this host. Payload facts and digests are not replayed. */
function checkReceipts(prev, cmd, next) {
  const { plan, instructions, nonChain } = receiptPlan(prev, cmd, next);
  check(same(next.evidence.instructions, instructions), 'BadInstructions');
  const world = next.map.worldHex, opts = { programOwnerHex: PROGRAM_OWNER_HEX };
  const header = (r, k) => (r.evidence.accounts.some(a => a.keyHex === k) ? chainHeaderFromAccounts(r.evidence.accounts, k, opts) : null);
  const chains = [{ label: 'holding', entity: 2, targetHex: next.host.refHex.slice(0, 104) + '00000000', before: header(prev, prev.holding.accountKeyHex), after: header(next, next.holding.accountKeyHex) }];
  const provinces = new Map();
  for (const p of [...prev.map.provinces, ...next.map.provinces]) provinces.set(p.accountKeyHex, p);
  for (const [k, p] of provinces) {
    const inPrev = prev.map.provinces.some(x => x.accountKeyHex === k), inNext = next.map.provinces.some(x => x.accountKeyHex === k);
    chains.push({ label: `province ${p.p},${p.q}`, entity: 1, targetHex: provinceKeyHex(world, p.p, p.q), before: inPrev ? header(prev, k) : null, after: inNext ? header(next, k) : null });
  }
  let rep;
  try { rep = verifyReceiptChains({ records: next.evidence.recordsHex, chains, nonChainKinds: nonChain, unverified: [], kinds: plan.map(x => x.kind) }); }
  catch (e) { if (e instanceof ReceiptError) throw new LocalModelError(`Receipt${e.code}`, e.message); throw e; }
  rep.records.forEach((r, i) => {
    const want = plan[i];
    check(r.provinceHex === want.province, 'ReceiptAttribution');
    if (want.bell !== undefined) check(r.bell === want.bell, 'ReceiptAttribution');
    if (want.host) check(r.hostHex === next.host.refHex, 'ReceiptAttribution');
    if (want.sealedDest) check(r.sealedDestHex === want.sealedDest, 'ReceiptAttribution');
  });
  return rep;
}
export function checkTransition(prev, cmd, next, initial = null) {
  validateState(next); check(next.command === cmd.kind,'BadTransition');
  if(next.status === 'refused' || cmd.kind === 'get') { check(next.revision === prev.revision && stable(next) === stable(prev),'BadTransition'); return next.status === 'refused' ? 'refused' : 'ok'; }
  check(next.revision === prev.revision + 1,'BadTransition');
  if(cmd.kind === 'reset') { check(initial ? stable(next) === stable(initial) : next.phase === 'ready' && freshEconomy(next.economy) && next.marchBinding === null && next.land.opened === 0,'BadReset'); return 'ok'; }
  check(prev.allowed.includes(cmd.kind),'BadTransition');
  if (cmd.kind === 'open_province') { checkOpen(prev, cmd, next); checkReceipts(prev, cmd, next); return 'ok'; }
  check(same(next.land, prev.land), 'LandChanged');
  check(BigInt(next.clock.unix) >= BigInt(prev.clock.unix) && next.clock.bell >= prev.clock.bell,'BadClock');
  check(next.host.refHex === prev.host.refHex && next.host.initialMilli === prev.host.initialMilli && next.holding.accountKeyHex === prev.holding.accountKeyHex && next.holding.tile === prev.holding.tile,'IdentityChanged');
  // the economy never touches the map; a phase step may only move the cursors the handlers move (checkMapCursors)
  if (ECONOMY.includes(cmd.kind)) check(same(next.map, prev.map), 'IdentityChanged'); else checkMapCursors(prev, next, cmd);
  const e0 = prev.economy, e1 = next.economy;
  if (ECONOMY.includes(cmd.kind)) {
    // same phase, same instant; one more of this command; the march untouched
    check(next.phase === prev.phase, 'BadPhase');
    check(next.clock.unix === prev.clock.unix && next.clock.bell === prev.clock.bell, 'BadClock');
    check(e1.usedThisInstant === e0.usedThisInstant + 1, 'BadEconomy');
    for (const k of Object.values(COUNTER)) check(e1[k] === e0[k] + (k === COUNTER[cmd.kind] ? 1 : 0), 'BadEconomy');
    check(same(next.host, prev.host) && same(next.combat, prev.combat) && same(next.returned, prev.returned) && same(next.horizon, prev.horizon) && same(next.marchBinding, prev.marchBinding), 'BadEconomy');
    check(next.holding.escrowLamports === prev.holding.escrowLamports && next.holding.poolOwedLamports === prev.holding.poolOwedLamports && next.holding.openTransits === prev.holding.openTransits, 'BadEconomy');
    // the request's own fixed count, compared, never computed as a cost or rule
    check(next.village.reserve.every((n, i) => n === prev.village.reserve[i] + (cmd.kind === 'train' && i === FIXED.trainUnit ? FIXED.trainCount : 0)), 'BadEconomy');
    check(same(next.evidence.instructions, [INSTRUCTION[cmd.kind]]) && next.evidence.recordsHex.length === 1, 'BadEconomy');
    onlyVillageChanged(prev, next);
  } else {
    check(next.phase === PHASES[PHASES.indexOf(prev.phase)+1],'BadPhase');
    for (const k of Object.values(COUNTER)) check(e1[k] === e0[k], 'BadEconomy');
    check(e1.usedThisInstant === (next.clock.unix === prev.clock.unix ? e0.usedThisInstant : 0), 'BadEconomy');
    check(next.evidence.instructions.length > 0 && next.evidence.recordsHex.length > 0, 'BadTransition');
    if (cmd.kind === 'depart' || cmd.kind === 'depart_route') check(same(next.clock, prev.clock), 'BadClock'); // a departure never moves the clock
    checkBindingStep(prev, cmd, next);
    checkAccountSet(prev, cmd, next);
    const mb = next.marchBinding;
    // a chosen arrival: whatever the handlers produced at an enemy-free province (zero engagements is legitimate),
    // a staying host of 1..departed milli-troops; never the recorded fixture's combat assertions
    if (cmd.kind === 'resolve_arrival' && mb.kind === 'chosen') check(next.combat.arrivalSurvivorMilli !== null && next.combat.arrivalSurvivorMilli >= 1 && next.combat.arrivalSurvivorMilli <= mb.departedMilli, 'BadArrival');
    if (cmd.kind === 'dissolve_return') check(next.holding.reserveUnits === prev.holding.reserveUnits + next.returned.creditedUnits && next.returned.creditedMilli === next.returned.creditedUnits * 1000, 'BadReturn');
  }
  checkReceipts(prev, cmd, next);
  return 'ok';
}
