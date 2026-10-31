// Workstream 12: a READ-ONLY continuity adapter for the existing AI-citizen memory (permutation-gateway/citizens/
// memory). It changes no file of that code and rewrites none of its stored episodes or ledgers. Migration
// candidate only: nothing calls it in the running system.
//
// What it works around (pinned by test/citizens-characterization.test.mjs, which runs the existing code as it is):
//   1. retrieve(episodes, focus, bellNow) keeps only episodes with created_bell < bellNow and ages them by
//      bellNow - bell. Its bells are Season-relative (frontier-abi bell_at(genesis_ts, t)), so after a new Season
//      starts at bell 0 every older episode has created_bell > bellNow: the AI's memory disappears from its prompts.
//   2. Ledger.advanceDay(day) returns early while day <= decay_day; with Season-relative days the decay and the
//      daily counters stop after a new Season until its day number passes the old one.
//   3. The ledger keys trust by citizen tag; the program derives the tag from the citizen address, which it derives
//      under the Season account, so the same wallet starts again at trust 0 under a new tag.
//
// The adapter reads the existing stores per partition and presents them on the world clock and per principal.
// The mapping (partition, Season bell) -> world bell and (partition, tag) -> principal is workstream 4's; it is
// passed in (`toWorldBell`, `principalOf`), never defined here.
import { retrieve } from '../../../permutation-gateway/citizens/memory/retrieve.mjs';
import { dayOf } from '../../../permutation-gateway/citizens/memory/config.mjs';

/**
 * Episodes of several partitions on the world clock. Each keeps its stored form under `origin` (unchanged; the M11
 * replay of a partition still uses those), and gets a world id `<partition>:<id>` so ids of two partitions never
 * collide.
 * @param {{partition: string, episodes: object[]}[]} perPartition
 * @param {(partition: string, bell: number) => number} toWorldBell  4's clock mapping
 */
export function worldEpisodes(perPartition, toWorldBell) {
  const out = [];
  for (const { partition, episodes } of perPartition) {
    for (const ep of episodes) {
      out.push({ ...ep, id: `${partition}:${ep.id}`, bell: toWorldBell(partition, ep.bell), created_bell: toWorldBell(partition, ep.created_bell),
        origin: { partition, id: ep.id, bell: ep.bell, created_bell: ep.created_bell } });
    }
  }
  return out;
}

/**
 * The existing retrieval, unchanged, over world-clock episodes. Grievances name their source episode by stored id;
 * pass them with their partition so they are mapped the same way.
 */
export function retrieveWorld(worldEps, focus, worldBellNow, { grievances = [] } = {}) {
  const g = grievances.map(x => ({ ...x, event: `${x.partition}:${x.event}` }));
  return retrieve(worldEps, focus, worldBellNow, { grievances: g });
}

/** The existing daily step (decay, counters) driven by the world day instead of the Season day. */
export function advanceDayWorld(ledger, worldBell, opts) {
  return ledger.advanceDay(dayOf(worldBell), opts);
}

/**
 * Trust per principal across the partitions' ledgers, as a VIEW: each part (partition, tag, code and model parts)
 * is listed; the total is their sum clamped to -100..100 as the existing rule clamps. Ledgers are not modified.
 * A tag 4 has not attributed to a principal stays under `unattributed`.
 * @param {{partition: string, ledger: {trustOf(tag): {total, t_code, t_model}}, tags: string[]}[]} perPartition
 * @param {(partition: string, tag: string) => string|null} principalOf  4's identity mapping
 */
export function trustByPrincipal(perPartition, principalOf) {
  const out = {}, unattributed = [];
  for (const { partition, ledger, tags } of perPartition) {
    for (const tag of tags) {
      const t = ledger.trustOf(tag);
      const p = principalOf(partition, tag);
      if (!p) { unattributed.push({ partition, tag, ...t }); continue; }
      const e = (out[p] ??= { t_code: 0, t_model: 0, total: 0, parts: [] });
      e.t_code += t.t_code; e.t_model += t.t_model;
      e.parts.push({ partition, tag, t_code: t.t_code, t_model: t.t_model });
    }
  }
  for (const e of Object.values(out)) e.total = Math.max(-100, Math.min(100, e.t_code + e.t_model));
  return { principals: out, unattributed };
}
