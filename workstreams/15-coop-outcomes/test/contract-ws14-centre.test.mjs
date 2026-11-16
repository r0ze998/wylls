// Contract test against ⑭'s centre facts (wylls.ws14.centre-facts/1, 88cf67c0): outputs of ⑭'s own centreFacts
// (scenarios/fixtures/ws14-centre-88cf67c0.json, gen-ws14-centre.mjs). Reported as an aggregate; never events.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readCentreFacts } from '../src/adapters/ws14-centre.mjs';
import { fromTowerFacts } from '../src/adapters/ws14.mjs';

const fx = JSON.parse(readFileSync(new URL('../scenarios/fixtures/ws14-centre-88cf67c0.json', import.meta.url), 'utf8'));
const O = fx.outputs;

test('a still fold is a snapshot; vaults, structures, transits and sightings are counted per kind', () => {
  const r = readCentreFacts(O.still);
  assert.equal(r.status, 'snapshot');
  assert.deepEqual(r.counts, {
    vaults: { centre: 2, concord: 1 },
    structures: { centre: 1, concord: 1, byKind: { tower: 1 } },
    transits: { centre: 2, concord: 1, raided: 0 },
    sightings: 1,
  });
  assert.deepEqual(r.refusedFacts, []);
  assert.equal(r.counted, false);
  assert.equal(r.world.ends, false);
});

test('cargo summed over resources by the source is not used; the evaluator keeps resources apart', () => {
  const r = readCentreFacts(O.still);
  const t = O.still.facts.find(f => f.kind === 'centre.transit' && f.ownerTag === '12');
  assert.equal(t.cargo, 80, '⑭ sums 30 wood and 50 stone');
  assert.ok(r.notUsed.some(s => /sum over resources/.test(s)));
  assert.ok(!JSON.stringify(r.counts).includes('80'));
  assert.ok(r.transitOwners.every(o => !('cargo' in o)));
  // ⑭'s per-resource cargo (88cf67c0) is read per resource: 100 + 30 wood, 50 stone at the centre; 100 wood through the Concord
  assert.deepEqual(r.cargo.byResource.wood, { centre: 130, concord: 100 });
  assert.deepEqual(r.cargo.byResource.stone, { centre: 50, concord: 0 });
  assert.equal(r.cargo.notGiven, 0);
  // a transit without cargoByResource (⑭ before 88cf67c0) is "not given", not zero
  const old = { ...O.still, facts: O.still.facts.map(({ cargoByResource, ...f }) => f) };
  assert.equal(readCentreFacts(old).cargo.notGiven, 2);
  assert.deepEqual(readCentreFacts(old).cargo.byResource.wood, { centre: 0, concord: 0 });
});

test('⑭\'s null cargo (28618a83) is "not given"; a known zero 8-slot cargo is a known zero, not "not given"', () => {
  // source-only: built from the frozen output, nothing regenerated; ⑭ writes cargo and cargoByResource null together
  const transitIdx = O.still.facts.flatMap((f, i) => (f.kind === 'centre.transit' ? [i] : []));
  assert.equal(transitIdx.length, 2);
  const withCargo = list => ({ ...O.still, facts: O.still.facts.map((f, i) => (transitIdx.includes(i) ? { ...f, ...list[transitIdx.indexOf(i)] } : f)) });
  const nul = { cargo: null, cargoByResource: null }, zero = { cargo: 0, cargoByResource: [0, 0, 0, 0, 0, 0, 0, 0] };
  const mixed = readCentreFacts(withCargo([nul, zero])).cargo;
  assert.equal(mixed.notGiven, 1, 'the null one only');
  assert.ok(Object.values(mixed.byResource).every(x => x.centre === 0 && x.concord === 0));
  const zeros = readCentreFacts(withCargo([zero, zero])).cargo;
  assert.equal(zeros.notGiven, 0, 'two known zeros are not "not given"');
  assert.equal(readCentreFacts(withCargo([nul, nul])).cargo.notGiven, 2);
  assert.equal(readCentreFacts(withCargo([nul, zero])).counts.transits.centre, 2, 'the transit itself is still counted');
});

test('u64 owner tags stay exact strings', () => {
  const r = readCentreFacts(O.still);
  assert.ok(r.transitOwners.some(o => o.ownerTag === '17278127443140898241'));
});

test('a moving fold is "between"; no /h/status is "source unknown": listed, not dated by a guess', () => {
  const m = readCentreFacts(O.moving);
  assert.equal(m.status, 'between');
  assert.match(m.reasons[0], /moved/);
  assert.deepEqual(m.counts, readCentreFacts(O.still).counts);
  const f = readCentreFacts(O.file);
  assert.equal(f.status, 'source_unknown');
  assert.equal(f.asOf, null);
  assert.equal(f.slotCommitment, 'not stated by the herald');
});

test('a sighting names the tower\'s owner and its subject (u64 exact), and is credited to no one (undecided)', () => {
  const r = readCentreFacts(O.still);
  assert.deepEqual(r.sightings, [{ bell: 290, what: 'caravan', towerFaction: 2, faction: 0, towerOwnerTag: '31', subject: '17278127443140898241', creditedTo: null }]);
});

test('refusals: another version, another schema, an unknown kind, a fact not derived', () => {
  assert.equal(readCentreFacts(O.badVersion).status, 'refused');
  assert.equal(readCentreFacts({ ...O.still, schema: 'wylls.ws14.tower-facts/1' }).status, 'refused');
  const odd = { ...O.still, facts: [...O.still.facts, { seq: 99, kind: 'centre.prize', verified: 'derived' }, { ...O.still.facts[0], seq: 98, verified: 'unverified' }] };
  assert.deepEqual(readCentreFacts(odd).refusedFacts.map(x => x.seq), [99, 98]);
});

test('①\'s real herald file has nothing at the centre; the tower-facts reader refuses centre facts', () => {
  const r = readCentreFacts(O.herald);
  assert.equal(r.counts.transits.centre, 0);
  const t = fromTowerFacts(O.still, {});
  assert.match(t.refused, /neither wylls\.ws14\.tower-facts/);
  assert.deepEqual(t.events, []);
});
