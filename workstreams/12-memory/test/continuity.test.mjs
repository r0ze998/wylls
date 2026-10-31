// Workstream 12, continuing world: records cross a fixed, short partition boundary and the memory stays whole.
//   p1 = world bells [0, 200), p2 = [200, ...): the fixture's stand-in for two Season accounts of ONE world.
// Checked before the boundary, after it, and after a restart: who owns what, how much was delivered, how many
// times a thing was counted, and what reliability says. Long-run growth is a separate test (longrun.test.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decisionInput } from '../src/index.mjs';
import { canonical, sha256hex } from '../src/records.mjs';
import { A, B, C, LIMITS, PARTITIONS, PLACE_A, REQUEST, WORLD, alias, allocate, allocateOp, caravanFacts, coverage, cv, dm, newMemory,
  promise, signedAllocation, tagIn, world } from '../fixtures/scenario.mjs';

const BOUNDARY = 200;
const PLACE_A2 = Object.freeze({ ...PLACE_A, partition: 'p2' });
const placeAlias = m => m.observe({ kind: 'place_alias', bell: BOUNDARY, source: { chain: 'index', sig: 'pa-A', ix: 0 }, data: { a: PLACE_A, b: PLACE_A2 } });
const one = (m, at = 300) => m.knowledge(A, at).commitments[0];
const stateHash = (m, at) => { const k = m.knowledge(A, at); return sha256hex(canonical({ c: k.commitments, r: k.reliability, cl: k.claims, u: k.unusable })); };

test('boundary: a promise made in p1 and delivered in p2 is fulfilled only through 4\'s continuity attestations', () => {
  const run = ({ place = true, id = true } = {}) => {
    const m = newMemory();
    const p = promise(m, { bell: 100, due: 260 });
    allocate(m, { ref: p.accept, partition: 'p2', seq: 1, bell: 205 });
    if (place) placeAlias(m);
    caravanFacts(m, { dst: PLACE_A2, seq: 1, depart: 205, settle: 240, withAlias: id });
    return one(m);
  };
  assert.equal(run().state, 'fulfilled');
  // without 4 saying it is the same place / the same principal: unknown, never "misdirected" or "not sent"
  assert.deepEqual([run({ place: false }).state, run({ place: false }).reasons], ['unconfirmed', ['place_identity_unverified']]);
  assert.deepEqual([run({ id: false }).state, run({ id: false }).reasons], ['unconfirmed', ['identity_unverified']]);
});

test('boundary: a caravan that left in p1 and settles after the boundary is still the same delivery', () => {
  const m = newMemory();
  const p = promise(m, { bell: 100, due: 260 });
  allocate(m, { ref: p.accept, bell: 150 });
  caravanFacts(m, { depart: 180, settle: 230 });
  const before = one(m, 199);
  assert.equal(before.state, 'in_progress');
  const after = one(m, 300);
  assert.equal(after.state, 'fulfilled');
  assert.equal(after.delivered_min, 100, 'delivered once, in full');
  assert.equal(after.links.length, 1);
});

test('boundary: reliability accrues to the principal across partitions and decays continuously (no reset)', () => {
  const m = newMemory();
  const p1 = promise(m, { bell: 100, due: 130 });
  allocate(m, { ref: p1.accept, bell: 102 });
  caravanFacts(m, { seq: 7 });
  placeAlias(m);
  const p2 = promise(m, { bell: 210, due: 240, place: PLACE_A2 });
  allocate(m, { ref: p2.accept, partition: 'p2', seq: 1, bell: 212 });
  caravanFacts(m, { dst: PLACE_A2, seq: 1, depart: 212, settle: 230 });
  const rel = m.knowledge(A, 400).reliability.B;
  assert.equal(rel.n_direct, 2, 'B_p1 and B_p2 are one principal');
  assert.deepEqual(rel.evidence.map(e => e.state), ['fulfilled', 'fulfilled']);
  // the p1 evidence keeps its age across the boundary: weight 0.5^((400-120)/432), not reset to 1 at bell 200
  assert.ok(Math.abs(rel.evidence[0].weight - 0.5 ** (280 / 432)) < 1e-6);
  assert.ok(rel.evidence[0].weight < rel.evidence[1].weight);
});

