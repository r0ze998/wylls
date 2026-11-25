// LOCAL PLAY, TEST-ONLY — a WIDE village's own host: train, muster and march wide -> wide (Q-W2, owner t385u
// 2026-11-19 22:32 JST 「おすすめで」: open wide-land interior marches and wide keep capture in LOCAL TEST only; devnet
// unchanged until r0ze plays it).
//
// Three page-signed local acts over a wide holding (rings 129+), each written from the published layout (the game's
// SDK has no shape for the wide band), the ONE builder both the page (flocalplay-act.mjs) and the relay (gateway
// local-play-act.mjs, which rebuilds the stated intent byte for byte) use:
//
//   WideTrain   0xDA op 3 WideEconomy Train {unit, n}   [actor s] [payer s,w] [season r] [citizen w] [holding w] [province r]
//   WideMuster  0xDA op 1 {unit u8, troops u32, tile u8} [actor s] [payer s,w] [season r] [citizen w] [holding w] [province w]
//                                                        [roster w] [system r]
//   WideDepart  0xDA {host 56, transit_slot u8, arrive_bell u32, tip u64, commit 32, seal 264}
//               [actor s] [payer s,w] [season r] [citizen w] [holding w] [standing province w] [system r]
//               [holding province r] [transit ×4 (the departing slot writable)] [standing roster r]
//
// The departure's effects are refused NotImplemented by every build but the local land lane's
// (permutation-frontier `localnet-wide-depart`, `proc::wide::DEPART_DEBIT_ENABLED`). After the send the world's
// runner settles everything (itest wide_depart.rs: the departure, the reveal from the PUBLIC round T(arrive), the
// gather, every bell's resolve, the transit's verdict). A host standing on a foreign keep's tile for the Season's
// keep_bells takes the keep (the wide resolve's keep contest).
//
// Also here: the wide host's 56-byte reference and its entry alias (frontier-abi world_index march.rs
// `wide_host_alias`), the reading of a wide holding's hosts out of its province's entry table, and the wide
// plaintext of a wide -> wide march.
import { seasonAddresses, withSeed } from './faddr.mjs';
import { wideHoldingAddress } from './fwide.mjs';
import { wideProvinceAddress } from './flocalplay-wide.mjs';
import { ringPosition } from './map/wide.mjs';
import { canonicalWideProvinceKey, traceWideDirections, encodeWideDirections, packWidePlain, validateWidePlain, WIDE_PLAIN_VERSION } from './fexpedition-seal.mjs';
import { setComputeUnitLimit, setComputeUnitPrice, setLoadedAccountsDataSizeLimit, requestHeapFrame } from '../sdk/frontier/budgets.mjs';
import { compileMessage } from '../sdk/solana-tx.mjs';
import { decode } from '../sdk/base58.mjs';
import { fromHex, toHex, utf8 } from '../sdk/bytes.mjs';
import { sha256 } from '../sdk/sha256.mjs';

