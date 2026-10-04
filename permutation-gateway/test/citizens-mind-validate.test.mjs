// AC1a: V2 (menu) and V3 (caps) of section 4.5, and the V5 glue.
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkMenu, applyCaps, applySpeech, messagesCap, DEFAULT_CAPS } from '../citizens/mind/validate.mjs';
import { makeSpeech } from './fixtures/ai-mind-doubles.mjs';

const P = { stance: ['hold', 'assault'], retreat: [0, 5000], timing: ['earliest'] };
const cands = [
  { id: 'c1', kind: 'autopilot', params: {} },
  { id: 'c2', kind: 'hold', params: {} },
  { id: 'c3', kind: 'march', troops: 500, facts: { host_id: '11' }, params: P },
  { id: 'c4', kind: 'march', troops: 500, facts: { host_id: '11' }, params: P },
  { id: 'c5', kind: 'build:wood', params: {} },
  { id: 'c6', kind: 'walls', params: {} },
  { id: 'c7', kind: 'train:spearman', params: { share: [25, 50, 75] } },
  { id: 'c8', kind: 'recall:H2', facts: { host_id: '12' }, params: { timing: ['earliest'] } },
  { id: 'c9', kind: 'march', troops: 300, facts: { host_id: '13' }, params: P },
];
const val = (over = {}) => ({ goal_id: 'G1', choose: ['c3'], params: {}, say: [], council: null, trust: [], mem: [], why: 'x', ...over });
const handles = { M1: 'e1', M2: 'e2' };

test('V2 accepts and fills missing params with the first allowed value', () => {
  const r = checkMenu(val({ params: { c3: { stance: 'assault' } } }), { candidates: cands, handles });
  assert.equal(r.ok, true);
  assert.deepEqual(r.params.c3, { stance: 'assault', retreat: 0, timing: 'earliest' });
});

test('V2 refuses autopilot or hold chosen with anything else', () => {
  assert.equal(checkMenu(val({ choose: ['c1', 'c5'] }), { candidates: cands }).ok, false);
  assert.equal(checkMenu(val({ choose: ['c3', 'c2'] }), { candidates: cands }).ok, false);
  assert.equal(checkMenu(val({ choose: ['c2'] }), { candidates: cands }).ok, true);
  assert.equal(checkMenu(val({ choose: ['c1'] }), { candidates: cands }).ok, true);
});

test('V2 refuses unknown ids and param values the candidate does not list', () => {
  assert.match(checkMenu(val({ choose: ['c99'] }), { candidates: cands }).error, /unknown id/);
  assert.match(checkMenu(val({ params: { c3: { stance: 'charge' } } }), { candidates: cands }).error, /not allowed/);
  assert.match(checkMenu(val({ params: { c3: { speed: 'x' } } }), { candidates: cands }).error, /not allowed/);
});

test('V2 drops params of an unchosen id and counts it (grammar cannot tie params to choose; step-0 measurement)', () => {
  const r = checkMenu(val({ params: { c3: {}, c9: { stance: 'hold' } } }), { candidates: cands });
  assert.equal(r.ok, true);
  assert.equal(r.stray, 1);
  assert.equal(r.params.c9, undefined);
});

test('V2: at most one march or recall per host', () => {
  assert.match(checkMenu(val({ choose: ['c3', 'c4'] }), { candidates: cands }).error, /host 11/);
  assert.equal(checkMenu(val({ choose: ['c3', 'c9'] }), { candidates: cands }).ok, true);
  assert.equal(checkMenu(val({ choose: ['c3', 'c8'] }), { candidates: cands }).ok, true, 'recall of another host');
});

test('V2: builds and walls are limited by the free queue slots', () => {
  assert.equal(checkMenu(val({ choose: ['c5', 'c6'] }), { candidates: cands, queueFree: 1 }).ok, false);
  assert.equal(checkMenu(val({ choose: ['c5', 'c6'] }), { candidates: cands, queueFree: 2 }).ok, true);
  assert.equal(checkMenu(val({ choose: ['c5', 'c7'] }), { candidates: cands, queueFree: 1 }).ok, true);
});

test('V2: mem handles outside the retrieved set are dropped and counted, never invalid', () => {
  const r = checkMenu(val({ mem: ['M1', 'M9', 'M1', 'x'] }), { candidates: cands, handles });
  assert.equal(r.ok, true);
  assert.deepEqual(r.mem.ids, ['e1']);
  assert.equal(r.mem.dropped, 3);
});

test('V3 (a): the decision\'s marches may not exceed 60 % of home troops', () => {
  const r = applyCaps({ chosen: ['c3', 'c9'], candidates: cands, homeTroops: 1000, dayStart: { home_troops: 150, march_troops_model: 0 }, marchesToday: 0 });
  assert.deepEqual(r.kept, ['c3']);
  assert.deepEqual(r.dropped, [{ id: 'c9', rule: 'a' }]);
  assert.equal(r.sent, 500);
});

