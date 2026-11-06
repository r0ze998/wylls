// Workstream 13's open case (its WORK-20261106c §5): a resident's process stopped right after ⑤'s reservation and
// before 13 saved its own state — so 13 cannot tell ⑤ about the key. ⑤ recovers it alone when the next process opens
// the ledger with FileCostLedger.openFenced (lease first, then the restart rule). Real child processes, killed.
//   W1 stopped after reserve: released at the next open; its amount counts against the caps until then, never twice
//   W2 stopped after calling: UNDECIDED at the next open — never released, never 0; still counted against the caps
//   W3 the next open while the stopped process's lease is someone else's live one: refused, nothing recovered
// KEY-FREE: files and child processes only; no relay, no chain, no key, nothing signed, no model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileCostLedger } from '../src/cost-store.mjs';
import { ProcessLease } from '../src/process-lease.mjs';

const WORKER = fileURLToPath(new URL('./procs/ledger-worker.mjs', import.meta.url));
const dirOf = () => mkdtempSync(join(tmpdir(), 'p05-ws13-'));
const run = args => new Promise((resolve, reject) => {
  const p = spawn(process.execPath, [WORKER, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { err += d; });
  p.on('error', reject);
  p.on('close', (code, signal) => resolve({ code, signal, err, lines: out.split('\n').filter(Boolean).map(l => JSON.parse(l)) }));
});
const KEY = 'asa:t3:infer:h17'; // 13's key form <resident>:t<turn>:infer:<hold id>

test('W1 stopped right after reserve (13\'s state not saved): the next open releases it; until then the caps count it once', async () => {
  const dir = dirOf();
  try {
    const a = await run(['ws13-stop', dir, 'asa', 'after-reserve', KEY, '6000']);
    assert.equal(a.signal, 'SIGKILL', a.err);
    // Before anyone recovers: the stale reservation still counts — a second 6000 does not fit the 10000 total.
    const peek = new FileCostLedger({ dir });
    assert.equal(peek.items.get(KEY).state, 'reserved');
    assert.equal(peek.check('6000')?.code, 'CategoryTotalLimit', 'not spent twice while it is unknown whether it was used');
    const next = new ProcessLease({ dir, agentId: 'asa', ttlMs: 3_600_000 });
    const { ledger, lease, recovered } = FileCostLedger.openFenced({ dir, lease: next });
    assert.equal(lease.epoch, 2);
    assert.deepEqual(recovered, { undecided: [], released: [KEY] });
    assert.equal(ledger.items.get(KEY).state, 'released');
    assert.equal(ledger.classes().available, '10000');
    ledger.reserve('asa:t3:infer:h18', '6000');     // the resident's next call under a new key: it fits again
    assert.throws(() => ledger.reserve(KEY, '1'), { code: 'DuplicateKey' }, 'the old key is never reused');
    assert.deepEqual(FileCostLedger.openFenced({ dir, lease: next }).recovered, { undecided: [], released: [] }, 'idempotent, and its own reservation stays');
    next.release();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('W2 stopped after calling: UNDECIDED at the next open (never released, never 0), and still counted', async () => {
  const dir = dirOf();
  try {
    const a = await run(['ws13-stop', dir, 'ren', 'after-calling', KEY, '6000']);
    assert.equal(a.signal, 'SIGKILL', a.err);
    const next = new ProcessLease({ dir, agentId: 'ren', ttlMs: 3_600_000 });
    const { ledger, recovered } = FileCostLedger.openFenced({ dir, lease: next });
    assert.deepEqual(recovered, { undecided: [KEY], released: [] });
    const c = ledger.classes();
    assert.deepEqual([c.undecided, c.available], ['6000', '4000']);
    assert.equal(ledger.release(KEY, 'try'), null, 'code cannot release it');
    assert.throws(() => ledger.decide(KEY, { by: 'operator', outcome: 'refund', note: 'looks unused' }), { code: 'EvidenceRequired' }, 'not refunded (0) without evidence');
    assert.equal(ledger.check('6000')?.code, 'CategoryTotalLimit', 'the caps still count it');
    next.release();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('W3 a live other process holds the resident: the open is refused and nothing of its reservations is touched', async () => {
  const dir = dirOf();
  try {
    const live = new ProcessLease({ dir, agentId: 'kai', ttlMs: 3_600_000 });
    const { ledger } = FileCostLedger.openFenced({ dir, lease: live, init: { available: '10000', caps: { total: '10000' } } });
    ledger.reserve(KEY, '5000');
    const other = new ProcessLease({ dir, agentId: 'kai', ttlMs: 3_600_000, pid: process.pid + 100000, isAlive: pid => pid === process.pid || pid === process.pid + 100000 });
    assert.throws(() => FileCostLedger.openFenced({ dir, lease: other }), { code: 'AlreadyRunning' });
    assert.equal(new FileCostLedger({ dir }).items.get(KEY).state, 'reserved');
    live.release();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
