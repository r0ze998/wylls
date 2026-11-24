// Tests of the prepared (not sent) devnet Season 2 AbortSeason sender (scripts/devnet/abort-season-2.mjs): the
// season refusals, the owner's 01:30 JST no-change window, the message layout and CLI refusals before any
// network call. Pure helpers plus CLI runs that refuse before any read. Nothing here contacts a network, uses a
// real key or signs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BOND_DEADLINE, NO_CHANGE_FROM, RPC, S2_PARAMS_HASH, S2_T_CREATE_MIN, SEASON_1, SEASON_2, buildMessage, seasonProblems,
} from '../abort-season-2.mjs';
import { AUTHORITY, DEVNET_GENESIS, INCINERATOR, PROGRAM, S1_T_CREATE_MIN, TAG_ABORT_SEASON, b58d, b58e, decodeSeason } from '../abort-season-1.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'abort-season-2.mjs');
const SHA = 'cd'.repeat(32);
const NOW_OK = Number(NO_CHANGE_FROM) - 3600; // 00:30 JST 11-25

function seasonBytes({ status, bump, authority = AUTHORITY, tCreate, params = S2_PARAMS_HASH, bond = 1_000_000_000n }) {
  const b = Buffer.alloc(1460);
  b.write('PSF1SEAS', 0, 'latin1');
  b[64] = status; b[65] = bump;
  b58d(authority).copy(b, 72);
  Buffer.from(params, 'hex').copy(b, 336);
  b.writeBigInt64LE(BigInt(tCreate), 368);
  b.writeBigUInt64LE(bond, 384);
  return b;
}
const S1 = (o = {}) => ({ owner: PROGRAM, ...decodeSeason(seasonBytes({ status: 6, bump: 255, tCreate: S1_T_CREATE_MIN, bond: 0n, params: '00'.repeat(32), ...o })) });
const S2 = (o = {}) => ({ owner: PROGRAM, ...decodeSeason(seasonBytes({ status: 0, bump: 252, tCreate: S2_T_CREATE_MIN, ...o })) });

test('the times: no-change window starts 01:30 JST 11-25, bond deadline 02:31:06 is inside it', () => {
  assert.equal(NO_CHANGE_FROM, 1795537800n);
  const jst = n => new Date((Number(n) + 9 * 3600) * 1000).toISOString().slice(0, 19);
  assert.equal(jst(NO_CHANGE_FROM), '2026-11-25T01:30:00');
  assert.equal(jst(BOND_DEADLINE), '2026-11-25T02:31:06');
  assert.ok(BOND_DEADLINE > NO_CHANGE_FROM && BOND_DEADLINE < NO_CHANGE_FROM + 7200n);
  assert.ok(BOND_DEADLINE - S2_T_CREATE_MIN >= 660n && BOND_DEADLINE - S2_T_CREATE_MIN <= 663n);
});