export const WIDE_TRAIN = 'WideTrain';
export const WIDE_MUSTER = 'WideMuster';
export const WIDE_DEPART = 'WideDepart';
export const WIDE_HOST_ACTS = Object.freeze([WIDE_TRAIN, WIDE_MUSTER, WIDE_DEPART]);
// (devnet-p17, devnet gap P17: the wide village's own Harvest and Build — 0xDA op 3, the same WideEconomy as WideTrain —
//  carried ONLY by the devnet wallet-paid flow (gateway devnet-play-act.mjs); every local-play relay refuses them, as no
//  local page sends them)
export const WIDE_HARVEST = 'WideHarvest';
export const WIDE_BUILD = 'WideBuild';
export const WIDE_ECONOMY_ACTS = Object.freeze([WIDE_HARVEST, WIDE_BUILD]);
/** devnet-p17: the wide village's own acts of the devnet page (never WideDepart: the devnet build keeps its debit closed). */
export const WIDE_VILLAGE_ACTS = Object.freeze([WIDE_HARVEST, WIDE_BUILD, WIDE_TRAIN, WIDE_MUSTER]);
/** Every name this module builds. */
export const WIDE_BUILT_ACTS = Object.freeze([...WIDE_HOST_ACTS, ...WIDE_ECONOMY_ACTS]);
export const WIDE_TAG = 0xda;
export const OP_MUSTER = 1, OP_ECONOMY = 3;
export const TAG_HARVEST = 0, TAG_BUILD = 1, TAG_TRAIN = 2;
/** frontier-abi economy.rs: walls (6) and the tier-up (7) write the province's site mirror (the province writable). */
export const BUILD_ITEM_WALLS = 6, BUILD_ITEM_TIER_UP = 7;
/** The Build items the page sends (0-5 the buildings, 6 walls, 7 the tier-up; the workshop 8 is not offered, as the legacy Build). */
export const WIDE_BUILD_ITEM_MAX = 7;
/** frontier-abi world_index roster.rs `wide_roster::SIZE`: the side table the FIRST WideMuster of a province creates from the payer. */
export const WIDE_ROSTER_BYTES = 3248;
/** permutation-rules host.rs MIN_HOST_TROOPS: the smallest host a muster raises. */
export const WIDE_MIN_HOST_TROOPS = 100;
/** The runtime's ceiling: none of the three was measured on the local lane before this change (see the report). */
export const WIDE_HOST_CU = 1_400_000;
export const WIDE_HOST_HEAP = 256 * 1024;
export const FIRST_WIDE_RING = 129n;
export const HOST_ALIAS_BIT = 1n << 63n;
export const SEAL_LEN = 264;
const SYSTEM = '11111111111111111111111111111111';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const check = (ok, code) => { if (!ok) fail(code); };
const exactKeys = (x, keys) => x !== null && typeof x === 'object' && !Array.isArray(x) && Object.keys(x).length === keys.length && keys.every(k => Object.hasOwn(x, k));
const int = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const wideText = v => typeof v === 'string' && /^-?(0|[1-9][0-9]{0,17})$/.test(v);
const hex = (v, n) => typeof v === 'string' && v.length === 2 * n && /^[0-9a-f]+$/.test(v);
const ringOf = (p, q) => ringPosition(BigInt(p), BigInt(q)).ring;
const wideAt = (x, code) => {
  check(exactKeys(x, ['p', 'q']) && wideText(x.p) && wideText(x.q), code);
  let r; try { r = ringOf(x.p, x.q); } catch { fail(code); }
  check(r >= FIRST_WIDE_RING, code);
  return Object.freeze({ p: x.p, q: x.q });
};
const wideVillage = (x, code) => {
  check(exactKeys(x, ['p', 'q', 'site']) && int(x.site, 0, 11), code);
  const at = wideAt({ p: x.p, q: x.q }, code);
  return Object.freeze({ ...at, site: x.site });
};

// ------------------------------------------------------------------------------------------- addresses and identity

export const wideRosterSeed = provinceKeyHex => 'wo' + toHex(sha256(utf8('PSF-WIDE-ROSTER-SEED-v1'), fromHex(provinceKeyHex)).slice(0, 15));
export const wideTransitSeed = (holding, slot) => 'wm' + toHex(sha256(utf8('PSF-WIDE-TRANSIT-SEED-v1'), Uint8Array.from(decode(holding)), Uint8Array.of(slot)).slice(0, 15));

/** The wide accounts of one village `{p, q, site}` of the Season (`world`: the 64-hex world id). */
export function wideVillageAccounts({ programId, seasonId, world, village, standing = null }) {
  const A = seasonAddresses(programId, String(seasonId));
  const holding = wideHoldingAddress(A.season, programId, BigInt(village.p), BigInt(village.q), village.site);
  const at = standing ?? village;
  const standingKey = canonicalWideProvinceKey({ world, p: String(at.p), q: String(at.q) });
  return Object.freeze({
    season: A.season,
    holding,
    province: wideProvinceAddress(A.season, programId, String(village.p), String(village.q)),
    roster: withSeed(A.season, wideRosterSeed(canonicalWideProvinceKey({ world, p: String(village.p), q: String(village.q) })), programId),
    standing: wideProvinceAddress(A.season, programId, String(at.p), String(at.q)),
    standingRoster: withSeed(A.season, wideRosterSeed(standingKey), programId),
    transits: Object.freeze([0, 1, 2, 3].map(s => withSeed(A.season, wideTransitSeed(holding, s), programId))),
  });
}

