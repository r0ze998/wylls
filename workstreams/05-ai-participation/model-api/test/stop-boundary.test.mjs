// WRITTEN, NOT RUN (2026-11-17, under an execution pause): no part of this file has been executed. It uses the same
// harness as autopilot.test.mjs (the local world, whose relay makes an in-memory test agent key, and the model HTTP
// fixture on 127.0.0.1), so it may be run ONLY through the repository's key-free guard once runs are allowed again.
//
// The owner-approved stop (A): from Autopilot.stop on, no new decision is acted on, nothing is sent or re-sent; what was
// already sent is only followed, read only (HANDOFF-4 §5).
//   S1 no lease: a stop while the model is answering sends nothing (AutopilotStopped), no act-begin is written
//   S2 a stop then a resume while the old tick still waits: the old tick sends nothing; a new tick may
//   S3 with a process lease: the same (AutopilotStopped before LeaseLost)
//   S4 checkSent after a stop: read only (no send, no model call); an unsettled send stays open, never "settled"
//   S5 checkSent refuses while running and while a tick begun before the stop is still in flight
//   S6 an act begun without an answer is reported as unfinished and is not re-sent by checkSent
//   S7 a stop between act-begin and the first agent_act (the old microtask window): nothing sent, the act-begin closed
//      as refused / not sent, nothing left unfinished
//   S8 the re-ask of an unfinished act at a run's start: not made once the caller is stopped
//   S9 verifyPending's bounded read rotates: 10 open sends, 8 reads a call — the 9th and 10th are read on the next call
//   S10 checkSent advances its start by what it read: acts held open at the front never starve the later ones
//   S11 the owner's status shows the last follow-up (null before one ran); status itself reads nothing
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunJournal } from '../../src/adapters.mjs';
import { createLocalWorld, northernRequests } from '../../src/local-world.mjs';
import { mandateFor, run } from '../../test/helpers.mjs';
import { verifyPending } from '../../src/participate.mjs';
import { openaiAdapter } from '../src/adapters.mjs';
import { loopbackTransport } from '../src/http-transport.mjs';
import { FIXTURE_BOOK } from '../src/price-book.mjs';
import { RunCostMock } from '../src/run-cost.mjs';
import { DecisionRegistry } from '../src/inference.mjs';
import { apiDecider } from '../src/api-decider.mjs';
import { Autopilot, FOLLOW_UP_READS } from '../src/autopilot.mjs';
import { ProcessLease } from '../src/process-lease.mjs';
import { tokenCheck } from './relay-tree.mjs';
import { startHttpFixture } from '../fixture/http-fixture.mjs';

