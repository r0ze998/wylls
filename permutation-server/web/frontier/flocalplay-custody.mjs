// LOCAL PLAY, TEST-ONLY, COEXIST LANE ONLY — a PREVIEW of ⑨ capacity and ⑩ custody (owner rules 2026-11-21 22:01 JST,
// plan-6-9-10-12-16 §2–3), built on ② A's storehouse (the S1 Vault) and caravans:
//
//   ⑨ CAPACITY ("工房を貸す"): the owner of a workshop village lends workshop copies (a pool), and grants another player
//      the use of them for a window; that player books a job, puts ore and wood from ITS storehouse in the village's
//      Province into it, and the copies turn them into arms at the workshop's own rate over chain time. The arms (and
//      what was not used) come back into the user's storehouse; they leave it only by caravan (② A). If the village is
//      lost, the CAPTOR TAKES EVERYTHING the jobs hold (policy CaptorTakesAll — the only policy this page opens with).
//        OpenCapacityPool 0xF0 (+ LendCapacity 0xF1 in the same message)   the owner (facility's Citizen)
//        ReclaimCapacity 0xF2 · GrantCapacity 0xF3 · RevokeCapacity 0xF4   the owner (Grant/Revoke: WALLET-ONLY here)
//        ReserveCapacity 0xF5 (+ DepositToJob 0xF6 ×2: ore and wood, same message)   the user
//        SettleJob 0xF7 (anyone) · CancelJob 0xF8 · ClaimJob 0xF9 (the user) · RecordFacilityLoss 0xFA (anyone)
//   ⑩ CUSTODY ("預ける"): the keeper of a storehouse opens a lot for another player's ORE (ore only); the owner of the
//      lot sends its ore there by its own custody caravan, and takes it back by caravan. Goods in transit are the
//      CARRIER's: a caravan beaten on the road loses them. The depositor's troops do not defend the storehouse; if it
//      is seized, the lot is forfeit to the captor (ReconcileLot, anyone).
//        OpenLot 0xC2 (the keeper's WALLET) · DepositLot 0xC4 · WithdrawLot 0xCC · CloseLot 0xCB (the lot's owner)
//        SettleCustody 0xC8 · ReconcileLot 0xCA (anyone; the page sends them for the viewer's own lot)
//
// Every rule is the PROGRAM's (permutation-frontier proc/capacity.rs, proc/custody.rs, built into the coexist lane
// 0x7805 only): this module only builds the instructions from their published layouts (frontier-abi capacity.rs,
// v2/ix.rs) and reads the accounts back. Nothing here changes a devnet build or a program.
//
// This module is the ONE builder both sides use, as flocalplay-rights.mjs is for ② (the page signs; the relay rebuilds
// the stated intent and refuses anything not byte for byte the same).
//
// FOG RULE (the page's views): a player is shown only the pools, jobs and lots it is a party to — its own facility's
// pool and jobs, the jobs it booked, the lots in its own storehouse and its own lots — and never another player's
// storehouse stock. A loss is told from the viewer's side only ("your ore in that storehouse was seized"), with the
// other side named by its nation alone.
import { seasonAddresses, withSeed, citizenTag } from './faddr.mjs';
import { ringPosition } from './map/wide.mjs';
import { budgetOf, setComputeUnitLimit, setComputeUnitPrice, setLoadedAccountsDataSizeLimit, CARAVAN_FEE } from '../sdk/frontier/budgets.mjs';
import { compileMessage } from '../sdk/solana-tx.mjs';
import { decode, encode } from '../sdk/base58.mjs';
import { toHex } from '../sdk/bytes.mjs';

// ------------------------------------------------------------------ constants

export const CAP_TAGS = Object.freeze({ OpenCapacityPool: 0xf0, LendCapacity: 0xf1, ReclaimCapacity: 0xf2, GrantCapacity: 0xf3, RevokeCapacity: 0xf4,
  ReserveCapacity: 0xf5, DepositToJob: 0xf6, SettleJob: 0xf7, CancelJob: 0xf8, ClaimJob: 0xf9, RecordFacilityLoss: 0xfa });
export const CUSTODY_TAGS = Object.freeze({ OpenLot: 0xc2, DepositLot: 0xc4, SettleCustody: 0xc8, ReconcileLot: 0xca, CloseLot: 0xcb, WithdrawLot: 0xcc });
/** The page's acts (an act may hold more than one instruction: OpenCapacityPool + Lend, Reserve + two deposits). */
export const CAPACITY_ACTS = Object.freeze(['OpenCapacityPool', 'ReclaimCapacity', 'GrantCapacity', 'RevokeCapacity', 'ReserveCapacity', 'SettleJob', 'CancelJob', 'ClaimJob', 'RecordFacilityLoss']);
export const CUSTODY_ACTS = Object.freeze(['OpenLot', 'DepositLot', 'SettleCustody', 'WithdrawLot', 'ReconcileLot', 'CloseLot']);
export const PREVIEW_ACTS = Object.freeze([...CAPACITY_ACTS, ...CUSTODY_ACTS]);
/** Wallet-only (② A's rule for issuing a right, applied to lending one): a resident's relay never sends them. */
export const PREVIEW_WALLET_ONLY = Object.freeze(['GrantCapacity', 'RevokeCapacity', 'OpenLot']);
/**
 * CU limits: the v2 budget table's rows for the custody band (abi-v2-budgets.mjs, S1 profile); the capacity band has no
 * row (workstream 4's provisional band), so its limits are generous (the price is 0 in local play) — a whole pool or
 * job is decoded and re-encoded per instruction.
 */
export const CAP_CU = Object.freeze({ OpenCapacityPool: 60_000, LendCapacity: 60_000, ReclaimCapacity: 60_000, GrantCapacity: 60_000, RevokeCapacity: 80_000,
  ReserveCapacity: 80_000, DepositToJob: 60_000, SettleJob: 60_000, CancelJob: 60_000, ClaimJob: 80_000, RecordFacilityLoss: 200_000 });