/** The 56-byte wide host reference (hex): the village's province key, its site, generation and muster sequence. */
export function wideHostRef({ world, p, q, site, gen, seq }) {
  const b = new Uint8Array(56);
  b.set(fromHex(canonicalWideProvinceKey({ world, p: String(p), q: String(q) })));
  b[50] = site; b[51] = gen;
  new DataView(b.buffer).setUint32(52, seq, true);
  return toHex(b);
}

/** frontier-abi `wide_host_alias`: the u64 id the host's province entry carries (BigInt). */
export function wideHostAlias(refHex) {
  const h = sha256(utf8('PSF-WIDE-HOST-ALIAS-v1'), fromHex(refHex));
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(h[i]);
  return HOST_ALIAS_BIT | (v >> 1n);
}

// ------------------------------------------------------------------------------------------- reading (pure)

const PV = Object.freeze({ RESOLVED_NEXT: 72, ENTRIES: 1064, ENTRY: 48, ENTRIES_N: 56, KEEP: 4480 });
const E = Object.freeze({ ID: 0, FACTION: 8, UNIT: 9, TILE: 10, STATE: 11, TROOPS: 12, STAMINA: 16, STAMINA_BELL: 20, READY_BELL: 24, PEND_BELL: 32, PEND_OP: 36 });
const H = Object.freeze({ GEN: 69, TILE: 70, STATE: 71, FACTION: 112, HOST_SEQ: 132, RESERVE: 720 });
const dv = b => new DataView(b.buffer, b.byteOffset, b.byteLength);

/** A wide province's cursor, entries (live ones) and keep, from its account bytes (an entry's `troops` is in milli-troops, as recorded). */
export function readWideProvince(bytes) {
  const v = dv(bytes);
  check(bytes.length >= PV.KEEP + 16, 'WideProvinceBytes');
  const entries = [];
  for (let i = 0; i < PV.ENTRIES_N; i++) {
    const o = PV.ENTRIES + i * PV.ENTRY, state = bytes[o + E.STATE];
    if (state === 0) continue;
    entries.push({ index: i, id: v.getBigUint64(o + E.ID, true), faction: bytes[o + E.FACTION], unit: bytes[o + E.UNIT], tile: bytes[o + E.TILE], state,
      troops: v.getUint32(o + E.TROOPS, true), readyBell: v.getUint32(o + E.READY_BELL, true), pendOp: bytes[o + E.PEND_OP], pendBell: v.getUint32(o + E.PEND_BELL, true) });
  }
  const k = PV.KEEP;
  const keep = bytes[k] === 0xff ? null : { tile: bytes[k], holder: bytes[k + 1], contender: bytes[k + 2], progress: bytes[k + 3], required: bytes[k + 4], troops: v.getUint32(k + 8, true) };
  return { resolvedNext: v.getUint32(PV.RESOLVED_NEXT, true), entries, keep };
}

/** A wide holding's generation, tile, state, nation, next muster sequence and reserve (whole troops per unit). */
export function readWideHolding(bytes) {
  check(bytes.length >= H.RESERVE + 32, 'WideHoldingBytes');
  const v = dv(bytes);
  return { gen: bytes[H.GEN], tile: bytes[H.TILE], state: bytes[H.STATE], faction: bytes[H.FACTION], hostSeq: v.getUint32(H.HOST_SEQ, true),
    reserve: [0, 1, 2, 3, 4, 5, 6, 7].map(u => v.getUint32(H.RESERVE + 4 * u, true)) };
}

/**
 * The hosts of a wide village standing in `province` (its own, or the province a march left them in): for every
 * sequence the holding issued, the entry whose id is the host's alias. → `[{ref, seq, entry}]`.
 */
