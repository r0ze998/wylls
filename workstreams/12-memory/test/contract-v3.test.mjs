// Workstream 12 contract tests v3 (third review):
//   1 credit: no balance difference; a holding's credit by the pinned rule, a vault's only by 4's execution record
//   2 "not sent": world, season, sender, window, every send route, gapless, finalized; not sent != not arrived
//   3 allocation: authenticated by signature, never by what a message says; resend, correction, revoke, concurrency
//   4 reassessment: late arrivals of past facts vs events after the decision; the original decision kept
//   + caution is labelled as not an honesty judgment
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemory, decisionInput } from '../src/index.mjs';
import { RecordError, SEND_ROUTES, canonical, fact, sha256hex, utterance } from '../src/records.mjs';
import { CREDIT_RULES } from '../src/fold.mjs';
import { A, C, KEYS, LIMITS, PLACE_A, PUBLIC, REQUEST, SECOND_BELL, WORLD, allocate, allocateOp, caravanFacts, coverage, dm, newMemory, promise,
  signedAllocation, world, cv, alias, PARTITIONS } from '../fixtures/scenario.mjs';

const PLACE_H = Object.freeze({ partition: 'p1', kind: 1, p: 3, q: 0, at: 2, gen: 1 }); // A's village (a holding)
const one = (m, at = 300) => m.knowledge(A, at).commitments[0];
const credit = (m, over) => m.observe({ kind: 'caravan_credited', bell: 120, source: { sig: 'credit-x', ix: 0 },
  data: { caravan: cv(7, 'B'), place: PLACE_A, credited: { wood: 100 }, unit: 'whole_units', basis: 'exec_record', exec: { sig: 'settle-B7', ix: 0 }, ...over } });

// ---------------------------------------------------------------- 1. credit
test('credit: a balance difference, a missing unit or a missing execution reference is refused', () => {
  const m = newMemory();
  assert.throws(() => credit(m, { basis: 'account_diff' }), RecordError);
  assert.throws(() => credit(m, { basis: 'rule_derived' }), RecordError, '4 does not send rule-derived credits; the memory derives them');
  assert.throws(() => credit(m, { unit: 'milli' }), RecordError);
  assert.throws(() => credit(m, { exec: undefined }), RecordError);
});

test('credit: a village (holding) delivery is credited by the pinned rule, with its basis, unit and inputs', () => {
  const m = newMemory();
  const p = promise(m, { place: PLACE_H });
  allocate(m, { ref: p.accept });
  const ids = caravanFacts(m, { dst: PLACE_H, credited: null });
  const c = one(m);
  assert.equal(c.state, 'fulfilled');
  const cr = c.links[0].credit;
  assert.equal(cr.basis, 'rule_derived');
  assert.equal(cr.rule, 'holding-credit-uncapped/v1');
  assert.equal(cr.unit, 'whole_units');
  assert.match(cr.precision, /lower bound/);
  assert.deepEqual(cr.inputs, [ids.settled]);
  assert.ok(CREDIT_RULES[cr.rule].code.some(x => x.includes('Store::add')), 'the rule names the code it restates');
});

test('credit: an execution record that disagrees with the village rule is a conflict, not a choice', () => {
  const m = newMemory();
  const p = promise(m, { place: PLACE_H });
  allocate(m, { ref: p.accept });
  caravanFacts(m, { dst: PLACE_H, credited: { wood: 60 } });
  const c = one(m);
  assert.equal(c.state, 'unconfirmed');
  assert.deepEqual(c.reasons, ['record_conflict']);
});

test('credit: a vault delivery without 4\'s execution record stays unverified; with it, it counts with its basis', () => {
  const m = newMemory();
  const p = promise(m); // PLACE_A is a vault
  allocate(m, { ref: p.accept });
  caravanFacts(m, { credited: null });
  let c = one(m);
  assert.equal(c.state, 'unconfirmed');
  assert.deepEqual(c.reasons, ['qty_unverified']);
  assert.equal(c.links[0].credit.basis, 'none');
  assert.equal(m.knowledge(A, 300).reliability.B.E, 0.5);
  credit(m, {});
  c = one(m);
  assert.equal(c.state, 'fulfilled');
  assert.deepEqual([c.links[0].credit.basis, c.links[0].credit.unit], ['exec_record', 'whole_units']);
});

