// The read-only result port over workstream 4's act registry, and its assembly in the live factory (2026-11-17.
// WRITTEN ONLY, NOT RUN). A fake acts client only: no runexec, no store, no wallet, no network, no key.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ws04ActsStatusPort, REGISTRY_KIND } from '../resident/ports/ws04-acts-status.mjs';
import { Unqueryable } from '../resident/ports/ws04-acts.mjs';
import { provenanceMismatch } from '../resident/live/resident-state.mjs';
import { bindingMismatchOf } from '../resident/resident.mjs';

const fake = answers => {
  const calls = { status: [], register: 0 };
  return { calls, register: async () => { calls.register += 1; throw new Error('never'); },
    status: async q => { calls.status.push(q); const a = answers[q.key]; if (a instanceof Error) throw a; return a; } };
};
const err = (code, message = code) => Object.assign(new Error(message), { code });
const port = (acts, o = {}) => ws04ActsStatusPort(acts, { agentId: 'asa', registry: 'runexec-store:/srv/ws04/runs.db', ...o });

test('status only: no submit, register, cancel or send; the origin is the stated one, fixed', () => {
  const p = port(fake({}));
  assert.deepEqual(Object.keys(p).sort(), ['access', 'kind', 'origin', 'status']);
  assert.equal(p.access, 'status-only');
  assert.deepEqual(p.origin, { kind: REGISTRY_KIND, registry: 'runexec-store:/srv/ws04/runs.db', agentId: 'asa' });
  assert.ok(Object.isFrozen(p) && Object.isFrozen(p.origin));
  for (const o of [{ registry: undefined }, { registry: '' }, { registry: 'two words' }, { registry: 'x'.repeat(257) }, { agentId: '' }, { agentId: 'a'.repeat(65) }]) assert.throws(() => port(fake({}), o), TypeError, JSON.stringify(o));
  assert.throws(() => ws04ActsStatusPort({}, { agentId: 'asa', registry: 'r' }), TypeError, 'a client with status()');
});

test("answers: null only for workstream 4's NoRecord; unknown stays unknown; Duplicate is not this key's success; failures are Unqueryable", async () => {
  const acts = fake({
    landed: { state: 'landed', signature: 'S1', commitment: 'finalized', final: true },
    unk: { state: 'unknown' }, reg: { state: 'registered' }, exp: { state: 'expired' }, ns: { state: 'not-sent' },
    dup: { state: 'landed', code: 'Duplicate', signature: 'Searlier' },
    unq: { state: 'unqueryable', why: 'wallet down' }, weird: { state: 'settled?' },
    nr: err('NoRecord'), spawn: err('Spawn', 'runexec said NoRecord without its exit 3 (exit 1): no answer'), store: err('StoreError'),
  });
  const p = port(acts);
  assert.equal((await p.status('landed')).fate, 'landed');
  assert.equal((await p.status('landed')).ws04.commitment, 'finalized', 'commitment kept, not decided here');
  assert.equal((await p.status('unk')).fate, 'unknown');
  assert.equal((await p.status('reg')).fate, 'pending');
  assert.equal((await p.status('exp')).fate, 'expired', 'expired is not folded into another state');
  assert.equal((await p.status('ns')).status, 'refused');
  const d = await p.status('dup');
  assert.equal(d.fate, 'failed');
  assert.equal(d.duplicate, true);
  assert.equal(d.signature, undefined, "the earlier send's signature is not this key's");
  assert.equal(await p.status('nr'), null);
  for (const k of ['spawn', 'store', 'unq', 'weird']) await assert.rejects(p.status(k), Unqueryable, k);
  await assert.rejects(p.status(''), Unqueryable);
  await assert.rejects(p.status('k'.repeat(129)), Unqueryable);
  assert.equal(acts.calls.register, 0, 'never registers');
  assert.ok(acts.calls.status.every(q => q.agentId === 'asa'), 'always its own agent id');
});

test('matching: a line recorded under the same stated registry and agent matches; another registry or a kind label alone does not', () => {
  const p = port(fake({}));
  const rec = { v: 1, world: { cluster: 'localnet', world_id: 'Prog/Sea' }, clock: 'season-bell:1000:60', execution: { registry: 'runexec-store:/srv/ws04/runs.db', agentId: 'asa', kind: REGISTRY_KIND }, identity: 'Me1' };
  const live = { world: rec.world, clock: rec.clock, execution: p.origin };
  assert.equal(provenanceMismatch(rec, live, 'Me1'), null);
  assert.equal(bindingMismatchOf(rec, { ...rec, execution: p.origin }, 'action'), null);
  assert.match(provenanceMismatch({ ...rec, execution: { ...rec.execution, registry: 'runexec-store:/other/runs.db' } }, live, 'Me1'), /another execution registry/);
  assert.match(provenanceMismatch({ ...rec, execution: { kind: REGISTRY_KIND } }, live, 'Me1'), /no declared execution registry/);
});

test('the port and the factory (as text): the side effect is said; the factory builds it from explicit settings with no IO', () => {
  const src = readFileSync(new URL('../resident/ports/ws04-acts-status.mjs', import.meta.url), 'utf8');
  assert.match(src, /RECORDS that answer/, 'a status read with a gateway port writes the registry\'s own store: said');
  assert.doesNotMatch(src.replace(/\/\/[^\n]*/g, ''), /\.register\(|\.submit\(|\.cancel\(|send\(|execFile|spawn\(/, 'nothing but status');
  const f = readFileSync(new URL('../resident/live/factory.mjs', import.meta.url), 'utf8');
  assert.match(f, /import \{ createActsClient \} from '\.\.\/\.\.\/\.\.\/04-execution\/clients\/acts\.mjs';/);
  assert.match(f, /if \(execution\) throw new TypeError\('give either execution or actsStatus, not both'\);/);
  assert.match(f, /!bin\.startsWith\('\/'\) \|\| typeof db !== 'string' \|\| !db\.startsWith\('\/'\)\) throw new TypeError/);
  assert.match(f, /execution = ws04ActsStatusPort\(createActsClient\(\{ bin, db, gatewayPort, bridge: bridge === true \}\), \{ agentId, registry \}\);/);
  const create = f.slice(f.indexOf('export function createLiveResident('), f.indexOf('const observe = '));
  assert.doesNotMatch(create, /await |\.status\(|\.get\(/, 'nothing read or run at creation');
});
