// 13's observe-canonical command with `--runexec --ws04-store|--ws04-db` (2026-11-17), every I/O injected: a fake
// execFile, a herald that answers 503, an RPC and a store reader that refuse. SOURCE-ONLY when written: not run.
// No process is started, no socket opened, no database opened. (Module loading reads this repository's source files;
// no other file is read or written.) Each injected function counts its calls, and the counts are asserted: a refusal
// that observeLive catches internally (it catches a store reader's throw) still shows as a call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../../13-citizens/bin/observe-canonical.mjs';
import { readFileSync } from 'node:fs';
import { b58encode } from '../adapters/canonical.mjs';
import { parseJsonU64 } from '../adapters/ws04-receipts.mjs';

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

// (2026-11-17) Past the herald: a normal Season and its events (the same fixtures as live-observation.test.mjs), so
// observeLive goes on to the RPC, the store and connectCanonical. Every one of them is a counted fake: the store
// reader returns 4's SIMULATOR receipts from fixtures/ws04-receipts (a fixture: never chain evidence). No binding
// files are given (the command would read them), so the RPC's cluster and the store's world are undeclared: holding
// every receipt is the correct answer here, and no RPC call is made.
const bytes = (fill) => Buffer.alloc(32, fill);
const PROGRAM = b58encode(bytes(0x21)), SEASON_PDA = b58encode(bytes(0x42));
const SEASON = { v: 1, programId: PROGRAM, cluster: 'localnet', sample: false, season: '1', seasonAddress: SEASON_PDA, genesisTs: 1_000_000, bellSecs: 600,
  continuous: true, latestSlot: 40, latestUnix: 1_000_000 + 200 * 600, slot: 40 };
const EVENTS = { v: 1, events: [2, 4, 6, 24].map((slot, i) => ({ seq: String(i + 1), slot, sig: `s${slot}`, kind: 1, bell: 100 + slot })), next: '4', full: false };
function fixtureStore() {
  const v = JSON.parse(readFileSync(new URL('../fixtures/ws04-receipts/happy.json', import.meta.url), 'utf8'));
  return { world: 'sim-world-1', runSpecs: Object.fromEntries(Object.entries(v.run_specs_json).map(([id, spec]) => [id, parseJsonU64(spec)])),
    receipts: v.receipts.map(r => ({ run_id: r.run_id, kind: r.kind, subject: r.subject, source: r.source, slot: Number(r.slot), body: parseJsonU64(r.body_json) })) };
}

