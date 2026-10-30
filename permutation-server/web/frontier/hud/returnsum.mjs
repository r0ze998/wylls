// What happened while the viewer was away, from the season's records and
// from nothing else (workstream 07; app.mjs tickFeed tells it on the page's
// first look, and the S1 records it reads between two looks).
//
// Today (hud/feed.mjs diffFeed): a page's first snapshot "is not news", so a
// player who opens the page sees no notification of anything that happened
// before; the chronicle starts CHRONICLE_WINDOW (500) events behind the
// head and keeps 400 (controller.mjs), and diffFeed knows no S1 record — a
// caravan raided or lost, a storehouse or a structure seized, a siege
// declared on the viewer's village, a nation's vote decided. The herald
// keeps every event (/h/events?after=, frontier-node herald server.rs over
// the findex index), and the page decodes every S1 kind (flog.mjs with the
// v2 log table), so the summary needs no new record and no new instruction.
// The words are hud/returnwords.mjs's.
//
// Two marks are kept apart:
//   fetched    the events this page has read (seq range, turns), told as
//              such ("records read up to turn N")
//   confirmed  the last event the player said they have seen, by pressing
//              "確認した"; only that moves the next summary's start
// and the summary says which case it is in: the first time on this device
// for this season and wallet (which is also what another device or a
// cleared browser looks like: the page cannot tell them apart and says so),
// another wallet on this device, a new season, or a gap — events between
// the confirmed mark and the first one read that the page did not get —
// which it names as a gap and never fills in.
//
// The mark moves only over records this page read without a hole
// (`confirmable`): with a gap it stays where it is; with a read that stopped
// early it moves to the last record read; on a first look it records the
// turn the look started from (`horizonBell`), so a later look says that
// nothing before that turn was seen on this device. The records are read
// for the summary by hud/awayread.mjs from the mark itself (the herald keeps
// them all), not from the chronicle's window.
//
// A caravan's records keep its SENDER's tag after a take (caravan.rs:
// OWNER_TAG "stays the address seed"), so who holds it now is folded from
// the records read (`caravanBook`) and kept with the mark for the caravans
// still on the road. A caravan whose send and takes this page never read
// has an unknown holder, and its records are told as such, never as the
// sender's own.
//
// A loss is told only from the record that logged it, with the amounts the
// record carries; nothing is estimated.
import { TRANSIT_OUTCOMES } from '../flog.mjs';
import { arrivalSettled } from './statussources.mjs';


export const STORE_VERSION = 2;
/** nation.rs proposal kinds: 1 a stance, 2 an expulsion, 3 a readmission (screens/s1.mjs PROPOSE_*). */
export const PROPOSAL_KIND = Object.freeze({ 1: 'stance', 2: 'expel', 3: 'readmit' });
/** How many turns back a first summary on a device looks (the page cannot know the player's last visit). */
export const FIRST_LOOK_BELLS = 144;
/** Most items the summary lists before "and N more in the chronicle". */
export const SUMMARY_MAX = 6;
/** Most caravans on the road kept with the mark (the oldest are dropped first; a dropped one reads as unknown). */
export const BOOK_MAX = 256;
/** A caravan's holder when the records read do not say (its send and takes were before them). */
export const UNKNOWN = 'unknown';

const big = v => { try { return v === null || v === undefined || v === '' ? null : BigInt(v); } catch { return null; } };
const same = (a, b) => big(a) !== null && big(b) !== null && big(a) === big(b);

/** The cargo of a record (`[u8; 32]`: eight u32 whole units, caravan.rs cargo_log) as numbers. */
export function cargoOf(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== 32) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, 32);
  return Array.from({ length: 8 }, (_, i) => v.getUint32(i * 4, true));
}

/**
 * The records as the summary reads them: one per seq (a page read twice, or two pages that overlap, give the same
 * record twice), oldest first (a page may come back out of order). → `{records, dups, reordered, bad}`; `bad`
 * counts entries with no usable seq, which are dropped.
 */
export function normalizeRecords(records = []) {
  const seen = new Map();
  let dups = 0, bad = 0, reordered = false, prev = null;
  for (const x of records) {
    const s = big(x?.seq);
    if (s === null || !x.record) { bad++; continue; }
    if (prev !== null && s < prev) reordered = true;
    prev = s;
    if (seen.has(s)) { dups++; continue; }
    seen.set(s, { ...x, seq: String(s) });
  }
  const out = [...seen.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([, x]) => x);
  return { records: out, dups, reordered, bad };
}

