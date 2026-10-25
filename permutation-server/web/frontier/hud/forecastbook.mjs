// What the page forecast when a march was sealed, kept on this device so the report can lay it beside what the record
// says (docs/design/uplift/02-CORE-FLOW: "the forecast and the result are told apart, and compared"). Only the
// viewer's own marches, only what the card showed: the range of troops left, the fates, the stance, how many tries.
// Nothing here is sent anywhere; another device has no book, and the report then shows the result alone.
const KEY = 'ps-ffc:';
const MAX = 60;

const keyOf = season => `${KEY}${season}`;
function load(storage, season) {
  try { const v = JSON.parse(storage?.get?.(keyOf(season)) ?? '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}

/** Keep a forecast for host `hostId` arriving at `bell` (the card's `c.forecast`, when it was ok). */
export function keepForecast(storage, season, { hostId, bell, stance, fc }) {
  if (!storage || season === undefined || season === null || !fc?.ok) return;
  const list = load(storage, season).filter(e => !(e.host === String(hostId) && e.bell === bell));
  list.unshift({ host: String(hostId), bell, stance, min: fc.troops.min, max: fc.troops.max, start: fc.troops.start, runs: fc.runs, fates: fc.fates });
  try { storage.set(keyOf(season), JSON.stringify(list.slice(0, MAX))); } catch { /* full or private */ }
}

/** The forecast kept for host `hostId` arriving at `bell`, or null. */
export function forecastFor(storage, season, hostId, bell) {
  return load(storage, season).find(e => e.host === String(hostId) && e.bell === bell) ?? null;
}
