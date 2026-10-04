// AC1a: the memory attach (sections 4.3, 5.2, 5.5): focus, handles, the mem enum, refs, goals_served.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryAttach, buildPeople, refScore, goalsServedDefault, MAX_REFS, MAX_PEOPLE } from '../citizens/mind/memory.mjs';
import { buildAnswerSchema, validateShape } from '../citizens/mind/schema.mjs';
import { checkMenu } from '../citizens/mind/validate.mjs';
import { loadWireFixture, renderMemoryDouble, makeStores, makeEpisode, TAGS } from './fixtures/ai-mind-doubles.mjs';

const { json: wire } = loadWireFixture();
const stores = (eps) => makeStores({ episodes: eps });
const own = (eps) => ({ tag: TAGS[0], bell: 40, persona: { id: 'conqueror' }, episodes: stores(eps).episodes(TAGS[0]), doc: { goals: [], grievances: [], trust: { citizens: {}, nations: {} } } });

test('focus = own tag, own nation, home pq, candidate entities, inbox senders, threat nations, extra entities', () => {
  let seen = null;
  const a = createMemoryAttach({ renderMemory: (os, focus, budget) => { seen = { os, focus, budget }; return { block: 'B', handles: {} }; } });
  a.attach({ ownState: own([]), request: wire.request, bell: 40, inboxTags: ['ffff000000000001'], threatNations: [4], extraEntities: ['pq:9,9'], budgetTokens: 600 });
  assert.deepEqual(seen.focus, [...new Set([TAGS[0], 'nation:0', 'pq:2,0', 'pq:1,1', 'ffff000000000001', 'nation:4', 'pq:9,9'])].sort());
  assert.equal(seen.budget.tokens, 600);
  assert.equal(seen.os.bell, 40);
});

test('refs: handles of episodes whose entities meet the candidate, best score first, at most 3; deterministic', () => {
  const eps = [1, 2, 3, 4, 5].map((i) => makeEpisode(i, { entities: ['pq:1,1', 'nation:3'], importance: i }));
  eps.push(makeEpisode(6, { entities: ['pq:7,7'], importance: 9 }));
  const a = createMemoryAttach({ renderMemory: renderMemoryDouble });
  const req = { situation: { me: { faction: 0, home: { p: 2, q: 0 } } }, candidates: [{ id: 'c1', kind: 'march', entities: ['pq:1,1'] }, { id: 'c2', kind: 'build:wood', entities: [] }, { id: 'c3', kind: 'march', entities: ['pq:7,7'] }] };
  const r1 = a.attach({ ownState: own(eps), request: req, bell: 100 });
  const r2 = a.attach({ ownState: own(eps), request: req, bell: 100 });
  assert.deepEqual(r1.candidates.map((c) => c.refs), r2.candidates.map((c) => c.refs));
  const c1 = r1.candidates[0];
  assert.equal(c1.refs.length, MAX_REFS);
  const scores = c1.refs.map((h) => refScore(own(eps).episodes.get(r1.handles[h]), ['pq:1,1'], 100));
  assert.deepEqual([...scores].sort((x, y) => y - x), scores, 'best score first');
  assert.deepEqual(r1.candidates[1].refs, []);
  assert.equal(r1.candidates[2].refs.length, 1);
  assert.equal(r1.candidates[2].goals_served.includes('G2'), true);
});

test('retrieved = the ids behind the handles in handle order; resolveMem drops unknown and repeated handles', () => {
  const eps = [1, 2, 3].map((i) => makeEpisode(i));
  const a = createMemoryAttach({ renderMemory: renderMemoryDouble });
  const r = a.attach({ ownState: own(eps), request: wire.request, bell: 100 });
  assert.deepEqual(r.retrieved, Object.keys(r.handles).map((h) => r.handles[h]));
  const m = a.resolveMem(['M2', 'M2', 'M9', 'x', 'M1'], r.handles);
  assert.deepEqual(m.ids, [r.handles.M2, r.handles.M1]);
  assert.equal(m.dropped, 3);
  const proto = a.resolveMem(['constructor', '__proto__', 'toString', 'M1'], r.handles);
  assert.deepEqual(proto.ids, [r.handles.M1]);
  assert.equal(proto.dropped, 3);
});

