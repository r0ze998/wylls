// The records the away summary reads (workstream 07, hud/returnsum.mjs is
// the model): from the player's own mark, page after page of the herald's
// /h/events?after= (the herald keeps every event of the season), not from
// the chronicle's window (controller.mjs reads from 500 events behind the
// head and keeps 400, so a mark older than that would be a gap every time).
//
// The reader belongs to one scope — the herald, the season and the wallet
// it reads for — and starts over when the scope changes, so the records of
// another season or another wallet's book are never carried into a summary.
// What it read is told as it is: `complete` only when the last page said it
// was the last (`full` false), `failed` when a page failed (the records read
// before it stand, the mark can move over them and no further). Pages that
// overlap or come back out of order are mended (returnsum.normalizeRecords);
// a body the page cannot decode is counted (`bad`), not guessed.
//
// Two positions are kept apart (2026-11-18): the transport cursor (where the
// next page is asked from) moves to the page's raw `next` — the herald's own
// cursor over every event it served, readable or not — and the records (what
// a summary and its "seen" mark are made of) are only the bodies decoded. A
// page of kinds this page does not read (decodeRecord → null) moves the cursor
// over them and adds no record: before, the cursor moved only over decoded
// records, so a full page of them was asked for again for ever. A `next` that
// is not a canonical u64, is not the page's newest raw seq (or, on an empty
// page, the cursor asked from), or goes back is not guessed at: the page
// fails, the pages read before it stand, the cursor stays where it was.
import { decodePage } from '../flog.mjs';
import { normalizeRecords } from './returnsum.mjs';

/** Pages read per look (the herald's page is 500 events: herald server.rs EVENTS_PAGE). */
export const AWAY_PAGES = 8;
/** How far behind the season's head a first look starts reading (it keeps the turns of its window only). */
export const AWAY_REACH = 4000;

/** The scope a reading belongs to. */
export const awayScope = ({ herald = '', seasonId = '', wallet = '' }) => `${herald}|${seasonId}|${wallet}`;

/** A canonical decimal u64 (as herald.mjs `events` checks its cursors) as a BigInt, else null. */
const u64 = s => (typeof s === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(s) && BigInt(s) <= 0xffffffffffffffffn ? BigInt(s) : null);
/**
 * The page's raw cursor, if it can be trusted: every raw seq a canonical u64, `next` a canonical u64 that is the
 * newest raw seq of the page (an empty page: the cursor it was asked from) and not behind that cursor. Else null.
 * (the raw seqs may come in any order: overlapping or reversed pages are mended by normalizeRecords, not refused here)
 */
function pageCursor(rows, next, at) {
  if (!Array.isArray(rows)) return null;
  let top = null;
  for (const e of rows) {
    const s = u64(e?.seq);
    if (s === null) return null;
    if (top === null || s > top) top = s;
  }
  const n = u64(next);
  if (n === null || n < at) return null;
  return n === (top ?? at) ? n : null;
}

/**
 * `events(after)`: the herald client's `events` (`{ok, events, next, full}`).
 * → `{start({scope, from}), more(), reset(), scope}`; both reads resolve to
 * `{scope, after, next, records, complete, failed, bad, stale}` — `next` the
 * transport cursor the reading reached (the next read starts after it; it may
 * be past the last record when the events after that record are of kinds this
 * page does not read), `stale` when the scope changed while the pages were
 * read (the result is then empty and the cursor is not touched).
 */
export function createAwayReader({ events, pages = AWAY_PAGES }) {
  let scope = null, cursor = null, gen = 0;
  async function readFrom(after) {
    const mine = gen, got = [];
    let complete = false, failed = false, bad = 0, at = BigInt(after);
    for (let i = 0; i < pages; i++) {
      let r;
      try { r = await events(String(at)); } catch { r = { ok: false }; }
      if (mine !== gen) return { scope, after: String(after), next: null, records: [], complete: false, failed: false, bad: 0, stale: true };
      if (!r?.ok) { failed = true; break; }
      // (a cursor that cannot be trusted is a failed page: its records are not taken, the cursor is not guessed)
      const next = pageCursor(r.events, r.next, at);
      if (next === null) { failed = true; break; }
      const page = decodePage(r.events);
      bad += page.bad;
      got.push(...normalizeRecords(page.records).records.filter(x => BigInt(x.seq) > at));
      if (!r.full) { complete = true; at = next; break; }
      // (a full page that moved the cursor nowhere would be read again for ever: stop, not complete)
      if (next === at) break;
      at = next;
    }
    cursor = at;
    return { scope, after: String(after), next: String(at), records: normalizeRecords(got).records, complete, failed, bad, stale: false };
  }
  return {
    get scope() { return scope; },
    /** Forget the scope (the page left play, or the wallet or season changed). */
    reset() { gen++; scope = null; cursor = null; },
    /** Read a scope from `from` (exclusive: the mark, or a first look's start). */
    start({ scope: sc, from }) {
      gen++; scope = sc; cursor = null;
      return readFrom(BigInt(from ?? 0) < 0n ? 0n : BigInt(from ?? 0));
    },
    /** The records after the last one read (between two looks). */
    more() {
      if (scope === null || cursor === null) return Promise.resolve({ scope, after: null, next: null, records: [], complete: false, failed: false, bad: 0, stale: true });
      return readFrom(cursor);
    },
  };
}
