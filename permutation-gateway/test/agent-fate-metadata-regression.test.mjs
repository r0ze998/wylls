// Regression: a transaction found at finalized past its lifetime, but without
// result metadata (web3.js types `meta` as nullable), must stay `unknown`:
// never `landed` (no "no error" evidence) and never `expired` (the node
// returned it), whatever fullHistory says. Pure: only fate.mjs (import-free)
// and injected async fake reads. No SDK, network, keys, storage or timers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fateOf } from '../src/frontier/agent/fate.mjs';

const SIG = 'fake-signature-for-fate-metadata-regression';
const SENT = { signature: SIG, lastValidBlockHeight: 10, slotFloor: 3 };

/**
 * A fake connection. `status` is the first entry of getSignatureStatuses' value (null: no status);
 * `txs` are getTransaction's answers in order (the last repeats); a value that is an Error is thrown.
 */
function fake({ status = null, height = 11, txs = [null], first = 0 } = {}) {
  const calls = [];
  let n = 0;
  const give = v => { if (v instanceof Error) throw v; return v; };
  return {
    calls,
    async getSignatureStatuses(sigs, o) { calls.push(['getSignatureStatuses', sigs, o]); return give(status instanceof Error ? status : { context: { slot: 12 }, value: [status] }); },
    async getBlockHeight(c) { calls.push(['getBlockHeight', c]); return give(height); },
    async getTransaction(sig, o) { calls.push(['getTransaction', sig, o]); return give(txs[Math.min(n++, txs.length - 1)]); },
    async getFirstAvailableBlock() { calls.push(['getFirstAvailableBlock']); return give(first); },
  };
}
const names = c => c.calls.map(x => x[0]);

const NO_EVIDENCE = [
  ['meta: null', { slot: 4, meta: null }],
  ['meta missing', { slot: 4 }],
  ['meta without err', { slot: 4, meta: { fee: 5000 } }],
  ['meta.err undefined', { slot: 4, meta: { err: undefined } }],
];

for (const [label, tx] of NO_EVIDENCE) {
  for (const fullHistory of [false, true]) {
    test(`found at finalized, ${label}, fullHistory ${fullHistory}: unknown, not landed or expired`, async () => {
      const c = fake({ txs: [tx], first: 0 }); // first ≤ slotFloor: expiry would be provable if the tx were absent
      const f = await fateOf(c, SENT, { fullHistory });
      assert.equal(f.fate, 'unknown');
      assert.equal(f.commitment, 'finalized');
      assert.equal(f.queryFailed, false);
      assert.match(f.why, /without result metadata/);
      // Decided by the found transaction: the history-coverage read is never reached.
      assert.deepEqual(names(c), ['getSignatureStatuses', 'getBlockHeight', 'getTransaction']);
    });
  }
}

test('the reproduced case: status value [null], height 11 > lifetime 10, {slot: 4, meta: null} is unknown', async () => {
  const c = fake({ status: null, height: 11, txs: [{ slot: 4, meta: null }] });
  const f = await fateOf(c, { signature: SIG, lastValidBlockHeight: 10 }, {});
  assert.deepEqual({ fate: f.fate, commitment: f.commitment, queryFailed: f.queryFailed }, { fate: 'unknown', commitment: 'finalized', queryFailed: false });
});

test('found at finalized with explicit meta.err null: landed', async () => {
  for (const fullHistory of [false, true]) {
    const f = await fateOf(fake({ txs: [{ slot: 4, meta: { err: null } }] }), SENT, { fullHistory });
    assert.equal(f.fate, 'landed');
    assert.equal(f.commitment, 'finalized');
    assert.equal(f.queryFailed, false);
  }
});

test('found at finalized with a real error: failed', async () => {
  for (const err of [{ InstructionError: [0, { Custom: 1 }] }, 'AccountInUse']) {
    for (const fullHistory of [false, true]) {
      const f = await fateOf(fake({ txs: [{ slot: 4, meta: { err } }] }), SENT, { fullHistory });
      assert.equal(f.fate, 'failed');
      assert.equal(f.commitment, 'finalized');
      assert.equal(f.queryFailed, false);
    }
  }
});

