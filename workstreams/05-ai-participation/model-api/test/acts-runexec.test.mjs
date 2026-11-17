// ⑤ on ④'s REAL act registry: ④'s `runexec act` binary and ④'s client `workstreams/04-execution/clients/acts.mjs`
// (④ b82fafa8 / 95686606). Runs only when both are given; otherwise every test here is SKIPPED and says so — the
// substitute is tested in acts-port.test.mjs, never counted as this.
//   RUNEXEC_BIN=<path to runexec>  FOUR_ACTS_CLIENT=<path to ④'s clients/acts.mjs>  node --test test/acts-runexec.test.mjs
//
//   X1 register / status / list through ④'s binary: idempotent, Conflict and NoRecord as ④'s codes, ④'s next steps
//   X2 restart: the store answers after every process is gone; finals never change, a contradicting read is kept
//   X3 several processes at once on one store: register and read concurrently — one row per act, none lost
//   X4 could not ask vs result unknown: a closed port and a 503 are `unqueryable` (read-again, facts kept); `unknown`
//      holds however often it is read; only a proved `expired` allows a new attempt
//   X5 the substitute and the real registry answer the same for the same script of wallet answers
//   X6 participate end to end on the real registry: registered before sending, result unknown never re-sent,
//      a proved expiry → one new attempt under a new key
// KEY-FREE: the wallet is a Node stub answering GET /f/agent/fate (chunked, as the wallet does); the MCP is a stub;
// no relay, no chain, no key, nothing signed, no model. runexec opens SQLite and reads 127.0.0.1 only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { actsRunIdOf, loadFourActsPort, localActsPort, registerBeforeSend, txStateFromActs } from '../src/acts-port.mjs';
import { FileActsRegistry, run4IdOf } from '../src/acts-registry.mjs';
import { fateReader } from '../src/fate-reader.mjs';
import { RunJournal } from '../../src/adapters.mjs';
import { participate } from '../../src/participate.mjs';
import { stubParticipation } from './stub-participation.mjs';

const BIN = process.env.RUNEXEC_BIN, CLIENT = process.env.FOUR_ACTS_CLIENT;
const skip = BIN && CLIENT && existsSync(BIN) && existsSync(CLIENT) ? false : 'NOT CONNECTED: set RUNEXEC_BIN and FOUR_ACTS_CLIENT to ④\'s runexec and clients/acts.mjs';
const WORKER = fileURLToPath(new URL('./procs/acts-cli-worker.mjs', import.meta.url));
const dirOf = () => mkdtempSync(join(tmpdir(), 'p05-x4-'));

/** The wallet's GET /f/agent/fate, scripted per key; answers chunked (writeHead + write + end). */
async function fateServer(answerFor) {
  const s = createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const a = answerFor(u.searchParams.get('id'), u.searchParams.get('key'));
    if (a?.http) { res.writeHead(a.http, { 'content-type': 'application/json' }); res.write(JSON.stringify({ error: 'down', code: 'Unavailable' })); return res.end(); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write(JSON.stringify(a));
    res.end();
  });
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  return { port: s.address().port, close: () => new Promise(r => s.close(r)) };
}
async function closedPort() { const s = createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; }
const body = (agentId, key, state, extra = {}) => ({ agentId, retained: true, key, status: 'sent', state, sent: true, signature: 'sigA', lastValidBlockHeight: 5000, slotFloor: 4000, signedAt: 17, commitment: state === 'landed' ? 'finalized' : null, why: state, ...extra });
const real = (db, gatewayPort = null) => loadFourActsPort({ clientPath: CLIENT, bin: BIN, db, gatewayPort });

