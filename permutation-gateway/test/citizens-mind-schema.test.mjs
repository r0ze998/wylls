// AC1a: the answer schema (section 4.4), V1, the request parser and the golden wire fixture (section 4.1).
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAnswerSchema, buildReflectionSchema, validateShape, validateReflectionShape, kindBase, responseFormat } from '../citizens/mind/schema.mjs';
import { parseDecide, HttpError } from '../citizens/mind/api.mjs';
import { loadWireFixture } from './fixtures/ai-mind-doubles.mjs';

const spec = {
  kind: 'session', goalIds: ['G1', 'G2'], candidateIds: ['c1', 'c2', 'c3'],
  paramsByCandidate: { c3: { stance: ['hold', 'assault'], retreat: [0, 5000], timing: ['earliest'] } },
  handles: ['M1', 'M2'], who: ['C1', 'C2', 'N0'], direct: ['C1'], channels: ['world', 'nation', 'direct'],
};
const good = () => ({ goal_id: 'G1', choose: ['c3'], params: { c3: { stance: 'assault', retreat: 0, timing: 'earliest' } }, say: [], council: null, trust: [], mem: ['M1'], why: 'Because.' });

test('the schema carries this prompt\'s enums and fixed key order', () => {
  const s = buildAnswerSchema(spec);
  assert.deepEqual(Object.keys(s.properties), ['goal_id', 'choose', 'params', 'say', 'council', 'trust', 'mem', 'why']);
  assert.deepEqual(s.properties.choose.items.enum, ['c1', 'c2', 'c3']);
  assert.equal(s.properties.choose.minItems, 1);
  assert.equal(s.properties.choose.maxItems, 3);
  assert.deepEqual(s.properties.mem.items.enum, ['M1', 'M2']);
  assert.deepEqual(s.properties.goal_id.enum, ['G1', 'G2']);
  assert.deepEqual(s.properties.params.properties.c3.properties.retreat.enum, [0, 5000]);
  assert.equal(s.additionalProperties, false);
  assert.deepEqual(s.required, Object.keys(s.properties));
  assert.equal(responseFormat('decision', s).type, 'json_schema');
});

test('mem enum is empty (maxItems 0) when no Remembered line is shown', () => {
  const s = buildAnswerSchema({ ...spec, handles: [] });
  assert.equal(s.properties.mem.maxItems, 0);
  assert.equal(validateShape({ ...good(), mem: ['M1'] }, { ...spec, handles: [] }).ok, true, 'V1 does not police handles; V2 drops them');
});

test('reaction, motion and ballot menus', () => {
  const r = buildAnswerSchema({ ...spec, kind: 'reaction' });
  assert.equal(r.properties.choose.maxItems, 0);
  assert.equal(r.properties.say.maxItems, 2);
  const m = buildAnswerSchema({ ...spec, kind: 'motion', channels: ['nation'], motionOptions: [0, 1, 2, 3] });
  assert.equal(m.properties.say.maxItems, 1);
  assert.deepEqual(m.properties.council.properties.motion.enum, [0, 1, 2, 3]);
  const b = buildAnswerSchema({ ...spec, kind: 'ballot', ballotOptions: [0, 1, 2] });
  assert.equal(b.properties.say.maxItems, 0, 'ballot has no speech');
  assert.deepEqual(b.properties.council.properties.ballot.enum, [0, 1, 2]);
  assert.equal(buildAnswerSchema({ ...spec, maxSay: 0 }).properties.say.maxItems, 0, 'budget override');
});

test('V1 accepts a good answer and rejects each broken rule with a reason', () => {
  assert.equal(validateShape(good(), spec).ok, true);
  const bad = (patch, re) => {
    const r = validateShape({ ...good(), ...patch }, spec);
    assert.equal(r.ok, false, JSON.stringify(patch));
    assert.match(r.errors.join('|'), re);
  };
  bad({ choose: ['c1', 'c1'] }, /duplicate/);
  bad({ choose: [] }, /empty in a session/);
  bad({ choose: ['c1', 'c2', 'c3', 'c3'] }, /more than 3/);
  bad({ goal_id: 'G9' }, /goal_id/);
  bad({ why: '' }, /why/);
  bad({ why: 'x'.repeat(201) }, /why/);
  bad({ council: { motion: 1 } }, /council must be null/);
  bad({ trust: [{ who: 'C1', delta: 11 }] }, /delta/);
  bad({ trust: [{ who: 'C9', delta: 1 }] }, /who/);
  bad({ trust: [{ who: 'C1', delta: 1 }, { who: 'C2', delta: 1 }, { who: 'N0', delta: 1 }, { who: 'C1', delta: 1 }] }, /more than 3/);
  bad({ mem: ['M1', 'M2', 'M1', 'M2'] }, /more than 3/);
  bad({ say: [{ channel: 'world', text: 'a' }, { channel: 'world', text: 'b' }, { channel: 'world', text: 'c' }] }, /more than 2/);
  bad({ say: [{ channel: 'world', text: 'y'.repeat(281) }] }, /text length/);
  bad({ say: [{ channel: 'direct', to: 'C2', text: 'hi' }] }, /direct target/);
  bad({ say: [{ channel: 'world', to: 'C1', text: 'hi' }] }, /only with channel direct/);
  bad({ extra: 1 }, /unknown key/);
  assert.equal(validateShape({ ...good(), say: [{ channel: 'direct', to: 'C1', text: '日本語で挨拶' }] }, spec).ok, true);
  assert.equal(validateShape(null, spec).ok, false);
  assert.equal(validateShape({ goal_id: 'G1' }, spec).ok, false);
});

