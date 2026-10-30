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
import { decodePage } from '../flog.mjs';
import { normalizeRecords } from './returnsum.mjs';

/** Pages read per look (the herald's page is 500 events: herald server.rs EVENTS_PAGE). */
export const AWAY_PAGES = 8;
/** How far behind the season's head a first look starts reading (it keeps the turns of its window only). */
export const AWAY_REACH = 4000;

/** The scope a reading belongs to. */
export const awayScope = ({ herald = '', seasonId = '', wallet = '' }) => `${herald}|${seasonId}|${wallet}`;

/**
 * `events(after)`: the herald client's `events` (`{ok, events, next, full}`).
 * → `{start({scope, from}), more(), reset(), scope}`; both reads resolve to
 * `{scope, after, records, complete, failed, bad, stale}` — `stale` when the
 * scope changed while the pages were read (the result is then empty).
 */
export function createAwayReader({ events, pages = AWAY_PAGES }) {
  let scope = null, cursor = null, gen = 0;
  async function readFrom(after) {
    const mine = gen, got = [];
    let complete = false, failed = false, bad = 0, at = BigInt(after);
    for (let i = 0; i < pages; i++) {
      let r;
      try { r = await events(String(at)); } catch { r = { ok: false }; }
      if (mine !== gen) return { scope, after: String(after), records: [], complete: false, failed: false, bad: 0, stale: true };
      if (!r?.ok) { failed = true; break; }
      const page = decodePage(r.events ?? []);
      bad += page.bad;
      const fresh = normalizeRecords(page.records).records.filter(x => BigInt(x.seq) > at);
      got.push(...fresh);
      const next = fresh.length ? BigInt(fresh.at(-1).seq) : at;
      if (!r.full) { complete = true; at = next; break; }
      // (a full page that brought nothing new would be read again for ever: stop, not complete)
      if (next === at) break;
      at = next;
    }
    cursor = at;
    return { scope, after: String(after), records: normalizeRecords(got).records, complete, failed, bad, stale: false };
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
      if (scope === null || cursor === null) return Promise.resolve({ scope, after: null, records: [], complete: false, failed: false, bad: 0, stale: true });
      return readFrom(cursor);
    },
  };
}
