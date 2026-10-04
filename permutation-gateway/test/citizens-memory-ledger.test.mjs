// The ledger (contract §5.1): shape, code deltas, the trust table with its code/model split and daily caps,
// decay (incl. the loyalty rule), grievances (code-only), standing orders, record seq, persistence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from '../citizens/memory/ledger.mjs';
import { tagHex } from '../citizens/persona/names.mjs';

const T = tagHex(1000n), X = tagHex(5n), Y = tagHex(6n);
const fresh = (o = {}) => Ledger.create({ tag: T, goals: [{ id: 'G1', memory: false }, { id: 'G2', memory: true }], bell: 0, ...o });
const trust = (id, who, amount, bell = 10) => ({ id, kind: 'trust', who, part: 'code', amount, bell });

test('create: the §5.1 shape (v2), commitments reserved and empty, no standing.avoid, no pact field anywhere', () => {
  const s = fresh().snapshot();
  assert.deepEqual(Object.keys(s).sort(), ['commitments', 'counters', 'cursor', 'day', 'day_start', 'decay_day', 'goals', 'grievances', 'seq', 'standing', 'tag', 'trust', 'v']);
  assert.equal(s.v, 2);
  assert.deepEqual(s.commitments, []);
  assert.deepEqual(Object.keys(s.standing).sort(), ['declined_calls', 'reserved']);
  assert.deepEqual(s.goals.map(g => [g.id, g.status, g.memory]), [['G1', 'active', false], ['G2', 'active', true]]);
  assert.ok(!/pact|betray|promise|alliance|renown/i.test(JSON.stringify(s)));
});

test('code deltas: a hostile act is -15 to the actor and a grievance of weight 8; the trust shows its code part', () => {
  const l = fresh();
  assert.equal(l.apply(trust('t1', X, -15, 412)), true);
  assert.equal(l.apply({ id: 'g1', kind: 'grievance', against: X, nation: 3, event: 'ep1', bell: 412, weight: 8 }), true);
  assert.deepEqual(l.trustOf(X), { total: -15, t_code: -15, t_model: 0 });
  assert.deepEqual(l.grievances({ open: true }).map(g => [g.against, g.event, g.weight, g.answered]), [[X, 'ep1', 8, false]]);
  assert.equal(l.snapshot().trust.citizens[X].last_bell, 412);
});

test('code deltas are idempotent: the same delta id is applied once (a larger batch window re-offers old deltas)', () => {
  const l = fresh();
  assert.equal(l.apply(trust('t1', X, -15)), true);
  assert.equal(l.apply(trust('t1', X, -15)), false);
  assert.equal(l.trustOf(X).total, -15);
  l.apply({ id: 'g1', kind: 'grievance', against: X, nation: 3, event: 'e', bell: 1, weight: 8 });
  assert.equal(l.apply({ id: 'g1', kind: 'grievance', against: X, nation: 3, event: 'e', bell: 1, weight: 8 }), false);
  assert.equal(l.grievances().length, 1);
  // nation entries are deduped through the applied list
  assert.equal(l.apply(trust('n1', 'nation:3', -15)), true);
  assert.equal(l.apply(trust('n1', 'nation:3', -15)), false);
  assert.equal(l.trustOf('nation:3').total, -15);
});

test('trust = t_code + t_model, clamped -100..100 (each part clamped as well)', () => {
  const l = fresh();
  for (let i = 0; i < 10; i++) l.apply(trust(`t${i}`, X, -15));
  assert.equal(l.trustOf(X).t_code, -100);
  l.applyModelDeltas([{ who: X, delta: -10 }]);
  assert.equal(l.trustOf(X).total, -100);
  const m = fresh();
  m.apply(trust('a', Y, 90));
  m.applyModelDeltas([{ who: Y, delta: 10 }]);
  assert.deepEqual(m.trustOf(Y), { total: 100, t_code: 90, t_model: 10 });
  assert.deepEqual(m.trustOf(tagHex(999n)), { total: 0, t_code: 0, t_model: 0 });
});

