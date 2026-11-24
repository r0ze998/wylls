// verify-pr215: the Season 2 AbortSeason sender run end to end against an in-memory devnet RPC (fixtures/
// mock-rpc-preload.mjs replaces fetch and shifts the clock). Checks the dry run's output and that every refusal
// happens before simulate/send: wrong cluster, a created season, Season 1 not Aborted, a failed simulation, the
// 01:30 JST window (no call at all). No network, no key file, nothing signed (the dry run sends a zero signature).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { NO_CHANGE_FROM, S2_PARAMS_HASH, S2_T_CREATE_MIN, SEASON_1, SEASON_2 } from '../abort-season-2.mjs';
import { AUTHORITY, DEVNET_GENESIS, INCINERATOR, MAINNET_GENESIS, PROGRAM, RPC, S1_T_CREATE_MIN, b58d } from '../abort-season-1.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, '..', 'abort-season-2.mjs');
const PRELOAD = pathToFileURL(join(here, 'fixtures', 'mock-rpc-preload.mjs')).href;
const NOW_OK_MS = (Number(NO_CHANGE_FROM) - 3600) * 1000; // 00:30 JST 11-25

function seasonB64({ status, bump, tCreate, params, bond }) {
  const b = Buffer.alloc(2048);
  b.write('PSF1SEAS', 0, 'latin1');
  b[64] = status; b[65] = bump;
  b58d(AUTHORITY).copy(b, 72);
  Buffer.from(params, 'hex').copy(b, 336);
  b.writeBigInt64LE(BigInt(tCreate), 368);
  b.writeBigUInt64LE(bond, 384);
  return b.toString('base64');
}
const s1 = (o = {}) => ({ owner: PROGRAM, lamports: 11054080, data: seasonB64({ status: 6, bump: 255, tCreate: S1_T_CREATE_MIN, params: '11'.repeat(32), bond: 0n, ...o }) });
const s2 = (o = {}) => ({ owner: PROGRAM, lamports: 1011054080, data: seasonB64({ status: 0, bump: 252, tCreate: S2_T_CREATE_MIN, params: S2_PARAMS_HASH, bond: 1_000_000_000n, ...o }) });

function run({ nowMs = NOW_OK_MS, genesis = DEVNET_GENESIS, S1 = s1(), S2 = s2(), simErr = null, args = [] } = {}) {
  const d = mkdtempSync(join(tmpdir(), 'abort-s2-mock-'));
  const logFile = join(d, 'calls.jsonl');
  try {
    const cfg = { nowMs, genesis, simErr, logFile, accounts: { [SEASON_1]: S1, [SEASON_2]: S2 }, balances: { [AUTHORITY]: 57_628_000_000, [INCINERATOR]: 0 } };
    const r = spawnSync(process.execPath, ['--import', PRELOAD, SCRIPT, ...args], { encoding: 'utf8', timeout: 60000, env: { ...process.env, MOCK_RPC: JSON.stringify(cfg) } });
    const calls = existsSync(logFile) ? readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
    return { status: r.status, out: r.stdout + r.stderr, calls, methods: calls.map(c => c.method) };
  } finally { rmSync(d, { recursive: true, force: true }); }
}