/** permutation-rules holding.rs `Resource` order. */
export const RES = Object.freeze({ food: 0, wood: 1, stone: 2, ore: 3, arms: 4, gold: 5 });
export const MILLI = 1000;
/** capacity.rs: 2 ore + 1 wood per arm, 4 arms an hour per copy; a job window at most 7 days; 16 jobs, 8 grants a pool. */
export const ORE_PER_ARM = 2, WOOD_PER_ARM = 1, ARMS_PER_HOUR = 4, HOUR = 3600, MAX_WINDOW = 7 * 86_400, MAX_JOBS = 16, MAX_GRANTS = 8;
export const RECIPE_ARMS = 1;
/** The only policies this page opens a pool with: CaptorTakesAll · Unaffected · HonorBooked (owner rule ⑨: the captor takes everything). */
export const POLICIES = Object.freeze([0, 0, 0]);
export const SOURCE_VAULT = 0;
/** capacity.rs `Fin`. */
export const FIN = Object.freeze({ open: 0, completed: 1, cancelled: 2, lost: 3 });
/** custody.rs lot states; S1 caravan states and custody marks (v2 layout s1.rs). */
export const LOT_OPEN = 1, LOT_FORFEITED = 2;
/** capacity.rs `layout::{pool, job}` SIZE (the record; the account holds its rent payer and, for a job, its lot link after it). */
export const POOL_SIZE = 16 + 114 + 1 + 8 * 87 + 1 + 16 * 45, JOB_SIZE = 16 + 166 + 1 + 8 * 25;
export const CV_MOVING = 1, CV_DELIVERED = 2, CV_LOST = 3, CV_CUSTODY_LOT = 1, CV_CUSTODY_TAKEN = 2;
const SYSTEM = '11111111111111111111111111111111';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const check = (ok, code) => { if (!ok) fail(code); };
const exactKeys = (x, keys) => x !== null && typeof x === 'object' && !Array.isArray(x) && Object.keys(x).length === keys.length && keys.every(k => Object.hasOwn(x, k));
const int = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const i64Text = v => typeof v === 'string' && /^-?(0|[1-9][0-9]{0,18})$/.test(v) && BigInt(v) >= -(2n ** 63n) && BigInt(v) < 2n ** 63n;
const address = v => { try { const b = decode(v); return typeof v === 'string' && v.length <= 44 && b.length === 32 && encode(b) === v; } catch { return false; } };

// ------------------------------------------------------------------ addresses

const leBytes = (n, write) => { const b = new Uint8Array(n); write(new DataView(b.buffer)); return b; };
const poolRaw = ({ p, q, site, gen }) => leBytes(6, dv => { dv.setInt16(0, p, true); dv.setInt16(2, q, true); dv.setUint8(4, site); dv.setUint8(5, gen); });
/** frontier-abi capacity.rs: `cp‖hex(le16 p ‖ le16 q ‖ site ‖ gen)`. */
export const poolSeed = f => 'cp' + toHex(poolRaw(f));
/** `cj‖hex(pool raw ‖ le32 grant ‖ le32 job)`. */
export const jobSeed = (f, grant, job) => { const r = new Uint8Array(14); r.set(poolRaw(f)); const dv = new DataView(r.buffer); dv.setUint32(6, grant >>> 0, true); dv.setUint32(10, job >>> 0, true); return 'cj' + toHex(r); };
/** frontier-abi v2/addr.rs: `cl‖hex(le16 p ‖ le16 q ‖ tile ‖ gen ‖ le64 owner_tag ‖ resource)`. */
export const lotSeed = ({ p, q, tile, gen }, ownerTag, resource = RES.ore) => 'cl' + toHex(leBytes(15, dv => {
  dv.setInt16(0, p, true); dv.setInt16(2, q, true); dv.setUint8(4, tile); dv.setUint8(5, gen); dv.setBigUint64(6, BigInt(ownerTag), true); dv.setUint8(14, resource);
}));
export const poolAddress = (seasonAddress, programId, f) => withSeed(seasonAddress, poolSeed(f), programId);
export const jobAddress = (seasonAddress, programId, f, grant, job) => withSeed(seasonAddress, jobSeed(f, grant, job), programId);
export const lotAddress = (seasonAddress, programId, vault, ownerTag, resource = RES.ore) => withSeed(seasonAddress, lotSeed(vault, ownerTag, resource), programId);
/** The tag of a Citizen address (decimal text). */
export const tagOf = citizen => citizenTag(citizen).toString();

// ------------------------------------------------------------------ reading accounts

const reader = b => {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let o = 0;
  const r = {
    at: x => { o = x; return r; }, off: () => o,
    u8: () => b[o++], i16: () => { const v = dv.getInt16(o, true); o += 2; return v; }, u32: () => { const v = dv.getUint32(o, true); o += 4; return v; },
    i64: () => { const v = dv.getBigInt64(o, true); o += 8; return v; }, u64: () => { const v = dv.getBigUint64(o, true); o += 8; return v; },
    key: () => { const v = encode(b.subarray(o, o + 32)); o += 32; return v; },
    optI64: () => { const f = r.u8(), v = r.i64(); return f === 1 ? v : null; }, optU32: () => { const f = r.u8(), v = r.u32(); return f === 1 ? v : null; },
  };
  return r;
};
const magicIs = (b, m) => b instanceof Uint8Array && b.length >= 8 && String.fromCharCode(...b.subarray(0, 8)) === m;
const n = v => Number(v);