test('V1 for motion and ballot calls checks the council field and empties choose', () => {
  const ms = { ...spec, kind: 'motion', channels: ['nation'], motionOptions: [0, 1, 2] };
  const base = { goal_id: 'G1', choose: [], params: {}, say: [], council: { motion: 2 }, trust: [], mem: [], why: 'ok' };
  assert.equal(validateShape(base, ms).ok, true);
  assert.equal(validateShape({ ...base, council: { motion: 3 } }, ms).ok, false);
  assert.equal(validateShape({ ...base, council: null }, ms).ok, false);
  assert.equal(validateShape({ ...base, choose: ['c1'] }, ms).ok, false);
  const bs = { ...spec, kind: 'ballot', ballotOptions: [0, 1] };
  assert.equal(validateShape({ ...base, council: { ballot: 1 } }, bs).ok, true);
  assert.equal(validateShape({ ...base, council: { ballot: 1 }, say: [{ channel: 'nation', text: 'x' }] }, bs).ok, false, 'ballot has no speech');
});

test('reflection schema and V1', () => {
  const s = buildReflectionSchema({ goalIds: ['G1'], who: ['C1'] });
  assert.deepEqual(Object.keys(s.properties), ['summary', 'goal_ops', 'trust', 'mem']);
  assert.equal(validateReflectionShape({ summary: 'ok', goal_ops: [{ op: 'drop', id: 'G1' }], trust: [], mem: [] }, { goalIds: ['G1'] }).ok, true);
  assert.equal(validateReflectionShape({ summary: '', goal_ops: [], trust: [], mem: [] }, {}).ok, false);
  assert.equal(validateReflectionShape({ summary: 'x', goal_ops: [{ op: 'x', id: 'G1' }], trust: [], mem: [] }, {}).ok, false);
});

test('kindBase strips the candidate kind suffix', () => {
  assert.equal(kindBase('recall:H2'), 'recall');
  assert.equal(kindBase('build:wood'), 'build');
  assert.equal(kindBase('march'), 'march');
  assert.equal(kindBase(undefined), '');
});

test('the golden wire fixture: the request parses and the answers have the pinned shape', () => {
  const { json: f, source } = loadWireFixture();
  assert.ok(source);
  assert.equal(f.v, 1);
  const R = parseDecide(f.request);
  assert.equal(R.ai.tag, '1885b43b654f032b');
  assert.equal(R.candidates.length, 10);
  assert.deepEqual(R.wake_hints, ['W-READY', 'W-QUEUE']);
  assert.equal(R.situation.me.hosts[0].host_id, '123149597278209', 'u64 ids are decimal strings');
  for (const a of [f.answer, f.answer_autopilot]) {
    assert.equal(a.v, 1);
    assert.equal(typeof a.decision_id, 'string');
    assert.ok(['model', 'autopilot'].includes(a.mode));
    assert.ok(Array.isArray(a.choice.ids) && a.choice.ids.length > 0);
    assert.deepEqual(Object.keys(a.social).sort(), ['ballot', 'motion', 'say']);
    assert.deepEqual(Object.keys(a.standing).sort(), ['declined_calls', 'reserved']);
    assert.deepEqual(Object.keys(a.caps).sort(), ['home_floor', 'march_troops_left']);
  }
  assert.equal(f.outcome.actions[0].status, 'sent');
  assert.deepEqual(f.outcome_answer, { ok: true });
});

test('parseDecide refuses malformed requests with 400', () => {
  const { json: f } = loadWireFixture();
  const bad = (mut) => {
    const r = JSON.parse(JSON.stringify(f.request));
    mut(r);
    assert.throws(() => parseDecide(r), (e) => e instanceof HttpError && e.status === 400);
  };
  bad((r) => { r.v = 2; });
  bad((r) => { r.ai.tag = 'xyz'; });
  bad((r) => { delete r.situation; });
  bad((r) => { r.candidates = r.candidates.concat(r.candidates); });
  bad((r) => { r.candidates[1].id = 'c1'; });
  bad((r) => { r.candidates[0].id = 'x1'; });
  bad((r) => { r.bell = -1; });
  assert.throws(() => parseDecide(null));
});
