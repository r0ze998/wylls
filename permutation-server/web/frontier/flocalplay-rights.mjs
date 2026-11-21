// LOCAL PLAY, TEST-ONLY, COEXIST LANE ONLY — ② rights (owner decision ② A, 2026-11-18): the workshop-stock swap as
// page-signed local acts, and the S1 Vault and caravan the swap needs (the swap's output lands in the grantee's Vault
// in the facility's Province and leaves it only by caravan).
//
//   IssueGrant 0xD0   the issuer's WALLET (never a session, never delegated): facility = one of its workshop villages,
//                     station = the grantee's live Vault in that Province; the facility pays GRANT_ISSUE_COST (25 gold)
//   ReserveSwap 0xD1  the grantee: `units` × (ORE_PER_ARM ore + WOOD_PER_ARM wood) leave the Vault, `units` arms
//                     leave the facility, all three into the Grant's escrow; `seq` = the Grant's executed swaps
//   ExecuteSwap 0xD2  the grantee: the arms into the Vault, the ore and wood into the facility
//   ReleaseSwap 0xD3  the grantee: an open reservation undone
//   RevokeGrant 0xD4  the issuer's WALLET (never delegated): the Grant ends; an open reservation is undone
//   CloseGrant 0xD5   the issuer (the Grant's rent recipient): the rent back once nothing is escrowed
//   BuildVault, SendCaravan   the game's own S1 shapes (fplay.mjs), local acts in this lane only
//
// This module is the ONE builder both sides use: the page (flocalplay-act.mjs, the memory-only wallet signs) and the
// relay (gateway local-play-act.mjs, which rebuilds the stated intent and refuses anything not byte for byte the same).
// The game's SDK has no shape for the rights band (its ABI tables hold no proposed tag: frontier-abi v2/rights.rs keeps
// them out of `Ix`), so the instruction is written here from that published layout:
//   data      ix_rights! — tag ‖ fields little-endian (IssueGrant: nonce u32, kind u8, max_swaps u16, max_units u32,
//             expires_ts i64; ReserveSwap: units u32, seq u16; ExecuteSwap: seq u16; the other three: the tag alone)
//   accounts  rights.rs `accounts::{issue, use_grant, release, close}` (the order, signer and writable flags)
//   address   the Grant: with_seed(season, 'gr' ‖ hex(le64 issuer_tag ‖ le32 nonce), program), issuer_tag = the first
//             8 bytes of the issuer's Citizen address, little-endian (proc/rights.rs `pl.pc.citizen_tag`)
// The wallet is fee payer AND actor: one signature (the actor and payer metas merge into one signing, writable key).
//
// FOG RULE (the page's views): a player is shown only the Grants it is a party to — as issuer or as grantee — and never
// another player's Vault stock. The chain is public (any Grant account can be read by anyone), but the page draws
// nothing beyond what its fog already draws: a Grant between two other players, or the contents of a Vault that is
// not the viewer's, is not listed, not counted and not hinted at. A grantee is named by its Citizen only, from the
// players the page already knows in that Province.
import { seasonAddresses, withSeed, citizenTag } from './faddr.mjs';
import { accountsFor, buildShape, cargoBytes } from './fplay.mjs';
import { ringPosition } from './map/wide.mjs';
import { setComputeUnitLimit, setComputeUnitPrice, setLoadedAccountsDataSizeLimit, budgetPrefix, CARAVAN_FEE } from '../sdk/frontier/budgets.mjs';
import { compileMessage } from '../sdk/solana-tx.mjs';
import { decode, encode } from '../sdk/base58.mjs';
import { toHex } from '../sdk/bytes.mjs';
// (TEST-ONLY preview of ⑨ capacity and ⑩ custody on the same Vault and caravans: flocalplay-custody.mjs builds them; they
//  ride the coexist acts' one checked path — the page signs, the relay rebuilds — and nothing else)
import { PREVIEW_ACTS, PREVIEW_WALLET_ONLY, previewIntent, previewIntentOf, previewMessage } from './flocalplay-custody.mjs';