test('boundary: "not sent" needs the whole window; coverage from both partitions is joined through identity_alias', () => {
  const m = newMemory();
  promise(m, { bell: 100, due: 260 });
  coverage(m, { from: 90, to: 199, bell: 199 });
  assert.deepEqual([one(m).state, one(m).coverage_gaps], ['unconfirmed', ['window_not_fully_covered']]);
  coverage(m, { partition: 'p2', from: 200, to: 270, bell: 270, withAlias: false });
  assert.deepEqual(one(m).reasons, ['coverage_insufficient'], 'B_p2 is nobody until 4 attests it');
  alias(m, 'B', 'p2');
  assert.equal(one(m).state, 'not_sent');
});

test('boundary: an allocation signed in p1 stays in force in p2; nonces continue per signer across partitions', () => {
  const m = newMemory();
  const p = promise(m, { bell: 100, due: 260 });
  allocateOp(m, { ref: p.accept, bell: 150, nonce: 1, qty: 100 });
  caravanFacts(m, { depart: 160, settle: 230 });
  assert.equal(one(m).state, 'fulfilled');
  // a correction signed after the boundary (nonce 2) is in force; reusing nonce 1 in p2 is refused
  assert.equal(allocateOp(m, { ref: p.accept, bell: 210, nonce: 2, qty: 60 }).status, 'added');
  assert.equal(allocateOp(m, { ref: p.accept, bell: 211, nonce: 1, qty: 70 }).reason, 'nonce_reused');
  assert.equal(one(m).links[0].qty, 60);
});

test('boundary: conflicting identity attestations, or an allocation for another world, are not used', () => {
  const m = newMemory();
  const p = promise(m, { bell: 100, due: 260 });
  allocate(m, { ref: p.accept, partition: 'p2', seq: 1, bell: 205 });
  placeAlias(m);
  caravanFacts(m, { dst: PLACE_A2, seq: 1, depart: 205, settle: 240 });
  assert.equal(one(m).state, 'fulfilled');
  // 4 (or a faulty index) also attests that B_p2 is C: two principals for one tag -> unknown again
  m.observe({ kind: 'identity_alias', bell: 206, source: { chain: 'index', sig: 'alias-conflict', ix: 0 }, data: { partition: 'p2', tag: tagIn('B', 'p2'), principal: 'C' } });
  assert.deepEqual(one(m).reasons, ['identity_unverified']);
  // a correctly signed allocation for another world is kept in the journal but never used here
  const m2 = newMemory();
  const p2 = promise(m2, { bell: 100, due: 260 });
  caravanFacts(m2, { depart: 150, settle: 230 });
  const other = signedAllocation({ by: 'B', commitment: p2.accept, caravan: cv(7), qty: 100, nonce: 1, bell: 150, visibility: dm('A', 'B'), world: { ...WORLD, world_id: 'another-world' } });
  assert.equal(m2.allocate(other).status, 'added', 'its signature is valid');
  assert.ok(m2.knowledge(A, 300).unusable.some(u => u.why === 'other_world'));
  assert.equal(one(m2).links.length, 0);
});

test('boundary: a sealed march and a private conversation from p1 stay private after the boundary', () => {
  const m = newMemory();
  const march = m.observe({ kind: 'march_sent', bell: 190, source: { sig: 'sealed-p1', ix: 0 }, visibility: dm('C'), data: { owner: 'C', host_id: 7, dest: { p: 4, q: 4 }, arrive_bell: 230 } });
  const talk = m.say({ speaker: 'C', bell: 195, visibility: dm('B', 'C'), text: 'meet me after the boundary' });
  for (const at of [199, 200, 300]) {
    const k = m.knowledge(A, at);
    assert.ok(!k.ids.has(march.id) && !k.ids.has(talk.id), `bell ${at}`);
  }
  assert.ok(m.knowledge(C, 300).ids.has(march.id));
  assert.ok(m.knowledge(B, 300).ids.has(talk.id));
});