test('the RPC is devnet only and the only URL; no env, no season/address flag', () => {
  assert.equal(RPC, 'https://api.devnet.solana.com');
  const src = readFileSync(SCRIPT, 'utf8');
  assert.equal(src.match(/https?:\/\/[^\s'"`)]+/g), null, 'the URL comes from abort-season-1.mjs only');
  assert.doesNotMatch(src, /process\.env/);
});

test('season refusals: only the announced-not-created season 2 passes, with season 1 Aborted', () => {
  assert.deepEqual(seasonProblems(S1(), S2(), NOW_OK), []);
  for (const status of [1, 2, 3, 4, 5, 6]) assert.match(seasonProblems(S1(), S2({ status }), NOW_OK).join(), /season 2 status .* is not Announced/);
  assert.match(seasonProblems(S1(), S2({ authority: INCINERATOR }), NOW_OK).join(), /season 2 authority/);
  assert.match(seasonProblems(S1(), S2({ tCreate: S2_T_CREATE_MIN - 2n }), NOW_OK).join(), /season 2 t_create_min/);
  assert.match(seasonProblems(S1(), S2({ params: 'ee'.repeat(32) }), NOW_OK).join(), /params hash/);
  assert.match(seasonProblems(S1(), S2({ bond: 0n }), NOW_OK).join(), /bond 0/);
  assert.match(seasonProblems(S1(), S2({ bump: 251 }), NOW_OK).join(), /season 2 address/);
  assert.match(seasonProblems(S1(), { ...S2(), owner: INCINERATOR }, NOW_OK).join(), /season 2 owner/);
  assert.match(seasonProblems(S1(), { ...S2(), magic: 'XXXXXXXX' }, NOW_OK).join(), /season 2 magic/);
  assert.match(seasonProblems(S1(), null, NOW_OK).join(), /season 2 account missing/);
  assert.match(seasonProblems(S1({ status: 0 }), S2(), NOW_OK).join(), /season 1 status 0 is not Aborted/);
  assert.match(seasonProblems(null, S2(), NOW_OK).join(), /season 1 account missing/);
});

test('season 1 can never be taken for season 2', () => {
  const p = seasonProblems(S1(), S1(), NOW_OK).join('; ');
  assert.match(p, /season 2 address is not PDA/);
  assert.match(p, /season 2 status 6/);
  const msg = buildMessage(DEVNET_GENESIS);
  assert.equal(msg.indexOf(b58d(SEASON_1)), -1);
});

test('owner no-change window: refused from 01:30:00 JST 11-25 on', () => {
  assert.deepEqual(seasonProblems(S1(), S2(), Number(NO_CHANGE_FROM) - 1), []);
  assert.match(seasonProblems(S1(), S2(), Number(NO_CHANGE_FROM)).join(), /no-change window/);
  assert.match(seasonProblems(S1(), S2(), Number(BOND_DEADLINE) + 1).join(), /no-change window/);
});

test('message: authority pays and signs as any+authority; season 2, incinerator writable; data [0x06]', () => {
  const msg = buildMessage(DEVNET_GENESIS);
  assert.deepEqual([...msg.subarray(0, 4)], [1, 0, 1, 4]);
  const keys = [0, 1, 2, 3].map(i => b58e(msg.subarray(4 + 32 * i, 36 + 32 * i)));
  assert.deepEqual(keys, [AUTHORITY, SEASON_2, INCINERATOR, PROGRAM]);
  assert.equal(b58e(msg.subarray(132, 164)), DEVNET_GENESIS);
  assert.deepEqual([...msg.subarray(164)], [1, 3, 4, 0, 1, 0, 2, 1, TAG_ABORT_SEASON]);
  assert.throws(() => buildMessage('1'), /bad blockhash/);
});

function cli(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', timeout: 20000 });
}

test('CLI refuses bad flags before any read (exit 2)', () => {
  for (const a of [['--send'], ['--yes-send'], ['--i-have-r0ze-approval'], ['--rpc', 'https://api.mainnet-beta.solana.com'],
    ['--season', '3'], ['--key', 'k', '--yes-send']]) {
    const r = cli(a);
    assert.equal(r.status, 2, `${a.join(' ')}: ${r.stdout}${r.stderr}`);
    assert.match(r.stdout + r.stderr, /REFUSE/);
    assert.doesNotMatch(r.stdout + r.stderr, /cluster devnet/);
  }
});

test('CLI: a malformed or loose key file is refused (exit 2) without printing its bytes, whatever the clock', () => {
  const d = mkdtempSync(join(tmpdir(), 'abort-s2-'));
  try {
    const bad = join(d, 'bad.json');
    const body = `[${Array.from({ length: 63 }, (_, i) => 200 + (i % 50)).join(',')}]`;
    writeFileSync(bad, body); chmodSync(bad, 0o600);
    const gate = ['--yes-send', '--i-have-r0ze-approval', '--approved-sha256', SHA];
    for (const mode of [0o600, 0o644]) {
      chmodSync(bad, mode);
      const r = cli(['--key', bad, ...gate]);
      assert.equal(r.status, 2, r.stdout + r.stderr);
      assert.match(r.stdout, /REFUSE/);
      assert.doesNotMatch(r.stdout + r.stderr, /2\d\d,2\d\d/);
      assert.doesNotMatch(r.stdout + r.stderr, /cluster devnet/);
    }
  } finally { rmSync(d, { recursive: true, force: true }); }
});
