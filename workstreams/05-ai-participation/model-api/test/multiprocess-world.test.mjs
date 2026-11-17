// P5 and P7 of the multi-process suite: the autopilot over the shared ledger and the process lease, END TO END over
// the local relay fixture. NOT KEY-FREE: the fixture creates test keypairs in memory and its relay signs the agent's
// transactions (never written, no real chain or wallet). Kept apart from multiprocess.test.mjs (key-free).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileCostLedger } from '../src/cost-store.mjs';
import { ProcessLease } from '../src/process-lease.mjs';
import { statusOf } from '../src/status-query.mjs';

const WORKER = fileURLToPath(new URL('./procs/ledger-worker.mjs', import.meta.url));
const dirOf = () => mkdtempSync(join(tmpdir(), 'p05-mp-'));
function run(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [WORKER, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; });
    p.on('error', reject);
    p.on('close', (code, signal) => resolve({ code, signal, lines: out.split('\n').filter(Boolean).map(l => JSON.parse(l)), err }));
  });
}

test('P5 the autopilot over the shared ledger and lease: a tick end to end; another process cannot start it; after a takeover it stops with no model call', async () => {
  const { createLocalWorld, northernRequests } = await import('../../src/local-world.mjs');
  const { RunJournal } = await import('../../src/adapters.mjs');
  const { mandateFor } = await import('../../test/helpers.mjs');
  const { createAgentMcp } = await import('../../src/deps.mjs');
  const { openaiAdapter } = await import('../src/adapters.mjs');
  const { apiDecider } = await import('../src/api-decider.mjs');
  const { Autopilot } = await import('../src/autopilot.mjs');
  const { loopbackTransport } = await import('../src/http-transport.mjs');
  const { DecisionRegistry } = await import('../src/inference.mjs');
  const { FIXTURE_BOOK } = await import('../src/price-book.mjs');
  const { startHttpFixture } = await import('../fixture/http-fixture.mjs');
  const { tokenCheck } = await import('./relay-tree.mjs');
  const dir = dirOf();
  const srv = await startHttpFixture(body => { const u = JSON.parse(body.input.find(m => m.role === 'user').content); const r = u.requests[0]; return { answer: { proposals: r ? [{ request: r.id, action: 'Train', fields: { unit: 0, n: 100 }, reason: 'one batch' }] : [], skipped: [] } }; });
  try {
    const w = await createLocalWorld({ stores: { Food: 5000, Wood: 100, Stone: 100, Ore: 2000, Gold: 1000 } });
    const b = northernRequests()[0];
    w.board.splice(0, w.board.length, ...[1, 2, 3].map(i => ({ ...b, id: `R-${i}`, deadlineSec: w.state.clock + 86_400, ask: { kind: 'train', unit: 0, n: 100 } })));
    const now = () => w.state.clock * 1000;
    const lease = new ProcessLease({ dir, agentId: w.agentId, ttlMs: 300 });
    const costs = new FileCostLedger({ dir, init: { available: '100000', caps: { total: '50000' } }, lease, now });
    const mcp = () => createAgentMcp({ relay: 'http://relay.test', agentId: w.agentId, capability: w.capability, fetch: w.fetch, source: 'ai' });
    let ap;
    const decider = apiDecider({ adapter: openaiAdapter, model: 'gpt-fixture-model', transport: loopbackTransport({ baseUrl: srv.url }), book: FIXTURE_BOOK(), costs, registry: new DecisionRegistry(), runId: () => ap.currentRun, sleep: async () => {} });
    const journal = new RunJournal({ now });
    ap = new Autopilot({ world: w, mandate: mandateFor(w, { allowed: ['Train'], expiresAt: w.state.clock + 86_400 }), decider, journal, mcp, tokenCheck: tokenCheck(), lease });
    await ap.start({ by: 'owner' });
    const t = await ap.tick();
    assert.equal(t.game[0].outcome, 'sent');
    // Another process sees the same ledger: the call this process made is settled there.
    const seen = new FileCostLedger({ dir }).classes();
    assert.equal(seen.settled, costs.classes().settled);
    assert.notEqual(seen.settled, '0');
    // Another process cannot start this agent while this one is live.
    const other = await run(['lease', dir, w.agentId, '300', '10']);
    assert.deepEqual([other.lines[0].acquired, other.lines[0].code], [false, 'AlreadyRunning']);
    // This process hangs past its TTL; another takes over; this one then stops before any model call.
    await new Promise(res => setTimeout(res, 400));
    const takeover = await run(['lease', dir, w.agentId, '300', '600']);
    assert.equal(takeover.lines[0].acquired, true);
    const calls = srv.requests();
    s_advance(w);
    const t2 = await ap.tick();
    assert.deepEqual(t2, { skipped: true, state: 'stopped-lease-lost' });
    assert.equal(srv.requests(), calls, 'no model call after the takeover');
    // ③'s status answer for the action this process sent (P6, against the same relay).
    const begun = journal.entries.find(e => e.step === 'act-begin').attemptId;
    const st1 = await statusOf({ journal, txState: w.txState }, begun);
    assert.equal(st1.submission, 'sent');
    assert.equal(st1.chain.status, 'Unavailable', 'no chain status yet: it may still land');
    assert.equal(st1.validUntil, null);
    w.settle();
    const st2 = await statusOf({ journal, txState: w.txState }, begun);
    assert.equal(st2.chain.status, 'Landed');
    assert.match(st2.chain.finality, /not distinguished/);
    assert.equal(st2.terminal, false, 'not final: finality is not proven by the relay');
    assert.equal(JSON.stringify(st2).includes(w.capability), false);
  } finally { await srv.close(); rmSync(dir, { recursive: true, force: true }); }
});
const s_advance = w => w.advance(60);

