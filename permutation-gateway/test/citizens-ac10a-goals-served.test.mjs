// AC10a, ruling R7 (contract v1.3 section 4.3): `goals_served` of a candidate comes from persona/goals.mjs ONLY. The second table that
// wave A left in mind/memory.mjs (keyed by persona id) is removed; these tests fail if a second table comes back or if the one
// table and the persona library drift apart.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LIBRARY } from '../citizens/persona/deal.mjs';
import * as goalsReal from '../citizens/persona/goals.mjs';
import { createMemoryAttach } from '../citizens/mind/memory.mjs';
import { renderMemoryDouble, makeStores, loadWireFixture, TAGS } from './fixtures/ai-mind-doubles.mjs';

const GOALS_PATH = new URL('../citizens/persona/goals.mjs', import.meta.url).pathname;
const MEMORY_PATH = new URL('../citizens/mind/memory.mjs', import.meta.url).pathname;
const { json: wire } = loadWireFixture();

// every base kind a candidate can have (contract 4.3; brain.rs and recall.rs): the golden fixture's kinds are a subset
const KINDS = ['autopilot', 'hold', 'march', 'recall', 'build', 'walls', 'train', 'muster', 'explore'];

/** The drift check: what is wrong between a goals module and the library. [] when they agree. */
function drift(mod, library = LIBRARY) {
  const out = [];
  const libraryKeys = new Set(library.personas.flatMap((p) => p.goals.map((g) => g.key)));
  for (const k of libraryKeys) if (!Object.hasOwn(mod.GOAL_SERVES, k)) out.push(`library goal "${k}" has no GOAL_SERVES entry`);
  for (const k of Object.keys(mod.GOAL_SERVES)) if (!libraryKeys.has(k)) out.push(`GOAL_SERVES entry "${k}" names a goal no persona has`);
  for (const k of Object.keys(mod.GOALS)) if (!Object.hasOwn(mod.GOAL_SERVES, k)) out.push(`goal function "${k}" has no GOAL_SERVES entry`);
  for (const [k, kinds] of Object.entries(mod.GOAL_SERVES)) for (const kind of kinds) if (!KINDS.includes(kind)) out.push(`GOAL_SERVES["${k}"] names the unknown kind "${kind}"`);
  // every persona must have at least one goal that some action kind advances (otherwise "serves" never prints for it)
  for (const p of library.personas) if (!p.goals.some((g) => mod.GOAL_SERVES[g.key]?.length)) out.push(`persona "${p.id}" has no goal that any action advances`);
  return out;
}

const personaOf = (id) => ({ id, goals: LIBRARY.personas.find((p) => p.id === id).goals });
const ownState = (persona) => ({ tag: TAGS[0], bell: 40, persona, episodes: makeStores({ episodes: [] }).episodes(TAGS[0]), doc: { goals: [], grievances: [], trust: { citizens: {}, nations: {} } } });
const attachGoals = (persona, kind, attach = createMemoryAttach({ renderMemory: renderMemoryDouble })) =>
  attach.attach({ ownState: ownState(persona), request: { situation: wire.request.situation, candidates: [{ id: 'c1', kind, entities: [] }] }, bell: 100 }).candidates[0].goals_served;

test('R7: goals.mjs and the persona library agree: every goal key has a goals_served entry and the reverse; kinds are real candidate kinds', () => {
  assert.deepEqual(drift(goalsReal), []);
  assert.ok(wire.request.candidates.every((c) => KINDS.includes(String(c.kind).split(':')[0])), 'the golden fixture\'s kinds are in the kind list');
});

