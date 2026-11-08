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
//   - PROVENANCE: where each input came from (basisCheck below). Only basis `chain` lets the resident act on it
//     (resident.mjs #publicEvidence); a fixture, the integrated build's own simulated output, or a cross-check is
//     never taken for chain evidence, finality or completeness.
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

/**
 * Whether the inputs are chain evidence, and why not. Kinds: `chain` (read from the chain or its indexer, with a
 * source), `integration-output` (records the integrated build produced, e.g. workstream 4's runexec over its simulated
 * chain), `fixture` (made up for a test). Basis `chain` needs every part `chain` with a source, AND:
 *   - finality in workstream 12's attestation shape (adapters/canonical.mjs finalizedSlotFrom): commitment
 *     'finalized', a slot, the world_id of the memory's world;
 *   - nothing offered as finality or completeness that is not that: a cross-check (`cross_checked`, workstream 19's
 *     word) says two readings agree, not that the history is complete or that a slot is finalized.
 * Any `fixture` part makes the basis `fixture`; else any `integration-output` part makes it `integration-output`;
 * else (missing or malformed parts) `unstated`. Only `chain` lets evidence act (resident.mjs).
 */
export function basisCheck(provenance, { world = null } = {}) {
  const why = [];
  const parts = PROVENANCE_PARTS.map(p => [p, provenance?.[p] ?? null]);
  for (const [p, x] of parts) {
    if (!x) { why.push(`${p}: not stated`); continue; }
    if (x.cross_checked !== undefined || x.proof === 'cross_checked' || x.commitment === 'cross_checked') why.push(`${p}: cross_checked is not ${p === 'records' ? 'completeness' : 'finality'}`);
    // Workstream 19's history words (docs/frontier/history-coverage.ja.md, bundle ws19-on-6984acfa, as 19 described
    // them to 13): history.complete is never true (false when unproven, else null); not_fetched, a gap or a range
    // outside what was fetched is not "nothing happened"; HistoryUnproven makes other failures unconfirmed.
    if ('complete' in x && x.complete !== true) why.push(`${p}: history not proven complete (complete: ${x.complete})`);
    if (x.history_unproven || x.HistoryUnproven || (Array.isArray(x.coverage) && x.coverage.some(c => ['not_fetched', 'gap'].includes(c?.state ?? c)))) why.push(`${p}: history unproven (not_fetched or gap is not absence)`);
    if (x.kind !== 'chain') why.push(`${p}: ${x.kind ?? 'no kind'}`);
    else if (typeof x.source !== 'string' || !x.source) why.push(`${p}: chain without a source`);
  }
  const f = provenance?.finality;
  if (f?.kind === 'chain' && !(f.commitment === 'finalized' && Number.isSafeInteger(f.slot) && typeof f.world_id === 'string')) why.push('finality: not a finalized attestation {commitment, slot, world_id}');
  if (f?.kind === 'chain' && world && f.world_id !== world.world_id) why.push('finality: for another world');
  const kinds = parts.map(([, x]) => x?.kind);
  const basis = !why.length ? 'chain' : kinds.includes('fixture') ? 'fixture' : kinds.includes('integration-output') ? 'integration-output' : 'unstated';
  return { basis, why };
}
/** The basis alone (see basisCheck). */
export const basisOf = (provenance, opts) => basisCheck(provenance, opts).basis;

export function ws12CanonicalEvidence({ ws12EvidencePort, memory, identity, worldClock, residentClock = MOCK_CLOCK, provenance = null }) {
  if (typeof ws12EvidencePort !== 'function') throw new TypeError("workstream 12's ws12EvidencePort");
  const clock = seasonClock(worldClock);
  const sameTime = sameClock(residentClock, clock);
  const port = ws12EvidencePort(memory, { identity, worldBellOf: sameTime ? b => b : null });
  const world = memory?.world && typeof memory.world.world_id === 'string' ? { cluster: memory.world.cluster, world_id: memory.world.world_id } : null;
  const prov = Object.freeze(Object.fromEntries(PROVENANCE_PARTS.map(p => [p, provenance?.[p] ? Object.freeze({ ...provenance[p] }) : null])));
  const { basis, why: basisWhy } = basisCheck(provenance, { world });
  return Object.freeze({
    kind: `ws13-over-${port.kind}`,
    world, clock, sameTime, basis, basisWhy, provenance: prov,
    read(q) {
      const r = port.read(q);
      if (r.status !== 'ok') return { ...r, facts: [], basis, basisWhy };
      // The same view 12's port used (public, at the world bell, observed by then), as structured commitments.
      const k = memory.knowledge(PUBLIC_VIEWER, q.worldBell, { observedBy: q.worldBell });
      const facts = k.commitments.filter(c => c.debtor === q.counterparty).map(c => ({
        commitment: c.id, state: c.state, due_bell: c.due_bell, verified: VERIFIED_STATES.includes(c.state), breach: BREACH_STATES.includes(c.state), sources: [...c.sources],
      }));
      return { ...r, facts, basis, basisWhy };
    },
  });
}
