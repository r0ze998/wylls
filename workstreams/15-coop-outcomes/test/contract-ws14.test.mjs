// Contract tests against ⑭'s real outputs, both versions read by one adapter:
//   v1 `wylls.ws14.tower-facts/1` — scenarios/fixtures/ws14-v1-bde8d1c1-case{A,B,C}.json,
//      ⑭'s own handoff files of bde8d1c1 (bytes unchanged; source in ws14-v1-bde8d1c1.source.json)
//   v0 `wylls.ws14.tower-facts/0` — scenarios/fixtures/ws14-7d7f2143.json (⑭'s model at 7d7f2143)
// ⑭'s facts come from a comparison model: they may show what the tower would
// do, never what happened in the game. ⑭'s boundaries are marks, not windows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { evaluate, evaluateSeries } from '../src/evaluate.mjs';
import { RULESETS } from '../src/rulesets.mjs';
import { fromTowerFacts, normalizeTowerFacts, SCHEMA_V0, SCHEMA_V1 } from '../src/adapters/ws14.mjs';

const read = f => readFileSync(new URL(`../scenarios/fixtures/${f}`, import.meta.url), 'utf8');
const src = JSON.parse(read('ws14-v1-bde8d1c1.source.json'));
const v1 = Object.fromEntries(['A', 'B', 'C'].map(c => [c, JSON.parse(read(`ws14-v1-bde8d1c1-case${c}.json`))]));
const v0 = JSON.parse(read('ws14-7d7f2143.json'));
const map = { actorOf: v => `v${v}` };

/** An evaluator input from ⑭'s facts: its villages as participants and ONE window given here (not from ⑭). */
function inputOf(facts, window) {
  const { events, streams } = fromTowerFacts(facts, map);
  const villages = new Map();
  for (const f of facts.events) if (f.actor !== null) villages.set(f.actor, f.nation);
  const nations = [...new Set([...villages.values()])].sort().map(n => `n${n}`);
  return {
    state: { at: 0, nations, actors: [...villages].sort((a, b) => a[0] - b[0]).map(([v, n]) => ({ id: `v${v}`, nation: `n${n}` })), lots: [], keeps: [], streams },
    events, windows: [window],
  };
}
const WHOLE = { id: 'given', opensAt: 0, endsAt: 21 * 24 * 6 };

test('v1 fixtures are ⑭\'s handoff bytes', () => {
  for (const [file, { sha256 }] of Object.entries(src.files)) assert.equal(createHash('sha256').update(read(file)).digest('hex'), sha256, file);
  for (const c of ['A', 'B', 'C']) {
    assert.equal(v1[c].schema, SCHEMA_V1);
    assert.equal(v1[c].world.ends, false);
    assert.deepEqual(v1[c].boundaries, [{ index: 1, hour: 168 }, { index: 2, hour: 336 }]);
  }
});

test('v1 time and order: bells = hour × time.bellsPerHour (stated by ⑭), seq is the stream position', () => {
  const n = normalizeTowerFacts(v1.B);
  assert.equal(n.version, 1);
  assert.equal(n.bellsPerHour, 6);
  assert.match(n.bellsPerHourSource, /time\.bellsPerHour/);
  assert.deepEqual(n.problems, []);
  const { events, streams } = fromTowerFacts(v1.B, map);
  for (const e of events) {
    const f = v1.B.events[e.seq];
    assert.equal(e.at, f.hour * 6);
    assert.equal(e.verified, 'model', 'unverified model facts are never facts of the game');
  }
  assert.deepEqual(streams.ws14, { from: 0, through: v1.B.events.length - 1, kinds: streams.ws14.kinds });
});

test('v1 posting and answering: a request, a send, an arrival; poster and responder named', () => {
  const { events } = fromTowerFacts(v1.B, map);
  const n = k => v1.B.events.filter(f => f.kind === k).length;
  assert.equal(events.filter(e => e.kind === 'tower.sighting').length, 0, 'the tower watches nothing');
  assert.equal(events.filter(e => e.kind === 'tower.request.posted').length, n('tower.board_post'));
  const taken = events.filter(e => e.kind === 'tower.request.taken');
  assert.equal(taken.length, n('tower.board_taken'));
  assert.ok(taken.every(e => e.poster && e.poster !== e.actor));
  const ful = events.filter(e => e.kind === 'tower.request.fulfilled');
  assert.equal(ful.length, n('tower.board_fulfilled'));
  assert.ok(ful.every(e => e.responder));
  const v = evaluate(RULESETS.B, inputOf(v1.B, WHOLE));
  const helper = v.achievements.personal.filter(p => p.goal === 'P-board-helper' && p.subject);
  assert.ok(helper.some(p => p.status === 'model_only'));
  assert.ok(!helper.some(p => p.status === 'achieved'));
  assert.equal(v.awards.filter(a => a.goal === 'P-board-helper').length, 0);
  assert.equal(v.achievements.personal.find(p => p.goal === 'P-scout').status, 'not_offered');
});

