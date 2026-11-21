// DEVNET PLAY (devnet-page-outpost) — the SECOND and THIRD village (FileOutpost) as a page-signed, WALLET-PAID devnet
// act: the connected wallet is fee payer AND actor, signs once, and pays its own fee and the village's rent deposit.
//
// The program's rule (permutation-frontier proc/citizen.rs `file_outpost_as`, permutation-rules holding.rs
// `may_found_outpost`): the anchor is the Citizen's FINAL first home (order 1), named by its host id (seq 0, its gen);
// the target is a site of a PRESENT Province (an absent one: BadAccount) at ring > `heartland_max_ring` (3), within
// `outpost_range` (3) of the home; a third village also names the slot-2 village. The settler cost is paid from the
// home's stores, and one Holding rent (layout Holding, 1280 bytes) is escrowed from the payer into the Citizen; keeper A's
// `tickets` role settles the ticket at the turn's end (SettleTicket, the same duty as a rim first village).
//
// This module is the ONE intent check and message builder both sides use: the page (flocalplay-act.mjs, the wallet
// signs) and the gateway (permutation-gateway local-play-act.mjs, which rebuilds the stated intent for the
// transaction's one signer and refuses anything that is not byte for byte the same). The instruction is the game's own
// (fplay.mjs `accountsFor('FileOutpost')`, `buildShape`), under the game's own budget prefix.
//
// The wire form (plain JSON):
//   subject {holding: {p, q, site}, gen, slot2: {p, q, site} | null, sites: [{p, q, site}]}
//   fields  {sites: [{p, q, site}], anchor_site_key: '<decimal u64>'}
// `holding` is the anchor (the first home), `gen` its generation, `slot2` the second village (a third village only),
// one target site (the page files one; the program takes 1–3).
// The target is never in the anchor's OWN province: the program's account table lists the anchor's Province read-only
// and every target Province writable, and a read-only program account that is writable is BadAccount (frontier-abi
// prologue.rs check_flags) — the same Province in both roles is always refused, whatever the rule says.
import { accountsFor, buildShape } from './fplay.mjs';
import { seasonAddresses, hostId, HOST_ID_INVALID } from './faddr.mjs';
import { ringPosition } from './map/wide.mjs';
import { budgetPrefix } from '../sdk/frontier/budgets.mjs';
import { compileMessage } from '../sdk/solana-tx.mjs';

export const OUTPOST_ACT = 'FileOutpost';
/** The program's `heartland_max_ring` and `outpost_range` of every S1 preset (S1_DEVNET_WIDE_7D included). */
export const OUTPOST_HEARTLAND_MAX_RING = 3;
export const OUTPOST_RANGE = 3;
/** layout Holding: the account FileOutpost escrows one rent of (the village's own account, made at SettleTicket). */
export const OUTPOST_HOLDING_BYTES = 1280;
/** The base fee of the transaction's one signature (lamports; the budget prefix sets no priority price). */
export const OUTPOST_FEE = 5000n;

const fail = code => { throw Object.assign(new Error(code), { code }); };
const check = (ok, code) => { if (!ok) fail(code); };
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const exact = (x, keys) => object(x) && Object.keys(x).length === keys.length && keys.every(k => Object.hasOwn(x, k));
const int = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;

/** A legacy place `{p, q, site}` (ring ≤ 128; 'WideHolding' outside). `loose`: extra keys allowed (the page's holding objects). */
function place(h, code, { loose = false } = {}) {
  check(object(h) && (loose || exact(h, ['p', 'q', 'site'])) && Number.isSafeInteger(h.p) && Number.isSafeInteger(h.q) && int(h.site, 0, 11), code);
  let ring; try { ring = ringPosition(BigInt(h.p), BigInt(h.q)).ring; } catch { fail(code); }
  check(ring <= 128n, code === 'LocalActShape' ? 'LocalActWideHolding' : code);
  return Object.freeze({ p: h.p, q: h.q, site: h.site });
}
const ringOfPlace = s => Number(ringPosition(BigInt(s.p), BigInt(s.q)).ring);
const distance = (a, b) => { const dp = a.p - b.p, dq = a.q - b.q; return Math.max(Math.abs(dp), Math.abs(dq), Math.abs(dp + dq)); };
/** The anchor key the program reads: host_id(home, gen, seq 0), as a decimal string ('' when the place has no host id). */
export function anchorKeyOf(home, gen) {
  const k = hostId({ p: home.p, q: home.q, site: home.site, gen, seq: 0 });
  return k === HOST_ID_INVALID ? '' : k.toString();
}

/**
 * The checked wire intent (frozen) from `subject` and `fields`, or throws `code`. The target must be outside the
 * heartland and within range of the anchor (the program's own count; it re-checks everything, and the gateway reads the
 * real accounts); the key must be the anchor's own host id.
 */
