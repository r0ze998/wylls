// LOCAL PLAY, TEST-ONLY — the WIDE CLAIM (0xD9 WideClaimSite) as a page-signed local act (owner t379u 「広い版がんばれ」).
//
// The wide claim files a ticket for one site of an opened wide province (rings 129+) as a later village (slot 2 or 3),
// anchored at the Citizen's slot-1 first home (frontier-abi world_index wide_ix 0xD9; program proc/wide.rs claim_site:
// the first home final, within `outpost_range` of the target, at least `outpost_tier_min`; the settler cost paid from
// its stores). The ticket is settled by the world's runner (itest wide_play `run_claims`: the bell's anchor and seed,
// 0xDC WideSettleTicket, then 0xDF WideFinalize) — the class-D duty, as the keeper settles legacy tickets.
//
// This module is the ONE builder both sides use: the page (flocalplay-act.mjs, the wallet signs) and the relay
// (gateway local-play-act.mjs, which rebuilds the stated intent and refuses anything not byte for byte the same).
// The game's SDK has no shape for the wide band (its ABI tables stop at the legacy and v2 tags), so the instruction is
// written here from the published layout:
//   accounts  [actor s] [payer s,w] [season r] [citizen w] [frontier r] [wide province w] [wide ticket w]
//             [anchor holding w] [anchor province r] [previous holding w] [previous province r] [system r]
//             (a slot-2 claim names the anchor pair as the previous pair, as frontier-node verify playable_wide_next)
//             then optionally [reach province r] (expansion-gameplay-1, reach from the nation's land: a wide province of
//             the claimer's nation — a village of it there, or a keep it won — within OUTPOST_RANGE of the target;
//             frontier-abi world_index/reach.rs, program proc/wide.rs reach_witness_distance)
//   data      0xD9 ‖ p i64 LE ‖ q i64 LE ‖ site u8 ‖ slot u8
//   addresses with_seed(season, 'wp' ‖ hex(sha256('PSF-WIDE-PROVINCE-SEED-v1' ‖ sort key)[..15]), program) and
//             with_seed(season, 'wt' ‖ hex(sha256('PSF-WIDE-TICKET-SEED-v1' ‖ citizen)[..15]), program)
import { seasonAddresses, withSeed } from './faddr.mjs';
import { sortKeyOf } from './fwide.mjs';
import { ringPosition } from './map/wide.mjs';
import { setComputeUnitLimit, setComputeUnitPrice, setLoadedAccountsDataSizeLimit, requestHeapFrame } from '../sdk/frontier/budgets.mjs';
import { compileMessage } from '../sdk/solana-tx.mjs';
import { decodePrefix } from './fcodec.mjs';
import { decode } from '../sdk/base58.mjs';
import { toHex, utf8 } from '../sdk/bytes.mjs';
import { sha256 } from '../sdk/sha256.mjs';

export const WIDE_CLAIM = 'WideClaim';
export const WIDE_CLAIM_TAG = 0xd9;
/** The claim's CU limit: the program measured ≈ 0.2–0.5 M on the devnet-playable `.so` (verify-pr70); 1.4 M is the runtime's ceiling. */
export const WIDE_CLAIM_CU = 1_400_000;
export const WIDE_CLAIM_HEAP = 256 * 1024;
export const FIRST_WIDE_RING = 129n;
/** The deployed `outpost_range` of every S1 preset: the anchor may be at most this many provinces from the target. */
export const OUTPOST_RANGE = 3;
/** frontier-abi world_index system program. */
const SYSTEM = '11111111111111111111111111111111';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const check = (ok, code) => { if (!ok) fail(code); };
const exactKeys = (x, keys) => x !== null && typeof x === 'object' && !Array.isArray(x) && Object.keys(x).length === keys.length && keys.every(k => Object.hasOwn(x, k));
const int = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const wideText = v => typeof v === 'string' && /^-?(0|[1-9][0-9]{0,17})$/.test(v);

export const wideProvinceSeed = (p, q) => 'wp' + toHex(sha256(utf8('PSF-WIDE-PROVINCE-SEED-v1'), sortKeyOf(BigInt(p), BigInt(q))).slice(0, 15));
export const wideProvinceAddress = (seasonAddress, programId, p, q) => withSeed(seasonAddress, wideProvinceSeed(p, q), programId);
export const wideTicketSeed = citizen => 'wt' + toHex(sha256(utf8('PSF-WIDE-TICKET-SEED-v1'), Uint8Array.from(decode(citizen))).slice(0, 15));
export const wideTicketAddress = (seasonAddress, programId, citizen) => withSeed(seasonAddress, wideTicketSeed(citizen), programId);

