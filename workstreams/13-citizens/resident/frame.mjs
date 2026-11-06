// Which world and which clock a bell belongs to, in the words workstream 12 (ea0636eb, adapters/canonical.mjs and
// ws08-world.mjs) uses for them:
//   world  {cluster, world_id}: workstream 12's world_id is `<program>/<world account>` (workstream 8's continuous
//          Season account). The test world is no workstream 8 world: its world_id is null.
//   clock  {kind, genesisTs, bellSecs, source}: 'season-bell' is workstream 8's Season bell,
//          floor((t - genesisTs) / bellSecs), with both numbers taken from the herald's /h/season; 'mock-world' is the
//          test world's own turn counter. Two clocks are the same only when kind, genesisTs and bellSecs all match.
// A bell is never carried from one clock or world to another: evidence on another clock or world is not read.
export const MOCK_WORLD = Object.freeze({ cluster: 'ws13-mock', world_id: null, source: 'workstream 13 test world (not a workstream 8 world)' });
export const MOCK_CLOCK = Object.freeze({ kind: 'mock-world', genesisTs: null, bellSecs: null, source: 'workstream 13 test world: its own turn counter, not the Season bell' });

/** Workstream 8's Season bell, from /h/season's numbers (as workstream 12's worldFromSeason returns them). */
export function seasonClock({ genesisTs, bellSecs, source }) {
  if (!Number.isSafeInteger(genesisTs)) throw new TypeError('genesisTs (from /h/season)');
  if (!Number.isSafeInteger(bellSecs) || bellSecs <= 0) throw new TypeError('bellSecs (from /h/season; not assumed)');
  if (typeof source !== 'string' || !source) throw new TypeError('source: where the clock was read');
  return Object.freeze({ kind: 'season-bell', genesisTs, bellSecs, source });
}

/** A clock's identity: its kind, and for the Season bell its two numbers. A bare string is a kind (older ports). */
export function clockId(c) {
  if (typeof c === 'string') return c || null;
  if (!c || typeof c.kind !== 'string') return null;
  return c.kind === 'season-bell' ? `season-bell:${c.genesisTs}:${c.bellSecs}` : c.kind;
}
export const sameClock = (a, b) => clockId(a) !== null && clockId(a) === clockId(b);

/** null when the two worlds are the same (or either is undeclared), else why not. */
export function worldMismatch(mine, theirs) {
  if (!mine || !theirs) return null;
  if (mine.world_id === null || theirs.world_id === null) return mine.world_id === theirs.world_id && mine.cluster === theirs.cluster ? null : 'not_a_ws08_world';
  return mine.cluster === theirs.cluster && mine.world_id === theirs.world_id ? null : 'another_world';
}
