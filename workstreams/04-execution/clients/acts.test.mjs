// The JS client of workstream 04's act registry, against the real `runexec` binary and a scripted
// GET /f/agent/fate on loopback. No keys, nothing signed, nothing sent.
//
//   RUNEXEC_BIN=<path to runexec> node --test workstreams/04-execution/clients/acts.test.mjs
//   (cargo build in workstreams/04-execution first; skipped without RUNEXEC_BIN)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createActsClient, mayStartNewAttempt, statusFor13, toP05Act, ActsError } from './acts.mjs';

const bin = process.env.RUNEXEC_BIN;
const skip = bin ? false : 'set RUNEXEC_BIN to the runexec binary';

function fateServer(byKey) {
  return new Promise(resolve => {
    const s = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://x');
      const v = u.pathname === '/f/agent/fate' ? byKey[u.searchParams.get('key')] : undefined;
      res.writeHead(v ? 200 : 404, { 'content-type': 'application/json' });
      res.end(JSON.stringify(v ?? { error: 'UnknownAgent' }));
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}
const signed = state => ({ state, sent: true, signature: 'sigA', lastValidBlockHeight: 5000, slotFloor: 4000, signedAt: 1762000000000, commitment: state === 'landed' ? 'finalized' : 'confirmed', why: state });
const db = () => path.join(mkdtempSync(path.join(os.tmpdir(), 'ws04-acts-')), 'runs.db');

test('register, then status reads the wallet once and records it', { skip }, async () => {
  const srv = await fateServer({ 'ai:p05.r1': signed('landed') });
  try {
    const c = createActsClient({ bin, db: db(), gatewayPort: srv.address().port });
    const r = await c.register({ agentId: 'agent1', key: 'ai:p05.r1', source: 'ai', runId: 'p05-run-1' });
    assert.equal(r.state, 'registered');
    const s = await c.status({ agentId: 'agent1', key: 'ai:p05.r1' });
    assert.deepEqual([s.state, s.next, s.signature, s.commitment], ['landed', 'done', 'sigA', 'finalized']);
    assert.equal(mayStartNewAttempt(s), false);
    const p = toP05Act(s);
    assert.deepEqual([p.run4Id, p.signedAt, p.cancel.until.lastValidBlockHeight], [r.run4Id, 1762000000000, 5000]);
    assert.equal((await c.list('p05-run-1')).acts.length, 1);
  } finally { srv.close(); }
});

test('result unknown holds; expired and not-sent alone allow a new attempt; unreadable reads again', { skip }, async () => {
  const srv = await fateServer({ 'ai:u': signed('unknown'), 'ai:e': signed('expired'), 'ai:n': { state: 'not-sent', sent: false } });
  try {
    const c = createActsClient({ bin, db: db(), gatewayPort: srv.address().port });
    const st = async key => { await c.register({ agentId: 'a', key, source: 'ai' }); return c.status({ agentId: 'a', key }); };
    const u = await st('ai:u');
    assert.deepEqual([u.state, u.next, mayStartNewAttempt(u)], ['unknown', 'hold', false]);
    assert.equal(mayStartNewAttempt(await st('ai:e')), true);
    assert.equal(mayStartNewAttempt(await st('ai:n')), true);
    const g = await st('ai:missing');
    assert.deepEqual([g.state, g.next, mayStartNewAttempt(g)], ['unqueryable', 'read-again', false]);
  } finally { srv.close(); }
});

test('workstream 13: null only for no record; unknown stays unknown; unreadable throws', { skip }, async () => {
  const srv = await fateServer({ 'resident:t3:0': signed('unknown'), 'resident:t3:1': signed('expired') });
  const port = srv.address().port;
  const file = db();
  try {
    const c = createActsClient({ bin, db: file, gatewayPort: port });
    assert.equal(await statusFor13(c, 'res1', 'resident:t9:0'), null, 'never registered');
    await c.register({ agentId: 'res1', key: 'resident:t3:0', source: 'resident' });
    await c.register({ agentId: 'res1', key: 'resident:t3:1', source: 'resident' });
    assert.equal((await statusFor13(c, 'res1', 'resident:t3:0')).fate, 'unknown');
    assert.equal((await statusFor13(c, 'res1', 'resident:t3:1')).fate, 'cancelled');
    await c.register({ agentId: 'res1', key: 'resident:t3:2', source: 'resident' });
    await assert.rejects(statusFor13(c, 'res1', 'resident:t3:2'), e => e instanceof ActsError && e.code === 'Unqueryable');
  } finally { srv.close(); }
});

test('refusals carry the command\'s code', { skip }, async () => {
  const c = createActsClient({ bin, db: db() });
  await assert.rejects(c.register({ agentId: 'a', key: 'k', source: 'nobody' }), e => e.code === 'BadRequest');
  await c.register({ agentId: 'a', key: 'k', source: 'mcp' });
  await assert.rejects(c.register({ agentId: 'a', key: 'k', source: 'ai' }), e => e.code === 'Conflict');
  await assert.rejects(c.status({ agentId: 'a', key: 'never' }), e => e.code === 'NoRecord');
});