test('boundary: a restart at the boundary gives the same state as no restart; re-delivered records are duplicates', () => {
  const build = (m, phase) => {
    if (phase !== 2) {
      const p = promise(m, { bell: 100, due: 260 });
      allocate(m, { ref: p.accept, bell: 150 });
      caravanFacts(m, { depart: 180, settle: null, eta: 230 });
      coverage(m, { from: 90, to: 199, bell: 199, caravans: [cv(7)] });
    }
    if (phase !== 1) {
      caravanFacts(m, { depart: 180, settle: 230 }); // 4 delivers the departure again (duplicate), then the settle
      coverage(m, { partition: 'p2', from: 200, to: 270, bell: 270 });
      placeAlias(m);
    }
  };
  const live = newMemory();
  build(live, 0);
  const dir = mkdtempSync(join(tmpdir(), 'm12cont-'));
  const path = join(dir, 'journal.jsonl');
  const first = newMemory({ path });
  build(first, 1);
  const h199 = stateHash(first, 199);
  const second = newMemory({ path }); // restart at the boundary
  assert.equal(stateHash(second, 199), h199);
  build(second, 2);
  assert.equal(stateHash(second, 300), stateHash(live, 300));
  assert.equal(second.journal.records().length, live.journal.records().length, 'no record twice');
  const c = one(second);
  assert.equal(c.state, 'fulfilled');
  assert.equal(c.delivered_min, 100);
  assert.equal(second.knowledge(A, 300).reliability.B.n_direct, 1, 'counted once');
});

test('boundary: facts of a partition 4 has not registered are kept, reported unusable, and used once registered', () => {
  const dir = mkdtempSync(join(tmpdir(), 'm12cont-'));
  const path = join(dir, 'journal.jsonl');
  const onlyP1 = { p1: PARTITIONS.p1 };
  const m = newMemory({ path, partitions: onlyP1 });
  const p = promise(m, { bell: 100, due: 260 });
  allocate(m, { ref: p.accept, partition: 'p2', seq: 1, bell: 205 });
  placeAlias(m);
  caravanFacts(m, { dst: PLACE_A2, seq: 1, depart: 205, settle: 240 });
  const k = m.knowledge(A, 300);
  assert.ok(k.unusable.length >= 5 && k.unusable.every(u => u.why.startsWith('partition_unregistered')));
  assert.equal(k.commitments[0].state, 'unconfirmed');
  const reopened = newMemory({ path }); // 4's registry now includes p2
  assert.equal(reopened.journal.records().length, m.journal.records().length);
  assert.equal(one(reopened).state, 'fulfilled');
});

test('boundary: a decision before the boundary is reassessed with p1 records observed after it', async () => {
  const m = newMemory();
  const p = promise(m, { bell: 100, due: 130 });
  allocate(m, { ref: p.accept, bell: 102 });
  const res = await m.choosePartner({ viewer: A, bell: 190, request: { ...REQUEST, need_by_bell: 340 }, candidates: world(), limits: LIMITS });
  caravanFacts(m, { obs: 230 }); // happened at 102..120 in p1, observed at 230 in p2
  const r = m.reassess(res.decision_id, 240);
  assert.equal(r.then_reproducible, true);
  assert.equal(r.reference_then, 'offer-C');
  assert.equal(r.reference_now, 'offer-B');
  assert.ok(r.late_arrivals.every(x => x.bell <= 190 && x.created_bell === 230));
});

