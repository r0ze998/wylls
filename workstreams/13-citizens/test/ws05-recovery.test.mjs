// W1 regression (integration 2026-11-08): a stop in the narrow windows of the model-call write-ahead record, reconciled
// on the next start against the cost ledger's own PERSISTENT state, which is authoritative:
//   after-wallet-hold   the wallet hold is saved, its record is not          → no call: the orphan `held` hold is released
//   after-mark-running  markRunning saved the hold `running`, record `reserved` → no call: released in both ledgers
//   after-cost-calling  5 has `calling` durably, record still `reserved`      → no call: released in 5 if 5 still says
//                       calling; if 5's own recovery made it `undecided`, it stays undecided in both (no evidence)
// For every case: both ledgers agree (5 settled = wallet spent, 5 undecided = wallet unresolved, nothing open), the
// crashed process made no model call in the cut-off turn, the recovered key is never called or reserved again, every
// action key is submitted once, and a further restart changes nothing.
//
// Keyless: run under test/keyless-guard.mjs (and scripts/ci/no-keys-guard.mjs from permutation-gateway). Fixture
// provider only: no model, no chain, no network, nothing billed. WS05_E9D1551A must point at the restored ORIGINAL
// workstream 5 package e9d1551a for the 5-ledger cases (nothing here claims anything about 5 at 9a4051c7); the
// flat-cost cases need no workstream 5.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runDemo } from '../demo/run-demo.mjs';
import { tmp } from './helpers.mjs';
import { ws05LedgerCost } from '../resident/ports/ws05-cost.mjs';
import { openResident } from '../world/harness.mjs';
import { fixtureProvider } from '../resident/ports/provider.mjs';

const ROOT = process.env.WS05_E9D1551A;
const skip5 = ROOT ? false : 'set WS05_E9D1551A to workstream 5 at e9d1551a';
const m5 = rel => import(pathToFileURL(path.join(ROOT, 'workstreams/05-ai-participation/model-api/src', rel)).href);
const PROVIDER = 'anthropic', MODEL = 'claude-fixture-model'; // an entry of 5's FIXTURE_BOOK (invented numbers)
const TURN = 3;

/** One 5 ledger directory per resident, a lease per open (a synthetic pid; the previous open's pid is dead). */
async function ws05Factory(root, { recover = true } = {}) {
  const { FileCostLedger } = await m5('cost-store.mjs');
  const { ProcessLease } = await m5('process-lease.mjs');
  const { FIXTURE_BOOK } = await m5('price-book.mjs');
  const alive = new Set();
  const lastPid = {};
  let next = 2_000_000;
  const costFor = r => {
    const dir = path.join(root, 'ws05', r.id);
    mkdirSync(dir, { recursive: true });
    if (lastPid[r.id]) alive.delete(lastPid[r.id]);
    const pid = (lastPid[r.id] = next++);
    alive.add(pid);
    const lease = new ProcessLease({ dir, agentId: r.id, pid, isAlive: p => alive.has(p), ttlMs: 3_600_000 });
    lease.acquire();
    const ledger = new FileCostLedger({ dir, init: { available: '400000', caps: {} }, lease });
    if (recover) ledger.recoverStale({ ttlMs: 3_600_000, isAlive: p => alive.has(p) });
    return ws05LedgerCost({ book: FIXTURE_BOOK(), ledger, provider: PROVIDER, model: MODEL });
  };
  return { costFor, ledgerOf: id => new FileCostLedger({ dir: path.join(root, 'ws05', id) }) };
}

const sum = xs => xs.reduce((a, b) => a + BigInt(b), 0n);
const inferenceHolds = r => Object.values(r.ledger.get(r.id).holds).filter(h => h.category === 'inference');
function wallet(r) {
  const rec = r.ledger.get(r.id);
  const holds = inferenceHolds(r);
  return { spent: BigInt(rec.bal.spent.inference ?? 0), unresolved: sum(holds.filter(h => h.state === 'unresolved').map(h => h.amount)), open: holds.filter(h => ['held', 'running'].includes(h.state)).length, holds };
}
function agree(r, l5) {
  const items = [...l5.items.values()];
  const c = l5.classes();
  const w = wallet(r);
  assert.equal(BigInt(c.settled), w.spent, `${r.id}: settled in 5 = spent in the wallet`);
  assert.equal(BigInt(c.undecided), w.unresolved, `${r.id}: undecided in 5 = unresolved in the wallet`);
  assert.equal(BigInt(c.reserved), 0n, `${r.id}: nothing left reserved or calling in 5`);
  assert.equal(w.open, 0, `${r.id}: no wallet hold left held or running`);
  assert.equal(new Set(items.map(i => i.key)).size, items.length, 'no key twice in 5');
  return { items, c, w };
}