/** capacity.rs `layout::pool` (the account starts with the record): the pool's fields, or null. Times are numbers (secs). */
export function decodePool(bytes) {
  if (!magicIs(bytes, 'PSF1CPOL') || bytes.length < POOL_SIZE) return null;
  const r = reader(bytes).at(16);
  const facility = { p: r.i16(), q: r.i16(), site: r.u8(), gen: r.u8() };
  const owner = r.key(), policies = [r.u8(), r.u8(), r.u8()], lent = r.u32(), ownerSeq = r.u32();
  r.u8(); r.u8(); r.u32(); r.u32();   // (the last owner op)
  const lostAt = r.optI64(), hasCaptor = r.u8(), captor = r.key(), lastGrantSeq = r.optU32(); r.u64();
  const ng = r.u8(), grants = [];
  for (let i = 0; i < 8; i++) {
    const start = r.off();
    if (i < ng) grants.push({ seq: r.u32(), user: r.key(), recipe: r.u8(), maxUnits: r.u32(), maxOutput: n(r.i64()), from: n(r.i64()), until: n(r.i64()), revokedAt: (x => (x === null ? null : n(x)))(r.optI64()), spent: n(r.i64()), lastJobSeq: r.optU32() });
    r.at(start + 87);
  }
  const nj = r.u8(), occ = [];
  for (let i = 0; i < 16; i++) {
    const start = r.off();
    if (i < nj) occ.push({ grant: r.u32(), job: r.u32(), units: r.u32(), start: n(r.i64()), end: n(r.i64()), endEff: n(r.i64()), open: r.u8() === 1, budget: n(r.i64()) });
    r.at(start + 45);
  }
  if (ng > 8 || nj > 16) return null;
  return Object.freeze({ facility, owner, policies, lent, ownerSeq, lostAt: lostAt === null ? null : n(lostAt), captor: hasCaptor === 1 ? captor : null, lastGrantSeq, grants, occ });
}

/** capacity.rs `layout::job`: the job's fields (amounts in milli), or null. */
export function decodeJob(bytes) {
  if (!magicIs(bytes, 'PSF1CJOB') || bytes.length < JOB_SIZE) return null;
  const r = reader(bytes).at(16);
  const j = { grant: r.u32(), seq: r.u32() }; r.u64();
  Object.assign(j, { user: r.key(), recipe: r.u8(), units: r.u32(), start: n(r.i64()), end: n(r.i64()), maxOutput: n(r.i64()), hopper: [n(r.i64()), n(r.i64())] });
  const fc = r.u8(), ft = n(r.i64());
  Object.assign(j, { fin: fc, finAt: ft, settled: n(r.i64()) }); r.u8();
  Object.assign(j, { claimed: n(r.i64()), refunded: r.u8() === 1, returned: [n(r.i64()), n(r.i64())], forfeitedIn: [n(r.i64()), n(r.i64())], forfeitedOut: n(r.i64()) });
  if (fc > 3) return null;
  return Object.freeze(j);
}

/** v2 layout s1 `Lot` (576 B): the lot's fields (amounts in milli), or null. */
export function decodeLot(bytes) {
  if (!magicIs(bytes, 'PSF1CLOT') || bytes.length !== 576) return null;
  const r = reader(bytes).at(64);
  const l = { p: r.i16(), q: r.i16(), tile: r.u8(), vaultGen: r.u8(), resource: r.u8(), state: r.u8(), owner: r.key(), ownerTag: r.u64().toString(), custodianTag: r.u64().toString(),
    quota: n(r.i64()), held: n(r.i64()), inTotal: n(r.i64()), outTotal: n(r.i64()), consumed: n(r.i64()), forfeited: n(r.i64()) };
  const inbound = [];
  for (let i = 0; i < 4; i++) { r.at(432 + i * 24); const tag = r.u64().toString(), seq = r.u32(), live = r.u8() === 1; r.at(432 + i * 24 + 16); const qty = n(r.i64()); if (live) inbound.push({ tag, seq, qty }); }
  r.at(528);
  return Object.freeze({ ...l, inbound, rentTo: r.key() });
}

/** v2 layout s1 `Caravan` (320 B): what this page needs of a caravan (its state, end, path, arrival, cargo, custody mark). */
export function decodeCaravan(bytes) {
  if (!magicIs(bytes, 'PSF1CRVN') || bytes.length !== 320) return null;
  const r = reader(bytes).at(64);
  const c = { ownerCitizen: r.key(), ownerTag: r.u64().toString(), seq: r.u32(), faction: r.u8(), state: r.u8(), steps: r.u8(), nProv: r.u8() };
  const place = at => { r.at(at); const kind = r.u8(), p = r.i16(), q = r.i16(), x = r.u8(), gen = r.u8(); return kind === 2 ? { kind: 'vault', p, q, tile: x, gen } : { kind: 'holding', p, q, site: x, gen }; };
  c.src = place(112); c.dst = place(128);
  r.at(156); const provinces = [];
  for (let i = 0; i < 4; i++) { const p = r.i16(), q = r.i16(); if (i < Math.min(c.nProv, 4)) provinces.push({ p, q }); }
  r.at(180); c.arriveTs = n(r.i64());
  r.at(192); c.cargo = Array.from({ length: 8 }, () => n(r.i64()));
  r.at(264); c.rentTo = r.key();
  r.at(296); c.custody = r.u8(); c.custodyResource = r.u8();
  r.at(304); c.custodyOwnerTag = r.u64().toString(); c.takenByTag = r.u64().toString();
  return Object.freeze({ ...c, provinces });
}

// ------------------------------------------------------------------ intents