test('the mem enum of the answer schema equals the handles of the prompt; a handle outside it is dropped by V2 and counted', () => {
  const eps = [1, 2, 3].map((i) => makeEpisode(i));
  const a = createMemoryAttach({ renderMemory: renderMemoryDouble });
  const r = a.attach({ ownState: own(eps), request: wire.request, bell: 100 });
  const handles = Object.keys(r.handles);
  const spec = { kind: 'session', candidateIds: r.candidates.map((c) => c.id), handles, goalIds: ['G1'], paramsByCandidate: {} };
  assert.deepEqual(buildAnswerSchema(spec).properties.mem.items.enum, handles);
  const v = { goal_id: 'G1', choose: ['c2'], params: {}, say: [], council: null, trust: [], mem: ['M1', 'M9'], why: 'x' };
  assert.equal(validateShape(v, spec).ok, true, 'the grammar cannot emit M9; if it appears anyway V1 lets it through and V2 drops it');
  const m = checkMenu(v, { candidates: r.candidates, handles: r.handles });
  assert.equal(m.ok, true);
  assert.equal(m.mem.dropped, 1);
  assert.deepEqual(m.mem.ids, [r.handles.M1]);
});

test('an empty memory gives an empty handle list (mem maxItems 0) and the block says nothing is remembered', () => {
  const a = createMemoryAttach({ renderMemory: renderMemoryDouble });
  const r = a.attach({ ownState: own([]), request: wire.request, bell: 100 });
  assert.deepEqual(r.handles, {});
  assert.deepEqual(r.retrieved, []);
  assert.equal(buildAnswerSchema({ kind: 'session', candidateIds: ['c1'], handles: Object.keys(r.handles) }).properties.mem.maxItems, 0);
});

test('goals_served: the default table per persona and kind, or a function from AC2 goals.mjs', () => {
  assert.deepEqual(goalsServedDefault('conqueror', { kind: 'march' }), ['G2', 'G3', 'G4']);
  assert.deepEqual(goalsServedDefault('guardian', { kind: 'walls' }), ['G1']);
  assert.deepEqual(goalsServedDefault('founder', { kind: 'explore:H2' }), ['G2']);
  assert.deepEqual(goalsServedDefault('nobody', { kind: 'march' }), []);
  const a = createMemoryAttach({ renderMemory: renderMemoryDouble, goalsServed: (persona, c) => (c.kind === 'hold' ? ['G9'] : []) });
  const r = a.attach({ ownState: own([]), request: wire.request, bell: 100 });
  assert.deepEqual(r.candidates.find((c) => c.kind === 'hold').goals_served, ['G9']);
});

test('buildPeople: handles C1.. by first appearance, own tag excluded, capped, wallet kept when known', () => {
  const p = buildPeople([{ tag: 'b', name: 'B' }, { tag: TAGS[0] }, { tag: 'c', wallet: 'WC' }, { tag: 'b', wallet: 'WB' }], TAGS[0]);
  assert.deepEqual(p.people.map((x) => [x.handle, x.tag, x.wallet]), [['C1', 'b', 'WB'], ['C2', 'c', 'WC']]);
  assert.equal(p.handleOfTag('c'), 'C2');
  assert.equal(p.handleOfTag(TAGS[0]), null);
  const many = buildPeople(Array.from({ length: 30 }, (_, i) => ({ tag: `t${i}` })), 'x');
  assert.equal(many.people.length, MAX_PEOPLE);
});

test('attach needs renderMemory; the mind passes no async token counter', () => {
  assert.throws(() => createMemoryAttach({}), /renderMemory/);
});
