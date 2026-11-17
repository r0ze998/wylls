// ⑭'s tower facts → evaluator events. OPTIONAL: no rule needs a tower.
//
// Two versions of ⑭'s contract are read by one path (normalizeTowerFacts):
//   v1 `wylls.ws14.tower-facts/1` — ⑭ at bde8d1c1a92b5766b79bf0af7aae69052ca8ea34,
//      workstreams/14-central-tower/CONTRACT.ja.md and proto/contract.mjs:
//      `{schema, source, world: {ends: false}, time: {unit, bellsPerHour, …},
//      case, params, tower, boundaries: [{index, hour}], events}`, every event
//      `{seq, hour, kind, actor, nation, verified: 'unverified', …}`
//   v0 `wylls.ws14.tower-facts/0` — ⑭ at 7d7f2143: `{t, kind, actor, nation}`,
//      no seq (array order), no time block, no boundaries
// Fixtures of both, produced by ⑭'s own code, are in scenarios/fixtures/.
//
// How the facts are read:
//   - `hour` (v0: `t`) is the model's hour, not chain time. Bells are
//     `hour × time.bellsPerHour`, the factor ⑭ states (v1); v0 states none
//     and its documented 6 is used and named as such (`bellsPerHourSource`)
//   - `seq` is the stream position (v0: the array index); ⑭ promises no gap
//   - `actor` is a village number of the model, not a wallet or a Citizen:
//     `map.actorOf(village)` names a participant of the evaluator, or null
//     (left out and listed: a gap, never a guess)
//   - ⑭ marks every fact `unverified`: made by a toy model. Here they become
//     `verified: 'model'`, which the evaluator never counts as a fact of the
//     game (a goal they alone support is `model_only`, no award)
//   - `tower.board_post {req}`: a request put on the notice board. Not a sighting
//   - `tower.board_taken {req, poster, cross}`: the actor answered `poster`'s
//     request and SENT goods (not arrived)
//   - `tower.board_fulfilled {req, responder, cross}`: both sides ARRIVED;
//     the actor is the poster, `responder` the one whose goods came (v1)
//   - `tower.relay_swap`: a swap at the relay storehouse; not a use of a joint
//     structure of this evaluator
//   - `period.boundary {index}`: a mark ⑭'s model was asked to make (a test
//     switch, "not a rule's war period"). It becomes `model.boundary`, kept
//     and reported, and is NOT made into an evaluation window: windows come
//     from whoever defines war periods (⑧ → ④), not from the tower
//   - other kinds stay ⑭'s: positions only
// ⑭ decides no winner and no end of the world; neither does this adapter.

export const SCHEMA_V0 = 'wylls.ws14.tower-facts/0';
export const SCHEMA_V1 = 'wylls.ws14.tower-facts/1';
export const SCHEMA = SCHEMA_V1;
/** ⑭ v0's documented factor (1 model hour = 6 turns of 600 s); v1 states it in `time.bellsPerHour`. */
export const BELLS_PER_HOUR = 6;
/** The evaluator kinds ⑭'s facts become (the stream is declared to carry these only). */
export const WS14_KINDS = Object.freeze(['tower.request.posted', 'tower.request.taken', 'tower.request.fulfilled', 'tower.relay.swap', 'model.boundary', 'position']);
const MAP = {
  'tower.board_post': 'tower.request.posted',
  'tower.board_taken': 'tower.request.taken',
  'tower.board_fulfilled': 'tower.request.fulfilled',
  'tower.relay_swap': 'tower.relay.swap',
  'period.boundary': 'model.boundary',
};

/**
 * Either version as `{version, bellsPerHour, bellsPerHourSource, events,
 * boundaries, problems}` with every event `{seq, hour, kind, actor, nation,
 * …}`. `problems` lists contract breaches found while reading (a seq that is
 * not its position, an hour that goes back, a v1 fact not `unverified`, a
 * missing `bellsPerHour`); a fact with a problem is not used.
 */
