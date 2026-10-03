// Tests of scripts/playtest-metrics.mjs on hand-made logs (PT-C, rules of PT-E): node --test scripts/playtest/metrics.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeMetrics, dayOf, DELIBERATE_KINDS, labelMatches, nonceOfCode, returnsOf } from '../playtest-metrics.mjs';

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

test('PT-E: a join at 23:50 and an action at 00:10 is NOT a return (the night start is the main case, not an edge case)', () => {
  const m = computeMetrics([issued(JST('2026-10-06T20:00:00'), 'friends-1', ['n1']), join(JST('2026-10-06T23:50:00'), 'n1', 'A'), act(JST('2026-10-07T00:10:00'), 'A', 'Harvest')]);
  assert.equal(m.N_joined, 1);
  assert.equal(m.N_returned, 0, 'twenty minutes later is not a return');
  assert.equal(m.N_acted_late, 0);
  assert.equal(m.secondary.N_returned_calendar_day, 1, 'the calendar-day figure is inflated: that is why it is secondary');
  assert.equal(m.secondary.D_calendar_days, 2);
});

test('PT-E: someone who plays 22:00 to 01:00 in one sitting is not a return; a break of 12 hours is, and so is a break after a long sitting', () => {
  const base = [issued(1, 'friends-1', ['n1', 'n2', 'n3']), join(JST('2026-10-06T22:00:00'), 'n1', 'A'), join(JST('2026-10-06T22:00:00'), 'n2', 'B'), join(JST('2026-10-06T22:00:00'), 'n3', 'C')];
  const sitting = [];
  for (let m = 0; m <= 180; m += 20) sitting.push(act(JST('2026-10-06T22:00:00') + m * 60_000, 'A', 'Build'));
  const m = computeMetrics([...base, ...sitting,
    act(JST('2026-10-07T11:00:00'), 'B', 'Harvest'),                       // 13 h after the join: a return
    act(JST('2026-10-06T22:30:00'), 'C', 'Harvest'), act(JST('2026-10-07T09:00:00'), 'C', 'Harvest'), // 10.5 h: not at 12 h
    act(JST('2026-10-07T20:00:00'), 'C', 'Train')]);                      // 11 h after the last: not at 12 h either
  const by = Object.fromEntries(m.people.map(p => [p.nonce, p]));
  assert.equal(by.n1.returned, false);
  assert.equal(by.n2.returned, true);
  assert.equal(by.n3.returned, false);
  assert.equal(m.N_returned, 1);
  assert.equal(m.N_returned_by_hours[18], 0, 'B waited 13 h: not an 18 h return');
  assert.equal(m.N_acted_late, 2, 'A acted 3 h after joining, B 13 h and C 22 h after it');
});

test('PT-E: the first return of a continuous player does not count (acted late is the weaker figure)', () => {
  const r = returnsOf(0, [10, 20, 30, 40].map(h => h * 3_600_000), 12);
  assert.deepEqual([r.returned, r.actedLate], [false, true], 'acted 40 h after the join without a 12 h break');
  const r2 = returnsOf(0, [1, 14].map(h => h * 3_600_000), 12);
  assert.equal(r2.returned, true);
});

test('PT-E: automatic actions are not play: FileTicket, SetSession and Settle* never make a return or a session', () => {
  const lines = [issued(1, 'friends-1', ['n1']), join(JST('2026-10-06T22:00:00'), 'n1', 'A'), act(JST('2026-10-06T22:00:05'), 'A', 'FileTicket'),
    act(JST('2026-10-07T11:00:00'), 'A', 'SetSession'), act(JST('2026-10-07T11:00:01'), 'A', 'SettleTransit'), act(JST('2026-10-07T12:00:00'), 'A', 'SettleExplore'), act(JST('2026-10-07T13:00:00'), 'A', 'FileTicket')];
  const m = computeMetrics(lines);
  assert.equal(m.N_returned, 0);
  assert.equal(m.N_acted_late, 0);
  assert.equal(m.deliberate_actions_total, 0);
  assert.equal(m.automatic_actions_total, 5);
  assert.equal(m.secondary.N_joined_never_acted, 1);
  assert.equal(m.medianSessions, 1);
  for (const k of ['Join', 'FileTicket', 'SetSession', 'SettleTransit', 'SettleExplore']) assert.ok(!DELIBERATE_KINDS.includes(k), k);
  assert.deepEqual([...DELIBERATE_KINDS].sort(), ['Build', 'Dissolve', 'Depart', 'Explore', 'Garrison', 'Harvest', 'Muster', 'SetVigil', 'Train'].sort());
});