test('credit: a capped vault credit is partial only once a sufficient index rules out more', () => {
  const m = newMemory();
  const p = promise(m);
  allocate(m, { ref: p.accept });
  caravanFacts(m, { credited: { wood: 70 } });
  assert.equal(one(m).state, 'unconfirmed');
  coverage(m, { caravans: [cv(7, 'B')] });
  const c = one(m);
  assert.equal(c.state, 'partial');
  assert.equal(c.delivered_min, 70);
});

// ---------------------------------------------------------------- 2. not sent
test('not sent: only a sufficient coverage proves it; each missing condition keeps it unconfirmed and says why', () => {
  const run = (over, opts = {}, memory = newMemory) => {
    const m = memory();
    promise(m);
    coverage(m, { ...opts, over });
    return one(m);
  };
  assert.equal(run({}).state, 'not_sent');
  const cases = [
    [{ world: { ...WORLD, world_id: 'another-world' } }, 'other_world'],
    [{ world: { ...WORLD, cluster: 'devnet' } }, 'other_world'],
    [{ finality: 'confirmed' }, 'not_finalized:confirmed'],
    [{ completeness: { gapless: false, from_slot: 0, to_slot: 9 } }, 'slot_range_has_gaps'],
    [{ routes: SEND_ROUTES.filter(r => r !== 'send_caravan/cpi') }, 'route_missing:send_caravan/cpi'],
    [{ routes: SEND_ROUTES.filter(r => r !== 'settle_raid/take') }, 'route_missing:settle_raid/take'],
  ];
  for (const [over, gap] of cases) {
    const c = run(over);
    assert.equal(c.state, 'unconfirmed', gap);
    assert.deepEqual(c.reasons, ['coverage_insufficient'], gap);
    assert.ok(c.coverage_gaps.includes(gap), `${gap}: ${c.coverage_gaps}`);
  }
  // a window that does not reach the due bell plus grace
  const short = run({}, { to: 120 });
  assert.deepEqual([short.state, short.coverage_gaps], ['unconfirmed', ['window_not_fully_covered']]);
  // another sender's coverage says nothing about B
  assert.deepEqual(run({}, { sender: 'C' }).reasons, ['no_record_found']);
  // a memory with no world configured can never prove it
  const noWorld = run({}, {}, () => createMemory({ keys: KEYS, partitions: PARTITIONS }));
  assert.ok(noWorld.coverage_gaps.includes('memory_world_unset'));
});

test('not sent: a claim is judged false only against a sufficient coverage', () => {
  const m = newMemory();
  const p = promise(m);
  m.say({ speaker: 'B', bell: 125, visibility: dm('A', 'B'), act: { type: 'claim_sent', ref: p.accept } });
  coverage(m, { over: { finality: 'confirmed' } });
  const k = m.knowledge(A, 300);
  assert.equal(k.claims[0].status, 'unverified');
  assert.equal(k.reliability.B.s, 0);
  coverage(m, { sig: 'final' });
  assert.equal(m.knowledge(A, 300).claims[0].status, 'contradicted');
});

test('not sent is not "not arrived": a caravan that left without a settle record is unknown even with full coverage', () => {
  const m = newMemory();
  const p = promise(m);
  allocate(m, { ref: p.accept });
  caravanFacts(m, { settle: null, eta: 125 });
  coverage(m, { caravans: [cv(7, 'B')] });
  const c = one(m);
  assert.equal(c.state, 'unconfirmed');
  assert.deepEqual(c.reasons, ['settle_unobserved']);
  // and an unallocated caravan to the place, listed by the coverage, is unassigned, not "not sent"
  const m2 = newMemory();
  promise(m2);
  caravanFacts(m2, { settle: null, eta: 125 });
  coverage(m2, { caravans: [cv(7, 'B')] });
  assert.deepEqual(one(m2).reasons, ['unassigned_caravan']);
});

