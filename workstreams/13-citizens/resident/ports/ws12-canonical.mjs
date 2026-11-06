// The resident's evidence port over workstream 12's canonical read port (c6877a1a, adapters/canonical.mjs
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
//   - finality is 12's: a commitment is decided (verified) only by records 12 accepted as finalized; 13 never
//     upgrades 12's word.
//   - PROVENANCE: where each input came from, `chain` (read from the chain or its indexer, with a source) or
//     `fixture` (made up for a test). A port whose inputs are not all `chain` has basis `fixture` (or `unstated`), and
//     the resident does not let it change a decision (resident.mjs #publicEvidence); a fixture is never chain evidence.
//   - FACTS: besides 12's text lines, the counterparty's commitments as 12's fold decided them (state, due bell,
//     sources), so the resident can act on a verified breach without parsing text.
// Read-only: nothing is written to 12.
import { MOCK_CLOCK, sameClock, seasonClock } from '../frame.mjs';

/** The inputs a decided commitment rests on (07-canonical.ja.md §1 of workstream 12). */
export const PROVENANCE_PARTS = Object.freeze(['world', 'clock', 'finality', 'identity', 'records']);
/** Workstream 12's decided states (src/fold.mjs VERIFIED_STATES, c6877a1a) and the breaches among them. */
export const VERIFIED_STATES = Object.freeze(['fulfilled', 'late', 'partial', 'not_sent']);
export const BREACH_STATES = Object.freeze(['partial', 'not_sent']);
const PUBLIC_VIEWER = Object.freeze({ tag: null, nation: null });

/** 'chain' only when every part is declared `chain` with a source; 'fixture' when any part is a fixture; else 'unstated'. */
export function basisOf(provenance) {
  const parts = PROVENANCE_PARTS.map(p => provenance?.[p]);
  if (parts.some(x => x?.kind === 'fixture')) return 'fixture';
  if (parts.every(x => x?.kind === 'chain' && typeof x.source === 'string' && x.source)) return 'chain';
  return 'unstated';
}

export function ws12CanonicalEvidence({ ws12EvidencePort, memory, identity, worldClock, residentClock = MOCK_CLOCK, provenance = null }) {
  if (typeof ws12EvidencePort !== 'function') throw new TypeError("workstream 12's ws12EvidencePort");
  const clock = seasonClock(worldClock);
  const sameTime = sameClock(residentClock, clock);
  const port = ws12EvidencePort(memory, { identity, worldBellOf: sameTime ? b => b : null });
  const world = memory?.world && typeof memory.world.world_id === 'string' ? { cluster: memory.world.cluster, world_id: memory.world.world_id } : null;
  const prov = Object.freeze(Object.fromEntries(PROVENANCE_PARTS.map(p => [p, provenance?.[p] ? Object.freeze({ kind: provenance[p].kind ?? null, source: provenance[p].source ?? null }) : null])));
  const basis = basisOf(provenance);
  return Object.freeze({
    kind: `ws13-over-${port.kind}`,
    world, clock, sameTime, basis, provenance: prov,
    read(q) {
      const r = port.read(q);
      if (r.status !== 'ok') return { ...r, facts: [], basis };
      // The same view 12's port used (public, at the world bell, observed by then), as structured commitments.
      const k = memory.knowledge(PUBLIC_VIEWER, q.worldBell, { observedBy: q.worldBell });
      const facts = k.commitments.filter(c => c.debtor === q.counterparty).map(c => ({
        commitment: c.id, state: c.state, due_bell: c.due_bell, verified: VERIFIED_STATES.includes(c.state), breach: BREACH_STATES.includes(c.state), sources: [...c.sources],
      }));
      return { ...r, facts, basis };
    },
  });
}