// ---------------------------------------------------------------- legacy v3 journals
const LEGACY_DIR = new URL('../fixtures/legacy-v3/', import.meta.url);
const expectedV3 = JSON.parse(readFileSync(new URL('expected-v3.json', LEGACY_DIR), 'utf8'));
const openLegacy = (arm, opts = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'm12legacy-'));
  const path = join(dir, `${arm}.jsonl`);
  copyFileSync(new URL(`${arm}.jsonl`, LEGACY_DIR), path); // a copy: the fixture itself is never written
  return newMemory({ path, ...opts });
};

test('legacy: v3 journals load under v4, their signatures verify as written, and the verdicts are the same', () => {
  for (const [arm, exp] of Object.entries(expectedV3.expected)) {
    const m = openLegacy(arm);
    const raw = readFileSync(new URL(`${arm}.jsonl`, LEGACY_DIR), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l).record).filter(Boolean);
    assert.ok(raw.every(r => r.v === 3), `${arm}: the fixture is v3`);
    assert.equal(m.journal.sha256(), sha256hex(canonical(raw)), `${arm}: replayed as written, nothing rewritten`);
    const k = m.knowledge(A, 300);
    assert.deepEqual(k.unusable, [], arm);
    assert.deepEqual(k.commitments.map(c => ({ id: c.id, state: c.state, reasons: c.reasons, delivered_min: c.delivered_min })), exp.commitments, arm);
    assert.deepEqual(k.claims.map(c => ({ id: c.id, status: c.status, criterion: c.criterion })), exp.claims, arm);
    const rel = k.reliability.B;
    assert.deepEqual(rel ? { E: rel.E, r: rel.r, s: rel.s } : null, exp.reliability_B, arm);
    const d = m.journal.get(exp.decision_id);
    assert.equal(d.chosen, exp.choice, arm);
    assert.equal(d.input_sha256, exp.input_sha256, `${arm}: the decision and the input it was shown are kept`);
    assert.equal(d.input.contract, 'wylls.memory12.decision-input/v3', 'an old decision keeps its old input contract');
  }
});

test('legacy: v3 records are not trusted under a registry that does not match the season they were written in', () => {
  const m = openLegacy('not_sent', { partitions: { p1: { ...PARTITIONS.p1, season: 2 }, p2: PARTITIONS.p2 } });
  const c = one(m);
  assert.equal(c.state, 'unconfirmed');
  assert.ok(c.coverage_gaps.includes('legacy_world_not_the_registered_partition'));
  const wrong = openLegacy('kept', { partitions: { p1: { ...PARTITIONS.p1, season: 2 }, p2: PARTITIONS.p2 } });
  assert.ok(wrong.knowledge(A, 300).unusable.some(u => u.why === 'legacy_world_not_the_registered_partition'), 'its v3 allocation is not used either');
  assert.notEqual(one(wrong).state, 'fulfilled');
  const m2 = openLegacy('kept', { legacy: null });
  assert.ok(m2.knowledge(A, 300).unusable.some(u => u.why === 'legacy_partition_unregistered'));
});

test('legacy: a v3 promise is fulfilled by a v4 delivery in the next partition (migration path, no rewrite)', () => {
  const m = openLegacy('claim_no_record'); // v3: B promised 100 wood, claimed to have sent it, nothing on record
  const v3 = one(m);
  assert.equal(v3.state, 'unconfirmed');
  allocate(m, { ref: v3.id, partition: 'p2', seq: 1, bell: 205, nonce: 10 });
  placeAlias(m);
  caravanFacts(m, { dst: PLACE_A2, seq: 1, depart: 205, settle: 240 });
  const c = one(m);
  assert.equal(c.state, 'late', 'delivered after the v3 due bell: late, and on record');
  assert.ok(m.journal.records().filter(r => r.v === 3).length > 0 && m.journal.records().some(r => r.v === 4));
  const input = decisionInput({ k: m.knowledge(A, 300), request: REQUEST, candidates: world(), limits: LIMITS });
  assert.equal(input.contract, 'wylls.memory12.decision-input/v4');
});