/**
 * `wire` for every (re)open: counts provider calls (with the record keys that were `calling` at that moment, and
 * whether the instance is the one set to crash) and every action key submitted.
 */
function recorder() {
  const calls = [], submits = [];
  const wire = r => {
    const inst = r.crash ? 'crashed' : 'later';
    const p = r.ports.provider;
    const w = Object.create(p);
    w.decide = async req => {
      calls.push({ id: r.id, inst, turn: r.state.turn + 1, calling: Object.entries(r.state.costCalls ?? {}).filter(([, c]) => c.phase === 'calling').map(([k]) => k) });
      return p.decide(req);
    };
    r.ports.provider = w;
    const e = r.ports.execution;
    r.ports.execution = { ...e, async submit(req) { submits.push(`${r.id}|${req.idempotencyKey}`); return e.submit(req); } };
  };
  return { calls, submits, wire };
}

const holdIdOf = callKey => callKey.split(':infer:')[1];
const historyOf = r => r.ledger.get(r.id).history ?? [];

function common(r, rec) {
  assert.equal(r.summary.mechanical.restarts.length, 1, 'the stop happened');
  assert.equal(rec.calls.filter(c => c.id === 'ren' && c.inst === 'crashed' && c.turn === TURN).length, 0, 'the crashed process made no model call in the cut-off turn');
  assert.equal(new Set(rec.submits).size, rec.submits.length, 'every action key submitted once');
}

/** Opens Ren once more from its files and steps once: the reconciliation already done changes nothing. */
async function reopenOnce(r, { costFor, wire }) {
  const again = openResident(r.all.ren.dir, { world: r.all.world, board: r.all.board, provider: fixtureProvider({ mode: 'goal' }), costFor, wire });
  await again.step();
  return again;
}

// ---- with workstream 5's ledger (original e9d1551a) -----------------------------------------------------------------
const CASES = [
  // [stop point, 5's own recovery, expected 5 state of the recovered call]
  ['after-mark-running', true, 'released'],
  ['after-mark-running', false, 'released'],
  ['after-cost-calling', true, 'undecided'],
  ['after-cost-calling', false, 'released'],
];
for (const [at, recover, expect5] of CASES) {
  test(`5 ledger: a stop ${at} (5's own recovery ${recover ? 'on' : 'off'}): 5 says ${expect5}, the wallet follows, no model call, nothing twice`, { skip: skip5, timeout: 180_000 }, async () => {
    const out = tmp();
    const f = await ws05Factory(out, { recover });
    const rec = recorder();
    const r = await runDemo({ out, bells: 80, costFor: f.costFor, wire: rec.wire, crash: { resident: 'ren', at, turn: TURN } });
    common(r, rec);
    const ren = r.all.ren;
    const { items, w } = agree(ren, f.ledgerOf('ren'));
    for (const id of ['asa']) agree(r.all[id], f.ledgerOf(id));
    // The recovered call: the one item 5 closed at the restart (by its own recovery or by the resident's recover()).
    const recovered = items.filter(i => /restart|gone/.test(`${i.reason ?? ''} ${i.why ?? ''}`));
    assert.equal(recovered.length, 1, `exactly one recovered call: ${JSON.stringify(items.map(i => [i.key, i.state, i.reason ?? i.why ?? '']))}`);
    const key = recovered[0].key;
    assert.equal(recovered[0].state, expect5);
    assert.ok(new RegExp(`^ren:t${TURN}:infer:`).test(key), 'the cut-off turn\'s call');
    assert.ok(!rec.calls.some(c => c.calling.includes(key)), 'the recovered key was never called');
    const hold = ren.ledger.get('ren').holds[holdIdOf(key)];
    const kept = ren.state.costCalls?.[key];
    if (expect5 === 'undecided') {
      assert.equal(hold?.state, 'unresolved', 'the wallet keeps it unresolved: 5 says undecided, no evidence decides it');
      assert.equal(hold.amount, recovered[0].amount, 'same amount in both ledgers');
      assert.equal(kept?.costState, 'undecided', 'the record stays on file until 5 decides it');
      assert.equal(w.unresolved, BigInt(recovered[0].amount));
    } else {
      assert.equal(hold, undefined, 'the wallet hold was released (no model call was made)');
      assert.equal(kept, undefined, 'reconciled: the record is gone');
      assert.equal(BigInt(f.ledgerOf('ren').classes().undecided), 0n);
      assert.ok(historyOf(ren).some(e => e.type === 'release' && e.reason === 'restart before calling'), 'released by the reconciliation');
    }
    // Idempotent: one more restart (5 reopened, its recovery again; the resident reopened) changes nothing for this call.
    const before = { item: { ...f.ledgerOf('ren').items.get(key) }, hold: hold ? { ...ren.ledger.get('ren').holds[hold.id] } : null };
    const again = await reopenOnce(r, { costFor: f.costFor, wire: rec.wire });
    const item2 = f.ledgerOf('ren').items.get(key);
    assert.deepEqual([item2.state, item2.amount, item2.settled ?? null], [before.item.state, before.item.amount, before.item.settled ?? null], '5 unchanged for the recovered key');
    const hold2 = again.ledger.get('ren').holds[holdIdOf(key)];
    assert.deepEqual(hold2 ? [hold2.state, hold2.amount] : null, before.hold ? [before.hold.state, before.hold.amount] : null, 'wallet unchanged for the recovered key');
    agree(again, f.ledgerOf('ren'));
    assert.ok(!rec.calls.some(c => c.calling.includes(key)), 'still never called');
  });
}

