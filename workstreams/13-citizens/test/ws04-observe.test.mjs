// The read-only client of `runexec observe` (resident/ports/ws04-observe.mjs), with a fake execFile (2026-11-17).
// SOURCE-ONLY when written: not run in the session that wrote it. No process is started, nothing is read or written.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ws04ObserveClient } from '../resident/ports/ws04-observe.mjs';

const PAGE = { format: 'ws04-observation/0', basis: 'unproven', world: null, finality: null, complete: null, observations: [], next_local_cursor: 0, held: [] };
function fake(answer) {
  const calls = [];
  const execFile = (bin, args, opts, cb) => { calls.push({ bin, args, opts }); const [err, stdout] = answer(args); setImmediate(() => cb(err, stdout, '')); };
  return { calls, execFile };
}
const parse = text => JSON.parse(text);

test('store and db: the exact read-only arguments, no shell, the page as printed', async () => {
  const f = fake(() => [null, `${JSON.stringify(PAGE)}\n`]);
  const c = ws04ObserveClient({ bin: '/x/runexec', execFile: f.execFile, parse });
  assert.deepEqual(await c.store('/s', { after: 5, limit: '64' }), PAGE);
  assert.deepEqual(await c.db('/s/index.sqlite'), PAGE);
  assert.deepEqual(f.calls.map(x => x.args), [['observe', 'store', '--store', '/s', '--after', '5', '--limit', '64'], ['observe', 'db', '--db', '/s/index.sqlite']]);
  assert.ok(f.calls.every(x => x.bin === '/x/runexec' && x.opts.shell === false && x.opts.timeout > 0));
});

test("runexec's own error code is kept; anything else is Spawn; never NoRecord made up", async () => {
  for (const [answer, code] of [
    [() => [Object.assign(new Error('exit 1'), { code: 1 }), '{"error":"ObservationNotRead","message":"no store"}\n'], 'ObservationNotRead'],
    [() => [Object.assign(new Error('exit 2'), { code: 2 }), '{"error":"BadRequest","message":"x"}\n'], 'BadRequest'],
    [() => [Object.assign(new Error('ENOENT'), { code: 'ENOENT' }), ''], 'Spawn'],
    [() => [null, 'not json'], 'Spawn'],
    [() => [Object.assign(new Error('exit 101'), { code: 101 }), `${JSON.stringify(PAGE)}\n`], 'Spawn'],   // a page with a failed exit is not taken
  ]) {
    const c = ws04ObserveClient({ bin: 'r', execFile: fake(answer).execFile, parse });
    await assert.rejects(c.store('/s'), e => e.code === code && e.code !== 'NoRecord', code);
  }
});

test('bad arguments are refused before anything is started', async () => {
  const f = fake(() => [null, '{}']);
  const c = ws04ObserveClient({ bin: 'r', execFile: f.execFile, parse });
  for (const [dir, o] of [['', {}], ['--limit', {}], [null, {}], ['/s', { limit: 0 }], ['/s', { limit: 257 }], ['/s', { limit: '+5' }],
    ['/s', { after: -1 }], ['/s', { after: '9223372036854775808' }], ['/s', { after: 1.5 }], ['/s', { after: '1e3' }]]) {
    await assert.rejects(c.store(dir, o), e => e.code === 'BadRequest', JSON.stringify([dir, o]));
  }
  assert.deepEqual(f.calls, []);
  assert.throws(() => ws04ObserveClient({ bin: 'r', execFile: f.execFile }), TypeError, 'the parser must be handed in');
});

test('the client is not a resident port and imports nothing (pinned as text)', () => {
  const s = readFileSync(new URL('../resident/ports/ws04-observe.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(s, /^import /m);
  assert.doesNotMatch(s, /12-memory|shell: true|NoRecord'|send|submit|sign\(/);
  const r = readFileSync(new URL('../resident/resident.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(r, /ws04-observe/, 'the resident does not use it');
});