const userOf = body => JSON.parse((body.messages ?? body.input).find(m => m.role === 'user').content);
const firstRequest = body => { const r = userOf(body).requests[0]; return { proposals: r ? [{ request: r.id, action: 'Train', fields: { unit: 0, n: 100 }, reason: 'one batch fits the limits' }] : [], skipped: [] }; };
const board = () => { const b = northernRequests()[0]; return [1, 2, 3, 4].map(i => ({ ...b, id: `R-${i}`, title: `第${i}陣：槍兵100`, ask: { kind: 'train', unit: 0, n: 100 } })); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
/** The model answers after `delayMs` (0: at once). */
const slow = delayMs => body => (delayMs ? { delayMs, answer: firstRequest(body) } : { answer: firstRequest(body) });

async function setup({ delayMs = 0, lease = false } = {}) {
  const srv = await startHttpFixture(slow(delayMs));
  const w = await createLocalWorld({ requests: board(), stores: { Food: 5000, Wood: 100, Stone: 100, Ore: 2000, Gold: 1000 } });
  const costs = new RunCostMock({ available: '100000', caps: { total: '1000000' }, now: () => w.state.clock * 1000 });
  let ap;
  const decider = apiDecider({ adapter: openaiAdapter, model: 'gpt-fixture-model', transport: loopbackTransport({ baseUrl: srv.url, timeoutMs: 2_000 }), book: FIXTURE_BOOK(), costs, registry: new DecisionRegistry(), runId: () => ap.currentRun, sleep: async () => {} });
  const mandate = mandateFor(w, { allowed: ['Train'], limits: { perRequest: { Food: 60, Ore: 20, Gold: 10 }, perDay: { Food: 600, Ore: 200, Gold: 100 }, troopsPerRequest: 100 } });
  const dir = lease ? mkdtempSync(join(tmpdir(), 'p05-stop-')) : null;
  ap = new Autopilot({ world: { ...w, mcp: () => w.mcp() }, mandate, decider, journal: new RunJournal({ now: () => w.state.clock * 1000 }), tokenCheck: tokenCheck(),
    ...(lease ? { lease: new ProcessLease({ dir, agentId: w.agentId, ttlMs: 30_000 }) } : {}) });
  return { srv, w, ap, close: async () => { ap.stop({ by: 'test' }); await srv.close(); if (dir) rmSync(dir, { recursive: true, force: true }); } };
}

const actBegins = (ap, runId) => ap.journal.entries.filter(e => e.runId === runId && e.step === 'act-begin');

for (const lease of [false, true]) {
  test(`S1/S3 ${lease ? 'with' : 'without'} a lease: a stop while the model answers sends nothing`, async () => {
    const s = await setup({ delayMs: 300, lease });
    try {
      await s.ap.start({ by: 'owner' });
      const sentBefore = s.w.chain.sent.length;
      const pending = s.ap.tick();
      await sleep(50);                                   // the tick is waiting for the model
      s.ap.stop({ by: 'owner' });
      const t = await pending;
      assert.equal(s.w.chain.sent.length, sentBefore, 'nothing sent after the stop');
      assert.ok(t.game.length > 0 && t.game.every(g => g.outcome === 'skipped' && g.code === 'AutopilotStopped'), JSON.stringify(t.game));
      assert.equal(actBegins(s.ap, t.runId).length, 0, 'no act-begin: a restart has nothing to re-ask');
      assert.equal(s.ap.state, 'stopped');
    } finally { await s.close(); }
  });
}

test('S2 a stop then a resume while the old tick waits: the old tick sends nothing; the next tick may', async () => {
  const s = await setup({ delayMs: 300 });
  try {
    await s.ap.start({ by: 'owner' });
    const sentBefore = s.w.chain.sent.length;
    const old = s.ap.tick();
    await sleep(50);
    s.ap.stop({ by: 'owner' });
    await s.ap.resume({ by: 'owner', note: 'resumed during the model call' });
    assert.equal(s.ap.state, 'running');
    const t = await old;
    assert.equal(s.w.chain.sent.length, sentBefore, 'the old generation sends nothing after the resume');
    assert.ok(t.game.every(g => g.code === 'AutopilotStopped'), JSON.stringify(t.game));
    assert.equal(s.ap.state, 'running', 'the old tick does not change the resumed run\'s state');
    s.w.advance(60);
    const t2 = await s.ap.tick();
    assert.equal(t2.game[0].outcome, 'sent', 'a tick of the current generation acts as before');
  } finally { await s.close(); }
});

test('S4 checkSent after a stop: read only; an unsettled send stays open', async () => {
  const s = await setup();
  try {
    await s.ap.start({ by: 'owner' });
    const t = await s.ap.tick();
    assert.equal(t.game[0].outcome, 'sent');
    s.ap.stop({ by: 'owner' });
    const sent = s.w.chain.sent.length, calls = s.srv.requests();
    const c1 = await s.ap.checkSent();
    assert.deepEqual([c1.sends, s.w.chain.sent.length, s.srv.requests()], [0, sent, calls], 'no send, no model call');
    assert.ok(c1.open >= 1 && c1.settled === false, JSON.stringify(c1));
    assert.ok(c1.verified.filter(v => !v.notRead).length <= FOLLOW_UP_READS);
    s.w.settle();
    const c2 = await s.ap.checkSent();
    assert.equal(s.w.chain.sent.length, sent);
    assert.ok(c2.verified.some(v => ['landed', 'contributed'].includes(v.outcome)), JSON.stringify(c2.verified));
    assert.equal(c2.settled, c2.open === 0 && c2.unfinished.length === 0);
  } finally { await s.close(); }
});

test('S5 checkSent refuses while running and while an earlier tick is in flight', async () => {
  const s = await setup({ delayMs: 300 });
  try {
    await s.ap.start({ by: 'owner' });
    assert.equal((await s.ap.checkSent()).skipped, true);
    const pending = s.ap.tick();
    await sleep(50);
    s.ap.stop({ by: 'owner' });
    const c = await s.ap.checkSent();
    assert.deepEqual([c.skipped, /in flight/.test(c.why)], [true, true]);
    await pending;
    assert.equal((await s.ap.checkSent()).skipped, undefined);
  } finally { await s.close(); }
});

test('S6 an act begun without an answer is reported, not re-sent', async () => {
  const s = await setup();
  try {
    await s.ap.start({ by: 'owner' });
    s.ap.stop({ by: 'owner' });
    s.ap.journal.append({ runId: 'x:t9', step: 'act-begin', key: 'k-unfinished', requestId: 'R-1', attemptId: 'p05.unfinished', outcome: 'acting', args: { requestId: 'p05.unfinished', policyVersion: 1, modeEpoch: 0, action: { name: 'Train', fields: { unit: 0, n: 100 } } } });
    const sent = s.w.chain.sent.length;
    const c = await s.ap.checkSent();
    assert.equal(s.w.chain.sent.length, sent);
    assert.deepEqual(c.unfinished.map(u => [u.key, u.outcome]), [['k-unfinished', 'unknown']]);
    assert.equal(c.settled, false);
  } finally { await s.close(); }
});

const STOP = { ok: false, code: 'AutopilotStopped', detail: 'stopped (test boundary)' };
const sentEntries = (journal, n) => { for (let i = 1; i <= n; i++) {
  journal.append({ runId: 'x:t1', step: 'act-begin', key: `k${i}`, requestId: `R-${i}`, attemptId: `p05.s${i}`, outcome: 'acting', args: { requestId: `p05.s${i}`, action: { name: 'Train', fields: { unit: 0, n: 1 } } } });
  journal.append({ runId: 'x:t1', step: 'act-result', key: `k${i}`, requestId: `R-${i}`, attemptId: `p05.s${i}`, outcome: 'sent', sent: true, signature: `sig${i}` });
} };

test('S7 a stop between act-begin and the first agent_act sends nothing and closes the act', async () => {
  const w = await createLocalWorld({ requests: board(), stores: { Food: 5000, Wood: 100, Stone: 100, Ore: 2000, Gold: 1000 } });
  let stopped = false;
  const boundary = { beforeAct: () => ({ ok: true }), beforeSend: () => (stopped ? STOP : { ok: true }) };
  const sentBefore = w.chain.sent.length;
  const { report, journal } = await run(w, { boundary, crash: step => { if (step === 'act-begin') stopped = true; } });
  assert.equal(w.chain.sent.length, sentBefore, 'no agent_act after the stop');
  const begun = journal.entries.filter(e => e.step === 'act-begin');
  assert.equal(begun.length, 1, 'the one act that passed beforeSend before the stop');
  const closed = journal.entries.find(e => e.step === 'act-result' && e.attemptId === begun[0].attemptId);
  assert.deepEqual([closed.outcome, closed.sent, closed.code], ['refused', false, 'AutopilotStopped']);
  assert.deepEqual(journal.unfinished(), [], 'nothing for a restart to re-ask');
  assert.ok(report.items.every(it => it.outcome !== 'sent'), JSON.stringify(report.items));
});

test('S8 an unfinished act is not re-asked once the caller is stopped', async () => {
  const w = await createLocalWorld({ requests: board(), stores: { Food: 5000, Wood: 100, Stone: 100, Ore: 2000, Gold: 1000 } });
  const journal = new RunJournal({ now: () => w.state.clock * 1000 });
  journal.append({ runId: 'x:t0', step: 'act-begin', key: 'k-open', requestId: 'R-1', attemptId: 'p05.open', outcome: 'acting', args: { requestId: 'p05.open', policyVersion: 1, modeEpoch: 0, action: { name: 'Train', fields: { unit: 0, n: 100 } } } });
  const sentBefore = w.chain.sent.length;
  const { report } = await run(w, { journal, boundary: { beforeAct: () => STOP, beforeSend: () => STOP } });
  assert.equal(w.chain.sent.length, sentBefore);
  assert.deepEqual(report.resumed.map(r => [r.key, r.outcome, r.code]), [['k-open', 'unknown', 'AutopilotStopped']]);
  assert.equal(journal.unfinished().length, 1, 'still unfinished (unknown), not taken as sent or as not sent');
});

test('S9 verifyPending rotates its bounded reads', async () => {
  const journal = new RunJournal({ now: () => 0 });
  sentEntries(journal, 10);
  const reads = [];
  const txState = async sig => { reads.push(sig); return { state: 'unknown' }; };
  const world = { village: () => null };
  const a = await verifyPending({ journal, txState, world, maxReads: 8, offset: 0 });
  assert.deepEqual(reads, ['sig1', 'sig2', 'sig3', 'sig4', 'sig5', 'sig6', 'sig7', 'sig8']);
  assert.equal(a.length, 10);
  assert.deepEqual(a.filter(v => v.notRead).map(v => v.key), ['k9', 'k10']);
  reads.length = 0;
  await verifyPending({ journal, txState, world, maxReads: 8, offset: 8 });
  assert.deepEqual(reads, ['sig9', 'sig10', 'sig1', 'sig2', 'sig3', 'sig4', 'sig5', 'sig6']);
  reads.length = 0;
  await verifyPending({ journal, txState, world });
  assert.equal(reads.length, 10, 'unbounded (a tick): every open act, in order');
  assert.deepEqual(reads.slice(0, 2), ['sig1', 'sig2']);
});

test('S10 checkSent advances its start: the later acts are read on the next call', async () => {
  const s = await setup();
  try {
    await s.ap.start({ by: 'owner' });
    s.ap.stop({ by: 'owner' });
    sentEntries(s.ap.journal, 10);
    const sent = s.w.chain.sent.length;
    const c1 = await s.ap.checkSent();
    const c2 = await s.ap.checkSent();
    const readKeys = c => c.verified.filter(v => !v.notRead).map(v => v.key);
    assert.equal(readKeys(c1).length, FOLLOW_UP_READS);
    assert.ok(readKeys(c2).includes('k9') && readKeys(c2).includes('k10'), JSON.stringify(readKeys(c2)));
    assert.deepEqual([c1.nextOffset, s.w.chain.sent.length], [8, sent]);
    assert.equal(c2.settled, false, 'held results are never settled');
  } finally { await s.close(); }
});

test('S11 status shows the last follow-up; status itself reads nothing', async () => {
  const s = await setup();
  try {
    await s.ap.start({ by: 'owner' });
    assert.equal(s.ap.status().followUp, null);
    const t = await s.ap.tick();
    assert.equal(t.game[0].outcome, 'sent');
    s.ap.stop({ by: 'owner' });
    const c = await s.ap.checkSent();
    const f = s.ap.status().followUp;
    assert.deepEqual([f.read, f.open, f.notRead, f.unfinished, f.settled, f.nextOffset], [c.verified.filter(v => !v.notRead).length, c.open, c.notRead, c.unfinished.length, c.settled, c.nextOffset]);
    const events = s.ap.events.length;
    s.ap.status(); s.ap.status();
    assert.equal(s.ap.events.length, events, 'status makes no read and records nothing');
  } finally { await s.close(); }
});