export const RIGHTS_TAGS = Object.freeze({ IssueGrant: 0xd0, ReserveSwap: 0xd1, ExecuteSwap: 0xd2, ReleaseSwap: 0xd3, RevokeGrant: 0xd4, CloseGrant: 0xd5 });
export const RIGHTS_ACTS = Object.freeze(Object.keys(RIGHTS_TAGS));
/** The S1 shapes the swap needs (a Vault in the facility's Province, a haul out of it): local acts in the coexist lane only. */
// (SettleCaravan, 0xB2, class D: the delivery of the viewer's OWN caravan once it has arrived — local play has no keeper
//  that cranks S1 caravans (frontier-node keeper caravans.rs runs only in the full keeper), so without it nothing hauled
//  into or out of a Vault ever lands. The wallet pays the fee and takes the caravan's escrowed fee back as beneficiary;
//  the caravan's rent goes to its RENT_TO, the wallet that sent it on this path. The program checks arrival and raids.)
export const COEXIST_S1_ACTS = Object.freeze(['BuildVault', 'SendCaravan', 'SettleCaravan']);
export const SETTLE_CARAVAN_TAG = 0xb2;
export const COEXIST_ACTS = Object.freeze([...RIGHTS_ACTS, ...COEXIST_S1_ACTS, ...PREVIEW_ACTS]);
/** Wallet-only and never delegated (MCP NEVER_DELEGATED; refused on a resident's relay: `LocalActWalletOnly`). */
export const RIGHTS_WALLET_ONLY = Object.freeze(['IssueGrant', 'RevokeGrant', ...PREVIEW_WALLET_ONLY]);
/**
 * CU limits: the coexist itest's measured totals (IssueGrant 20,275 · ReserveSwap 14,854 · ExecuteSwap 16,636) and
 * ws02's LiteSVM rights build (Issue 20,944 · Reserve 12,419 · Execute 14,172 · Release 11,459 · Revoke 12,908 ·
 * Close 4,018), about twice the larger: the price is 0 in local play, so headroom costs nothing, and a limit hit
 * would refuse a whole swap.
 */
export const RIGHTS_CU = Object.freeze({ IssueGrant: 45_000, ReserveSwap: 32_000, ExecuteSwap: 35_000, ReleaseSwap: 25_000, RevokeGrant: 28_000, CloseGrant: 10_000 });
/** frontier-abi v2/rights.rs: the one kind, the issue cost (whole units, resource order food…influence), the bounds. */
export const KIND_STOCK_SWAP = 1;
export const GRANT_ISSUE_COST = Object.freeze([0, 0, 0, 0, 0, 25, 0, 0]);
export const MAX_GRANT_SECS = 30 * 86_400;
export const MAX_UNITS_PER_SWAP = 10_000;
export const GRANT_MAGIC = 'PSF2GRNT';
export const GRANT_SIZE = 272;
export const STATE_ACTIVE = 1, STATE_REVOKED = 2;
const SYSTEM = '11111111111111111111111111111111';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const check = (ok, code) => { if (!ok) fail(code); };
const exactKeys = (x, keys) => x !== null && typeof x === 'object' && !Array.isArray(x) && Object.keys(x).length === keys.length && keys.every(k => Object.hasOwn(x, k));
const int = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const u64Text = v => typeof v === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(v) && BigInt(v) <= 0xffffffffffffffffn;
const i64Text = v => typeof v === 'string' && /^-?(0|[1-9][0-9]{0,18})$/.test(v) && BigInt(v) >= -(2n ** 63n) && BigInt(v) < 2n ** 63n;
const address = v => { try { const b = decode(v); return typeof v === 'string' && v.length <= 44 && b.length === 32 && encode(b) === v; } catch { return false; } };

// ------------------------------------------------------------------ addresses

