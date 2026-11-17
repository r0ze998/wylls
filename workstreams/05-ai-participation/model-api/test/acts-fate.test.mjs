// ⑤'s acts on ④ 77c5cbe2's execution contract: GET /f/agent/fate's seven states and the acts registry (run4Id).
//   A1 the fate read keeps RESULT UNKNOWN, PROVED EXPIRY and COULD NOT ASK apart; malformed or failed reads are never an answer
//   A2 run4Id is ④'s: act- + sha256(agent ‖ 0x00 ‖ key)[..16] (reference values from sha256sum, not from this code)
//   A3 the registry follows ④'s acts.rs rules (idempotent, never merged, finals never change, conflicts kept, facts kept)
//   A4 the registry across processes: four processes register the same acts at once — one row each, none lost
//   A5 participate: a relay `failed` whose bytes may have left is followed, held and counted, never retried
//   A6 verifyPending: GET /f/tx's `expired` is not a proof (held); the fate read's proved `expired` frees the act
//   A7 ③'s status answer from the fate read: validUntil, signedAt, run4Id; only proved ends are terminal
//   A8 the RunReceipt local adapter: GET /f/tx `expired` is not a final fate; the fate read fills signedAt and cancel.until
// KEY-FREE: no key is generated, derived or used and nothing is signed. The relay is a stub object (fixed answers), the
// chain is not involved, and no model is called. Imports load the shared modules' definitions only (checked by an
// import-closure scan before running: no top-level key creation).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FATE_STATES, fateReader, readFate, txStateFromFate, txStateFromTx } from '../src/fate-reader.mjs';
import { FileActsRegistry, run4IdOf } from '../src/acts-registry.mjs';
import { statusOf } from '../src/status-query.mjs';
import { localReceiptPort } from '../src/run-receipt.mjs';
import { RunJournal, OUTCOME } from '../../src/adapters.mjs';
import { contributedTo, mayHaveLeft, participate, verifyPending } from '../../src/participate.mjs';

const dirOf = () => mkdtempSync(join(tmpdir(), 'p05-acts-'));
const WORKER = fileURLToPath(new URL('./procs/ledger-worker.mjs', import.meta.url));
const signed = (state, extra = {}) => ({ agentId: 'agent1', retained: true, key: 'ai:p05.r1', status: 'sent', state, sent: true, signature: 'sigA', lastValidBlockHeight: 5000, slotFloor: 4000, signedAt: 1_762_000_000_000, commitment: null, why: state, ...extra });
/** A stub relay answering GET /f/agent/fate from a table key → body (or a status / a throw). */
const stubFetch = table => async url => {
  const u = new URL(url);
  const a = table[u.searchParams.get('key')];
  if (a === 'throw') throw new Error('ECONNREFUSED');
  if (a?.http) return { status: a.http, json: async () => a.body ?? {} };
  return { status: 200, json: async () => a ?? { state: 'unqueryable', retained: false, why: 'not kept' } };
};

test('A1 the fate read: seven states, three different "not decided" answers, and nothing malformed passes as an answer', async () => {
  const read = fateReader({ relay: 'http://relay.test/', fetch: stubFetch({
    'ai:a': signed('unknown', { why: 'history starts later' }),
    'ai:b': signed('expired', { why: 'proved by getFirstAvailableBlock' }),
    'ai:c': signed('unqueryable', { queryFailed: true, why: 'rpc down' }),
    'ai:d': signed('pending', { commitment: 'confirmed' }),
    'ai:e': 'throw', 'ai:f': { http: 503, body: { code: 'Unavailable' } }, 'ai:g': { state: 'gone' },
    'ai:h': { agentId: 'agent1', retained: true, key: 'ai:h', status: 'refused', code: 'ActionNotAllowed', state: 'not-sent', sent: false },
  }) });
  const [u, x, q, p, thrown, http, bad, ns] = await Promise.all(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(k => read('agent1', `ai:${k}`)));
  assert.deepEqual([u.state, u.final, u.noEffect], ['unknown', false, false], 'result unknown: held, not final, not retryable');
  assert.deepEqual([x.state, x.final, x.noEffect], ['expired', true, true], 'proved expiry: final, a new attempt may follow');
  assert.deepEqual([q.state, q.final, q.noEffect], ['unqueryable', false, false], 'could not ask: says nothing');
  assert.deepEqual([p.state, p.commitment, p.final], ['pending', 'confirmed', false], 'confirmed is progress, not a decision');
  assert.deepEqual([ns.state, ns.final, ns.noEffect, ns.sent], ['not-sent', true, true, false]);
  for (const r of [thrown, http, bad]) assert.equal(r.state, 'unqueryable');
  assert.equal(thrown.readError, 'Unreachable');
  assert.equal(http.readError, 'Unavailable');
  assert.equal(bad.readError, undefined, 'a malformed 200 answer is unqueryable too');
  assert.deepEqual([u.signature, u.lastValidBlockHeight, u.slotFloor, u.signedAt], ['sigA', 5000, 4000, 1_762_000_000_000]);
  assert.deepEqual(new Set([u.in4, x.in4, q.in4]).size, 3, 'three different words in ④\'s run vocabulary too');
  assert.equal(FATE_STATES.length, 7);
  assert.equal(readFate(null).state, 'unqueryable');
});

