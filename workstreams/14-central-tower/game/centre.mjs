// What happens at the centre of the real game, read from the herald's
// public S1 feeds. No rule is added and nothing is decided here: the tower
// is still only a landmark, and this module only reports what the existing
// game already lets players do at and around the Concord.
//
//   centreFacts({ caravans, structures, observedAt })
//     caravans    the herald's h/caravans.json (`{v: 1, moving, vaults}`,
//                 frontier-node/crates/herald/src/caravan.rs)
//     structures  the herald's h/structures.json (`{v: 1, structures,
//                 sightings}`, herald/src/structure.rs); optional
//     observedAt  a label the caller gives the snapshot (a bell, a time);
//                 the feeds are live snapshots and carry none of their own
//
// The facts are 'derived': the herald folds them from the chain's records,
// and this module only selects and counts them (the vocabulary of ⑮'s
// contract). They are a snapshot: a caravan that has settled is gone from
// `moving`, and the herald keeps a closed vault listed until it reads it
// absent (its own note). Schema `wylls.ws14.centre-facts/1`, separate from
// the model's `tower-facts/1`, whose facts are all unverified.
import { ringOf } from '../proto/geometry.mjs';

export const SCHEMA = 'wylls.ws14.centre-facts/1';
export const VERIFIED = 'derived';
/** The centre: ring 0 is the Concord, ring 1 the six Seats around it. */
export const INNER_RING = 1;
/** `structure::KIND_*` (permutation-rules/src/frontier/structure.rs). */
export const STRUCTURE_KIND = Object.freeze({ 1: 'tower', 2: 'palisade', 3: 'fort' });

const isConcord = (p, q) => p === 0 && q === 0;
const int = x => Number.isSafeInteger(x);
const tagOrder = (a, b) => (BigInt(a.ownerTag) < BigInt(b.ownerTag) ? -1 : BigInt(a.ownerTag) > BigInt(b.ownerTag) ? 1 : (a.seq ?? a.tile ?? 0) - (b.seq ?? b.tile ?? 0));
const sumCargo = c => (Array.isArray(c) ? c.reduce((s, x) => s + (int(x) ? x : 0), 0) : 0);

/** Problems with the feeds as text ([] when they can be read). */
export function feedProblems({ caravans, structures }) {
  const out = [];
  if (!caravans || caravans.v !== 1) out.push(`h/caravans.json: version ${caravans?.v}, expected 1`);
  else {
    if (!Array.isArray(caravans.moving)) out.push('h/caravans.json: no moving list');
    if (!Array.isArray(caravans.vaults)) out.push('h/caravans.json: no vaults list');
    (caravans.moving ?? []).forEach((m, i) => {
      if (typeof m.ownerTag !== 'string' || !/^\d+$/.test(m.ownerTag)) out.push(`moving ${i}: ownerTag`);
      if (!Array.isArray(m.provinces) || !m.provinces.every(x => Array.isArray(x) && x.length === 2 && x.every(int))) out.push(`moving ${i}: provinces`);
    });
    (caravans.vaults ?? []).forEach((v, i) => { if (![v.p, v.q, v.tile].every(int)) out.push(`vault ${i}: place`); });
  }
  if (structures !== undefined && structures !== null) {
    if (structures.v !== 1) out.push(`h/structures.json: version ${structures.v}, expected 1`);
    else (structures.structures ?? []).forEach((s, i) => { if (![s.p, s.q, s.tile, s.kind].every(int)) out.push(`structure ${i}: place or kind`); });
  }
  return out;
}