/** The Grant's seed: 'gr' ‖ hex(le64 issuer_tag ‖ le32 nonce) (26 characters). */
export function grantSeed(issuerTag, nonce) {
  const raw = new Uint8Array(12), dv = new DataView(raw.buffer);
  dv.setBigUint64(0, BigInt(issuerTag), true); dv.setUint32(8, nonce >>> 0, true);
  return 'gr' + toHex(raw);
}
export const grantAddress = (seasonAddress, programId, issuerTag, nonce) => withSeed(seasonAddress, grantSeed(issuerTag, nonce), programId);
/** The issuer tag of a Citizen address (decimal text, as the intents carry it). */
export const issuerTagOf = citizenAddress => citizenTag(citizenAddress).toString();

// ------------------------------------------------------------------ reading a Grant

/** A Grant account's bytes (rights.rs `layout`) → its fields (addresses base58, u64/i64 as decimal text), or null. */
export function decodeGrant(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : null;
  if (!b || b.length !== GRANT_SIZE || String.fromCharCode(...b.subarray(0, 8)) !== GRANT_MAGIC) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const key = o => encode(b.subarray(o, o + 32));
  return Object.freeze({
    seasonId: dv.getBigUint64(8, true).toString(), version: dv.getUint16(16, true), kind: b[18], state: b[19],
    facilityGen: b[20], stationGen: b[21], facilitySite: b[22], stationTile: b[23], p: dv.getInt16(24, true), q: dv.getInt16(26, true),
    nonce: dv.getUint32(28, true), issuerCitizen: key(32), granteeCitizen: key(64), facility: key(96), station: key(128),
    issuerTag: dv.getBigUint64(160, true).toString(), expiresTs: dv.getBigInt64(168, true).toString(), issuedTs: dv.getBigInt64(176, true).toString(),
    maxSwaps: dv.getUint16(184, true), swaps: dv.getUint16(186, true), maxUnits: dv.getUint32(188, true), unitsSwapped: dv.getUint32(192, true),
    openUnits: dv.getUint32(196, true), openTs: dv.getBigInt64(200, true).toString(),
    open: Object.freeze([dv.getBigInt64(208, true).toString(), dv.getBigInt64(216, true).toString(), dv.getBigInt64(224, true).toString()]),
    revokedTs: dv.getBigInt64(232, true).toString(), rentTo: key(240),
  });
}

/**
 * What a Grant allows the viewer now (advisory; the program re-checks everything): `{role, can: Set(names), unitsLeft}`.
 * `role` is 'issuer', 'grantee' or null — null means the viewer is no party and the page draws nothing of it (fog rule).
 */
export function grantOptions(g, viewerCitizen, nowTs) {
  if (!g) return { role: null, can: new Set(), unitsLeft: 0 };
  const role = g.issuerCitizen === viewerCitizen ? 'issuer' : g.granteeCitizen === viewerCitizen ? 'grantee' : null;
  const allowed = [];   // (the commands' names, not codes: kept as a list, then a Set)
  const now = BigInt(Math.floor(Number(nowTs)));
  const live = g.state === STATE_ACTIVE && now < BigInt(g.expiresTs);
  const unitsLeft = Math.max(0, g.maxUnits - g.unitsSwapped);
  const spent = g.swaps >= g.maxSwaps || unitsLeft === 0;
  if (role === 'grantee') {
    if (g.openUnits === 0 && live && !spent) allowed.push('ReserveSwap');
    if (g.openUnits > 0 && live) allowed.push('ExecuteSwap');
    if (g.openUnits > 0) allowed.push('ReleaseSwap');
  }
  if (role === 'issuer') {
    if (g.state === STATE_ACTIVE) allowed.push('RevokeGrant');
    if (g.openUnits === 0 && (g.state === STATE_REVOKED || !live || spent)) allowed.push('CloseGrant');
  }
  return { role, can: new Set(allowed), unitsLeft };
}

// ------------------------------------------------------------------ intents

