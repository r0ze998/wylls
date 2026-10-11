// Arrival-control development worlds publish tile ownership after resolving
// combat. This extension never substitutes for a chain account or CQ keep.
export const territoryEnabled = FS => FS?.sample?.territory?.mode === 'arrival-control';
const hostIdOf = x => typeof x === 'string' && /^\d{1,20}$/.test(x) && BigInt(x) <= 0xffffffffffffffffn ? x : null;

export function parseTerritory(value) {
  if (!value || value.v !== 1 || value.mode !== 'arrival-control' || !Number.isInteger(value.bell) || value.bell < 0) return null;
  if (!Array.isArray(value.owners) || value.owners.length !== 61 || !value.owners.every(x => Number.isInteger(x) && (x === 255 || x >= 0 && x < 6))) return null;
  if (!Array.isArray(value.since) || value.since.length !== 61 || !value.since.every(x => x === null || Number.isInteger(x) && x >= 0 && x <= value.bell)) return null;
  const owners = [...value.owners], totals = Array(6).fill(0);
  owners.forEach(x => { if (x < 6) totals[x]++; });
  const clean = list => (Array.isArray(list) ? list : []).filter(x => Number.isInteger(x?.tile) && x.tile >= 0 && x.tile < 61 && Number.isInteger(x.to) && x.to >= 0 && x.to < 6 && (x.from === 255 || Number.isInteger(x.from) && x.from >= 0 && x.from < 6) && Number.isInteger(x.bell) && x.bell <= value.bell && x.bell >= 0 && ['arrival', 'battle'].includes(x.reason)).map(x => ({ tile: x.tile, from: x.from, to: x.to, bell: x.bell, reason: x.reason, hostId: hostIdOf(x.hostId) }));
  return { v: 1, mode: value.mode, bell: value.bell, owners, since: [...value.since], totals, changes: clean(value.changes), history: clean(value.history).slice(-128) };
}

export function territoryOf(FS, p, q) {
  return territoryEnabled(FS) ? FS.provinces?.get(`${p},${q}`)?.sampleTerritory ?? null : null;
}
export function territoryOwner(FS, p, q, tile) {
  const n = territoryOf(FS, p, q)?.owners?.[tile];
  return Number.isInteger(n) && n >= 0 && n < 6 ? n : null;
}
// Counts only provinces read by this viewer; never calls this the whole world.
export function territoryTotals(FS) {
  const totals = Array(6).fill(0);
  if (territoryEnabled(FS)) for (const env of FS.provinces?.values?.() ?? []) for (const n of env.sampleTerritory?.owners ?? []) if (n < 6) totals[n]++;
  return totals;
}
