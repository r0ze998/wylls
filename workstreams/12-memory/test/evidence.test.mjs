// Workstream 12 regression tests: the evidence rules of the second review.
//   1 absence is not failure or a lie     2 explicit allocation only     3 DELIVERED is not the amount nor the recipient
//   4 happened vs observed               5 verified evidence vs unknowns, and what makes a claim false
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemory } from '../src/index.mjs';
import { CLAIM_CRITERIA, GRACE_BELLS } from '../src/fold.mjs';
import { A, LIMITS, PLACE_A, PUBLIC, REQUEST, SECOND_BELL, dm, promise, caravanFacts, allocate, world } from '../fixtures/scenario.mjs';
import { newMemory, coverage, WORLD, KEYS, signedAllocation, allocateOp, cv, alias } from '../fixtures/scenario.mjs';

const cov = (m, o = {}) => coverage(m, o).id;
const state = (m, at = 300, opts) => m.knowledge(A, at, opts).commitments.map(c => c.state);
const PLACE_A_GEN2 = { ...PLACE_A, gen: 2 };

// ---------------------------------------------------------------- 1. absence
test('absence: no record at all is unconfirmed, never not-delivered, and does not lower reliability', () => {
  const m = newMemory();
  promise(m);
  const k = m.knowledge(A, 300);
  assert.equal(k.commitments[0].state, 'unconfirmed');
  assert.deepEqual(k.commitments[0].reasons, ['no_record_found']);
  assert.equal(k.reliability.B.E, 0.5);
  assert.equal(k.reliability.B.unresolved.length, 1);
});

test('absence: a failed lookup and a gap in the index are unknown; only a complete index verifies a shortfall', () => {
  const m = newMemory();
  promise(m);
  alias(m, 'B'); // whose tag B_p1 is (4's attestation); without it the failure could not be attributed to B
  m.observe({ kind: 'lookup_failed', bell: 140, source: { chain: 'index', sig: 'lf', ix: 0 }, data: { query: 'coverage', partition: 'p1', sender: 'B_p1', reason: 'indexer behind' } });
  assert.deepEqual(m.knowledge(A, 300).commitments[0].reasons, ['lookup_failed']);
  cov(m, { from: 90, to: 110 }); cov(m, { from: 115, to: 140 }); // a hole at 111..114
  assert.equal(state(m)[0], 'unconfirmed');
  cov(m, { from: 111, to: 114, bell: 141 });
  assert.equal(state(m)[0], 'not_sent', 'contiguous coverage closes the window');
});

test('absence: in transit, past arrival without a settle, and a departure the index lists without its record are unknown', () => {
  const m = newMemory();
  const p = promise(m, { due: 200 });
  allocate(m, { ref: p.accept });
  caravanFacts(m, { settle: null, depart: 150, eta: 160 });
  m.observe({ kind: 'caravan_sent', bell: 150, source: { sig: 'eta', ix: 1 }, data: { caravan: cv(8, 'B'), dst: PLACE_A, cargo: { wood: 100 }, eta_bell: 260 } });
  allocate(m, { ref: p.accept, seq: 8, qty: 100, bell: 151 }); // over-allocation by the debtor: B#8 has its own capacity
  const k = m.knowledge(A, 180);
  assert.equal(k.commitments[0].state, 'in_progress');
  assert.deepEqual(k.commitments[0].links.map(l => l.state), ['settle_unobserved', 'in_transit']);
  assert.equal(m.knowledge(A, 300).commitments[0].state, 'unconfirmed');
  // the index lists a caravan of B whose departure record we do not have
  const m2 = newMemory();
  promise(m2);
  cov(m2, { caravans: [cv(3, 'B')] });
  assert.deepEqual(m2.knowledge(A, 300).commitments[0].reasons, ['coverage_caravan_unresolved']);
});

