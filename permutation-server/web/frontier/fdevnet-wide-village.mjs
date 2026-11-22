// DEVNET PLAY (devnet-p17, devnet gap P17) — a WIDE village's own acts on a devnet season the page plays itself:
// Harvest, Build, Train and Muster over the player's wide village (rings 129+, won by a wide claim or reached by an
// expedition), each ONE page-signed, WALLET-PAID transaction (the connected wallet is fee payer AND actor).
//
// The program (permutation-frontier proc/wide.rs, the devnet playable build 67a33c92… routes all of them):
//   WideHarvest  0xDA op 3, action Harvest            the stores settle; nothing is bought            (fee only)
//   WideBuild    0xDA op 3, action Build item 0-7      a building (0-5), the walls (6), the tier-up (7) (fee only)
//   WideTrain    0xDA op 3, action Train unit, n       paid at once from the stores, into the reserve  (fee only)
//   WideMuster   0xDA op 1, unit, troops, tile         a host out of the reserve onto a passable tile; the FIRST muster
//                                                     of the province creates its wide roster (3,248 bytes) from the
//                                                     payer (rent), every later one does not            (fee [+ rent])
// WideMuster also needs the village FINAL (NotFinal), the province resolved to the previous bell (NotResident: keeper
// A's `wide-resolve` role keeps it so), at least 100 troops of the unit in the reserve (MIN_HOST_TROOPS; Insufficient)
// and a passable tile of the province (BadData). WideEconomy reads no cursor. WideGarrison (op 4) and WideDepart are
// not offered here (the devnet build keeps WideDepart's debit closed: NotImplemented).
//
// The intent and the message are the shared builder's (flocalplay-wide-host.mjs), which the gateway rebuilds byte for
// byte (devnet-play-act.mjs). This module is the page's own: the cost preview, the checks the page can make from the
// village's captured record before anything is signed, and the result read back from the next record.
//
// FOG (map/fog.mjs, DEVNET_FOG): only the player's own village and its own province are read here — the village's
// record (`/h/me`) and the province's passable tiles and turn cursor (`/h/world/wide/route` for that one province);
// nothing about any other player's hosts or land is shown.
import { WIDE_HARVEST, WIDE_BUILD, WIDE_TRAIN, WIDE_MUSTER, WIDE_VILLAGE_ACTS, WIDE_BUILD_ITEM_MAX, WIDE_MIN_HOST_TROOPS, BUILD_ITEM_WALLS, BUILD_ITEM_TIER_UP } from './flocalplay-wide-host.mjs';

export { WIDE_VILLAGE_ACTS, WIDE_HARVEST, WIDE_BUILD, WIDE_TRAIN, WIDE_MUSTER };
/** The base fee of the transaction's one signature (lamports; the budget prefix sets no priority price). */
export const WIDE_VILLAGE_FEE = 5000n;
/** A preview is good for this long (ms); the send checks everything again anyway. */
export const WIDE_VILLAGE_PREVIEW_MS = 120_000;
/** The gateway's context schema of a wide village's act. */
export const WIDE_VILLAGE_CONTEXT_SCHEMA = 'frontier-devnet-play-wide-village-context-v1';
/** The most troops one Train or Muster names on the page (the legacy forms' bound). */
export const WIDE_VILLAGE_MAX_TROOPS = 30_000;
/** The units the ABI's Train and Muster take (0-6, `UNIT_ORDER`). */
export const WIDE_UNITS = Object.freeze([0, 1, 2, 3, 4, 5, 6]);
/** Holding v2 states (fland.mjs HOLDING_STATE): 1 provisional, 2 final. */
const PROVISIONAL = 1, FINAL = 2;
/** Province v2 layout (codec.mjs layoutOf('Province', 2)): the turn cursor and the passable mask, as the program reads them. */
const PV = Object.freeze({ RESOLVED_NEXT: 72, PASSABLE_MASK: 264, MIN: 272 });

const int = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const no = (code, extra = {}) => Object.freeze({ ok: false, code, ...extra });

/**
 * What the wallet pays for one act, in lamports (BigInt): the rent of the wide roster when a muster creates it (the
 * gateway's `roster_rent` for this cluster; nothing when `rosterPresent`), and the one signature's fee.
 */
export function wideVillageCost({ name, rosterRent = 0n, rosterPresent = true }) {
  const deposit = name === WIDE_MUSTER && !rosterPresent ? BigInt(rosterRent) : 0n;
  return Object.freeze({ deposit, fee: WIDE_VILLAGE_FEE, total: deposit + WIDE_VILLAGE_FEE });
}

/** The captured bytes of the village's own wide province → `{resolvedNext, passable: [tile…]}`, or null when they do not read. */
export function wideProvinceFacts(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < PV.MIN) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const mask = v.getBigUint64(PV.PASSABLE_MASK, true);
  const passable = [];
  for (let t = 0; t < 61; t++) if ((mask >> BigInt(t)) & 1n) passable.push(t);
  return Object.freeze({ resolvedNext: v.getUint32(PV.RESOLVED_NEXT, true), passable: Object.freeze(passable) });
}