/** A caravan's key: its sender's tag and its seq (the records keep both). */
export const caravanKey = r => (r?.owner_tag !== undefined && r?.seq !== undefined ? `${big(r.owner_tag)}:${r.seq}` : null);

/**
 * Who holds each caravan, from a starting book (`{key: holder}`, the mark's) and the records read, oldest first.
 * A holder is a tag (decimal string), null for a burned caravan (it walks on empty) or UNKNOWN. → Map key → holder.
 * Records on a caravan the book never saw leave it UNKNOWN until its send is read.
 */
export function caravanBook(start = {}, records = []) {
  const book = new Map(Object.entries(start ?? {}).map(([k, v]) => [k, v === null ? null : String(v)]));
  for (const x of records) fold(book, x.record);
  return book;
}
function fold(book, r) {
  const key = caravanKey(r);
  if (!key) return;
  if (r.name === 'CARAVAN_SENT') book.set(key, String(big(r.owner_tag)));
  else if (r.name === 'CARAVAN_RAIDED') book.set(key, r.choice === 1 ? null : String(big(r.raider_tag)));
  else if (r.name === 'CARAVAN_SETTLED') book.delete(key);
}
const holderOf = (book, r) => { const k = caravanKey(r); return k && book?.has(k) ? book.get(k) : UNKNOWN; };

/** The device's key for a season and a wallet. */
export const storeKey = (seasonId, wallet) => `ws07-return:${seasonId}:${wallet}`;

/**
 * Read the stored marks (`{v, seasonId, wallet, confirmedSeq, confirmedBell, horizonBell, caravans, confirmedAt}`),
 * null when none, unreadable or of another season or wallet. A version 1 mark (before the horizon and the book)
 * reads with no horizon and an empty book.
 */
export function loadMarks(storage, seasonId, wallet) {
  try {
    const raw = storage?.getItem?.(storeKey(seasonId, wallet));
    const m = raw ? JSON.parse(raw) : null;
    if (!m || (m.v !== 1 && m.v !== STORE_VERSION) || String(m.seasonId) !== String(seasonId) || m.wallet !== wallet || big(m.confirmedSeq) === null) return null;
    return { v: STORE_VERSION, seasonId: String(m.seasonId), wallet: m.wallet, confirmedSeq: String(big(m.confirmedSeq)), confirmedBell: Number(m.confirmedBell ?? 0), horizonBell: m.horizonBell ?? null, caravans: m.caravans && typeof m.caravans === 'object' ? m.caravans : {}, confirmedAt: m.confirmedAt ?? null };
  } catch { return null; }
}
/** What this device last used: `{seasonId, wallet}` or null (to tell "another wallet" and "a new season"). */
export function loadLast(storage) {
  try { const m = JSON.parse(storage?.getItem?.('ws07-return:last') ?? 'null'); return m && m.seasonId !== undefined ? m : null; } catch { return null; }
}

/**
 * The player pressed "確認した" on a summary whose `confirm` is ok: the mark moves to `confirm.toSeq`. A mark never
 * moves back (another tab may have moved it further). Returns `{marks, moved}`, or null when storage refused (the
 * mark is then where it was, and the page says so).
 */
export function confirm(storage, { seasonId, wallet, confirm: c, at }) {
  if (!c?.ok) return null;
  try {
    const had = loadMarks(storage, seasonId, wallet);
    // (a mark beyond the season's head is not this history's — summarize says markAhead — and is replaced)
    if (had && !c.reset && big(had.confirmedSeq) >= big(c.toSeq)) return { marks: had, moved: false };
    const entries = Object.entries(c.caravans ?? {});
    const m = { v: STORE_VERSION, seasonId: String(seasonId), wallet, confirmedSeq: String(c.toSeq), confirmedBell: c.toBell, horizonBell: c.horizonBell ?? null,
      caravans: Object.fromEntries(entries.slice(Math.max(0, entries.length - BOOK_MAX))), confirmedAt: at };
    storage.setItem(storeKey(seasonId, wallet), JSON.stringify(m));
    storage.setItem('ws07-return:last', JSON.stringify({ seasonId: String(seasonId), wallet }));
    const back = loadMarks(storage, seasonId, wallet);
    return back && back.confirmedSeq === m.confirmedSeq ? { marks: back, moved: true } : null;
  } catch { return null; }
}