test('a later read with metadata decides: unknown → landed, unknown → failed', async () => {
  const ok = fake({ txs: [{ slot: 4, meta: null }, { slot: 4, meta: { err: null } }] });
  assert.equal((await fateOf(ok, SENT, { fullHistory: true })).fate, 'unknown');
  assert.equal((await fateOf(ok, SENT, { fullHistory: true })).fate, 'landed');
  const bad = fake({ txs: [{ slot: 4 }, { slot: 4, meta: { err: { InstructionError: [0, 'Custom'] } } }] });
  assert.equal((await fateOf(bad, SENT)).fate, 'unknown');
  assert.equal((await fateOf(bad, SENT)).fate, 'failed');
});

// ---------------------------------------------------------------- unchanged paths

test('status path unchanged: finalized without/with error, not finalized, read failure', async () => {
  const landed = fake({ status: { slot: 4, confirmationStatus: 'finalized', err: null } });
  assert.deepEqual(await fateOf(landed, SENT), { fate: 'landed', why: 'finalized', commitment: 'finalized', queryFailed: false });
  assert.deepEqual(names(landed), ['getSignatureStatuses']);
  const failed = await fateOf(fake({ status: { slot: 4, confirmationStatus: 'finalized', err: { InstructionError: [0, 'Custom'] } } }), SENT);
  assert.equal(failed.fate, 'failed');
  const confirmed = await fateOf(fake({ status: { slot: 4, confirmationStatus: 'confirmed', err: null } }), SENT);
  assert.deepEqual({ fate: confirmed.fate, commitment: confirmed.commitment, queryFailed: confirmed.queryFailed }, { fate: 'pending', commitment: 'confirmed', queryFailed: false });
  const down = await fateOf(fake({ status: new Error('boom') }), SENT);
  assert.deepEqual({ fate: down.fate, commitment: down.commitment, queryFailed: down.queryFailed }, { fate: 'pending', commitment: null, queryFailed: true });
});

test('expiry path unchanged: absent tx past its lifetime', async () => {
  const full = await fateOf(fake({ txs: [null] }), SENT, { fullHistory: true });
  assert.deepEqual({ fate: full.fate, commitment: full.commitment, queryFailed: full.queryFailed }, { fate: 'expired', commitment: null, queryFailed: false });
  assert.equal((await fateOf(fake({ txs: [null], first: 3 }), SENT)).fate, 'expired'); // first ≤ slotFloor
  assert.equal((await fateOf(fake({ txs: [null], first: 4 }), SENT)).fate, 'unknown'); // history starts after slotFloor
  assert.equal((await fateOf(fake({ txs: [null] }), { signature: SIG, lastValidBlockHeight: 10 })).fate, 'unknown'); // no slotFloor
  const cov = await fateOf(fake({ txs: [null], first: new Error('x') }), SENT);
  assert.deepEqual({ fate: cov.fate, queryFailed: cov.queryFailed }, { fate: 'unknown', queryFailed: true });
});

test('lifetime and read-failure paths unchanged', async () => {
  const within = fake({ height: 10, txs: [{ slot: 4, meta: null }] });
  assert.equal((await fateOf(within, SENT, { fullHistory: true })).fate, 'pending');
  assert.deepEqual(names(within), ['getSignatureStatuses', 'getBlockHeight']); // no transaction read within the lifetime
  assert.equal((await fateOf(fake(), { signature: SIG, lastValidBlockHeight: null })).fate, 'unknown');
  const h = await fateOf(fake({ height: new Error('h') }), SENT);
  assert.deepEqual({ fate: h.fate, queryFailed: h.queryFailed }, { fate: 'pending', queryFailed: true });
  const t = await fateOf(fake({ txs: [new Error('t')] }), SENT, { fullHistory: true });
  assert.deepEqual({ fate: t.fate, commitment: t.commitment, queryFailed: t.queryFailed }, { fate: 'unknown', commitment: null, queryFailed: true });
});