function village(h, code) {
  check(exactKeys(h, ['p', 'q', 'site']) && Number.isSafeInteger(h.p) && Number.isSafeInteger(h.q) && int(h.site, 0, 11), code);
  let ring; try { ring = ringPosition(BigInt(h.p), BigInt(h.q)).ring; } catch { fail(code); }
  check(ring <= 128n, 'LocalActWideHolding');
  return Object.freeze({ p: h.p, q: h.q, site: h.site });
}
function tileOf(t, code) {
  check(exactKeys(t, ['p', 'q', 'tile']) && Number.isSafeInteger(t.p) && Number.isSafeInteger(t.q) && int(t.tile, 0, 60), code);
  let ring; try { ring = ringPosition(BigInt(t.p), BigInt(t.q)).ring; } catch { fail(code); }
  check(ring <= 128n, 'LocalActWideHolding');
  return Object.freeze({ p: t.p, q: t.q, tile: t.tile });
}
function grantRef(g, code) {
  check(exactKeys(g, ['issuer_tag', 'nonce']) && u64Text(g.issuer_tag) && int(g.nonce, 0, 0xffffffff), code);
  return Object.freeze({ issuer_tag: g.issuer_tag, nonce: g.nonce });
}
/** A use of a Grant names the Grant, its facility village and its station Vault (all three pinned by the Grant). */
function useSubject(s, code) {
  check(exactKeys(s, ['grant', 'facility', 'station']), code);
  const facility = village(s.facility, code), station = tileOf(s.station, code);
  check(facility.p === station.p && facility.q === station.q, code);
  return Object.freeze({ grant: grantRef(s.grant, code), facility, station });
}
/** A caravan's end: a village {kind:'holding', p, q, site, gen} or a Vault {kind:'vault', p, q, tile, gen}. */
function place(x, code) {
  check(x !== null && typeof x === 'object' && (x.kind === 'holding' || x.kind === 'vault'), code);
  if (x.kind === 'holding') {
    check(exactKeys(x, ['kind', 'p', 'q', 'site', 'gen']) && int(x.gen, 0, 255), code);
    const v = village({ p: x.p, q: x.q, site: x.site }, code);
    return Object.freeze({ kind: 'holding', ...v, gen: x.gen });
  }
  check(exactKeys(x, ['kind', 'p', 'q', 'tile', 'gen']) && int(x.gen, 0, 255), code);
  const t = tileOf({ p: x.p, q: x.q, tile: x.tile }, code);
  return Object.freeze({ kind: 'vault', ...t, gen: x.gen });
}
const PLACE_KIND = Object.freeze({ holding: 1, vault: 2 });

/**
 * The checked intent `{name, subject, fields}` (plain JSON; what both sides build from). Throws `code` (or
 * `LocalActWideHolding`) for anything else:
 *   IssueGrant   subject {facility: village, grantee: Citizen base58, station: {p, q, tile}}   (station in the facility's Province)
 *                fields  {nonce, kind: 1, max_swaps 1-65535, max_units 1-…, expires_ts: decimal text}
 *   ReserveSwap  subject {grant: {issuer_tag, nonce}, facility, station}   fields {units 1-10000, seq}
 *   ExecuteSwap  (same subject)   fields {seq}
 *   ReleaseSwap / RevokeGrant  (same subject)   fields {}
 *   CloseGrant   subject {grant}   fields {}
 *   BuildVault   subject {holding: village, at: {p, q, tile}}   fields {tile}   (tile = at.tile)
 *   SendCaravan  subject {seq, src: place, dst: place, provinces: [{p, q}] 1-4}
 *                fields  {seq, dst_kind, dst_p, dst_q, dst_at, dst_gen, steps, path: 12 bytes, cargo: 8 whole amounts, fee: decimal text}
 */