/**
 * One record as a summary item, or null when it is not the viewer's news.
 * `me`: `{tag (citizen tag), faction, holdings: [{p, q, site}], hostOf(id) →
 * holding or null}`. `book`: caravanBook() as it stood just before this
 * record (null: nothing known, every caravan's holder is unknown). Items:
 * `{seq, bell, kind, tone ('loss' | 'threat' | 'gain' | 'nation' | 'result'
 * | 'uncertain'), rank (3 most pressing), facts, at: {p, q, tile?}}`. A
 * caravan item's facts carry `sender` ('me' or 'other') and `holder` ('me',
 * 'other', 'burned' or 'unknown') apart.
 */
export function itemOf({ seq, record: r }, me, book = null) {
  const mineHolding = (p, q, site) => (me.holdings ?? []).some(h => h.p === p && h.q === q && (site === undefined || h.site === site));
  const base = { seq: String(seq), bell: Number(r.bell ?? r.logBell), kind: r.name };
  const held = holderOf(book, r);
  const who = { sender: same(r.owner_tag, me.tag) ? 'me' : 'other', holder: held === UNKNOWN ? 'unknown' : held === null ? 'burned' : same(held, me.tag) ? 'me' : 'other' };
  switch (r.name) {
    case 'CARAVAN_RAIDED': {
      const facts = { ...who, choice: r.choice === 1 ? 'burn' : 'take', byDefault: r.by === 1, cargo: cargoOf(r.taken), seq: r.seq };
      // (the raider first: a sender who takes back a caravan taken from it gained, it did not lose)
      if (same(r.raider_tag, me.tag)) return { ...base, tone: 'gain', rank: 1, at: { p: r.p, q: r.q }, facts };
      if (who.holder === 'me') return { ...base, tone: 'loss', rank: 3, at: { p: r.p, q: r.q }, facts };
      if (who.holder === 'unknown' && who.sender === 'me') return { ...base, tone: 'uncertain', rank: 2, at: { p: r.p, q: r.q }, facts };
      return null;
    }
    case 'RAID_OPENED':
      // (the raid is decided within RAID_DECIDE_BELLS by the raider, else by default: the outcome is CARAVAN_RAIDED's)
      if (who.holder === 'me') return { ...base, tone: 'threat', rank: 2, at: { p: r.p, q: r.q }, facts: { ...who, seq: r.seq } };
      if (who.holder === 'unknown' && who.sender === 'me') return { ...base, tone: 'uncertain', rank: 1, at: { p: r.p, q: r.q }, facts: { ...who, seq: r.seq } };
      return null;
    case 'CARAVAN_SETTLED': {
      // (a burned caravan still walks on, empty, and is logged as delivered: nothing arrived for anyone)
      const facts = { ...who, cargo: cargoOf(r.cargo), seq: r.seq };
      if (who.holder === 'me') return r.outcome === 1 ? { ...base, tone: 'loss', rank: 3, facts: { ...facts, lost: true } } : { ...base, tone: 'result', rank: 1, facts: { ...facts, delivered: true } };
      if (who.holder === 'unknown' && who.sender === 'me') return { ...base, tone: 'uncertain', rank: 1, facts: { ...facts, lost: r.outcome === 1 } };
      return null;
    }
    case 'VAULT_SEIZED':
    case 'STRUCTURE_SEIZED': {
      const what = r.name === 'VAULT_SEIZED' ? 'vault' : (['', 'tower', 'palisade', 'fort'][r.kind] ?? 'structure');
      if (same(r.prev_tag, me.tag)) return { ...base, tone: 'loss', rank: 3, at: { p: r.p, q: r.q, tile: r.tile }, facts: { what } };
      if (same(r.captor_tag, me.tag)) return { ...base, tone: 'gain', rank: 1, at: { p: r.p, q: r.q, tile: r.tile }, facts: { what } };
      return null;
    }
    case 'SIEGE_DECLARED':
      return same(r.owner_tag, me.tag) ? { ...base, tone: 'threat', rank: 3, at: { p: r.p, q: r.q }, facts: { attacker: r.attacker, required: r.required } } : null;
    case 'CAPTURE_SETTLED':
      if (same(r.victim_tag, me.tag)) return { ...base, tone: 'loss', rank: 3, at: { p: r.p, q: r.q }, facts: { village: true } };
      if (same(r.captor_tag, me.tag)) return { ...base, tone: 'gain', rank: 2, at: { p: r.p, q: r.q }, facts: { village: true } };
      return null;
    case 'NATION_DECIDED':
      if (r.faction !== me.faction) return null;
      return { ...base, tone: 'nation', rank: same(r.target_tag, me.tag) ? 3 : 2, facts: { passed: r.passed === 1, proposal: PROPOSAL_KIND[r.kind] ?? 'other', target: r.target_faction, value: r.value, aboutMe: same(r.target_tag, me.tag), yes: r.yes, no: r.no } };
    case 'NATION_PROPOSED':
      if (r.faction !== me.faction) return null;
      return { ...base, tone: 'nation', rank: same(r.target_tag, me.tag) ? 3 : 1, facts: { open: true, proposal: PROPOSAL_KIND[r.kind] ?? 'other', target: r.target_faction, value: r.value, closeBell: r.close_bell, aboutMe: same(r.target_tag, me.tag) } };
    case 'TRANSIT_SETTLED': {
      const h = me.hostOf?.(r.host_id);
      if (!h) return null;
      // (frontier-abi log transit_outcome: 1 Stays … 8 BadSeal, as screens/chronicle.mjs reads them)
      const outcome = TRANSIT_OUTCOMES[Number(r.outcome) - 1] ?? 'Other';
      const bad = outcome === 'Destroyed' || outcome === 'BadSeal' || outcome === 'Routed';
      return { ...base, tone: bad ? 'loss' : 'result', rank: bad ? 3 : 1, facts: { outcome, troops: Math.floor(Number(r.troops ?? 0) / 1000) } };
    }
    case 'CLASH':
      return mineHolding(r.p, r.q) && Number(r.engagements ?? 0) > 0 ? { ...base, tone: 'threat', rank: 2, at: { p: r.p, q: r.q }, facts: { engagements: Number(r.engagements) }, battle: { p: r.p, q: r.q, bell: Number(r.bell) } } : null;
    default:
      return null;
  }
}