test('model deltas: +-10 per handle per decision, at most +-15 per handle per game day, the excess clipped', () => {
  const l = fresh();
  let r = l.applyModelDeltas([{ who: X, delta: 10 }], { bell: 5 });
  assert.deepEqual(r, [{ who: X, applied: 10, clipped: false }]);
  r = l.applyModelDeltas([{ who: X, delta: 10 }]);
  assert.deepEqual(r, [{ who: X, applied: 5, clipped: true }]); // 10 + 10 = 20 -> clipped to the day's 15
  r = l.applyModelDeltas([{ who: X, delta: 10 }]);
  assert.deepEqual(r, [{ who: X, applied: 0, clipped: true }]);
  assert.equal(l.trustOf(X).t_model, 15);
  r = l.applyModelDeltas([{ who: X, delta: -10 }, { who: X, delta: -10 }, { who: X, delta: -10 }, { who: X, delta: -10 }]);
  assert.deepEqual(r.map(x => x.applied), [-10, -10, -10, 0]); // from +15 down: to +5, -5, -15, then the floor of the day
  assert.equal(l.trustOf(X).t_model, -15);
  // a single delta beyond +-10 is clamped first
  const m = fresh();
  assert.deepEqual(m.applyModelDeltas([{ who: Y, delta: 40 }]), [{ who: Y, applied: 10, clipped: true }]);
  // nations work the same way
  assert.deepEqual(m.applyModelDeltas([{ who: 'nation:2', delta: -7 }]), [{ who: 'nation:2', applied: -7, clipped: false }]);
  assert.equal(m.trustOf('nation:2').t_model, -7);
});

test('model deltas reset at the game day: advanceDay clears model_today and the day counters', () => {
  const l = fresh();
  l.bump('sessions'); l.bump('messages', 3);
  l.applyModelDeltas([{ who: X, delta: 10 }, { who: X, delta: 10 }]);
  assert.equal(l.snapshot().trust.citizens[X].model_today, 15);
  assert.equal(l.advanceDay(1, { temperament: { grudge: 100, loyalty: 0 }, ownNation: 0 }), true);
  const s = l.snapshot();
  assert.equal(s.trust.citizens[X].model_today, 0);
  assert.deepEqual(s.counters, { day: 1, sessions: 0, reactions: 0, messages: 0, marches: 0 });
  assert.equal(l.advanceDay(1, { temperament: { grudge: 100, loyalty: 0 }, ownNation: 0 }), false, 'once per game day');
});

test('decay: d = ceil((100 - grudge) / 20) per game day toward 0; toward own-nation citizens max(1, d - floor(loyalty / 34))', () => {
  const vec = [ // grudge, loyalty -> [d, own]
    [100, 0, 0, 1], [90, 70, 1, 1], [80, 85, 1, 1], [60, 50, 2, 1], [50, 85, 3, 1], [40, 34, 3, 2], [30, 60, 4, 3], [30, 20, 4, 4], [0, 100, 5, 3], [0, 0, 5, 5],
  ];
  for (const [grudge, loyalty, d, own] of vec) {
    const l = fresh();
    const mate = tagHex(70n), other = tagHex(71n);
    l.apply(trust('m', mate, -50)); l.apply(trust('o', other, -50)); l.apply(trust('n0', 'nation:2', -50)); l.apply(trust('n1', 'nation:4', -50));
    l.decay({ temperament: { grudge, loyalty }, ownNation: 2, nationOf: t => (t === mate ? 2 : 4) });
    if (d === 0) { assert.equal(l.trustOf(other).t_code, -50); continue; }
    assert.equal(l.trustOf(other).t_code, -50 + d, `grudge ${grudge}: other citizen`);
    assert.equal(l.trustOf(mate).t_code, -50 + own, `grudge ${grudge} loyalty ${loyalty}: own-nation citizen`);
    assert.equal(l.trustOf('nation:4').t_code, -50 + d);
    assert.equal(l.trustOf('nation:2').t_code, -50 + own, 'the own nation entry uses the loyalty step');
  }
});

test('decay moves BOTH parts toward 0 from either side and never crosses 0', () => {
  const l = fresh();
  l.apply(trust('a', X, 3)); l.applyModelDeltas([{ who: X, delta: -2 }]);
  l.decay({ temperament: { grudge: 0, loyalty: 0 }, ownNation: 0 }); // step 5
  assert.deepEqual(l.trustOf(X), { total: 0, t_code: 0, t_model: 0 });
});

test('advanceDay applies one decay per missed day (at most 10) and sets the day', () => {
  const l = fresh();
  l.apply(trust('a', X, -100));
  l.advanceDay(3, { temperament: { grudge: 50, loyalty: 0 }, ownNation: 0 }); // d = 3, three days
  assert.equal(l.trustOf(X).t_code, -100 + 9);
  assert.equal(l.snapshot().day, 3);
  l.advanceDay(100, { temperament: { grudge: 50, loyalty: 0 }, ownNation: 0 }); // capped at 10 steps
  assert.equal(l.trustOf(X).t_code, -100 + 9 + 30);
});