export function rightsIntent(name, subject, fields, code = 'LocalActShape') {
  check(COEXIST_ACTS.includes(name), 'LocalActNotAllowed');
  if (PREVIEW_ACTS.includes(name)) return previewIntent(name, subject, fields, code);
  const s = subject, f = fields;
  check(s !== null && typeof s === 'object' && !Array.isArray(s) && f !== null && typeof f === 'object' && !Array.isArray(f), code);
  const out = (subj, flds) => Object.freeze({ name, subject: Object.freeze(subj), fields: Object.freeze(flds) });
  if (name === 'IssueGrant') {
    check(exactKeys(s, ['facility', 'grantee', 'station']) && address(s.grantee), code);
    const facility = village(s.facility, code), station = tileOf(s.station, code);
    check(facility.p === station.p && facility.q === station.q, code);
    check(exactKeys(f, ['nonce', 'kind', 'max_swaps', 'max_units', 'expires_ts']) && int(f.nonce, 0, 0xffffffff) && f.kind === KIND_STOCK_SWAP
      && int(f.max_swaps, 1, 0xffff) && int(f.max_units, 1, 0xffffffff) && i64Text(f.expires_ts) && BigInt(f.expires_ts) > 0n, code);
    return out({ facility, grantee: s.grantee, station }, { nonce: f.nonce, kind: f.kind, max_swaps: f.max_swaps, max_units: f.max_units, expires_ts: f.expires_ts });
  }
  if (name === 'CloseGrant') {
    check(exactKeys(s, ['grant']) && exactKeys(f, []), code);
    return out({ grant: grantRef(s.grant, code) }, {});
  }
  if (name === 'BuildVault') {
    check(exactKeys(s, ['holding', 'at']) && exactKeys(f, ['tile']), code);
    const holding = village(s.holding, code), at = tileOf(s.at, code);
    check(f.tile === at.tile, code);
    return out({ holding, at }, { tile: at.tile });
  }
  if (name === 'SendCaravan') {
    check(exactKeys(s, ['seq', 'src', 'dst', 'provinces']) && int(s.seq, 0, 0xffffffff) && Array.isArray(s.provinces) && s.provinces.length >= 1 && s.provinces.length <= 4, code);
    const src = place(s.src, code), dst = place(s.dst, code);
    const provinces = s.provinces.map(x => { check(exactKeys(x, ['p', 'q']) && Number.isSafeInteger(x.p) && Number.isSafeInteger(x.q), code); return Object.freeze({ p: x.p, q: x.q }); });
    check(exactKeys(f, ['seq', 'dst_kind', 'dst_p', 'dst_q', 'dst_at', 'dst_gen', 'steps', 'path', 'cargo', 'fee']) && f.seq === s.seq
      && f.dst_kind === PLACE_KIND[dst.kind] && f.dst_p === dst.p && f.dst_q === dst.q && f.dst_at === (dst.kind === 'vault' ? dst.tile : dst.site) && f.dst_gen === dst.gen
      && int(f.steps, 1, 32) && Array.isArray(f.path) && f.path.length === 12 && f.path.every(x => int(x, 0, 255))
      && Array.isArray(f.cargo) && f.cargo.length === 8 && f.cargo.every(x => int(x, 0, 0xffffffff)) && f.cargo.some(x => x > 0)
      && f.fee === CARAVAN_FEE.toString(), code);
    return out({ seq: s.seq, src, dst, provinces: Object.freeze(provinces) },
      { seq: f.seq, dst_kind: f.dst_kind, dst_p: f.dst_p, dst_q: f.dst_q, dst_at: f.dst_at, dst_gen: f.dst_gen, steps: f.steps, path: Object.freeze([...f.path]), cargo: Object.freeze([...f.cargo]), fee: f.fee });
  }
  if (name === 'SettleCaravan') {
    check(exactKeys(s, ['seq', 'dst', 'provinces']) && int(s.seq, 0, 0xffffffff) && Array.isArray(s.provinces) && s.provinces.length >= 1 && s.provinces.length <= 4 && exactKeys(f, []), code);
    const dst = place(s.dst, code);
    const provinces = s.provinces.map(x => { check(exactKeys(x, ['p', 'q']) && Number.isSafeInteger(x.p) && Number.isSafeInteger(x.q), code); return Object.freeze({ p: x.p, q: x.q }); });
    return out({ seq: s.seq, dst, provinces: Object.freeze(provinces) }, {});
  }
  const subj = useSubject(s, code);
  if (name === 'ReserveSwap') { check(exactKeys(f, ['units', 'seq']) && int(f.units, 1, MAX_UNITS_PER_SWAP) && int(f.seq, 0, 0xffff), code); return out(subj, { units: f.units, seq: f.seq }); }
  if (name === 'ExecuteSwap') { check(exactKeys(f, ['seq']) && int(f.seq, 0, 0xffff), code); return out(subj, { seq: f.seq }); }
  check(exactKeys(f, []), code);   // ReleaseSwap, RevokeGrant
  return out(subj, {});
}

