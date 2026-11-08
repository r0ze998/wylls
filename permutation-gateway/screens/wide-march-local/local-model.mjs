// Strict transport/structural validation only. All game outcomes belong to the Rust host.
// Protocol v2: the village economy and the march on ONE holding, one revision, one simulated clock.
import { checkEvidence, villageAccountKeys } from './local-evidence.mjs';
import { parseWideInt } from '../../../permutation-server/web/frontier/map/wide.mjs';
export const PROTOCOL = 'wylls-local-march-v2';
export const SESSION = 'integrated-economy-march-same-holding';
export const MAX_COMMAND_BYTES = 128, MAX_REPLY_BYTES = 1048576;
export const HOST_REL_PATH = Object.freeze(['.local','wide-march-demo','target','debug','examples','local_march_demo']);
export const PHASES = Object.freeze(['ready','departed','travelling','revealed','resolved','settled','returned']);
export const STEPS = Object.freeze(['depart','settle_departure','post_reveal','resolve_arrival','settle_transit','dissolve_return']);
export const ECONOMY = Object.freeze(['harvest','build_farm','train']);
export const COMMANDS = Object.freeze([...STEPS, ...ECONOMY]);
/** Fixed session constants the host must report exactly (protocol document); the browser never chooses them. */
export const FIXED = Object.freeze({ perInstantBudget: 8, farmItem: 0, trainUnit: 0, trainCount: 10, finalBell: 25, destinationPreparedThroughBell: 19 });
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
export const allowedFor = (phase, usedThisInstant) => {
  const step = STEPS[PHASES.indexOf(phase)];
  return [...(step ? [step] : []), ...(usedThisInstant < FIXED.perInstantBudget ? ECONOMY : []), 'reset'];
};
export function commandFromBody(route, body) {
  check(route === 'action' || route === 'reset', 'BadCommand');
  keys(body, route === 'action' ? ['expectedRevision','action'] : ['expectedRevision']); nat(body.expectedRevision, 1000000);
  const kind = route === 'reset' ? 'reset' : body.action;
  check(route === 'reset' ? kind === 'reset' : COMMANDS.includes(kind), 'BadCommand');
  return { kind, rev: body.expectedRevision };
}
export function commandLine(cmd) { if (cmd.kind === 'get') return 'get'; check([...COMMANDS,'reset'].includes(cmd.kind),'BadCommand'); nat(cmd.rev,1000000); return `${cmd.kind} ${cmd.rev}`; }
export function parseReplyLine(line) { check(typeof line === 'string' && line.length <= MAX_REPLY_BYTES && /^[\x20-\x7e]+$/.test(line)); let v; try { v = JSON.parse(line); } catch { throw new LocalModelError('BadJSON'); } return parseReplyObject(v); }
function parseVillage(v) {
  keys(v, ['tier','flags','lastOwnerAction','stores','production','queue','reserve']);
  nat(v.tier, 3); nat(v.flags, 255); sdec(v.lastOwnerAction);
  array(v.stores, 8); for (const s of v.stores) { keys(s, ['value','rate','cap','t0']); sdec(s.value); sdec(s.rate); sdec(s.cap); sdec(s.t0); }
  array(v.production, 8); for (const p of v.production) sdec(p);
  array(v.queue, 4); for (const q of v.queue) { keys(q, ['doneAt','kind','arg','delta']); sdec(q.doneAt); nat(q.kind, 4); nat(q.arg, 255); sdec(q.delta); }
  array(v.reserve, 8); for (const n of v.reserve) nat(n, 0xffffffff);
}
export function parseReplyObject(r) {
  keys(r,['protocol','mode','auth','beacon','session','status','error','refusalCode','command','revision','phase','allowed','clock','horizon','economy','village','map','host','holding','combat','returned','evidence']);
  check(r.protocol === PROTOCOL && r.mode === 'local-only' && r.auth === 'MOCK_AUTH_NO_SIGNATURE' && r.beacon === 'PUBLIC_FIXTURES_REAL_VERIFICATION' && r.session === SESSION);
  check(['ok','refused','fault'].includes(r.status)); check(r.status === 'ok' ? r.error === null : typeof r.error === 'string' && /^[A-Za-z0-9_:-]{1,128}$/.test(r.error));
  if (r.refusalCode !== null) { nat(r.refusalCode, 0xffffffff); check(r.status === 'refused' && r.error === 'HANDLER_REFUSED'); }
  check(['get','reset',...COMMANDS].includes(r.command)); nat(r.revision,1000000); check(PHASES.includes(r.phase));
  keys(r.economy,['perInstantBudget','usedThisInstant','harvests','farmBuilds','trains','farmItem','trainUnit','trainCount']);
  check(r.economy.perInstantBudget === FIXED.perInstantBudget && r.economy.farmItem === FIXED.farmItem && r.economy.trainUnit === FIXED.trainUnit && r.economy.trainCount === FIXED.trainCount);
  nat(r.economy.usedThisInstant, FIXED.perInstantBudget); nat(r.economy.harvests, 1000000); nat(r.economy.farmBuilds, 1000000); nat(r.economy.trains, 1000000);
  check(Array.isArray(r.allowed) && new Set(r.allowed).size === r.allowed.length && [...r.allowed].sort().join('|') === allowedFor(r.phase, r.economy.usedThisInstant).sort().join('|'));
  keys(r.clock,['unix','bell']); dec(r.clock.unix); nat(r.clock.bell);
  keys(r.horizon,['model','finalBell','destinationPreparedThroughBell','originResolvedNext','destinationResolvedNext']);
  check(r.horizon.model === 'PHASE_STEPS_ONLY' && r.horizon.finalBell === FIXED.finalBell && r.horizon.destinationPreparedThroughBell === FIXED.destinationPreparedThroughBell);
  nat(r.horizon.originResolvedNext, 0xffffffff); nat(r.horizon.destinationResolvedNext, 0xffffffff); check(r.clock.bell <= r.horizon.finalBell);
  parseVillage(r.village);
  keys(r.map,['worldHex','origin','destination','route','provinces']); hex(r.map.worldHex,64); coord(r.map.origin); coord(r.map.destination);
  check(r.map.origin.p === '129' && r.map.origin.q === '0' && r.map.destination.p === '129' && r.map.destination.q === '-1');
  check(Array.isArray(r.map.provinces) && r.map.provinces.length === 2); const ps = new Set();
  for (const p of r.map.provinces) { keys(p,['p','q','accountKeyHex','passableMask']); coord(p); hex(p.accountKeyHex,64); dec(p.passableMask); ps.add(`${p.p},${p.q}`); }
  check(ps.size === 2 && ps.has('129,0') && ps.has('129,-1'));
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
  if(r.command === 'get' || r.command === 'reset' || r.status !== 'ok') check(r.evidence.recordsHex.length === 0 && r.evidence.instructions.length === 0);
  try { checkEvidence(r); } catch { throw new LocalModelError('EvidenceMismatch'); }
  return r;
}
const stable = r => JSON.stringify({ phase:r.phase, allowed:[...r.allowed].sort(), clock:r.clock, horizon:r.horizon, economy:r.economy, village:r.village, map:r.map, host:r.host, holding:r.holding, combat:r.combat, returned:r.returned, accounts:r.evidence.accounts });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export function validateState(reply) { parseReplyObject(reply); check(reply.status !== 'fault','HostFault'); return reply; }
export const replyObject = r => r;
const freshEconomy = e => e.usedThisInstant === 0 && e.harvests === 0 && e.farmBuilds === 0 && e.trains === 0;
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
  check(BigInt(next.clock.unix) >= BigInt(prev.clock.unix) && next.clock.bell >= prev.clock.bell,'BadClock');
  check(same(next.map, prev.map) && next.host.refHex === prev.host.refHex && next.host.initialMilli === prev.host.initialMilli && next.holding.accountKeyHex === prev.holding.accountKeyHex && next.holding.tile === prev.holding.tile,'IdentityChanged');
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