test('the responder decides: a village that also took the request, but whose goods did not complete it, is not credited', () => {
  const ev = (seq, hour, kind, actor, nation, f = {}) => ({ seq, hour, kind, actor, nation, verified: 'unverified', ...f });
  const facts = {
    schema: SCHEMA_V1, world: { ends: false }, time: { unit: 'model hour', bellsPerHour: 6 }, boundaries: [],
    events: [
      ev(0, 1, 'tower.board_post', 1, 0, { req: 7 }),
      ev(1, 2, 'tower.board_taken', 2, 1, { req: 7, poster: 1, cross: true }),
      ev(2, 2, 'tower.board_taken', 3, 2, { req: 7, poster: 1, cross: true }),
      ev(3, 5, 'tower.board_fulfilled', 1, 0, { req: 7, responder: 3, cross: true }),
    ],
  };
  const v = evaluate(RULESETS.B, inputOf(facts, { id: 'w', opensAt: 0, endsAt: 100 }));
  const st = id => v.achievements.personal.find(p => p.goal === 'P-board-helper' && p.subject === id)?.status;
  assert.equal(st('v3'), 'model_only');
  assert.equal(st('v2'), 'not_achieved');
});

test('⑭\'s boundaries are reported, never made into windows; nothing closes at them', () => {
  const r = fromTowerFacts(v1.C, map);
  assert.equal('windows' in r, false);
  assert.deepEqual(r.boundaries.map(b => [b.index, b.hour, b.bell]), [[1, 168, 1008], [2, 336, 2016]]);
  const s = evaluateSeries(RULESETS.C, inputOf(v1.C, WHOLE));
  assert.equal(s.verdicts.length, 1, 'only the window the input gives');
  const v = s.verdicts[0];
  assert.equal(v.window.closeAt, WHOLE.endsAt);
  assert.equal(v.window.closedBy, 'schedule');
  assert.deepEqual(v.modelBoundaries.inWindow, [{ index: 1, at: 1008 }, { index: 2, at: 2016 }]);
  assert.equal(v.world.ends, false);
  assert.equal(v.prize.status, 'not_decided');
});

test('facts of a boundary\'s hour come after it (⑭ records the mark first), as the evaluator\'s half-open windows would place them', () => {
  for (const c of ['B', 'C']) {
    for (const b of v1[c].events.filter(f => f.kind === 'period.boundary')) {
      const same = v1[c].events.filter(f => f.hour === b.hour && f.kind !== 'period.boundary');
      assert.ok(same.every(f => f.seq > b.seq), `${c} hour ${b.hour}`);
    }
  }
});

test('case A (landmark only) carries nothing to judge: positions and marks only', () => {
  const { events } = fromTowerFacts(v1.A, map);
  assert.ok(events.every(e => e.kind === 'position' || e.kind === 'model.boundary'));
  const v = evaluate(RULESETS.B, inputOf(v1.A, WHOLE));
  assert.equal(v.awards.length, 0);
});

test('relay swaps (case C) are not uses of a joint structure', () => {
  const v = evaluate(RULESETS.B, inputOf(v1.C, WHOLE));
  assert.equal(v.achievements.joint[0].projects.length, 0);
  assert.equal(v.awards.length, 0);
});

test('contract breaches: a fact claiming to be verified is left out (a gap); no bellsPerHour is refused; a wrong seq is a problem', () => {
  const tampered = { ...v1.B, events: v1.B.events.map(e => (e.kind === 'tower.board_fulfilled' && e.seq < 600 ? { ...e, verified: 'chain' } : e)) };
  const r = fromTowerFacts(tampered, map);
  assert.ok(r.problems.length > 0 && r.problems.every(p => /unverified/.test(p.why)));
  const v = evaluate(RULESETS.B, inputOf(tampered, WHOLE));
  assert.ok(v.records.gaps.some(g => g.stream === 'ws14'));
  assert.ok(v.achievements.personal.some(p => p.goal === 'P-board-helper' && p.status === 'indeterminate'));
  assert.equal(v.scores.status, 'decided', 'a gap in the tower stream undecides only tower facts');
  assert.match(fromTowerFacts({ ...v1.B, time: {} }, map).refused, /bellsPerHour/);
  const shifted = { ...v1.B, events: v1.B.events.map((e, i) => (i === 3 ? { ...e, seq: 99 } : e)) };
  assert.ok(fromTowerFacts(shifted, map).problems.some(p => /not its position/.test(p.why)));
  assert.match(fromTowerFacts({ schema: 'wylls.ws14.tower-facts/2' }, map).refused, /neither/);
});

test('v0 is still read by the same path (t → hour, array order → seq, the documented 6 named)', () => {
  const n = normalizeTowerFacts(v0.B.facts);
  assert.equal(n.version, 0);
  assert.equal(v0.B.facts.schema, SCHEMA_V0);
  assert.match(n.bellsPerHourSource, /v0/);
  const { events } = fromTowerFacts(v0.B.facts, map);
  v0.B.facts.events.forEach((f, i) => assert.equal(events.find(e => e.seq === i).at, f.t * 6));
  assert.equal(events.filter(e => e.kind === 'tower.sighting').length, 0);
});

test('unknown villages are left out as gaps, not guessed', () => {
  const r = fromTowerFacts(v1.B, { actorOf: v => (v === 8 ? null : `v${v}`) });
  assert.ok(r.unresolved.length > 0 && r.unresolved.every(u => u.village === 8));
});