/**
 * The intent from what the page's order carries (`v`, `fields` as controller.mjs passes them): the page's own values
 * are converted to the wire form (bytes as arrays, the fee and expiry as decimal text), then checked as above.
 */
export function rightsIntentOf(name, v, fields) {
  if (PREVIEW_ACTS.includes(name)) return previewIntentOf(name, v, fields);
  const f = { ...(fields ?? {}) };
  if (name === 'SendCaravan') {
    if (f.path instanceof Uint8Array) f.path = Array.from(f.path);
    if (f.cargo instanceof Uint8Array) { const dv = new DataView(f.cargo.buffer, f.cargo.byteOffset, f.cargo.byteLength); f.cargo = Array.from({ length: 8 }, (_, i) => dv.getUint32(i * 4, true)); }
    if (typeof f.fee === 'bigint') f.fee = f.fee.toString();
    const s = { seq: v?.seq, src: v?.src, dst: v?.dst, provinces: v?.provinces };
    return rightsIntent(name, s, f, 'LocalActShape');
  }
  // (the page's holding object carries much more than its place: only its place is the intent's, as for the other acts)
  const placeOf = h => (h && typeof h === 'object' ? { p: h.p, q: h.q, site: h.site } : h);
  if (name === 'SettleCaravan') return rightsIntent(name, { seq: v?.seq, dst: v?.dst, provinces: v?.provinces }, f, 'LocalActShape');
  if (name === 'BuildVault') return rightsIntent(name, { holding: placeOf(v?.holding), at: v?.at && typeof v.at === 'object' ? { p: v.at.p, q: v.at.q, tile: v.at.tile } : v?.at }, f, 'LocalActShape');
  if (name === 'IssueGrant' && typeof f.expires_ts === 'bigint') f.expires_ts = f.expires_ts.toString();
  const s = {};
  for (const k of Object.keys(v ?? {})) s[k] = v[k];
  return rightsIntent(name, s, f, 'LocalActShape');
}

// ------------------------------------------------------------------ the instruction and the message

function grantData(intent) {
  const tag = RIGHTS_TAGS[intent.name], f = intent.fields;
  if (intent.name === 'IssueGrant') {
    const d = new Uint8Array(20), dv = new DataView(d.buffer);
    d[0] = tag; dv.setUint32(1, f.nonce, true); d[5] = f.kind; dv.setUint16(6, f.max_swaps, true); dv.setUint32(8, f.max_units, true); dv.setBigInt64(12, BigInt(f.expires_ts), true);
    return d;
  }
  if (intent.name === 'ReserveSwap') { const d = new Uint8Array(7), dv = new DataView(d.buffer); d[0] = tag; dv.setUint32(1, f.units, true); dv.setUint16(5, f.seq, true); return d; }
  if (intent.name === 'ExecuteSwap') { const d = new Uint8Array(3), dv = new DataView(d.buffer); d[0] = tag; dv.setUint16(1, f.seq, true); return d; }
  return Uint8Array.of(tag);
}

