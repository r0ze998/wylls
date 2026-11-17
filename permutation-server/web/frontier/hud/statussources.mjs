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
const DELIVERED = 0, LOST = 1;
/**
 * The program version whose settlement rules the village reading below was checked against (permutation-frontier
 * lib.rs PROGRAM_VERSION = PROGRAM_VERSION_S1, the S1 program). Under any other version a village's intake is not read
 * from the record.
 */
export const S1_PROGRAM_VERSION = 4;

/**
 * The viewer's caravans that left the road's list (the caravans feed) while this page watched it, before any record of
 * their end was read. Kept in memory only: a reload starts with nothing, and says nothing of caravans it never saw.
 * `observe(moving)` takes the list as read (skip it when the list was not read) → the gone ones, `[{key, ownerTag, seq,
 * arriveBell}]`, oldest first; `ended(key)` drops one once its settlement or a raid on it is read (returnsum.caravanKey
 * form: "<owner tag>:<seq>"); `reset()` forgets all (another wallet or season).
 */
export function createCaravanWatch() {
  const seen = new Map(), gone = new Map(), done = new Set();
  const keyOf = c => { try { return `${BigInt(c.ownerTag)}:${c.seq}`; } catch { return null; } };
  return {
    observe(moving) {
      const now = new Map();
      for (const c of moving ?? []) { const k = keyOf(c); if (k !== null) now.set(k, c); }
      for (const [k, c] of seen) if (!now.has(k) && !done.has(k)) gone.set(k, { key: k, ownerTag: c.ownerTag, seq: c.seq, arriveBell: c.arriveBell ?? null });
      for (const k of now.keys()) gone.delete(k);
      seen.clear();
      for (const [k, c] of now) seen.set(k, c);
      return [...gone.values()];
    },
    ended(key) { done.add(String(key)); gone.delete(String(key)); seen.delete(String(key)); },
    reset() { seen.clear(); gone.clear(); done.clear(); },
  };
}

/** A caravan still on the road (the caravans feed): overdue once its arrival turn has come — not arrived —, else nothing yet. */
export function arrivalOnRoad(c, nowBell) {
  const at = c?.arriveBell;
  return Number.isFinite(at) && at <= Number(nowBell ?? 0) ? { state: 'overdue', bell: at } : null;
}

/**
 * A settlement read. `settled`: `{outcome, dst, cargo}` from CARAVAN_SETTLED;
 * `sent`: `{cargo, wornBps, dst}` from the same caravan's CARAVAN_SENT, or
 * null when it was not read; `rules`: `{programVersion}` of the season.
 * → arrivalView input. Two judgements are kept apart:
 *   intake    what went into the destination is known: a delivered outcome,
 *             to a village, under the S1 program's rules (Holding::credit adds
 *             the record's cargo whole). Counted in the record's units (whole
 *             amounts: cargo_log drops what is under one).
 *   compare   whether that is all of what the send recorded: the send read,
 *             to the very place (kind, province, site, generation, tile) the
 *             settlement names. The send's cargo is AFTER the towers' wear —
 *             the first loaded amount and the road's loss are not in it, and
 *             nothing is worked out for them.
 * A settlement at another place than the send named: when a take of the caravan was read after its send (`sent.taken`),
 * the holder is the raider, who chose the new place — the intake is told, not compared (dstChanged). With no take read,
 * the cause is not known from these records: it is `misdelivered`, nothing is counted as this caravan's arrival, and no
 * cause (a raid or anything else) is named. (04 HANDOFF §2 DestinationMismatch)
 */
export function arrivalSettled(settled, sent, { programVersion } = {}) {
  const ok = c => Array.isArray(c) && c.length === 8;
  const outcome = Number(settled?.outcome), recorded = ok(settled?.cargo) ? settled.cargo : null;
  if (outcome === LOST) return { state: 'lost', recorded };
  if (outcome !== DELIVERED) return { state: 'settledUnverified', why: 'outcomeUnknown', recorded };
  const kind = dstKind(settled?.dst);
  if (kind === DST_VAULT) return { state: 'settledUnverified', why: 'vault', recorded };
  if (kind !== DST_HOLDING || !recorded) return { state: 'settledUnverified', why: 'dstUnknown', recorded };
  if (Number(programVersion) !== S1_PROGRAM_VERSION) return { state: 'settledUnverified', why: 'rulesUnknown', recorded };
  if (!ok(sent?.cargo)) return { state: 'verifiedIntake', intake: recorded, compare: 'sentUnknown' };
  const samePlace = (() => { try { return sent.dst !== undefined && sent.dst !== null && BigInt(sent.dst) === BigInt(settled.dst); } catch { return false; } })();
  if (!samePlace) return sent.taken === true ? { state: 'verifiedIntake', intake: recorded, compare: 'dstChanged' } : { state: 'misdelivered', recorded };
  const full = recorded.every((n, i) => n >= sent.cargo[i]);
  const base = { basis: 'sentRecord', sent: sent.cargo, arrived: recorded, wornBps: sent.wornBps ?? 0 };
  return full ? { state: 'verifiedFull', ...base } : { state: 'verifiedPartial', ...base };
}