export function outpostIntent(subject, fields, code = 'LocalActInvalid') {
  check(exact(subject, ['holding', 'gen', 'slot2', 'sites']) && exact(fields, ['sites', 'anchor_site_key']), code);
  const home = place(subject.holding, code);
  check(int(subject.gen, 0, 255), code);
  const slot2 = subject.slot2 === null ? null : place(subject.slot2, code);
  check(Array.isArray(subject.sites) && subject.sites.length === 1 && Array.isArray(fields.sites) && fields.sites.length === 1, code);
  const t = place(subject.sites[0], code), f = place(fields.sites[0], code);
  check(t.p === f.p && t.q === f.q && t.site === f.site, code);
  check(ringOfPlace(t) > OUTPOST_HEARTLAND_MAX_RING && distance(home, t) <= OUTPOST_RANGE && !(t.p === home.p && t.q === home.q), code);
  check(slot2 === null || !(slot2.p === home.p && slot2.q === home.q && slot2.site === home.site), code);
  const key = anchorKeyOf(home, subject.gen);
  check(key !== '' && fields.anchor_site_key === key, code);
  return Object.freeze({ name: OUTPOST_ACT, subject: Object.freeze({ holding: home, gen: subject.gen, slot2, sites: Object.freeze([t]) }),
    fields: Object.freeze({ sites: Object.freeze([t]), anchor_site_key: key }) });
}

/**
 * The page's order (controller.mjs `act('FileOutpost', {v, fields})`) in the wire form: `v = {sites: [target], anchor,
 * slot2}` (the page's holding objects: `anchor.gen` is read), `fields = {sites, anchor_site_key}` (a bigint key).
 */
export function outpostIntentOf(v, fields) {
  check(object(v) && object(fields) && Array.isArray(v.sites) && v.sites.length === 1, 'LocalActShape');
  const anchor = place(v.anchor, 'LocalActShape', { loose: true });
  const gen = Number(v.anchor.gen);
  const second = v.slot2 && !(v.slot2.p === anchor.p && v.slot2.q === anchor.q && v.slot2.site === anchor.site) ? place(v.slot2, 'LocalActShape', { loose: true }) : null;
  const key = typeof fields.anchor_site_key === 'bigint' ? fields.anchor_site_key.toString() : fields.anchor_site_key;
  const t = place(v.sites[0], 'LocalActShape', { loose: true });
  return outpostIntent({ holding: anchor, gen, slot2: second, sites: [t] }, { sites: [t], anchor_site_key: key }, 'LocalActShape');
}

/**
 * The unsigned message of a checked intent: the game's own FileOutpost (fplay.mjs) for `wallet` as fee payer AND
 * actor, under the game's budget prefix with `loadedLimit`. → Uint8Array. Throws on a shape that would need another signer.
 */
export function outpostMessage(intent, { programId, seasonId, wallet, blockhash, loadedLimit, profile }) {
  check(intent?.name === OUTPOST_ACT, 'LocalActNotAllowed');
  const A = seasonAddresses(programId, String(seasonId));
  const s = intent.subject;
  const v = { addresses: A, wallet, actor: wallet, profile, sites: [...s.sites], anchor: s.holding, slot2: s.slot2 ?? undefined };
  const fields = { sites: [...intent.fields.sites], anchor_site_key: BigInt(intent.fields.anchor_site_key) };
  const built = buildShape({ programId, name: OUTPOST_ACT, accounts: accountsFor(OUTPOST_ACT, v), fields, feePayer: wallet, blockhash, profile });
  check(built.signers.length === 0, 'LocalActSigner');
  const prefix = budgetPrefix(OUTPOST_ACT, { profile, loadedLimit });
  return Uint8Array.from(compileMessage({ feePayer: wallet, recentBlockhash: blockhash, instructions: [...prefix, built.expected] }));
}

/**
 * What the wallet pays for one FileOutpost, in lamports (BigInt): the rent deposit (one Holding rent, less what the
 * Citizen already holds in escrow) and the one signature's fee. `holdingRent` = the cluster's rent of 1280 bytes (the
 * gateway's context answer), `escrow` = the Citizen's TICKET_ESCROW (0 when unknown: the bound is then the full rent).
 */
export function outpostCost({ holdingRent, escrow = 0n }) {
  const rent = BigInt(holdingRent), held = BigInt(escrow ?? 0n);
  const deposit = rent > held ? rent - held : 0n;
  return Object.freeze({ deposit, fee: OUTPOST_FEE, total: deposit + OUTPOST_FEE });
}
/** Lamports as SOL text with up to 9 decimals, trailing zeros dropped ("0.007157640" → "0.00715764"). */
export function solText(lamports) {
  const n = BigInt(lamports), whole = n / 1_000_000_000n, frac = (n % 1_000_000_000n).toString().padStart(9, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}
