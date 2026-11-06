// The resident's execution port over workstream 4's act registry (resident/ports/ws04-acts.mjs).
//   - always: against a fake registry client (keyless, nothing spawned);
//   - with WS04_ACTS_CLIENT (workstream 4's clients/acts.mjs, 95686606) and RUNEXEC_BIN (its runexec, built from the
//     same commit): against the real registry, a SQLite file in a temp directory, reading a scripted GET
//     /f/agent/fate on 127.0.0.1 that answers from the test world. No wallet, no key, nothing signed: the registry's
//     `act` command only records and reads (workstreams/04-execution/src/acts.rs has no key code).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { small, run } from './helpers.mjs';
import { ws04ActsPort, fateOfReceipt, Unqueryable } from '../resident/ports/ws04-acts.mjs';
import { assertPort } from '../resident/ports/execution.mjs';

const one = () => small({ residents: [{ id: 'ren', goal: 'village-first', pos: { q: 0, r: 0 } }] });
const firstBuild = ren => Object.values(ren.state.journal).find(j => j.purpose?.type === 'build');
const family = (keys, base) => keys.filter(k => k === base || k.startsWith(`${base}#`));

test('receipts keep the seven states; registered waits; unqueryable and unknown names throw', () => {
  const f = s => fateOfReceipt({ state: s, run4Id: 'r1', next: 'x', newAttemptAllowed: s === 'expired' || s === 'not-sent' });
  assert.deepEqual(['landed', 'failed', 'expired', 'not-sent', 'pending', 'unknown', 'registered'].map(s => f(s).fate), ['landed', 'failed', 'expired', 'not-sent', 'pending', 'unknown', 'pending']);
  assert.equal(f('not-sent').status, 'refused');
  assert.equal(f('expired').ws04.newAttemptAllowed, true);
  assert.throws(() => f('unqueryable'), Unqueryable);
  assert.throws(() => f('cancelled'), Unqueryable, 'not a workstream 4 state: not guessed');
});

test('the port declares retention for good, registers before sending, and NoRecord alone is null', async () => {
  const calls = [];
  const acts = {
    async register(a) { calls.push(['register', a.key, a.source]); return { state: 'registered' }; },
    async status({ key }) { if (key === 'never') throw Object.assign(new Error('no record'), { code: 'NoRecord' }); if (key === 'down') throw Object.assign(new Error('spawn'), { code: 'Spawn' }); return { state: 'landed' }; },
  };
  const port = ws04ActsPort(acts, { agentId: 'ren', send: async req => { calls.push(['send', req.idempotencyKey]); return { ok: true, status: 'sent' }; } });
  assertPort('execution', port);
  assert.equal(port.retentionBells, Infinity);
  await port.submit({ idempotencyKey: 'ren:t1:0', action: {} });
  assert.deepEqual(calls, [['register', 'ren:t1:0', 'resident'], ['send', 'ren:t1:0']]);
  assert.equal(await port.status('never'), null);
  await assert.rejects(port.status('down'), Unqueryable);
  assert.equal((await port.status('k')).fate, 'landed');
  assert.throws(() => ws04ActsPort(acts, { agentId: 'ren' }), /send/);
  assert.throws(() => ws04ActsPort(acts, { agentId: 'x'.repeat(65), send: async () => ({}) }), /64/);
  ws04ActsPort(acts, { agentId: 'x'.repeat(64), send: async () => ({}) });
  calls.length = 0;
  assert.equal((await port.submit({ idempotencyKey: 'k'.repeat(129), action: {} })).error.code, 'BadKey');
  assert.deepEqual(calls, [], 'neither registered nor sent');
});

// ---- the real registry -------------------------------------------------------------------------------------------
const CLIENT = process.env.WS04_ACTS_CLIENT, BIN = process.env.RUNEXEC_BIN;
const REAL = CLIENT && BIN ? false : 'set WS04_ACTS_CLIENT (workstream 4 clients/acts.mjs) and RUNEXEC_BIN (its runexec)';