export function normalizeTowerFacts(facts, { bellsPerHour } = {}) {
  if (!facts || (facts.schema !== SCHEMA_V0 && facts.schema !== SCHEMA_V1)) return { refused: `schema ${facts?.schema ?? 'missing'} is neither ${SCHEMA_V1} nor ${SCHEMA_V0}` };
  const v1 = facts.schema === SCHEMA_V1;
  const problems = [];
  let factor = bellsPerHour;
  let source = 'caller';
  if (factor === undefined) {
    if (v1 && Number.isSafeInteger(facts.time?.bellsPerHour) && facts.time.bellsPerHour > 0) { factor = facts.time.bellsPerHour; source = 'time.bellsPerHour (⑭ v1)'; }
    else if (!v1) { factor = BELLS_PER_HOUR; source = '⑭ v0 README §9.1: 1 hour = 6 turns'; }
    else return { refused: 'v1 facts without time.bellsPerHour: the hour cannot be turned into bells' };
  }
  const events = [];
  let lastHour = -Infinity;
  (facts.events ?? []).forEach((f, i) => {
    const e = v1 ? { ...f } : { ...f, seq: i, hour: f.t };
    delete e.t;
    if (e.seq !== i) { problems.push({ seq: i, why: `seq ${e.seq} is not its position` }); return; }
    if (!Number.isSafeInteger(e.hour) || e.hour < 0) { problems.push({ seq: i, why: `hour ${e.hour}` }); return; }
    if (e.hour < lastHour) { problems.push({ seq: i, why: 'hour goes back' }); return; }
    lastHour = e.hour;
    if (v1 && e.verified !== 'unverified') { problems.push({ seq: i, why: `verified ${e.verified}: ⑭'s facts are unverified` }); return; }
    events.push(e);
  });
  const boundaries = v1 ? (facts.boundaries ?? []).map(b => ({ index: b.index, hour: b.hour })) : events.filter(e => e.kind === 'period.boundary').map(e => ({ index: e.index, hour: e.hour }));
  return { version: v1 ? 1 : 0, bellsPerHour: factor, bellsPerHourSource: source, events, boundaries, problems, length: (facts.events ?? []).length, refused: null };
}

/**
 * `{events, skipped, unresolved, problems, boundaries, streams, refused}`.
 * `map.actorOf(village)` names the participant for ⑭'s village number;
 * `map.nationOf(nation)` the nation (default `n<number>`). The stream is
 * declared complete (`through`) and limited to WS14_KINDS, so a missing or
 * refused fact undecides only what tower facts decide. `boundaries` are
 * ⑭'s marks in bells, for reporting: they are not evaluation windows.
 */
export function fromTowerFacts(facts, map, { stream = 'ws14', bellsPerHour } = {}) {
  const n = normalizeTowerFacts(facts, { bellsPerHour });
  if (n.refused) return { events: [], skipped: [], unresolved: [], problems: [], boundaries: [], streams: {}, refused: n.refused };
  const nationOf = map.nationOf ?? (x => `n${x}`);
  const actorOf = v => (v === null || v === undefined ? null : map.actorOf(v));
  const events = [];
  const skipped = [];
  const unresolved = [];
  for (const f of n.events) {
    const at = f.hour * n.bellsPerHour;
    const base = { id: `${stream}:${f.seq}`, stream, seq: f.seq, at, verified: 'model', src: { kind: f.kind, hour: f.hour, version: n.version } };
    const kind = MAP[f.kind];
    if (kind === 'model.boundary') { events.push({ ...base, kind, index: f.index }); continue; }
    if (!kind || f.actor === null || f.actor === undefined) { skipped.push({ seq: f.seq, kind: f.kind }); events.push({ ...base, kind: 'position' }); continue; }
    const actor = actorOf(f.actor);
    if (!actor) { unresolved.push({ seq: f.seq, kind: f.kind, village: f.actor }); continue; }
    const nation = f.nation === null || f.nation === undefined ? null : nationOf(f.nation);
    if (kind === 'tower.relay.swap') { events.push({ ...base, kind, actor, nation, offer: f.offer, cross: !!f.cross, contributor: !!f.contributor }); continue; }
    const extra = {};
    if (f.cross !== undefined) extra.cross = !!f.cross;
    if (kind === 'tower.request.taken' && f.poster !== undefined) {
      const poster = actorOf(f.poster);
      if (!poster) { unresolved.push({ seq: f.seq, kind: f.kind, village: f.poster }); continue; }
      extra.poster = poster;
    }
    if (kind === 'tower.request.fulfilled' && f.responder !== undefined) {
      const responder = actorOf(f.responder);
      if (!responder) { unresolved.push({ seq: f.seq, kind: f.kind, village: f.responder }); continue; }
      extra.responder = responder;
    }
    events.push({ ...base, kind, req: String(f.req), actor, nation, ...extra });
  }
  return {
    events, skipped, unresolved, problems: n.problems, refused: null,
    version: n.version, bellsPerHour: n.bellsPerHour, bellsPerHourSource: n.bellsPerHourSource,
    boundaries: n.boundaries.map(b => ({ ...b, bell: b.hour * n.bellsPerHour, note: '⑭\'s model mark: not an evaluation window, not a war period' })),
    streams: { [stream]: { from: 0, through: n.length - 1, kinds: WS14_KINDS } },
  };
}