function village(h, code) {
  check(exactKeys(h, ['p', 'q', 'site', 'gen']) && Number.isSafeInteger(h.p) && Number.isSafeInteger(h.q) && int(h.site, 0, 11) && int(h.gen, 0, 255), code);
  let ring; try { ring = ringPosition(BigInt(h.p), BigInt(h.q)).ring; } catch { fail(code); }
  check(ring <= 128n, 'LocalActWideHolding');
  return Object.freeze({ p: h.p, q: h.q, site: h.site, gen: h.gen });
}
function vaultRef(t, code) {
  check(exactKeys(t, ['p', 'q', 'tile', 'gen']) && Number.isSafeInteger(t.p) && Number.isSafeInteger(t.q) && int(t.tile, 0, 60) && int(t.gen, 0, 255), code);
  let ring; try { ring = ringPosition(BigInt(t.p), BigInt(t.q)).ring; } catch { fail(code); }
  check(ring <= 128n, 'LocalActWideHolding');
  return Object.freeze({ p: t.p, q: t.q, tile: t.tile, gen: t.gen });
}
function place(x, code) {
  check(x !== null && typeof x === 'object' && (x.kind === 'holding' || x.kind === 'vault'), code);
  if (x.kind === 'holding') { check(exactKeys(x, ['kind', 'p', 'q', 'site', 'gen']), code); return Object.freeze({ kind: 'holding', ...village({ p: x.p, q: x.q, site: x.site, gen: x.gen }, code) }); }
  check(exactKeys(x, ['kind', 'p', 'q', 'tile', 'gen']), code);
  return Object.freeze({ kind: 'vault', ...vaultRef({ p: x.p, q: x.q, tile: x.tile, gen: x.gen }, code) });
}
const provinceList = (a, code) => {
  check(Array.isArray(a) && a.length >= 1 && a.length <= 4, code);
  return Object.freeze(a.map(x => { check(exactKeys(x, ['p', 'q']) && Number.isSafeInteger(x.p) && Number.isSafeInteger(x.q), code); return Object.freeze({ p: x.p, q: x.q }); }));
};
const caravanList = (a, code) => {
  check(Array.isArray(a) && a.length <= 4, code);
  return Object.freeze(a.map(x => { check(exactKeys(x, ['tag', 'seq']) && typeof x.tag === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(x.tag) && BigInt(x.tag) <= 0xffffffffffffffffn && int(x.seq, 0, 0xffffffff), code); return Object.freeze({ tag: x.tag, seq: x.seq }); }));
};
const walk = (f, code) => check(int(f.steps, 1, 32) && Array.isArray(f.path) && f.path.length === 12 && f.path.every(x => int(x, 0, 255)) && f.fee === CARAVAN_FEE.toString(), code);
const gj = (f, code) => check(int(f.grant, 0, 0xffffffff) && int(f.job, 0, 0xffffffff), code);
const times = (f, keys, code) => check(keys.every(k => i64Text(f[k]) && BigInt(f[k]) > 0n), code);

/**
 * The checked intent `{name, subject, fields}` (plain JSON; what the page and the relay build from). Throws `code` (or
 * `LocalActWideHolding`) for anything else:
 *   OpenCapacityPool   subject {facility}   fields {policies: [0,0,0], lend: 1-64, seq}   (the pool opened if `open`, then Lend)
 *                      — `open` (boolean) says whether the message carries OpenCapacityPool first (a pool already open: Lend alone)
 *   ReclaimCapacity    subject {facility}   fields {units 1-64, seq}
 *   GrantCapacity      subject {facility, user: Citizen}   fields {grant, max_units 1-64, max_output (milli), from, until}
 *   RevokeCapacity     subject {facility}   fields {grant}
 *   ReserveCapacity    subject {facility, vault}   fields {grant, job, units, start, end, max_output, ore, wood, deposit}
 *                      (ore, wood in milli; `deposit` the first deposit id: the ore's, the wood's is deposit + 1)
 *   SettleJob / CancelJob / ClaimJob   subject {facility[, vault]}   fields {grant, job}   (ClaimJob names the user's vault)
 *   RecordFacilityLoss subject {facility, jobs: [{grant, job}] 0-16}   fields {}
 *   OpenLot            subject {vault, owner: Citizen}   fields {quota 1-…}   (ore)
 *   DepositLot         subject {seq, src: place, vault, provinces}   fields {seq, qty, steps, path, fee}
 *   WithdrawLot        subject {seq, vault, dst: place, provinces}   fields {seq, qty, steps, path, fee}
 *   SettleCustody      subject {seq, vault, owner_tag, provinces}   fields {}    (the viewer's own custody caravan `seq`)
 *   ReconcileLot       subject {vault, owner_tag, caravans: [{tag, seq}] 0-4}   fields {}
 *   CloseLot           subject {vault, owner_tag, rent_to}   fields {}
 */
