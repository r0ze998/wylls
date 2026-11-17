// Workstream 12 <- workstream 8: the memory's world, partition and clock from the continuous-world program state.
//
// What 8 implemented (read on origin/integration/ws09-13-v16-d0949fd4, frontier-abi): the world is the existing
// Season account kept for good, marked continuous (conquest block byte 80 `CONTINUOUS`, `end_bell = join_close_bell =
// NO_END_BELL = u32::MAX`; EndSeason refuses it, error 94 `ContinuousWorld`). There is no separate world-id type: the
// world is the program plus that account (workstream 4's `Chain::world()` says the same). Its bell is the Season bell,
// `bell_at(genesis_ts, t) = floor((t - genesis_ts) / bell_secs)` (frontier-abi prologue.rs; the herald publishes
// `bellSecs` in /h/season — 600 today, but taken from there, not assumed here), which no longer restarts.
//
// So for workstream 12: one world {cluster, world_id = <program>/<world account>}, ONE registered partition (the world
// account), and world bell = Season bell. This module derives only that; it defines no World or Period of its own. An
// account that is not continuous is registered as a partition (its records stay readable) but gives no world: nothing
// can be proven "not sent" against it (fold: memory_world_unset).
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * @param {{cluster: string, program: string, worldAccount: string, seasonId: number, continuous: boolean}} chain
 *        what the herald (/h/world, /h/season) or an RPC read of the world account reports
 * @returns {{world: object|null, partitions: object, partition: string, reasons: string[]}}
 */
export function worldConfig({ cluster, program, worldAccount, seasonId, continuous }) {
  if (typeof cluster !== 'string' || !cluster) throw new TypeError('cluster');
  if (!B58.test(program ?? '') || !B58.test(worldAccount ?? '')) throw new TypeError('program and worldAccount are base58 account addresses');
  if (!Number.isSafeInteger(seasonId) || seasonId < 0) throw new TypeError('seasonId');
  const partitions = { [worldAccount]: { program, season: seasonId } };
  if (continuous !== true) return { world: null, partitions, partition: worldAccount, reasons: ['world_not_continuous'] };
  return { world: { cluster, world_id: `${program}/${worldAccount}` }, partitions, partition: worldAccount, reasons: [] };
}

/**
 * The world clock for workstream 4's slots: Season bell of the slot's block time. `blockTimeOfSlot(slot)` is the
 * RPC's getBlockTime (unix seconds, or null when not known). Returns null when the time is unknown or before genesis:
 * the caller holds the record instead of guessing a bell.
 */
export function clockFromGenesis({ genesisTs, bellSecs, blockTimeOfSlot }) {
  if (!Number.isSafeInteger(genesisTs)) throw new TypeError('genesisTs');
  if (!Number.isSafeInteger(bellSecs) || bellSecs <= 0) throw new TypeError('bellSecs (from /h/season; not assumed)');
  if (typeof blockTimeOfSlot !== 'function') throw new TypeError('blockTimeOfSlot');
  return slot => {
    const t = blockTimeOfSlot(slot);
    if (!Number.isSafeInteger(t) || t < genesisTs) return null;
    const bell = Math.floor((t - genesisTs) / bellSecs);
    return bell < 2 ** 32 ? bell : null;
  };
}
