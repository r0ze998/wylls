// Contract test against ⑭'s real output: scenarios/fixtures/ws14-7d7f2143.json
// was produced by ⑭'s own model and `toFacts()` at 7d7f2143 (gen-ws14.mjs).
// ⑭'s facts are model facts: they may show what the tower would do, never
// what happened in the game.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluate, evaluateSeries } from '../src/evaluate.mjs';
import { RULESETS } from '../src/rulesets.mjs';
import { fromTowerFacts, windowsFromBoundaries, BELLS_PER_HOUR, SCHEMA } from '../src/adapters/ws14.mjs';

const fx = JSON.parse(readFileSync(new URL('../scenarios/fixtures/ws14-7d7f2143.json', import.meta.url), 'utf8'));
const map = { actorOf: v => `v${v}` };
const END = fx.source.params.days * 24 * BELLS_PER_HOUR;

/** An evaluator input from one case of the fixture: ⑭'s villages as participants, its boundaries as windows. */
function inputOf(c, adapt = x => x) {
  const facts = adapt(fx[c].facts);
  const { events, streams } = fromTowerFacts(facts, map);
  const villages = new Map();
  for (const f of fx[c].facts.events) if (f.actor !== null) villages.set(f.actor, f.nation);
  const nations = [...new Set([...villages.values()])].sort().map(n => `n${n}`);
  return {
    state: { at: 0, nations, actors: [...villages].sort((a, b) => a[0] - b[0]).map(([v, n]) => ({ id: `v${v}`, nation: `n${n}` })), lots: [], keeps: [], streams },
    events,
    windows: windowsFromBoundaries(fx[c].boundaries, { from: 0, to: END }),
  };
}

test('the fixture is ⑭\'s real output (schema, kinds, fields t/req/cross/actor)', () => {
  for (const c of ['B', 'C']) {
    assert.equal(fx[c].facts.schema, SCHEMA);
    for (const f of fx[c].facts.events) {
      assert.ok(Number.isInteger(f.t) && 'actor' in f && 'nation' in f, JSON.stringify(f));
      if (f.kind.startsWith('tower.board_')) assert.ok('req' in f);
      if (f.kind === 'tower.board_taken' || f.kind === 'tower.board_fulfilled') assert.equal(typeof f.cross, 'boolean');
    }
  }
  assert.ok(fx.B.facts.events.some(f => f.kind === 'tower.board_post'));
  assert.ok(fx.C.facts.events.some(f => f.kind === 'tower.relay_swap'));
});

test('t is the model hour: a fact at hour t becomes bell 6t; the order is the array\'s', () => {
  const { events } = fromTowerFacts(fx.B.facts, map);
  fx.B.facts.events.forEach((f, i) => {
    const e = events.find(x => x.seq === i);
    assert.equal(e.at, f.t * 6);
  });
});

test('posting is a request, not a sighting; taking is a send, not an arrival', () => {
  const { events } = fromTowerFacts(fx.B.facts, map);
  assert.equal(events.filter(e => e.kind === 'tower.sighting').length, 0);
  const n = k => fx.B.facts.events.filter(f => f.kind === k).length;
  assert.equal(events.filter(e => e.kind === 'tower.request.posted').length, n('tower.board_post'));
  assert.equal(events.filter(e => e.kind === 'tower.request.taken').length, n('tower.board_taken'));
  assert.equal(events.filter(e => e.kind === 'tower.request.fulfilled').length, n('tower.board_fulfilled'));
  assert.ok(events.every(e => e.verified === 'model'));
  const v = evaluate(RULESETS.B, inputOf('B'), { window: 'P0' });
  assert.equal(v.achievements.personal.find(p => p.goal === 'P-scout').status, 'not_offered');
  assert.deepEqual(v.achievements.personal.find(p => p.goal === 'P-scout').reasons.map(r => r.code), ['no_sighting_source']);
  // A village that only took (its exchange never arrived in the window) is not credited.
  const helper = v.achievements.personal.filter(p => p.goal === 'P-board-helper' && p.subject);
  assert.ok(helper.some(p => p.status === 'not_achieved' && p.reasons[0].code === 'taken_not_arrived'));
});

test('model facts are never facts of the game: model_only at most, and no award', () => {
  const s = evaluateSeries(RULESETS.B, inputOf('B'));
  const statuses = new Set(s.verdicts.flatMap(v => v.achievements.personal.filter(p => p.goal === 'P-board-helper' && p.subject).map(p => p.status)));
  assert.ok(statuses.has('model_only'));
  assert.equal(statuses.has('achieved'), false);
  assert.equal(s.verdicts.flatMap(v => v.awards).filter(a => a.goal === 'P-board-helper').length, 0);
  for (const v of s.verdicts) assert.equal(v.prize.status, 'not_decided');
});

test('the relay storehouse\'s swaps (case C) are not uses of a joint structure', () => {
  const v = evaluate(RULESETS.B, inputOf('C'), { window: 'P1' });
  assert.equal(v.achievements.joint[0].status, 'not_achieved');
  assert.equal(v.achievements.joint[0].projects.length, 0);
  assert.equal(v.awards.length, 0);
});

test('windows follow ⑭\'s boundaries; a fact in a boundary\'s hour belongs to the period after it', () => {
  const ws = windowsFromBoundaries(fx.B.boundaries, { from: 0, to: END });
  assert.deepEqual(fx.B.boundaries.map(b => b.t), [72, 144, 216]);
  assert.deepEqual(ws.map(w => [w.opensAt, w.endsAt]), [[0, 432], [432, 864], [864, 1296], [1296, 1440]]);
  // ⑭ records the boundary first in its hour (model.mjs step): facts of hour 72 are after it.
  const atBoundary = fx.C.facts.events.filter(f => f.t === 72);
  assert.ok(atBoundary.length > 0);
  const { events } = fromTowerFacts(fx.C.facts, map);
  const w = ws.find(x => 72 * 6 >= x.opensAt && 72 * 6 < x.endsAt);
  assert.equal(w.id, 'P1');
  assert.ok(events.filter(e => e.src.t === 72).every(e => e.at >= w.opensAt && e.at < w.endsAt));
});

test('a missing tower fact undecides only what tower facts decide', () => {
  const input = inputOf('B');
  const drop = input.events.find(e => e.kind === 'tower.request.fulfilled');
  const gap = { ...input, events: input.events.filter(e => e !== drop) };
  const v = evaluate(RULESETS.B, gap, { window: 'P0' });
  assert.ok(v.records.gaps.some(g => g.stream === 'ws14'));
  assert.ok(v.achievements.personal.some(p => p.goal === 'P-board-helper' && p.status === 'indeterminate'));
  assert.equal(v.scores.status, 'decided');
  assert.equal(v.achievements.joint[0].status, 'not_achieved');
});

test('a wrong schema is refused; unknown villages are left out as gaps, not guessed', () => {
  assert.match(fromTowerFacts({ schema: 'wylls.ws14.tower-facts/1' }, map).refused, /not wylls\.ws14\.tower-facts\/0/);
  const r = fromTowerFacts(fx.B.facts, { actorOf: v => (v === 8 ? null : `v${v}`) });
  assert.ok(r.unresolved.length > 0 && r.unresolved.every(u => u.village === 8));
});
