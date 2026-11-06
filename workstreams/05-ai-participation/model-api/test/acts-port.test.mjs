// ⑤'s acts port with the SUBSTITUTE registry (localActsPort over acts-registry.mjs). The same checks against ④'s
// REAL registry are in acts-runexec.test.mjs (they run when ④'s runexec binary is given).
//   S1 receipts carry ④'s next step (done | new-attempt | wait | hold | read-again) and say they are the substitute
//   S2 participate registers each act BEFORE sending; a registry that cannot record stops the act (nothing is sent)
//   S3 result unknown is never turned into "did not happen" by time: days later, still held, nothing re-sent
//   S4 ③'s status answer from the registry: never registered ≠ unreadable ≠ result unknown
// KEY-FREE: stub MCP (fixed answers), stub fate reads; no relay, no chain, no key, nothing signed, no model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { actsRunIdOf, localActsPort, nextOf, registerBeforeSend, txStateFromActs } from '../src/acts-port.mjs';
import { FileActsRegistry, run4IdOf } from '../src/acts-registry.mjs';
import { readFate } from '../src/fate-reader.mjs';
import { statusOf } from '../src/status-query.mjs';
import { RunJournal } from '../../src/adapters.mjs';
import { participate } from '../../src/participate.mjs';
import { stubParticipation } from './stub-participation.mjs';

const dirOf = () => mkdtempSync(join(tmpdir(), 'p05-port-'));
const signed = (state, extra = {}) => readFate({ state, sent: true, signature: 'sigA', lastValidBlockHeight: 5000, slotFloor: 4000, signedAt: 17, why: state, ...extra });