/** Axial distance between a legacy (p, q) and a wide (p, q) (whole numbers; BigInt-safe). */
export function distance(a, b) {
  const dp = BigInt(a.p) - BigInt(b.p), dq = BigInt(a.q) - BigInt(b.q), ds = -dp - dq;
  const abs = x => (x < 0n ? -x : x);
  const m = [abs(dp), abs(dq), abs(ds)].reduce((x, y) => (x > y ? x : y));
  return Number(m);
}

/**
 * The checked intent `{name: 'WideClaim', subject: {holding: anchor, target: {p, q}, reach?: {p, q}}, fields: {site,
 * slot}}`: the anchor a legacy village (ring ≤ 128) — the Citizen's slot-1 first home —, the target a wide province
 * (ring ≥ 129, coordinates as decimal strings) within OUTPOST_RANGE of the anchor, or of `reach` when named: another
 * wide province (the reach witness, expansion-gameplay-1) within OUTPOST_RANGE of the target — whether it is the
 * nation's land is the program's check. Site 0-11, slot 2 or 3. Throws a code.
 */
export function wideClaimIntent(subject, fields, code = 'LocalActShape') {
  const withReach = subject !== null && typeof subject === 'object' && Object.hasOwn(subject, 'reach');
  check(exactKeys(subject, withReach ? ['holding', 'target', 'reach'] : ['holding', 'target']) && exactKeys(fields, ['site', 'slot']), code);
  const h = subject.holding, t = subject.target, w = withReach ? subject.reach : null;
  check(exactKeys(h, ['p', 'q', 'site']) && Number.isSafeInteger(h.p) && Number.isSafeInteger(h.q) && int(h.site, 0, 11), code);
  check(exactKeys(t, ['p', 'q']) && wideText(t.p) && wideText(t.q), code);
  if (withReach) check(exactKeys(w, ['p', 'q']) && wideText(w.p) && wideText(w.q) && !(w.p === t.p && w.q === t.q), code);
  let ha, ta, wa;
  try { ha = ringPosition(BigInt(h.p), BigInt(h.q)).ring; ta = ringPosition(BigInt(t.p), BigInt(t.q)).ring; wa = w ? ringPosition(BigInt(w.p), BigInt(w.q)).ring : null; } catch { fail(code); }
  check(ha <= 128n, 'LocalActWideHolding');
  check(ta >= FIRST_WIDE_RING, code);
  if (w) check(wa >= FIRST_WIDE_RING && distance(w, t) <= OUTPOST_RANGE, code);
  else check(distance(h, t) <= OUTPOST_RANGE, code);
  check(int(fields.site, 0, 11) && int(fields.slot, 2, 3), code);
  const subj = { holding: Object.freeze({ p: h.p, q: h.q, site: h.site }), target: Object.freeze({ p: t.p, q: t.q }) };
  if (w) subj.reach = Object.freeze({ p: w.p, q: w.q });
  return Object.freeze({ name: WIDE_CLAIM, subject: Object.freeze(subj), fields: Object.freeze({ site: fields.site, slot: fields.slot }) });
}

/** The 0xD9 instruction of `intent` for `wallet` (actor and payer) in the Season `seasonId` of `programId`. */
export function wideClaimInstruction(intent, { programId, seasonId, wallet }) {
  const A = seasonAddresses(programId, String(seasonId));
  const h = intent.subject.holding, t = intent.subject.target, f = intent.fields;
  const citizen = A.of('Citizen', { wallet });
  const anchor = A.of('Holding', h), anchorProvince = A.of('Province', h);
  const keys = [
    { pubkey: wallet, isSigner: true, isWritable: false },
    { pubkey: wallet, isSigner: true, isWritable: true },
    { pubkey: A.season, isSigner: false, isWritable: false },
    { pubkey: citizen, isSigner: false, isWritable: true },
    { pubkey: A.of('Frontier'), isSigner: false, isWritable: false },
    { pubkey: wideProvinceAddress(A.season, programId, t.p, t.q), isSigner: false, isWritable: true },
    { pubkey: wideTicketAddress(A.season, programId, citizen), isSigner: false, isWritable: true },
    { pubkey: anchor, isSigner: false, isWritable: true },
    { pubkey: anchorProvince, isSigner: false, isWritable: false },
    { pubkey: anchor, isSigner: false, isWritable: true },
    { pubkey: anchorProvince, isSigner: false, isWritable: false },
    { pubkey: SYSTEM, isSigner: false, isWritable: false },
  ];
  // (the reach witness, read-only, last: expansion-gameplay-1)
  if (intent.subject.reach) keys.push({ pubkey: wideProvinceAddress(A.season, programId, intent.subject.reach.p, intent.subject.reach.q), isSigner: false, isWritable: false });
  const data = new Uint8Array(19), dv = new DataView(data.buffer);
  data[0] = WIDE_CLAIM_TAG;
  dv.setBigInt64(1, BigInt(t.p), true); dv.setBigInt64(9, BigInt(t.q), true);
  data[17] = f.site; data[18] = f.slot;
  return { programId, keys, data };
}