test('X1 ④\'s binary: register / status / list, ④\'s codes and next steps', { skip }, async () => {
  const dir = dirOf();
  try {
    const db = join(dir, 'runs.db');
    const acts = await real(db);
    const r = await acts.register({ agentId: 'agent1', key: 'ai:p05.r1', source: 'ai', runId: actsRunIdOf('agent1') });
    assert.deepEqual([r.run4Id, r.state, r.next, r.newAttemptAllowed, r.connection, acts.real], [run4IdOf('agent1', 'ai:p05.r1'), 'registered', 'wait', false, 'real', true]);
    assert.equal(r.run4Id, 'act-008445dbab443860', '④\'s id = ⑤\'s run4IdOf (sha256sum reference)');
    assert.equal((await acts.register({ agentId: 'agent1', key: 'ai:p05.r1', source: 'ai', runId: actsRunIdOf('agent1') })).run4Id, r.run4Id);
    await assert.rejects(acts.register({ agentId: 'agent1', key: 'ai:p05.r1', source: 'mcp', runId: actsRunIdOf('agent1') }), { code: 'Conflict' });
    await assert.rejects(acts.status({ agentId: 'agent1', key: 'ai:never' }), { code: 'NoRecord' });
    await assert.rejects(acts.register({ agentId: 'agent1', key: 'ai:x', source: 'robot' }), { code: 'BadRequest' });
    const l = await acts.list(actsRunIdOf('agent1'));
    assert.deepEqual(l.acts.map(a => a.run4Id), [r.run4Id]);
    assert.equal(l.acts[0].receiptVersion, 'p04-acts/0.1');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('X2 restart: every runexec call is its own process; the store answers across them, finals stay, conflicts are kept', { skip }, async () => {
  const dir = dirOf();
  let answer = 'pending';
  const w = await fateServer((id, key) => body(id, key, answer));
  try {
    const db = join(dir, 'runs.db');
    await (await real(db, w.port)).register({ agentId: 'agent1', key: 'ai:p05.r2', source: 'ai', runId: actsRunIdOf('agent1') });
    answer = 'landed';
    assert.equal((await (await real(db, w.port)).status({ agentId: 'agent1', key: 'ai:p05.r2' })).state, 'landed');
    await w.close();
    // The wallet is gone and a new client starts: the store still answers, from what it recorded.
    const after = await (await real(db)).status({ agentId: 'agent1', key: 'ai:p05.r2' });
    assert.deepEqual([after.state, after.final, after.signature, after.next], ['landed', true, 'sigA', 'done']);
    // A later, contradicting read never replaces a final state; it is kept as conflict.
    answer = 'expired';
    const w2 = await fateServer((id, key) => body(id, key, answer));
    const c = await (await real(db, w2.port)).status({ agentId: 'agent1', key: 'ai:p05.r2' });
    await w2.close();
    assert.deepEqual([c.state, c.conflict?.state], ['landed', 'expired']);
  } finally { await w.close().catch(() => {}); rmSync(dir, { recursive: true, force: true }); }
});

function child(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [WORKER, CLIENT, BIN, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { err += d; });
    p.on('error', reject);
    p.on('close', code => resolve({ code, err, ...(out.trim() ? JSON.parse(out.trim().split('\n').at(-1)) : {}) }));
  });
}

test('X3 several processes on one store at once: 4 register the same 15 acts while 2 read them — one row each, no store error', { skip, timeout: 120_000 }, async () => {
  const dir = dirOf();
  const w = await fateServer((id, key) => body(id, key, 'pending'));
  try {
    const db = join(dir, 'runs.db');
    await (await real(db)).register({ agentId: 'agent-m', key: 'ai:p05.mp0', source: 'ai', runId: actsRunIdOf('agent-m') });
    const rs = await Promise.all([
      ...[1, 2, 3, 4].map(() => child([db, 'register', 'agent-m', '15'])),
      ...[1, 2].map(() => child([db, 'status', 'agent-m', '15', String(w.port)])),
    ]);
    for (const r of rs) assert.equal(r.code, 0, r.err);
    const regs = rs.slice(0, 4);
    for (const r of regs) assert.deepEqual(r.errors, [], `register errors: ${r.errors}`);
    for (const r of regs) assert.deepEqual(r.ids, regs[0].ids, 'the same ids in every process');
    // Readers may run before a key is registered (NoRecord), never a store error.
    for (const r of rs.slice(4)) assert.ok(r.errors.every(e => e === 'NoRecord'), `read errors: ${r.errors}`);
    const l = await (await real(db)).list(actsRunIdOf('agent-m'));
    assert.equal(l.acts.length, 15);
  } finally { await w.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('X4 could not ask ≠ result unknown: closed port and 503 are unqueryable (facts kept); unknown holds; only proved expired allows a new attempt', { skip }, async () => {
  const dir = dirOf();
  let answer = { state: 'pending' };
  const w = await fateServer((id, key) => (answer.http ? answer : body(id, key, answer.state, answer.extra)));
  try {
    const db = join(dir, 'runs.db');
    const q = { agentId: 'agent1', key: 'ai:p05.r4' };
    await (await real(db, w.port)).register({ ...q, source: 'ai', runId: actsRunIdOf('agent1') });
    assert.equal((await (await real(db, w.port)).status(q)).state, 'pending');
    const gone = await (await real(db, await closedPort())).status(q);
    assert.deepEqual([gone.state, gone.next, gone.newAttemptAllowed, gone.signature, gone.lastValidBlockHeight], ['unqueryable', 'read-again', false, 'sigA', 5000]);
    assert.ok(gone.lastReadError);
    answer = { http: 503 };
    const busy = await (await real(db, w.port)).status(q);
    assert.deepEqual([busy.state, busy.next, busy.signature], ['unqueryable', 'read-again', 'sigA']);
    answer = { state: 'unknown', extra: { why: 'the node\'s history starts after the send' } };
    for (let i = 0; i < 5; i++) {
      const u = await (await real(db, w.port)).status(q);
      assert.deepEqual([u.state, u.next, u.newAttemptAllowed], ['unknown', 'hold', false], `read ${i}`);
    }
    answer = { state: 'expired', extra: { why: 'proved by the node\'s history' } };
    const x = await (await real(db, w.port)).status(q);
    assert.deepEqual([x.state, x.next, x.newAttemptAllowed, x.final], ['expired', 'new-attempt', true, true]);
  } finally { await w.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('X5 the substitute and the real registry give the same answers for the same wallet script', { skip }, async () => {
  const dir = dirOf();
  const script = [{ state: 'pending' }, { http: 503 }, { state: 'unknown' }, { state: 'landed' }, { state: 'expired' }, { http: 503 }];
  let answer = script[0];
  const w = await fateServer((id, key) => (answer.http ? answer : body(id, key, answer.state)));
  try {
    const realPort = await real(join(dir, 'runs.db'), w.port);
    const sub = localActsPort({ registry: new FileActsRegistry({ dir: join(dir, 'sub') }), fate: fateReader({ relay: `http://127.0.0.1:${w.port}`, fetch: globalThis.fetch }) });
    const q = { agentId: 'agent1', key: 'ai:p05.r5' };
    const fields = r => ({ run4Id: r.run4Id, state: r.state, final: r.final, next: r.next, newAttemptAllowed: r.newAttemptAllowed, signature: r.signature, signedAt: r.signedAt, lastValidBlockHeight: r.lastValidBlockHeight, cancel: r.cancel, conflict: r.conflict?.state ?? null, retention: r.retention });
    for (const p of [realPort, sub]) await p.register({ ...q, source: 'ai', runId: actsRunIdOf('agent1') });
    for (const a of script) {
      answer = a;
      const [x, y] = [await realPort.status(q), await sub.status(q)];
      assert.deepEqual(fields(y), fields(x), `after ${JSON.stringify(a)}`);
      assert.deepEqual([x.connection, y.connection], ['real', 'substitute']);
    }
  } finally { await w.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('X6 participate on the real registry, ⑤ restarted before every tick: registered before sending; result unknown never re-sent; a proved expiry → one new attempt', { skip, timeout: 120_000 }, async () => {
  const dir = dirOf();
  const fates = new Map();
  const w = await fateServer((id, key) => body(id, key, fates.get(key) ?? 'pending', { signature: `sig-${key}` }));
  try {
    const db = join(dir, 'runs.db');
    const acts = await real(db, w.port);
    const sent = [];
    let clock = 1_000_000;
    const st = stubParticipation({ clock: () => clock, deadlineSec: clock + 90 * 86_400, onAct: a => { sent.push(a.requestId); return { ok: true, status: 'sent', sent: true, signature: `sig-ai:${a.requestId}`, lastValidBlockHeight: 5000, slotFloor: 4000, signedAt: 17, charges: [] }; } });
    // the act is in ④'s store before the relay is asked
    const seenBefore = [];
    const reg = registerBeforeSend(acts, { agentId: 'agent1', source: 'ai' });
    const registerAct = async x => { const r = await reg(x); seenBefore.push((await acts.status({ agentId: 'agent1', key: `ai:${x.requestId}` }, { read: false })).state); return r; };
    // ⑤ restarts before every tick: the journal is re-read from its file, the registry port is made anew (④'s store
    // is the same file). Nothing of ⑤'s memory carries over except the journal file.
    const jfile = join(dir, 'journal.jsonl');
    const tick = async n => {
      const journal = new RunJournal({ file: jfile, now: () => clock * 1000 });
      const port = n === 1 ? acts : await real(db, w.port);
      return participate({ ...st.args, mandate: { ...st.args.mandate, expiresAt: clock + 86_400 }, journal, runId: `t${n}`, txState: txStateFromActs(port, { agentId: 'agent1', source: 'ai' }), registerAct: n === 1 ? registerAct : registerBeforeSend(port, { agentId: 'agent1', source: 'ai' }) });
    };
    await tick(1);
    assert.deepEqual([sent.length, seenBefore], [1, ['registered']]);
    fates.set(`ai:${sent[0]}`, 'unknown');
    for (let d = 1; d <= 5; d++) { clock += 86_400; const r = await tick(d + 1); assert.equal(r.verified[0]?.fateState, 'unknown'); }
    assert.equal(sent.length, 1, 'result unknown: five days later, not re-sent');
    fates.set(`ai:${sent[0]}`, 'expired');
    await tick(10); await tick(11);
    assert.equal(sent.length, 2);
    assert.notEqual(sent[1], sent[0]);
    const l = await acts.list(actsRunIdOf('agent1'));
    assert.deepEqual(new Set(l.acts.map(a => a.state)), new Set(['expired', 'pending']));
  } finally { await w.close(); rmSync(dir, { recursive: true, force: true }); }
});