export function previewIntent(name, subject, fields, code = 'LocalActShape') {
  check(PREVIEW_ACTS.includes(name), 'LocalActNotAllowed');
  const s = subject, f = fields;
  check(s !== null && typeof s === 'object' && !Array.isArray(s) && f !== null && typeof f === 'object' && !Array.isArray(f), code);
  const out = (subj, flds) => Object.freeze({ name, subject: Object.freeze(subj), fields: Object.freeze(flds) });
  switch (name) {
    case 'OpenCapacityPool': {
      check(exactKeys(s, ['facility', 'open']) && typeof s.open === 'boolean' && exactKeys(f, ['policies', 'lend', 'seq']) && Array.isArray(f.policies)
        && f.policies.length === 3 && f.policies.every((x, i) => x === POLICIES[i]) && int(f.lend, 1, 64) && int(f.seq, 0, 0xffffffff), code);
      return out({ facility: village(s.facility, code), open: s.open }, { policies: [...POLICIES], lend: f.lend, seq: f.seq });
    }
    case 'ReclaimCapacity':
      check(exactKeys(s, ['facility']) && exactKeys(f, ['units', 'seq']) && int(f.units, 1, 64) && int(f.seq, 0, 0xffffffff), code);
      return out({ facility: village(s.facility, code) }, { units: f.units, seq: f.seq });
    case 'GrantCapacity':
      check(exactKeys(s, ['facility', 'user']) && address(s.user) && exactKeys(f, ['grant', 'max_units', 'max_output', 'from', 'until']) && int(f.grant, 0, 0xffffffff)
        && int(f.max_units, 1, 64) && i64Text(f.max_output) && BigInt(f.max_output) > 0n, code);
      times(f, ['from', 'until'], code); check(BigInt(f.from) < BigInt(f.until), code);
      return out({ facility: village(s.facility, code), user: s.user }, { grant: f.grant, max_units: f.max_units, max_output: f.max_output, from: f.from, until: f.until });
    case 'RevokeCapacity':
      check(exactKeys(s, ['facility']) && exactKeys(f, ['grant']) && int(f.grant, 0, 0xffffffff), code);
      return out({ facility: village(s.facility, code) }, { grant: f.grant });
    case 'ReserveCapacity': {
      check(exactKeys(s, ['facility', 'vault']) && exactKeys(f, ['grant', 'job', 'units', 'start', 'end', 'max_output', 'ore', 'wood', 'deposit']), code);
      gj(f, code); check(int(f.units, 1, 64) && i64Text(f.max_output) && BigInt(f.max_output) > 0n && int(f.ore, 0, 2 ** 40) && int(f.wood, 0, 2 ** 40) && f.ore + f.wood > 0
        && Number.isSafeInteger(f.deposit) && f.deposit >= 0 && f.deposit < 2 ** 52, code);
      times(f, ['start', 'end'], code); check(BigInt(f.start) < BigInt(f.end) && BigInt(f.end) - BigInt(f.start) <= BigInt(MAX_WINDOW), code);
      const facility = village(s.facility, code), vault = vaultRef(s.vault, code);
      check(facility.p === vault.p && facility.q === vault.q, code);
      return out({ facility, vault }, { grant: f.grant, job: f.job, units: f.units, start: f.start, end: f.end, max_output: f.max_output, ore: f.ore, wood: f.wood, deposit: f.deposit });
    }
    case 'SettleJob': case 'CancelJob':
      check(exactKeys(s, ['facility']) && exactKeys(f, ['grant', 'job']), code); gj(f, code);
      return out({ facility: village(s.facility, code) }, { grant: f.grant, job: f.job });
    case 'ClaimJob': {
      check(exactKeys(s, ['facility', 'vault']) && exactKeys(f, ['grant', 'job']), code); gj(f, code);
      const facility = village(s.facility, code), vault = vaultRef(s.vault, code);
      check(facility.p === vault.p && facility.q === vault.q, code);
      return out({ facility, vault }, { grant: f.grant, job: f.job });
    }
    case 'RecordFacilityLoss':
      check(exactKeys(s, ['facility', 'jobs']) && Array.isArray(s.jobs) && s.jobs.length <= MAX_JOBS && exactKeys(f, []), code);
      return out({ facility: village(s.facility, code), jobs: Object.freeze(s.jobs.map(x => { check(exactKeys(x, ['grant', 'job']), code); gj(x, code); return Object.freeze({ grant: x.grant, job: x.job }); })) }, {});
    case 'OpenLot':
      check(exactKeys(s, ['vault', 'owner']) && address(s.owner) && exactKeys(f, ['quota']) && int(f.quota, 1, 1_000_000), code);
      return out({ vault: vaultRef(s.vault, code), owner: s.owner }, { quota: f.quota });
    case 'DepositLot': {
      check(exactKeys(s, ['seq', 'src', 'vault', 'provinces']) && int(s.seq, 0, 0xffffffff) && exactKeys(f, ['seq', 'qty', 'steps', 'path', 'fee']) && f.seq === s.seq && int(f.qty, 1, 1_000_000), code);
      walk(f, code);
      return out({ seq: s.seq, src: place(s.src, code), vault: vaultRef(s.vault, code), provinces: provinceList(s.provinces, code) },
        { seq: f.seq, qty: f.qty, steps: f.steps, path: Object.freeze([...f.path]), fee: f.fee });
    }
    case 'WithdrawLot': {
      check(exactKeys(s, ['seq', 'vault', 'dst', 'provinces']) && int(s.seq, 0, 0xffffffff) && exactKeys(f, ['seq', 'qty', 'steps', 'path', 'fee']) && f.seq === s.seq && int(f.qty, 1, 1_000_000), code);
      walk(f, code);
      return out({ seq: s.seq, vault: vaultRef(s.vault, code), dst: place(s.dst, code), provinces: provinceList(s.provinces, code) },
        { seq: f.seq, qty: f.qty, steps: f.steps, path: Object.freeze([...f.path]), fee: f.fee });
    }
    case 'SettleCustody':
      check(exactKeys(s, ['seq', 'vault', 'owner_tag', 'provinces']) && int(s.seq, 0, 0xffffffff) && caravanList([{ tag: s.owner_tag, seq: s.seq }], code) && exactKeys(f, []), code);
      return out({ seq: s.seq, vault: vaultRef(s.vault, code), owner_tag: s.owner_tag, provinces: provinceList(s.provinces, code) }, {});
    case 'ReconcileLot':
      check(exactKeys(s, ['vault', 'owner_tag', 'caravans']) && caravanList([{ tag: s.owner_tag, seq: 0 }], code) && exactKeys(f, []), code);
      return out({ vault: vaultRef(s.vault, code), owner_tag: s.owner_tag, caravans: caravanList(s.caravans, code) }, {});
    case 'CloseLot':
      check(exactKeys(s, ['vault', 'owner_tag', 'rent_to']) && caravanList([{ tag: s.owner_tag, seq: 0 }], code) && address(s.rent_to) && exactKeys(f, []), code);
      return out({ vault: vaultRef(s.vault, code), owner_tag: s.owner_tag, rent_to: s.rent_to }, {});
    default: return fail('LocalActNotAllowed');
  }
}

/** The intent from what the page's order carries (`v` = the subject; byte arrays and bigints converted to wire form). */
export function previewIntentOf(name, v, fields) {
  const f = { ...(fields ?? {}) };
  if (f.path instanceof Uint8Array) f.path = Array.from(f.path);
  if (typeof f.fee === 'bigint') f.fee = f.fee.toString();
  for (const k of ['max_output', 'from', 'until', 'start', 'end']) if (typeof f[k] === 'bigint' || typeof f[k] === 'number') f[k] = String(f[k]);
  const s = {};
  for (const k of Object.keys(v ?? {})) s[k] = v[k];
  return previewIntent(name, s, f, 'LocalActShape');
}

// ------------------------------------------------------------------ instructions

const k = (pubkey, isSigner, isWritable) => ({ pubkey, isSigner, isWritable });
const data = (n, write) => { const d = new Uint8Array(n); write(new DataView(d.buffer), d); return d; };
const placeKind = x => (x.kind === 'vault' ? 2 : 1);
const placeAt = x => (x.kind === 'vault' ? x.tile : x.site);

