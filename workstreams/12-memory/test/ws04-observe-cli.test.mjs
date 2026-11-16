// 13's observe-canonical command with `--runexec --ws04-store|--ws04-db` (2026-11-17), every I/O injected: a fake
// execFile, a herald that answers 503, an RPC and a store reader that refuse. SOURCE-ONLY when written: not run.
// No process is started, no socket opened, no database opened. (Module loading reads this repository's source files;
// no other file is read or written.) Each injected function counts its calls, and the counts are asserted: a refusal
// that observeLive catches internally (it catches a store reader's throw) still shows as a call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../../13-citizens/bin/observe-canonical.mjs';

const H = ['world_binding_unproven', 'finality_unproven', 'transaction_record_identity_unproven', 'committed_frame_unproven'];
const ROW = { event_cursor: 1, archive_sequence: 1, ps2_ordinal: 0, signature: 'sig1', transaction_slot: 101, body_sha256: 'a'.repeat(64), local_locator: 'findex-row:1:0',
  event: { kind: 'caravan_settled', value: { key: { owner: 18446744073709551615n, seq: 3 }, outcome: 0, dst: { kind: 2, p: 3, q: 0, at: 4, gen: 1 }, cargo: [0, 0, 0, 0, 0, 0, 0, 0], credited: null, slot: 101 } },
  held: H, archive_epoch: { epoch: { from_seq: 1, source: 'rpc_poll', program_configured: 'P', commitment_requested: 'finalized' }, why: 'covered_by_epoch', pairing: 'same_directory_not_proof_of_same_archive' } };
const PAGE = { format: 'ws04-observation/0', basis: 'unproven', world: null, finality: null, complete: null, observations: [ROW], next_local_cursor: 1,
  held: ['not_executor_receipts', 'source_provenance_unproven', 'resume_cursor_not_admitted', 'store_pairing_is_not_a_snapshot_or_proof', 'archive_epoch_is_producer_setting_not_evidence'],
  store: { same_directory: true, index_last_seq: 1, manifest_next_seq_before: 2, manifest_next_seq_after: 2, manifest_stable: true, generation: 'index_matches_manifest', limits: ['two files read one after the other: not one snapshot'] } };
// runexec prints u64 as a bare number: write the owner as such, so the parse must keep it exact
const PRINTED = JSON.stringify(PAGE, (k, v) => (typeof v === 'bigint' ? `@@${v}@@` : v)).replace(/"@@(\d+)@@"/g, '$1');
const base = ['--herald', 'http://127.0.0.1:1', '--rpc', 'http://127.0.0.1:2', '--store', '/nowhere/runexec.sqlite'];
/** The herald answers 503; the RPC and the store reader refuse; every call is counted. Without `readStore` here,
 *  observeLive would fall back to the real SQLite reader (`io.readStore ?? readWs04Store`). */
function fakeIo() {
  const n = { getJson: [], rpc: 0, readStore: 0 };
  return { n, io: {
    getJson: async url => { n.getJson.push(url); return { ok: false, status: 503 }; },
    rpc: async () => { n.rpc++; throw new Error('no RPC in this test'); },
    readStore: () => { n.readStore++; throw new Error('no store is opened in this test'); },
  } };
}
async function run(args, answer) {
  const calls = [];
  const execFile = (bin, a, opts, cb) => { calls.push({ bin, a, opts }); const [err, out] = answer(); setImmediate(() => cb(err, out, '')); };
  const printed = [];
  const { n, io } = fakeIo();
  const code = await main([...base, ...args], { io, execFile, print: s => printed.push(s) });
  return { code, out: JSON.parse(printed.at(-1)), calls, n };
}
/** No RPC, no store; the herald only asked for its Season and its events (both 503), at the fake address. */
function onlyHeraldReads(n) {
  assert.equal(n.rpc, 0, 'no RPC call');
  assert.equal(n.readStore, 0, 'no store reader call: no database is chosen or opened');
  assert.ok(n.getJson.every(u => u.startsWith('http://127.0.0.1:1/h/')), n.getJson.join(' '));
}

test('a store page from runexec reaches 12\'s held report with its epochs and pairing, every hold kept', async () => {
  const { out, calls, n } = await run(['--runexec', '/x/runexec', '--ws04-store', '/s', '--ws04-limit', '10'], () => [null, `${PRINTED}\n`]);
  onlyHeraldReads(n);
  assert.deepEqual(n.getJson, ['http://127.0.0.1:1/h/season', 'http://127.0.0.1:1/h/events?after=0']);
  assert.deepEqual(calls.map(c => c.a), [['observe', 'store', '--store', '/s', '--limit', '10']]);
  assert.deepEqual(out.ws04Read, { status: 'read', mode: 'store' });
  const w = out.ws04;
  assert.deepEqual([w.status, w.admitted], ['held', 0]);
  assert.ok(w.pageHeld.includes('store_pairing_is_not_a_snapshot_or_proof'));
  assert.deepEqual(w.observations[0].held, H);
  assert.deepEqual(w.observations[0].archive_epoch, ROW.archive_epoch);
  assert.equal(w.store.generation, 'index_matches_manifest'); assert.deepEqual(w.store.unsafe, []);
  assert.deepEqual(w.why, []);
  assert.equal(out.status, 'world_unverified', 'the herald part is unaffected (503 here)');
});

test('a failed read is ws04Read not_read with runexec\'s code; nothing is handed to 12; never NoRecord', async () => {
  for (const [answer, code] of [[() => [Object.assign(new Error('exit 1'), { code: 1 }), '{"error":"ObservationNotRead","message":"m"}\n'], 'ObservationNotRead'],
    [() => [Object.assign(new Error('ENOENT'), { code: 'ENOENT' }), ''], 'Spawn']]) {
    const { out, n } = await run(['--runexec', 'r', '--ws04-db', '/s/index.sqlite'], answer);
    onlyHeraldReads(n);
    assert.equal(out.ws04Read.status, 'not_read'); assert.equal(out.ws04Read.code, code); assert.notEqual(out.ws04Read.code, 'NoRecord');
    assert.equal(out.ws04, null);
  }
});

test('page sources are exclusive and checked before anything is started', async () => {
  for (const args of [['--ws04-observation', 'p.json', '--runexec', 'r', '--ws04-store', '/s'], ['--runexec', 'r', '--ws04-store', '/s', '--ws04-db', '/d'],
    ['--runexec', 'r'], ['--ws04-store', '/s'], ['--ws04-limit', '5'], ['--runexec', '', '--ws04-store', '/s'], ['--runexec', 'r', '--ws04-store', '']]) {
    const { code, calls, out, n } = await run(args, () => [null, '{}']);
    assert.equal(code, 64, JSON.stringify(args)); assert.equal(out.error, 'usage'); assert.deepEqual(calls, []);
    assert.deepEqual([n.getJson.length, n.rpc, n.readStore], [0, 0, 0], 'a usage error reads nothing at all');
  }
});