const LOG = [
  issued(JST('2026-10-06T20:00:00'), 'bots', ['b1', 'b2']),
  issued(JST('2026-10-06T21:00:00'), 'friends-1', ['n1', 'n2', 'n3', 'n4', 'n5']),
  join(JST('2026-10-06T21:30:00'), 'b1', 'bot1'), act(JST('2026-10-07T10:00:00'), 'bot1', 'Build'),
  join(JST('2026-10-06T22:00:00'), 'n1', 'A'),
  act(JST('2026-10-06T22:05:00'), 'A'), act(JST('2026-10-06T22:20:00'), 'A'),   // one session
  act(JST('2026-10-06T23:59:00'), 'A'), act(JST('2026-10-07T00:01:00'), 'A'),   // second session, spans midnight
  act(JST('2026-10-07T13:00:00'), 'A', 'Harvest'),                              // 13 h after the last: a return
  join(JST('2026-10-06T23:00:00'), 'n2', 'B'), act(JST('2026-10-06T23:10:00'), 'B'), // joins and acts on day 1 only
  join(JST('2026-10-07T09:00:00'), 'n3', 'C'),                                  // joins day 2, never acts
  join(JST('2026-10-08T12:00:00'), 'n4', 'D'), act(JST('2026-10-09T08:00:00'), 'D'), act(JST('2026-10-09T08:10:00'), 'D'), // 20 h later
  seen(JST('2026-10-07T20:00:00'), 'B'),                                        // visit only: not a return
  join(JST('2026-10-08T12:30:00'), 'zz', 'Z'),                                  // a nonce from no batch
  join(JST('2026-10-08T12:31:00'), 'n1', 'A2'),                                 // the same invite twice: one person
];

test('headline figures', () => {
  const m = computeMetrics(LOG);
  assert.equal(m.N_invited, 5);
  assert.equal(m.N_joined, 4);
  assert.deepEqual(m.secondary.days, ['2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09']);
  assert.equal(m.secondary.D_calendar_days, 4);
  assert.equal(m.N_returned, 2); // A (13 h after the last) and D (20 h after the join); B is only seen later; C never acted
  assert.equal(m.secondary.N_returned_incl_visits, 3);
  assert.equal(m.secondary.joins_unknown_batch, 1);
  assert.equal(m.secondary.joins_excluded_labels, 1);
  assert.equal(m.elapsed_hours, Number(((JST('2026-10-09T08:10:00') - JST('2026-10-06T22:00:00')) / 3_600_000).toFixed(1)));
  const by = Object.fromEntries(m.people.map(p => [p.nonce, p]));
  assert.equal(by.n1.sessions, 3); // 22:00-22:20; 23:59-00:01; 13:00
  assert.equal(by.n2.sessions, 1);
  assert.equal(by.n3.sessions, 1);
  assert.equal(by.n4.sessions, 2); // join, then 20 hours later
  assert.equal(m.medianSessions, 1); // A,B,C,D = 3,1,1,2 -> sorted 1,1,2,3: the lower median is 1
});

test('PT-E: counted labels are an allow-list; every label is listed; an unexpected label is reported, never counted', () => {
  const lines = [issued(1, 'friends-1', ['n1']), issued(1, 'unlabelled', ['u1', 'u2']), issued(1, 'ops', ['o1']), issued(1, 'bots', ['b1']), issued(1, 'friends-2', ['n2']),
    join(2, 'n1', 'A'), join(2, 'u1', 'U'), join(2, 'o1', 'O'), join(2, 'b1', 'B'), join(2, 'n2', 'F')];
  const m = computeMetrics(lines);
  assert.equal(m.N_invited, 2);
  assert.equal(m.N_joined, 2);
  assert.deepEqual(Object.keys(m.labels).sort(), ['bots', 'friends-1', 'friends-2', 'ops', 'unlabelled']);
  assert.equal(m.labels.unlabelled.issued, 2);
  assert.equal(m.labels.unlabelled.joined, 1);
  assert.equal(m.labels.unlabelled.counted, false);
  assert.deepEqual(m.unexpectedLabels, ['unlabelled']);
  assert.deepEqual(computeMetrics(lines.slice(0, 1).concat(lines.slice(3, 4))).unexpectedLabels, [], 'bots and ops are known');
  assert.ok(labelMatches('friends-*', 'friends-2026-10-06') && !labelMatches('friends-*', 'ops') && labelMatches('ops', 'ops'));
  assert.equal(computeMetrics(lines, { include: ['friends-*', 'unlabelled'] }).N_joined, 3);
  assert.equal(computeMetrics(lines, { exclude: ['friends-2'] }).N_joined, 1);
});

