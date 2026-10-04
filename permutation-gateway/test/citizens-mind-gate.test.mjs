// AC1a: wake events and the delta gate (sections 3.2 and 3.3), exactly.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGate, rollCounters, normaliseWakes, DAY_BELLS } from '../citizens/mind/gate.mjs';

const fresh = () => ({ day: 0, sessions: 0, reactions: 0, messages: 0, marches: 0 });
const base = (over = {}) => ({ tag: 'a', bell: 100, endBell: 1008, ready: true, wakes: [], counters: fresh(), ...over });

test('a first ready step pulses at once (last = bell - 24) and opens a session', () => {
  const g = createGate();
  const d = g.decide(base());
  assert.equal(d.mode, 'session');
  assert.deepEqual(d.wake, ['W-PULSE']);
  assert.equal(d.score, 3);
});

test('after a session the pulse waits 24 bells; below the gate is autopilot', () => {
  const g = createGate();
  const c = fresh();
  g.noteSession('a', 100, c);
  assert.equal(g.decide(base({ bell: 110, counters: c })).reason, 'below_gate');
  assert.equal(g.decide(base({ bell: 123, counters: c })).mode, 'autopilot');
  assert.equal(g.decide(base({ bell: 124, counters: c })).mode, 'session');
});

test('a clash (weight 4) opens a session; two bells apart unless s >= 6', () => {
  const g = createGate();
  const c = fresh();
  g.noteSession('a', 100, c);
  assert.equal(g.decide(base({ bell: 101, counters: c, wakes: ['W-CLASH'] })).mode, 'autopilot', 'b - last < 2 and s = 4');
  assert.equal(g.decide(base({ bell: 102, counters: c, wakes: ['W-CLASH'] })).mode, 'session');
  assert.equal(g.decide(base({ bell: 101, counters: c, wakes: ['W-CLASH', 'W-CALL'] })).mode, 'session', 's = 7 >= 6');
});

test('threat weight is 2, +1 when the departing mass is at least half of home troops', () => {
  const g = createGate();
  const c = fresh();
  g.noteSession('a', 100, c);
  assert.equal(g.score(normaliseWakes([{ code: 'W-THREAT' }])), 2);
  assert.equal(g.score(normaliseWakes([{ code: 'W-THREAT', big: true }])), 3);
  assert.equal(g.decide(base({ bell: 110, counters: c, wakes: [{ code: 'W-THREAT' }] })).mode, 'autopilot');
  assert.equal(g.decide(base({ bell: 110, counters: c, wakes: [{ code: 'W-THREAT', big: true }] })).mode, 'session');
  assert.equal(g.decide(base({ bell: 110, counters: c, wakes: [{ code: 'W-THREAT' }, 'W-READY'] })).mode, 'session', '2 + 1');
});

test('W-READY and W-QUEUE together (2) never open a session alone', () => {
  const g = createGate();
  const c = fresh();
  g.noteSession('a', 100, c);
  assert.equal(g.decide(base({ bell: 110, counters: c, wakes: ['W-READY', 'W-QUEUE'] })).mode, 'autopilot');
});

test('social cap: W-DM + W-HALL contribute at most 2, so social traffic alone never opens a session', () => {
  const g = createGate();
  const c = fresh();
  g.noteSession('a', 100, c);
  const d = g.decide(base({ bell: 110, counters: c, wakes: ['W-DM', 'W-HALL'] }));
  assert.equal(d.score, 2);
  assert.equal(d.mode, 'reaction', 'but it earns a reaction');
  assert.equal(g.decide(base({ bell: 110, counters: c, wakes: ['W-DM', 'W-HALL', 'W-READY'] })).mode, 'session', '2 + 1 = 3');
});

test('W-CALL (3) opens a session; with budget gone it falls to a reaction', () => {
  const g = createGate();
  const c = fresh();
  g.noteSession('a', 100, c);
  assert.equal(g.decide(base({ bell: 110, counters: c, wakes: ['W-CALL'] })).mode, 'session');
  c.sessions = 8;
  assert.equal(g.decide(base({ bell: 110, counters: c, wakes: ['W-CALL'] })).mode, 'reaction');
  c.reactions = 6;
  const d = g.decide(base({ bell: 110, counters: c, wakes: ['W-CALL'] }));
  assert.equal(d.mode, 'autopilot');
  assert.equal(d.reason, 'budget');
});

test('session budget: 8 a day, then autopilot "budget"; the next game day starts fresh', () => {
  const g = createGate();
  const c = fresh();
  c.sessions = 8;
  assert.equal(g.decide(base({ bell: 100, counters: c })).reason, 'budget');
  const d = g.decide(base({ bell: DAY_BELLS + 1, counters: c }));
  assert.equal(c.day, 1);
  assert.equal(c.sessions, 0);
  assert.equal(d.mode, 'session');
});

test('global reaction cap: at most 4 reactions per bell across all AIs', () => {
  const g = createGate();
  const cs = Array.from({ length: 6 }, fresh);
  const modes = cs.map((c, i) => {
    g.noteSession(`t${i}`, 100, c);
    c.sessions = 0;
    const d = g.decide(base({ tag: `t${i}`, bell: 105, counters: c, wakes: ['W-DM'] }));
    if (d.mode === 'reaction') g.noteReaction(105, c);
    return d.mode;
  });
  assert.deepEqual(modes, ['reaction', 'reaction', 'reaction', 'reaction', 'autopilot', 'autopilot']);
});

test('season end and not ready beat everything', () => {
  const g = createGate();
  assert.equal(g.decide(base({ bell: 1006, wakes: ['W-CLASH'] })).reason, 'season_end');
  assert.equal(g.decide(base({ bell: 1005 })).mode, 'session');
  assert.equal(g.decide(base({ ready: false, wakes: ['W-CLASH'] })).reason, 'not_ready');
});

test('rollCounters resets on a new day only', () => {
  const c = { day: 0, sessions: 3, reactions: 2, messages: 4, marches: 1 };
  rollCounters(c, 100);
  assert.equal(c.sessions, 3);
  rollCounters(c, 144);
  assert.deepEqual([c.day, c.sessions, c.reactions, c.messages, c.marches], [1, 0, 0, 0, 0]);
});

test('normaliseWakes dedupes by code and ignores junk', () => {
  const w = normaliseWakes(['W-DM', { code: 'W-DM' }, { code: 'W-THREAT', big: true }, null, 7, { x: 1 }]);
  assert.deepEqual(w.map((x) => x.code), ['W-DM', 'W-THREAT']);
  assert.equal(w[1].big, true);
});
