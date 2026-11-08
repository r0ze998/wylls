// The facts ⑭ hands to ⑮ (and to anyone else): the contract, version 1.
//
// ⑭'s facts come from a toy model, not from the chain, a page or a person.
// Every event therefore carries `verified: 'unverified'`: a reader may show
// it, but must not count it as proof of anything. Nothing here names a
// winner, a score, a rank, a prize or an end of the world.
//
// `toFacts(sim)` returns
//   { schema, source, world: {ends: false}, time, case, params, tower,
//     boundaries: [{index, hour}], events: [envelope] }
// and every envelope is
//   { seq, hour, kind, actor, nation, verified: 'unverified', ...fields }
//   seq      0, 1, 2, … with no gap, in the order the model recorded them
//   hour     the model's hour (the model steps one hour at a time). It is
//            NOT chain time: a reader that wants bells multiplies by
//            `time.bellsPerHour` and says it did so.
//   actor    a village number of the model (null for the tower itself),
//            not a wallet or a Citizen
//   nation   the actor's nation in the model (null with a null actor)
//
// `KINDS` lists every kind with its own fields and what it means. A reader
// that meets a kind it does not know should skip it, not fail.
export const SCHEMA = 'wylls.ws14.tower-facts/1';
export const VERIFIED = 'unverified';
/** One model hour is six bells of the rules (travel.rs BELL_SECS 600); stated so a reader converts on purpose, never by accident. */
export const BELLS_PER_HOUR = 6;

export const KINDS = Object.freeze({
  // B: the notice board. A request is barter: the poster wants `want` and gives `give`.
  'tower.board_post': { fields: ['req'], means: 'the actor put its own open request `req` on the tower\'s board, so every nation can see it. A request, not a sighting: the tower watches nothing' },
  'tower.board_taken': { fields: ['req', 'poster', 'cross'], means: 'the actor answered board request `req` of village `poster` and sent the goods. Sent, not arrived. `cross`: poster and actor are of different nations' },
  'tower.board_fulfilled': { fields: ['req', 'responder', 'cross'], means: 'both sides of board request `req` arrived: the goods of `responder` reached the poster (the actor) and the poster\'s payment reached `responder`' },
  // C: the relay vault
  'tower.relay_offer': { fields: ['offer'], means: 'the actor\'s standing offer `offer` reached the relay vault and is open' },
  'tower.relay_swap': { fields: ['offer', 'cross', 'contributor'], means: 'the actor\'s payment reached the vault and took offer `offer`; its goods are now on the way back. `contributor`: the actor had put something into the build' },
  'tower.sent': { fields: ['role', 'res', 'amount'], means: 'the actor sent goods toward the tower (role give or upkeep). Sent, not arrived' },
  'tower.pledged': { fields: ['res', 'amount'], means: 'the actor set goods aside at home for someone else to carry to the tower' },
  'tower.carried': { fields: ['for', 'amount'], means: 'the actor set off with goods that village `for` had set aside' },
  'tower.contribution': { fields: ['amount', 'carrier', 'stage'], means: 'goods of the actor arrived at the tower (`carrier`: who carried them, or null). Arrived' },
  'tower.escort': { fields: [], means: 'the actor escorted the roads to the centre for a while' },
  'tower.upkeep_delivered': { fields: ['amount'], means: 'food for the vault\'s upkeep arrived' },
  'tower.stage_opened': { fields: ['stage'], means: 'a build stage opened (`retry`: again after a lapse)' },
  'tower.stage_completed': { fields: ['stage', 'contributors', 'nations'], means: 'a build stage was met' },
  'tower.stage_lapsed': { fields: ['stage', 'fraction', 'contributors'], means: 'a build stage was not met by its deadline (the tower\'s own rule, not a period)' },
  'tower.refund_claim': { fields: ['amount'], means: 'goods the actor had put into a lapsed stage became the actor\'s claim at the centre' },
  'tower.claim_withdrawn': { fields: ['amount'], means: 'the actor set off home with its claim' },
  'tower.dormant': { fields: ['stage'], means: 'the vault stopped for want of upkeep' },
  'tower.awake': { fields: [], means: 'the vault works again' },
  // any case
  'centre.raid': { fields: ['stage', 'fraction'], means: 'the actor began raiding the roads near the centre' },
  'period.boundary': { fields: ['index'], means: 'a boundary the model was asked to mark (a test switch, not a rule\'s war period). Nothing was reset, closed or settled' },
});