/** A scripted GET /f/agent/fate: the test world's answer as workstream 4's wallet states, or `override(key)`. */
function fateServer(world, actor, override) {
  const reads = [];
  return new Promise(resolve => {
    const s = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://x');
      const key = u.searchParams.get('key');
      reads.push(key);
      let v = override(key);
      if (v === undefined) {
        const w = world.status(key, actor);
        v = !w ? { state: 'not-sent', sent: false } : { state: { cancelled: 'expired' }[w.fate] ?? w.fate, sent: true, signature: w.signature ?? null, why: w.fateError ?? null, commitment: w.fate === 'landed' ? 'finalized' : 'confirmed' };
      }
      res.writeHead(v ? 200 : 503, { 'content-type': 'application/json' });
      res.end(JSON.stringify(v ?? { error: 'Unavailable' }));
    });
    s.listen(0, '127.0.0.1', () => resolve({ s, reads }));
  });
}

async function withRegistry(override, bells) {
  const { createActsClient } = await import(pathToFileURL(path.resolve(CLIENT)).href);
  const env = await one();
  const ren = env.rs.ren;
  const world = ren.ports.execution;
  const sent = [];
  const { s, reads } = await fateServer(env.world, ren.address, override);
  try {
    const acts = createActsClient({ bin: BIN, db: path.join(mkdtempSync(path.join(os.tmpdir(), 'ws13-acts-')), 'runs.db'), gatewayPort: s.address().port });
    ren.ports.execution = ws04ActsPort(acts, { agentId: ren.address, runId: 'ws13-test', send: async req => { sent.push(req.idempotencyKey); return world.submit(req); } });
    await run(env, bells);
    return { env, ren, sent, reads, list: await acts.list('ws13-test') };
  } finally { s.close(); }
}

test('real registry: a build is registered, sent once, read through runexec and lands', { skip: REAL, timeout: 120_000 }, async () => {
  const { ren, sent, list } = await withRegistry(() => undefined, 12);
  const it = firstBuild(ren);
  assert.equal(it.state, 'landed');
  assert.deepEqual(family(sent, it.key), [it.key]);
  const row = list.acts.find(a => a.idempotencyKey === it.key);
  assert.deepEqual([row.source, row.state], ['resident', 'landed']);
  assert.equal(row.commitment, 'finalized', 'the commitment the scripted wallet reported is kept by 4');
});

test('real registry: "unknown" from the wallet is held and never sent again', { skip: REAL, timeout: 120_000 }, async () => {
  let base = null;
  const { ren, sent, list } = await withRegistry(k => { base ??= k; return k === base ? { state: 'unknown', sent: true, signature: 'sigU' } : undefined; }, 25);
  const it = Object.values(ren.state.journal).find(j => j.key === base);
  assert.equal(it.state, 'sent');
  assert.deepEqual(family(sent, base), [base]);
  assert.equal(list.acts.find(a => a.idempotencyKey === base).state, 'unknown');
});

test('real registry: "expired" allows one new attempt under a new key; an unreadable wallet is read again', { skip: REAL, timeout: 120_000 }, async () => {
  let base = null, down = 3;
  const { ren, sent, list } = await withRegistry(k => {
    base ??= k;
    if (k === base && down > 0) { down--; return null; } // 503: the registry records unqueryable
    return k === base ? { state: 'expired', sent: true, signature: 'sigE' } : undefined;
  }, 30);
  assert.deepEqual(family(sent, base), [base, `${base}#a2`]);
  assert.equal(Object.values(ren.state.journal).find(j => j.key === base || j.key === `${base}#a2`)?.state ?? firstBuild(ren).state, 'landed');
  assert.deepEqual(list.acts.filter(a => family([a.idempotencyKey], base).length)
    .map(a => [a.idempotencyKey, a.state]).sort((x, y) => x[0].length - y[0].length), [[base, 'expired'], [`${base}#a2`, 'landed']]);
});