test('grievances come only from code; `answered` is set only by an answered delta; the model cannot', () => {
  const l = fresh();
  l.apply({ id: 'g1', kind: 'grievance', against: X, nation: 3, event: 'e1', bell: 100, weight: 8 });
  l.applyModelDeltas([{ who: X, delta: 10 }]);
  assert.equal(l.grievances({ open: true }).length, 1);
  assert.equal(l.apply({ id: 'a', kind: 'answered', grievance: 'nope', bell: 110 }), false);
  assert.equal(l.apply({ id: 'a1', kind: 'answered', grievance: 'g1', bell: 110 }), true);
  assert.equal(l.apply({ id: 'a2', kind: 'answered', grievance: 'g1', bell: 111 }), false);
  assert.deepEqual(l.grievances().map(g => [g.answered, g.answered_bell]), [[true, 110]]);
  assert.deepEqual(l.grievances({ open: true }), []);
  assert.throws(() => l.apply({ id: 'x', kind: 'pact', bell: 1 }), /unknown delta kind/);
});

test('goal ops come from the reflection: drop and resume change the status, progress is code-set', () => {
  const l = fresh();
  l.setGoalProgress({ G1: 61.4, G2: 140, G9: 5 });
  assert.deepEqual(l.snapshot().goals.map(g => g.progress), [61, 100]);
  assert.equal(l.goalOp({ op: 'drop', id: 'G1' }), true);
  assert.equal(l.snapshot().goals[0].status, 'dropped');
  assert.equal(l.goalOp({ op: 'resume', id: 'G1' }), true);
  assert.equal(l.goalOp({ op: 'progress', id: 'G2' }), true);
  assert.equal(l.goalOp({ op: 'drop', id: 'G7' }), false);
  assert.equal(l.goalOp({ op: 'avoid', id: 'G1' }), false);
});

test('standing orders: reserved hosts expire by bell, declined Strike-Order periods persist; there is no avoid order', () => {
  const l = fresh();
  l.reserve(11, 120); l.reserve(12, 140); l.reserve(11, 150); // a repeat replaces
  l.declineCall(4); l.declineCall(4); l.declineCall(5);
  assert.deepEqual(l.standing(100), { reserved: [{ host_id: 12, until_bell: 140 }, { host_id: 11, until_bell: 150 }], declined_calls: [4, 5] });
  assert.deepEqual(l.standing(140).reserved, [{ host_id: 11, until_bell: 150 }]);
  assert.deepEqual(l.standing(150).reserved, []);
  assert.ok(!('avoid' in l.standing(0)));
});

test('record seq: (bell << 4) | k, k counts the wallet\'s records of that type in the bell; a 17th in one bell throws', () => {
  const l = fresh();
  assert.equal(l.nextSeq('talk', 7), 7 * 16);
  assert.equal(l.nextSeq('talk', 7), 7 * 16 + 1);
  assert.equal(l.nextSeq('talk', 8), 8 * 16);
  assert.equal(l.nextSeq('ballot', 8), 8 * 16);
  for (let i = 0; i < 16; i++) l.nextSeq('talk', 9);
  assert.throws(() => l.nextSeq('talk', 9), /more than 16/);
});

test('day start and cursor are stored as given', () => {
  const l = fresh();
  l.setDayStart(288, 4200, 0); l.setCursor({ event_seq: 123456n, bell: 401 });
  const s = l.snapshot();
  assert.deepEqual(s.day_start, { bell: 288, home_troops: 4200, march_troops_model: 0 });
  assert.deepEqual(s.cursor, { event_seq: '123456', bell: 401 });
});

test('save and load round-trip (atomic write, no temp file left); canonical() is stable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-'));
  const l = fresh();
  l.apply(trust('a', X, -15)); l.apply({ id: 'g', kind: 'grievance', against: X, nation: 1, event: 'e', bell: 1, weight: 8 });
  l.save(join(dir, 'sub', `${T}.json`));
  assert.deepEqual(readdirSync(join(dir, 'sub')), [`${T}.json`]);
  const back = Ledger.load(join(dir, 'sub', `${T}.json`));
  assert.deepEqual(back.snapshot(), l.snapshot());
  assert.equal(back.canonical(), l.canonical());
  assert.equal(JSON.parse(readFileSync(join(dir, 'sub', `${T}.json`), 'utf8')).v, 2);
  const a = fresh(), b = fresh();
  a.apply(trust('1', X, -1)); a.apply(trust('2', Y, -2));
  b.apply(trust('2', Y, -2)); b.apply(trust('1', X, -1));
  assert.equal(a.canonical(), b.canonical(), 'key order does not matter');
});