test('past a normal Season: every I/O is a counted fake, the store reader is the fake (no SQLite), receipts held, 4\'s page held to the end', async () => {
  const store = fixtureStore();
  const n = { getJson: [], rpc: 0, readStore: [] };
  const io = {
    getJson: async url => {
      n.getJson.push(url);
      if (url === 'http://127.0.0.1:1/h/season') return { ok: true, status: 200, body: SEASON };
      if (url === 'http://127.0.0.1:1/h/events?after=0') return { ok: true, status: 200, body: EVENTS };
      return { ok: false, status: 404 };
    },
    rpc: async () => { n.rpc++; throw new Error('no RPC in this test'); },
    readStore: path => { n.readStore.push(path); return store; },
  };
  const spawned = [];
  const execFile = (bin, a, opts, cb) => { spawned.push({ bin, a, shell: opts.shell }); setImmediate(() => cb(null, `${PRINTED}\n`, '')); };
  const printed = [];
  const code = await main([...base, '--herald-kind', 'chain', '--rpc-kind', 'chain', '--store-kind', 'chain',
    '--runexec', '/x/runexec', '--ws04-store', '/s'], { io, execFile, print: s => printed.push(s) });
  const out = JSON.parse(printed.at(-1));
  // what was asked, and of whom
  assert.deepEqual(n.getJson, ['http://127.0.0.1:1/h/season', 'http://127.0.0.1:1/h/events?after=0']);
  assert.equal(n.rpc, 0, 'no RPC: the RPC <-> cluster pairing is not declared');
  assert.deepEqual(n.readStore, ['/nowhere/runexec.sqlite'], 'the injected reader, once: no SQLite fallback, nothing opened');
  assert.deepEqual(spawned, [{ bin: '/x/runexec', a: ['observe', 'store', '--store', '/s'], shell: false }]);
  // the observation: held, with its reasons; labels lowered, never chain
  assert.equal(code, 2); assert.equal(out.status, 'held');
  assert.ok(out.reasons.includes('rpc_cluster_undeclared') && out.reasons.includes('world_binding_undeclared'), out.reasons.join(' '));
  assert.equal(out.held.length, store.receipts.length);
  assert.ok(out.held.every(h => h.why === 'world_binding_undeclared'));
  assert.equal(out.ingest, null, 'nothing taken in');
  assert.deepEqual(out.world, { cluster: 'localnet', world_id: `${PROGRAM}/${SEASON_PDA}` });
  assert.equal(out.inputs.finality.slot, null);
  for (const part of ['world', 'clock', 'identity', 'records']) assert.equal(out.provenance[part]?.kind, 'integration-output', part);
  assert.equal(out.provenance.finality, null);
  assert.notEqual(out.basis, 'chain');
  // 4's page reaches the end of the output, held, with its epoch and pairing as given
  assert.deepEqual(out.ws04Read, { status: 'read', mode: 'store' });
  assert.deepEqual([out.ws04.status, out.ws04.admitted, out.ws04.why], ['held', 0, []]);
  assert.deepEqual(out.ws04.observations[0].held, H);
  assert.equal(out.ws04.observations[0].archive_epoch.why, 'covered_by_epoch');
  assert.equal(out.ws04.store.generation, 'index_matches_manifest');
  assert.equal(out.resident.assembled, false);
});

// (2026-11-17, SOURCE-ONLY when written: not run) the CLI's own input and its diagnostic of the page's mode
test('an empty --ws04-observation is a usage error, not "no page asked for"; nothing is read or started', async () => {
  const { code, out, calls, n } = await run(['--ws04-observation', ''], () => { throw new Error('nothing is started'); });
  assert.equal(code, 64); assert.deepEqual(out, { error: 'usage', why: '--ws04-observation is empty' });
  assert.deepEqual(calls, []); assert.deepEqual(n.getJson, []); assert.equal(n.rpc, 0); assert.equal(n.readStore, 0);
});

test('a page of the other mode is named in ws04Read, still handed to 12 and held; the agreeing mode adds nothing', async () => {
  const plain = { ...PAGE, held: PAGE.held.slice(0, 3), observations: [{ ...ROW, archive_epoch: undefined }] };
  delete plain.store; delete plain.observations[0].archive_epoch;
  const PLAIN = JSON.stringify(plain, (k, v) => (typeof v === 'bigint' ? `@@${v}@@` : v)).replace(/"@@(\d+)@@"/g, '$1');
  const W = ['ws04_page_mode_not_the_requested_mode'];
  for (const [args, printed, read] of [
    [['--runexec', 'r', '--ws04-db', '/s/index.sqlite'], PRINTED, { status: 'read', mode: 'db', why: W }],
    [['--runexec', 'r', '--ws04-store', '/s'], PLAIN, { status: 'read', mode: 'store', why: W }],
    [['--runexec', 'r', '--ws04-db', '/s/index.sqlite'], PLAIN, { status: 'read', mode: 'db' }],
    [['--runexec', 'r', '--ws04-store', '/s'], PRINTED, { status: 'read', mode: 'store' }],
  ]) {
    const { out, n } = await run(args, () => [null, `${printed}\n`]);
    onlyHeraldReads(n);
    assert.deepEqual(out.ws04Read, read, args.join(' '));
    assert.deepEqual([out.ws04.status, out.ws04.admitted], ['held', 0]);
    assert.deepEqual(out.ws04.observations[0].held, H);
    assert.notEqual(out.ws04Read.code, 'NoRecord');
  }
});
