// Which of the viewer's villages this device has already seen land (UX brief
// §5.1: "the first time the village exists on this device"). A convenience
// of this device, never a record: clearing it only lets a landing play again.
//
// A landing plays for a village that is still provisional the first time this
// device sees it: it has just been placed (the page watched it happen, or was
// reloaded while waiting). A village that is already final at first sight is
// old news: it is noted and nothing plays (a moment is never replayed for
// something that happened long ago).
export const LANDED_PREFIX = 'ps-flanded:';
/** The storage key of a wallet's landed villages in a season (beside `ps-fsurvey:` and `ps-fui:`). */
export const landedKey = ({ cluster, programId, seasonId }, wallet) => `${LANDED_PREFIX}${cluster}:${programId}:${seasonId}:${wallet}`;
/** At most this many villages are remembered (the oldest are dropped). */
export const LANDED_MAX = 64;

const int = Number.isInteger;
/** A village's identity over its life: its province, site and generation. */
export const villageId = h => `${h.p},${h.q},${h.site ?? ''},${h.gen ?? 0}`;

const quietStorage = {
  get(k) { try { return globalThis.localStorage?.getItem(k) ?? null; } catch { return null; } },
  set(k, v) { try { globalThis.localStorage.setItem(k, v); return true; } catch { return false; } },
};

/** The ids a stored text holds (damaged text: none). */
export function unpackLanded(text) {
  try { const v = JSON.parse(text ?? 'null'); return Array.isArray(v) ? v.filter(x => typeof x === 'string' && x.length < 40).slice(-LANDED_MAX) : []; } catch { return []; }
}

/**
 * The book of one page. `next(key, holdings)` → the landing to play now,
 * `{id, key: "P,Q,tile", at: {p, q, tile}}`, or null. `key` is landedKey(…)
 * (null: nothing is remembered and nothing plays); `holdings` the viewer's
 * Holdings. The same landing is returned until another village lands, so a
 * caller that asks every frame starts it once (by its `id`).
 */
export function createLandingBook({ storage = quietStorage } = {}) {
  let at = null, seen = new Set(), last = null;
  return {
    /**
     * The landing that `next` would start for these holdings, without noting anything: `"P,Q,tile"` or null. For
     * the moments before the page knows its viewer for sure (a reload while the village is provisional): the map
     * keeps that land out of its colour until the landing is really reported, so the colour never shows, goes and
     * comes back.
     */
    peek(key, holdings) {
      if (!key) return null;
      const known = key === at ? seen : new Set(unpackLanded(storage.get(key)));
      let out = null;
      for (const h of holdings ?? []) {
        if (!h || !int(h.p) || !int(h.q) || !int(h.tile) || h.state !== 1 || known.has(villageId(h))) continue;
        out = `${h.p},${h.q},${h.tile}`;
      }
      return out;
    },
    next(key, holdings) {
      if (!key) return null;
      if (key !== at) { at = key; seen = new Set(unpackLanded(storage.get(key))); last = null; }
      let fresh = false;
      for (const h of holdings ?? []) {
        if (!h || !int(h.p) || !int(h.q) || !int(h.tile)) continue;
        const id = villageId(h);
        if (seen.has(id)) continue;
        seen.add(id); fresh = true;
        if (h.state === 1) last = { id, key: `${h.p},${h.q},${h.tile}`, at: { p: h.p, q: h.q, tile: h.tile } };
      }
      if (fresh) storage.set(key, JSON.stringify([...seen].slice(-LANDED_MAX)));
      return last;
    },
  };
}