const FORBIDDEN = /^(winner|winners|victory|score|scores|rank|ranking|prize|reward|worldEnds|endOfWorld)$/i;

/** Problems with a facts object as text, [] when it keeps the contract. */
export function checkFacts(f) {
  const out = [];
  if (!f || f.schema !== SCHEMA) return [`schema is ${f?.schema}, not ${SCHEMA}`];
  if (f.world?.ends !== false) out.push('world.ends must be false');
  if (f.time?.bellsPerHour !== BELLS_PER_HOUR) out.push('time.bellsPerHour missing');
  let lastHour = -Infinity;
  const posted = new Map();
  (f.events ?? []).forEach((e, i) => {
    const at = `event ${i} (${e.kind})`;
    if (e.seq !== i) out.push(`${at}: seq ${e.seq}, expected ${i}`);
    if (!Number.isSafeInteger(e.hour) || e.hour < 0) out.push(`${at}: hour ${e.hour}`);
    if (e.hour < lastHour) out.push(`${at}: hour goes back`);
    lastHour = e.hour;
    if (e.verified !== VERIFIED) out.push(`${at}: verified ${e.verified}`);
    const k = KINDS[e.kind];
    if (!k) { out.push(`${at}: unknown kind`); return; }
    for (const field of k.fields) if (!(field in e)) out.push(`${at}: no ${field}`);
    if ((e.actor === null) !== (e.nation === null)) out.push(`${at}: actor and nation must both be set or both null`);
    for (const key of Object.keys(e)) if (FORBIDDEN.test(key)) out.push(`${at}: forbidden field ${key}`);
    if (e.kind === 'tower.board_post') posted.set(e.req, e);
    if (e.kind === 'tower.board_taken') {
      const p = posted.get(e.req);
      if (!p) out.push(`${at}: req ${e.req} was not posted on the board before`);
      else {
        if (p.actor !== e.poster) out.push(`${at}: poster ${e.poster} is not the one who posted (${p.actor})`);
        if (e.actor === e.poster) out.push(`${at}: a village answered its own request`);
        if (e.cross !== (p.nation !== e.nation)) out.push(`${at}: cross does not match the nations`);
      }
    }
    if (e.kind === 'tower.board_fulfilled') {
      const p = posted.get(e.req);
      if (!p) out.push(`${at}: req ${e.req} was not posted on the board before`);
      else if (p.actor !== e.actor) out.push(`${at}: the fulfilled side ${e.actor} is not the poster (${p.actor})`);
    }
  });
  for (const key of Object.keys(f)) if (FORBIDDEN.test(key)) out.push(`forbidden field ${key}`);
  const marked = (f.events ?? []).filter(e => e.kind === 'period.boundary').map(e => ({ index: e.index, hour: e.hour }));
  if (JSON.stringify(marked) !== JSON.stringify(f.boundaries ?? [])) out.push('boundaries do not match the period.boundary events');
  return out;
}

const EXPORTED = kind => kind in KINDS;

/** The facts of a run, in the contract's shape. */
export function toFacts(sim) {
  const events = [];
  for (const f of sim.facts) {
    if (!EXPORTED(f.kind)) continue;
    const { t, kind, actor, nation, ...fields } = f;
    events.push({ seq: events.length, hour: t, kind, actor, nation, verified: VERIFIED, ...fields });
  }
  return {
    schema: SCHEMA,
    source: 'model: workstreams/14-central-tower/proto (a toy model; not chain records)',
    world: { ends: false },
    time: { unit: 'model hour', bellsPerHour: BELLS_PER_HOUR, observedUntilHour: sim.until, atHour: sim.tick },
    case: sim.case,
    params: { ...sim.P, rules: undefined },
    tower: sim.case === 'C' ? { stage: sim.tower.stage, dormant: sim.tower.dormant, stock: { ...sim.tower.stock }, progress: { ...sim.tower.progress }, completedAtHour: [...sim.tower.completedAt], lapses: sim.tower.lapses } : null,
    boundaries: events.filter(e => e.kind === 'period.boundary').map(e => ({ index: e.index, hour: e.hour })),
    events,
  };
}