test('R7 drift check is not vacuous: a copy of goals.mjs with an entry removed, an extra entry, or an unknown kind is reported', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ac10a-goals-'));
  const src = readFileSync(GOALS_PATH, 'utf8');
  const A = "  two_armies: Object.freeze(['train', 'muster']),";
  assert.ok(src.includes(A));
  const mutants = {
    'an entry removed': [src.replace(A, ''), /two_armies" has no GOAL_SERVES entry/],
    'an entry for a goal nobody has': [src.replace(A, `${A}\n  nobody_has_this: Object.freeze(['march']),`), /nobody_has_this" names a goal no persona has/],
    'an unknown kind': [src.replace(A, "  two_armies: Object.freeze(['train', 'teleport']),"), /unknown kind "teleport"/],
  };
  let i = 0;
  for (const [name, [text, re]] of Object.entries(mutants)) {
    assert.notEqual(text, src, name);
    const f = join(dir, `goals-mut-${i++}.mjs`);
    writeFileSync(f, text);
    const problems = drift(await import(pathToFileURL(f).href));
    assert.ok(problems.some((p) => re.test(p)), `${name}: ${JSON.stringify(problems)}`);
  }
});

test('R7: mind/memory.mjs holds no goal table of its own (no persona id, no kind table, no goalsServedDefault) and imports goals.mjs', () => {
  const src = readFileSync(MEMORY_PATH, 'utf8');
  for (const p of LIBRARY.personas) assert.equal(src.includes(p.id), false, `memory.mjs must not name the persona "${p.id}"`);
  assert.equal(/KIND_GOALS|goalsServedDefault/.test(src), false);
  assert.match(src, /from '\.\.\/persona\/goals\.mjs'/);
});

test('R7: the attach reads the persona\'s goal ids and keys through goals.mjs: the persona id is ignored', () => {
  // a persona id that no table could know, with goal G7 = march_daily: a march serves G7
  assert.deepEqual(attachGoals({ id: 'unlisted', goals: [{ id: 'G7', key: 'march_daily' }] }, 'march:camp'), ['G7']);
  // the id "conqueror" with another set of goals: only those goals count
  assert.deepEqual(attachGoals({ id: 'conqueror', goals: [{ id: 'G1', key: 'walls_600' }] }, 'march'), []);
  assert.deepEqual(attachGoals({ id: 'conqueror', goals: [{ id: 'G1', key: 'walls_600' }] }, 'walls'), ['G1']);
  // no goals, an unknown key or a missing persona serve nothing
  assert.deepEqual(attachGoals({ id: 'conqueror' }, 'march'), []);
  assert.deepEqual(attachGoals({ id: 'x', goals: [{ id: 'G1', key: 'not_a_goal' }] }, 'march'), []);
  assert.deepEqual(attachGoals(null, 'march'), []);
});

test('R7: for every persona and kind the attach equals goals.mjs goalsServed (goal order), and the answers are what wave A\'s table said (as sets)', () => {
  // the wave-A table of mind/memory.mjs, copied here ONLY as the regression oracle of the move (it is deleted from the code)
  const WAVE_A = {
    conqueror: { march: ['G2', 'G3', 'G4'], train: ['G1'], muster: ['G1'] },
    guardian: { walls: ['G1'], hold: ['G2', 'G3'], recall: ['G4', 'G3'], train: ['G2'], muster: ['G3'] },
    diplomat: { build: ['G4'] },
    avenger: { march: ['G1'], hold: ['G2'], train: ['G4'], muster: ['G4'], recall: ['G2'] },
    founder: { build: ['G1', 'G3'], explore: ['G2'], hold: ['G4'], walls: ['G1'], train: ['G4'] },
    opportunist: { march: ['G1', 'G2', 'G3'], build: ['G4'] },
  };
  for (const p of LIBRARY.personas) {
    for (const kind of KINDS) {
      const got = attachGoals(personaOf(p.id), kind === 'build' ? 'build:wood' : kind);
      assert.deepEqual(got, goalsReal.goalsServed(personaOf(p.id), { kind }), `${p.id} ${kind}`);
      assert.deepEqual([...got].sort(), [...(WAVE_A[p.id]?.[kind] ?? [])].sort(), `${p.id} ${kind}: same set as wave A`);
      assert.deepEqual(got, [...got].sort(), 'goal order');
    }
  }
});

test('R7: baseKind and goalsServed on the kinds the brain emits ("march:camp", "build:wood", "explore:H2", "recall:H1")', () => {
  assert.equal(goalsReal.baseKind('build:wood'), 'build');
  assert.equal(goalsReal.baseKind(undefined), '');
  assert.deepEqual(goalsReal.goalsServed(personaOf('founder'), { kind: 'build:wood' }), ['G1', 'G3']);
  assert.deepEqual(goalsReal.goalsServed(personaOf('guardian'), { kind: 'recall:H1' }), ['G3', 'G4']);
  assert.deepEqual(goalsReal.goalsServed(personaOf('conqueror'), { kind: 'autopilot' }), []);
});
