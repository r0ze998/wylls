// Tests of the one-off devnet Season 1 AbortSeason sender (scripts/devnet/abort-season-1.mjs): the flag gate,
// the cluster guard, the season refusals and the message layout. Pure helpers plus CLI runs that refuse before
// any network call. Nothing here contacts a network, uses a real key or signs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AUTHORITY, DEVNET_GENESIS, INCINERATOR, MAINNET_GENESIS, PROGRAM, RPC, S1_T_CREATE_MIN, S2_T_CREATE_MIN, SEASON_1,
  SEASON_2, TAG_ABORT_SEASON, b58d, b58e, buildMessage, decodeSeason, gateFlags, genesisProblem, keyFileProblem, parseArgs,
  pda, programSha256, seasonProblems, seasonSeed,
} from '../abort-season-1.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'abort-season-1.mjs');
const SHA = 'ab'.repeat(32);
const NOW_OK = Number(S1_T_CREATE_MIN) - 13 * 3600; // 06:34 JST on 11-24, when it was sent

function seasonBytes({ status = 0, bump, authority = AUTHORITY, tCreate }) {
  const b = Buffer.alloc(1460);
  b.write('PSF1SEAS', 0, 'latin1');
  b[64] = status; b[65] = bump;
  b58d(authority).copy(b, 72);
  b.writeBigInt64LE(BigInt(tCreate), 368);
  b.writeBigUInt64LE(1_000_000_000n, 384);
  return b;
}
const S1 = (o = {}) => ({ owner: PROGRAM, ...decodeSeason(seasonBytes({ bump: 255, tCreate: S1_T_CREATE_MIN, ...o })) });
const S2 = (o = {}) => ({ owner: PROGRAM, ...decodeSeason(seasonBytes({ bump: 252, tCreate: S2_T_CREATE_MIN, ...o })) });

test('the pinned addresses are the season PDAs with their stored bumps', () => {
  assert.equal(pda(seasonSeed(1), 255, PROGRAM), SEASON_1);
  assert.equal(pda(seasonSeed(2), 252, PROGRAM), SEASON_2);
  assert.equal(b58e(b58d(INCINERATOR)), INCINERATOR);
});

