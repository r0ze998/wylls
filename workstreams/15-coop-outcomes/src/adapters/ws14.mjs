// ⑭'s tower facts → evaluator events. OPTIONAL: no rule needs a tower.
// Written against ⑭'s real output: `toFacts(sim)` of
// workstreams/14-central-tower/proto/adapters.mjs at
// 7d7f2143d6f2696a3bc323d1d619b1d6961a7b18 (origin/preserve/ws14-7d7f2143),
// README §9.1. A fixture of that output, produced by ⑭'s own code, is in
// scenarios/fixtures/ (test/contract-ws14.test.mjs).
//
// What ⑭'s facts are (§9.1) and how they are read here:
//   - every fact is `{t, kind, actor, nation, ...}`; `t` is the model's hour
//     (1 hour = 6 turns = 6 bells of 600 s), not a bell; the array position is
//     the order (no `seq`)
//   - they are made by a simulation, not read from the chain: `verified:
//     'model'`. The evaluator never counts them as facts of the game (a goal
//     they alone support is `model_only`, never `achieved`, and gives no award)
//   - `tower.board_post {req}`: `actor` posted request `req` on the notice
//     board (case B). It is not a sighting (⑭'s tower has no sighting function)
//   - `tower.board_taken {req, cross}`: `actor` answered it by sending goods
//     (a send, not an arrival); `cross` = another nation
//   - `tower.board_fulfilled {req, cross}`: the exchange arrived both ways
//     (`actor` = the poster)
//   - `tower.relay_swap {offer, cross, contributor}`: a swap at the relay
//     storehouse (case C). Not a use of a joint structure of this evaluator
//   - every other kind (stages, upkeep, escorts, raids at the centre, refunds)
//     stays ⑭'s: kept as a position (`skipped`), never judged
//   - `period.boundary {index}` is recorded first in its hour, so facts with
//     the same `t` belong to the period after it: the same half-open windows
//     as the evaluator's. `toFacts()` leaves these facts out (it keeps
//     `tower.*` and `centre.*` only); pass them as `boundaries` (from the
//     model's `sim.facts`) to get the windows.
// ⑭ decides no winner and no end of the world; neither does this adapter.

export const SCHEMA = 'wylls.ws14.tower-facts/0';
/** ⑭: 1 model hour = 6 turns; one turn is one S1 bell (600 s, prologue.rs bell_at). */
export const BELLS_PER_HOUR = 6;
/** The evaluator kinds ⑭'s facts become (the stream is declared to carry these only). */
export const WS14_KINDS = Object.freeze(['tower.request.posted', 'tower.request.taken', 'tower.request.fulfilled', 'tower.relay.swap', 'position']);
const MAP = {
  'tower.board_post': 'tower.request.posted',
  'tower.board_taken': 'tower.request.taken',
  'tower.board_fulfilled': 'tower.request.fulfilled',
  'tower.relay_swap': 'tower.relay.swap',
};

/**
 * `{events, skipped, unresolved, streams, refused}`. `map.actorOf(village)`
 * names the evaluator's participant for ⑭'s village number (null: unknown,
 * left out and listed: a gap, never a guess); `map.nationOf(nation)` the
 * nation (default `n<number>`). The stream is declared complete
 * (`through`) and limited to WS14_KINDS, so a missing fact undecides only
 * what tower facts decide.
 */
export function fromTowerFacts(facts, map, { stream = 'ws14', bellsPerHour = BELLS_PER_HOUR } = {}) {
  if (!facts || facts.schema !== SCHEMA) return { events: [], skipped: [], unresolved: [], streams: {}, refused: `schema ${facts?.schema ?? 'missing'} is not ${SCHEMA}` };
  const nationOf = map.nationOf ?? (n => `n${n}`);
  const events = [];
  const skipped = [];
  const unresolved = [];
  const list = facts.events ?? [];
  list.forEach((f, seq) => {
    const at = f.t * bellsPerHour;
    const base = { id: `${stream}:${seq}`, stream, seq, at, verified: 'model', src: { kind: f.kind, t: f.t } };
    const kind = MAP[f.kind];
    if (!kind || f.actor === null || f.actor === undefined) {
      skipped.push({ seq, kind: f.kind });
      events.push({ ...base, kind: 'position' });
      return;
    }
    const actor = map.actorOf(f.actor);
    if (!actor) { unresolved.push({ seq, kind: f.kind, village: f.actor }); return; }
    const nation = f.nation === null || f.nation === undefined ? null : nationOf(f.nation);
    if (kind === 'tower.relay.swap') events.push({ ...base, kind, actor, nation, offer: f.offer, cross: !!f.cross, contributor: !!f.contributor });
    else events.push({ ...base, kind, req: String(f.req), actor, nation, ...(f.cross === undefined ? {} : { cross: !!f.cross }) });
  });
  return { events, skipped, unresolved, refused: null, streams: { [stream]: { from: 0, through: list.length - 1, kinds: WS14_KINDS } } };
}

/**
 * Evaluation windows from ⑭'s `period.boundary` facts (`sim.facts`): a
 * boundary at hour `t` closes one window and opens the next at bell
 * `t * bellsPerHour`. `from` and `to` (bells) bound the first and last.
 * ⑭ marks where a boundary would fall; it decides no period length, and
 * neither does this (`periodHours` is undecided on both sides).
 */
export function windowsFromBoundaries(boundaries, { from, to, bellsPerHour = BELLS_PER_HOUR, prefix = 'P' }) {
  const cuts = (boundaries ?? []).filter(b => b.kind === 'period.boundary').map(b => b.t * bellsPerHour).filter(b => b > from && b < to).sort((a, b) => a - b);
  const edges = [from, ...new Set(cuts), to];
  return edges.slice(0, -1).map((a, i) => ({ id: `${prefix}${i}`, opensAt: a, endsAt: edges[i + 1] }));
}
