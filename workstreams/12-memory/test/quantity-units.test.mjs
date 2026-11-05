// Workstream 12: whole-unit records hide sub-unit fractions (workstream 4 QUANTITY-CONTRACT §3-§4, read on
// origin/preserve/ws04-a967f5f1). The log carries cargo as floor(milli / 1000), so a delivery's true amount is in
// [b, b + 1) and n deliveries sum to [sum b, sum b + n). A shortfall is proven only when sum b + n <= qty; b = 0 is not
// zero; "not sent" is never concluded from a delivery that rounded to 0.
import test from 'node:test';
import assert from 'node:assert/strict';
import { A, PLACE_A, allocate, caravanFacts, coverage, cv, newMemory, promise } from '../fixtures/scenario.mjs';

const PLACE_H = Object.freeze({ partition: 'p1', kind: 1, p: 3, q: 0, at: 2, gen: 1 }); // a holding: rule-derived credit
const one = (m, at = 300) => m.knowledge(A, at).commitments[0];

test('units: two deliveries of 49 (each possibly 49.x) do not prove a shortfall against 99', () => {
  const m = newMemory();
  const p = promise(m, { qty: 99, place: PLACE_H });
  allocate(m, { ref: p.accept, seq: 1, qty: 49, bell: 103 });
  allocate(m, { ref: p.accept, seq: 2, qty: 49, bell: 104 });
  caravanFacts(m, { dst: PLACE_H, seq: 1, cargo: { wood: 49 }, credited: null });
  caravanFacts(m, { dst: PLACE_H, seq: 2, cargo: { wood: 49 }, credited: null, depart: 104 });
  coverage(m, { caravans: [cv(1), cv(2)] });
  const c = one(m);
  assert.equal(c.delivered_min, 98);
  assert.equal(c.sub_unit_slack, 2);
  assert.deepEqual([c.state, c.reasons], ['unconfirmed', ['qty_sub_unit_uncertain']], 'the true total can be up to 99.98');
  assert.equal(m.knowledge(A, 300).reliability.B.E, 0.5, 'not counted either way');
});

test('units: two deliveries of 40 prove a shortfall against 99 (40.x + 40.x < 82 <= 99)', () => {
  const m = newMemory();
  const p = promise(m, { qty: 99, place: PLACE_H });
  allocate(m, { ref: p.accept, seq: 1, qty: 40, bell: 103 });
  allocate(m, { ref: p.accept, seq: 2, qty: 40, bell: 104 });
  caravanFacts(m, { dst: PLACE_H, seq: 1, cargo: { wood: 40 }, credited: null });
  caravanFacts(m, { dst: PLACE_H, seq: 2, cargo: { wood: 40 }, credited: null, depart: 104 });
  coverage(m, { caravans: [cv(1), cv(2)] });
  assert.equal(one(m).state, 'partial');
});

test('units: a caravan that carried less than one unit (logged 0) is never read as "not sent"', () => {
  const m = newMemory();
  const p = promise(m, { qty: 1, place: PLACE_H });
  allocate(m, { ref: p.accept, seq: 1, qty: 1, bell: 103 });
  // 0.9 wood: CARAVAN_SENT and CARAVAN_SETTLED log floor(900 / 1000) = 0
  caravanFacts(m, { dst: PLACE_H, seq: 1, cargo: {}, credited: null });
  coverage(m, { caravans: [cv(1)] });
  const c = one(m);
  assert.notEqual(c.state, 'not_sent');
  assert.equal(c.state, 'unconfirmed');
  assert.ok(c.reasons.includes('unassigned_caravan'), 'the caravan to the place is listed and not explained away');
  assert.equal(m.knowledge(A, 300).reliability.B.s, 0);
});

test('units: a single delivery credited below the promise is partial (b + 1 <= qty), and rounding never makes it "not sent"', () => {
  const m = newMemory();
  const p = promise(m, { qty: 100, place: PLACE_H });
  allocate(m, { ref: p.accept, seq: 1, qty: 60, bell: 103 });
  caravanFacts(m, { dst: PLACE_H, seq: 1, cargo: { wood: 60 }, credited: null });
  coverage(m, { caravans: [cv(1)] });
  const c = one(m);
  assert.deepEqual([c.state, c.delivered_min, c.sub_unit_slack], ['partial', 60, 1]);
});

test('units: "late" needs the on-time part proven short; otherwise it stays undecided', () => {
  // on time: the given whole-unit deliveries (each possibly + a fraction); then one late delivery completes the promise
  const run = (qty, onTimeParts) => {
    const m = newMemory();
    const p = promise(m, { qty, place: PLACE_H, due: 130 });
    const lateQty = qty - onTimeParts.reduce((a, b) => a + b, 0) + 1;
    onTimeParts.forEach((q, i) => {
      allocate(m, { ref: p.accept, seq: i + 1, qty: q, bell: 103 + i });
      caravanFacts(m, { dst: PLACE_H, seq: i + 1, cargo: { wood: q }, credited: null, depart: 103 + i, settle: 120 });
    });
    allocate(m, { ref: p.accept, seq: 9, qty: lateQty, bell: 150 });
    caravanFacts(m, { dst: PLACE_H, seq: 9, cargo: { wood: lateQty }, credited: null, depart: 150, settle: 200 });
    return one(m);
  };
  assert.equal(run(100, [99]).state, 'late', 'one on-time delivery of 99.x is below 100: proven late (4 §4, b + 1 <= qty)');
  const r = run(99, [49, 49]);
  assert.deepEqual([r.state, r.reasons], ['unconfirmed', ['qty_sub_unit_uncertain']], '49.x + 49.x on time could already reach 99');
});

test('units: a vault credit from 4\'s execution record carries the same margin', () => {
  const m = newMemory();
  const p = promise(m, { qty: 100 }); // PLACE_A is a vault
  allocate(m, { ref: p.accept, seq: 1, qty: 100, bell: 103 });
  caravanFacts(m, { seq: 1, credited: { wood: 99 } });
  coverage(m, { caravans: [cv(1)] });
  assert.deepEqual([one(m).state, one(m).delivered_min, one(m).sub_unit_slack], ['partial', 99, 1], '99.x < 100: proven short');
  const m2 = newMemory();
  const p2 = promise(m2, { qty: 99 });
  allocate(m2, { ref: p2.accept, seq: 1, qty: 49, bell: 103 });
  allocate(m2, { ref: p2.accept, seq: 2, qty: 49, bell: 104 });
  caravanFacts(m2, { seq: 1, cargo: { wood: 49 } });
  caravanFacts(m2, { seq: 2, cargo: { wood: 49 }, depart: 104 });
  coverage(m2, { caravans: [cv(1), cv(2)] });
  assert.deepEqual([one(m2).state, one(m2).reasons], ['unconfirmed', ['qty_sub_unit_uncertain']]);
  assert.ok(PLACE_A.kind === 2);
});

test('units: a delivery a full vault credited as 0 is "partial", never "not sent" (it was sent and settled)', () => {
  const m = newMemory();
  const p = promise(m, { qty: 100 }); // PLACE_A is a vault; min(have + c, max(cap, have)) adds nothing when full
  allocate(m, { ref: p.accept, seq: 1, qty: 100, bell: 103 });
  caravanFacts(m, { seq: 1, credited: { wood: 0 } });
  coverage(m, { caravans: [cv(1)] });
  const c = one(m);
  assert.deepEqual([c.state, c.delivered_min, c.links[0].state], ['partial', 0, 'delivered']);
  assert.equal(m.knowledge(A, 300).reliability.B.verified.not_sent, 0);
});
