// Strict transport/structural validation only. All game outcomes belong to the Rust host.
// Protocol v3: the village economy and the march on ONE holding, one revision, one simulated clock, plus
// ring-129 provinces opened by the real WideOpenProvince over LOCAL synthetic land records.
import { checkEvidence, villageAccountKeys, landChangedKeys } from './local-evidence.mjs';
import { parseWideInt, ringOfWide } from '../../../permutation-server/web/frontier/map/wide.mjs';
export const PROTOCOL = 'wylls-local-march-v3';
export const SESSION = 'integrated-economy-march-same-holding';
export const MAX_COMMAND_BYTES = 128, MAX_REPLY_BYTES = 1048576;
export const HOST_REL_PATH = Object.freeze(['.local','wide-march-demo','target','debug','examples','local_march_demo']);
export const PHASES = Object.freeze(['ready','departed','travelling','revealed','resolved','settled','returned']);
export const STEPS = Object.freeze(['depart','settle_departure','post_reveal','resolve_arrival','settle_transit','dissolve_return']);
export const ECONOMY = Object.freeze(['harvest','build_farm','train']);
export const COMMANDS = Object.freeze([...STEPS, ...ECONOMY]);
/** The longest chosen path a route quote accepts (the legacy march limit). */
export const MAX_ROUTE_DIRS = 32;
/** A valid chosen-path string: 1..=32 directions, each 0..5. */
export const routeDirsOk = s => typeof s === 'string' && s.length >= 1 && s.length <= MAX_ROUTE_DIRS && /^[0-5]+$/.test(s);
/** Fixed session constants the host must report exactly (protocol document); the browser never chooses them. */
export const FIXED = Object.freeze({ perInstantBudget: 8, farmItem: 0, trainUnit: 0, trainCount: 10, finalBell: 25, destinationPreparedThroughBell: 19, maxRouteDirs: MAX_ROUTE_DIRS });
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
export const allowedFor = (phase, usedThisInstant, opened = 0) => {
  const step = STEPS[PHASES.indexOf(phase)];
  return [...(step ? [step] : []), ...(usedThisInstant < FIXED.perInstantBudget ? ECONOMY : []), ...(opened < LAND.budget ? ['open_province'] : []), 'reset'];
};
/** A canonical decimal coordinate string within ±2^62 (parseWideInt), kept as a string end to end. */
const coordText = s => { check(typeof s === 'string', 'BadCommand'); try { parseWideInt(s); } catch { throw new LocalModelError('BadCommand'); } return s; };
export function commandFromBody(route, body) {
  check(route === 'action' || route === 'reset' || route === 'open', 'BadCommand');
  check(obj(body), 'BadCommand');
  if (route === 'open') {
    // the only inputs: the shown revision and a canonical coordinate; ring, budget and duplicates are the host's
    check(Object.keys(body).sort().join('|') === 'expectedRevision|p|q', 'BadCommand');
    check(Number.isSafeInteger(body.expectedRevision) && body.expectedRevision >= 0 && body.expectedRevision <= 1000000, 'BadCommand');
    return { kind: 'open_province', rev: body.expectedRevision, p: coordText(body.p), q: coordText(body.q) };
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
export function parseReplyObject(r) {
  keys(r,['protocol','mode','auth','beacon','session','status','error','refusalCode','command','revision','phase','allowed','clock','horizon','economy','village','land','map','host','holding','combat','returned','evidence','routeQuote']);
  check(r.protocol === PROTOCOL && r.mode === 'local-only' && r.auth === 'MOCK_AUTH_NO_SIGNATURE' && r.beacon === 'PUBLIC_FIXTURES_REAL_VERIFICATION' && r.session === SESSION);
  check(['ok','refused','fault'].includes(r.status)); check(r.status === 'ok' ? r.error === null : typeof r.error === 'string' && /^[A-Za-z0-9_:-]{1,128}$/.test(r.error));
  if (r.refusalCode !== null) { nat(r.refusalCode, 0xffffffff); check(r.status === 'refused' && r.error === 'HANDLER_REFUSED'); }
  check(['get','reset','quote_route','open_province',...COMMANDS].includes(r.command)); nat(r.revision,1000000); check(PHASES.includes(r.phase));
  parseLand(r.land);
  keys(r.economy,['perInstantBudget','usedThisInstant','harvests','farmBuilds','trains','farmItem','trainUnit','trainCount']);
  check(r.economy.perInstantBudget === FIXED.perInstantBudget && r.economy.farmItem === FIXED.farmItem && r.economy.trainUnit === FIXED.trainUnit && r.economy.trainCount === FIXED.trainCount);
  nat(r.economy.usedThisInstant, FIXED.perInstantBudget); nat(r.economy.harvests, 1000000); nat(r.economy.farmBuilds, 1000000); nat(r.economy.trains, 1000000);
  check(Array.isArray(r.allowed) && new Set(r.allowed).size === r.allowed.length && [...r.allowed].sort().join('|') === allowedFor(r.phase, r.economy.usedThisInstant, r.land.opened).sort().join('|'));
  keys(r.clock,['unix','bell']); dec(r.clock.unix); nat(r.clock.bell);
  keys(r.horizon,['model','finalBell','destinationPreparedThroughBell','originResolvedNext','destinationResolvedNext']);
  check(r.horizon.model === 'PHASE_STEPS_ONLY' && r.horizon.finalBell === FIXED.finalBell && r.horizon.destinationPreparedThroughBell === FIXED.destinationPreparedThroughBell);
  nat(r.horizon.originResolvedNext, 0xffffffff); nat(r.horizon.destinationResolvedNext, 0xffffffff); check(r.clock.bell <= r.horizon.finalBell);
  parseVillage(r.village);
  keys(r.map,['worldHex','origin','destination','route','provinces']); hex(r.map.worldHex,64); coord(r.map.origin); coord(r.map.destination);
  check(r.map.origin.p === '129' && r.map.origin.q === '0' && r.map.destination.p === '129' && r.map.destination.q === '-1');
  // The two exported fixtures first, then every province opened this session (ring 129 only, at most the budget).
  check(Array.isArray(r.map.provinces) && r.map.provinces.length >= 2 && r.map.provinces.length <= 2 + LAND.budget); const ps = new Set();
  r.map.provinces.forEach((p, i) => {
    keys(p,['p','q','accountKeyHex','passableMask','source','openedBell','resolvedNext','wedge','region']); coord(p); hex(p.accountKeyHex,64); dec(p.passableMask);
    nat(p.openedBell, 0xffffffff); nat(p.resolvedNext, 0xffffffff); nat(p.wedge, 5); nat(p.region, 255);
    const key = `${p.p},${p.q}`; check(!ps.has(key)); ps.add(key);
    if (i < 2) check(p.source === 'fixture' && key === FIXTURE_PROVINCES[i]);
    else {
      check(p.source === 'opened' && !FIXTURE_PROVINCES.includes(key));
      check(ringOfWide(BigInt(p.p), BigInt(p.q)) === BigInt(LAND.ring));
      // a newly opened province has no resolve history yet (NO_RESOLVE_HISTORY), and opened no later than now
      check(p.resolvedNext === p.openedBell && p.openedBell <= r.clock.bell);
    }
  });
  check(r.map.provinces.length - 2 === r.land.opened);
  check(r.land.provincesCreated === LAND.provincesCreatedAtInstall + r.land.opened);
  check(Array.isArray(r.map.route) && r.map.route.length > 0 && r.map.route.length <= 128);
  for (const t of r.map.route) { keys(t,['p','q','tile']); coord(t); tile(t.tile); check(ps.has(`${t.p},${t.q}`)); }
  keys(r.host,['refHex','originTile','destinationTile','initialMilli','currentMilli','transitState','fate']); hex(r.host.refHex,112); tile(r.host.originTile); tile(r.host.destinationTile); nat(r.host.initialMilli); nat(r.host.currentMilli); check(['absent','departed','settled','closed'].includes(r.host.transitState)); if (r.host.fate !== null) nat(r.host.fate,255);
  const first = r.map.route[0], last = r.map.route.at(-1); check(first.p === r.map.origin.p && first.q === r.map.origin.q && first.tile === r.host.originTile && last.p === r.map.destination.p && last.q === r.map.destination.q && last.tile === r.host.destinationTile);
  keys(r.holding,['accountKeyHex','tile','reserveUnits','escrowLamports','poolOwedLamports','openTransits']); hex(r.holding.accountKeyHex,64); tile(r.holding.tile); nat(r.holding.reserveUnits); dec(r.holding.escrowLamports); dec(r.holding.poolOwedLamports); nat(r.holding.openTransits,255);
  check(r.village.reserve[FIXED.trainUnit] === r.holding.reserveUnits);
  keys(r.combat,['engagements','arrivalSurvivorMilli','enemyFixture']); nat(r.combat.engagements); check(r.combat.enemyFixture === true); if(r.combat.arrivalSurvivorMilli !== null) nat(r.combat.arrivalSurvivorMilli);
  keys(r.returned,['creditedUnits','creditedMilli']); nat(r.returned.creditedUnits); nat(r.returned.creditedMilli);
  keys(r.evidence,['instructions','recordsHex','accounts']); check(Array.isArray(r.evidence.instructions) && r.evidence.instructions.length <= 128); for(const s of r.evidence.instructions) check(typeof s === 'string' && /^[\x20-\x7e]{1,128}$/.test(s));
  check(Array.isArray(r.evidence.recordsHex) && r.evidence.recordsHex.length <= 256); for(const s of r.evidence.recordsHex) hex(s);
  check(Array.isArray(r.evidence.accounts) && r.evidence.accounts.length > 0 && r.evidence.accounts.length <= 256); const seen = new Set();
  for(const a of r.evidence.accounts) { keys(a,['keyHex','ownerHex','lamports','dataHex']); hex(a.keyHex,64); hex(a.ownerHex,64); dec(a.lamports); hex(a.dataHex); check(!seen.has(a.keyHex)); seen.add(a.keyHex); }
  check(seen.has(r.holding.accountKeyHex) && r.map.provinces.every(p => seen.has(p.accountKeyHex)));
  if(r.command === 'get' || r.command === 'reset' || r.command === 'quote_route' || r.status !== 'ok') check(r.evidence.recordsHex.length === 0 && r.evidence.instructions.length === 0);
  // WideOpenProvince runs alone and logs nothing (no receipt kind is allocated for it)
  if(r.command === 'open_province' && r.status === 'ok') check(same(r.evidence.instructions, ['WideOpenProvince']) && r.evidence.recordsHex.length === 0);
  // A route quote carries the host's validation; it is present exactly on a successful quote_route.
  if (r.routeQuote !== null) { check(r.command === 'quote_route' && r.status === 'ok'); parseRouteQuote(r.routeQuote, ps); }
  else check(!(r.command === 'quote_route' && r.status === 'ok'));
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
const stable = r => JSON.stringify({ phase:r.phase, allowed:[...r.allowed].sort(), clock:r.clock, horizon:r.horizon, economy:r.economy, village:r.village, land:r.land, map:r.map, host:r.host, holding:r.holding, combat:r.combat, returned:r.returned, accounts:r.evidence.accounts });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
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
/** An opening: same phase and instant, nothing of the village or the march moved, exactly the asked ring-129
 * province added (opened now, no resolve history), the land count and the ring seed's count up by one, and the
 * account set changed only by the new province, the ring seed record and one wedge fund paying the province's rent. */
function checkOpen(prev, cmd, next) {
  check(next.phase === prev.phase && same(next.clock, prev.clock), 'BadOpen');
  for (const k of ['economy','village','host','holding','combat','returned','horizon']) check(same(next[k], prev[k]), 'BadOpen');
  for (const k of ['worldHex','origin','destination','route']) check(same(next.map[k], prev.map[k]), 'BadOpen');
  const key = p => `${p.p},${p.q}`;
  const before = new Map(prev.map.provinces.map(p => [key(p), p]));
  check(next.map.provinces.length === prev.map.provinces.length + 1, 'BadOpen');
  const added = next.map.provinces.filter(p => !before.has(key(p)));
  check(added.length === 1, 'BadOpen');
  for (const p of next.map.provinces) if (before.has(key(p))) check(same(p, before.get(key(p))), 'BadOpen');
  const n = added[0];
  check(n.p === cmd.p && n.q === cmd.q && n.source === 'opened' && n.openedBell === next.clock.bell, 'BadOpen');
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
/** A phase step runs real Resolve, which advances a fixture province's RESOLVED_NEXT. That cursor is already bound
 * to the province's bytes and to the horizon by checkEvidence; here it may only move forward (never back), and so
 * may the horizon. Every other map field (world, origin, destination, route, the province list, each province's
 * key, mask, source, bells, wedge and region) stays exact, and an opened province is not part of the fixed march:
 * its summary and its whole account (data, lamports, owner) stay byte-identical. */
function checkMapCursors(prev, next) {
  for (const k of ['worldHex','origin','destination','route']) check(same(next.map[k], prev.map[k]), 'IdentityChanged');
  check(next.map.provinces.length === prev.map.provinces.length, 'IdentityChanged');
  const account = (r, k) => JSON.stringify(r.evidence.accounts.find(a => a.keyHex === k) ?? null);
  next.map.provinces.forEach((p, i) => {
    const b = prev.map.provinces[i];
    check(same({ ...p, resolvedNext: 0 }, { ...b, resolvedNext: 0 }), 'IdentityChanged');
    if (p.source === 'opened') check(p.resolvedNext === b.resolvedNext && account(next, p.accountKeyHex) === account(prev, p.accountKeyHex), 'IdentityChanged');
    else check(p.resolvedNext >= b.resolvedNext, 'CursorRegressed');
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
export function checkTransition(prev, cmd, next, initial = null) {
  validateState(next); check(next.command === cmd.kind,'BadTransition');
  if(next.status === 'refused' || cmd.kind === 'get') { check(next.revision === prev.revision && stable(next) === stable(prev),'BadTransition'); return next.status === 'refused' ? 'refused' : 'ok'; }
  check(next.revision === prev.revision + 1,'BadTransition');
  if(cmd.kind === 'reset') { check(initial ? stable(next) === stable(initial) : next.phase === 'ready' && freshEconomy(next.economy),'BadReset'); return 'ok'; }
  check(prev.allowed.includes(cmd.kind),'BadTransition');
  if (cmd.kind === 'open_province') { checkOpen(prev, cmd, next); return 'ok'; }
  check(same(next.land, prev.land), 'LandChanged');
  check(BigInt(next.clock.unix) >= BigInt(prev.clock.unix) && next.clock.bell >= prev.clock.bell,'BadClock');
  check(next.host.refHex === prev.host.refHex && next.host.initialMilli === prev.host.initialMilli && next.holding.accountKeyHex === prev.holding.accountKeyHex && next.holding.tile === prev.holding.tile,'IdentityChanged');
  // the economy never touches the map; a phase step may only move the fixtures' resolve cursors forward
  if (ECONOMY.includes(cmd.kind)) check(same(next.map, prev.map), 'IdentityChanged'); else checkMapCursors(prev, next);
  const e0 = prev.economy, e1 = next.economy;
  if (ECONOMY.includes(cmd.kind)) {
    // same phase, same instant; one more of this command; the march untouched
    check(next.phase === prev.phase, 'BadPhase');
    check(next.clock.unix === prev.clock.unix && next.clock.bell === prev.clock.bell, 'BadClock');
    check(e1.usedThisInstant === e0.usedThisInstant + 1, 'BadEconomy');
    for (const k of Object.values(COUNTER)) check(e1[k] === e0[k] + (k === COUNTER[cmd.kind] ? 1 : 0), 'BadEconomy');
    check(same(next.host, prev.host) && same(next.combat, prev.combat) && same(next.returned, prev.returned) && same(next.horizon, prev.horizon), 'BadEconomy');
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
  }
  return 'ok';
}
