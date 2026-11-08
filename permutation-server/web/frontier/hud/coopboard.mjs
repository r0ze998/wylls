// The way from the game to workstream 01's cooperation between nations — requests across nations, answers, the
// caravans linked to them — through the slot the S1 village card already has (hud/coopentry.mjs). Workstream 07
// connects; the board, its records and its rules are 01's (workstreams/01-national-strategy/coop/), and nothing here
// decides one of them. This replaces 01's proposal 0003 (a second fold in the card, to a fixed path) with the slot
// that was made for it.
//
// 01's board (coop/board.mjs) serves its page and /coop/* and passes every other path on to the herald, so a game
// reached through the board finds /coop/config on its own origin. A game served by the herald alone gets a 404 there:
// the board is not on this server, and the slot shows nothing. A board that cannot be read now is said as such
// (disabled, with why); a board for another Season is not offered (its requests are not this world's).
import { L } from '../../lang.mjs';
import { registerCoopEntry } from './coopentry.mjs';
import { activeHolding } from '../fstate.mjs';
import { pinned } from '../fchainio.mjs';

/** Where 01's board serves its page (coop/board.mjs PAGE); its config may name another (`page`). */
export const BOARD_PAGE = '/ws01/repo/workstreams/01-national-strategy/coop/';

/**
 * Read the board's config: `{read: 'ok', config}` | `{read: 'absent'}` (no board on this server: 404) |
 * `{read: 'unread', code}` (it did not answer, or answered something else).
 */
export async function probeBoard({ fetch: f = (...a) => globalThis.fetch(...a), base = '' } = {}) {
  let r;
  try { r = await f(`${base}/coop/config`, { cache: 'no-store' }); } catch { return { read: 'unread', code: 'network' }; }
  if (r.status === 404) return { read: 'absent' };
  if (!r.ok) return { read: 'unread', code: `HTTP${r.status}` };
  let j;
  try { j = await r.json(); } catch { return { read: 'unread', code: 'BadBody' }; }
  // (01's config: `season` is the board's present context {programId, seasonId} — coop/board.mjs —, `page` its page)
  const s = j?.season;
  if (!j || typeof j !== 'object' || !s || typeof s !== 'object' || typeof s.seasonId !== 'string' || !s.seasonId) return { read: 'unread', code: 'BadConfig' };
  return { read: 'ok', config: j };
}

/** The program the page is pinned to, or null (no pin yet). */
const pinnedProgram = FS => { try { return FS?.pin?.programId ?? pinned()?.programId ?? null; } catch { return null; } };

/** This village as the board's `to` (p,q,site,gen), or null. */
export function villageTo(FS) {
  const h = activeHolding(FS);
  return h ? [h.p, h.q, h.site, h.gen ?? 0].join(',') : null;
}

/** The slot's state for a board read `b` (probeBoard's answer, or null before the first read). */
export function boardState(FS, b) {
  if (!b || b.read === 'absent') return { hidden: true };
  if (b.read !== 'ok') return { available: false, why: L`国をまたぐ依頼の板を読み込めませんでした（${b.code ?? '?'}）。もう一度読み込むと、また確かめます` };
  const season = FS?.season?.seasonId, program = pinnedProgram(FS);
  const other = season === undefined || season === null || b.config.season.seasonId !== String(season)
    || (program && typeof b.config.season.programId === 'string' && b.config.season.programId !== program);
  if (other) return { available: false, why: L`この依頼の板は、別の世界（シーズン）のものです` };
  if (!villageTo(FS)) return { available: false, why: L`村を選ぶと、その村を届け先にして開けます` };
  return { available: true };
}

/** The board's page for this village (the board's own `page` when its config names one on this origin). */
export function boardHref(FS, b) {
  const page = typeof b?.config?.page === 'string' && b.config.page.startsWith('/') && !b.config.page.startsWith('//') ? b.config.page : BOARD_PAGE;
  return `${page}?to=${encodeURIComponent(villageTo(FS) ?? '')}`;
}

/**
 * Register the entry and read the board now and every `every` ms. `changed()` is called after each read (the page
 * draws the card again). → a function that stops it and removes the entry.
 */
export function installCoopBoard({ fetch, base = '', every = 60_000, changed = () => {}, open = href => globalThis.open?.(href, '_blank', 'noopener'), timers = globalThis } = {}) {
  let board = null, stopped = false, timer = null;
  const read = async () => {
    const b = await probeBoard({ fetch, base });
    if (stopped) return;
    board = b;
    changed();
    timer = timers.setTimeout?.(read, b.read === 'absent' ? every * 5 : every) ?? null;
  };
  const off = registerCoopEntry({
    id: 'ws01-coop',
    title: () => L`国をまたぐ依頼を開く`,
    state: FS => boardState(FS, board),
    open: FS => open(boardHref(FS, board)),
  });
  read();
  return () => { stopped = true; if (timer !== null) timers.clearTimeout?.(timer); off(); };
}