export function wideHostsIn({ world, village, holding, province }) {
  const out = [];
  for (let seq = 0; seq < Math.min(holding.hostSeq, 64); seq++) {
    const ref = wideHostRef({ world, ...village, gen: holding.gen, seq });
    const alias = wideHostAlias(ref);
    const e = province.entries.find(x => x.id === alias && x.state >= 1 && x.state <= 3);
    if (e) out.push({ ref, seq, entry: e });
  }
  return out;
}

/**
 * The wide plaintext of a WIDE host's march wide -> wide (both ends ring 129+), `fexpedition-seal`'s codec and
 * checks; the program's reveal judges passability and timing again. → `{plainHex, plain, route}`.
 */
export function prepareWideOutboundPlain({ world, host, origin, directions, arriveBell, stance = 0, retreatBps = 0 }) {
  const route = traceWideDirections({ world, origin, directions });
  check(route.pathComplete, 'EmptyPath');
  check(BigInt(route.origin.ring) >= FIRST_WIDE_RING, 'WideOriginRequired');
  check(BigInt(route.endpoint.ring) >= FIRST_WIDE_RING, 'WideDestinationRequired');
  const path = encodeWideDirections(directions);
  const plain = { version: WIDE_PLAIN_VERSION, host, arriveBell, dest: route.endpoint.key, destTile: route.endpoint.tile, stance, retreatBps, ...path, reserved: '00'.repeat(8) };
  validateWidePlain(plain, { host, arriveBell });
  return { plainHex: toHex(packWidePlain(plain)), plain, route };
}

// ------------------------------------------------------------------------------------------- the three acts

/**
 * The checked intent of one of the three acts. `subject`: `{wide: {p, q, site}}` (decimal p/q strings, ring 129+),
 * and for WideDepart also `standing: {p, q}` (where the host stands). Throws a code.
 */
export function wideHostIntent(name, subject, fields, code = 'LocalActShape') {
  check(WIDE_BUILT_ACTS.includes(name), 'LocalActNotAllowed');
  if (name === WIDE_DEPART) {
    check(exactKeys(subject, ['wide', 'standing']), code);
    const wide = wideVillage(subject.wide, code), standing = wideAt(subject.standing, code);
    check(exactKeys(fields, ['host', 'transit_slot', 'arrive_bell', 'tip', 'commit', 'seal']), code);
    check(hex(fields.host, 56) && int(fields.transit_slot, 0, 3) && int(fields.arrive_bell, 0, 0xffffffff), code);
    check(typeof fields.tip === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(fields.tip) && BigInt(fields.tip) < (1n << 64n), code);
    check(hex(fields.commit, 32) && hex(fields.seal, SEAL_LEN), code);
    // (the host is this village's: its reference names the village's province and site)
    const b = fromHex(fields.host);
    check(b[50] === wide.site, code);
    return Object.freeze({ name, subject: Object.freeze({ wide, standing }), fields: Object.freeze({ ...fields }) });
  }
  check(exactKeys(subject, ['wide']), code);
  const wide = wideVillage(subject.wide, code);
  // (devnet-p17: Harvest has no fields; Build names one item, 0-7)
  if (name === WIDE_HARVEST) {
    check(exactKeys(fields, []), code);
    return Object.freeze({ name, subject: Object.freeze({ wide }), fields: Object.freeze({}) });
  }
  if (name === WIDE_BUILD) {
    check(exactKeys(fields, ['item']) && int(fields.item, 0, WIDE_BUILD_ITEM_MAX), code);
    return Object.freeze({ name, subject: Object.freeze({ wide }), fields: Object.freeze({ item: fields.item }) });
  }
  if (name === WIDE_TRAIN) {
    check(exactKeys(fields, ['unit', 'n']) && int(fields.unit, 0, 6) && int(fields.n, 1, 0xffffffff), code);
    return Object.freeze({ name, subject: Object.freeze({ wide }), fields: Object.freeze({ unit: fields.unit, n: fields.n }) });
  }
  check(exactKeys(fields, ['unit', 'troops', 'tile']) && int(fields.unit, 0, 6) && int(fields.troops, 1, 0xffffffff) && int(fields.tile, 0, 60), code);
  return Object.freeze({ name, subject: Object.freeze({ wide }), fields: Object.freeze({ unit: fields.unit, troops: fields.troops, tile: fields.tile }) });
}

