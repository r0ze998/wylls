// Where the display contract's states come from (workstream 07; the views
// are hud/statusview.mjs). Two kinds of source:
//
//   from the S1 records, here     a caravan's arrival in five states, from the
//                                 records and the program's own rules:
//                                 - past its arrival turn and still on the road
//                                   (the caravans feed lists it): overdue, not
//                                   arrived
//                                 - CARAVAN_SETTLED, outcome lost: lost
//                                 - delivered to a storehouse: not verified.
//                                   caravan.rs settle_caravan cuts each amount
//                                   at the vault's cap (have + c, at most
//                                   max(cap, have)) while the record keeps the
//                                   whole cargo, and the page reads no vault
//                                   stores to compare
//                                 - delivered to a village: Holding::credit adds
//                                   the whole amount with no cap (holding.rs),
//                                   so what went in is the record's cargo; it is
//                                   verified full or partial against
//                                   CARAVAN_SENT's cargo (which is after the
//                                   towers' wear, caravan.rs send), and not
//                                   verified when that send was not read
//   registered by their owners    04's arrival (it replaces the above when 04
//                                 registers it), 04's cancel of a caravan, 05's
//                                 costs of a village and its switch back to
//                                 manual play. With nothing registered nothing
//                                 of theirs is shown: the page has no cancel and
//                                 no reservation of its own, and none is
//                                 invented here.
//
// A source returns the contract's plain object (statusview.mjs names its
// fields) or null when it has nothing to say; a source that throws says
// nothing.

const sources = new Map();
/** The kinds a source may be registered for, and who owns them. */
export const SOURCE_KINDS = Object.freeze({
  caravanArrival: '04', // (FS, caravan on the road) → arrivalView input | null (replaces the page's own when given)
  caravanCancel: '04', // (FS, caravan {ownerTag, seq, …}) → cancelView input | null
  villageCosts: '05', // (FS, holding) → {costs: [costView input], committedInHave: boolean} | null
  manualPlay: '05', // (FS) → manualView input | null
});

/** Register a source for one kind (a second replaces the first). Returns a function that removes it. */
export function registerStatusSource(kind, fn) {
  if (!Object.hasOwn(SOURCE_KINDS, kind) || typeof fn !== 'function') throw new TypeError(`status source: one of ${Object.keys(SOURCE_KINDS).join(', ')}, and a function`);
  sources.set(kind, fn);
  return () => { if (sources.get(kind) === fn) sources.delete(kind); };
}
/** What the source of `kind` says, or null (none registered, nothing to say, or it threw). */
export function statusFrom(kind, ...args) {
  const fn = sources.get(kind);
  if (!fn) return null;
  try { return fn(...args) ?? null; } catch { return null; }
}

/** caravan.rs place kinds (frontier-abi v2 layout s1.rs PL::KIND_*), from a record's `dst` (u64, kind in its low byte). */
export const DST_HOLDING = 1, DST_VAULT = 2;
export const dstKind = dst => { try { return dst === undefined || dst === null ? null : Number(BigInt(dst) & 0xffn); } catch { return null; } };
/** caravan.rs caravan_outcome: 0 delivered, 1 lost. */
const LOST = 1;

/** A caravan still on the road (the caravans feed): overdue once its arrival turn has come — not arrived —, else nothing yet. */
export function arrivalOnRoad(c, nowBell) {
  const at = c?.arriveBell;
  return Number.isFinite(at) && at <= Number(nowBell ?? 0) ? { state: 'overdue', bell: at } : null;
}

/**
 * A settlement read. `settled`: `{outcome, dst, cargo}` from CARAVAN_SETTLED;
 * `sent`: `{cargo, wornBps}` from the same caravan's CARAVAN_SENT, or null
 * when it was not read. → arrivalView input.
 */
export function arrivalSettled(settled, sent) {
  const ok = c => Array.isArray(c) && c.length === 8;
  if (Number(settled?.outcome) === LOST) return { state: 'lost', recorded: ok(settled.cargo) ? settled.cargo : null };
  const kind = dstKind(settled?.dst), recorded = ok(settled?.cargo) ? settled.cargo : null;
  if (kind === DST_VAULT) return { state: 'settledUnverified', why: 'vault', recorded, sent: sent?.cargo ?? null };
  if (kind !== DST_HOLDING || !recorded) return { state: 'settledUnverified', why: 'dstUnknown', recorded };
  if (!ok(sent?.cargo)) return { state: 'settledUnverified', why: 'sentUnknown', recorded };
  const full = recorded.every((n, i) => n >= sent.cargo[i]);
  return full ? { state: 'verifiedFull', arrived: recorded, wornBps: sent.wornBps ?? 0 } : { state: 'verifiedPartial', sent: sent.cargo, arrived: recorded, wornBps: sent.wornBps ?? 0 };
}