/** The centre's facts and counts in one snapshot of the feeds. */
export function centreFacts({ caravans, structures = null, observedAt = null }) {
  const problems = feedProblems({ caravans, structures });
  if (problems.length) return { schema: SCHEMA, refused: problems };
  const facts = [];
  const push = (kind, fields) => facts.push({ ...fields, seq: facts.length, kind, verified: VERIFIED });

  // Vaults and structures standing in the Concord or a Seat: who holds a place at the centre.
  for (const v of [...caravans.vaults].sort(tagOrder)) {
    const ring = ringOf(v.p, v.q);
    if (ring <= INNER_RING) push('centre.vault', { p: v.p, q: v.q, tile: v.tile, ring, concord: isConcord(v.p, v.q), faction: v.faction ?? null, ownerTag: v.ownerTag, gen: v.gen ?? null });
  }
  const items = structures ? [...(structures.structures ?? [])].sort(tagOrder) : [];
  for (const s of items) {
    const ring = ringOf(s.p, s.q);
    if (ring <= INNER_RING) push('centre.structure', { p: s.p, q: s.q, tile: s.tile, ring, concord: isConcord(s.p, s.q), structureKind: STRUCTURE_KIND[s.kind] ?? `kind ${s.kind}`, faction: s.faction ?? null, ownerTag: s.ownerTag });
  }
  // Caravans on the road whose walk enters the centre.
  let cargoAll = 0, cargoInner = 0, cargoConcord = 0, inner = 0, concord = 0;
  for (const m of [...caravans.moving].sort(tagOrder)) {
    const cargo = sumCargo(m.cargo);
    cargoAll += cargo;
    const rings = m.provinces.map(([p, q]) => ringOf(p, q));
    const throughConcord = m.provinces.some(([p, q]) => isConcord(p, q));
    if (Math.min(...rings) > INNER_RING) continue;
    inner++; cargoInner += cargo;
    if (throughConcord) { concord++; cargoConcord += cargo; }
    push('centre.transit', { ownerTag: m.ownerTag, seqOfOwner: m.seq ?? null, faction: m.faction ?? null, throughConcord, innermostRing: Math.min(...rings), provinces: m.provinces.length, cargo, raided: !!m.raided });
  }
  // What watchtowers standing at the centre reported (S1's own sightings).
  const towerAtCentre = new Set(facts.filter(f => f.kind === 'centre.structure' && f.structureKind === 'tower').map(f => `${f.p},${f.q},${f.tile}`));
  for (const s of structures?.sightings ?? []) {
    const t = s.tower;
    if (!t || !towerAtCentre.has(`${t.p},${t.q},${t.tile}`)) continue;
    push('centre.sighting', { bell: s.bell ?? null, tower: { p: t.p, q: t.q, tile: t.tile }, towerFaction: s.towerFaction ?? null, what: s.what ?? null, faction: s.faction ?? null });
  }

  const moving = caravans.moving.length;
  const byFaction = {};
  for (const f of facts) if (f.kind !== 'centre.sighting' && f.faction !== null) {
    const k = String(f.faction);
    byFaction[k] ??= { vaults: 0, structures: 0, transits: 0 };
    byFaction[k][{ 'centre.vault': 'vaults', 'centre.structure': 'structures', 'centre.transit': 'transits' }[f.kind]]++;
  }
  return {
    schema: SCHEMA,
    source: 'herald h/caravans.json and h/structures.json (S1 public feeds), a snapshot',
    world: { ends: false },
    observedAt,
    facts,
    summary: {
      moving,
      throughInner: inner,
      throughConcord: concord,
      innerShare: moving ? inner / moving : null,
      concordShare: moving ? concord / moving : null,
      cargoInnerShare: cargoAll ? cargoInner / cargoAll : null,
      cargoConcordShare: cargoAll ? cargoConcord / cargoAll : null,
      vaultsAtCentre: facts.filter(f => f.kind === 'centre.vault').length,
      vaultsInConcord: facts.filter(f => f.kind === 'centre.vault' && f.concord).length,
      structuresAtCentre: facts.filter(f => f.kind === 'centre.structure').length,
      structuresInConcord: facts.filter(f => f.kind === 'centre.structure' && f.concord).length,
      byFaction,
    },
  };
}