/** The 0xDA instruction of `intent` for `wallet` (actor and payer). `world`: the Season's world id (64 hex). */
export function wideHostInstruction(intent, { programId, seasonId, wallet, world }) {
  const A = seasonAddresses(programId, String(seasonId));
  const citizen = A.of('Citizen', { wallet });
  const w = intent.subject.wide;
  const acc = wideVillageAccounts({ programId, seasonId, world, village: w, standing: intent.subject.standing ?? null });
  const k = (pubkey, isWritable, isSigner = false) => ({ pubkey, isSigner, isWritable });
  const head = [k(wallet, false, true), k(wallet, true, true), k(A.season, false), k(citizen, true)];
  const env = (op, n) => { const d = new Uint8Array(4 + n); d[0] = WIDE_TAG; d[1] = 0xff; d[2] = 1; d[3] = op; return d; };
  // (devnet-p17: the action's six canonical bytes, zero padded; walls and the tier-up name the province writable —
  //  frontier-abi wide_ix ECONOMY_MIRROR — every other action read-only, as WideTrain)
  if (intent.name === WIDE_HARVEST || intent.name === WIDE_BUILD) {
    const d = env(OP_ECONOMY, 6);
    const item = intent.name === WIDE_BUILD ? intent.fields.item : null;
    if (item === null) d[4] = TAG_HARVEST; else { d[4] = TAG_BUILD; d[5] = item; }
    const mirror = item === BUILD_ITEM_WALLS || item === BUILD_ITEM_TIER_UP;
    return { programId, keys: [...head, k(acc.holding, true), k(acc.province, mirror)], data: d };
  }
  if (intent.name === WIDE_TRAIN) {
    const d = env(OP_ECONOMY, 6), v = dv(d);
    d[4] = TAG_TRAIN; d[5] = intent.fields.unit; v.setUint32(6, intent.fields.n, true);
    return { programId, keys: [...head, k(acc.holding, true), k(acc.province, false)], data: d };
  }
  if (intent.name === WIDE_MUSTER) {
    const d = env(OP_MUSTER, 6), v = dv(d);
    d[4] = intent.fields.unit; v.setUint32(5, intent.fields.troops, true); d[9] = intent.fields.tile;
    return { programId, keys: [...head, k(acc.holding, true), k(acc.province, true), k(acc.roster, true), k(SYSTEM, false)], data: d };
  }
  const f = intent.fields, d = new Uint8Array(1 + 56 + 1 + 4 + 8 + 32 + SEAL_LEN), v = dv(d);
  d[0] = WIDE_TAG; d.set(fromHex(f.host), 1); d[57] = f.transit_slot; v.setUint32(58, f.arrive_bell, true);
  v.setBigUint64(62, BigInt(f.tip), true); d.set(fromHex(f.commit), 70); d.set(fromHex(f.seal), 102);
  const keys = [...head, k(acc.holding, true), k(acc.standing, true), k(SYSTEM, false), k(acc.province, false),
    ...acc.transits.map((t, s) => k(t, s === f.transit_slot)), k(acc.standingRoster, false)];
  // (a host at home: its standing province IS the holding's own; the one account then takes the writable position's
  //  flags in the compiled message, as the deployed Depart's own account list does)
  return { programId, keys, data: d };
}

/** The whole message: the act under the runtime's compute ceiling and the local loaded-data limit, the wallet as payer. */
export function wideHostMessage(intent, { programId, seasonId, wallet, world, blockhash, loadedLimit }) {
  const prefix = [setComputeUnitLimit(WIDE_HOST_CU), setComputeUnitPrice(0n), setLoadedAccountsDataSizeLimit(loadedLimit), requestHeapFrame(WIDE_HOST_HEAP)];
  return Uint8Array.from(compileMessage({ feePayer: wallet, recentBlockhash: blockhash, instructions: [...prefix, wideHostInstruction(intent, { programId, seasonId, wallet, world })] }));
}
