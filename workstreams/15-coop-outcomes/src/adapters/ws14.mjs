// ⑭'s tower facts → evaluator events. OPTIONAL: no rule here needs a tower;
// without this input the tower's personal goal is simply not offered.
// Written from ⑭'s relayed interface (`toFacts(sim)` →
// `{schema: 'wylls.ws14.tower-facts/0', case, params, tower, events}`, no
// winner and no end), while ⑭ was still running and before it committed; the
// per-fact fields below are ASSUMED and the mapping is checked on synthetic
// facts only.
//
// ⑭ decides no winner and no end of the world; neither does this adapter.
// Only facts that are someone's observation used by someone else, or a use
// of a built thing, are mapped. Everything else (board posts, stages,
// upkeep, dormancy) stays ⑭'s and is listed as `skipped`.

export const SCHEMA = 'wylls.ws14.tower-facts/0';

/** Assumed fact fields: `{kind, hour, actor?, id?, of?, by?, structure?}`. */
export function fromTowerFacts(facts, map, { stream = 'ws14' } = {}) {
  if (!facts || facts.schema !== SCHEMA) return { events: [], skipped: [], refused: `schema ${facts?.schema ?? 'missing'} is not ${SCHEMA}` };
  const events = [];
  const skipped = [];
  (facts.events ?? []).forEach((f, seq) => {
    const at = map.bellOfHour(f.hour);
    const base = { id: `${stream}:${seq}`, stream, seq, at, verified: 'derived', src: { kind: f.kind } };
    if (f.kind === 'tower.board_post' && f.actor) events.push({ ...base, kind: 'tower.sighting', sighting: f.id ?? `post:${seq}`, tower: 'central', actor: map.actorOf(f.actor) });
    else if (f.kind === 'tower.board_taken' && f.by) events.push({ ...base, kind: 'tower.report.used', sighting: f.of, actor: map.actorOf(f.by) });
    else if (f.kind === 'tower.relay_swap' && f.actor && map.relayStructure) events.push({ ...base, kind: 'use', structure: map.relayStructure, actor: map.actorOf(f.actor), how: 'supply' });
    else { skipped.push({ seq, kind: f.kind }); events.push({ ...base, kind: 'position', verified: 'chain' }); }
  });
  return { events, skipped, refused: null };
}
