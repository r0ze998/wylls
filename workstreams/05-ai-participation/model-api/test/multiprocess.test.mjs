// Several PROCESSES on one machine sharing ⑤'s cost ledger and the per-agent lease (real child processes).
//   P1 no double spend: four processes race for a total cap of 50 calls — exactly 50 are reserved, every key once
//   P2 one autopilot per agent: of three processes taking the same agent's lease at once, exactly one gets it
//   P3 a crashed process: its call in flight becomes UNDECIDED (never released, never 0); its unsent reservation comes back
//   P4 a hung process: taken over after its TTL, it can no longer reserve (LeaseLost) or renew
//   P6 the status answer for ③ in ④'s vocabulary, never stronger than what the relay shows
// KEY-FREE: no key is generated or derived and nothing is signed here (no relay, no chain). P5 and P7, which run the
// autopilot over the local relay fixture (in-memory test keys, the fixture relay signs), are in multiprocess-world.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileCostLedger } from '../src/cost-store.mjs';
import { ProcessLease } from '../src/process-lease.mjs';
import { RunCostMock } from '../src/run-cost.mjs';
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

test('P1 no double spend across processes: four processes race for a total cap of 50 calls — exactly 50 reserved, each key once', async () => {
  const dir = dirOf();
  try {
    new FileCostLedger({ dir, init: { available: '1000000', caps: { total: '5000' } } });
    const rs = await Promise.all([1, 2, 3, 4].map(i => run(['race', dir, 'agent-x', `p${i}`, '40', '100'])));
    for (const r of rs) assert.equal(r.code, 0, r.err);
    const ok = rs.reduce((t, r) => t + r.lines.at(-1).ok, 0);
    assert.equal(ok, 50, `reserved ${ok}`);
    assert.ok(rs.every(r => r.lines.length === 1), 'no unexpected refusal');
    const l = new FileCostLedger({ dir });
    const c = l.classes();
    assert.deepEqual([c.settled, c.reserved, c.undecided], ['5000', '0', '0']);
    assert.equal(l.items.size, 50);
    assert.equal(JSON.parse(readFileSync(join(dir, 'ledger.json'), 'utf8')).v, 1, 'the ledger file is whole');
    assert.deepEqual(readdirSync(dir).filter(f => /\.(tmp|mutex)/.test(f)), [], 'no temporary or lock files left');
    // Without the shared ledger, each process would keep its own count: the same cap admits 50 per process.
    const [a, b] = [new RunCostMock({ available: '1000000', caps: { total: '5000' } }), new RunCostMock({ available: '1000000', caps: { total: '5000' } })];
    let alone = 0;
    for (const m of [a, b]) for (let i = 0; i < 50; i++) { m.reserve(`k${i}`, '100'); alone++; }
    assert.equal(alone, 100, 'two in-memory ledgers would have spent the cap twice');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('P2 one autopilot per agent across processes: of three processes taking the same lease at once, exactly one gets it', async () => {
  const dir = dirOf();
  try {
    const rs = await Promise.all([1, 2, 3].map(() => run(['lease', dir, 'agent-y', '30000', '600'])));
    const got = rs.map(r => r.lines[0]);
    assert.equal(got.filter(g => g.acquired).length, 1, JSON.stringify(got));
    assert.ok(got.filter(g => !g.acquired).every(g => g.code === 'AlreadyRunning'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('P3 a crashed process: its call in flight becomes UNDECIDED (never released), its unsent reservation comes back; the next process takes over', async () => {
  const dir = dirOf();
  try {
    new FileCostLedger({ dir, init: { available: '1000', caps: { total: '1000' } } });
    const r = await run(['crash', dir, 'agent-z', '30000']);
    assert.equal(r.signal, 'SIGKILL');
    assert.equal(r.lines[0].ready, true);
    // The next process: the dead holder's lease is taken over at once (its process is gone, whatever the TTL).
    const lease = new ProcessLease({ dir, agentId: 'agent-z', ttlMs: 30_000 });
    const l = lease.acquire();
    assert.equal(l.epoch, 2);
    assert.equal(l.takenOver.leaseId, r.lines[0].leaseId);
    const ledger = new FileCostLedger({ dir, lease });
    assert.deepEqual(ledger.recoverStale({ ttlMs: 30_000 }), { undecided: ['crash-calling#0'], released: ['crash-reserved#0'] });
    const c = ledger.classes();
    assert.deepEqual([c.undecided, c.released, c.available], ['100', '100', '900'], 'the call that may have been billed stays held; the unsent one is back');
    assert.equal(ledger.release('crash-calling#0', 'try'), null, 'an undecided cost cannot be released by code');
    lease.release();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('P4 a hung process: after its TTL another process takes the agent over; the hung one can no longer reserve or renew', async () => {
  const dir = dirOf();
  try {
    new FileCostLedger({ dir, init: { available: '1000', caps: { total: '1000' } } });
    const hung = run(['zombie', dir, 'agent-w', '200', '700']);
    await new Promise(res => setTimeout(res, 400));                // the hung process's lease is now older than 200 ms
    const lease = new ProcessLease({ dir, agentId: 'agent-w', ttlMs: 200 });
    const l = lease.acquire();                                     // its process is alive, but its heartbeat is stale
    assert.equal(l.epoch, 2);
    const r = await hung;
    const lines = Object.assign({}, ...r.lines);
    assert.deepEqual([lines.reserved, lines.code], [false, 'LeaseLost']);
    assert.equal(lines.renewed, false);
    assert.equal(new FileCostLedger({ dir }).items.has('zombie#0'), false, 'nothing reserved by the process that was taken over');
    lease.release();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('P6 the status answer never claims more than the relay shows: expired is not Absent; refused and unknown are told apart', async () => {
  const journal = { entries: [
    { step: 'act-begin', attemptId: 'p05.a' }, { step: 'act-result', attemptId: 'p05.a', outcome: 'sent', signature: 'SIG-A' },
    { step: 'act-begin', attemptId: 'p05.b' }, { step: 'act-result', attemptId: 'p05.b', outcome: 'refused', code: 'BudgetExceeded' },
    { step: 'act-begin', attemptId: 'p05.c' }, { step: 'act-error', attemptId: 'p05.c', outcome: 'unknown', code: 'RelayUnreachable' },
  ] };
  const tx = state => async () => ({ state });
  assert.equal((await statusOf({ journal, txState: tx('expired') }, 'p05.a')).chain.status, 'Unavailable');
  assert.equal((await statusOf({ journal, txState: tx('failed') }, 'p05.a')).chain.status, 'Failed');
  assert.equal((await statusOf({ journal, txState: async () => { throw new Error('down'); } }, 'p05.a')).chain.status, 'Unavailable');
  const refused = await statusOf({ journal, txState: tx('landed') }, 'p05.b');
  assert.deepEqual([refused.submission, refused.code, refused.chain, refused.terminal], ['refused', 'BudgetExceeded', null, true]);
  const unknown = await statusOf({ journal, txState: tx('landed') }, 'p05.c');
  assert.deepEqual([unknown.submission, unknown.chain.status, unknown.terminal], ['begun-unknown', 'Unavailable', false]);
  assert.equal((await statusOf({ journal, txState: tx('landed') }, 'p05.zzz')).submission, 'unknown-request');
  for (const s of ['landed', 'failed', 'expired', 'unknown']) assert.notEqual((await statusOf({ journal, txState: tx(s) }, 'p05.a')).chain.status, 'Absent', 'Absent is never derived from the relay');
  assert.ok(existsSync(WORKER));
});

