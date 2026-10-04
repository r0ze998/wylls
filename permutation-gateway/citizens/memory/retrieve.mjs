// Retrieval (contract §5.2): a pure function over the episode list.
//
//   score = importance x 0.5^((bellNow - bell) / 72) x (1 + 0.5 x |entities ∩ focus|)
//
// Over episodes with created_bell < bellNow (an episode is retrievable one bell
// after it became public). Take the top 8 by (score desc, bell desc, id asc),
// plus the source episodes of up to 3 open grievances (newest first; exempt
// from the decay and from the cut), plus the 3 newest by bell; deduplicate and
// present oldest first. The same inputs always give the same ids in the same
// order (G15). Scores are compared after rounding to 1e-9, so a last-bit
// difference between two machines cannot reorder a tie.
import { HALF_LIFE_BELLS, RETRIEVE_GRIEVANCE_SOURCES, RETRIEVE_NEWEST, RETRIEVE_TOP } from './config.mjs';

export const focusSet = focus => (focus instanceof Set ? focus : new Set(focus ?? []));
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
export const oldestFirst = (a, b) => a.bell - b.bell || a.created_bell - b.created_bell || byId(a, b);
const newestFirst = (a, b) => b.bell - a.bell || b.created_bell - a.created_bell || byId(a, b);

export function scoreOf(ep, focus, bellNow) {
  const age = Math.max(0, bellNow - ep.bell);
  let overlap = 0;
  for (const e of ep.entities) if (focus.has(e)) overlap++;
  return Math.round(ep.importance * 0.5 ** (age / HALF_LIFE_BELLS) * (1 + 0.5 * overlap) * 1e9);
}

/**
 * @param {object[]} episodes all episodes of one AI
 * @param {Iterable<string>} focus entity strings ("<tag>", "nation:<f>", "pq:p,q")
 * @param {number} bellNow
 * @param {{grievances?: {event: string, bell: number, answered?: boolean}[]}} [opts] the ledger's grievances (open ones count)
 * @returns {string[]} episode ids, oldest first
 */
export function retrieve(episodes, focus, bellNow, { grievances = [] } = {}) {
  const f = focusSet(focus);
  const eligible = episodes.filter(e => e.created_bell < bellNow && !e.redacted);
  const index = new Map(eligible.map(e => [e.id, e]));
  const scored = eligible.map(e => ({ e, s: scoreOf(e, f, bellNow) }))
    .sort((a, b) => b.s - a.s || b.e.bell - a.e.bell || byId(a.e, b.e));
  const picked = new Map();
  for (const { e } of scored.slice(0, RETRIEVE_TOP)) picked.set(e.id, e);
  const open = grievances.filter(g => !g.answered && index.has(g.event))
    .sort((a, b) => b.bell - a.bell || (a.event < b.event ? -1 : 1)).slice(0, RETRIEVE_GRIEVANCE_SOURCES);
  for (const g of open) picked.set(g.event, index.get(g.event));
  for (const e of [...eligible].sort(newestFirst).slice(0, RETRIEVE_NEWEST)) picked.set(e.id, e);
  return [...picked.values()].sort(oldestFirst).map(e => e.id);
}

/** The ids that a cut to a token budget must never drop: the newest 3 of `ids` and the open-grievance sources. */
export function protectedIds(episodesById, ids, grievances = []) {
  const keep = new Set();
  const list = ids.map(id => episodesById.get(id)).filter(Boolean).sort(newestFirst);
  for (const e of list.slice(0, RETRIEVE_NEWEST)) keep.add(e.id);
  for (const g of grievances) if (!g.answered && ids.includes(g.event)) keep.add(g.event);
  return keep;
}