test('V3 (b) day cap and (c) home floor, with the H0 < 200 exemption', () => {
  const day = applyCaps({ chosen: ['c9'], candidates: cands, homeTroops: 1000, dayStart: { home_troops: 1000, march_troops_model: 400 }, marchesToday: 1 });
  assert.deepEqual(day.dropped, [{ id: 'c9', rule: 'b' }], '400 + 300 > 600');
  const floor = applyCaps({ chosen: ['c3'], candidates: cands, homeTroops: 900, dayStart: { home_troops: 1500, march_troops_model: 0 }, marchesToday: 0 });
  assert.deepEqual(floor.dropped, [{ id: 'c3', rule: 'c' }], '900 - 500 < 40 % of 1500');
  const exempt = applyCaps({ chosen: ['c3'], candidates: cands, homeTroops: 900, dayStart: { home_troops: 199, march_troops_model: 900 }, marchesToday: 0 });
  assert.deepEqual(exempt.kept, ['c3'], 'H0 < 200: no day cap and no floor');
  assert.equal(exempt.capsNow.home_floor, 0);
  const exemptStillA = applyCaps({ chosen: ['c3'], candidates: cands, homeTroops: 700, dayStart: { home_troops: 150, march_troops_model: 0 }, marchesToday: 0 });
  assert.deepEqual(exemptStillA.dropped, [{ id: 'c3', rule: 'a' }], '500 > 60 % of 700: (a) always applies');
});

test('V3 (d): at most 4 model-chosen marches per game day', () => {
  const r = applyCaps({ chosen: ['c9'], candidates: cands, homeTroops: 5000, dayStart: { home_troops: 5000, march_troops_model: 0 }, marchesToday: 4 });
  assert.deepEqual(r.dropped, [{ id: 'c9', rule: 'd' }]);
  assert.equal(applyCaps({ chosen: ['c9'], candidates: cands, homeTroops: 5000, dayStart: { home_troops: 5000, march_troops_model: 0 }, marchesToday: 3 }).kept.length, 1);
});

test('V3 leaves non-march choices and recalls alone; the reported caps are the allowance at the start of the decision (the brain\'s V6 checks the decision against them)', () => {
  const r = applyCaps({ chosen: ['c5', 'c8', 'c3'], candidates: cands, homeTroops: 1000, dayStart: { home_troops: 1000, march_troops_model: 0 }, marchesToday: 0 });
  assert.deepEqual(r.kept, ['c5', 'c8', 'c3']);
  assert.deepEqual(r.capsNow, { march_troops_left: 600, home_floor: 400 }, '60 % of 1000 today, floor 40 % of 1000: the 500-troop march of this very decision still fits');
  const later = applyCaps({ chosen: ['c5'], candidates: cands, homeTroops: 1000, dayStart: { home_troops: 1000, march_troops_model: 500 }, marchesToday: 1 });
  assert.deepEqual(later.capsNow, { march_troops_left: 100, home_floor: 400 }, 'after 500 troops marched today');
  assert.equal(DEFAULT_CAPS.marches_per_day, 4);
});

test('the golden fixture caps: 1000 home troops, 500 sent -> 100 left? no: answer example uses 600 left before the march', () => {
  const r = applyCaps({ chosen: ['c2'], candidates: cands, homeTroops: 1000, dayStart: { home_troops: 1000, march_troops_model: 0 }, marchesToday: 0 });
  assert.deepEqual(r.capsNow, { march_troops_left: 600, home_floor: 400 });
});

test('messages cap = 6 + round(sociability / 25), at most 10', () => {
  assert.equal(messagesCap({ temperament: { sociability: 40 } }), 8);
  assert.equal(messagesCap({ temperament: { sociability: 90 } }), 10);
  assert.equal(messagesCap({ temperament: { sociability: 0 } }), 6);
  assert.equal(messagesCap({ temperament: { sociability: 100 } }), 10);
});

test('V5 glue: a refused say is dropped alone, a refused why is replaced by the code string, drops are counted by reason', () => {
  const speech = makeSpeech({ refuse: (k, text) => (text.includes('bad') ? (k === 'say' ? 'pact_word' : 'sealed_coordinate') : null) });
  const value = val({ say: [{ channel: 'world', text: 'bad one' }, { channel: 'nation', text: 'fine' }], why: 'bad reason' });
  const r = applySpeech({ value, speech, ctx: {}, messagesLeft: 5, kind: 'session' });
  assert.deepEqual(r.say.map((m) => m.text), ['fine']);
  assert.equal(r.why, '(reason withheld by the checker: sealed_coordinate)');
  assert.equal(r.why_withheld, 'sealed_coordinate');
  assert.deepEqual(r.drops, { pact_word: 1, 'why:sealed_coordinate': 1 });
});

test('V5 glue: the message budget drops the excess', () => {
  const r = applySpeech({ value: val({ say: [{ channel: 'world', text: 'a' }, { channel: 'world', text: 'b' }] }), speech: makeSpeech(), ctx: {}, messagesLeft: 1, kind: 'session' });
  assert.equal(r.say.length, 1);
  assert.equal(r.drops.message_budget, 1);
});