test('P7 a takeover in the middle of a long tick: the model call is paid, but the act is not sent (LeaseLost before acting)', async () => {
  const { createLocalWorld, northernRequests } = await import('../../src/local-world.mjs');
  const { RunJournal } = await import('../../src/adapters.mjs');
  const { mandateFor } = await import('../../test/helpers.mjs');
  const { createAgentMcp } = await import('../../src/deps.mjs');
  const { openaiAdapter } = await import('../src/adapters.mjs');
  const { apiDecider } = await import('../src/api-decider.mjs');
  const { Autopilot } = await import('../src/autopilot.mjs');
  const { loopbackTransport } = await import('../src/http-transport.mjs');
  const { DecisionRegistry } = await import('../src/inference.mjs');
  const { FIXTURE_BOOK } = await import('../src/price-book.mjs');
  const { startHttpFixture } = await import('../fixture/http-fixture.mjs');
  const { tokenCheck } = await import('./relay-tree.mjs');
  const dir = dirOf();
  let w;
  // The model takes 600 ms; meanwhile another process takes the agent over (this lease's TTL is 300 ms).
  const srv = await startHttpFixture(async body => {
    await new Promise(res => setTimeout(res, 400));
    const t = await run(['lease', dir, w.agentId, '300', '50']);
    if (!t.lines[0].acquired) throw new Error(`takeover failed: ${JSON.stringify(t.lines)}`);
    const u = JSON.parse(body.input.find(m => m.role === 'user').content); const r = u.requests[0];
    return { answer: { proposals: r ? [{ request: r.id, action: 'Train', fields: { unit: 0, n: 100 }, reason: 'one batch' }] : [], skipped: [] } };
  });
  try {
    w = await createLocalWorld({ stores: { Food: 5000, Wood: 100, Stone: 100, Ore: 2000, Gold: 1000 } });
    const b = northernRequests()[0];
    w.board.splice(0, w.board.length, { ...b, id: 'R-1', deadlineSec: w.state.clock + 86_400, ask: { kind: 'train', unit: 0, n: 100 } });
    const now = () => w.state.clock * 1000;
    const lease = new ProcessLease({ dir, agentId: w.agentId, ttlMs: 300 });
    const costs = new FileCostLedger({ dir, init: { available: '100000', caps: { total: '50000' } }, lease, now });
    let ap;
    const decider = apiDecider({ adapter: openaiAdapter, model: 'gpt-fixture-model', transport: loopbackTransport({ baseUrl: srv.url, timeoutMs: 5_000 }), book: FIXTURE_BOOK(), costs, registry: new DecisionRegistry(), runId: () => ap.currentRun, sleep: async () => {} });
    ap = new Autopilot({ world: w, mandate: mandateFor(w, { allowed: ['Train'], expiresAt: w.state.clock + 86_400 }), decider, journal: new RunJournal({ now }),
      mcp: () => createAgentMcp({ relay: 'http://relay.test', agentId: w.agentId, capability: w.capability, fetch: w.fetch, source: 'ai' }), tokenCheck: tokenCheck(), lease });
    await ap.start({ by: 'owner' });
    const t = await ap.tick();
    assert.equal(t.inference.status, 'ok', 'the call was made and is paid');
    assert.deepEqual([t.game[0].outcome, t.game[0].code], ['skipped', 'LeaseLost']);
    assert.equal(w.sentCount(), 0, 'nothing sent after the takeover');
    assert.notEqual(new FileCostLedger({ dir }).classes().settled, '0');
  } finally { await srv.close(); rmSync(dir, { recursive: true, force: true }); }
});