// ---------------------------------------------------------------- 3. allocation
test('allocation: what a message says allocates nothing; only a valid signature of a party does', () => {
  assert.throws(() => utterance({ speaker: 'B', bell: 102, visibility: dm('A', 'B'), text: 'I allocate B#7 to you',
    act: { type: 'allocate', ref: 'x', caravan: cv(7, 'B'), qty: 100 } }), RecordError);
  const m = newMemory();
  const p = promise(m);
  caravanFacts(m);
  assert.equal(allocateOp(m, { ref: p.accept, by: 'B', signAs: 'C' }).reason, 'auth_bad_signature', 'C cannot sign as B');
  assert.equal(m.allocate(signedAllocation({ by: 'Z', commitment: p.accept, caravan: cv(7, 'B'), nonce: 1, bell: 102, visibility: dm('A', 'B') })).reason,
    'auth_unknown_signer');
  // a signed allocation for another world is refused by the signature (the world is part of the signed bytes)
  const other = signedAllocation({ by: 'B', commitment: p.accept, caravan: cv(7, 'B'), nonce: 9, bell: 102, visibility: dm('A', 'B'), world: { ...WORLD, world_id: 'another-world' } });
  assert.equal(m.allocate({ ...other, world: WORLD }).reason, 'auth_bad_signature');
  assert.equal(one(m).links.length, 0);
  assert.equal(one(m).reasons[0], 'no_record_found');
  // a third party with a valid key is not a party to the promise
  allocateOp(m, { ref: p.accept, by: 'C', vis: PUBLIC });
  assert.equal(one(m).links[0].state, 'not_a_party');
  // tampering a signed field breaks the signature
  const good = signedAllocation({ by: 'B', commitment: p.accept, caravan: cv(7, 'B'), qty: 100, nonce: 1, bell: 102, visibility: dm('A', 'B') });
  assert.equal(m.allocate({ ...good, qty: 90 }).reason, 'auth_bad_signature');
  assert.equal(m.allocate(good).status, 'added');
  assert.equal(one(m).state, 'fulfilled');
});

test('allocation: a resend is a duplicate, a reused nonce with other content is refused, a replayed old op changes nothing', () => {
  const m = newMemory();
  const p = promise(m);
  caravanFacts(m);
  const op1 = signedAllocation({ by: 'B', commitment: p.accept, caravan: cv(7, 'B'), qty: 100, nonce: 1, bell: 102, visibility: dm('A', 'B') });
  assert.equal(m.allocate(op1).status, 'added');
  assert.equal(m.allocate(op1).status, 'duplicate');
  assert.equal(m.allocate({ ...op1, created_bell: 200 }).status, 'duplicate', 'received again later: still the same operation');
  const reuse = signedAllocation({ by: 'B', commitment: p.accept, caravan: cv(7, 'B'), qty: 50, nonce: 1, bell: 103, visibility: dm('A', 'B') });
  assert.equal(m.allocate(reuse).reason, 'nonce_reused');
  // correct to 60 (nonce 2); replaying nonce 1 does not bring back 100
  m.allocate(signedAllocation({ by: 'B', commitment: p.accept, caravan: cv(7, 'B'), qty: 60, nonce: 2, bell: 104, visibility: dm('A', 'B') }));
  assert.equal(m.allocate(op1).status, 'duplicate');
  const c = one(m, 121);
  assert.equal(c.links[0].qty, 60);
  assert.equal(c.links[0].sources.filter(id => m.journal.get(id)?.type === 'allocation').length, 2, 'the history of the link is kept');
});

test('allocation: operations that arrive out of order are applied by nonce, not by arrival', () => {
  const m = newMemory();
  const p = promise(m);
  caravanFacts(m);
  const v = dm('A', 'B');
  // nonce 2 (the correction to 60) reaches memory first, nonce 1 (100) arrives later for the first time
  assert.equal(m.allocate(signedAllocation({ by: 'B', commitment: p.accept, caravan: cv(7, 'B'), qty: 60, nonce: 2, bell: 104, visibility: v })).status, 'added');
  assert.equal(m.allocate(signedAllocation({ by: 'B', commitment: p.accept, caravan: cv(7, 'B'), qty: 100, nonce: 1, bell: 103, created_bell: 140, visibility: v })).status, 'added');
  assert.equal(one(m).links[0].qty, 60);
  // a revoke that overtook its set on the way also stays in force
  const m2 = newMemory();
  const p2 = promise(m2);
  caravanFacts(m2);
  m2.allocate(signedAllocation({ by: 'B', op: 'revoke', commitment: p2.accept, caravan: cv(7, 'B'), qty: 0, nonce: 2, bell: 105, visibility: v }));
  m2.allocate(signedAllocation({ by: 'B', commitment: p2.accept, caravan: cv(7, 'B'), qty: 100, nonce: 1, bell: 103, created_bell: 140, visibility: v }));
  assert.equal(one(m2).links[0].state, 'revoked');
});