/**
 * The items of records read after a summary (between two looks), with the book carried on: → `{items, book}`. The
 * book is not changed in place.
 */
export function itemsSince(records, me, book, sent = null, rules = {}) {
  const b = new Map(book ?? []), sn = new Map(sent ?? []), items = [];
  for (const x of normalizeRecords(records).records) {
    const it = withArrival(itemOf(x, me, b), x.record, sn, rules);
    if (it) items.push(it);
    fold(b, x.record);
    foldSent(sn, x.record);
  }
  return { items, book: b, sent: sn };
}

/**
 * What each caravan was sent with, from CARAVAN_SENT (key → `{cargo, wornBps, dst}`: the cargo after the towers' wear,
 * caravan.rs send), forgotten at its settlement. Not kept with the mark: a caravan whose send was not read is not
 * compared, and its arrival stays unverified.
 */
function foldSent(sent, r) {
  const key = caravanKey(r);
  if (!key) return;
  if (r.name === 'CARAVAN_SENT') { const c = cargoOf(r.cargo); if (c) sent.set(key, { cargo: c, wornBps: Number(r.worn_bps ?? 0), dst: r.dst ?? null }); }
  else if (r.name === 'CARAVAN_SETTLED') sent.delete(key);
}
/**
 * A settlement of a caravan the viewer holds (sent and never taken, or taken by the viewer): `facts.arrival`, as
 * statussources.arrivalSettled judges it under the season's `rules` (`{programVersion}`). A burned caravan (no holder)
 * and one taken from the viewer are not the viewer's, so they are told no arrival at all.
 */
function withArrival(it, r, sent, rules = {}) {
  if (!it || it.kind !== 'CARAVAN_SETTLED' || it.facts?.holder !== 'me') return it;
  const a = arrivalSettled({ outcome: r.outcome, dst: r.dst, cargo: it.facts.cargo }, sent.get(caravanKey(r)) ?? null, rules);
  return { ...it, facts: { ...it.facts, arrival: a } };
}