/** The whole message: the claim under its compute budget (the local loaded-data limit), the wallet as fee payer. */
export function wideClaimMessage(intent, { programId, seasonId, wallet, blockhash, loadedLimit }) {
  const prefix = [setComputeUnitLimit(WIDE_CLAIM_CU), setComputeUnitPrice(0n), setLoadedAccountsDataSizeLimit(loadedLimit), requestHeapFrame(WIDE_CLAIM_HEAP)];
  return Uint8Array.from(compileMessage({ feePayer: wallet, recentBlockhash: blockhash, instructions: [...prefix, wideClaimInstruction(intent, { programId, seasonId, wallet })] }));
}

/**
 * The settler cost of a claim by a citizen who holds `holdingsN` villages BEFORE it (frontier proc citizen.rs
 * `settler_cost(holdings_n)` with C::HOLDINGS_N as read by WideClaim / FileOutpost: catalog SETTLER_COST
 * [800, 800, 400, 0, 0, 200, 0, 0] × (2 + (n−1)²) / 2 per resource; vectors/v2/web-rules.json `settler_cost`),
 * whole units: 1 village held → the second costs 800 …, 2 held → the third costs 1,200 … (loop-play11).
 */
export const SETTLER_BASE = Object.freeze([800, 800, 400, 0, 0, 200, 0, 0]);
export function settlerCost(holdingsN) {
  const k = Math.max(0, holdingsN - 1);
  return SETTLER_BASE.map(b => Math.floor(b * (2 + k * k) / 2));
}

/**
 * The wide provinces a claim from `home` may name among `opened` (`[{p, q}]`, decimal strings): those within
 * OUTPOST_RANGE of `home`, nearest first — and, with `lands` (the claimer's nation's land, `[{p, q}]`:
 * nationLandsOf; expansion-gameplay-1), after them those within OUTPOST_RANGE of some land, each with `reach` = the
 * nearest such land (the witness the claim names), nearest to home first. A land is never its own target's witness.
 */
export function claimTargets(home, opened, lands = []) {
  const wide = t => { try { return ringPosition(BigInt(t.p), BigInt(t.q)).ring >= FIRST_WIDE_RING; } catch { return false; } };
  const order = (a, b) => distance(home, a) - distance(home, b) || (a.p + ',' + a.q < b.p + ',' + b.q ? -1 : 1);
  const all = (opened ?? []).map(t => ({ p: String(t.p), q: String(t.q) })).filter(wide);
  const near = all.filter(t => distance(home, t) <= OUTPOST_RANGE).sort(order);
  const L = (lands ?? []).map(l => ({ p: String(l.p), q: String(l.q) })).filter(wide);
  if (!L.length) return near;
  const far = [];
  for (const t of all) {
    if (distance(home, t) <= OUTPOST_RANGE) continue;
    let best = null;
    for (const l of L) {
      if (l.p === t.p && l.q === t.q) continue;
      const d = distance(l, t);
      if (d <= OUTPOST_RANGE && (!best || d < best.d || (d === best.d && l.p + ',' + l.q < best.l.p + ',' + best.l.q))) best = { l, d };
    }
    if (best) far.push({ ...t, reach: { p: best.l.p, q: best.l.q } });
  }
  return [...near, ...far.sort(order)];
}