test('absence: "sent" and "delivered" are different claims and neither is a fact', () => {
  const m = newMemory();
  const p = promise(m);
  allocate(m, { ref: p.accept });
  caravanFacts(m, { settle: 140, depart: 110 });
  const sent = m.say({ speaker: 'B', bell: 112, visibility: dm('A', 'B'), act: { type: 'claim_sent', ref: p.accept, caravan: cv(7, 'B') } }).id;
  const got = m.say({ speaker: 'B', bell: 113, visibility: dm('A', 'B'), act: { type: 'claim_delivered', ref: p.accept, caravan: cv(7, 'B') } }).id;
  const claims = Object.fromEntries(m.knowledge(A, 120).claims.map(c => [c.id, c.status]));
  assert.equal(claims[sent], 'consistent');
  assert.equal(claims[got], 'unverified', 'not settled yet when looked at');
  const later = Object.fromEntries(m.knowledge(A, 300).claims.map(c => [c.id, c]));
  assert.equal(later[got].status, 'mismatch');
  assert.equal(later[got].criterion, 'premature', 'settled after the claim: shown, not counted as a lie');
  assert.equal(m.knowledge(A, 300).reliability.B.claims.contradicted, 0);
});

// ---------------------------------------------------------------- 5. what makes a claim false
test('a claim is false only by a stated criterion; mismatches are shown and not counted', () => {
  const run = (setup, act) => {
    const m = newMemory();
    const p = promise(m);
    setup(m, p);
    m.say({ speaker: 'B', bell: 125, visibility: dm('A', 'B'), act: { type: 'claim_sent', ref: p.accept, ...act } });
    const k = m.knowledge(A, 300);
    return { claim: k.claims[0], rel: k.reliability.B };
  };
  // named caravan absent from a complete index
  let r = run(m => cov(m), { caravan: cv(9, 'B') });
  assert.deepEqual([r.claim.status, r.claim.criterion], ['contradicted', 'caravan_absent_in_complete_index']);
  assert.ok(r.claim.basis.length && r.rel.evidence.find(e => e.kind === 'false_claim').rule === CLAIM_CRITERIA.caravan_absent_in_complete_index);
  // no index: unverified, nothing counted
  r = run(() => {}, { caravan: cv(9, 'B') });
  assert.equal(r.claim.status, 'unverified');
  assert.equal(r.rel.s, 0);
  // someone else's caravan / a caravan to another place or generation: mismatch
  r = run(m => alias(m, 'C'), { caravan: cv(1, 'C') });
  assert.deepEqual([r.claim.status, r.claim.criterion], ['mismatch', 'caravan_of_another']);
  r = run(m => caravanFacts(m, { dst: PLACE_A_GEN2 }), { caravan: cv(7, 'B') });
  assert.deepEqual([r.claim.status, r.claim.criterion], ['mismatch', 'caravan_to_other_place']);
  assert.equal(r.rel.claims.contradicted, 0);
  assert.ok(!r.rel.evidence.some(e => e.kind === 'false_claim'));
});

// ---------------------------------------------------------------- 2. explicit allocation
test('allocation: a caravan nobody allocated is not paired by guesswork', () => {
  const m = newMemory();
  promise(m);
  caravanFacts(m);
  cov(m, { caravans: [cv(7, 'B')] });
  const k = m.knowledge(A, 300);
  assert.equal(k.commitments[0].state, 'unconfirmed');
  assert.deepEqual(k.commitments[0].reasons, ['unassigned_caravan']);
  assert.equal(k.unassigned.length, 1);
  assert.equal(k.reliability.B.E, 0.5);
});

test('allocation: parallel promises with the same partner, each with its own caravan', () => {
  const m = newMemory();
  const p1 = promise(m, { bell: 100, due: 130 });
  const p2 = promise(m, { bell: 102, due: 130 });
  allocate(m, { ref: p2.accept, seq: 8, bell: 104 });
  allocate(m, { ref: p1.accept, seq: 7, bell: 105 });
  caravanFacts(m, { seq: 7 });
  caravanFacts(m, { seq: 8, settle: 200 });
  const k = m.knowledge(A, 300);
  const by = Object.fromEntries(k.commitments.map(c => [c.id, c.state]));
  assert.equal(by[p1.accept], 'fulfilled');
  assert.equal(by[p2.accept], 'late', 'B#8 settled after the due bell: its own promise is late, not the other');
});

