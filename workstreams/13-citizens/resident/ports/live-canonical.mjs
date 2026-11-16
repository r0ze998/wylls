// The resident's evidence port over ONE live observation of the canonical sources (2026-11-16): workstream 12's
// adapters/live-observation.mjs `observeLive(...)` (herald /h/season, /h/events, /h/me; one finalized-slot RPC read;
// workstream 4's store read once, read-only) passed through this tree's existing ws12CanonicalEvidence. Workstream 13
// still imports nothing of workstream 12: the caller hands in 12's `ws12EvidencePort` and the observation.
//
// What this adds, and nothing else:
//   - an observation that did not connect (no world, the store not read, every receipt held) gives a port that
//     answers `observation_<status>` and no lines, with the reasons, so the resident shows why and acts on nothing;
//   - the held receipts and missing inputs travel with the port (`observation`), never dropped and never decided here;
//   - `wireLiveEvidence(port)` is the `wire` hook world/harness.mjs openResident already takes. It sets
//     `ports.evidence` and nothing else.
// The basis is ws12CanonicalEvidence's basisCheck over the observation's provenance. Workstream 4's receipts are
// 'integration-output' (12 caps them there), so today's basis is never chain and the resident shows the lines but
// acts on none (resident.mjs #publicEvidence). Nothing here raises a kind, a finality or a completeness.
import { MOCK_CLOCK } from '../frame.mjs';
import { ws12CanonicalEvidence } from './ws12-canonical.mjs';

const summaryOf = obs => Object.freeze({
  status: obs?.status ?? 'missing',
  reasons: Object.freeze([...(obs?.reasons ?? [])]),
  held: (obs?.held ?? []).length,
  heldReasons: Object.freeze([...new Set((obs?.held ?? []).map(h => h.why))]),
  inputs: obs?.inputs ? Object.freeze({ ...obs.inputs }) : null,
});

/** A port that answers nothing, with why (an observation that did not connect). */
function heldPort(summary) {
  const basisWhy = Object.freeze([`observation ${summary.status}: ${summary.reasons.join('; ') || 'no reason given'}`]);
  return Object.freeze({
    kind: 'ws13-live-canonical-held', world: null, clock: null, sameTime: false, basis: 'unstated', basisWhy,
    provenance: null, observation: summary,
    read: () => ({ status: `observation_${summary.status}`, lines: [], facts: [], basis: 'unstated', basisWhy: [...basisWhy] }),
  });
}

/**
 * The evidence port for one observation. `observation` is 12's observeLive result; `ws12EvidencePort` is 12's
 * function; `residentClock` is the resident's own clock (frame.mjs): only the Season bell of the same numbers lets
 * 12 answer (else clock_unverified, as ws12CanonicalEvidence decides).
 */
export function liveCanonicalEvidence({ ws12EvidencePort, observation, residentClock = MOCK_CLOCK }) {
  const summary = summaryOf(observation);
  // connectCanonical's own words: 'ok' (connected; some receipts may still be held, each with its reason) or 'held'
  // after a full read. 'world_unverified' (no Season) and a missing memory or clock answer nothing.
  if (!observation || !observation.memory || !observation.clock || !['ok', 'held'].includes(observation.status)) return heldPort(summary);
  const port = ws12CanonicalEvidence({
    ws12EvidencePort, memory: observation.memory, identity: observation.identity, worldClock: observation.clock,
    residentClock, provenance: observation.provenance,
  });
  return Object.freeze({
    kind: `ws13-live-over-${port.kind}`, world: port.world, clock: port.clock, sameTime: port.sameTime,
    basis: port.basis, basisWhy: port.basisWhy, provenance: port.provenance, observation: summary,
    read: q => ({ ...port.read(q), observation: { status: summary.status, held: summary.held } }),
  });
}

/** world/harness.mjs openResident's `wire(resident)`: the port as `ports.evidence`, nothing else. */
export const wireLiveEvidence = port => resident => { resident.ports.evidence = port; };