test('5 ledger: a stop after the wallet hold, before its record: the orphan held hold is released; 5 never saw the call', { skip: skip5, timeout: 180_000 }, async () => {
  const out = tmp();
  const f = await ws05Factory(out);
  const rec = recorder();
  const r = await runDemo({ out, bells: 80, costFor: f.costFor, wire: rec.wire, crash: { resident: 'ren', at: 'after-wallet-hold', turn: TURN } });
  common(r, rec);
  const { items } = agree(r.all.ren, f.ledgerOf('ren'));
  assert.equal(items.filter(i => /restart|gone/.test(`${i.reason ?? ''} ${i.why ?? ''}`)).length, 0, '5 never reserved the cut-off call');
  assert.ok(historyOf(r.all.ren).some(e => e.type === 'release' && /never made/.test(e.reason ?? '')), 'the orphan hold was released');
});

// ---- flat cost (no workstream 5: runs in every keyless run) ---------------------------------------------------------
test('flat cost: a stop after the wallet hold leaves an orphan held hold; the next start releases it, and nothing else', { timeout: 180_000 }, async () => {
  const out = tmp();
  const rec = recorder();
  const r = await runDemo({ out, bells: 60, wire: rec.wire, crash: { resident: 'ren', at: 'after-wallet-hold', turn: TURN } });
  common(r, rec);
  const ren = r.all.ren;
  const w = wallet(ren);
  assert.equal(w.open, 0, 'no inference hold left held or running');
  assert.equal(w.unresolved, 0n, 'nothing made unresolved: the hold never ran');
  assert.equal(historyOf(ren).filter(e => e.type === 'release' && /never made/.test(e.reason ?? '')).length, 1, 'exactly one orphan released');
  const again = await reopenOnce(r, { wire: rec.wire });
  assert.equal(historyOf(again).filter(e => e.type === 'release' && /never made/.test(e.reason ?? '')).length, 1, 'a further restart releases nothing more');
});

test('flat cost: a stop right after markRunning (no record to prove the call was not made) stays unresolved, never released', { timeout: 180_000 }, async () => {
  const out = tmp();
  const rec = recorder();
  const r = await runDemo({ out, bells: 60, wire: rec.wire, crash: { resident: 'ren', at: 'after-mark-running', turn: TURN } });
  common(r, rec);
  const ren = r.all.ren;
  const w = wallet(ren);
  const unresolved = w.holds.filter(h => h.state === 'unresolved');
  assert.equal(unresolved.length, 1, 'the cut-off call is held unresolved (conservative: the flat path keeps no record)');
  assert.equal(unresolved[0].key, `ren:t${TURN}:infer`);
  assert.equal(w.open, 0);
  assert.ok(!historyOf(ren).some(e => e.type === 'release' && /never made/.test(e.reason ?? '')), 'not taken for an orphan');
});