test('allocation: one caravan split over two promises, and never the same quantity twice', () => {
  const m = newMemory();
  const p1 = promise(m, { qty: 50 });
  const p2 = promise(m, { bell: 102, qty: 50 });
  allocate(m, { ref: p1.accept, qty: 50, bell: 104 });
  allocate(m, { ref: p2.accept, qty: 50, bell: 105 });
  caravanFacts(m, { cargo: { wood: 100 } });
  assert.deepEqual(state(m), ['fulfilled', 'fulfilled']);
  // a third promise allocated to the same caravan exceeds its capacity: refused, not double-counted
  const p3 = promise(m, { bell: 106, qty: 50 });
  allocate(m, { ref: p3.accept, qty: 50, by: 'A', bell: 107 });
  const k = m.knowledge(A, 300);
  const c3 = k.commitments.find(c => c.id === p3.accept);
  assert.equal(c3.links[0].state, 'over_allocated');
  assert.notEqual(c3.state, 'fulfilled');
  const total = k.commitments.reduce((s, c) => s + c.delivered_min, 0);
  assert.equal(total, 100, 'never more than the caravan carried');
});

test('allocation: a short credit shared by two allocations gives bounds, not a guessed split', () => {
  const m = newMemory();
  const p1 = promise(m, { qty: 50 });
  const p2 = promise(m, { bell: 102, qty: 50 });
  allocate(m, { ref: p1.accept, qty: 50, bell: 104 });
  allocate(m, { ref: p2.accept, qty: 50, bell: 105 });
  caravanFacts(m, { cargo: { wood: 100 }, credited: { wood: 80 } });
  cov(m, { caravans: [cv(7, 'B')] });
  const k = m.knowledge(A, 300);
  for (const c of k.commitments) {
    assert.equal(c.state, 'unconfirmed');
    assert.deepEqual(c.reasons, ['qty_split_ambiguous']);
    assert.deepEqual([c.delivered_min, c.delivered_max], [30, 50]);
  }
  assert.equal(k.reliability.B.E, 0.5);
});

test('allocation: a third party cannot allocate, and a party disagreement takes the smaller quantity', () => {
  const m = newMemory();
  const p = promise(m);
  allocate(m, { by: 'C', ref: p.accept, vis: PUBLIC });
  caravanFacts(m);
  assert.equal(m.knowledge(A, 300).commitments[0].links[0].state, 'not_a_party');
  const m2 = newMemory();
  const p2 = promise(m2);
  allocate(m2, { ref: p2.accept, qty: 100 });
  allocate(m2, { by: 'A', ref: p2.accept, qty: 60, bell: 121 });
  caravanFacts(m2);
  cov(m2, { caravans: [cv(7, 'B')] });
  const c = m2.knowledge(A, 300).commitments[0];
  assert.equal(c.links[0].disputed, true);
  assert.equal(c.links[0].qty, 60);
  assert.equal(c.state, 'partial');
});

// ---------------------------------------------------------------- 3. quantity and recipient
test('quantity: DELIVERED without a measured credit is unverified; the settle record is not the credited amount', () => {
  const m = newMemory();
  const p = promise(m);
  allocate(m, { ref: p.accept });
  caravanFacts(m, { credited: null });
  let c = m.knowledge(A, 300).commitments[0];
  assert.equal(c.state, 'unconfirmed');
  assert.deepEqual(c.reasons, ['qty_unverified']);
  assert.deepEqual([c.delivered_min, c.delivered_max], [0, 100]);
  // the storehouse took 60 of the 100 recorded (e.g. capacity): partial only once the index rules out more
  m.observe({ kind: 'caravan_credited', bell: 120, created_bell: 150, source: { sig: 'credit-late', ix: 0 },
    data: { caravan: cv(7, 'B'), place: PLACE_A, credited: { wood: 60 }, unit: 'whole_units', basis: 'exec_record', exec: { sig: 'settle-B7', ix: 0 } } });
  c = m.knowledge(A, 300).commitments[0];
  assert.equal(c.state, 'unconfirmed', 'the rest may still come');
  cov(m, { caravans: [cv(7, 'B')] });
  c = m.knowledge(A, 300).commitments[0];
  assert.equal(c.state, 'partial');
  assert.equal(c.delivered_min, 60);
  assert.ok(Math.abs(m.knowledge(A, 300).reliability.B.r / m.knowledge(A, 300).reliability.B.s - 60 / 40) < 1e-6);
});