/** The instructions of `intent` for `wallet` (actor, payer and fee payer) in Season `seasonId` of `programId`. */
export function previewInstructions(intent, { programId, seasonId, wallet }) {
  check(PREVIEW_ACTS.includes(intent.name), 'LocalActNotAllowed');
  const A = seasonAddresses(programId, String(seasonId));
  const citizen = A.of('Citizen', { wallet });
  const s = intent.subject, f = intent.fields;
  const player = [k(wallet, true, false), k(wallet, true, true), k(A.season, false, false), k(citizen, false, true)];
  const anyone = [k(wallet, true, true), k(A.season, false, false)];
  const ix = (tag, keys, d) => ({ name: Object.keys(CAP_TAGS).find(x => CAP_TAGS[x] === tag) ?? Object.keys(CUSTODY_TAGS).find(x => CUSTODY_TAGS[x] === tag), programId, keys, data: d });
  if (intent.name in CUSTODY_TAGS || intent.name === 'OpenLot') {
    const vault = A.of('Vault', s.vault);
    switch (intent.name) {
      case 'OpenLot': {
        const lot = lotAddress(A.season, programId, s.vault, tagOf(s.owner));
        return [ix(0xc2, [...player, k(vault, false, true), k(s.owner, false, false), k(lot, false, true), k(SYSTEM, false, false)],
          data(6, (dv, d) => { d[0] = 0xc2; d[1] = RES.ore; dv.setUint32(2, f.quota, true); }))];
      }
      case 'DepositLot': {
        const lot = lotAddress(A.season, programId, s.vault, tagOf(citizen));
        const src = s.src.kind === 'vault' ? A.of('Vault', s.src) : A.of('Holding', s.src);
        const caravan = A.of('Caravan', { ownerTag: citizenTag(citizen), seq: s.seq });
        return [ix(0xc4, [...player, k(src, false, true), k(vault, false, false), k(lot, false, true), k(caravan, false, true), k(SYSTEM, false, false),
          ...s.provinces.map(pq => k(A.of('Province', pq), false, true))],
        data(30, (dv, d) => { d[0] = 0xc4; dv.setUint32(1, f.seq, true); dv.setUint32(5, f.qty, true); d[9] = f.steps; d.set(f.path, 10); dv.setBigUint64(22, BigInt(f.fee), true); }))];
      }
      case 'WithdrawLot': {
        const lot = lotAddress(A.season, programId, s.vault, tagOf(citizen));
        const dst = s.dst.kind === 'vault' ? A.of('Vault', s.dst) : A.of('Holding', s.dst);
        const caravan = A.of('Caravan', { ownerTag: citizenTag(citizen), seq: s.seq });
        return [ix(0xcc, [...player, k(vault, false, true), k(lot, false, true), k(dst, false, false), k(caravan, false, true), k(SYSTEM, false, false),
          ...s.provinces.map(pq => k(A.of('Province', pq), false, true))],
        data(37, (dv, d) => {
          d[0] = 0xcc; dv.setUint32(1, f.seq, true); dv.setUint32(5, f.qty, true); d[9] = placeKind(s.dst); dv.setInt16(10, s.dst.p, true); dv.setInt16(12, s.dst.q, true);
          d[14] = placeAt(s.dst); d[15] = s.dst.gen; d[16] = f.steps; d.set(f.path, 17); dv.setBigUint64(29, BigInt(f.fee), true);
        }))];
      }
      case 'SettleCustody': {
        // (the caravan is the viewer's own: its rent and escrowed fee come back to this wallet, which sent it on this path)
        const caravan = A.of('Caravan', { ownerTag: BigInt(tagOf(citizen)), seq: s.seq });
        const lot = lotAddress(A.season, programId, s.vault, s.owner_tag);
        return [ix(0xc8, [...anyone, k(caravan, false, true), k(vault, false, false), k(lot, false, true), k(wallet, false, true), k(wallet, false, true),
          ...s.provinces.map(pq => k(A.of('Province', pq), false, false))], data(33, (_, d) => { d[0] = 0xc8; d.set(decode(wallet), 1); }))];
      }
      case 'ReconcileLot': {
        const lot = lotAddress(A.season, programId, s.vault, s.owner_tag);
        return [ix(0xca, [...anyone, k(vault, false, true), k(lot, false, true), ...s.caravans.map(c => k(A.of('Caravan', { ownerTag: BigInt(c.tag), seq: c.seq }), false, false))], Uint8Array.of(0xca))];
      }
      case 'CloseLot': {
        const lot = lotAddress(A.season, programId, s.vault, s.owner_tag);
        return [ix(0xcb, [...player, k(vault, false, true), k(lot, false, true), k(s.rent_to, false, true)], Uint8Array.of(0xcb))];
      }
    }
  }
  const fac = s.facility, holding = A.of('Holding', fac), pool = poolAddress(A.season, programId, fac);
  const job = (g, j) => jobAddress(A.season, programId, fac, g, j);
  switch (intent.name) {
    case 'OpenCapacityPool': {
      const lend = ix(0xf1, [...player, k(holding, false, true), k(pool, false, true)], data(9, (dv, d) => { d[0] = 0xf1; dv.setUint32(1, f.lend, true); dv.setUint32(5, f.seq, true); }));
      if (!s.open) return [lend];
      return [ix(0xf0, [...player, k(holding, false, false), k(pool, false, true), k(SYSTEM, false, false)], Uint8Array.of(0xf0, ...f.policies)), lend];
    }
    case 'ReclaimCapacity':
      return [ix(0xf2, [...player, k(holding, false, true), k(pool, false, true)], data(9, (dv, d) => { d[0] = 0xf2; dv.setUint32(1, f.units, true); dv.setUint32(5, f.seq, true); }))];
    case 'GrantCapacity':
      return [ix(0xf3, [...player, k(holding, false, false), k(pool, false, true)], data(66, (dv, d) => {
        d[0] = 0xf3; dv.setUint32(1, f.grant, true); d.set(decode(s.user), 5); d[37] = RECIPE_ARMS; dv.setUint32(38, f.max_units, true);
        dv.setBigInt64(42, BigInt(f.max_output), true); dv.setBigInt64(50, BigInt(f.from), true); dv.setBigInt64(58, BigInt(f.until), true);
      }))];
    case 'RevokeCapacity':   // (HonorBooked: no booked job is listed)
      return [ix(0xf4, [...player, k(holding, false, false), k(pool, false, true)], data(5, (dv, d) => { d[0] = 0xf4; dv.setUint32(1, f.grant, true); }))];
    case 'ReserveCapacity': {
      const jb = job(f.grant, f.job), vault = A.of('Vault', s.vault);
      const out = [ix(0xf5, [...player, k(holding, false, false), k(pool, false, true), k(jb, false, true), k(SYSTEM, false, false)], data(37, (dv, d) => {
        d[0] = 0xf5; dv.setUint32(1, f.grant, true); dv.setUint32(5, f.job, true); dv.setUint32(9, f.units, true);
        dv.setBigInt64(13, BigInt(f.start), true); dv.setBigInt64(21, BigInt(f.end), true); dv.setBigInt64(29, BigInt(f.max_output), true);
      }))];
      const dep = (id, res, amount) => ix(0xf6, [...player, k(holding, false, false), k(pool, false, true), k(jb, false, true), k(vault, false, true)], data(32, (dv, d) => {
        d[0] = 0xf6; dv.setUint32(1, f.grant, true); dv.setUint32(5, f.job, true); dv.setBigUint64(9, BigInt(id), true); d[17] = res;
        dv.setBigInt64(18, BigInt(amount), true); d[26] = SOURCE_VAULT; d[27] = 0; dv.setUint32(28, 0, true);
      }));
      if (f.ore > 0) out.push(dep(f.deposit, RES.ore, f.ore));
      if (f.wood > 0) out.push(dep(f.deposit + 1, RES.wood, f.wood));
      return out;
    }
    case 'SettleJob':
      return [ix(0xf7, [...anyone, k(holding, false, false), k(pool, false, true), k(job(f.grant, f.job), false, true)], data(9, (dv, d) => { d[0] = 0xf7; dv.setUint32(1, f.grant, true); dv.setUint32(5, f.job, true); }))];
    case 'CancelJob':
      return [ix(0xf8, [...player, k(holding, false, false), k(pool, false, true), k(job(f.grant, f.job), false, true)], data(9, (dv, d) => { d[0] = 0xf8; dv.setUint32(1, f.grant, true); dv.setUint32(5, f.job, true); }))];
    case 'ClaimJob':
      return [ix(0xf9, [...player, k(holding, false, false), k(pool, false, true), k(job(f.grant, f.job), false, true), k(A.of('Vault', s.vault), false, true)],
        data(9, (dv, d) => { d[0] = 0xf9; dv.setUint32(1, f.grant, true); dv.setUint32(5, f.job, true); }))];
    case 'RecordFacilityLoss':
      return [ix(0xfa, [...anyone, k(holding, false, true), k(pool, false, true), ...s.jobs.map(x => k(job(x.grant, x.job), false, true))], Uint8Array.of(0xfa))];
  }
  return fail('LocalActNotAllowed');
}