/** The rights instruction of `intent` (checked) for `wallet` (actor and payer) in Season `seasonId` of `programId`. */
export function rightsInstruction(intent, { programId, seasonId, wallet }) {
  check(RIGHTS_ACTS.includes(intent.name), 'LocalActNotAllowed');
  const A = seasonAddresses(programId, String(seasonId));
  const citizen = A.of('Citizen', { wallet });
  const k = (pubkey, isSigner, isWritable) => ({ pubkey, isSigner, isWritable });
  const s = intent.subject;
  let keys;
  if (intent.name === 'IssueGrant') {
    const grant = grantAddress(A.season, programId, issuerTagOf(citizen), intent.fields.nonce);
    keys = [k(wallet, true, false), k(wallet, true, true), k(A.season, false, false), k(citizen, false, true), k(A.of('Holding', s.facility), false, true),
      k(A.of('Province', s.facility), false, false), k(s.grantee, false, false), k(A.of('Vault', s.station), false, false), k(grant, false, true), k(SYSTEM, false, false)];
  } else if (intent.name === 'CloseGrant') {
    // (the rent recipient the Grant names: the issuer's wallet, the payer of its IssueGrant on this path)
    keys = [k(wallet, true, false), k(A.season, false, false), k(grantAddress(A.season, programId, s.grant.issuer_tag, s.grant.nonce), false, true), k(wallet, false, true)];
  } else {
    const grant = grantAddress(A.season, programId, s.grant.issuer_tag, s.grant.nonce);
    const facility = A.of('Holding', s.facility), station = A.of('Vault', s.station), province = A.of('Province', s.facility);
    keys = intent.name === 'ReleaseSwap'
      ? [k(wallet, true, false), k(A.season, false, false), k(citizen, false, false), k(grant, false, true), k(facility, false, true), k(station, false, true), k(province, false, false)]
      : [k(wallet, true, false), k(wallet, true, true), k(A.season, false, false), k(citizen, false, true), k(grant, false, true), k(facility, false, true), k(station, false, true), k(province, false, false)];
  }
  return { programId, keys, data: grantData(intent) };
}

/**
 * SettleCaravan of the wallet's own caravan `seq` (fclient ix::v2 settle_caravan): `[fee_payer s,w] [season r]
 * [caravan w] [dst w] [beneficiary w] [rent_to w] [path_province r ×1..4]`, data `0xB2 ‖ beneficiary`.
 */
export function settleCaravanInstruction(intent, { programId, seasonId, wallet }) {
  const A = seasonAddresses(programId, String(seasonId));
  const citizen = A.of('Citizen', { wallet }), s = intent.subject;
  const k = (pubkey, isSigner, isWritable) => ({ pubkey, isSigner, isWritable });
  const caravan = A.of('Caravan', { ownerTag: citizenTag(citizen), seq: s.seq });
  const dst = s.dst.kind === 'vault' ? A.of('Vault', s.dst) : A.of('Holding', s.dst);
  const keys = [k(wallet, true, true), k(A.season, false, false), k(caravan, false, true), k(dst, false, true), k(wallet, false, true), k(wallet, false, true),
    ...s.provinces.map(pq => k(A.of('Province', pq), false, false))];
  const data = new Uint8Array(33); data[0] = SETTLE_CARAVAN_TAG; data.set(decode(wallet), 1);
  return { programId, keys, data };
}

/** The S1 shape of a BuildVault / SendCaravan intent through the game's own builder (fplay.mjs), the wallet as actor. */
function s1Built(intent, { programId, seasonId, wallet, blockhash, profile }) {
  const A = seasonAddresses(programId, String(seasonId));
  const s = intent.subject, f = intent.fields;
  const v = { addresses: A, wallet, actor: wallet, profile, ...s };
  const fields = intent.name === 'SendCaravan'
    ? { ...f, path: Uint8Array.from(f.path), cargo: cargoBytes(f.cargo), fee: BigInt(f.fee) }
    : { ...f };
  const built = buildShape({ programId, name: intent.name, accounts: accountsFor(intent.name, v), fields, feePayer: wallet, blockhash, profile });
  check(built.signers.length === 0, 'LocalActSigner');
  return built.expected;
}