/** The wire subject of a captured wide village (p/q decimal strings: a BigInt coordinate is never sent as a subject). */
export const wideVillageOf = holding => Object.freeze({ p: String(holding.p), q: String(holding.q), site: Number(holding.site) });

/**
 * The page's own checks of one act over the selected wide slot `entry` (fwide.mjs selectedWide), from its captured
 * record — the program checks everything again, and the gateway's send is preflighted (a refusal there is "not sent").
 * `fields` as the act takes them; `province` = wideProvinceFacts of the village's province (muster only; null = not
 * read); `nowBell` the page's turn. → `{ok: true, warn: [..codes]}` or `{ok: false, code}`.
 */
export function wideVillageCheck(entry, { name, fields = {}, province = null, nowBell = null } = {}) {
  if (!WIDE_VILLAGE_ACTS.includes(name)) return no('LocalActNotAllowed');
  const h = entry?.holding;
  if (!h || entry.status !== 'captured-unverified') return no('WideVillageUnread');
  const x = h.economy, state = Number(x?.state);
  if (state !== PROVISIONAL && state !== FINAL) return no('WideVillageNotLive');
  const warn = [];
  if (name === WIDE_HARVEST) return Object.freeze({ ok: true, warn });
  if (name === WIDE_BUILD) {
    if (!int(fields.item, 0, WIDE_BUILD_ITEM_MAX)) return no('WideVillageShape');
    if (Array.isArray(x.queue) && x.queue.length && x.queue.every(q => q.inUse)) return no('QueueFull');
    return Object.freeze({ ok: true, warn });
  }
  if (!int(fields.unit, 0, 6)) return no('WideVillageShape');
  if (name === WIDE_TRAIN) return int(fields.n, 1, WIDE_VILLAGE_MAX_TROOPS) ? Object.freeze({ ok: true, warn }) : no('WideVillageShape');
  // WideMuster
  if (state !== FINAL) return no('NotFinal');
  if (!int(fields.troops, WIDE_MIN_HOST_TROOPS, WIDE_VILLAGE_MAX_TROOPS)) return no('WideVillageTroops');
  const have = Number(x.reserve?.[fields.unit] ?? 0);
  if (have < fields.troops) return no('Insufficient', { have });
  if (!province) return no('WideProvinceUnread');
  if (!province.passable.includes(fields.tile)) return no('WideVillageTile');
  // (the province's cursor as captured: a lag here is a warning — the capture may be older than the chain; the send's
  //  preflight is the program's own word, NotResident 26)
  if (Number.isInteger(nowBell) && province.resolvedNext + 1 < nowBell) warn.push('WideProvinceLag');
  return Object.freeze({ ok: true, warn });
}

/** Whether a Build item writes the province's site mirror (walls, the tier-up): its account list names the province writable. */
export const mirrorItem = item => item === BUILD_ITEM_WALLS || item === BUILD_ITEM_TIER_UP;

/**
 * The result read back: what changed between the village's record before the send (`before`, its economy) and a
 * later record (`after`). → `{changed, reserve: [{unit, from, to}], queue: {from, to}, walls: {from, to}, tier: {from, to},
 * stores: [{resource, from, to}], touched}` — every figure the record's own, nothing projected.
 */
export function wideVillageResult(before, after) {
  const out = { reserve: [], stores: [], queue: null, walls: null, tier: null, touched: false };
  if (!before || !after) return Object.freeze({ ...out, changed: false });
  for (let u = 0; u < 7; u++) { const a = Number(before.reserve?.[u] ?? 0), b = Number(after.reserve?.[u] ?? 0); if (a !== b) out.reserve.push({ unit: u, from: a, to: b }); }
  const used = e => (e.queue ?? []).filter(q => q.inUse).length;
  if (used(before) !== used(after)) out.queue = { from: used(before), to: used(after) };
  if (String(before.walls) !== String(after.walls)) out.walls = { from: Number(before.walls), to: Number(after.walls) };
  if (Number(before.tier) !== Number(after.tier)) out.tier = { from: Number(before.tier), to: Number(after.tier) };
  for (let i = 0; i < (after.stores ?? []).length; i++) {
    const a = before.stores?.[i]?.value, b = after.stores[i].value;
    if (a !== undefined && String(a) !== String(b)) out.stores.push({ resource: after.stores[i].resource, from: String(a), to: String(b) });
  }
  out.touched = String(before.lastOwnerAction) !== String(after.lastOwnerAction);
  const changed = out.touched || out.reserve.length > 0 || out.queue !== null || out.walls !== null || out.tier !== null || out.stores.length > 0;
  return Object.freeze({ ...out, changed });
}