/** The CU limit of one message (the sum of its instructions' rows). */
export function previewCuLimit(ixs, profile = 3) {
  let cu = 0;
  for (const x of ixs) {
    if (x.name in CAP_CU) cu += CAP_CU[x.name];
    else cu += budgetOf(x.name, profile)?.cuLimit ?? fail('LocalActNotAllowed');
  }
  return Math.min(1_400_000, cu);
}

/** The whole message of a ⑨/⑩ act: its instructions under one compute budget, the wallet the only signature. */
export function previewMessage(intent, { programId, seasonId, wallet, blockhash, loadedLimit, profile = 3 }) {
  const ixs = previewInstructions(intent, { programId, seasonId, wallet });
  const prefix = [setComputeUnitLimit(previewCuLimit(ixs, profile)), setComputeUnitPrice(0n), setLoadedAccountsDataSizeLimit(loadedLimit)];
  return Uint8Array.from(compileMessage({ feePayer: wallet, recentBlockhash: blockhash, instructions: [...prefix, ...ixs.map(({ programId: pid, keys, data: d }) => ({ programId: pid, keys, data: d }))] }));
}

// ------------------------------------------------------------------ planning (pure; the program checks again)

/** Seconds `units` copies need to make `arms` whole arms (capacity.rs `secs_for`, ceil). */
export const secsFor = (units, arms) => (units > 0 && arms > 0 ? Math.ceil((arms * MILLI * HOUR) / (units * ARMS_PER_HOUR * MILLI)) : 0);
/** A job's plan from what the user asks: `{units, arms, start, end, maxOutput (milli), ore, wood (milli)}`. */
export function jobPlan({ units, arms, now, lead = 120 }) {
  const start = Math.floor(now) + lead, end = start + Math.max(1, secsFor(units, arms));
  return { units, arms, start, end, maxOutput: arms * MILLI, ore: arms * ORE_PER_ARM * MILLI, wood: arms * WOOD_PER_ARM * MILLI };
}
/** The output a job has made by `t` (milli; capacity.rs `out_at`, the window and the hopper bound it). */
export function jobOutAt(j, t) {
  const fed = Math.min(Math.floor(j.hopper[0] / (ORE_PER_ARM * MILLI)), Math.floor(j.hopper[1] / (WOOD_PER_ARM * MILLI))) * MILLI;
  const limit = Math.min(j.maxOutput, fed);
  const until = j.fin === FIN.open ? t : Math.min(t, j.finAt);
  const secs = Math.max(0, Math.min(until, j.end) - j.start);
  return Math.min(limit, Math.floor((j.units * ARMS_PER_HOUR * MILLI * secs) / HOUR));
}
/** The next grant seq of a pool (past every grant it ever held) and a grant's next job seq. */
export const nextGrantSeq = pool => (pool?.lastGrantSeq === null || pool?.lastGrantSeq === undefined ? 0 : pool.lastGrantSeq + 1);
export const nextJobSeq = grant => (grant?.lastJobSeq === null || grant?.lastJobSeq === undefined ? 0 : grant.lastJobSeq + 1);

