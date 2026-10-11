// Arrival-control gameplay for the local development world. This state is
// owned by the server; it is deliberately separate from the chain's CQ keep
// records. A client's destination choice never changes ownership. Only the
// resolved military roster can do so, after the shared WASM battle result
// and all departures/returns have been applied.
export const UNCLAIMED = 255;
const TILES = 61;
const faction = n => Number.isInteger(n) && n >= 0 && n < 6;
const tile = n => Number.isInteger(n) && n >= 0 && n < TILES;
const passable = (pv, t) => tile(t) && ((BigInt(pv.passableMask) >> BigInt(t)) & 1n) === 1n;
const standing = (e, bell) => e?.state === 1 && e.fromBell <= bell + 1 && e.troops > 0 && e.unit >= 0 && e.unit < 6 && faction(e.faction);

/** Villages retain their account owner; field occupation cannot grant a home. */
function settlements(pv) {
  const out = new Map();
  for (let s = 0; s < pv.siteCount; s++) {
    const m = pv.siteMirror[s], t = pv.sites[s];
    if (m?.state === 1 && faction(m.faction) && passable(pv, t)) out.set(t, m.faction);
  }
  return out;
}

/** Starting positions are established facts, without fictional arrival events. */
export function createTerritory(pv, bell = pv.resolvedNext - 1) {
  const state = { bell, owners: Array(TILES).fill(UNCLAIMED), since: Array(TILES).fill(null), changes: [], history: [], withdrawn: new Set() };
  const homes = settlements(pv), at = new Map();
  for (const e of pv.entries) if (standing(e, bell) && passable(pv, e.tile)) {
    const sides = at.get(e.tile) ?? new Set(); sides.add(e.faction); at.set(e.tile, sides);
  }
  for (const [t, sides] of at) if (sides.size === 1 && !(pv.camp?.state === 1 && pv.camp.tile === t)) {
    state.owners[t] = [...sides][0]; state.since[t] = bell;
  }
  for (const [t, f] of homes) { state.owners[t] = f; state.since[t] = bell; }
  return state;
}

/** A newly placed home is confirmed server state; its land is granted at once. */
export function settleHomeTerritory(state, pv, bell = state.bell) {
  for (const [t, f] of settlements(pv)) if (state.owners[t] !== f) {
    state.owners[t] = f; state.since[t] = bell;
  }
}

/**
 * Resolve once, in bell order. Empty land is secured by a surviving military
 * host. A defended field changes hands only after the battle leaves a single
 * faction there. Retreating, destroyed, in-transit and civilian hosts never
 * claim land. Leaving a captured field does not surrender it.
 */
export function resolveTerritory(state, pv, bell, { battleTiles = [], arrivedHostIds = [], withdrawnHostIds = [] } = {}) {
  if (!Number.isInteger(bell) || bell < 0) throw new Error('territory: invalid bell');
  if (bell <= state.bell) return territorySnapshot(state);
  if (bell !== state.bell + 1) throw new Error('territory: unresolved bell gap');
  const homes = settlements(pv), at = new Map(), fought = new Set(battleTiles);
  for (const id of arrivedHostIds) state.withdrawn.delete(String(id));
  for (const id of withdrawnHostIds) state.withdrawn.add(String(id));
  for (const e of pv.entries) if (standing(e, bell) && passable(pv, e.tile)) {
    const sides = at.get(e.tile) ?? new Set(); sides.add(e.faction); at.set(e.tile, sides);
  }
  state.changes = [];
  settleHomeTerritory(state, pv, bell);
  for (const [t, sides] of at) {
    // A surviving army that was pushed onto another tile did not order an
    // expansion there. It must make a successful march before claiming again.
    if (!pv.entries.some(e => standing(e, bell) && e.tile === t && !state.withdrawn.has(String(e.id)))) continue;
    if (homes.has(t) || sides.size !== 1 || (pv.camp?.state === 1 && pv.camp.tile === t)) continue;
    const to = [...sides][0], from = state.owners[t];
    if (from === to) continue;
    state.owners[t] = to; state.since[t] = bell;
    const hostId = pv.entries.filter(e => standing(e, bell) && e.tile === t && e.faction === to && !state.withdrawn.has(String(e.id))).map(e => BigInt(e.id)).sort((a, b) => a < b ? -1 : a > b ? 1 : 0)[0];
    state.changes.push({ tile: t, from, to, bell, hostId: String(hostId), reason: fought.has(t) ? 'battle' : 'arrival' });
  }
  state.changes.sort((a, b) => a.tile - b.tile);
  state.history.push(...state.changes);
  if (state.history.length > 128) state.history.splice(0, state.history.length - 128);
  state.bell = bell;
  return territorySnapshot(state);
}

/** Independent arrays: an already closed bell cannot change with the world. */
export function territorySnapshot(state) {
  const totals = [0, 0, 0, 0, 0, 0];
  for (const owner of state.owners) if (faction(owner)) totals[owner]++;
  return { v: 1, mode: 'arrival-control', authority: 'local-preview', bell: state.bell,
    owners: [...state.owners], since: [...state.since], changes: state.changes.map(c => ({ ...c })), history: state.history.map(c => ({ ...c })), totals };
}
