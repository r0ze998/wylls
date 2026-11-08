// ⑯ independent check of workstream 5's cost ledger recovery (10e74967 model-api/src/cost-store.mjs,
// process-lease.mjs): two processes after a crash, a zombie after a takeover, and repeated recovery.
// Keyless: the ledger is JSON files in a fresh temp dir; pids and clocks are injected numbers. No model, no network.
// WS05_ROOT: a checkout of workstream 5.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.env.WS05_ROOT;
const m5 = rel => import(pathToFileURL(path.join(ROOT, 'workstreams/05-ai-participation/model-api/src', rel)).href);
const { FileCostLedger } = await m5('cost-store.mjs');
const { ProcessLease } = await m5('process-lease.mjs');
const fresh = () => mkdtempSync(path.join(tmpdir(), 'v16-ws05-'));
const INIT = { available: 1000n.toString(), caps: {} };
const avail = l => BigInt(l.classes().available ?? l.fourClasses?.().available ?? 0);

function world() {
  const dir = fresh();
  let t = 1_000_000;
  const alive = new Set();
  const clock = () => t;
  const lease = pid => new ProcessLease({ dir, agentId: 'ren', ttlMs: 30_000, now: clock, pid, isAlive: p => alive.has(p) });
  return { dir, clock, alive, lease, tick: ms => { t += ms; } };
}

test('f1: one crash, two restarts racing: one takes the lease, the other is refused; recovery is applied once', () => {
  const w = world();
  w.alive.add(101);
  const a = FileCostLedger.openFenced({ dir: w.dir, lease: w.lease(101), init: INIT, now: w.clock });
  a.ledger.reserve('k1', 100);
  a.ledger.reserve('k2', 50); a.ledger.calling('k2');
  const before = avail(a.ledger);
  w.alive.delete(101); // process 101 crashes
  w.alive.add(202); w.alive.add(303);
  const bl = w.lease(202);
  const b = FileCostLedger.openFenced({ dir: w.dir, lease: bl, now: w.clock });
  assert.deepEqual([b.recovered.released, b.recovered.undecided], [['k1'], ['k2']]);
  assert.throws(() => FileCostLedger.openFenced({ dir: w.dir, lease: w.lease(303), now: w.clock }), e => e.code === 'AlreadyRunning');
  assert.equal(avail(b.ledger), before + 100n, 'k1 returned once; k2 (calling) stays held as undecided');
  // B's clean stop, then another restart: nothing more is recovered.
  bl.release();
  const c = FileCostLedger.openFenced({ dir: w.dir, lease: w.lease(303), now: w.clock });
  assert.deepEqual([c.recovered.released, c.recovered.undecided], [[], []]);
  assert.equal(avail(c.ledger), before + 100n);
});

test('f2: a zombie (alive but its heartbeat stale) after a takeover cannot reserve, and cannot move what was recovered', () => {
  const w = world();
  w.alive.add(101);
  const zl = w.lease(101);
  const z = FileCostLedger.openFenced({ dir: w.dir, lease: zl, init: INIT, now: w.clock });
  z.ledger.reserve('k1', 100);
  w.tick(31_000); // 101 hangs past the TTL without renewing
  w.alive.add(202);
  const b = FileCostLedger.openFenced({ dir: w.dir, lease: w.lease(202), now: w.clock });
  assert.deepEqual(b.recovered.released, ['k1']);
  const after = avail(b.ledger);
  // The zombie wakes up.
  assert.throws(() => z.ledger.reserve('k3', 10), e => e.code === 'LeaseLost', 'no new reservation');
  const r = { calling: z.ledger.calling('k1'), settle: z.ledger.settle('k1', 80) };
  assert.equal(r.settle, null, 'a released item is not settled');
  assert.equal(b.ledger.items.get('k1').state, 'released', 'the zombie did not move k1');
  assert.equal(avail(b.ledger), after, 'nothing charged twice or returned twice');
  console.log('f2 zombie calling() on a released item returned', JSON.stringify(r.calling ?? null), '(no refusal is raised: the caller is not told)');
});

test('f3: a call in flight when its process was taken over is undecided, then its measured cost is settled once', () => {
  const w = world();
  w.alive.add(101);
  const z = FileCostLedger.openFenced({ dir: w.dir, lease: w.lease(101), init: INIT, now: w.clock });
  z.ledger.reserve('k1', 100); z.ledger.calling('k1');
  const start = avail(z.ledger);
  w.tick(31_000);
  w.alive.add(202);
  const b = FileCostLedger.openFenced({ dir: w.dir, lease: w.lease(202), now: w.clock });
  assert.deepEqual(b.recovered.undecided, ['k1']);
  // The provider answered the zombie: its settle is the one record of the real cost.
  const s = z.ledger.settle('k1', 70);
  assert.equal(s?.settled, '70');
  assert.equal(avail(b.ledger), start + 30n, 'the reservation minus the measured cost came back, once');
  assert.equal(z.ledger.settle('k1', 70), null, 'a second settle does nothing');
  const c = b.ledger; c.release('k1', 'late release');
  assert.equal(c.items.get('k1').state, 'settled', 'a settled item cannot be released afterwards');
  assert.equal(avail(c), start + 30n);
});