/** What the page needs of a legacy Holding (v2 layout, 1280 B): place, generation, owner, nation, workshop copies (milli→count). */
export function decodeHoldingBrief(bytes) {
  if (!magicIs(bytes, 'PSF1HOLD') || bytes.length < 704) return null;
  const r = reader(bytes).at(64);
  const h = { p: r.i16(), q: r.i16(), site: r.u8(), gen: r.u8(), tile: r.u8(), state: r.u8(), ownerCitizen: r.key() };
  r.at(112); h.faction = r.u8();
  r.at(472 + 8 * RES.arms); h.workshops = Math.floor(n(r.i64()) / (ARMS_PER_HOUR * MILLI));
  r.at(700); h.lent = r.u32();
  // (PREV_GEN @1256, CAPTURED_BELL @1260: a capture moves the village to the next generation — the pool and jobs of the
  //  generation before stay at their own addresses, which carry that generation)
  if (bytes.length >= 1264) { r.at(1256); h.prevGen = r.u8(); r.at(1260); h.capturedBell = r.u32(); } else { h.prevGen = 0; h.capturedBell = 0; }
  return Object.freeze(h);
}

// ------------------------------------------------------------------ what to read (pure)

/** How many generations before a storehouse's present one its lots are still looked for (each seizure is one). */
export const LOT_GEN_LOOKBACK = 2;
/**
 * The lots to read: `[{vault, owner}]` (the vault as the lot's address needs it: p, q, tile and the lot's generation).
 * A lot's address carries its storehouse's generation, and a seizure moves the storehouse to the next one (SeizeVault:
 * gen + 1) — read only at the present generation, a seized storehouse's lots would vanish from both sides and the loss
 * would never be told. So: the present generation (the viewer's storehouses for every other player with a village in
 * that Province; another's storehouse for the viewer), the generations before (up to LOT_GEN_LOOKBACK, both roles:
 * the lot's own `custodianTag` and `owner` tell which side the viewer was), and every lot read before, again by its own
 * address (`known`), and every lot the storehouse's own LOT LIST found (`listed`, listedLots below: owner 2026-11-26
 * 10:52 answer 8 / Q-TG2-1 — the keeper sees every lot in its own storehouse, also a depositor's whose village there was
 * captured or left, who is no longer among the Province's villagers).
 */
export function lotReadPlan({ vaults = [], holdings = [], viewer, known = [], listed = [] }) {
  const out = new Map();
  const add = (vault, owner) => { const key = `${vault.p},${vault.q},${vault.tile},${vault.gen}:${owner}`; if (!out.has(key)) out.set(key, { vault, owner }); };
  for (const v of vaults) {
    const others = [...new Set(holdings.filter(h => h.ownerCitizen !== viewer && h.p === v.p && h.q === v.q).map(h => h.ownerCitizen))];
    if (v.ownerCitizen === viewer) for (const o of others) add(v, o);
    else add(v, viewer);
    for (let g = Number(v.gen) - 1; g >= Math.max(1, Number(v.gen) - LOT_GEN_LOOKBACK); g--) {
      const before = { p: v.p, q: v.q, tile: v.tile, gen: g, ownerCitizen: null, faction: null };
      add(before, viewer);
      for (const o of others) add(before, o);
    }
  }
  for (const e of known) add(e.vault, e.owner);
  for (const e of listed) add(e.vault, e.owner);
  return [...out.values()];
}
/** The relay's read-only lot list of one storehouse (permutation-gateway local-play-act.mjs LOCAL_ACT_LOTS_READ_SCHEMA). */
export const LOT_LIST_SCHEMA = 'frontier-local-play-act-lots-read-v1';
/**
 * (owner-answers-logic, Q-TG2-1) The lots of storehouse `vault` that its lot list named (`addresses`, the relay's answer)
 * and that were read back (`accounts`: Map address → bytes | null): `[{vault, owner}]` — only a Lot whose OWN bytes name
 * that storehouse place and generation and derive that very address (`lotAddress(seasonAddress, programId, vault,
 * ownerTag, resource)`), of ore (the only resource this page opens lots for), and whose owner Citizen's tag is its owner
 * tag. So the list's word alone adds nothing: an address the relay made up, another season's or another storehouse's
 * lot is dropped here. `vault` is passed through as given (the planner's key: p, q, tile, gen).
 */
export function listedLots({ vault, addresses = [], accounts, seasonAddress, programId }) {
  const out = [];
  for (const a of Array.isArray(addresses) ? addresses : []) {
    const b = accounts?.get?.(a);
    const l = b ? decodeLot(b) : null;
    if (!l || l.p !== Number(vault.p) || l.q !== Number(vault.q) || l.tile !== Number(vault.tile) || l.vaultGen !== Number(vault.gen) || l.resource !== RES.ore) continue;
    let ok = false;
    try { ok = tagOf(l.owner) === l.ownerTag && lotAddress(seasonAddress, programId, vault, l.ownerTag, l.resource) === a; } catch { ok = false; }
    if (ok) out.push({ vault, owner: l.owner });
  }
  return out;
}
/**
 * The pools to read: `[{p, q, site, gen}]`. A pool's address carries its village's generation and a capture moves the
 * village on (the Holding keeps PREV_GEN and CAPTURED_BELL), so a captured workshop village's pool — the one whose jobs
 * the captor takes, RecordFacilityLoss — is at the generation before: read it too, and every pool read before (`known`).
 */
export function poolReadPlan({ holdings = [], known = [] }) {
  const out = new Map();
  const add = f => { const key = `${f.p},${f.q},${f.site},${f.gen}`; if (!out.has(key)) out.set(key, { p: f.p, q: f.q, site: f.site, gen: f.gen }); };
  for (const h of holdings) {
    if (h.workshops > 0 || h.lent > 0) add(h);
    if (h.capturedBell && h.prevGen > 0 && h.prevGen !== h.gen) add({ ...h, gen: h.prevGen });
  }
  for (const f of known) add(f);
  return [...out.values()];
}