/**
 * The whole message of a coexist act: the instruction under its compute budget (the local loaded-data limit), the
 * wallet as fee payer (the only signature). `profile` (the S1 shapes only): the Season's profile (3).
 */
export function rightsMessage(intent, { programId, seasonId, wallet, blockhash, loadedLimit, profile = 3 }) {
  check(COEXIST_ACTS.includes(intent.name), 'LocalActNotAllowed');
  if (PREVIEW_ACTS.includes(intent.name)) return previewMessage(intent, { programId, seasonId, wallet, blockhash, loadedLimit, profile });
  let ix, prefix;
  if (RIGHTS_ACTS.includes(intent.name)) {
    ix = rightsInstruction(intent, { programId, seasonId, wallet });
    prefix = [setComputeUnitLimit(RIGHTS_CU[intent.name]), setComputeUnitPrice(0n), setLoadedAccountsDataSizeLimit(loadedLimit)];
  } else if (intent.name === 'SettleCaravan') {
    ix = settleCaravanInstruction(intent, { programId, seasonId, wallet });
    prefix = budgetPrefix('SettleCaravan', { profile, loadedLimit });
  } else {
    ix = s1Built(intent, { programId, seasonId, wallet, blockhash, profile });
    prefix = budgetPrefix(intent.name, { profile, loadedLimit });
  }
  return Uint8Array.from(compileMessage({ feePayer: wallet, recentBlockhash: blockhash, instructions: [...prefix, ix] }));
}

/** The Grant address an intent names (null for the S1 acts). */
export function grantOfIntent(intent, { programId, seasonId, wallet }) {
  const A = seasonAddresses(programId, String(seasonId));
  if (intent.name === 'IssueGrant') return grantAddress(A.season, programId, issuerTagOf(A.of('Citizen', { wallet })), intent.fields.nonce);
  if (RIGHTS_ACTS.includes(intent.name)) return grantAddress(A.season, programId, intent.subject.grant.issuer_tag, intent.subject.grant.nonce);
  return null;
}

// ------------------------------------------------------------------ the page's Grant list

export const HERALD_GRANTS_SCHEMA = 'frontier-herald-grants-v1';
/**
 * The herald's `/h/grants` answer kept to the FOG RULE: only Grants whose issuer or grantee is `viewerCitizen`; any
 * other row is dropped here even if the herald sent it. The herald names a party by its Citizen when it has captured
 * that Citizen and always by its tag (`issuer_tag`, `grantee_tag`: the first 8 bytes of the Citizen address, LE), so a
 * row is matched by tag. → the rows, or null when the answer is not the herald's grants schema (the page then falls
 * back to the Grants it issued itself).
 */
export function partyGrants(answer, viewerCitizen) {
  if (!answer || answer.schema !== HERALD_GRANTS_SCHEMA || !Array.isArray(answer.grants) || !address(viewerCitizen)) return null;
  const tag = issuerTagOf(viewerCitizen);
  return answer.grants.filter(g => g && typeof g === 'object' && address(g.address) && u64Text(String(g.issuer_tag)) && int(Number(g.nonce), 0, 0xffffffff)
    && (String(g.issuer_tag) === tag || String(g.grantee_tag) === tag || g.issuer_citizen === viewerCitizen || g.grantee_citizen === viewerCitizen));
}
/** The Grant bytes a herald row carries (`account`, base64), decoded; null when absent or not a Grant. */
export function rowGrant(row) {
  if (typeof row?.account !== 'string') return null;
  try { const bin = typeof Buffer !== 'undefined' ? new Uint8Array(Buffer.from(row.account, 'base64')) : Uint8Array.from(atob(row.account), c => c.charCodeAt(0)); return decodeGrant(bin); } catch { return null; }
}