/**
 * The summary. `records`: the decoded events read (`[{seq, record}]`,
 * flog.mjs decodePage; duplicates and order are mended here). `read`:
 * `{after, complete, failed}` — the cursor the records were read from
 * (exclusive), whether the reading reached the head, whether a page failed.
 * `marks`: loadMarks(); `last`: loadLast(); `season`, `wallet`, `nowBell`;
 * `headSeq`: the season record's head (a mark beyond it is not this
 * history's). → `{mode, since, firstBell, horizonBell, read: {after, toSeq,
 * fromBell, toBell, n, dups, reordered}, gap, incomplete, failed,
 * windowFrom, items, more, counts, book, confirm}`. `confirm` is `{ok: true,
 * toSeq, toBell, horizonBell, caravans, partial, reset}` or `{ok: false, why:
 * 'gap' | 'nothing'}`.
 */
export function summarize({ records: raw, read, marks: given, last, season, wallet, nowBell, headSeq = null, me, rules = {} }) {
  const norm = normalizeRecords(raw);
  const records = norm.records;
  const ahead = !!given && big(headSeq) !== null && big(given.confirmedSeq) > big(headSeq);
  const marks = ahead ? null : given;
  const mode = ahead ? 'markAhead'
    : marks ? 'sinceConfirmed'
    : last && String(last.seasonId) !== String(season) ? 'newSeason'
    : last && last.wallet !== wallet ? 'otherWallet'
    : 'firstOnDevice';
  const since = marks ? { seq: String(marks.confirmedSeq), bell: marks.confirmedBell } : null;
  const after = since ? big(since.seq) : null;
  const firstBell = since ? null : Math.max(0, Number(nowBell ?? 0) - FIRST_LOOK_BELLS);
  const bellOf = x => Number(x.record.bell ?? x.record.logBell);
  const inRange = records.filter(x => (after !== null ? big(x.seq) > after : bellOf(x) >= firstBell));
  // (a gap: the page read from a cursor later than the confirmed mark, so the events in between were not read)
  const from = big(read?.after) ?? (records.length ? big(records[0].seq) - 1n : null);
  const gap = after !== null && from !== null && from > after ? { afterSeq: String(after), beforeSeq: String(from + 1n) } : null;
  // (a first look that could not reach back to its window's first turn says from which turn it read)
  const windowFrom = !since && from !== null && from > 0n && records.length && bellOf(records[0]) > firstBell ? bellOf(records[0]) : null;
  // who holds each caravan, record by record, from the mark's own book on
  const book = caravanBook(marks?.caravans ?? {}, []), sent = new Map(), items = [], want = new Set(inRange);
  for (const x of records) {
    const it = want.has(x) ? withArrival(itemOf(x, me, book), x.record, sent, rules) : null;
    if (it) items.push(it);
    fold(book, x.record);
    foldSent(sent, x.record);
  }
  const counts = {};
  for (const i of items) counts[i.tone] = (counts[i.tone] ?? 0) + 1;
  const sorted = [...items].sort((a, b) => b.rank - a.rank || b.bell - a.bell || (big(b.seq) > big(a.seq) ? 1 : -1));
  const bells = inRange.map(bellOf).filter(Number.isFinite);
  const lastRead = records.at(-1) ?? null;
  const horizonBell = since ? (marks.horizonBell ?? null) : windowFrom ?? firstBell;
  const confirmOut = gap ? { ok: false, why: 'gap' }
    : !lastRead || (after !== null && big(lastRead.seq) <= after) ? { ok: false, why: 'nothing' }
    : { ok: true, toSeq: lastRead.seq, toBell: bellOf(lastRead), horizonBell, caravans: Object.fromEntries(book), partial: read?.complete === false, reset: ahead };
  return {
    mode, since, firstBell, horizonBell, windowFrom,
    read: { after: from === null ? null : String(from), toSeq: lastRead?.seq ?? null, fromBell: bells.length ? Math.min(...bells) : null, toBell: bells.length ? Math.max(...bells) : null, n: inRange.length, dups: norm.dups, reordered: norm.reordered },
    gap, incomplete: read?.complete === false, failed: read?.failed === true,
    items: sorted.slice(0, SUMMARY_MAX), more: Math.max(0, sorted.length - SUMMARY_MAX), counts,
    book, sent, confirm: confirmOut,
  };
}