test('A2 run4Id is ④\'s id for the same act (reference from sha256sum)', () => {
  assert.equal(run4IdOf('agent1', 'ai:p05.r1'), 'act-008445dbab443860');
  assert.equal(run4IdOf('agent2', 'ai:p05.r1'), 'act-1ad7904027b3da39');
  assert.notEqual(run4IdOf('agent1', 'mcp:p05.r1'), run4IdOf('agent1', 'ai:p05.r1'), 'the source prefix is part of the key');
});

test('A3 the registry by ④\'s acts.rs rules', async () => {
  const dir = dirOf();
  try {
    const reg = new FileActsRegistry({ dir, now: () => 1 });
    // acts.rs registration_is_idempotent_and_never_merged
    const a = reg.register({ agentId: 'agent1', key: 'ai:p05.r1', source: 'ai', runId: 'p05-run-1' });
    assert.equal(a, reg.register({ agentId: 'agent1', key: 'ai:p05.r1', source: 'ai', runId: 'p05-run-1' }));
    assert.throws(() => reg.register({ agentId: 'agent1', key: 'ai:p05.r1', source: 'mcp', runId: 'p05-run-1' }), { code: 'Conflict' });
    assert.throws(() => reg.register({ agentId: 'agent1', key: 'ai:p05.r1', source: 'ai', runId: 'other-run' }), { code: 'Conflict' });
    const a2 = reg.register({ agentId: 'agent2', key: 'ai:p05.r1', source: 'ai', runId: 'p05-run-1' });
    assert.notEqual(a, a2);
    assert.equal(reg.byRun('p05-run-1').length, 2);
    // pending, then landed with the signing facts; cancel.until is the lifetime (a block height)
    const script = answers => { let i = 0; return async () => { const x = answers[Math.min(i++, answers.length - 1)]; if (x === 'fail') throw new Error('connection refused'); return x; }; };
    let r = await reg.refresh(a, script([readFate(signed('pending', { commitment: 'confirmed' }))]));
    assert.deepEqual([r.state, r.final, r.commitment, r.cancel.phase], ['pending', false, 'confirmed', 'AwaitingSigned']);
    assert.deepEqual(r.cancel.until, { lastValidBlockHeight: 5000 });
    // a failed read: unqueryable, the known signature stays
    r = await reg.refresh(a, script(['fail']));
    assert.deepEqual([r.state, r.signature, r.signedAt, r.lastReadError], ['unqueryable', 'sigA', 1_762_000_000_000, 'connection refused']);
    // a gateway that no longer keeps the record (retained: false): known facts are kept
    r = await reg.refresh(a, async () => readFate({ state: 'unqueryable', retained: false, why: 'not kept' }));
    assert.deepEqual([r.state, r.signature, r.lastValidBlockHeight], ['unqueryable', 'sigA', 5000]);
    r = await reg.refresh(a, script([readFate(signed('landed', { commitment: 'finalized' }))]));
    assert.deepEqual([r.state, r.final, r.cancel.phase], ['landed', true, 'Completed']);
    // a final state never changes: a failed read leaves it, a contradicting read is kept as conflict
    r = await reg.refresh(a, script(['fail']));
    assert.deepEqual([r.state, r.lastReadError], ['landed', null]);
    r = await reg.refresh(a, script([readFate(signed('expired'))]));
    assert.deepEqual([r.state, r.conflict?.state], ['landed', 'expired']);
    // not-sent: the cancel stage is before signing
    const n = reg.register({ agentId: 'agent1', key: 'ai:p05.r2', source: 'ai', runId: 'p05-run-1' });
    r = await reg.refresh(n, async () => readFate({ state: 'not-sent', sent: false, status: 'refused', why: 'refused before signing' }));
    assert.deepEqual([r.state, r.final, r.cancel.result, r.cancellable], ['not-sent', true, 'NotSent', false]);
    // a result unknown stays open (held)
    const u = reg.register({ agentId: 'agent1', key: 'ai:p05.r3', source: 'ai', runId: 'p05-run-1' });
    r = await reg.refresh(u, async () => readFate(signed('unknown')));
    assert.deepEqual([r.state, r.final], ['unknown', false]);
    assert.deepEqual(new Set(reg.open().map(x => x.run4Id)), new Set([u, a2]), 'open: the result-unknown act and agent2\'s, never read');
    assert.deepEqual(r.retention, { retentionBells: null, deleted: false });
    assert.equal(r.receiptVersion, 'p04-acts/0.1');
    // restart: a new object over the same directory answers from the file
    assert.equal(new FileActsRegistry({ dir }).receipt(a).state, 'landed');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function run(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [WORKER, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { err += d; });
    p.on('error', reject);
    p.on('close', code => resolve({ code, lines: out.split('\n').filter(Boolean).map(l => JSON.parse(l)), err }));
  });
}

test('A4 the registry across processes: four processes register the same 30 acts at once; another run under a key is refused', async () => {
  const dir = dirOf();
  try {
    const rs = await Promise.all([1, 2, 3, 4].map(() => run(['acts', dir, 'agent-x', 'p05-run-7', '30'])));
    for (const r of rs) assert.equal(r.code, 0, r.err);
    const ids = rs.map(r => r.lines[0].ids);
    for (const x of ids) assert.deepEqual(x, ids[0], 'every process gets the same ids');
    assert.ok(rs.every(r => r.lines[0].refused.length === 0));
    const reg = new FileActsRegistry({ dir });
    assert.equal(reg.byRun('p05-run-7').length, 30, 'one row per act, none lost or doubled');
    const other = await run(['acts', dir, 'agent-x', 'p05-run-8', '3']);
    assert.deepEqual(other.lines[0].refused, ['Conflict', 'Conflict', 'Conflict']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// A stub MCP server: agent_view from a fixed view, agent_act from a script. No relay, no key.
const VIEW = { agentId: 'agent1', mode: 'auto', modeEpoch: 3, policy: { version: 2, allowed: ['Train'] }, village: [1, 2, 3], delegation: { delegated: true }, historySeq: 1 };
const stubMcp = act => ({ async handle(req) {
  const { name, arguments: args } = req.params;
  if (name === 'agent_view') return { result: { isError: false, structuredContent: VIEW } };
  if (name === 'agent_act') { const r = act(args); return { result: { isError: !r.ok, structuredContent: r } }; }
  return { result: { isError: true, structuredContent: { ok: false, error: { code: 'NoSuchTool' } } } };
} });
const WORLD = { clockSec: () => 1_000_000, village: () => ({ stores: {}, reserve_troops: {} }), requests: () => [] };
const MANDATE = { mandateId: 'm1', version: 1, agentId: 'agent1', basedOnPolicyVersion: 2, allowed: ['Train'], expiresAt: 2_000_000 };
const quiet = { name: 'stub', free: true, async plan() { return { proposals: [], notes: [] }; } };
function begunJournal() {
  const journal = new RunJournal();
  const args = { requestId: 'p05.attempt-1', policyVersion: 2, modeEpoch: 3, action: { name: 'Train', fields: { unit: 0, n: 10 } } };
  journal.append({ runId: 't1', step: 'act-begin', key: 'K1', requestId: 'R-1', attemptId: args.requestId, outcome: OUTCOME.ACTING, args, cost: { food: 10 }, worldSec: 1_000_000 });
  return journal;
}

test('A5 a relay `failed` that may have left is followed: held, counted, never a new requestId', async () => {
  assert.equal(mayHaveLeft({ status: 'failed', sent: true }), true);
  assert.equal(mayHaveLeft({ status: 'failed', sent: null }), true, 'an older relay that does not say: may have left');
  assert.equal(mayHaveLeft({ status: 'failed', sent: false }), false, 'nothing left: a new attempt may follow');
  assert.equal(mayHaveLeft({ status: 'refused', sent: false }), false);
  for (const answer of [
    { ok: false, status: 'failed', sent: true, signature: 'sigA', lastValidBlockHeight: 5000, slotFloor: 4000, signedAt: 17, error: { code: 'SendFailed' }, charges: [] },
    { ok: false, status: 'failed', error: { code: 'SendFailed' }, charges: [] },
  ]) {
    const journal = begunJournal();
    let acts = 0;
    const report = await participate({ mcp: stubMcp(() => { acts++; return answer; }), world: WORLD, txState: async () => ({ state: 'unknown' }), mandate: MANDATE, decider: quiet, journal, runId: 't2' });
    assert.equal(acts, 1, 'the begun act is asked again once, under the same requestId');
    const res = journal.entries.findLast(e => e.step === 'act-result');
    assert.deepEqual([res.outcome, res.relayStatus, res.attemptId], [OUTCOME.SENT, 'failed', 'p05.attempt-1']);
    assert.equal(report.resumed[0].outcome, OUTCOME.UNKNOWN);
    assert.equal(contributedTo(journal, 'R-1'), 10, 'counted as on its way (it may land)');
    assert.deepEqual(journal.committedToday(1_000_000), { food: 10 }, 'the day\'s limit still counts it');
    if (answer.sent) assert.deepEqual([res.signature, res.lastValidBlockHeight, res.signedAt], ['sigA', 5000, 17]);
    // The next run does not ask the relay again for it (no act-begin is open), and it stays held.
    const again = await participate({ mcp: stubMcp(() => { acts++; return answer; }), world: WORLD, txState: async () => ({ state: 'unknown' }), mandate: MANDATE, decider: quiet, journal, runId: 't3' });
    assert.equal(acts, 1, 'nothing re-sent');
    assert.deepEqual(again.resumed, []);
  }
  // `failed` with sent: false is "nothing left", as before.
  const journal = begunJournal();
  await participate({ mcp: stubMcp(() => ({ ok: false, status: 'failed', sent: false, error: { code: 'SendFailed' }, charges: [] })), world: WORLD, txState: async () => ({ state: 'unknown' }), mandate: MANDATE, decider: quiet, journal, runId: 't2' });
  assert.equal(journal.entries.findLast(e => e.step === 'act-result').outcome, 'failed');
  assert.equal(contributedTo(journal, 'R-1'), 0);
});

function sentJournal() {
  const journal = begunJournal();
  journal.append({ runId: 't1', step: 'act-result', key: 'K1', requestId: 'R-1', attemptId: 'p05.attempt-1', outcome: OUTCOME.SENT, sent: true, signature: 'sigA', lastValidBlockHeight: 5000 });
  return journal;
}

test('A6 verifyPending: GET /f/tx `expired` is held; the fate read keeps unknown and unqueryable apart; a proved expiry frees the act', async () => {
  const released = [];
  const guard = { release: k => released.push(k) };
  // GET /f/tx says expired (confirmed height only)
  let j = sentJournal();
  let out = await verifyPending({ journal: j, txState: txStateFromTx(async () => ({ state: 'expired' })), world: WORLD, guard });
  assert.deepEqual([out[0].outcome, released.length], [OUTCOME.UNKNOWN, 0]);
  assert.equal(j.entries.at(-1).relayTx, 'expired');
  assert.equal(contributedTo(j, 'R-1'), 10, 'still counted: it may have landed');
  // fate: unknown, unqueryable — both held, recorded apart
  const fateOf = body => fateReader({ relay: 'http://r', fetch: stubFetch({ 'ai:p05.attempt-1': body }) });
  for (const [body, want] of [[signed('unknown'), 'unknown'], [signed('unqueryable', { queryFailed: true }), 'unqueryable'], ['throw', 'unqueryable'], [signed('pending'), 'pending']]) {
    j = sentJournal();
    out = await verifyPending({ journal: j, txState: txStateFromFate(fateOf(body), { agentId: 'agent1', source: 'ai' }), world: WORLD, guard });
    assert.deepEqual([out[0].outcome, out[0].fateState, j.entries.at(-1).fateState, released.length], [OUTCOME.UNKNOWN, want, want, 0]);
  }
  // fate: a proved expiry — final, the executor's reservation comes back, a new attempt may follow
  j = sentJournal();
  out = await verifyPending({ journal: j, txState: txStateFromFate(fateOf(signed('expired')), { agentId: 'agent1', source: 'ai' }), world: WORLD, guard });
  assert.deepEqual([out[0].outcome, released], ['expired', ['game:p05.attempt-1']]);
  assert.equal(contributedTo(j, 'R-1'), 0);
  // a fate read for another signature is not taken
  j = sentJournal();
  out = await verifyPending({ journal: j, txState: txStateFromFate(fateOf(signed('expired', { signature: 'sigB' })), { agentId: 'agent1', source: 'ai' }), world: WORLD, guard });
  assert.equal(out[0].outcome, OUTCOME.UNKNOWN);
});

test('A7 ③\'s status answer from the fate read: ④\'s states, validUntil and signedAt, run4Id; only proved ends are terminal', async () => {
  const journal = sentJournal();
  const ask = async body => statusOf({ journal, txState: async () => ({ state: 'landed' }), fate: fateReader({ relay: 'http://r', fetch: stubFetch({ 'ai:p05.attempt-1': body }) }), agentId: 'agent1', source: 'ai' }, 'p05.attempt-1');
  const u = await ask(signed('unknown')), x = await ask(signed('expired')), q = await ask('throw'), l = await ask(signed('landed'));
  assert.deepEqual([u.fate.state, u.terminal, u.mayRetry], ['unknown', false, false]);
  assert.deepEqual([x.fate.state, x.terminal, x.mayRetry], ['expired', true, true]);
  assert.deepEqual([q.fate.state, q.terminal, q.fate.readError], ['unqueryable', false, 'Unreachable']);
  assert.deepEqual([l.fate.state, l.terminal, l.mayRetry], ['landed', true, false]);
  assert.deepEqual([u.validUntil, u.validUntilUnit, u.signedAt, u.signature], [5000, 'block height (lastValidBlockHeight)', 1_762_000_000_000, 'sigA']);
  assert.equal(u.run4Id, run4IdOf('agent1', 'ai:p05.attempt-1'));
  assert.equal(new Set([u.terminalWhy, x.terminalWhy, q.terminalWhy]).size, 3);
  // without a reader, the older answer says what it is read by
  const old = await statusOf({ journal, txState: async () => ({ state: 'expired' }) }, 'p05.attempt-1');
  assert.deepEqual([old.readBy, old.chain.status], ['GET /f/tx (no fate reader)', 'Unavailable']);
});

test('A8 the RunReceipt local adapter: GET /f/tx `expired` is not final; the fate read gives signedAt and cancel.until', async () => {
  const view = async () => ({ ...VIEW, citizen: 'c1', history: [{ type: 'action', key: 'ai:p05.attempt-1', source: 'ai' }], holds: [] });
  for (const [fate, want, until] of [[null, 'unknown', null], [fateReader({ relay: 'http://r', fetch: stubFetch({ 'ai:p05.attempt-1': signed('pending') }) }), 'pending', { lastValidBlockHeight: 5000 }]]) {
    const port = localReceiptPort({ view, txState: async () => ({ state: 'expired' }), fate });
    await port.open({ runId: 't1' });
    port.attachAct('t1', { requestId: 'p05.attempt-1', outcome: 'sent', signature: 'sigA', proposed: { name: 'Train' } });
    await port.close('t1');
    port.cancel('t1', 'before-sign');
    const r = await port.refreshFates('t1');
    assert.equal(r.acts[0].fate, want);
    const ph = port.cancelPhase('t1');
    assert.deepEqual([ph.phase, ph.until], ['AwaitingSigned', until]);
    if (fate) assert.equal(r.acts[0].signedAt, 1_762_000_000_000);
  }
});
