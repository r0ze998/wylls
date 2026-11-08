// ⑭'s centre facts (`wylls.ws14.centre-facts/1`, game/centre.mjs at d9c8b81d): what the herald's public S1 feeds
// show at the centre (rings 0-1), in one snapshot. Read here as an aggregate of facts, reported only:
//   - nothing is turned into evaluator events. The feeds are the current state with no time (sightings excepted),
//     and no rule says what a vault, a structure or a transit at the centre earns. Goals, awards, scores and prizes
//     are not touched (undecided).
//   - `verified: 'derived'` (the herald folded them from chain records). Not ⑭'s model facts (`unverified`).
//   - `centre.transit.cargo` is the sum over resources of a caravan's cargo (⑭ `sumCargo`), and the summary's cargo
//     shares are built on it. The evaluator keeps resources apart, so neither is used.
//   - a sighting carries no tower owner and no subject: it cannot be credited to anyone.
//   - provenance: the herald's fold position read before and after the feeds. Moving (`stable: false`) or not
//     stated (`from: null`) is reported as such; the facts are still listed, never dated by a guess.
export const CENTRE_SCHEMA = 'wylls.ws14.centre-facts/1';
const KINDS = new Set(['centre.vault', 'centre.structure', 'centre.transit', 'centre.sighting']);
const NOT_USED = Object.freeze([
  'centre.transit.cargo: a sum over resources (the evaluator keeps resources apart)',
  'summary.cargoInnerShare / cargoConcordShare: built on that sum',
  'summary.*: recounted here from the facts, not taken',
]);

/** The centre facts as a report, or `{status: 'refused', reasons}`. Never events. */
export function readCentreFacts(doc) {
  if (!doc || doc.schema !== CENTRE_SCHEMA) return { status: 'refused', reasons: [`schema ${doc?.schema ?? 'missing'}, expected ${CENTRE_SCHEMA}`] };
  if (doc.refused) return { status: 'refused', reasons: [...doc.refused] };
  if (!Array.isArray(doc.facts)) return { status: 'refused', reasons: ['no facts list'] };
  const refusedFacts = [];
  const facts = [];
  for (const f of doc.facts) {
    if (!KINDS.has(f?.kind)) refusedFacts.push({ seq: f?.seq ?? null, why: `unknown kind ${f?.kind}` });
    else if (f.verified !== 'derived') refusedFacts.push({ seq: f.seq ?? null, why: `verified ${f.verified}, expected derived` });
    else facts.push(f);
  }
  const p = doc.provenance ?? {};
  const status = p.from === null || p.from === undefined ? 'source_unknown' : p.stable === true ? 'snapshot' : 'between';
  const of = k => facts.filter(f => f.kind === k);
  const count = (list, pred = () => true) => list.filter(pred).length;
  const byKind = {};
  for (const s of of('centre.structure')) byKind[s.structureKind] = (byKind[s.structureKind] ?? 0) + 1;
  const byFaction = {};
  for (const f of facts) {
    if (f.kind === 'centre.sighting' || f.faction === null || f.faction === undefined) continue;
    const k = String(f.faction);
    byFaction[k] ??= { vaults: 0, structures: 0, transits: 0 };
    byFaction[k][{ 'centre.vault': 'vaults', 'centre.structure': 'structures', 'centre.transit': 'transits' }[f.kind]]++;
  }
  const transits = of('centre.transit');
  return {
    status,
    reasons: status === 'snapshot' ? [] : [p.why ?? 'no /h/status read with the feeds'],
    schema: CENTRE_SCHEMA,
    verified: 'derived',
    counted: false, // reported only: no goal, award, score or prize reads these
    world: { ends: false },
    observedAt: doc.observedAt ?? null,
    asOf: p.after ?? null,
    slotCommitment: p.slotCommitment ?? 'not stated by the herald',
    counts: {
      vaults: { centre: count(of('centre.vault')), concord: count(of('centre.vault'), f => f.concord) },
      structures: { centre: count(of('centre.structure')), concord: count(of('centre.structure'), f => f.concord), byKind },
      transits: { centre: transits.length, concord: count(transits, f => f.throughConcord), raided: count(transits, f => f.raided) },
      sightings: count(of('centre.sighting')),
    },
    byFaction,
    transitOwners: transits.map(f => ({ ownerTag: String(f.ownerTag), seq: f.seqOfOwner ?? null, faction: f.faction ?? null, throughConcord: !!f.throughConcord })),
    sightings: of('centre.sighting').map(f => ({ bell: f.bell ?? null, what: f.what ?? null, towerFaction: f.towerFaction ?? null, faction: f.faction ?? null, creditedTo: null })),
    notUsed: NOT_USED,
    refusedFacts,
  };
}
