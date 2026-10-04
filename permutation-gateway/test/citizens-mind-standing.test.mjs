// AC1a: standing orders (section 3.6): reserved hosts by hold or recall, declined Calls, expiry by bell.
import test from 'node:test';
import assert from 'node:assert/strict';
import { liveStanding, updateStanding, declinedPeriods, emptyStanding, RESERVE_BELLS } from '../citizens/mind/standing.mjs';

const hosts = [{ handle: 'H1', host_id: '123149597278209' }, { handle: 'H2', host_id: '123149597278210' }];
const cands = [
  { id: 'c1', kind: 'autopilot' },
  { id: 'c2', kind: 'hold', facts: { keeps_home: ['H1'] } },
  { id: 'c3', kind: 'march', flags: { council: true }, facts: { period: 4, host_id: '123149597278209' } },
  { id: 'c4', kind: 'recall:H2', facts: { host_id: '123149597278210' } },
  { id: 'c5', kind: 'build:wood' },
];

test('a hold choice reserves the hosts named in its facts for 12 bells (host ids stay decimal strings)', () => {
  const s = updateStanding(emptyStanding(), { bell: 100, candidates: cands, chosenIds: ['c2'], hosts });
  assert.deepEqual(s.reserved, [{ host_id: '123149597278209', until_bell: 100 + RESERVE_BELLS }]);
});

test('a recall reserves its host too', () => {
  const s = updateStanding(emptyStanding(), { bell: 100, candidates: cands, chosenIds: ['c4'], hosts });
  assert.deepEqual(s.reserved.map((r) => r.host_id), ['123149597278210']);
});

test('an offered Strike Order that is not chosen declines that period (unless the choice is autopilot alone)', () => {
  assert.deepEqual(updateStanding(emptyStanding(), { bell: 1, candidates: cands, chosenIds: ['c5'], hosts }).declined_calls, [4]);
  assert.deepEqual(updateStanding(emptyStanding(), { bell: 1, candidates: cands, chosenIds: ['c2'], hosts }).declined_calls, [4], 'hold declines it too');
  assert.deepEqual(updateStanding(emptyStanding(), { bell: 1, candidates: cands, chosenIds: ['c1'], hosts }).declined_calls, [], 'choose autopilot: no decline');
  assert.deepEqual(updateStanding(emptyStanding(), { bell: 1, candidates: cands, chosenIds: ['c3'], hosts }).declined_calls, [], 'chosen: not declined');
  assert.deepEqual(declinedPeriods(cands, ['c5']), [4]);
});

test('the period comes from the member view when the candidate does not carry it', () => {
  const noPeriod = cands.map((c) => (c.id === 'c3' ? { ...c, facts: { host_id: 'x' } } : c));
  assert.deepEqual(updateStanding(emptyStanding(), { bell: 1, candidates: noPeriod, chosenIds: ['c5'], hosts, callPeriod: 9 }).declined_calls, [9]);
});

test('liveStanding drops expired reservations and sorts; declined periods are unique and sorted', () => {
  const s = { reserved: [{ host_id: '9', until_bell: 50 }, { host_id: '5', until_bell: 200 }, { host_id: '3', until_bell: 101 }], declined_calls: [4, 2, 4] };
  assert.deepEqual(liveStanding(s, 100), { reserved: [{ host_id: '3', until_bell: 101 }, { host_id: '5', until_bell: 200 }], declined_calls: [2, 4] });
  assert.deepEqual(liveStanding(null, 5), { reserved: [], declined_calls: [] });
});

test('a longer reservation is never shortened', () => {
  const st = { reserved: [{ host_id: '123149597278209', until_bell: 300 }], declined_calls: [] };
  updateStanding(st, { bell: 100, candidates: cands, chosenIds: ['c2'], hosts });
  assert.equal(st.reserved[0].until_bell, 300);
});