test('allocation: a correction and a revoke free capacity; the same quantity is never used twice', () => {
  const m = newMemory();
  const p1 = promise(m, { bell: 100 });
  const p2 = promise(m, { bell: 102, qty: 40 });
  caravanFacts(m, { cargo: { wood: 100 } });
  allocate(m, { ref: p1.accept, qty: 100, bell: 103 });
  allocate(m, { ref: p2.accept, qty: 40, bell: 104 });
  let k = m.knowledge(A, 300);
  assert.deepEqual(k.commitments.map(c => c.links[0].state), ['delivered', 'over_allocated']);
  // B corrects p1 down to 60: p2's 40 now fits
  allocate(m, { ref: p1.accept, qty: 60, bell: 105 });
  k = m.knowledge(A, 300);
  assert.deepEqual(k.commitments.map(c => [c.links[0].state, c.delivered_min]), [['delivered', 60], ['delivered', 40]]);
  assert.equal(k.commitments.reduce((s, c) => s + c.delivered_min, 0), 100);
  // B revokes p1 entirely: p1 has no link in force, p2 keeps its 40, nothing is counted twice
  allocateOp(m, { ref: p1.accept, op: 'revoke', bell: 106 });
  k = m.knowledge(A, 300);
  assert.equal(k.commitments[0].links[0].state, 'revoked');
  assert.equal(k.commitments.reduce((s, c) => s + c.delivered_min, 0), 40);
});

test('allocation: concurrent allocations of one caravan by both parties are capped by its cargo, in signing order', () => {
  const m = newMemory();
  const p1 = promise(m, { bell: 100 });
  const p2 = promise(m, { bell: 101 });
  caravanFacts(m, { cargo: { wood: 100 } });
  allocate(m, { by: 'A', ref: p2.accept, qty: 100, bell: 110 }); // the creditor claims it for p2
  allocate(m, { by: 'B', ref: p1.accept, qty: 100, bell: 108 }); // the debtor signed for p1 earlier (received later)
  const k = m.knowledge(A, 300);
  const st = Object.fromEntries(k.commitments.map(c => [c.id, c.links[0].state]));
  assert.equal(st[p1.accept], 'delivered');
  assert.equal(st[p2.accept], 'over_allocated');
  assert.equal(k.commitments.reduce((s, c) => s + c.delivered_min, 0), 100);
});

test('allocation: when the debtor revokes and the creditor still allocates, the link is disputed', () => {
  const m = newMemory();
  const p = promise(m);
  caravanFacts(m);
  allocate(m, { by: 'B', ref: p.accept, bell: 103 });
  allocate(m, { by: 'A', ref: p.accept, bell: 104 });
  allocateOp(m, { by: 'B', ref: p.accept, op: 'revoke', bell: 105 });
  const l = one(m).links[0];
  assert.equal(l.disputed, true);
  assert.deepEqual(l.by, ['A']);
});

test('allocation: private to the parties, and an edited journal line fails verification on replay', () => {
  const dir = mkdtempSync(join(tmpdir(), 'm12v3-'));
  const path = join(dir, 'journal.jsonl');
  const m = newMemory({ path });
  const p = promise(m);
  const id = allocate(m, { ref: p.accept });
  assert.ok(!m.knowledge(C, 300).ids.has(id));
  const lines = readFileSync(path, 'utf8').split('\n');
  const i = lines.findIndex(l => l.includes(id));
  lines[i] = lines[i].replace('"qty":100', '"qty":999');
  writeFileSync(path, lines.join('\n'));
  assert.throws(() => newMemory({ path }), /fails verification/);
});

