// The resident's evidence port over workstream 12's canonical read port (ea0636eb, adapters/canonical.mjs
// `ws12EvidencePort(memory, {identity, worldBellOf})`). Workstream 13 does not import workstream 12: the caller hands
// in 12's function, its memory (with the world 12 took from the herald's /h/season), its identity resolver (herald
// citizen accounts), and the world clock 12 read (`worldFromSeason(season).clock`).
//
// What this adds on 13's side:
//   - `world` and `clock` declared in 13's frame words (resident/frame.mjs), so the resident withholds evidence on
//     another clock or about another world before asking;
//   - `worldBellOf` is given to 12 only when the resident's clock IS that world clock (same kind, genesisTs,
//     bellSecs); then a resident bell is a world bell and passes unchanged. Otherwise 12 is given none and answers
//     `clock_unverified`. Nothing converts one clock into the other.
//   - finality is 12's: a line is `verified` only from receipts 12 took in under a finality attestation; 13 shows the
//     epistemic word 12 gives and never upgrades it.
// Read-only: nothing is written to 12.
import { MOCK_CLOCK, sameClock, seasonClock } from '../frame.mjs';

export function ws12CanonicalEvidence({ ws12EvidencePort, memory, identity, worldClock, residentClock = MOCK_CLOCK }) {
  if (typeof ws12EvidencePort !== 'function') throw new TypeError("workstream 12's ws12EvidencePort");
  const clock = seasonClock(worldClock);
  const sameTime = sameClock(residentClock, clock);
  const port = ws12EvidencePort(memory, { identity, worldBellOf: sameTime ? b => b : null });
  const world = memory?.world && typeof memory.world.world_id === 'string' ? { cluster: memory.world.cluster, world_id: memory.world.world_id } : null;
  return Object.freeze({
    kind: `ws13-over-${port.kind}`,
    world, clock, sameTime,
    read(q) { return port.read(q); },
  });
}