test('quantity: a partial delivery before the index is complete stays open for the rest', () => {
  const m = newMemory();
  const p = promise(m);
  allocate(m, { ref: p.accept, qty: 40 });
  caravanFacts(m, { cargo: { wood: 40 }, credited: { wood: 40 } });
  let c = m.knowledge(A, 300).commitments[0];
  assert.equal(c.state, 'unconfirmed');
  assert.equal(c.delivered_min, 40);
  cov(m, { caravans: [cv(7, 'B')] });
  c = m.knowledge(A, 300).commitments[0];
  assert.equal(c.state, 'partial');
});

test('recipient: the owner AT THE SETTLE BELL decides, not the current owner; unknown owner is unknown', () => {
  const ownedBy = (m, owner, from, to, sig) => m.observe({ kind: 'place_owner', bell: to ?? 300, source: { chain: 'index', sig, ix: 0 },
    data: { place: PLACE_A, owner, from_bell: from, to_bell: to } });
  // A held the place at 120; D holds it now: still fulfilled
  let m = newMemory();
  let p = promise(m);
  allocate(m, { ref: p.accept });
  caravanFacts(m, { owner: null });
  ownedBy(m, 'A', 0, 150, 'own-a'); ownedBy(m, 'D', 151, null, 'own-d');
  assert.equal(state(m)[0], 'fulfilled');
  // D held it at 120: delivered, but not to the creditor -> neutral
  m = newMemory();
  p = promise(m);
  allocate(m, { ref: p.accept });
  caravanFacts(m, { owner: null });
  ownedBy(m, 'A', 0, 110, 'own-a'); ownedBy(m, 'D', 111, null, 'own-d');
  const k = m.knowledge(A, 300);
  assert.equal(k.commitments[0].state, 'recipient_changed');
  assert.equal(k.commitments[0].links[0].owner_at_settle, 'D');
  assert.equal(k.reliability.B.E, 0.5);
  // only an attestation for an interval before the settle: unknown
  m = newMemory();
  p = promise(m);
  allocate(m, { ref: p.accept });
  caravanFacts(m, { owner: null });
  ownedBy(m, 'A', 0, 100, 'own-a');
  assert.deepEqual(m.knowledge(A, 300).commitments[0].reasons, ['recipient_unverified']);
});

test('recipient: a place of another generation is a different place (misdirected), not the promised one', () => {
  const m = newMemory();
  const p = promise(m);
  allocate(m, { ref: p.accept });
  caravanFacts(m, { dst: PLACE_A_GEN2 });
  assert.equal(m.knowledge(A, 300).commitments[0].links[0].state, 'misdirected');
  assert.equal(state(m)[0], 'unconfirmed', 'without an index, perhaps another caravan is coming');
  cov(m, { caravans: [cv(7, 'B')] });
  assert.equal(state(m)[0], 'not_sent');
  assert.equal(m.knowledge(A, 300).reliability.B.claims.contradicted, 0, 'a wrong delivery is not a lie');
});