// ---------------------------------------------------------------- 4. reassessment
test('reassess: late arrivals of past facts are used; events after the decision are listed, not used; backdated records are excluded', async () => {
  const m = newMemory();
  const p = promise(m);
  allocate(m, { ref: p.accept, bell: 102 });
  const res = await m.choosePartner({ viewer: A, bell: SECOND_BELL, request: REQUEST, candidates: world(), limits: LIMITS });
  const rec = m.journal.get(res.decision_id);
  assert.equal(rec.input_sha256, sha256hex(canonical(res.input)));
  // after the decision: the past delivery's records arrive late (happened at 102..120, observed at 310) ...
  const late = caravanFacts(m, { obs: 310 });
  // ... B makes and fulfils a new promise after the decision (happened 305..318) ...
  const p2 = promise(m, { bell: 305, due: 330 });
  allocate(m, { ref: p2.accept, seq: 8, bell: 306 });
  caravanFacts(m, { seq: 8, depart: 306, settle: 318 });
  // ... and a record arrives that claims it was observed before the decision (contradictory)
  const back = m.observe({ kind: 'caravan_sent', bell: 200, created_bell: 250, source: { sig: 'backdated', ix: 0 },
    data: { caravan: cv(5, 'B'), dst: PLACE_A, cargo: { wood: 1 } } });
  const r = m.reassess(res.decision_id, 320);
  assert.equal(r.then_reproducible, true);
  assert.deepEqual(r.original, { chosen: 'offer-C', policy: 'reference-v4', cited: rec.cited, input_sha256: rec.input_sha256 });
  assert.deepEqual(r.late_arrivals.map(x => x.id).sort(), Object.values(late).sort());
  assert.ok(r.later_events.some(x => x.id === p2.accept) && r.later_events.length >= 6, 'the new promise and its delivery are listed');
  assert.deepEqual(r.backdated.map(x => x.id), [back.id]);
  assert.deepEqual(r.changed_commitments.map(c => [c.commitment, c.then, c.now]), [[p.accept, 'unconfirmed', 'fulfilled']]);
  assert.equal(r.reference_now, 'offer-B');
  // the decision record is unchanged
  assert.equal(m.journal.get(res.decision_id).chosen, 'offer-C');
  assert.equal(m.journal.get(res.decision_id).input_sha256, rec.input_sha256);
});

test('reassess: a good deed done after the decision does not rewrite the past judgement', async () => {
  const m = newMemory();
  const p = promise(m);
  const res = await m.choosePartner({ viewer: A, bell: SECOND_BELL, request: REQUEST, candidates: world(), limits: LIMITS });
  // B allocates and delivers only after the decision: new acts, not late evidence
  allocate(m, { ref: p.accept, seq: 9, bell: 302 });
  caravanFacts(m, { seq: 9, depart: 302, settle: 315 });
  const r = m.reassess(res.decision_id, 320);
  assert.equal(r.would_differ, false);
  assert.deepEqual(r.changed_commitments, []);
  assert.equal(r.late_arrivals.length, 0);
  assert.ok(r.later_events.length >= 4);
  assert.equal(m.knowledge(A, 320).commitments[0].state, 'late', 'judged now, it is a late delivery');
});

// ---------------------------------------------------------------- caution label
test('caution is labelled as not an honesty judgment and never moves reliability', () => {
  const m = newMemory();
  promise(m);
  const k = m.knowledge(A, 300);
  const input = decisionInput({ k, request: REQUEST, candidates: world(), limits: LIMITS });
  assert.equal(input.cost_model.caution.is_honesty_judgment, false);
  const b = input.candidates.find(c => c.tag === 'B');
  assert.equal(b.unknown.open_overdue, 1);
  assert.equal(b.unknown.caution_is_honesty_judgment, false);
  assert.equal(b.reliability.E, 0.5);
  assert.ok(input.rules.some(r => /not proof of bad faith/.test(r)));
});

test('facts: an observation before its occurrence is refused', () => {
  assert.throws(() => fact({ kind: 'caravan_sent', bell: 120, created_bell: 110, source: { sig: 's', ix: 0 },
    data: { caravan: cv(1, 'B'), dst: PLACE_A, cargo: { wood: 1 } } }), RecordError);
});
