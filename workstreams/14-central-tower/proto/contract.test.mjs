// node --test workstreams/14-central-tower/proto/contract.test.mjs
// The facts ⑭ hands to ⑮ keep their contract (contract.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSim, run, step, snapshot, restore, CASES } from './model.mjs';
import { toFacts, checkFacts, KINDS, SCHEMA, VERIFIED, BELLS_PER_HOUR } from './contract.mjs';

const WEEK = 7 * 24;
const runs = [];
for (const c of CASES) for (const seed of [1, 2, 3]) {
  const sim = createSim({ seed, case: c, days: 21, periodHours: WEEK }); run(sim);
  runs.push({ c, seed, sim, facts: toFacts(sim) });
}

test('every run keeps the contract', () => {
  for (const r of runs) assert.deepEqual(checkFacts(r.facts), [], `${r.c} seed ${r.seed}`);
});

test('model facts are unverified, the world does not end, time says what it is', () => {
  for (const { facts } of runs) {
    assert.equal(facts.schema, SCHEMA);
    assert.equal(facts.world.ends, false);
    assert.equal(facts.time.bellsPerHour, BELLS_PER_HOUR);
    assert.ok(facts.events.length > 0);
    assert.ok(facts.events.every(e => e.verified === VERIFIED));
  }
});

test('period boundaries are handed over (they were not in version 0)', () => {
  for (const { facts } of runs) {
    assert.deepEqual(facts.boundaries, [{ index: 1, hour: WEEK }, { index: 2, hour: 2 * WEEK }]);
    assert.deepEqual(facts.events.filter(e => e.kind === 'period.boundary').map(e => e.hour), [WEEK, 2 * WEEK]);
  }
  const none = createSim({ seed: 1, case: 'B', days: 21 }); run(none);
  assert.deepEqual(toFacts(none).boundaries, []);
});

test('hour is the model hour the fact happened in; seq is the order, with no gap', () => {
  for (const { sim, facts } of runs) {
    const src = sim.facts.filter(f => f.kind in KINDS);
    assert.equal(facts.events.length, src.length);
    facts.events.forEach((e, i) => { assert.equal(e.seq, i); assert.equal(e.hour, src[i].t); assert.equal(e.actor, src[i].actor); });
  }
});

test('board: a post, the answer to it and its fulfilment mean what the contract says', () => {
  let taken = 0, fulfilled = 0, cross = 0;
  for (const { c, facts } of runs) {
    const ev = facts.events;
    if (c !== 'B') { assert.equal(ev.filter(e => e.kind.startsWith('tower.board_')).length, 0, `${c} has no board`); continue; }
    const post = new Map(ev.filter(e => e.kind === 'tower.board_post').map(e => [e.req, e]));
    const answer = new Map();
    for (const e of ev.filter(x => x.kind === 'tower.board_taken')) {
      const p = post.get(e.req);
      assert.ok(p && p.seq < e.seq, 'answered after it was posted');
      assert.equal(e.poster, p.actor);
      assert.notEqual(e.actor, e.poster);
      assert.equal(e.cross, p.nation !== e.nation);
      assert.ok(!answer.has(e.req), 'one answer per request');
      answer.set(e.req, e); taken++; if (e.cross) cross++;
    }
    for (const e of ev.filter(x => x.kind === 'tower.board_fulfilled')) {
      const a = answer.get(e.req);
      assert.ok(a && a.seq < e.seq && a.hour <= e.hour, 'fulfilled after it was answered');
      assert.equal(e.actor, post.get(e.req).actor, 'the poster is the fulfilled side');
      assert.equal(e.responder, a.actor);
      assert.equal(e.cross, a.cross);
      fulfilled++;
    }
  }
  assert.ok(taken > 0 && fulfilled > 0 && cross > 0, `${taken} answers, ${fulfilled} fulfilled, ${cross} across nations`);
  assert.ok(!Object.keys(KINDS).some(k => /sighting/.test(k)), 'the tower reports no sightings');
});

test('a restart does not change the facts handed over', () => {
  const P = { seed: 4, case: 'C', days: 21, periodHours: WEEK };
  const whole = createSim(P); run(whole);
  let s = createSim(P); while (s.tick < WEEK) step(s); s = restore(snapshot(s)); run(s);
  assert.deepEqual(toFacts(s), toFacts(whole));
});

test('every tower, centre and period kind the model records is in the contract', () => {
  const src = readFileSync(new URL('./model.mjs', import.meta.url), 'utf8');
  const kinds = new Set([...src.matchAll(/'((?:tower|centre|period)\.[a-z_]+)'/g)].map(m => m[1]));
  for (const k of kinds) assert.ok(k in KINDS, `${k} is not in the contract`);
});

test('the checker catches a broken handover', () => {
  const good = runs.find(r => r.c === 'B').facts;
  const copy = () => JSON.parse(JSON.stringify(good));
  const broken = [
    ['claimed verified', f => { f.events[0].verified = 'derived'; }],
    ['a gap in seq', f => { f.events.splice(1, 1); }],
    ['time going back', f => { f.events[2].hour = -1; }],
    ['an answer to a request never posted', f => { f.events.find(e => e.kind === 'tower.board_taken').req = -7; }],
    ['a wrong cross', f => { const e = f.events.find(e => e.kind === 'tower.board_taken'); e.cross = !e.cross; }],
    ['a winner', f => { f.winner = 0; }],
    ['a boundary left out', f => { f.boundaries = []; }],
    ['a world that ends', f => { f.world.ends = true; }],
    ['an unknown schema', f => { f.schema = 'wylls.ws14.tower-facts/0'; }],
  ];
  for (const [what, mutate] of broken) { const f = copy(); mutate(f); assert.ok(checkFacts(f).length > 0, what); }
});