// ---------------------------------------------------------------- 4. happened vs observed
test('time: an on-time delivery observed late is on time, not late; before it is observed it is unknown', () => {
  const m = newMemory();
  const p = promise(m);
  allocate(m, { ref: p.accept });
  caravanFacts(m, { obs: 250 });
  assert.equal(m.knowledge(A, 200).commitments[0].state, 'unconfirmed');
  assert.equal(m.knowledge(A, 200).reliability.B.E, 0.5);
  const c = m.knowledge(A, 260).commitments[0];
  assert.equal(c.state, 'fulfilled');
  assert.equal(c.links[0].on_time, true);
  // a truly late settle is late
  const m2 = newMemory();
  const p2 = promise(m2);
  allocate(m2, { ref: p2.accept });
  caravanFacts(m2, { settle: 130 + GRACE_BELLS + 1 });
  assert.equal(state(m2)[0], 'late');
});

test('time: a decision taken before evidence arrived can be reassessed; the original decision is kept', async () => {
  const m = newMemory();
  const p = promise(m);
  allocate(m, { ref: p.accept });
  const res = await m.choosePartner({ viewer: A, bell: SECOND_BELL, request: REQUEST, candidates: world(), limits: LIMITS });
  assert.equal(res.answer.choice, 'offer-C');
  caravanFacts(m, { obs: 310 });
  const r = m.reassess(res.decision_id, 320);
  assert.equal(r.reference_then, 'offer-C');
  assert.equal(r.reference_now, 'offer-B');
  assert.equal(r.would_differ, true);
  assert.deepEqual(r.changed_commitments.map(c => [c.then, c.now]), [['unconfirmed', 'fulfilled']]);
  assert.ok(r.late_arrivals.every(f => f.created_bell === 310 && f.bell <= 120));
  assert.equal(m.journal.get(res.decision_id).chosen, 'offer-C', 'the record of what was decided is not rewritten');
  assert.equal(m.reassess(res.decision_id, 305).would_differ, false, 'nothing new by 305');
});

test('time: a wrong index attestation rolled back restores the previous judgement and the decision recovers', async () => {
  const m = newMemory();
  const p = promise(m);
  allocate(m, { ref: p.accept });
  const bad = cov(m, { caravans: [] }); // the index said B sent nothing (wrong: its own departure record was missing)
  // with an allocated caravan unknown, the commitment stays unconfirmed even with this coverage
  assert.equal(state(m)[0], 'unconfirmed');
  const m2 = newMemory();
  const p2 = promise(m2);
  const bad2 = cov(m2, { caravans: [] });
  m2.say({ speaker: 'B', bell: 125, visibility: dm('A', 'B'), act: { type: 'claim_sent', ref: p2.accept } });
  assert.equal(m2.knowledge(A, 300).commitments[0].state, 'not_sent');
  assert.equal(m2.knowledge(A, 300).reliability.B.claims.contradicted, 1);
  const d = await m2.choosePartner({ viewer: A, bell: SECOND_BELL, request: REQUEST, candidates: world(), limits: LIMITS });
  m2.observe({ kind: 'rollback', bell: 140, created_bell: 305, source: { chain: 'index', sig: 'rb-cov', ix: 0 }, data: { fact: bad2, reason: 'index rebuilt' } });
  allocate(m2, { ref: p2.accept, bell: 306 }); // B names its caravan after the decision
  caravanFacts(m2, { obs: 305 });
  const k = m2.knowledge(A, 310);
  assert.equal(k.commitments[0].state, 'fulfilled');
  assert.equal(k.reliability.B.claims.contradicted, 0, 'the false-claim verdict is withdrawn with its basis');
  assert.equal(k.reliability.B.claims.unverified, 1, 'a claim naming no caravan needs a complete index to be checked');
  const r = m2.reassess(d.decision_id, 310);
  // judged at the decision bell with what is observed now: no longer a verified failure (the allocation came later)
  assert.deepEqual(r.changed_commitments.map(c => [c.then, c.now]), [['not_sent', 'unconfirmed']]);
  assert.equal(r.terms_now['offer-B'].E, 0.5);
  assert.ok(r.terms_then['offer-B'].E < 0.5);
  assert.ok(bad);
});