test('PT-E: --exclude-codes removes a person from N, N_joined, N_returned and sessions', () => {
  const code = Buffer.concat([Buffer.alloc(12, 1), Buffer.alloc(8, 9)]).toString('base64url');
  const nonce = nonceOfCode(code);
  assert.equal(nonce, '010101010101010101010101');
  assert.equal(nonceOfCode(nonce), nonce, 'a nonce is accepted as it is');
  const lines = [issued(1, 'friends-1', [nonce, 'n2']), join(JST('2026-10-06T22:00:00'), nonce, 'A'), act(JST('2026-10-07T12:00:00'), 'A', 'Harvest'),
    join(JST('2026-10-06T22:00:00'), 'n2', 'B'), act(JST('2026-10-07T12:00:00'), 'B', 'Harvest')];
  const all = computeMetrics(lines);
  assert.deepEqual([all.N_invited, all.N_joined, all.N_returned], [2, 2, 2]);
  const m = computeMetrics(lines, { excludeCodes: [code] });
  assert.deepEqual([m.N_invited, m.N_joined, m.N_returned, m.people.length], [1, 1, 1, 1]);
  assert.deepEqual(m.removed_by_exclude_codes, { from_invited: 1, joined: 1, listed: 1 });
});

test('PT-E: returns right after a reminder are counted apart (prompted, not organic)', () => {
  const lines = [issued(1, 'friends-1', ['n1', 'n2']), join(JST('2026-10-06T22:00:00'), 'n1', 'A'), join(JST('2026-10-06T22:00:00'), 'n2', 'B'),
    act(JST('2026-10-07T20:30:00'), 'A', 'Harvest'), act(JST('2026-10-07T12:00:00'), 'B', 'Harvest')];
  const m = computeMetrics(lines, { reminders: [JST('2026-10-07T20:00:00')] });
  assert.equal(m.N_returned, 2);
  assert.equal(m.N_returned_after_reminder, 1);
});

test('per-day active citizens count a join as activity on its day', () => {
  const m = computeMetrics(LOG);
  const d = Object.fromEntries(m.perDay.map(r => [r.day, r]));
  assert.equal(d['2026-10-06'].activeCitizens, 2); // A, B
  assert.equal(d['2026-10-07'].activeCitizens, 2); // A (00:01, 13:00), C (join)
  assert.equal(d['2026-10-08'].activeCitizens, 1); // D (join)
  assert.equal(d['2026-10-09'].activeCitizens, 1);
  assert.equal(d['2026-10-07'].withVisits, 3); // + B seen
});

test('the day boundary follows the timezone offset', () => {
  const m0 = computeMetrics(LOG, { tzHours: 0 });
  assert.notDeepEqual(m0.secondary.days, computeMetrics(LOG).secondary.days);
  assert.equal(m0.window.tzOffsetHours, 0);
});

test('empty and degenerate logs', () => {
  const m = computeMetrics([]);
  assert.equal(m.N_invited, 0); assert.equal(m.N_joined, 0); assert.equal(m.secondary.D_calendar_days, 0); assert.equal(m.N_returned, 0); assert.equal(m.medianSessions, null); assert.equal(m.elapsed_hours, null);
  const only = computeMetrics([issued(1, 'friends-1', ['x']), join(2, 'x', 'C')]);
  assert.equal(only.N_joined, 1); assert.equal(only.N_returned, 0); assert.equal(only.medianSessions, 1);
});

test('the window cuts lines by time', () => {
  const m = computeMetrics(LOG, { since: JST('2026-10-07T00:00:00') });
  assert.equal(m.N_invited, 0); // the batches were issued before the window
  assert.equal(m.N_joined, 0);
});

test('bots can be included or other labels excluded', () => {
  const m = computeMetrics(LOG, { include: ['*'] });
  assert.equal(m.N_invited, 7);
  const m2 = computeMetrics(LOG, { exclude: ['friends-1'] });
  assert.equal(m2.N_joined, 0);
});