test('dry run (no key): reads, simulates with sigVerify off, sends nothing, exit 0', () => {
  const r = run();
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /^DRY RUN: nothing is sent without --yes-send/m);
  assert.match(r.out, new RegExp(`cluster devnet \\(genesis ${DEVNET_GENESIS}\\)`));
  assert.match(r.out, /season 2 Announced, bond 1000000000 lamports, params f63f0b36/);
  assert.match(r.out, /unsigned: simulated with sigVerify off/);
  assert.match(r.out, /simulate: err=null units=4321/);
  assert.match(r.out, /DRY RUN: nothing sent\. A send needs --key, --yes-send, --i-have-r0ze-approval and --approved-sha256\./);
  assert.deepEqual(r.methods, ['getGenesisHash', 'getAccountInfo', 'getAccountInfo', 'getBalance', 'getBalance', 'getLatestBlockhash', 'simulateTransaction']);
  assert.ok(r.calls.every(c => c.url === RPC), 'only the devnet RPC');
  assert.deepEqual(r.calls.filter(c => c.method === 'getAccountInfo').map(c => c.params[0]), [SEASON_1, SEASON_2]);
  const sim = r.calls.find(c => c.method === 'simulateTransaction');
  assert.equal(sim.params[1].sigVerify, false);
  const tx = Buffer.from(sim.params[0], 'base64');
  assert.ok(tx.subarray(1, 65).equals(Buffer.alloc(64)), 'zero signature in a dry run');
});

test('wrong cluster (mainnet-beta / unknown genesis): refused after the genesis read only', () => {
  for (const g of [MAINNET_GENESIS, '11111111111111111111111111111111']) {
    const r = run({ genesis: g });
    assert.equal(r.status, 2, r.out);
    assert.match(r.out, /REFUSE: genesis .* (mainnet-beta|is not devnet's)/);
    assert.deepEqual(r.methods, ['getGenesisHash']);
  }
});

test('season 2 already created / seeded / running / aborted: refused before simulate', () => {
  for (const status of [1, 2, 3, 6]) {
    const r = run({ S2: s2({ status }) });
    assert.equal(r.status, 2, r.out);
    assert.match(r.out, new RegExp(`season 2 status ${status} is not Announced`));
    assert.ok(!r.methods.includes('simulateTransaction') && !r.methods.includes('sendTransaction'));
  }
});

test('season 2 missing, other params or no bond; season 1 not Aborted: refused before simulate', () => {
  for (const [o, re] of [[{ S2: null }, /season 2 account missing/], [{ S2: s2({ params: 'ab'.repeat(32) }) }, /params hash/],
    [{ S2: s2({ bond: 0n }) }, /bond 0/], [{ S1: s1({ status: 0 }) }, /season 1 status 0 is not Aborted/]]) {
    const r = run(o);
    assert.equal(r.status, 2, r.out);
    assert.match(r.out, re);
    assert.ok(!r.methods.includes('simulateTransaction'));
  }
});

test('a failed simulation is refused (exit 2), nothing sent', () => {
  const r = run({ simErr: { InstructionError: [0, { Custom: 6 }] } });
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /REFUSE: simulation failed/);
  assert.ok(!r.methods.includes('sendTransaction'));
});

test('from 01:30:00 JST 11-25 on: refused before any RPC call (dry run and full send gate alike)', () => {
  for (const nowMs of [Number(NO_CHANGE_FROM) * 1000, (Number(NO_CHANGE_FROM) + 3661) * 1000]) {
    for (const args of [[], ['--key', '/nonexistent', '--yes-send', '--i-have-r0ze-approval', '--approved-sha256', 'ab'.repeat(32)]]) {
      const r = run({ nowMs, args });
      assert.equal(r.status, 2, r.out);
      assert.match(r.out, /01:30 JST 11-25 or later/);
      assert.deepEqual(r.calls, []);
    }
  }
  const before = run({ nowMs: Number(NO_CHANGE_FROM) * 1000 - 120000 });
  assert.equal(before.status, 0, before.out);
});

test('send gate: missing approval flags are refused before any RPC call, whatever the clock', () => {
  for (const args of [['--key', '/nonexistent', '--yes-send'], ['--key', '/nonexistent', '--yes-send', '--i-have-r0ze-approval'],
    ['--key', '/nonexistent', '--yes-send', '--approved-sha256', 'ab'.repeat(32)]]) {
    const r = run({ args });
    assert.equal(r.status, 2, r.out);
    assert.match(r.out, /SEND GATE: CLOSED/);
    assert.deepEqual(r.calls, []);
  }
});
