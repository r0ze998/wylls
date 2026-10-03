// Tests of scripts/playtest-metrics.mjs on hand-made logs (PT-C): node --test scripts/playtest/metrics.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeMetrics, dayOf } from '../playtest-metrics.mjs';

const JST = s => Date.parse(`${s}+09:00`); // "2026-10-07T23:59:00"
const issued = (t, label, nonces) => ({ t, event: 'invites_issued', label, count: nonces.length, nonces });
const join = (t, invite, citizen) => ({ t, event: 'join', invite, wallet: `w-${citizen}`, citizen, signature: 's' });
const act = (t, citizen, kind = 'Build') => ({ t, event: 'action', citizen, kind, signature: 's' });
const seen = (t, citizen) => ({ t, event: 'seen', citizen });

test('calendar day is the JST date, midnight splits a session', () => {
  assert.equal(dayOf(JST('2026-10-07T23:59:59')), '2026-10-07');
  assert.equal(dayOf(JST('2026-10-08T00:00:00')), '2026-10-08');
  assert.equal(dayOf(Date.parse('2026-10-07T15:00:00Z')), '2026-10-08'); // 00:00 JST
  assert.equal(dayOf(Date.parse('2026-10-07T15:00:00Z'), 0), '2026-10-07');
});

const LOG = [
  issued(JST('2026-10-06T20:00:00'), 'bots', ['b1', 'b2']),
  issued(JST('2026-10-06T21:00:00'), 'friends', ['n1', 'n2', 'n3', 'n4', 'n5']),
  join(JST('2026-10-06T21:30:00'), 'b1', 'bot1'), act(JST('2026-10-07T10:00:00'), 'bot1'),
  join(JST('2026-10-06T22:00:00'), 'n1', 'A'),
  act(JST('2026-10-06T22:05:00'), 'A'), act(JST('2026-10-06T22:20:00'), 'A'),   // one session
  act(JST('2026-10-06T23:59:00'), 'A'), act(JST('2026-10-07T00:01:00'), 'A'),   // second session, spans midnight, returns
  join(JST('2026-10-06T23:00:00'), 'n2', 'B'), act(JST('2026-10-06T23:10:00'), 'B'), // joins and acts on day 1 only
  join(JST('2026-10-07T09:00:00'), 'n3', 'C'),                                  // joins day 2, never acts
  join(JST('2026-10-08T12:00:00'), 'n4', 'D'), act(JST('2026-10-09T08:00:00'), 'D'), act(JST('2026-10-09T08:10:00'), 'D'),
  seen(JST('2026-10-07T20:00:00'), 'B'),                                        // visit only: not a return
  join(JST('2026-10-08T12:30:00'), 'zz', 'Z'),                                  // a nonce from no batch
  join(JST('2026-10-08T12:31:00'), 'n1', 'A2'),                                 // the same invite twice: one person
];

test('headline figures', () => {
  const m = computeMetrics(LOG);
  assert.equal(m.N_invited, 5);
  assert.equal(m.N_joined, 4);
  assert.deepEqual(m.days, ['2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09']);
  assert.equal(m.D, 4);
  assert.equal(m.N_returned, 2); // A (acted on 10-07) and D (acted on 10-09); B only on its join day (a visit later does not count); C never
  assert.equal(m.secondary.N_returned_incl_visits, 3);
  assert.equal(m.secondary.joins_unknown_batch, 1);
  assert.equal(m.secondary.joins_excluded_labels, 1);
  const by = Object.fromEntries(m.people.map(p => [p.nonce, p]));
  assert.equal(by.n1.sessions, 2); // 22:00-22:20 is one session; 23:59 starts another (gap 99 min) and 00:01 belongs to it
  assert.equal(by.n2.sessions, 1);
  assert.equal(by.n3.sessions, 1);
  assert.equal(by.n4.sessions, 2); // join, then 20 hours later
  assert.equal(m.medianSessions, 1); // sessions per person A,B,C,D = 2,1,1,2: the lower median is 1
});

test('median sessions of A is two sessions (22:00-22:20, 23:59-00:01)', () => {
  const m = computeMetrics(LOG);
  const a = m.people.find(p => p.nonce === 'n1');
  assert.equal(a.sessions, 2);
});

test('per-day active citizens count a join as activity on its day', () => {
  const m = computeMetrics(LOG);
  const d = Object.fromEntries(m.perDay.map(r => [r.day, r]));
  assert.equal(d['2026-10-06'].activeCitizens, 2); // A, B
  assert.equal(d['2026-10-07'].activeCitizens, 2); // A (00:01), C (join)
  assert.equal(d['2026-10-08'].activeCitizens, 1); // D (join)
  assert.equal(d['2026-10-09'].activeCitizens, 1);
  assert.equal(d['2026-10-07'].withVisits, 3); // + B seen
});

test('the day boundary follows the timezone offset', () => {
  const m0 = computeMetrics(LOG, { tzHours: 0 });
  assert.notDeepEqual(m0.days, computeMetrics(LOG).days);
  assert.equal(m0.window.tzOffsetHours, 0);
});

test('empty and degenerate logs', () => {
  const m = computeMetrics([]);
  assert.equal(m.N_invited, 0); assert.equal(m.N_joined, 0); assert.equal(m.D, 0); assert.equal(m.N_returned, 0); assert.equal(m.medianSessions, null);
  const only = computeMetrics([issued(1, 'friends', ['x']), join(2, 'x', 'C')]);
  assert.equal(only.N_joined, 1); assert.equal(only.N_returned, 0); assert.equal(only.medianSessions, 1);
});

test('the window cuts lines by time', () => {
  const m = computeMetrics(LOG, { since: JST('2026-10-07T00:00:00') });
  assert.equal(m.N_invited, 0); // the batches were issued before the window
  assert.equal(m.N_joined, 0);
});

test('bots can be included or other labels excluded', () => {
  const m = computeMetrics(LOG, { exclude: [] });
  assert.equal(m.N_invited, 7);
  const m2 = computeMetrics(LOG, { exclude: ['bots', 'friends'] });
  assert.equal(m2.N_joined, 0);
});