test('S1 the substitute port: ④\'s next steps, ④\'s error codes, and it says it is the substitute', async () => {
  const dir = dirOf();
  try {
    let answer = signed('pending');
    const port = localActsPort({ registry: new FileActsRegistry({ dir }), fate: async () => answer });
    const r = await port.register({ agentId: 'agent1', key: 'ai:p05.k1', source: 'ai', runId: 'run-1' });
    assert.deepEqual([r.state, r.next, r.newAttemptAllowed, r.connection, port.real], ['registered', 'wait', false, 'substitute', false]);
    const want = { pending: ['wait', false], unknown: ['hold', false], unqueryable: ['read-again', false], landed: ['done', false] };
    for (const [state, [next, again]] of Object.entries(want)) {
      answer = signed(state);
      const s = await port.status({ agentId: 'agent1', key: 'ai:p05.k1' });
      assert.deepEqual([s.state, s.next, s.newAttemptAllowed], [state, next, again], state);
    }
    for (const s of ['not-sent', 'expired']) assert.deepEqual(nextOf(s), { next: 'new-attempt', newAttemptAllowed: true });
    await assert.rejects(port.status({ agentId: 'agent1', key: 'ai:never' }), { code: 'NoRecord' });
    await assert.rejects(port.register({ agentId: 'agent1', key: 'ai:p05.k1', source: 'mcp', runId: 'run-1' }), { code: 'Conflict' });
    await assert.rejects(port.register({ agentId: 'agent1', key: 'ai:p05.k2', source: 'robot', runId: 'run-1' }), { code: 'BadRequest' });
    assert.equal((await port.list('run-1')).acts.length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('S2 register before send: the record exists when agent_act is called; no record, no send', async () => {
  const dir = dirOf();
  try {
    const registry = new FileActsRegistry({ dir });
    const port = localActsPort({ registry, fate: async () => signed('pending') });
    const st = stubParticipation({ onAct: args => {
      // The act is in the registry before the relay is asked.
      assert.ok(registry.get(run4IdOf('agent1', `ai:${args.requestId}`)), 'registered before agent_act');
      return { ok: true, status: 'sent', sent: true, signature: 'sigA', lastValidBlockHeight: 5000, slotFloor: 4000, signedAt: 17, charges: [] };
    } });
    const journal = new RunJournal();
    const r = await participate({ ...st.args, journal, runId: 't1', registerAct: registerBeforeSend(port, { agentId: 'agent1', source: 'ai' }) });
    assert.equal(r.items[0].outcome, 'sent');
    assert.equal(st.acts.length, 1);
    assert.equal(journal.entries.find(e => e.step === 'act-begin').registry, 'substitute');
    // A registry that cannot record (here: the key is taken by another run) — the act is not sent.
    const st2 = stubParticipation({ onAct: () => assert.fail('must not be sent') });
    const failing = { kind: 'broken', real: false, register: async () => { throw Object.assign(new Error('database is locked'), { code: 'StoreError' }); } };
    const j2 = new RunJournal();
    const r2 = await participate({ ...st2.args, journal: j2, runId: 't1', registerAct: registerBeforeSend(failing, { agentId: 'agent1', source: 'ai' }) });
    assert.deepEqual([r2.items[0].outcome, r2.items[0].code, st2.acts.length], ['skipped', 'ActsUnavailable', 0]);
    // Next run, the same decision registers again under the SAME requestId (nothing was sent, nothing to double).
    const ids = [];
    const st3 = stubParticipation({ onAct: a => { ids.push(a.requestId); return { ok: true, status: 'sent', sent: true, signature: 'sigB', charges: [] }; } });
    await participate({ ...st3.args, journal: j2, runId: 't2', registerAct: registerBeforeSend(port, { agentId: 'agent1', source: 'ai' }) });
    assert.equal(ids[0], j2.entries.find(e => e.step === 'guard' && e.code === 'ActsUnavailable').attemptId);
    // A crash after register and before act-begin: the key is in the registry, the journal knows nothing. The next tick
    // computes the same requestId and registers it again — idempotent (one run id per autopilot), so it is sent.
    const reg4 = localActsPort({ registry: new FileActsRegistry({ dir: join(dir, 'c') }) });
    const rid = ids[0];
    await reg4.register({ agentId: 'agent1', key: `ai:${rid}`, source: 'ai', runId: actsRunIdOf('agent1') });
    const sent4 = [];
    const st5 = stubParticipation({ onAct: a => { sent4.push(a.requestId); return { ok: true, status: 'sent', sent: true, signature: 'sigC', charges: [] }; } });
    const r5 = await participate({ ...st5.args, journal: new RunJournal(), runId: 't9', registerAct: registerBeforeSend(reg4, { agentId: 'agent1', source: 'ai' }) });
    assert.deepEqual([sent4, r5.items[0].outcome], [[rid], 'sent'], 'not stuck on Conflict');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('S3 result unknown is not "did not happen" after any amount of time: held for 30 days, nothing re-sent; a proved expiry then allows one new attempt', async () => {
  const dir = dirOf();
  try {
    // One answer per key: the first attempt's, then pending for any later key.
    let answer = signed('unknown', { why: 'the node\'s history starts after the send' });
    let first = null;
    const port = localActsPort({ registry: new FileActsRegistry({ dir }), fate: async (_a, key) => { first ??= key; return key === first ? answer : signed('pending', { signature: `sig-${key}` }); } });
    let clock = 1_000_000;
    const sent = [];
    const st = stubParticipation({ clock: () => clock, deadlineSec: 1_000_000 + 90 * 86_400, onAct: a => { sent.push(a.requestId); return { ok: true, status: 'sent', sent: true, signature: sent.length === 1 ? 'sigA' : `sig-ai:${a.requestId}`, lastValidBlockHeight: 5000, slotFloor: 4000, signedAt: 17, charges: [] }; } });
    const journal = new RunJournal({ now: () => clock * 1000 });
    const tick = n => participate({ ...st.args, mandate: { ...st.args.mandate, expiresAt: clock + 86_400 }, journal, runId: `t${n}`, txState: txStateFromActs(port, { agentId: 'agent1', source: 'ai' }), registerAct: registerBeforeSend(port, { agentId: 'agent1', source: 'ai' }) });
    await tick(1);
    for (let d = 1; d <= 30; d++) { clock += 86_400; const r = await tick(d + 1); assert.equal(r.verified[0]?.fateState, 'unknown'); assert.equal(r.items[0]?.code, 'Duplicate'); }
    assert.equal(sent.length, 1, 'sent once in 30 days of result unknown');
    const s = await port.status({ agentId: 'agent1', key: `ai:${sent[0]}` });
    assert.deepEqual([s.state, s.next, s.newAttemptAllowed], ['unknown', 'hold', false]);
    // The node later proves absence (expired): a NEW attempt under a NEW key, once.
    answer = signed('expired', { why: 'proved' });
    clock += 3600;
    await tick(40);
    await tick(41);
    assert.equal(sent.length, 2);
    assert.notEqual(sent[1], sent[0], 'a new attempt has a new key');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('S4 ③\'s status from the registry: never registered, unreadable and result unknown are three answers', async () => {
  const dir = dirOf();
  try {
    const registry = new FileActsRegistry({ dir });
    const port = localActsPort({ registry, fate: async () => signed('unknown') });
    const journal = new RunJournal();
    const ask = (acts, id) => statusOf({ journal, txState: async () => null, acts, agentId: 'agent1', source: 'ai' }, id);
    const none = await ask(port, 'p05.never');
    assert.deepEqual([none.registry, none.fate, none.journal], ['no-record', null, 'unknown-request']);
    await port.register({ agentId: 'agent1', key: 'ai:p05.k1', source: 'ai', runId: 'r' });
    const u = await ask(port, 'p05.k1');
    assert.deepEqual([u.registry, u.fate.state, u.next, u.mayRetry, u.terminal, u.connection, u.validUntil], ['recorded', 'unknown', 'hold', false, false, 'substitute', 5000]);
    const broken = { kind: 'broken', real: true, status: async () => { throw Object.assign(new Error('spawn runexec ENOENT'), { code: 'Spawn' }); } };
    const q = await ask(broken, 'p05.k1');
    assert.deepEqual([q.registry, q.fate.state, q.next, q.connection], ['unreadable', 'unqueryable', 'read-again', 'real']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
