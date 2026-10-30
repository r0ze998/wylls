// The seams to workstreams 4, 5 and 12: replaceable without changing the resident.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { small, run, tmp } from './helpers.mjs';
import { answerSchema, decideWithin, fixtureProvider, fromChatProvider, ProviderRefusal } from '../resident/ports/provider.mjs';
import { localMemory, trustOf } from '../resident/ports/memory.mjs';
import { assertPort } from '../resident/ports/execution.mjs';
import { assertNoApiKeys } from '../../../permutation-gateway/citizens/mind/guards.mjs';
import { decisionsOf } from '../demo/report.mjs';
import path from 'node:path';

const REQ = { turn: 1, bell: 1, system: 's', user: 'u', candidates: [{ id: 'wait', kind: 'wait', summary: 'w', score: 0 }, { id: 'build:3', kind: 'build', summary: 'b', score: 1 }], handles: ['M1'], schema: answerSchema(['wait', 'build:3'], ['M1']), limits: { maxOutputTokens: 50, deadlineMs: 100 } };

test('a workstream-5 chat provider plugs in through fromChatProvider; its JSON is checked like any answer; no network here', async () => {
  const asked = [];
  const chat = { complete: async q => { asked.push(q); return { text: JSON.stringify({ choice: 'build:3', reason: 'grow', mem: ['M1', 'M9'] }), usage: { inputTokens: 9, outputTokens: 3 }, model: 'm' }; } };
  const p = fromChatProvider(chat, { provider: 'claude', model: 'configured-by-ws5' });
  const a = await decideWithin(p, REQ);
  assert.deepEqual([a.choice, a.mem, a.provider, a.usage.inputTokens], ['build:3', ['M1'], 'claude', 9]);
  assert.deepEqual(Object.keys(asked[0]).sort(), ['maxOutputTokens', 'schema', 'system', 'user']);
  assert.deepEqual(asked[0].schema.properties.choice, { enum: ['wait', 'build:3'] });
  const bad = fromChatProvider({ complete: async () => ({ text: 'not json' }) }, { provider: 'gpt', model: 'x' });
  await assert.rejects(decideWithin(bad, REQ), e => e instanceof ProviderRefusal && e.code === 'Shape');
  const off = fromChatProvider({ complete: async () => ({ text: JSON.stringify({ choice: 'raid:everyone', reason: '', mem: [] }) }) }, { provider: 'gpt', model: 'x' });
  await assert.rejects(decideWithin(off, REQ), e => e.code === 'NotACandidate');
});

test('the demo refuses to start with a paid-API key in its environment (the citizens\' guard)', () => {
  assert.throws(() => assertNoApiKeys({ ANTHROPIC_API_KEY: 'x' }), /ApiKeyInEnv|paid-API key/);
  assert.throws(() => assertNoApiKeys({ OPENAI_API_KEY: 'x' }));
  assert.doesNotThrow(() => assertNoApiKeys({}));
});

test('memory: the local adapter keeps an episode once, survives a reopen, recalls with the citizens\' retrieval', () => {
  const f = path.join(tmp(), 'e.jsonl');
  const m = localMemory(f);
  const ep = { id: 'kept:1', bell: 5, kind: 'kept', importance: 3, entities: ['c2'], text: { en: 'x', ja: 'x' } };
  assert.equal(m.append(ep), true);
  assert.equal(m.append(ep), false);
  m.append({ id: 'broken:2', bell: 6, kind: 'broken', importance: 6, entities: ['c3'] });
  const again = localMemory(f);
  assert.equal(again.all().length, 2);
  assert.deepEqual(again.recall({ focus: ['c3'], bell: 6 }).map(e => e.id), ['kept:1', 'broken:2']);
  assert.deepEqual([trustOf(again, 'c2'), trustOf(again, 'c3')], [1, -2]);
  assert.throws(() => m.append({ id: 'x', bell: 1, kind: 'gossip', importance: 1, entities: [] }), /bad episode/);
});

test('memory is replaceable: an in-memory stand-in for workstream 12 with the same interface gives the same decisions', async () => {
  const stub = () => { const eps = new Map(); return { kind: 'ws12-stub', append: e => (eps.has(e.id) ? false : (eps.set(e.id, { v: 1, created_bell: e.bell, facts: {}, text: { en: '', ja: '' }, ...e }), true)), recall: () => [...eps.values()].sort((a, b) => a.bell - b.bell).slice(-8), all: () => [...eps.values()] }; };
  const play = async swap => {
    const env = await small({ residents: [{ id: 'ren', goal: 'surplus-use', pos: { q: 0, r: 0 } }], people: [{ name: 'Kou', pos: { q: 2, r: 0 },
      async script(bell, me) { if (bell === 4) await me.post({ kind: 'request', to: 'c1', want: { Food: 60 }, offer: { Ore: 60 }, deadlineBell: 30 }); } }] });
    if (swap) env.rs.ren.ports.memory = stub();
    await run(env, 60);
    return decisionsOf(env.rs.ren).map(d => [d.bell, d.choice.replace(/[0-9a-f]{16}/, 'ID')]);
  };
  assert.deepEqual(await play(true), await play(false));
});

test('execution and board ports are checked for their methods (a workstream-4 runner must offer submit, status, cancel)', async () => {
  const env = await small({ residents: [{ id: 'ren', pos: { q: 0, r: 0 } }] });
  assert.ok(assertPort('execution', env.rs.ren.ports.execution));
  assert.ok(assertPort('board', env.rs.ren.ports.board));
  assert.throws(() => assertPort('execution', { submit() {} }), /lacks status/);
  await run(env, 1);
  assert.equal(fixtureProvider().name, 'fixture:goal');
});