// the Province v2 site mirror and keep (frontier-abi v2/layout/province.rs: SITE_COUNT @262, SITE_MIRROR @296 × 64
// with STATE @0 (1 = a holding) and FACTION @1; KEEP @4480 with HOLDER @1 and CHANGES @6 u16)
const SITE_COUNT_AT = 262, MIRROR_AT = 296, MIRROR_BYTES = 64, KEEP_AT = 4480, NO_TILE = 0xff;
/**
 * Whether a wide province's captured bytes (4,864, a herald capture) are `faction`'s land for a claim's reach witness
 * (frontier-abi world_index/reach.rs is_nation_land): a village of the nation there (a holding-state site of that
 * faction in the site mirror), or a keep the nation holds that was taken at least once (the keep a province opened
 * with — every wide keep starts held by some nation — gives no reach). False for anything unreadable.
 */
export function isNationLandBytes(bytes, faction) {
  if (!(bytes instanceof Uint8Array) || bytes.length < KEEP_AT + 8 || !int(faction, 0, 5)) return false;
  const n = Math.min(bytes[SITE_COUNT_AT], 12);
  for (let i = 0; i < n; i++) { const o = MIRROR_AT + i * MIRROR_BYTES; if (bytes[o] === 1 && bytes[o + 1] === faction) return true; }
  const k = KEEP_AT;
  return bytes[k] !== NO_TILE && bytes[k + 1] === faction && (bytes[k + 6] | (bytes[k + 7] << 8)) > 0;
}

/** `faction`'s land among herald wide entries `[{p, q, bytes_b64}]` (isNationLandBytes) → `[{p, q}]` decimal strings. */
export function nationLandsOf(entries, faction) {
  const out = [];
  for (const e of entries ?? []) {
    try {
      const b64 = e?.bytes_b64;
      if (typeof b64 !== 'string') continue;
      const bytes = typeof Buffer !== 'undefined' ? new Uint8Array(Buffer.from(b64, 'base64')) : Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      if (isNationLandBytes(bytes, faction)) out.push({ p: String(e.p), q: String(e.q) });
    } catch { /* unreadable: no reach */ }
  }
  return out;
}

/**
 * The free sites of each wide province in a herald `/h/world/wide/route` answer (its captured province bytes, decoded
 * by the game's own Province decoder): `Map("p,q" → [site…])`, a site FREE (0) or RELEASED (3) and below its count.
 * A claim on any other site is "taken" at its settle — the settler cost spent, no village (wide-local-playable run 5:
 * site 0 of a province was reserved, state 5) — so a claim names only one of these. A province whose bytes do not
 * decode is left out (no guess).
 */
export function freeWideSites(route) {
  const out = new Map();
  for (const r of Array.isArray(route?.route) ? route.route : []) {
    try {
      const b64 = r?.capture?.bytes_b64;
      if (typeof b64 !== 'string') continue;
      const bytes = typeof Buffer !== 'undefined' ? new Uint8Array(Buffer.from(b64, 'base64')) : Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      const d = decodePrefix('Province', bytes, { profile: 2 });
      const n = Number(d.siteCount);
      const free = [];
      for (let i = 0; i < Math.min(n, 12); i++) if ([0, 3].includes(Number(d.siteMirror?.[i]?.state))) free.push(i);
      out.set(`${r.p},${r.q}`, free);
    } catch { /* not readable: not offered */ }
  }
  return out;
}

/**
 * `faction`'s land among the page's wide land cells (map/wideland.mjs wideLandOf: `villages` with their nation, `keep`
 * with its holder and `changes`) → `[{p, q}]` decimal strings: a village of the nation there, or a keep the nation
 * holds that was taken at least once (isNationLandBytes' rule over the decoded cell).
 */
export function nationLandsOfCells(cells, faction) {
  if (!int(faction, 0, 5)) return [];
  return (cells ?? []).filter(c => (c?.villages ?? []).some(v => v?.nation === faction)
    || (c?.keep && c.keep.holder === faction && Number(c.keep.changes ?? 0) > 0))
    .map(c => ({ p: String(c.p), q: String(c.q) }));
}

/** The launcher's opened list joined with the herald's current wide cells (rings > 128), each province once. */
export function mergeOpened(targets, cells) {
  const out = new Map();
  for (const t of targets ?? []) out.set(`${String(t.p)},${String(t.q)}`, { p: String(t.p), q: String(t.q) });
  for (const c of cells ?? []) if (Number(c?.ring) > 128) out.set(`${String(c.p)},${String(c.q)}`, { p: String(c.p), q: String(c.q) });
  return [...out.values()];
}