test('the RPC is devnet only and is the only URL in the script; no override flag exists', () => {
  assert.equal(RPC, 'https://api.devnet.solana.com');
  const src = readFileSync(SCRIPT, 'utf8');
  assert.deepEqual([...new Set(src.match(/https?:\/\/[^\s'"`)]+/g))], [RPC]);
  assert.doesNotMatch(src, /process\.env/);
  for (const a of [['--rpc', 'https://api.mainnet-beta.solana.com'], ['--url', 'x'], ['--season', '2'], ['--season-id', '2']]) {
    assert.match(parseArgs(a).error, /unknown argument/);
  }
});

test('genesis guard: devnet only, mainnet-beta named', () => {
  assert.equal(genesisProblem(DEVNET_GENESIS), null);
  assert.match(genesisProblem(MAINNET_GENESIS), /mainnet-beta: refused/);
  assert.match(genesisProblem('4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY'), /not devnet's/);
});

test('flag gate: dry run by default; a send needs --key, --yes-send, approval and sha (end-season style)', () => {
  assert.deepEqual(parseArgs([]).opts, { key: null, yesSend: false, approval: false, approvedSha256: null });
  assert.equal(gateFlags(parseArgs([]).opts).length, 3);
  assert.match(parseArgs(['--send']).error, /replaced by --yes-send/);
  assert.match(parseArgs(['--yes-send']).error, /needs --key/);
  assert.match(parseArgs(['--i-have-r0ze-approval']).error, /belong to a send/);
  assert.match(parseArgs(['--approved-sha256', SHA]).error, /belong to a send/);
  assert.match(parseArgs(['--approved-sha256', 'xyz']).error, /64 hex/);
  assert.match(parseArgs(['--key']).error, /need --key FILE/);
  const half = parseArgs(['--key', 'k', '--yes-send']).opts;
  assert.deepEqual(gateFlags(half).map(s => s.split(' ')[0]), ['--i-have-r0ze-approval', '--approved-sha256']);
  const full = parseArgs(['--key', 'k', '--yes-send', '--i-have-r0ze-approval', '--approved-sha256', SHA.toUpperCase()]).opts;
  assert.equal(full.approvedSha256, SHA);
  assert.deepEqual(gateFlags(full), []);
});

test('season refusals: only the announced-not-created season 1 passes', () => {
  assert.deepEqual(seasonProblems(S1(), S2(), NOW_OK), []);
  // today's chain: season 1 already Aborted (6) → refused
  assert.match(seasonProblems(S1({ status: 6 }), S2(), NOW_OK).join(), /status 6 is not Announced/);
  for (const status of [1, 2, 3, 4, 5]) assert.match(seasonProblems(S1({ status }), S2(), NOW_OK).join(), /is not Announced/);
  assert.match(seasonProblems(S1({ authority: INCINERATOR }), S2(), NOW_OK).join(), /authority/);
  assert.match(seasonProblems(S1({ tCreate: S1_T_CREATE_MIN + 1n }), S2(), NOW_OK).join(), /season 1 t_create_min/);
  assert.match(seasonProblems({ ...S1(), owner: INCINERATOR }, S2(), NOW_OK).join(), /season 1 owner/);
  assert.match(seasonProblems({ ...S1(), magic: 'XXXXXXXX' }, S2(), NOW_OK).join(), /magic/);
  assert.match(seasonProblems(null, S2(), NOW_OK).join(), /season 1 account missing/);
});

test('season 2 can never be taken for season 1', () => {
  // season 2's bytes where season 1's are expected (wrong PDA, wrong t_create_min) → refused
  const p = seasonProblems(S2(), S2(), NOW_OK).join('; ');
  assert.match(p, /not PDA \["season", le64\(1\)\]/);
  assert.match(p, /season 1 t_create_min/);
  assert.match(seasonProblems(S1(), null, NOW_OK).join(), /season 2 account missing/);
  assert.match(seasonProblems(S1(), S2({ tCreate: S2_T_CREATE_MIN - 2n }), NOW_OK).join(), /season 2 t_create_min/);
  assert.match(seasonProblems(S1(), S2({ bump: 251 }), NOW_OK).join(), /season 2 address/);
  // the transaction names season 1 only
  const msg = buildMessage(DEVNET_GENESIS);
  assert.equal(msg.indexOf(b58d(SEASON_2)), -1);
});

test('bond deadline margin: refused from t_create_min + 300 s (bond burns at ≈ +660 s)', () => {
  assert.deepEqual(seasonProblems(S1(), S2(), Number(S1_T_CREATE_MIN) + 300), []);
  assert.match(seasonProblems(S1(), S2(), Number(S1_T_CREATE_MIN) + 301).join(), /bond deadline/);
});

test('message: authority pays and signs as any+authority; season 1, incinerator writable; data [0x06]', () => {
  const msg = buildMessage(DEVNET_GENESIS);
  assert.deepEqual([...msg.subarray(0, 4)], [1, 0, 1, 4]);
  const keys = [0, 1, 2, 3].map(i => b58e(msg.subarray(4 + 32 * i, 36 + 32 * i)));
  assert.deepEqual(keys, [AUTHORITY, SEASON_1, INCINERATOR, PROGRAM]);
  assert.equal(b58e(msg.subarray(132, 164)), DEVNET_GENESIS); // blockhash slot
  assert.deepEqual([...msg.subarray(164)], [1, 3, 4, 0, 1, 0, 2, 1, TAG_ABORT_SEASON]);
  assert.throws(() => buildMessage('1'), /bad blockhash/);
});

test('programSha256 hashes the ELF inside ProgramData (padding excluded)', () => {
  const elf = Buffer.alloc(128);
  elf.write('\x7fELF', 0, 'latin1'); elf[4] = 2; elf[5] = 1;
  elf.writeBigUInt64LE(64n, 0x28); elf.writeUInt16LE(64, 0x3A); elf.writeUInt16LE(1, 0x3C);
  elf.fill(7, 64);
  const pd = Buffer.concat([Buffer.alloc(45), elf, Buffer.alloc(500)]);
  const want = programSha256(Buffer.concat([Buffer.alloc(45), elf]));
  assert.match(want, /^[0-9a-f]{64}$/);
  assert.equal(programSha256(pd), want);
  assert.equal(programSha256(Buffer.alloc(200)), null);
});

test('key file guard: symlink, non-regular and group/other-readable files are refused', () => {
  const st = (o) => ({ isSymbolicLink: () => false, isFile: () => true, uid: process.getuid?.() ?? 0, mode: 0o100600, ...o });
  assert.equal(keyFileProblem('k', st()), null);
  assert.equal(keyFileProblem('k', st({ mode: 0o100400 })), null);
  assert.match(keyFileProblem('k', st({ isSymbolicLink: () => true })), /symlink/);
  assert.match(keyFileProblem('k', st({ isFile: () => false })), /not a regular file/);
  assert.match(keyFileProblem('k', st({ mode: 0o100644 })), /mode 644/);
  if (process.getuid) assert.match(keyFileProblem('k', st({ uid: process.getuid() + 1 })), /not owned/);
});

function cli(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', timeout: 20000 });
}

test('CLI refuses bad flags before any read (exit 2)', () => {
  for (const a of [['--send'], ['--yes-send'], ['--i-have-r0ze-approval'], ['--rpc', 'https://api.mainnet-beta.solana.com'],
    ['--key', 'k', '--yes-send']]) {
    const r = cli(a);
    assert.equal(r.status, 2, `${a.join(' ')}: ${r.stdout}${r.stderr}`);
    assert.match(r.stdout + r.stderr, /REFUSE/);
    assert.doesNotMatch(r.stdout + r.stderr, /cluster devnet/);
  }
});

test('CLI: a malformed or loose key file is refused without printing its bytes', () => {
  const d = mkdtempSync(join(tmpdir(), 'abort-s1-'));
  try {
    const bad = join(d, 'bad.json');
    const body = `[${Array.from({ length: 63 }, (_, i) => 200 + (i % 50)).join(',')}]`; // 63 bytes: not a keypair
    writeFileSync(bad, body); chmodSync(bad, 0o600);
    const gate = ['--yes-send', '--i-have-r0ze-approval', '--approved-sha256', SHA];
    let r = cli(['--key', bad, ...gate]);
    assert.equal(r.status, 2);
    assert.match(r.stdout, /not a Solana CLI key file/);
    assert.doesNotMatch(r.stdout + r.stderr, /2\d\d,2\d\d/);
    writeFileSync(bad, body.slice(0, 20)); // invalid JSON
    r = cli(['--key', bad, ...gate]);
    assert.equal(r.status, 2);
    assert.doesNotMatch(r.stdout + r.stderr, /2\d\d,2\d\d/);
    chmodSync(bad, 0o644);
    r = cli(['--key', bad, ...gate]);
    assert.equal(r.status, 2);
    assert.match(r.stdout, /mode 644/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
